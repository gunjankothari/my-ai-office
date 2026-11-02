import { createHash } from "node:crypto";
import { canonicalJson, type ApprovalMode, type Grant, type Risk, type ToolDef } from "@agent-office/shared";
import type { ApprovalQueue } from "./approvals";
import type { AuditLog } from "./audit";
import type { CredentialBroker } from "./broker";
import { decide, type Decision } from "./policy";

/*
 * The tool gateway sits between agents and every tool server (MCP servers or
 * built-in connectors). Agents never talk to a tool server directly. For each call it:
 *   1. looks the connection up inside the agent's own project only,
 *   2. checks the grant (tool, resource, expiry) and the agent's approval mode,
 *   3. pauses for approval when needed,
 *   4. adds the credential itself, so the model never sees it,
 *   5. trims and scrubs the output, and
 *   6. writes an audit line.
 * It also shows the model only the tools it was granted, which keeps prompts small.
 */

export interface ToolServer {
  /** Synchronous: servers cache their tool list when they connect. */
  tools(): ToolDef[];
  /**
   * `auth.secret` is the connection's credential, read from the vault for this call.
   * Servers that keep a long-lived session (MCP over stdio or HTTP) apply the credential
   * when they connect and ignore it here.
   */
  call(tool: string, args: Record<string, unknown>, auth: { secret: string }): Promise<unknown>;
  /** JSON Schema of a tool's arguments, for engines that must describe tools to a model. */
  schema?(tool: string): unknown;
  close?(): Promise<void>;
}

export interface Connection {
  id: string;
  projectId: string;
  service: string;
  label: string;
  /** Name of the secret in this project's vault. Omit for servers that need no credential. */
  credentialHandle?: string;
  server: ToolServer;
}

export interface AgentCtx {
  agentId: string;
  projectId: string;
  mode: ApprovalMode;
  grants: Grant[];
}

export interface ToolIndexEntry {
  connectionId: string;
  service: string;
  name: string;
  description: string;
  risk: Risk;
  /** Present when the server provides one. The API engine ignores it, the Claude Code engine needs it. */
  inputSchema?: unknown;
}

export type CallResult =
  | { status: "ok"; output: string; truncated: boolean }
  | { status: "needs_approval"; approvalId: string; reason: string }
  | { status: "denied"; reason: string }
  | { status: "dry_run"; wouldDo: string }
  | { status: "error"; message: string };

export interface GatewayDeps {
  broker: CredentialBroker;
  audit: AuditLog;
  approvals: ApprovalQueue;
  agentCtx: (agentId: string) => AgentCtx | undefined;
  now?: () => number;
  maxOutputChars?: number;
  timeoutMs?: number;
}

const argsHash = (args: Record<string, unknown>) => createHash("sha256").update(canonicalJson(args)).digest("hex").slice(0, 16);

export class ToolGateway {
  private conns = new Map<string, Connection>();
  private readonly now: () => number;
  private readonly maxOut: number;
  private readonly timeout: number;

  constructor(private readonly deps: GatewayDeps) {
    this.now = deps.now ?? Date.now;
    this.maxOut = deps.maxOutputChars ?? 4000;
    this.timeout = deps.timeoutMs ?? 30_000;
  }

  private k = (projectId: string, connectionId: string) => `${projectId}/${connectionId}`;

  addConnection(c: Connection): void {
    this.conns.set(this.k(c.projectId, c.id), c);
  }

  removeConnection(projectId: string, connectionId: string): void {
    this.conns.delete(this.k(projectId, connectionId));
  }

  /** Only the tools this agent is currently granted. Short lines, cheap in tokens. */
  listTools(agentId: string): ToolIndexEntry[] {
    const ctx = this.deps.agentCtx(agentId);
    if (!ctx) return [];
    const out: ToolIndexEntry[] = [];
    for (const g of ctx.grants) {
      if (g.agentId !== ctx.agentId || g.projectId !== ctx.projectId) continue;
      if (g.expiresAt !== undefined && this.now() >= g.expiresAt) continue;
      const conn = this.conns.get(this.k(ctx.projectId, g.connectionId));
      if (!conn) continue;
      for (const t of conn.server.tools()) {
        if (g.tools.includes(t.name)) {
          const inputSchema = conn.server.schema?.(t.name);
          out.push({ connectionId: conn.id, service: conn.service, name: t.name, description: t.description, risk: t.risk, ...(inputSchema ? { inputSchema } : {}) });
        }
      }
    }
    return out;
  }

  async call(agentId: string, connectionId: string, toolName: string, args: Record<string, unknown>): Promise<CallResult> {
    const ctx = this.deps.agentCtx(agentId);
    if (!ctx) return { status: "denied", reason: "unknown agent" };
    const conn = this.conns.get(this.k(ctx.projectId, connectionId));
    if (!conn) return this.denied(ctx, connectionId, toolName, args, "unknown connection");
    const tool = conn.server.tools().find((t) => t.name === toolName);
    const grant = ctx.grants.find(
      (g) => g.agentId === ctx.agentId && g.projectId === ctx.projectId && g.connectionId === connectionId && g.tools.includes(toolName),
    );
    const d = decide({ tool, grant, args, mode: ctx.mode, now: this.now() });
    return this.act(d, ctx, conn, tool, args);
  }

  private async act(d: Decision, ctx: AgentCtx, conn: Connection, tool: ToolDef | undefined, args: Record<string, unknown>): Promise<CallResult> {
    const name = tool?.name ?? "?";
    switch (d.action) {
      case "deny":
        return this.denied(ctx, conn.id, name, args, d.reason);
      case "dry": {
        const wouldDo = this.summary(ctx.projectId, name, args);
        this.log(ctx, conn.id, name, args, "dry_run");
        return { status: "dry_run", wouldDo };
      }
      case "ask": {
        const a = this.deps.approvals.create({
          projectId: ctx.projectId, agentId: ctx.agentId, connectionId: conn.id, tool: name, args,
          summary: this.summary(ctx.projectId, name, args), risk: tool!.risk, reason: d.reason,
        });
        this.log(ctx, conn.id, name, args, "needs_approval", { approvalId: a.id, reason: d.reason });
        return { status: "needs_approval", approvalId: a.id, reason: d.reason };
      }
      case "allow":
        return this.execute(ctx, conn, tool!, args, "auto");
    }
  }

  /** Runs a call the user approved. Policy is checked again, so a grant revoked meanwhile still wins. */
  async resolveApproval(id: string, approve: boolean, by: string): Promise<CallResult> {
    const r = this.deps.approvals.resolve(id, approve, by);
    if (!r.ok) return { status: "denied", reason: `approval ${r.reason}` };
    const a = r.approval;
    const ctx = this.deps.agentCtx(a.agentId);
    if (!ctx) return { status: "denied", reason: "unknown agent" };
    if (!approve) {
      this.log(ctx, a.connectionId, a.tool, a.args, "denied_by_user", { by });
      return { status: "denied", reason: `denied by ${by}` };
    }
    const conn = this.conns.get(this.k(ctx.projectId, a.connectionId));
    if (!conn) return this.denied(ctx, a.connectionId, a.tool, a.args, "connection removed");
    const tool = conn.server.tools().find((t) => t.name === a.tool);
    const grant = ctx.grants.find((g) => g.agentId === ctx.agentId && g.connectionId === a.connectionId && g.tools.includes(a.tool));
    const d = decide({ tool, grant, args: a.args, mode: ctx.mode, now: this.now() });
    if (d.action === "deny") return this.denied(ctx, a.connectionId, a.tool, a.args, d.reason);
    if (d.action === "dry") return { status: "dry_run", wouldDo: this.summary(ctx.projectId, a.tool, a.args) };
    return this.execute(ctx, conn, tool!, a.args, `approved_by:${by}`);
  }

  private async execute(ctx: AgentCtx, conn: Connection, tool: ToolDef, args: Record<string, unknown>, how: string): Promise<CallResult> {
    const started = this.now();
    try {
      const run = (secret: string) => this.withTimeout(conn.server.call(tool.name, args, { secret }));
      const raw = conn.credentialHandle
        ? await this.deps.broker.withCredential(ctx.projectId, conn.credentialHandle, run)
        : await run("");
      let text = typeof raw === "string" ? raw : JSON.stringify(raw) ?? "";
      let truncated = false;
      if (text.length > this.maxOut) {
        truncated = true;
        text = text.slice(0, this.maxOut) + `…[truncated ${text.length - this.maxOut} chars]`;
      }
      // Scrub after truncating, so a secret cannot hide at the cut point, and scrub the final text.
      const output = this.deps.broker.scrub(ctx.projectId, text);
      this.log(ctx, conn.id, tool.name, args, "ok", { how, ms: this.now() - started, outChars: output.length, truncated });
      return { status: "ok", output, truncated };
    } catch (e) {
      const message = this.deps.broker.scrub(ctx.projectId, e instanceof Error ? e.message : String(e));
      this.log(ctx, conn.id, tool.name, args, "error", { how, message });
      return { status: "error", message };
    }
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("tool timed out")), this.timeout);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  private summary(projectId: string, tool: string, args: Record<string, unknown>): string {
    const parts = Object.entries(args).map(([k, v]) => `${k}=${String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 60)}`);
    return this.deps.broker.scrub(projectId, `${tool}(${parts.join(", ")})`);
  }

  private denied(ctx: AgentCtx, connectionId: string, tool: string, args: Record<string, unknown>, reason: string): CallResult {
    this.log(ctx, connectionId, tool, args, "denied", { reason });
    return { status: "denied", reason };
  }

  private log(ctx: AgentCtx, connectionId: string, tool: string, args: Record<string, unknown>, outcome: string, extra: Record<string, unknown> = {}): void {
    this.deps.audit.append({ kind: "tool.call", projectId: ctx.projectId, agentId: ctx.agentId, connectionId, tool, argsHash: argsHash(args), outcome, ...extra });
  }
}

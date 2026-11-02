import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  NonceCache, Risk, generateKeyPair, signObject, signerFromExported, verifyCommand,
  type ApprovalMode, type CommandReplyBody, type Grant, type Signer, type StatusSnapshot,
} from "@agent-office/shared";
import { ApprovalQueue } from "./approvals";
import { AuditLog } from "./audit";
import { CredentialBroker } from "./broker";
import { ToolGateway, type AgentCtx } from "./gateway";
import { McpToolServer, type McpSpec } from "./mcp/server";
import { ToolReviews, type DiscoveredTool } from "./mcp/review";
import { ClaudeCodeEngine } from "./engines/claude-code";
import type { AgentEngine, EngineAgent, EngineOutcome, ResumeState } from "./engines/types";
import type { RunEvent } from "@agent-office/shared";
import { PairingManager, TrustStore } from "./trust";
import { Vault } from "./vault";

export interface AgentRecord {
  id: string;
  name: string;
  role: string;
  projectId: string;
  mode: ApprovalMode;
  model: string;
  status: "idle" | "working" | "asleep";
  tokensToday: number;
  /** Which engine thinks for this agent. "claude-code" uses the user's own Claude Code sign-in. */
  engine?: "claude-code";
  /** Model alias passed to the engine (for Claude Code, for example "sonnet" or "haiku"). Optional. */
  engineModel?: string;
  /** While asleep (usage limit reached): when to try again. */
  sleepUntil?: number;
}

export interface OfficeOptions {
  home: string;
  name: string;
  masterKey: Buffer;
  version?: string;
  now?: () => number;
  /** How to start Claude Code. Default: the `claude` program on PATH. */
  claude?: { command?: string; commandArgs?: string[]; timeoutMs?: number };
  /** How long an agent rests after a usage limit with no reset time given. Default 30 minutes. */
  restMs?: number;
}

/** An MCP connection. Holds no secrets: the credential lives in the vault under `credentialHandle`. */
export interface McpConnectionRecord {
  id: string;
  projectId: string;
  service: string;
  label: string;
  credentialHandle?: string;
  spec: McpSpec;
}

interface PersistedState {
  projects: { id: string; name: string }[];
  agents: AgentRecord[];
  grants: Grant[];
  mcp?: McpConnectionRecord[];
}

const OFFICE_PROJECT = "_office"; // vault namespace for the host's own signing key

/**
 * One Office Host: a vault, a gateway, a list of projects and agents, the devices
 * it trusts, and the handler for everything the hub relays to it.
 */
export class Office {
  readonly vault: Vault;
  readonly broker: CredentialBroker;
  readonly audit: AuditLog;
  readonly approvals: ApprovalQueue;
  readonly gateway: ToolGateway;
  readonly trust: TrustStore;
  readonly pairing: PairingManager;
  readonly nonces = new NonceCache();
  readonly reviews: ToolReviews;
  private readonly mcp = new Map<string, McpToolServer>();
  private mcpRecords: McpConnectionRecord[] = [];
  readonly projects = new Map<string, { id: string; name: string }>();
  readonly agents = new Map<string, AgentRecord>();
  grants: Grant[] = [];
  /** Assigned by the hub at enrollment. */
  officeId: string | undefined;
  /** Commands issued before this moment are refused (see verifyCommand). */
  private readonly startedAt: number;

  private constructor(
    readonly opts: OfficeOptions,
    readonly signer: Signer,
    vault: Vault,
  ) {
    const now = opts.now ?? Date.now;
    this.startedAt = now();
    this.vault = vault;
    this.broker = new CredentialBroker(vault);
    this.audit = new AuditLog(join(opts.home, "audit.jsonl"), now);
    this.approvals = new ApprovalQueue(10 * 60_000, now);
    this.trust = new TrustStore(join(opts.home, "trusted-devices.json"));
    this.reviews = new ToolReviews(join(opts.home, "tool-reviews.json"));
    this.pairing = new PairingManager(this.trust, signer.publicKey, now);
    this.gateway = new ToolGateway({
      broker: this.broker, audit: this.audit, approvals: this.approvals, now,
      agentCtx: (id) => this.agentCtx(id),
    });
    this.loadState();
  }

  static async open(opts: OfficeOptions): Promise<Office> {
    mkdirSync(opts.home, { recursive: true });
    const vault = new Vault(join(opts.home, "vault.json"), opts.masterKey);
    const identityFile = join(opts.home, "host-identity.json");
    if (!existsSync(identityFile) || !vault.has(OFFICE_PROJECT, "host-signing-key")) {
      // The private key lives in the vault like any other credential. Only the public half is written in the clear.
      const kp = await generateKeyPair();
      vault.put(OFFICE_PROJECT, "host-signing-key", kp.privateKey);
      writeFileSync(identityFile, JSON.stringify({ publicKey: kp.publicKey }), { mode: 0o600 });
    }
    const { publicKey } = JSON.parse(readFileSync(identityFile, "utf8")) as { publicKey: string };
    const signer = await new CredentialBroker(vault).withCredential(OFFICE_PROJECT, "host-signing-key", (privateKey) =>
      signerFromExported({ publicKey, privateKey }),
    );
    const office = new Office(opts, signer, vault);
    await office.restoreConnections();
    return office;
  }

  get publicKey(): string {
    return this.signer.publicKey;
  }

  // ---------- registry ----------
  private stateFile = () => join(this.opts.home, "state.json");

  private loadState(): void {
    if (!existsSync(this.stateFile())) return;
    const s = JSON.parse(readFileSync(this.stateFile(), "utf8")) as PersistedState;
    s.projects.forEach((p) => this.projects.set(p.id, p));
    s.agents.forEach((a) => this.agents.set(a.id, a));
    this.grants = s.grants;
    this.mcpRecords = s.mcp ?? [];
  }

  private saveState(): void {
    const s: PersistedState = { projects: [...this.projects.values()], agents: [...this.agents.values()], grants: this.grants, mcp: this.mcpRecords };
    const tmp = this.stateFile() + ".tmp";
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(tmp, this.stateFile());
  }

  addProject(id: string, name: string): void {
    this.projects.set(id, { id, name });
    this.saveState();
  }

  addAgent(a: Omit<AgentRecord, "status" | "tokensToday"> & Partial<Pick<AgentRecord, "status" | "tokensToday">>): void {
    if (!this.projects.has(a.projectId)) throw new Error(`unknown project ${a.projectId}`);
    this.agents.set(a.id, { status: "idle", tokensToday: 0, ...a });
    this.saveState();
  }

  addGrant(g: Grant): void {
    const agent = this.agents.get(g.agentId);
    if (!agent || agent.projectId !== g.projectId) throw new Error("grant must be for an agent in the same project");
    this.grants.push(g);
    this.saveState();
    this.audit.append({ kind: "grant.added", projectId: g.projectId, agentId: g.agentId, connectionId: g.connectionId, tools: g.tools, resources: g.resources });
  }

  revokeGrant(grantId: string): void {
    const g = this.grants.find((x) => x.id === grantId);
    this.grants = this.grants.filter((x) => x.id !== grantId);
    this.saveState();
    if (g) this.audit.append({ kind: "grant.revoked", projectId: g.projectId, agentId: g.agentId, connectionId: g.connectionId });
  }

  // ---------- MCP connections ----------
  private mcpKey = (projectId: string, id: string) => `${projectId}/${id}`;

  private async startMcp(c: McpConnectionRecord): Promise<McpToolServer> {
    const server = await McpToolServer.connect({
      spec: c.spec, broker: this.broker, projectId: c.projectId, connectionId: c.id,
      credentialHandle: c.credentialHandle, reviews: this.reviews, audit: this.audit,
    });
    this.mcp.set(this.mcpKey(c.projectId, c.id), server);
    this.gateway.addConnection({ id: c.id, projectId: c.projectId, service: c.service, label: c.label, credentialHandle: c.credentialHandle, server });
    return server;
  }

  /**
   * Connects to an MCP server for a project and registers it with the gateway.
   * Its tools start unreviewed: nothing it offers runs on its own until the user reviews it.
   */
  async addMcpConnection(c: McpConnectionRecord): Promise<DiscoveredTool[]> {
    if (!this.projects.has(c.projectId)) throw new Error(`unknown project ${c.projectId}`);
    if (this.mcp.has(this.mcpKey(c.projectId, c.id))) throw new Error("connection id already in use");
    if (c.credentialHandle && !this.vault.has(c.projectId, c.credentialHandle)) throw new Error(`no credential "${c.credentialHandle}" in this project's vault`);
    const server = await this.startMcp(c);
    this.mcpRecords.push(c);
    this.saveState();
    this.audit.append({ kind: "mcp.connected", projectId: c.projectId, connectionId: c.id, service: c.service, tools: server.tools().length });
    return server.discovered();
  }

  async removeMcpConnection(projectId: string, id: string): Promise<void> {
    const key = this.mcpKey(projectId, id);
    await this.mcp.get(key)?.close();
    this.mcp.delete(key);
    this.gateway.removeConnection(projectId, id);
    this.mcpRecords = this.mcpRecords.filter((r) => !(r.projectId === projectId && r.id === id));
    this.grants = this.grants.filter((g) => !(g.projectId === projectId && g.connectionId === id));
    this.reviews.clear(projectId, id);
    this.saveState();
    this.audit.append({ kind: "mcp.removed", projectId, connectionId: id });
  }

  /** Reconnects saved MCP connections at startup. One that fails does not stop the others. */
  private async restoreConnections(): Promise<void> {
    for (const c of this.mcpRecords) {
      try { await this.startMcp(c); } catch (e) {
        this.audit.append({ kind: "mcp.restore_failed", projectId: c.projectId, connectionId: c.id, error: this.broker.scrub(c.projectId, e instanceof Error ? e.message : String(e)) });
      }
    }
  }

  private mcpServer(projectId: string, id: string): McpToolServer {
    const s = this.mcp.get(this.mcpKey(projectId, id));
    if (!s) throw new Error("unknown connection");
    return s;
  }

  discoveredTools(projectId: string, connectionId: string): DiscoveredTool[] {
    return this.mcpServer(projectId, connectionId).discovered();
  }

  /** Records the user's decision for one tool, pinned to the tool's current definition. */
  reviewTool(projectId: string, connectionId: string, tool: string, decision: { risk: Risk; outbound?: boolean; resourceArg?: string; resourceArgs?: string[] }): void {
    const server = this.mcpServer(projectId, connectionId);
    const d = server.discovered().find((t) => t.name === tool);
    if (!d) throw new Error("unknown tool");
    for (const a of [...(decision.resourceArg ? [decision.resourceArg] : []), ...(decision.resourceArgs ?? [])]) {
      if (!d.args.includes(a)) throw new Error(`the tool has no argument "${a}"`);
    }
    this.reviews.set(projectId, connectionId, tool, {
      hash: d.hash, risk: decision.risk,
      ...(decision.outbound ? { outbound: true } : {}),
      ...(decision.resourceArgs ? { resourceArgs: decision.resourceArgs } : decision.resourceArg ? { resourceArg: decision.resourceArg } : {}),
    });
    server.applyReviews();
    this.audit.append({ kind: "tool.reviewed", projectId, connectionId, tool, ...decision });
  }

  // ---------- running agents ----------
  private engineFor(a: AgentRecord): AgentEngine {
    if (a.engine === "claude-code") {
      const c = this.opts.claude ?? {};
      return new ClaudeCodeEngine({
        gateway: this.gateway, workRoot: join(this.opts.home, "claude-work"), command: c.command, commandArgs: c.commandArgs, timeoutMs: c.timeoutMs,
        scrub: (projectId, t) => this.broker.scrub(projectId, t),
      });
    }
    throw new Error(`${a.name} has no engine yet. Set engine to "claude-code" (the API engine is not built).`);
  }

  setAgentEngine(agentId: string, engine: "claude-code", model?: string): void {
    const a = this.agents.get(agentId);
    if (!a) throw new Error("unknown agent");
    a.engine = engine;
    if (model !== undefined) a.engineModel = model || undefined;
    this.saveState();
  }

  private asEngineAgent(a: AgentRecord): EngineAgent {
    return { id: a.id, name: a.name, role: a.role, projectId: a.projectId, model: a.engineModel };
  }

  /** Marks the agent while it works and records how it ended. Usage limits put it to sleep. */
  private async tracked(agentId: string, kind: string, fn: (a: AgentRecord) => Promise<EngineOutcome>): Promise<EngineOutcome> {
    const a = this.agents.get(agentId);
    if (!a) throw new Error("unknown agent");
    const now = this.opts.now?.() ?? Date.now();
    if (a.status === "asleep" && a.sleepUntil && now < a.sleepUntil) {
      throw new Error(`${a.name} is resting until ${new Date(a.sleepUntil).toLocaleTimeString()} (usage limit).`);
    }
    if (a.status === "working") throw new Error(`${a.name} is already working.`);
    a.status = "working";
    a.sleepUntil = undefined;
    this.audit.append({ kind: `run.${kind}`, projectId: a.projectId, agentId });
    let outcome: EngineOutcome;
    try {
      outcome = await fn(a);
    } catch (e) {
      a.status = "idle";
      this.audit.append({ kind: "run.ended", projectId: a.projectId, agentId, status: "failed" });
      throw e;
    }
    if (outcome.status === "rate_limited") {
      a.status = "asleep";
      a.sleepUntil = outcome.resetAt ?? (this.opts.now?.() ?? Date.now()) + (this.opts.restMs ?? 30 * 60_000);
    } else {
      a.status = "idle";
    }
    if (outcome.status === "finished" && outcome.tokens) a.tokensToday += outcome.tokens;
    this.audit.append({ kind: "run.ended", projectId: a.projectId, agentId, status: outcome.status });
    this.saveState();
    return outcome;
  }

  /** Runs one task for an agent on its engine. */
  runTask(agentId: string, task: string, o: { engine?: AgentEngine; runId?: string; emit?: (e: RunEvent) => void; signal?: AbortSignal } = {}): Promise<EngineOutcome> {
    return this.tracked(agentId, "started", (a) =>
      (o.engine ?? this.engineFor(a)).run({ agent: this.asEngineAgent(a), task, runId: o.runId ?? `run_${Date.now().toString(36)}`, emit: o.emit, signal: o.signal }),
    );
  }

  /** Continues a run that was waiting for approval. */
  continueRun(resume: ResumeState, followUp: string, o: { engine?: AgentEngine; emit?: (e: RunEvent) => void; signal?: AbortSignal } = {}): Promise<EngineOutcome> {
    return this.tracked(resume.agent.id, "resumed", (a) => (o.engine ?? this.engineFor(a)).resume(resume, followUp, { emit: o.emit, signal: o.signal }));
  }

  async close(): Promise<void> {
    await Promise.all([...this.mcp.values()].map((s) => s.close()));
    this.mcp.clear();
  }

  agentCtx(agentId: string): AgentCtx | undefined {
    const a = this.agents.get(agentId);
    if (!a) return undefined;
    return { agentId, projectId: a.projectId, mode: a.mode, grants: this.grants.filter((g) => g.agentId === agentId && g.projectId === a.projectId) };
  }

  // ---------- what the cloud is allowed to know ----------
  statusSnapshot(): StatusSnapshot {
    const agents = [...this.agents.values()];
    const waiting = new Set(this.approvals.pending().map((a) => a.agentId));
    return {
      officeName: this.opts.name,
      version: this.opts.version ?? "0.0.0",
      agents: { total: agents.length, working: agents.filter((a) => a.status === "working").length, waiting: waiting.size },
      pendingApprovals: this.approvals.pending().length,
      tokensToday: agents.reduce((n, a) => n + a.tokensToday, 0),
      projects: [...this.projects.values()].map((p) => ({ id: p.id, name: p.name, agents: agents.filter((a) => a.projectId === p.id).length })),
    };
  }

  // ---------- relayed messages ----------
  /** Everything the hub forwards lands here. The return value goes back to the sender. */
  async handleRelay(payload: unknown): Promise<unknown> {
    const type = (payload as { type?: unknown } | null)?.type;
    if (typeof type === "string" && type.startsWith("pair.")) {
      const r = await this.pairing.handle(payload);
      this.audit.append({ kind: "pairing", outcome: r.type === "pair.accepted" ? "accepted" : r.reason });
      return r;
    }

    const v = await verifyCommand(payload, { officeId: this.officeId ?? "", device: (id) => this.trust.get(id), nonces: this.nonces, now: this.opts.now?.(), notBefore: this.startedAt });
    const nonce = typeof (payload as { nonce?: unknown } | null)?.nonce === "string" ? (payload as { nonce: string }).nonce : "";
    if (!v.ok) {
      this.audit.append({ kind: "command.rejected", reason: v.reason });
      return this.reply({ type: "command.reply", nonce, ok: false, error: v.reason });
    }
    try {
      const result = await this.dispatch(v.command.type, v.command.payload, v.deviceId);
      this.audit.append({ kind: "command", deviceId: v.deviceId, command: v.command.type, outcome: "ok" });
      return this.reply({ type: "command.reply", nonce: v.nonce, ok: true, result });
    } catch (e) {
      const error = e instanceof Error ? e.message : "failed";
      this.audit.append({ kind: "command", deviceId: v.deviceId, command: v.command.type, outcome: "error", error });
      return this.reply({ type: "command.reply", nonce: v.nonce, ok: false, error });
    }
  }

  private reply(body: CommandReplyBody) {
    return signObject(this.signer, body);
  }

  private async dispatch(type: string, payload: Record<string, unknown>, deviceId: string): Promise<unknown> {
    switch (type) {
      case "ping":
        return { pong: this.opts.now?.() ?? Date.now(), officeName: this.opts.name };
      case "status.get":
        return this.statusSnapshot();
      case "approvals.list":
        return this.approvals.pending().map((a) => ({
          id: a.id, agent: this.agents.get(a.agentId)?.name ?? a.agentId, summary: a.summary, risk: a.risk, reason: a.reason, expiresAt: a.expiresAt,
        }));
      case "approval.resolve": {
        const a = z.object({ approvalId: z.string(), approve: z.boolean() }).parse(payload);
        return this.gateway.resolveApproval(a.approvalId, a.approve, deviceId);
      }
      case "tools.discovered": {
        const a = z.object({ projectId: z.string(), connectionId: z.string() }).parse(payload);
        return this.discoveredTools(a.projectId, a.connectionId);
      }
      case "tools.review": {
        const a = z.object({ projectId: z.string(), connectionId: z.string(), tool: z.string(), risk: Risk, outbound: z.boolean().optional(), resourceArg: z.string().optional(), resourceArgs: z.array(z.string()).min(1).max(4).optional() }).parse(payload);
        this.reviewTool(a.projectId, a.connectionId, a.tool, { risk: a.risk, outbound: a.outbound, resourceArg: a.resourceArg, resourceArgs: a.resourceArgs });
        return { reviewed: a.tool };
      }
      case "devices.list":
        return this.trust.list().map((d) => ({ deviceId: d.deviceId, name: d.name, addedAt: d.addedAt, revoked: Boolean(d.revoked) }));
      case "devices.revoke": {
        const a = z.object({ deviceId: z.string() }).parse(payload);
        if (!this.trust.revoke(a.deviceId)) throw new Error("unknown device");
        return { revoked: a.deviceId };
      }
      default:
        throw new Error("unknown_command");
    }
  }
}

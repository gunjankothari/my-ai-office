import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDef } from "@agent-office/shared";
import type { AuditLog } from "../audit";
import type { CredentialBroker } from "../broker";
import type { ToolServer } from "../gateway";
import { SAFE_TOOL_NAME, describe, toToolDef, type DiscoveredTool, type McpToolInfo, type ToolReviews } from "./review";

/*
 * Adapter between the official MCP SDK client and the gateway's ToolServer interface.
 * The SDK does the protocol work (handshake, tool listing, calls, validation, transports).
 * This file adds what the SDK does not: credential injection from the vault, review and
 * pinning of tool definitions, text-only output, and reconnecting.
 *
 * Not covered here: sandboxing the server process (wrap `command` in a container runner),
 * and the OAuth flow for remote servers (the SDK's `authProvider` hook is the place for it).
 */

export type McpSpec =
  | {
      kind: "stdio";
      command: string;
      args?: string[];
      cwd?: string;
      /** Extra non-secret environment variables. The host's own environment is NOT passed on. */
      env?: Record<string, string>;
      /** Name of the environment variable that receives the vault credential. */
      secretEnv?: string;
    }
  | {
      kind: "http";
      url: string;
      /** Header that carries the credential. Default "Authorization". */
      secretHeader?: string;
      /** Text put before the credential. Default "Bearer ". */
      secretPrefix?: string;
      /** Extra non-secret headers, for example { "X-MCP-Readonly": "true" }. */
      headers?: Record<string, string>;
    };

export interface McpConnectOptions {
  spec: McpSpec;
  broker: CredentialBroker;
  projectId: string;
  connectionId: string;
  reviews: ToolReviews;
  /** Vault handle holding the credential. Omit for servers that need none. */
  credentialHandle?: string;
  audit?: AuditLog;
  timeoutMs?: number;
}

const MAX_TOOLS = 500;

/** Text only. Images and binary blobs are named, never inlined into the model's context. */
export function flattenContent(res: { content?: unknown[]; structuredContent?: unknown }): string {
  const parts: string[] = [];
  for (const b of (res.content ?? []) as Record<string, any>[]) {
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "image") parts.push(`[image omitted, ${b.mimeType ?? "unknown type"}]`);
    else if (b.type === "audio") parts.push(`[audio omitted, ${b.mimeType ?? "unknown type"}]`);
    else if (b.type === "resource_link") parts.push(`[link ${b.uri}]`);
    else if (b.type === "resource") parts.push(typeof b.resource?.text === "string" ? b.resource.text : `[resource ${b.resource?.uri ?? "?"} omitted]`);
  }
  if (parts.length === 0 && res.structuredContent !== undefined) return JSON.stringify(res.structuredContent);
  return parts.join("\n");
}

function assertSafeUrl(raw: string): URL {
  const u = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("remote MCP servers must use https");
  return u;
}

export class McpToolServer implements ToolServer {
  private client: Client | undefined;
  private connected = false;
  private raw: McpToolInfo[] = [];
  private defs = new Map<string, ToolDef>();
  private opening: Promise<void> | undefined;

  private constructor(private readonly o: McpConnectOptions) {}

  static async connect(o: McpConnectOptions): Promise<McpToolServer> {
    if (o.spec.kind === "http") assertSafeUrl(o.spec.url);
    const s = new McpToolServer(o);
    await s.open();
    return s;
  }

  private get timeout(): number {
    return this.o.timeoutMs ?? 30_000;
  }

  /** Builds the transport. The credential is read from the vault here and goes straight into the child's environment or the request header. */
  private async transport(): Promise<Transport> {
    const { spec, broker, projectId, credentialHandle } = this.o;
    const build = (secret: string | undefined): Transport => {
      if (spec.kind === "stdio") {
        const env: Record<string, string> = { ...getDefaultEnvironment(), ...(spec.env ?? {}) };
        if (secret !== undefined && spec.secretEnv) env[spec.secretEnv] = secret;
        return new StdioClientTransport({ command: spec.command, args: spec.args, cwd: spec.cwd, env, stderr: "ignore" });
      }
      const headers: Record<string, string> = { ...(spec.headers ?? {}) };
      if (secret !== undefined) headers[spec.secretHeader ?? "Authorization"] = (spec.secretPrefix ?? "Bearer ") + secret;
      return new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers }, redirectPolicy: "same-origin" });
    };
    return credentialHandle ? broker.withCredential(projectId, credentialHandle, (s) => build(s)) : build(undefined);
  }

  /** (Re)connects. Called at start and again, once, if the server process has gone away. */
  private open(): Promise<void> {
    this.opening ??= (async () => {
      try {
        const client = new Client({ name: "agent-office", version: "0.0.0" });
        client.onclose = () => { this.connected = false; };
        await client.connect(await this.transport(), { timeout: this.timeout });
        this.client = client;
        this.connected = true;
        await this.refresh();
      } finally {
        this.opening = undefined;
      }
    })();
    return this.opening;
  }

  /** Lists the server's tools again and recomputes review state. Definitions that changed since review are flagged. */
  async refresh(): Promise<void> {
    if (!this.client) throw new Error("not connected");
    const all: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20 && all.length < MAX_TOOLS; page++) {
      const r = await this.client.listTools(cursor ? { cursor } : undefined, { timeout: this.timeout });
      all.push(...(r.tools as unknown as McpToolInfo[]));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    const safe = all.filter((t) => SAFE_TOOL_NAME.test(t.name)).slice(0, MAX_TOOLS);
    if (safe.length < all.length) this.audit({ kind: "mcp.tools_skipped", count: all.length - safe.length });
    this.raw = safe;
    this.applyReviews(true);
  }

  /** Recomputes tool definitions from the current review decisions. Call after the user reviews a tool. */
  applyReviews(auditChanges = false): void {
    const entries = this.o.reviews.get(this.o.projectId, this.o.connectionId);
    this.defs.clear();
    for (const t of this.raw) {
      const entry = entries[t.name];
      this.defs.set(t.name, toToolDef(t, entry));
      if (auditChanges && entry && describe(t, entry).changed) {
        this.audit({ kind: "mcp.tool_changed", tool: t.name, note: "definition changed since it was reviewed; it needs review again" });
      }
    }
  }

  private audit(e: Record<string, unknown>): void {
    this.o.audit?.append({ projectId: this.o.projectId, connectionId: this.o.connectionId, ...e });
  }

  tools(): ToolDef[] {
    return [...this.defs.values()];
  }

  schema(tool: string): unknown {
    return this.raw.find((t) => t.name === tool)?.inputSchema;
  }

  /** For the review screen. */
  discovered(): DiscoveredTool[] {
    const entries = this.o.reviews.get(this.o.projectId, this.o.connectionId);
    return this.raw.map((t) => describe(t, entries[t.name]));
  }

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.defs.has(tool)) throw new Error(`unknown tool ${tool}`);
    if (!this.connected) await this.open();
    const res = (await this.client!.callTool({ name: tool, arguments: args }, undefined, { timeout: this.timeout })) as unknown as {
      content?: unknown[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    const text = flattenContent(res);
    if (res.isError) throw new Error(text || "the tool reported an error");
    return text;
  }

  async close(): Promise<void> {
    this.connected = false;
    await this.client?.close().catch(() => {});
  }
}

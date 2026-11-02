import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallResult, ToolGateway, ToolIndexEntry } from "../gateway";

/*
 * Offers ONE agent's granted tools to an external program (the Claude Code engine) as an MCP
 * server, so that every action goes through the gateway: grants, reviews, resource limits,
 * approvals, credential injection, scrubbing and the audit log all still apply.
 *
 *   - listens on 127.0.0.1 only, on a random port, for the length of one run,
 *   - every request needs the run's random token (compared in constant time),
 *   - the Host header must be loopback, which stops DNS-rebinding from a web page,
 *   - the token is bound to one agent, and the tool list is rebuilt on every request,
 *     so a grant revoked mid-run disappears immediately.
 */

export interface PendingApproval { approvalId: string; connectionId: string; tool: string; summary: string }

export interface GatewayMcpOptions {
  gateway: ToolGateway;
  agentId: string;
  /** Called for each tool call with its outcome, for run events. */
  onCall?: (e: { connectionId: string; tool: string; outcome: CallResult["status"] }) => void;
}

export interface RunningGatewayMcp {
  url: string;
  token: string;
  /** Approvals requested during this run. The tool call returned immediately; the run ends and resumes later. */
  pending: PendingApproval[];
  close(): Promise<void>;
}

export const SERVER_NAME = "office";
const MAX_FULL_NAME = 64;
const PREFIX_LEN = `mcp__${SERVER_NAME}__`.length;

const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
export const exposedName = (e: Pick<ToolIndexEntry, "connectionId" | "name">) => `${clean(e.connectionId)}__${clean(e.name)}`;

const eq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

export async function startGatewayMcp(o: GatewayMcpOptions): Promise<RunningGatewayMcp> {
  const token = randomBytes(32).toString("base64url");
  const pending: PendingApproval[] = [];
  let port = 0;

  /** Tools the model may see, keyed by the name it will use. Names too long for Claude are left out. */
  const visible = () => {
    const m = new Map<string, ToolIndexEntry>();
    for (const e of o.gateway.listTools(o.agentId)) {
      const n = exposedName(e);
      if (PREFIX_LEN + n.length <= MAX_FULL_NAME && !m.has(n)) m.set(n, e);
    }
    return m;
  };

  const buildServer = () => {
    const s = new Server({ name: SERVER_NAME, version: "0.0.0" }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...visible()].map(([name, e]) => {
        const schema = (e.inputSchema && typeof e.inputSchema === "object" ? e.inputSchema : {}) as Record<string, unknown>;
        return { name, description: `[${e.service}] ${e.description}`, inputSchema: { ...schema, type: "object" as const } };
      }),
    }));
    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      const e = visible().get(req.params.name);
      if (!e) return text("Unknown tool, or it is not granted to you. Do not retry.", true);
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const r = await o.gateway.call(o.agentId, e.connectionId, e.name, args);
      o.onCall?.({ connectionId: e.connectionId, tool: e.name, outcome: r.status });
      switch (r.status) {
        case "ok":
          return text(r.truncated ? r.output + "\n[output was shortened]" : r.output);
        case "needs_approval": {
          pending.push({ approvalId: r.approvalId, connectionId: e.connectionId, tool: e.name, summary: r.reason });
          return text(
            `This action needs the user's approval and has NOT run (request ${r.approvalId}: ${r.reason}). ` +
              "The user has been asked. Do not try again and do not look for another way. Finish any other work, then say you are waiting for approval.",
          );
        }
        case "denied":
          return text(`Denied: ${r.reason}. Do not retry.`, true);
        case "dry_run":
          return text(`Dry run, not executed: ${r.wouldDo}`);
        case "error":
          return text(`The tool failed: ${r.message}`, true);
      }
    });
    return s;
  };

  const loopbackHost = (h: string | undefined) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;

  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let n = 0;
      req.on("data", (c: Buffer) => { n += c.length; if (n > 1_000_000) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
      req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined); } catch (e) { reject(e); } });
      req.on("error", reject);
    });

  const http: HttpServer = createServer(async (req, res) => {
    try {
      if (!loopbackHost(req.headers.host)) { res.writeHead(403).end(); return; }
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ") || !eq(auth.slice(7), token)) { res.writeHead(401).end(); return; }
      if (new URL(req.url ?? "/", "http://x").pathname !== "/mcp") { res.writeHead(404).end(); return; }
      if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return; }
      const body = await readBody(req);
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
    }
  });

  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  port = (http.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    pending,
    close: () => new Promise<void>((resolve) => { http.closeAllConnections(); http.close(() => resolve()); }),
  };
}

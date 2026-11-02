import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { extname, join, resolve as resolvePath, sep } from "node:path";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  ClientToHub, HostToHub, MAX_MESSAGE_BYTES, hostAuthMessage, randomId, verifySignature,
  type HubToClient, type HubToHost,
} from "@agent-office/shared";
import { HubStore } from "./store";

/*
 * The cloud hub is a deliberately dumb relay. It:
 *   - authenticates hosts with a signature challenge (enrollment binds the host's public key once),
 *   - forwards opaque `relay` / `reply` payloads between UI clients and hosts,
 *   - stores office names and the last status snapshot.
 * It never sees secrets or task contents, and it cannot make a host act: hosts only
 * run commands signed by devices the user paired with the host directly.
 *
 * Placeholder: UI clients authenticate with one admin token. Passkey (WebAuthn)
 * sign-in and per-device sessions replace this before the hub is exposed to anyone else.
 */

export interface HubOptions {
  port: number;
  adminToken: string;
  dbPath: string;
  bindHost?: string;
  allowedOrigin?: string;
  /** Max messages per second per socket before it is dropped. */
  maxMsgPerSec?: number;
  /** How long a new client connection may stay silent before it is closed. Default 5000. */
  authTimeoutMs?: number;
  /** Folder with the built web app. When set, the hub serves it. */
  webDir?: string;
  log?: (msg: string) => void;
}

export interface RunningHub {
  port: number;
  store: HubStore;
  close(): Promise<void>;
}

const safeEq = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Headers every response carries. HSTS only when the request came in over https (Railway's proxy says so). */
function securityHeaders(req: IncomingMessage): Record<string, string> {
  const https = req.headers["x-forwarded-proto"] === "https" || Boolean((req.socket as { encrypted?: boolean }).encrypted);
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    ...(https ? { "strict-transport-security": "max-age=31536000" } : {}),
  };
}

/** The web app may load its own files and Google Fonts, and talk to this hub only. */
function contentSecurityPolicy(req: IncomingMessage): string {
  const host = (req.headers.host ?? "").replace(/[^A-Za-z0-9.:\-\[\]]/g, "");
  const https = req.headers["x-forwarded-proto"] === "https" || Boolean((req.socket as { encrypted?: boolean }).encrypted);
  const live = host ? ` ${https ? "wss" : "ws"}://${host}` : "";
  return [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
    "img-src 'self' data:", `connect-src 'self'${live}`, "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ].join("; ");
}

/**
 * Serves the built web app. Only files under `root`, never anything above it. Unknown paths without a
 * file extension get index.html, so the app's own routes work on reload. A missing file with an extension is a 404.
 */
function serveStatic(req: IncomingMessage, res: ServerResponse, root: string, rawPath: string): void {
  let rel: string;
  try { rel = decodeURIComponent(rawPath); } catch { res.writeHead(400).end(); return; }
  if (rel.includes("\0") || rel.includes("\\")) { res.writeHead(400).end(); return; }

  const base = resolvePath(root);
  let file = resolvePath(join(base, "." + sep + rel));
  if (file !== base && !file.startsWith(base + sep)) { res.writeHead(404).end(); return; }

  const stat = (f: string) => { try { return statSync(f); } catch { return undefined; } };
  let st = stat(file);
  if (st?.isDirectory()) { file = join(file, "index.html"); st = stat(file); }
  if (!st?.isFile()) {
    if (extname(rel) !== "") { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found"); return; }
    file = join(base, "index.html");
    st = stat(file);
    if (!st?.isFile()) { res.writeHead(404).end(); return; }
  }

  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const html = type.startsWith("text/html");
  const hashed = rel.startsWith("/assets/");
  res.writeHead(200, {
    "content-type": type,
    "content-length": st.size,
    "cache-control": html ? "no-cache" : hashed ? "public, max-age=31536000, immutable" : "public, max-age=300",
    ...(html ? { "content-security-policy": contentSecurityPolicy(req) } : {}),
  });
  if (req.method === "HEAD") { res.end(); return; }
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

interface ClientConn { id: string; ws: WebSocket; subs: Set<string>; talkedTo: Set<string> }

export async function startHub(opts: HubOptions): Promise<RunningHub> {
  const log = opts.log ?? (() => {});
  const store = new HubStore(opts.dbPath);
  const hosts = new Map<string, WebSocket>();
  const clients = new Map<string, ClientConn>();
  const maxRate = opts.maxMsgPerSec ?? 50;
  const origin = opts.allowedOrigin ?? "http://localhost:5173";
  let closed = false;

  const sendJson = (ws: WebSocket, msg: HubToClient | HubToHost) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const officeStatusMsg = (officeId: string): HubToClient | undefined => {
    const o = store.office(officeId);
    if (!o) return undefined;
    return { type: "office.status", officeId, online: hosts.has(officeId), lastSeen: o.lastSeen, status: o.status };
  };

  const broadcastStatus = (officeId: string) => {
    const msg = officeStatusMsg(officeId);
    if (!msg) return;
    for (const c of clients.values()) if (c.subs.has(officeId)) sendJson(c.ws, msg);
  };

  // ---------- HTTP ----------
  const cors = (res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Vary", "Origin");
  };
  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const isAdmin = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? "";
    return h.startsWith("Bearer ") && safeEq(h.slice(7), opts.adminToken);
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let n = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        n += c.length;
        if (n > 4096) { reject(new Error("too large")); req.destroy(); } else chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  const http = createServer(async (req, res) => {
    for (const [k, v] of Object.entries(securityHeaders(req))) res.setHeader(k, v);
    cors(res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    let path: string;
    try { path = new URL(req.url ?? "/", "http://x").pathname; } catch { res.writeHead(400).end(); return; }
    try {
      if (path === "/healthz") { res.writeHead(200); res.end("ok"); return; }
      if (path.startsWith("/api/") && !isAdmin(req)) return json(res, 401, { error: "unauthorized" });
      if (path === "/api/offices" && req.method === "GET") {
        return json(res, 200, store.offices().map((o) => ({ ...o, online: hosts.has(o.id) })));
      }
      if (path === "/api/offices" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { name?: unknown };
        const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
        if (!name) return json(res, 400, { error: "name required" });
        return json(res, 201, store.createOffice(name));
      }
      if (opts.webDir && !path.startsWith("/api/") && (req.method === "GET" || req.method === "HEAD")) return serveStatic(req, res, opts.webDir, path);
      json(res, 404, { error: "not found" });
    } catch {
      json(res, 400, { error: "bad request" });
    }
  });

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/host") {
      wss.handleUpgrade(req, socket, head, (ws) => onHost(ws));
    } else if (url.pathname === "/client") {
      // The token is not in the URL (logs keep URLs). The client proves itself with its first message.
      wss.handleUpgrade(req, socket, head, (ws) => onClient(ws));
    } else {
      socket.destroy();
    }
  });

  const limiter = (ws: WebSocket) => {
    let n = 0;
    const t = setInterval(() => { n = 0; }, 1000);
    ws.on("close", () => clearInterval(t));
    return () => {
      if (++n > maxRate) { ws.close(1008, "rate limit"); return false; }
      return true;
    };
  };
  const parse = (data: RawData): unknown => {
    try { return JSON.parse(data.toString()); } catch { return undefined; }
  };

  function onHost(ws: WebSocket) {
    const nonce = randomId("c_", 16);
    let officeId: string | undefined;
    const ok = limiter(ws);
    // Without an error listener, an oversized frame would crash the whole process.
    ws.on("error", (e) => log(`host socket error: ${e.message}`));
    sendJson(ws, { type: "challenge", nonce });

    ws.on("message", async (data) => {
      if (closed || !ok()) return;
      const parsed = HostToHub.safeParse(parse(data));
      if (!parsed.success) return sendJson(ws, { type: "error", code: "bad_message" });
      const m = parsed.data;

      if (!officeId) {
        if (m.type === "host.enroll") {
          const id = store.enroll(m.enrollToken, m.hostPublicKey);
          if (!id) { sendJson(ws, { type: "error", code: "bad_enroll_token" }); return ws.close(1008); }
          officeId = id;
          sendJson(ws, { type: "enrolled", officeId: id });
        } else if (m.type === "host.auth") {
          const o = store.office(m.officeId);
          const good = o?.hostPublicKey ? await verifySignature(o.hostPublicKey, hostAuthMessage(nonce, m.officeId), m.signature) : false;
          if (closed) return;
          if (!good) { sendJson(ws, { type: "error", code: "bad_signature" }); return ws.close(1008); }
          officeId = m.officeId;
          sendJson(ws, { type: "authed" });
        } else {
          return sendJson(ws, { type: "error", code: "not_authenticated" });
        }
        hosts.get(officeId)?.close(4000, "replaced");
        hosts.set(officeId, ws);
        store.touch(officeId);
        log(`host online: ${officeId}`);
        broadcastStatus(officeId);
        return;
      }

      switch (m.type) {
        case "status":
          store.setStatus(officeId, m.status);
          broadcastStatus(officeId);
          break;
        case "reply": {
          const c = clients.get(m.to);
          // Only answer clients that actually talked to this office.
          if (c && c.talkedTo.has(officeId)) sendJson(c.ws, { type: "reply", officeId, payload: m.payload });
          break;
        }
        case "event":
          for (const c of clients.values()) if (c.subs.has(officeId)) sendJson(c.ws, { type: "event", officeId, payload: m.payload });
          break;
        default:
          sendJson(ws, { type: "error", code: "unexpected" });
      }
    });

    ws.on("close", () => {
      if (!closed && officeId && hosts.get(officeId) === ws) {
        hosts.delete(officeId);
        log(`host offline: ${officeId}`);
        broadcastStatus(officeId);
      }
    });
  }

  function onClient(ws: WebSocket) {
    const c: ClientConn = { id: randomId("cl_"), ws, subs: new Set(), talkedTo: new Set() };
    let authed = false;
    const ok = limiter(ws);
    ws.on("error", (e) => log(`client socket error: ${e.message}`));
    // A connection that says nothing is closed. Until it authenticates it is not registered anywhere,
    // so a host cannot reach it and it can ask for nothing.
    const deadline = setTimeout(() => { if (!authed) ws.close(1008, "auth timeout"); }, opts.authTimeoutMs ?? 5000);
    ws.on("close", () => { clearTimeout(deadline); clients.delete(c.id); });

    ws.on("message", (data) => {
      if (closed || !ok()) return;
      const parsed = ClientToHub.safeParse(parse(data));

      if (!authed) {
        if (!parsed.success || parsed.data.type !== "auth" || !safeEq(parsed.data.token, opts.adminToken)) {
          sendJson(ws, { type: "error", code: "unauthorized" });
          return ws.close(1008, "unauthorized");
        }
        authed = true;
        clearTimeout(deadline);
        clients.set(c.id, c);
        sendJson(ws, { type: "hello", clientId: c.id });
        return;
      }

      if (!parsed.success) return sendJson(ws, { type: "error", code: "bad_message" });
      const m = parsed.data;
      if (m.type === "subscribe") {
        if (!store.office(m.officeId)) return sendJson(ws, { type: "error", code: "unknown_office", officeId: m.officeId });
        c.subs.add(m.officeId);
        const s = officeStatusMsg(m.officeId);
        if (s) sendJson(ws, s);
      } else if (m.type === "relay") {
        const host = hosts.get(m.officeId);
        if (!host) return sendJson(ws, { type: "error", code: "office_offline", officeId: m.officeId });
        c.talkedTo.add(m.officeId);
        sendJson(host, { type: "relay", from: c.id, payload: m.payload });
      }
    });
  }

  await new Promise<void>((resolve) => http.listen(opts.port, opts.bindHost ?? "127.0.0.1", resolve));
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  log(`hub listening on ${port}`);

  return {
    port,
    store,
    async close() {
      closed = true;
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((r) => http.close(() => r()));
      http.closeAllConnections?.();
      store.close();
    },
  };
}

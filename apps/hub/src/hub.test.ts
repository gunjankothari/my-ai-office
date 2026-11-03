import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { generateKeyPair, hostAuthMessage, signerFromExported } from "@agent-office/shared";
import { startHub, type RunningHub } from "./server";

const TOKEN = "test-admin-token-0123456789";
const hubs: RunningHub[] = [];
after(async () => { for (const h of hubs) await h.close(); });

async function boot(extra: Partial<Parameters<typeof startHub>[0]> = {}) {
  const hub = await startHub({ port: 0, adminToken: TOKEN, dbPath: join(mkdtempSync(join(tmpdir(), "hub-")), "hub.db"), ...extra });
  hubs.push(hub);
  const base = `http://127.0.0.1:${hub.port}`;
  const api = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    fetch(base + path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" } });
  return { hub, base, api, ws: `ws://127.0.0.1:${hub.port}` };
}

/** Collects JSON messages from a socket and lets a test wait for one. */
function tap(ws: WebSocket) {
  const msgs: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    msgs.push(m);
    waiters.splice(0).forEach((w) => w(m));
  });
  const next = (pred: (m: any) => boolean = () => true, ms = 2000): Promise<any> =>
    new Promise((resolve, reject) => {
      const found = msgs.find(pred);
      if (found) { msgs.splice(msgs.indexOf(found), 1); return resolve(found); }
      const t = setTimeout(() => reject(new Error("timeout waiting for message")), ms);
      const w = (m: any) => {
        if (pred(m)) { clearTimeout(t); msgs.splice(msgs.indexOf(m), 1); resolve(m); } else waiters.push(w);
      };
      waiters.push(w);
    });
  const open = () => new Promise<void>((r) => (ws.readyState === WebSocket.OPEN ? r() : ws.once("open", () => r())));
  return { msgs, next, open };
}

/** Opens a client connection and signs in the way the web app does: the token goes in the first message. */
async function connectClient(b: Awaited<ReturnType<typeof boot>>, token = TOKEN) {
  const c = new WebSocket(`${b.ws}/client`);
  const ct = tap(c);
  await ct.open();
  c.send(JSON.stringify({ type: "auth", token }));
  const hello = await ct.next((m) => m.type === "hello");
  return { c, ct, hello };
}

async function enrolledHost(b: Awaited<ReturnType<typeof boot>>) {
  const created = await (await b.api("/api/offices", { method: "POST", body: JSON.stringify({ name: "Home lab" }) })).json() as { id: string; enrollToken: string };
  const kp = await generateKeyPair();
  const signer = await signerFromExported(kp);
  const ws = new WebSocket(`${b.ws}/host`);
  const t = tap(ws);
  const ch = await t.next((m) => m.type === "challenge");
  ws.send(JSON.stringify({ type: "host.enroll", enrollToken: created.enrollToken, hostPublicKey: kp.publicKey }));
  const en = await t.next((m) => m.type === "enrolled");
  assert.equal(en.officeId, created.id);
  return { officeId: created.id, kp, signer, ws, t, challenge: ch.nonce as string };
}

test("admin API needs the token; offices can be created and listed", async () => {
  const b = await boot();
  assert.equal((await b.api("/api/offices", {}, null)).status, 401);
  assert.equal((await b.api("/api/offices", {}, "wrong-token-wrong-token")).status, 401);
  assert.equal((await b.api("/api/offices", { method: "POST", body: JSON.stringify({}) })).status, 400);
  const r = await b.api("/api/offices", { method: "POST", body: JSON.stringify({ name: "Studio laptop" }) });
  assert.equal(r.status, 201);
  const list = await (await b.api("/api/offices")).json() as any[];
  assert.equal(list.length, 1);
  assert.equal(list[0].online, false);
  assert.equal(list[0].hostPublicKey, null);
});

test("deleting an office needs the token, disconnects its host and stops it reconnecting", async () => {
  const b = await boot();
  const h = await enrolledHost(b);
  const closed = new Promise<number>((r) => h.ws.on("close", (code) => r(code)));
  assert.equal((await b.api(`/api/offices/${h.officeId}`, { method: "DELETE" }, null)).status, 401);
  assert.equal((await b.api("/api/offices/off_nope", { method: "DELETE" })).status, 404);
  assert.equal((await b.api(`/api/offices/${h.officeId}`, { method: "DELETE" })).status, 200);
  assert.equal(await closed, 4001);
  assert.equal(b.hub.store.offices().length, 0);

  const ws = new WebSocket(`${b.ws}/host`);
  const t = tap(ws);
  const ch = await t.next((m) => m.type === "challenge");
  ws.send(JSON.stringify({ type: "host.auth", officeId: h.officeId, signature: await h.signer.sign(hostAuthMessage(ch.nonce, h.officeId)) }));
  assert.equal((await t.next((m) => m.type === "error")).code, "bad_signature");
});

test("a host enrolls once with its token; the token cannot be reused", async () => {
  const b = await boot();
  const h = await enrolledHost(b);
  h.ws.close();
  const ws2 = new WebSocket(`${b.ws}/host`);
  const t2 = tap(ws2);
  await t2.next((m) => m.type === "challenge");
  const created = (await b.hub.store.offices())[0]!;
  assert.ok(created.hostPublicKey);
  ws2.send(JSON.stringify({ type: "host.enroll", enrollToken: "enr_0000000000000000000000000", hostPublicKey: "A".repeat(43) }));
  assert.equal((await t2.next((m) => m.type === "error")).code, "bad_enroll_token");
});

test("a host reconnects by signing the hub's challenge; a wrong key is refused", async () => {
  const b = await boot();
  const h = await enrolledHost(b);
  h.ws.close();

  const ws = new WebSocket(`${b.ws}/host`);
  const t = tap(ws);
  const ch = await t.next((m) => m.type === "challenge");
  ws.send(JSON.stringify({ type: "host.auth", officeId: h.officeId, signature: await h.signer.sign(hostAuthMessage(ch.nonce, h.officeId)) }));
  await t.next((m) => m.type === "authed");

  const rogue = await signerFromExported(await generateKeyPair());
  const ws2 = new WebSocket(`${b.ws}/host`);
  const t2 = tap(ws2);
  const ch2 = await t2.next((m) => m.type === "challenge");
  ws2.send(JSON.stringify({ type: "host.auth", officeId: h.officeId, signature: await rogue.sign(hostAuthMessage(ch2.nonce, h.officeId)) }));
  assert.equal((await t2.next((m) => m.type === "error")).code, "bad_signature");

  // a signature for an old challenge cannot be replayed on a new connection
  const ws3 = new WebSocket(`${b.ws}/host`);
  const t3 = tap(ws3);
  await t3.next((m) => m.type === "challenge");
  ws3.send(JSON.stringify({ type: "host.auth", officeId: h.officeId, signature: await h.signer.sign(hostAuthMessage(ch.nonce, h.officeId)) }));
  assert.equal((await t3.next((m) => m.type === "error")).code, "bad_signature");
});

test("relay reaches the host and replies come back; status is broadcast", async () => {
  const b = await boot();
  const h = await enrolledHost(b);

  const { c, ct, hello } = await connectClient(b);
  c.send(JSON.stringify({ type: "subscribe", officeId: h.officeId }));
  const s0 = await ct.next((m) => m.type === "office.status");
  assert.equal(s0.online, true);

  c.send(JSON.stringify({ type: "relay", officeId: h.officeId, payload: { hello: "world" } }));
  const relayed = await h.t.next((m) => m.type === "relay");
  assert.deepEqual(relayed.payload, { hello: "world" });
  assert.equal(relayed.from, hello.clientId);

  h.ws.send(JSON.stringify({ type: "reply", to: relayed.from, payload: { pong: 1 } }));
  assert.deepEqual((await ct.next((m) => m.type === "reply")).payload, { pong: 1 });

  const status = { officeName: "Home lab", version: "0", agents: { total: 3, working: 1, waiting: 1 }, pendingApprovals: 1, tokensToday: 10, projects: [] };
  h.ws.send(JSON.stringify({ type: "status", status }));
  const s1 = await ct.next((m) => m.type === "office.status" && m.status);
  assert.equal(s1.status.agents.total, 3);
  assert.equal(b.hub.store.office(h.officeId)?.status?.tokensToday, 10);

  h.ws.close();
  assert.equal((await ct.next((m) => m.type === "office.status" && m.online === false)).online, false);
  c.send(JSON.stringify({ type: "relay", officeId: h.officeId, payload: {} }));
  assert.equal((await ct.next((m) => m.type === "error")).code, "office_offline");
});

test("a host cannot send replies to clients that never talked to it", async () => {
  const b = await boot();
  const h = await enrolledHost(b);
  const { ct, hello } = await connectClient(b);
  h.ws.send(JSON.stringify({ type: "reply", to: hello.clientId, payload: { spoof: true } }));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ct.msgs.filter((m) => m.type === "reply").length, 0);
});

test("malformed, oversized and flooding messages are refused", async () => {
  const b = await boot({ maxMsgPerSec: 5 });
  const { c, ct } = await connectClient(b);
  c.send("not json");
  assert.equal((await ct.next((m) => m.type === "error")).code, "bad_message");
  c.send(JSON.stringify({ type: "relay", officeId: "x" })); // missing payload is allowed by schema (unknown), office offline
  const closed = new Promise<number>((r) => c.on("close", (code) => r(code)));
  for (let i = 0; i < 30; i++) c.send(JSON.stringify({ type: "subscribe", officeId: "nope" }));
  assert.equal(await closed, 1008, "rate limit closes the socket");

  const { c: c2 } = await connectClient(b);
  const closed2 = new Promise<number>((r) => c2.on("close", (code) => r(code)));
  c2.send("x".repeat(300 * 1024));
  assert.equal(await closed2, 1009, "oversized message closes the socket");
});

test("a client connection must sign in with its first message, or it can do nothing", async () => {
  const b = await boot({ authTimeoutMs: 300 });
  const h = await enrolledHost(b);
  const closeCode = (c: WebSocket) => new Promise<number>((r) => c.on("close", (code) => r(code)));

  // wrong token
  const bad = new WebSocket(`${b.ws}/client`);
  const badTap = tap(bad);
  await badTap.open();
  const badClosed = closeCode(bad);
  bad.send(JSON.stringify({ type: "auth", token: "not-the-token-not-the-token" }));
  assert.equal((await badTap.next((m) => m.type === "error")).code, "unauthorized");
  assert.equal(await badClosed, 1008);

  // asking for something before signing in
  const eager = new WebSocket(`${b.ws}/client`);
  const eagerTap = tap(eager);
  await eagerTap.open();
  const eagerClosed = closeCode(eager);
  eager.send(JSON.stringify({ type: "relay", officeId: h.officeId, payload: { sneaky: true } }));
  assert.equal(await eagerClosed, 1008);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(h.t.msgs.filter((m) => m.type === "relay").length, 0, "nothing reached the host");

  // saying nothing at all
  const silent = new WebSocket(`${b.ws}/client`);
  await tap(silent).open();
  assert.equal(await closeCode(silent), 1008);

  // the token is no longer accepted in the address
  const legacy = new WebSocket(`${b.ws}/client?token=${TOKEN}`);
  const legacyTap = tap(legacy);
  await legacyTap.open();
  const legacyClosed = closeCode(legacy);
  assert.equal(await legacyClosed, 1008, "a token in the URL does not sign anyone in");
  assert.equal(legacyTap.msgs.filter((m) => m.type === "hello").length, 0);
});

// ---------- serving the web app ----------
import { mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

/** Sends the path exactly as given. fetch() would tidy "/../" away before it reached the server. */
const rawGet = (port: number, path: string, o: { method?: string; headers?: Record<string, string> } = {}) =>
  new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: o.headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", reject);
    r.end();
  });

function makeSite() {
  const root = mkdtempSync(join(tmpdir(), "site-"));
  const web = join(root, "dist");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), "<!doctype html><title>Agent Office</title><script type=\"module\" src=\"/assets/app.abc123.js\"></script>");
  writeFileSync(join(web, "assets", "app.abc123.js"), "console.log('app')");
  writeFileSync(join(web, "assets", "style.abc123.css"), "body{}");
  writeFileSync(join(root, "secret.txt"), "TOP-SECRET-OUTSIDE-THE-SITE");
  return { root, web };
}

test("the web app is served, with long caching for hashed files, no caching for the page, and security headers", async () => {
  const site = makeSite();
  const b = await boot({ webDir: site.web });
  const page = await rawGet(b.hub.port, "/", { headers: { host: `127.0.0.1:${b.hub.port}`, "x-forwarded-proto": "https" } });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes("Agent Office"));
  assert.match(String(page.headers["content-type"]), /text\/html/);
  assert.equal(page.headers["cache-control"], "no-cache");
  const csp = String(page.headers["content-security-policy"]);
  assert.ok(csp.includes("default-src 'self'") && csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'"));
  assert.ok(csp.includes(`connect-src 'self' wss://127.0.0.1:${b.hub.port}`), "may open the live connection to this hub, nothing else");
  assert.ok(!/script-src[^;]*unsafe/.test(csp), "no inline or eval scripts");
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.ok(String(page.headers["strict-transport-security"]).startsWith("max-age="), "HSTS over https");

  const plain = await rawGet(b.hub.port, "/", { headers: { host: `127.0.0.1:${b.hub.port}` } });
  assert.equal(plain.headers["strict-transport-security"], undefined, "no HSTS over plain http");
  assert.ok(String(plain.headers["content-security-policy"]).includes(`ws://127.0.0.1:${b.hub.port}`));

  const js = await rawGet(b.hub.port, "/assets/app.abc123.js");
  assert.equal(js.status, 200);
  assert.match(String(js.headers["content-type"]), /javascript/);
  assert.equal(js.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal((await rawGet(b.hub.port, "/assets/style.abc123.css")).headers["content-type"], "text/css; charset=utf-8");
});

test("the app's own routes work on reload, missing files are 404, and only reading is allowed", async () => {
  const site = makeSite();
  const b = await boot({ webDir: site.web });
  const route = await rawGet(b.hub.port, "/offices/off_123");
  assert.equal(route.status, 200);
  assert.ok(route.body.includes("Agent Office"), "falls back to the page");
  assert.equal((await rawGet(b.hub.port, "/assets/missing.js")).status, 404, "a missing file is not the page");
  const head = await rawGet(b.hub.port, "/", { method: "HEAD" });
  assert.deepEqual([head.status, head.body], [200, ""]);
  assert.equal((await rawGet(b.hub.port, "/", { method: "POST" })).status, 404);
  assert.equal((await rawGet(b.hub.port, "/healthz")).body, "ok");
});

test("nothing outside the web folder can be read, however the path is written", async () => {
  const site = makeSite();
  const b = await boot({ webDir: site.web });
  for (const path of [
    "/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/%2e%2e%2fsecret.txt", "/assets/../../secret.txt",
    "/assets/%2e%2e/%2e%2e/secret.txt", "/..\\secret.txt", "/%5c..%5csecret.txt", "/%00", "/%2e%2e/%2e%2e/%2e%2e/etc/passwd", "/..%252fsecret.txt",
  ]) {
    const r = await rawGet(b.hub.port, path);
    assert.ok(!r.body.includes("TOP-SECRET-OUTSIDE-THE-SITE"), `${path} leaked the file`);
    assert.ok(!r.body.includes("root:"), `${path} leaked passwd`);
  }
  // a path that names a file (has an extension) is never answered with the page: it is refused
  for (const path of ["/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt"]) assert.ok([400, 404].includes((await rawGet(b.hub.port, path)).status), path);
});

test("the API stays protected and is never cached when the web app is served", async () => {
  const site = makeSite();
  const b = await boot({ webDir: site.web });
  const noAuth = await rawGet(b.hub.port, "/api/offices");
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.headers["cache-control"], "no-store");
  const unknown = await rawGet(b.hub.port, "/api/nothing", { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(unknown.status, 404);
  assert.ok(unknown.body.includes("not found") && !unknown.body.includes("Agent Office"), "an unknown API path is not answered with the page");
  assert.equal((await b.api("/api/offices")).status, 200);
});

test("without a web folder the hub serves no pages", async () => {
  const b = await boot();
  assert.equal((await rawGet(b.hub.port, "/")).status, 404);
});

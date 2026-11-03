import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startHub, type RunningHub } from "./server";

const TOKEN = "test-admin-token-0123456789";
const ORIGIN = "http://localhost:5173";
const hubs: RunningHub[] = [];
after(async () => { for (const h of hubs) await h.close(); });

async function boot(extra: Partial<Parameters<typeof startHub>[0]> = {}) {
  const hub = await startHub({ port: 0, adminToken: TOKEN, dbPath: join(mkdtempSync(join(tmpdir(), "hub-")), "hub.db"), allowedOrigin: ORIGIN, ...extra });
  hubs.push(hub);
  const post = (path: string, body: unknown, token: string | null = TOKEN) =>
    fetch(`http://127.0.0.1:${hub.port}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  const get = (path: string, token: string | null = TOKEN) =>
    fetch(`http://127.0.0.1:${hub.port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { hub, post, get, ws: `ws://127.0.0.1:${hub.port}` };
}

// ---- a software authenticator: just enough CBOR and WebAuthn to stand in for a phone or laptop ----
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
}
const cbor = (v: unknown): Buffer => {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  const entries = [...(v as Map<unknown, unknown>).entries()];
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
};

class Authenticator {
  readonly credId = randomBytes(16);
  private priv: KeyObject;
  private pubJwk: { x: string; y: string };
  counter = 0;
  constructor(private origin = ORIGIN, private rpId = "localhost") {
    const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.priv = kp.privateKey;
    this.pubJwk = kp.publicKey.export({ format: "jwk" }) as { x: string; y: string };
  }
  get id() { return b64u(this.credId); }

  register(challenge: string) {
    const cose = cbor(new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.pubJwk.x, "base64url")], [-3, Buffer.from(this.pubJwk.y, "base64url")]]));
    const idLen = Buffer.from([0, this.credId.length]);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), idLen, this.credId, cose]);
    const clientData = JSON.stringify({ type: "webauthn.create", challenge, origin: this.origin, crossOrigin: false });
    const att = cbor(new Map<unknown, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(Buffer.from(clientData)), attestationObject: b64u(att), transports: ["internal"] },
    };
  }

  login(challenge: string) {
    this.counter += 1;
    const c = Buffer.alloc(4);
    c.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([0x05]), c]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: this.origin, crossOrigin: false }));
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.priv);
    return {
      id: this.id, rawId: this.id, type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) },
    };
  }
}

type B = Awaited<ReturnType<typeof boot>>;

async function registerKey(b: B, key = new Authenticator(), token = TOKEN, name = "Laptop") {
  const opts = (await (await b.post("/api/passkeys/options", {}, token)).json()) as { challenge: string };
  const r = await b.post("/api/passkeys/verify", { name, response: key.register(opts.challenge) }, token);
  return { key, status: r.status };
}

async function signIn(b: B, key: Authenticator) {
  const opts = (await (await b.post("/auth/options", {}, null)).json()) as { challenge: string };
  const response = key.login(opts.challenge);
  const r = await b.post("/auth/verify", { response }, null);
  return { response, status: r.status, token: r.status === 200 ? ((await r.json()) as { token: string }).token : undefined };
}

test("a passkey can be added with the admin token, then signs in and gets a working session", async () => {
  const b = await boot();
  assert.deepEqual(await (await b.get("/auth/status", null)).json(), { passkeys: 0 });
  assert.equal((await b.post("/auth/options", {}, null)).status, 409, "nothing to sign in with yet");

  assert.equal((await registerKey(b, new Authenticator(), "wrong-token-wrong-token")).status, 401);
  const { key, status } = await registerKey(b);
  assert.equal(status, 201);
  assert.deepEqual(await (await b.get("/auth/status", null)).json(), { passkeys: 1 });
  assert.equal(((await (await b.get("/api/passkeys")).json()) as any[])[0].name, "Laptop");

  const s = await signIn(b, key);
  assert.equal(s.status, 200);
  assert.equal((await b.get("/api/offices", s.token)).status, 200, "the session works like the admin token");
  assert.equal(b.hub.store.passkey(key.id)?.counter, 1, "the counter is kept");
});

test("a sign-in answer cannot be replayed, and a stranger's key gets nothing", async () => {
  const b = await boot();
  const { key } = await registerKey(b);
  const first = await signIn(b, key);
  assert.equal(first.status, 200);
  assert.equal((await b.post("/auth/verify", { response: first.response }, null)).status, 401, "the challenge was used up");

  const stranger = new Authenticator();
  assert.equal((await signIn(b, stranger)).status, 401);
  assert.equal((await b.post("/auth/verify", { response: { id: "x" } }, null)).status, 401);
  assert.equal((await b.post("/auth/verify", {}, null)).status, 401);
});

test("a key that answers for a different site is refused", async () => {
  const b = await boot();
  await registerKey(b);
  const evil = new Authenticator("https://evil.example", "evil.example");
  assert.equal((await signIn(b, evil)).status, 401);
  // also a genuine registered key answering with the wrong origin
  const { key } = await registerKey(b);
  (key as any).origin = "https://evil.example";
  assert.equal((await signIn(b, key)).status, 401);
});

test("too many wrong answers lock sign-in for a while, even for the right key", async () => {
  const b = await boot();
  const { key } = await registerKey(b);
  for (let i = 0; i < 10; i++) await b.post("/auth/verify", { response: { id: "nope" } }, null);
  assert.equal((await signIn(b, key)).status, 429);
});

test("with requirePasskey, the admin token stops working once a passkey exists", async () => {
  const b = await boot({ requirePasskey: true });
  assert.equal((await b.get("/api/offices")).status, 200, "still the way in before the first passkey");
  const { key } = await registerKey(b);
  assert.equal((await b.get("/api/offices")).status, 401);
  const s = await signIn(b, key);
  assert.equal((await b.get("/api/offices", s.token)).status, 200);
});

test("a session works for the live connection, and logging out ends it", async () => {
  const b = await boot();
  const { key } = await registerKey(b);
  const { token } = await signIn(b, key);

  const hello = async (t: string) => new Promise<string>((resolve) => {
    const ws = new WebSocket(`${b.ws}/client`);
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token: t })));
    ws.on("message", (d) => { resolve(JSON.parse(d.toString()).type); ws.close(); });
    ws.on("close", () => resolve("closed"));
  });
  assert.equal(await hello(token!), "hello");
  assert.equal((await b.post("/api/logout", {}, token)).status, 200);
  assert.equal((await b.get("/api/offices", token)).status, 401);
  assert.equal(await hello(token!), "error");
});

test("removing a passkey signs everyone out", async () => {
  const b = await boot();
  const { key } = await registerKey(b);
  const { token } = await signIn(b, key);
  const del = await fetch(`http://127.0.0.1:${b.hub.port}/api/passkeys/${key.id}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  assert.equal(del.status, 200);
  assert.equal((await b.get("/api/offices", token)).status, 401);
  assert.equal((await b.get("/api/offices")).status, 200, "the admin token still recovers the hub");
});

test("sessions expire", async () => {
  const b = await boot();
  const token = b.hub.store.createSession(1000, 5000);
  assert.equal(b.hub.store.sessionValid(token, 5500), true);
  assert.equal(b.hub.store.sessionValid(token, 6001), false);
});

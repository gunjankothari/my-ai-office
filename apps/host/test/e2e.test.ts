import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import {
  generateKeyPair, signerFromExported, signCommand, pairingProof, verifyPairingProof, verifyObject,
  type CommandReplyBody, type Signer,
} from "@agent-office/shared";
import { startHub, type RunningHub } from "@agent-office/hub";
import { Office } from "../src/office";
import { HostLink } from "../src/link";
import { fakeServer, SECRET, tmp } from "./helpers";

const ADMIN = "e2e-admin-token-0123456789";
const cleanup: (() => Promise<void> | void)[] = [];
after(async () => { for (const c of cleanup.reverse()) await c(); });

/** A phone or browser: its own key, a socket to the hub, and request/response over the relay. */
async function device(hubPort: number, officeId: string, name: string) {
  const kp = await generateKeyPair();
  const signer: Signer = await signerFromExported(kp);
  const deviceId = "dev_" + name;
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/client`);
  const inbox: any[] = [];
  const waiting: ((m: any) => boolean)[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    const i = waiting.findIndex((w) => w(m));
    if (i >= 0) waiting.splice(i, 1); else inbox.push(m);
  });
  await new Promise<void>((r) => ws.once("open", () => r()));
  cleanup.push(() => ws.terminate());
  const next = (pred: (m: any) => boolean): Promise<any> =>
    new Promise((resolve, reject) => {
      const i = inbox.findIndex(pred);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      const t = setTimeout(() => reject(new Error("timeout")), 4000);
      waiting.push((m) => (pred(m) ? (clearTimeout(t), resolve(m), true) : false));
    });
  ws.send(JSON.stringify({ type: "auth", token: ADMIN }));
  await next((m) => m.type === "hello");
  ws.send(JSON.stringify({ type: "subscribe", officeId }));
  const relay = async (payload: unknown) => {
    ws.send(JSON.stringify({ type: "relay", officeId, payload }));
    return (await next((m) => m.type === "reply")).payload;
  };
  const command = async (type: string, payload: Record<string, unknown> = {}) => relay(await signCommand(signer, deviceId, officeId, { type, payload }));
  return { kp, signer, deviceId, name, relay, command, next, ws };
}

async function world() {
  const hub = await startHub({ port: 0, adminToken: ADMIN, dbPath: join(tmp(), "hub.db") });
  cleanup.push(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  const created = await (await fetch(base + "/api/offices", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Home lab" }) })).json() as { id: string; enrollToken: string };

  const home = tmp();
  const office = await Office.open({ home, name: "Home lab", masterKey: randomBytes(32) });
  const link = new HostLink({ url: `ws://127.0.0.1:${hub.port}`, office, stateFile: join(home, "hub.json"), enrollToken: created.enrollToken });
  link.start();
  cleanup.push(() => link.stop());
  await link.whenReady();

  // what a UI would read from the hub before pairing (untrusted until the host proves itself)
  const listed = await (await fetch(base + "/api/offices", { headers: { authorization: `Bearer ${ADMIN}` } })).json() as any[];
  return { hub, office, link, officeId: created.id, hostKeyFromHub: listed[0].hostPublicKey as string, base };
}

async function pair(w: Awaited<ReturnType<typeof world>>, name: string) {
  const d = await device(w.hub.port, w.officeId, name);
  const { code } = w.office.pairing.start();
  const proof = await pairingProof(code, "device", d.kp.publicKey, w.hostKeyFromHub);
  const res = await d.relay({ type: "pair.request", deviceId: d.deviceId, deviceName: name, devicePublicKey: d.kp.publicKey, hostPublicKey: w.hostKeyFromHub, proof });
  assert.equal(res.type, "pair.accepted");
  // the device only trusts the host if the host proves it knew the code
  assert.equal(await verifyPairingProof(code, "host", d.kp.publicKey, res.hostPublicKey, res.proof), true);
  return d;
}

const open = async (w: Awaited<ReturnType<typeof world>>, d: Awaited<ReturnType<typeof device>>, type: string, payload: Record<string, unknown> = {}) => {
  const env = await d.command(type, payload);
  assert.equal(await verifyObject(w.hostKeyFromHub, env), true, "reply is signed by the host");
  return env.body as CommandReplyBody;
};

test("the host enrolls, shows up online, and publishes only a status snapshot", async () => {
  const w = await world();
  assert.equal(w.office.officeId, w.officeId);
  const list = await (await fetch(w.base + "/api/offices", { headers: { authorization: `Bearer ${ADMIN}` } })).json() as any[];
  assert.equal(list[0].online, true);
  assert.equal(list[0].hostPublicKey, w.office.publicKey);
  w.office.addProject("p", "Project");
  w.link.pushStatus();
  await new Promise((r) => setTimeout(r, 100));
  const seen = w.hub.store.office(w.officeId)?.status;
  assert.equal(seen?.projects[0]?.name, "Project");
  assert.ok(!JSON.stringify(seen).includes("secret"));
});

test("pairing without the hub's help, then signed commands work and replies are host-signed", async () => {
  const w = await world();
  const phone = await pair(w, "phone");
  assert.ok(w.office.trust.get(phone.deviceId));
  const r = await open(w, phone, "ping");
  assert.equal(r.ok, true);
  assert.equal((r.result as any).officeName, "Home lab");
});

test("replayed commands are rejected", async () => {
  const w = await world();
  const phone = await pair(w, "phone");
  const cmd = await signCommand(phone.signer, phone.deviceId, w.officeId, { type: "ping" });
  assert.equal(((await phone.relay(cmd)).body as CommandReplyBody).ok, true);
  const again = (await phone.relay(cmd)).body as CommandReplyBody;
  assert.deepEqual([again.ok, again.error], [false, "replay"]);
});

test("an unpaired device cannot command the host, even with a valid signature of its own", async () => {
  const w = await world();
  const stranger = await device(w.hub.port, w.officeId, "stranger");
  const r = (await stranger.command("approval.resolve", { approvalId: "x", approve: true })).body as CommandReplyBody;
  assert.deepEqual([r.ok, r.error], [false, "unknown_device"]);
});

test("a hostile hub cannot pair its own device: wrong code, wrong host key, and the code is burned after 3 tries", async () => {
  const w = await world();
  const evil = await device(w.hub.port, w.officeId, "evil");
  const { code } = w.office.pairing.start();
  const req = async (c: string, hostKey: string) =>
    evil.relay({ type: "pair.request", deviceId: evil.deviceId, deviceName: "evil", devicePublicKey: evil.kp.publicKey, hostPublicKey: hostKey, proof: await pairingProof(c, "device", evil.kp.publicKey, hostKey) });

  assert.equal((await req("AAAA-BBBB-CCCC", w.hostKeyFromHub)).reason, "bad_proof");
  const attackerKey = (await generateKeyPair()).publicKey;
  assert.equal((await req(code, attackerKey)).reason, "wrong_host", "a swapped host key is refused even with the right code");
  assert.equal((await req("DDDD-EEEE-FFFF", w.hostKeyFromHub)).reason, "bad_proof");
  assert.equal((await req(code, w.hostKeyFromHub)).reason, "no_active_pairing", "burned after 3 failures, even the right code no longer works");
  assert.equal(w.office.trust.get(evil.deviceId), undefined);
});

test("pairing codes are single use", async () => {
  const w = await world();
  const a = await pair(w, "a");
  const b = await device(w.hub.port, w.officeId, "b");
  const proof = await pairingProof("ZZZZ-ZZZZ-ZZZZ", "device", b.kp.publicKey, w.hostKeyFromHub);
  const r = await b.relay({ type: "pair.request", deviceId: b.deviceId, deviceName: "b", devicePublicKey: b.kp.publicKey, hostPublicKey: w.hostKeyFromHub, proof });
  assert.equal(r.reason, "no_active_pairing");
  assert.ok(a);
});

test("approving a risky action from a paired device runs it once; the credential never leaves the host", async () => {
  const w = await world();
  const phone = await pair(w, "phone");
  const server = fakeServer();
  w.office.addProject("demo", "Demo");
  w.office.addAgent({ id: "ada", name: "Ada", role: "Developer", projectId: "demo", mode: "risky", model: "mid" });
  w.office.vault.put("demo", "github", SECRET);
  w.office.gateway.addConnection({ id: "gh", projectId: "demo", service: "GitHub", label: "x", credentialHandle: "github", server });
  w.office.addGrant({ id: "g1", projectId: "demo", agentId: "ada", connectionId: "gh", tools: ["delete_branch"], resources: [] });

  const call = await w.office.gateway.call("ada", "gh", "delete_branch", { repo: "demo-app" });
  assert.equal(call.status, "needs_approval");

  const list = await open(w, phone, "approvals.list");
  const items = list.result as { id: string; agent: string; summary: string }[];
  assert.equal(items.length, 1);
  assert.equal(items[0]!.agent, "Ada");

  const res = await open(w, phone, "approval.resolve", { approvalId: items[0]!.id, approve: true });
  assert.equal((res.result as any).status, "ok");
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0]!.secret, SECRET);
  const everythingThePhoneSaw = JSON.stringify([list, res]);
  assert.ok(!everythingThePhoneSaw.includes(SECRET));

  const again = await open(w, phone, "approval.resolve", { approvalId: items[0]!.id, approve: true });
  assert.equal((again.result as any).status, "denied");
  assert.equal(server.calls.length, 1, "no second execution");
});

test("a revoked device is cut off immediately", async () => {
  const w = await world();
  const phone = await pair(w, "phone");
  const laptop = await pair(w, "laptop");
  assert.equal((await open(w, laptop, "devices.revoke", { deviceId: phone.deviceId })).ok, true);
  const r = (await phone.command("ping")).body as CommandReplyBody;
  assert.deepEqual([r.ok, r.error], [false, "revoked"]);
  assert.equal((await open(w, laptop, "ping")).ok, true, "other devices keep working");
});

test("the host survives a restart and reconnects with its saved identity (no new enroll token)", async () => {
  const w = await world();
  const home = w.office.opts.home;
  const key = w.office.opts.masterKey;
  await w.link.stop();
  const office2 = await Office.open({ home, name: "Home lab", masterKey: key });
  assert.equal(office2.publicKey, w.office.publicKey, "same host identity after restart");
  const link2 = new HostLink({ url: `ws://127.0.0.1:${w.hub.port}`, office: office2, stateFile: join(home, "hub.json") });
  link2.start();
  cleanup.push(() => link2.stop());
  await link2.whenReady();
  assert.equal(office2.officeId, w.officeId);
});

test("the vault file holds no plaintext and the host private key is not stored in the clear", async () => {
  const w = await world();
  w.office.vault.put("demo", "github", SECRET);
  const { readFileSync } = await import("node:fs");
  const home = w.office.opts.home;
  const all = ["vault.json", "host-identity.json", "state.json", "trusted-devices.json"].map((f) => { try { return readFileSync(join(home, f), "utf8"); } catch { return ""; } }).join("\n");
  assert.ok(!all.includes(SECRET));
  const identity = JSON.parse(readFileSync(join(home, "host-identity.json"), "utf8"));
  assert.deepEqual(Object.keys(identity), ["publicKey"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPair, signerFromExported, signCommand, verifyCommand, NonceCache, type TrustedDevice,
  newPairingCode, pairingProof, verifyPairingProof, signObject, verifyObject, fingerprint,
} from "./index";

async function setup() {
  const dev = await generateKeyPair();
  const signer = await signerFromExported(dev);
  const device: TrustedDevice = { deviceId: "dev1", name: "Phone", publicKey: dev.publicKey, addedAt: 0 };
  const ctx = (now: number, d: TrustedDevice | null = device, nonces = new NonceCache()) => ({
    officeId: "off1", device: (id: string) => (id === "dev1" && d ? d : undefined), nonces, now,
  });
  return { signer, device, ctx };
}

test("a valid signed command verifies", async () => {
  const { signer, ctx } = await setup();
  const now = 1_000_000;
  const cmd = await signCommand(signer, "dev1", "off1", { type: "ping" }, { now });
  const r = await verifyCommand(cmd, ctx(now));
  assert.equal(r.ok, true);
});

test("replaying the same command is rejected", async () => {
  const { signer, device, ctx } = await setup();
  const now = 1_000_000;
  const nonces = new NonceCache();
  const cmd = await signCommand(signer, "dev1", "off1", { type: "ping" }, { now });
  assert.equal((await verifyCommand(cmd, ctx(now, device, nonces))).ok, true);
  const again = await verifyCommand(cmd, ctx(now + 1, device, nonces));
  assert.deepEqual(again, { ok: false, reason: "replay" });
});

test("expired, future, long-lived and tampered commands are rejected", async () => {
  const { signer, ctx } = await setup();
  const now = 5_000_000;
  const old = await signCommand(signer, "dev1", "off1", { type: "ping" }, { now: now - 120_000, ttlMs: 60_000 });
  assert.deepEqual(await verifyCommand(old, ctx(now)), { ok: false, reason: "expired" });

  const future = await signCommand(signer, "dev1", "off1", { type: "ping" }, { now: now + 120_000 });
  assert.deepEqual(await verifyCommand(future, ctx(now)), { ok: false, reason: "not_yet_valid" });

  const long = await signCommand(signer, "dev1", "off1", { type: "ping" }, { now, ttlMs: 3_600_000 });
  assert.deepEqual(await verifyCommand(long, ctx(now)), { ok: false, reason: "ttl_too_long" });

  const good = await signCommand(signer, "dev1", "off1", { type: "ping", payload: { a: 1 } }, { now });
  const tampered = { ...good, command: { ...good.command, payload: { a: 2 } } };
  assert.deepEqual(await verifyCommand(tampered, ctx(now)), { ok: false, reason: "bad_signature" });
});

test("commands issued before the host started are rejected, so a restart cannot reopen a replay window", async () => {
  const { signer, ctx } = await setup();
  const hostStart = 2_000_000;
  const before = await signCommand(signer, "dev1", "off1", { type: "ping" }, { now: hostStart - 10_000 });
  const after = await signCommand(signer, "dev1", "off1", { type: "ping" }, { now: hostStart + 1_000 });
  const withStart = (now: number) => ({ ...ctx(now), notBefore: hostStart });
  assert.deepEqual(await verifyCommand(before, withStart(hostStart + 2_000)), { ok: false, reason: "stale" });
  assert.equal((await verifyCommand(after, withStart(hostStart + 2_000))).ok, true);
});

test("unknown device, revoked device and wrong office are rejected", async () => {
  const { signer, device, ctx } = await setup();
  const now = 1_000_000;
  const cmd = await signCommand(signer, "dev1", "off1", { type: "ping" }, { now });
  assert.deepEqual(await verifyCommand(cmd, ctx(now, null)), { ok: false, reason: "unknown_device" });
  assert.deepEqual(await verifyCommand(cmd, ctx(now, { ...device, revoked: true })), { ok: false, reason: "revoked" });
  const other = await signCommand(signer, "dev1", "other-office", { type: "ping" }, { now });
  assert.deepEqual(await verifyCommand(other, ctx(now)), { ok: false, reason: "wrong_office" });
});

test("a command signed by a different key is rejected even with a trusted device id", async () => {
  const { ctx } = await setup();
  const rogue = await signerFromExported(await generateKeyPair());
  const now = 1_000_000;
  const cmd = await signCommand(rogue, "dev1", "off1", { type: "ping" }, { now });
  assert.deepEqual(await verifyCommand(cmd, ctx(now)), { ok: false, reason: "bad_signature" });
});

test("pairing proofs bind the code and both keys", async () => {
  const code = newPairingCode();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const proof = await pairingProof(code, "device", "devKey", "hostKey");
  assert.equal(await verifyPairingProof(code, "device", "devKey", "hostKey", proof), true);
  assert.equal(await verifyPairingProof(code.toLowerCase().replace(/-/g, " "), "device", "devKey", "hostKey", proof), true, "code is normalized");
  assert.equal(await verifyPairingProof("AAAA-BBBB-CCCC", "device", "devKey", "hostKey", proof), false, "wrong code");
  assert.equal(await verifyPairingProof(code, "device", "otherKey", "hostKey", proof), false, "swapped device key");
  assert.equal(await verifyPairingProof(code, "device", "devKey", "otherHost", proof), false, "swapped host key");
  assert.equal(await verifyPairingProof(code, "host", "devKey", "hostKey", proof), false, "role is bound");
});

test("signed objects detect edits", async () => {
  const kp = await generateKeyPair();
  const signer = await signerFromExported(kp);
  const env = await signObject(signer, { ok: true, n: 1 });
  assert.equal(await verifyObject(kp.publicKey, env), true);
  assert.equal(await verifyObject(kp.publicKey, { ...env, body: { ok: true, n: 2 } }), false);
  assert.match(await fingerprint(kp.publicKey), /^([0-9a-f]{4} ){3}[0-9a-f]{4}$/);
});

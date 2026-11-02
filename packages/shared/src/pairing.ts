import { z } from "zod";
import { b64u, utf8 } from "./b64";

/*
 * Pairing a device with an Office Host without trusting the hub.
 *
 * The host prints a one-time code. You type it into the new device. The hub
 * never sees the code. Both sides prove they know it with an HMAC that also
 * binds both public keys, so the hub cannot insert its own keys:
 *   - the host only trusts a device whose proof verifies,
 *   - the device only pins a host key whose proof verifies.
 * The code is stretched with PBKDF2 so a hub that records the proofs cannot
 * cheaply guess it offline. The host also burns the code after 3 bad tries.
 */

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
export const PAIRING_TTL_MS = 10 * 60_000;
export const PAIRING_MAX_ATTEMPTS = 3;

export function newPairingCode(): string {
  const out: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < 12) {
    const b = new Uint8Array(1);
    globalThis.crypto.getRandomValues(b);
    if (b[0]! < limit) out.push(ALPHABET[b[0]! % ALPHABET.length]!);
  }
  const s = out.join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

export const normalizeCode = (c: string): string => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

const bs = (b: Uint8Array): BufferSource => b as unknown as BufferSource;

async function hmacKey(code: string): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey("raw", bs(utf8.enc(normalizeCode(code))), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt: bs(utf8.enc("agent-office-pairing-v1")), iterations: 100_000, hash: "SHA-256" },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export type ProofRole = "device" | "host";
const message = (role: ProofRole, devicePublicKey: string, hostPublicKey: string) =>
  utf8.enc(`agent-office-pair|${role}|${devicePublicKey}|${hostPublicKey}`);

export async function pairingProof(code: string, role: ProofRole, devicePublicKey: string, hostPublicKey: string): Promise<string> {
  const key = await hmacKey(code);
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, bs(message(role, devicePublicKey, hostPublicKey))));
  return b64u.enc(mac);
}

export async function verifyPairingProof(
  code: string,
  role: ProofRole,
  devicePublicKey: string,
  hostPublicKey: string,
  proof: string,
): Promise<boolean> {
  try {
    const key = await hmacKey(code);
    return await globalThis.crypto.subtle.verify("HMAC", key, bs(b64u.dec(proof)), bs(message(role, devicePublicKey, hostPublicKey)));
  } catch {
    return false;
  }
}

export const PairRequest = z
  .object({
    type: z.literal("pair.request"),
    deviceId: z.string().min(1).max(100),
    deviceName: z.string().min(1).max(100),
    devicePublicKey: z.string().min(40).max(60),
    hostPublicKey: z.string().min(40).max(60),
    proof: z.string().min(1).max(100),
  })
  .strict();
export type PairRequest = z.infer<typeof PairRequest>;

export const PairAccepted = z
  .object({
    type: z.literal("pair.accepted"),
    deviceId: z.string(),
    hostPublicKey: z.string(),
    proof: z.string(),
  })
  .strict();
export type PairAccepted = z.infer<typeof PairAccepted>;

export const PairRejected = z.object({ type: z.literal("pair.rejected"), reason: z.string() }).strict();
export type PairRejected = z.infer<typeof PairRejected>;

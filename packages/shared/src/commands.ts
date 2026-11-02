import { z } from "zod";
import { canonicalJson, verifySignature, type Signer } from "./crypto";
import { randomId } from "./b64";

/*
 * Signed commands. The cloud hub only relays these. The Office Host runs a
 * command only if it is signed by a device the user paired directly with the
 * host. A hacked or malicious hub cannot make an agent act.
 */

export const MAX_COMMAND_TTL_MS = 5 * 60_000;
export const CLOCK_SKEW_MS = 30_000;

export const CommandBody = z
  .object({
    type: z.string().min(1).max(64),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type CommandBody = z.infer<typeof CommandBody>;

export const SignedCommand = z
  .object({
    v: z.literal(1),
    officeId: z.string().min(1).max(100),
    deviceId: z.string().min(1).max(100),
    nonce: z.string().min(16).max(64),
    issuedAt: z.number().int(),
    expiresAt: z.number().int(),
    command: CommandBody,
    sig: z.string().min(1).max(200),
  })
  .strict();
export type SignedCommand = z.infer<typeof SignedCommand>;

export interface TrustedDevice {
  deviceId: string;
  name: string;
  /** Raw Ed25519 public key, base64url. */
  publicKey: string;
  addedAt: number;
  revoked?: boolean;
}

export class NonceCache {
  private seen = new Map<string, number>();
  /** Returns false if the nonce was already used. */
  checkAndAdd(nonce: string, expiresAt: number, now: number): boolean {
    for (const [n, exp] of this.seen) if (exp < now) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, expiresAt);
    return true;
  }
}

const unsigned = (c: Omit<SignedCommand, "sig">) => canonicalJson(c);

export async function signCommand(
  signer: Signer,
  deviceId: string,
  officeId: string,
  command: { type: string; payload?: Record<string, unknown> },
  opts: { ttlMs?: number; now?: number } = {},
): Promise<SignedCommand> {
  const now = opts.now ?? Date.now();
  const body: Omit<SignedCommand, "sig"> = {
    v: 1,
    officeId,
    deviceId,
    nonce: randomId("n_", 16),
    issuedAt: now,
    expiresAt: now + (opts.ttlMs ?? 60_000),
    command: { type: command.type, payload: command.payload ?? {} },
  };
  return { ...body, sig: await signer.sign(unsigned(body)) };
}

export type VerifyFailure =
  | "malformed"
  | "wrong_office"
  | "unknown_device"
  | "revoked"
  | "not_yet_valid"
  | "expired"
  | "ttl_too_long"
  | "stale"
  | "bad_signature"
  | "replay";

export type VerifyResult =
  | { ok: true; deviceId: string; command: CommandBody; nonce: string }
  | { ok: false; reason: VerifyFailure };

export async function verifyCommand(
  raw: unknown,
  ctx: {
    officeId: string;
    device: (id: string) => TrustedDevice | undefined;
    nonces: NonceCache;
    now?: number;
    /**
     * Reject commands issued before this time. Hosts pass their start time, because the
     * nonce cache is in memory: without this, a command captured just before a restart
     * could be replayed inside its validity window.
     */
    notBefore?: number;
  },
): Promise<VerifyResult> {
  const parsed = SignedCommand.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const env = parsed.data;
  const now = ctx.now ?? Date.now();

  if (env.officeId !== ctx.officeId) return { ok: false, reason: "wrong_office" };
  const dev = ctx.device(env.deviceId);
  if (!dev) return { ok: false, reason: "unknown_device" };
  if (dev.revoked) return { ok: false, reason: "revoked" };
  if (env.issuedAt > now + CLOCK_SKEW_MS) return { ok: false, reason: "not_yet_valid" };
  if (env.expiresAt <= now) return { ok: false, reason: "expired" };
  if (env.expiresAt - env.issuedAt > MAX_COMMAND_TTL_MS) return { ok: false, reason: "ttl_too_long" };
  if (ctx.notBefore !== undefined && env.issuedAt < ctx.notBefore) return { ok: false, reason: "stale" };

  const { sig, ...rest } = env;
  if (!(await verifySignature(dev.publicKey, unsigned(rest), sig))) return { ok: false, reason: "bad_signature" };
  // Consume the nonce only after the signature is valid, so an attacker cannot burn nonces.
  if (!ctx.nonces.checkAndAdd(env.nonce, env.expiresAt, now)) return { ok: false, reason: "replay" };
  return { ok: true, deviceId: env.deviceId, command: env.command, nonce: env.nonce };
}

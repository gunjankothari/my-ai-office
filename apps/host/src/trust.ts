import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  PAIRING_MAX_ATTEMPTS, PAIRING_TTL_MS, PairRequest, newPairingCode, pairingProof, verifyPairingProof,
  type PairAccepted, type PairRejected, type TrustedDevice,
} from "@agent-office/shared";

/** Devices this host trusts to give it commands. Stored locally. The hub has no say in it. */
export class TrustStore {
  private devices = new Map<string, TrustedDevice>();

  constructor(private readonly file: string) {
    if (existsSync(file)) for (const d of JSON.parse(readFileSync(file, "utf8")) as TrustedDevice[]) this.devices.set(d.deviceId, d);
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify([...this.devices.values()], null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get = (id: string): TrustedDevice | undefined => this.devices.get(id);
  list = (): TrustedDevice[] => [...this.devices.values()];

  add(d: TrustedDevice): void {
    this.devices.set(d.deviceId, d);
    this.save();
  }

  revoke(id: string): boolean {
    const d = this.devices.get(id);
    if (!d) return false;
    d.revoked = true;
    this.save();
    return true;
  }
}

interface Session { code: string; expiresAt: number; attempts: number }

/**
 * One pairing code is live at a time. It expires after 10 minutes and is burned
 * after 3 wrong attempts, so a hostile relay gets at most 3 guesses at ~60 bits.
 */
export class PairingManager {
  private session: Session | undefined;

  constructor(
    private readonly trust: TrustStore,
    private readonly hostPublicKey: string,
    private readonly now: () => number = Date.now,
  ) {}

  start(): { code: string; expiresAt: number } {
    const s = { code: newPairingCode(), expiresAt: this.now() + PAIRING_TTL_MS, attempts: 0 };
    this.session = s;
    return { code: s.code, expiresAt: s.expiresAt };
  }

  get active(): boolean {
    return Boolean(this.session && this.now() < this.session.expiresAt);
  }

  private fail(reason: string): PairRejected {
    return { type: "pair.rejected", reason };
  }

  private strike(s: Session): void {
    if (++s.attempts >= PAIRING_MAX_ATTEMPTS) this.session = undefined;
  }

  async handle(raw: unknown): Promise<PairAccepted | PairRejected> {
    const req = PairRequest.safeParse(raw);
    if (!req.success) return this.fail("malformed");
    const s = this.session;
    if (!s || this.now() >= s.expiresAt) return this.fail("no_active_pairing");
    const r = req.data;

    // A device that was told a different host key is being steered by someone in the middle.
    if (r.hostPublicKey !== this.hostPublicKey) { this.strike(s); return this.fail("wrong_host"); }
    if (!(await verifyPairingProof(s.code, "device", r.devicePublicKey, this.hostPublicKey, r.proof))) {
      this.strike(s);
      return this.fail("bad_proof");
    }
    const existing = this.trust.get(r.deviceId);
    if (existing && existing.publicKey !== r.devicePublicKey) return this.fail("device_exists");

    this.session = undefined; // single use
    this.trust.add({ deviceId: r.deviceId, name: r.deviceName, publicKey: r.devicePublicKey, addedAt: this.now() });
    return {
      type: "pair.accepted",
      deviceId: r.deviceId,
      hostPublicKey: this.hostPublicKey,
      proof: await pairingProof(s.code, "host", r.devicePublicKey, this.hostPublicKey),
    };
  }
}

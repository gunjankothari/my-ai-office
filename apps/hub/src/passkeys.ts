import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { HubStore } from "./store";

/*
 * Passkey (WebAuthn) sign-in for the one person who owns this hub.
 * The hub stores each passkey's PUBLIC key and a counter. The private key never leaves the person's device.
 * A successful sign-in returns a random session token (only its hash is stored) that works like the admin token
 * for the API and the live connection, and expires.
 */

export const SESSION_TTL_MS = 12 * 3600_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_PENDING = 200;
const USER_ID = new TextEncoder().encode("agent-office-owner");

type Kind = "register" | "login";

export class Passkeys {
  private challenges = new Map<string, { kind: Kind; exp: number }>();
  private failures: number[] = [];

  constructor(
    private readonly store: HubStore,
    readonly origin: string,
    private readonly now: () => number = Date.now,
  ) {}

  get rpID(): string {
    return new URL(this.origin).hostname;
  }

  private remember(kind: Kind, challenge: string): void {
    const t = this.now();
    for (const [c, v] of this.challenges) if (v.exp <= t) this.challenges.delete(c);
    // Anyone may ask for login options. A cap stops that from growing memory without limit.
    if (this.challenges.size >= MAX_PENDING) this.challenges.delete(this.challenges.keys().next().value!);
    this.challenges.set(challenge, { kind, exp: t + CHALLENGE_TTL_MS });
  }

  /** A challenge can be answered once, only for the purpose it was made for. */
  private consume = (kind: Kind) => (challenge: string): boolean => {
    const c = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    return Boolean(c && c.kind === kind && c.exp > this.now());
  };

  /** Too many wrong answers in a minute: stop listening for a while. */
  private tooManyFailures(): boolean {
    const t = this.now();
    this.failures = this.failures.filter((f) => t - f < 60_000);
    return this.failures.length >= 10;
  }

  async registrationOptions() {
    const o = await generateRegistrationOptions({
      rpName: "Agent Office",
      rpID: this.rpID,
      userName: "owner",
      userID: USER_ID,
      excludeCredentials: this.store.passkeys().map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    this.remember("register", o.challenge);
    return o;
  }

  async register(response: RegistrationResponseJSON, name: string): Promise<{ ok: true; id: string } | { ok: false }> {
    try {
      const v = await verifyRegistrationResponse({
        response,
        expectedChallenge: this.consume("register"),
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
      });
      if (!v.verified) return { ok: false };
      const c = v.registrationInfo.credential;
      this.store.addPasskey({ id: c.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports ?? [], name: name.trim().slice(0, 60) || "Passkey" });
      return { ok: true, id: c.id };
    } catch {
      return { ok: false };
    }
  }

  async loginOptions() {
    const keys = this.store.passkeys();
    if (keys.length === 0) return undefined;
    const o = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: "required",
      allowCredentials: keys.map((p) => ({ id: p.id, transports: p.transports })),
    });
    this.remember("login", o.challenge);
    return o;
  }

  /** Returns a session token, "locked" when too many wrong answers came in, or undefined when the answer is wrong. */
  async login(response: AuthenticationResponseJSON): Promise<string | "locked" | undefined> {
    if (this.tooManyFailures()) return "locked";
    const fail = () => { this.failures.push(this.now()); return undefined; };
    const key = typeof response?.id === "string" ? this.store.passkey(response.id) : undefined;
    if (!key) return fail();
    try {
      const v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: this.consume("login"),
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
        credential: { id: key.id, publicKey: key.publicKey as Uint8Array<ArrayBuffer>, counter: key.counter, transports: key.transports },
      });
      if (!v.verified) return fail();
      this.store.setPasskeyCounter(key.id, v.authenticationInfo.newCounter);
      return this.store.createSession(SESSION_TTL_MS, this.now());
    } catch {
      return fail();
    }
  }
}

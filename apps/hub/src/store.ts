import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { randomId, StatusSnapshot } from "@agent-office/shared";

/*
 * What the cloud hub remembers: office names, each host's PUBLIC key, and the
 * last status snapshot (counts and names only). No secrets, no code, no task text.
 */

export interface OfficeRow {
  id: string;
  name: string;
  hostPublicKey: string | null;
  lastSeen: number | null;
  status: StatusSnapshot | null;
}

export interface PasskeyRow {
  /** Credential id, base64url. */
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  name: string;
  created: number;
}

const mapPasskey = (r: Record<string, unknown>): PasskeyRow => ({
  id: r.id as string,
  publicKey: new Uint8Array(r.public_key as Uint8Array),
  counter: Number(r.counter),
  transports: JSON.parse((r.transports as string | null) ?? "[]") as string[],
  name: r.name as string,
  created: Number(r.created),
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export class HubStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS offices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host_pub TEXT,
        enroll_hash TEXT,
        status TEXT,
        last_seen INTEGER,
        created INTEGER NOT NULL
      )`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS passkeys (
        id TEXT PRIMARY KEY,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT,
        name TEXT NOT NULL,
        created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY,
        expires INTEGER NOT NULL
      )`);
  }

  // ---------- passkeys and sessions ----------
  passkeyCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM passkeys").get() as { n: number }).n);
  }

  passkeys(): PasskeyRow[] {
    return (this.db.prepare("SELECT * FROM passkeys ORDER BY created").all() as Record<string, unknown>[]).map(mapPasskey);
  }

  passkey(id: string): PasskeyRow | undefined {
    const r = this.db.prepare("SELECT * FROM passkeys WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? mapPasskey(r) : undefined;
  }

  addPasskey(p: Omit<PasskeyRow, "created">, now = Date.now()): void {
    this.db.prepare("INSERT INTO passkeys (id, public_key, counter, transports, name, created) VALUES (?, ?, ?, ?, ?, ?)")
      .run(p.id, p.publicKey, p.counter, JSON.stringify(p.transports ?? []), p.name, now);
  }

  setPasskeyCounter(id: string, counter: number): void {
    this.db.prepare("UPDATE passkeys SET counter = ? WHERE id = ?").run(counter, id);
  }

  deletePasskey(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM passkeys WHERE id = ?").run(id).changes) > 0;
  }

  /** Only the hash of a session token is stored, like the enrollment token. */
  createSession(ttlMs: number, now = Date.now()): string {
    const token = randomId("ses_", 32);
    this.db.prepare("DELETE FROM sessions WHERE expires <= ?").run(now);
    this.db.prepare("INSERT INTO sessions (hash, expires) VALUES (?, ?)").run(sha(token), now + ttlMs);
    return token;
  }

  sessionValid(token: string, now = Date.now()): boolean {
    const r = this.db.prepare("SELECT expires FROM sessions WHERE hash = ?").get(sha(token)) as { expires: number } | undefined;
    return Boolean(r && r.expires > now);
  }

  revokeSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE hash = ?").run(sha(token));
  }

  /** Signing out everywhere, for example after a passkey is removed. */
  revokeAllSessions(): void {
    this.db.exec("DELETE FROM sessions");
  }

  close(): void {
    this.db.close();
  }

  /** The enrollment token is shown once. Only its hash is stored. */
  createOffice(name: string, now = Date.now()): { id: string; enrollToken: string } {
    const id = randomId("off_");
    const enrollToken = randomId("enr_", 24);
    this.db.prepare("INSERT INTO offices (id, name, enroll_hash, created) VALUES (?, ?, ?, ?)").run(id, name, sha(enrollToken), now);
    return { id, enrollToken };
  }

  /** Binds a host key to the office and burns the token. Returns the office id, or undefined if the token is wrong. */
  enroll(enrollToken: string, hostPublicKey: string): string | undefined {
    const row = this.db.prepare("SELECT id FROM offices WHERE enroll_hash = ?").get(sha(enrollToken)) as { id: string } | undefined;
    if (!row) return undefined;
    this.db.prepare("UPDATE offices SET host_pub = ?, enroll_hash = NULL WHERE id = ?").run(hostPublicKey, row.id);
    return row.id;
  }

  private map(r: Record<string, unknown>): OfficeRow {
    let status: StatusSnapshot | null = null;
    if (typeof r.status === "string") {
      const p = StatusSnapshot.safeParse(JSON.parse(r.status));
      status = p.success ? p.data : null;
    }
    return { id: r.id as string, name: r.name as string, hostPublicKey: (r.host_pub as string | null) ?? null, lastSeen: (r.last_seen as number | null) ?? null, status };
  }

  office(id: string): OfficeRow | undefined {
    const r = this.db.prepare("SELECT * FROM offices WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.map(r) : undefined;
  }

  offices(): OfficeRow[] {
    return (this.db.prepare("SELECT * FROM offices ORDER BY created").all() as Record<string, unknown>[]).map((r) => this.map(r));
  }

  /** Forgets an office: its name, host key and status. Returns false if there was none. */
  deleteOffice(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM offices WHERE id = ?").run(id).changes) > 0;
  }

  setStatus(id: string, status: StatusSnapshot, now = Date.now()): void {
    this.db.prepare("UPDATE offices SET status = ?, last_seen = ? WHERE id = ?").run(JSON.stringify(status), now, id);
  }

  touch(id: string, now = Date.now()): void {
    this.db.prepare("UPDATE offices SET last_seen = ? WHERE id = ?").run(now, id);
  }
}

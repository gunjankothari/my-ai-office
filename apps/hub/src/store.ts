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

  setStatus(id: string, status: StatusSnapshot, now = Date.now()): void {
    this.db.prepare("UPDATE offices SET status = ?, last_seen = ? WHERE id = ?").run(JSON.stringify(status), now, id);
  }

  touch(id: string, now = Date.now()): void {
    this.db.prepare("UPDATE offices SET last_seen = ? WHERE id = ?").run(now, id);
  }
}

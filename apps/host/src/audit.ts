import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "@agent-office/shared";

/*
 * Append-only audit log. Each line carries the hash of the previous line, so
 * editing or deleting a line in the middle breaks the chain and verify() says where.
 * (Someone who can rewrite the whole file can still rewrite the whole chain;
 * ship periodic anchors to the hub or to external storage to close that gap.)
 */

const ZERO = "0".repeat(64);

interface Line { seq: number; ts: number; prev: string; event: Record<string, unknown>; hash: string }

const hashOf = (l: Omit<Line, "hash">) =>
  createHash("sha256").update(l.prev + canonicalJson({ seq: l.seq, ts: l.ts, event: l.event })).digest("hex");

export class AuditLog {
  private seq = 0;
  private prev = ZERO;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      const lines = this.read();
      const last = lines[lines.length - 1];
      if (last) {
        this.seq = last.seq;
        this.prev = last.hash;
      }
    }
  }

  private read(): Line[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);
  }

  append(event: Record<string, unknown>): void {
    const base = { seq: this.seq + 1, ts: this.now(), prev: this.prev, event };
    const line: Line = { ...base, hash: hashOf(base) };
    appendFileSync(this.file, JSON.stringify(line) + "\n", { mode: 0o600 });
    this.seq = line.seq;
    this.prev = line.hash;
  }

  recent(limit = 50): Line[] {
    return this.read().slice(-limit);
  }

  verify(): { ok: true; count: number } | { ok: false; brokenAt: number } {
    let prev = ZERO;
    let expectSeq = 1;
    for (const l of this.read()) {
      const { hash, ...rest } = l;
      if (l.seq !== expectSeq || l.prev !== prev || hashOf(rest) !== hash) return { ok: false, brokenAt: l.seq };
      prev = hash;
      expectSeq++;
    }
    return { ok: true, count: expectSeq - 1 };
  }
}

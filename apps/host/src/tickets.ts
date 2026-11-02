import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Ticket, TicketEvent, TicketEventKind, TicketPriority, TicketStatus, TicketUsage } from "@agent-office/shared";

/*
 * Tickets live on the host, in one file, and nowhere else. The hub is only ever told how many there are.
 * Every change appends an event, so "who worked on it, when, and what it cost" can always be read back.
 */

const MAX_EVENTS = 300;
const MAX_TEXT = 2000;
const clip = (t: string | undefined, n = MAX_TEXT) => (t === undefined ? undefined : t.length > n ? t.slice(0, n) + "…" : t);

export const OPEN: TicketStatus[] = ["new", "planning", "assigned", "progress", "waiting_approval", "waiting_user"];
export const isOpen = (s: TicketStatus) => OPEN.includes(s);

interface Persisted { next: number; tickets: Ticket[] }

export class TicketStore {
  private tickets = new Map<string, Ticket>();
  private next = 1;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    if (existsSync(file)) {
      const s = JSON.parse(readFileSync(file, "utf8")) as Persisted;
      this.next = s.next;
      s.tickets.forEach((t) => this.tickets.set(t.id, t));
    }
  }

  private save(): void {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify({ next: this.next, tickets: [...this.tickets.values()] } satisfies Persisted), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  create(i: { projectId: string; title: string; description?: string; priority?: TicketPriority; createdBy: string; assigneeId?: string }): Ticket {
    const ts = this.now();
    const t: Ticket = {
      id: `T-${this.next++}`, projectId: i.projectId, title: clip(i.title.trim(), 200)!, description: clip(i.description?.trim() ?? "", 8000)!,
      status: i.assigneeId ? "assigned" : "new", priority: i.priority ?? "normal", assigneeId: i.assigneeId, createdBy: i.createdBy,
      createdAt: ts, updatedAt: ts, usage: { tokens: 0, costUsd: 0, runs: 0 }, workers: {}, events: [],
    };
    this.tickets.set(t.id, t);
    this.event(t, "created", i.createdBy, i.assigneeId ? `Assigned straight to ${i.assigneeId}` : undefined, false);
    if (i.assigneeId) this.event(t, "assigned", i.createdBy, undefined, false);
    this.save();
    return t;
  }

  get(id: string): Ticket | undefined { return this.tickets.get(id); }

  list(f: { projectId?: string; status?: TicketStatus; open?: boolean } = {}): Ticket[] {
    return [...this.tickets.values()]
      .filter((t) => (!f.projectId || t.projectId === f.projectId) && (!f.status || t.status === f.status) && (f.open === undefined || isOpen(t.status) === f.open))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Changes a ticket and records why. `patch` is applied first, then the event is appended. */
  update(id: string, patch: Partial<Pick<Ticket, "status" | "assigneeId" | "question" | "result" | "priority" | "triageBy">>, ev?: { kind: TicketEventKind; actor: string; text?: string; tokens?: number; costUsd?: number }): Ticket {
    const t = this.tickets.get(id);
    if (!t) throw new Error("unknown ticket");
    Object.assign(t, patch);
    if (patch.question === undefined && "question" in patch) delete t.question;
    if (ev) this.event(t, ev.kind, ev.actor, ev.text, false, ev.tokens, ev.costUsd);
    t.updatedAt = this.now();
    this.save();
    return t;
  }

  /** Adds one run's usage to the ticket and to whoever did it. */
  addUsage(id: string, agentId: string, u: { tokens?: number; costUsd?: number }): void {
    const t = this.tickets.get(id);
    if (!t) return;
    const bump = (x: TicketUsage) => { x.tokens += u.tokens ?? 0; x.costUsd = Math.round((x.costUsd + (u.costUsd ?? 0)) * 1e6) / 1e6; x.runs += 1; };
    bump(t.usage);
    bump((t.workers[agentId] ??= { tokens: 0, costUsd: 0, runs: 0 }));
    t.updatedAt = this.now();
    this.save();
  }

  note(id: string, kind: TicketEventKind, actor: string, text?: string): void {
    const t = this.tickets.get(id);
    if (!t) throw new Error("unknown ticket");
    this.event(t, kind, actor, text, true);
  }

  private event(t: Ticket, kind: TicketEventKind, actor: string, text?: string, persist = true, tokens?: number, costUsd?: number): void {
    const e: TicketEvent = { ts: this.now(), kind, actor, ...(text ? { text: clip(text) } : {}), ...(tokens ? { tokens } : {}), ...(costUsd ? { costUsd } : {}) };
    t.events.push(e);
    if (t.events.length > MAX_EVENTS) t.events.splice(1, t.events.length - MAX_EVENTS);
    t.updatedAt = e.ts;
    if (persist) this.save();
  }

  /** A restart ends every run in flight. Say so, and put each ticket somewhere safe. Never re-run work that may have had side effects. */
  recoverAfterRestart(): void {
    for (const t of this.tickets.values()) {
      if (t.status === "planning") { t.status = "new"; this.event(t, "interrupted", "office", "The office restarted during triage. Triage will run again.", false); }
      else if (t.status === "progress" || t.status === "waiting_approval") {
        t.status = "waiting_user";
        t.question = "The office restarted while this was running, so the work stopped part-way. Reply to run it again, or cancel it.";
        this.event(t, "interrupted", "office", t.question, false);
      }
    }
    this.save();
  }

  counts(): { open: number; working: number; waitingForYou: number } {
    const all = [...this.tickets.values()];
    return {
      open: all.filter((t) => isOpen(t.status)).length,
      working: all.filter((t) => t.status === "planning" || t.status === "progress").length,
      waitingForYou: all.filter((t) => t.status === "waiting_user" || t.status === "waiting_approval").length,
    };
  }
}

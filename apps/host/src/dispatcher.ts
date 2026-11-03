import type { Ticket } from "@agent-office/shared";
import type { Office, AgentRecord } from "./office";
import type { CallResult } from "./gateway";
import type { EngineOutcome, ResumeState } from "./engines/types";
import type { PendingApproval } from "./engines/gateway-mcp";
import { approvalFollowUp } from "./engines/followup";

/*
 * Moves tickets along. It does three things and nothing else:
 *   1. a new ticket goes to the project's Manager, who either assigns it or asks you a question,
 *   2. an assigned ticket goes to its agent as soon as that agent is free and not resting,
 *   3. a paused ticket continues once you have answered every approval it was waiting for.
 * One run per agent at a time, and a cap on how many agents run at once, because on a flat plan
 * every run draws on the same usage allowance.
 */

export interface DispatcherOptions {
  /** How many agents may work at the same moment. Default 2. */
  maxParallel?: number;
  now?: () => number;
}

interface Paused { state: ResumeState; approvals: PendingApproval[]; answered: Map<string, CallResult> }

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + "…" : t);

export class Dispatcher {
  private inflight = new Set<Promise<void>>();
  private busy = new Set<string>(); // ticket ids with a run in progress
  private aborts = new Map<string, AbortController>();
  private paused = new Map<string, Paused>();
  private timer: NodeJS.Timeout | undefined;
  private kicking = false;

  constructor(private readonly office: Office, private readonly o: DispatcherOptions = {}) {}

  private now = () => (this.o.now ?? this.office.opts.now ?? Date.now)();
  private max = () => this.o.maxParallel ?? 2;

  /** Check regularly, so a sleeping agent is woken when its time comes. */
  start(everyMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.kick(), everyMs);
    this.timer.unref();
    this.kick();
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; }

  /** Asks for a pass soon, without waiting for it. */
  kick(): void {
    if (!this.office.opts.autoDispatch || this.kicking) return;
    this.kicking = true;
    queueMicrotask(() => { this.kicking = false; this.tick(); });
  }

  private free(agent: AgentRecord | undefined): agent is AgentRecord {
    if (!agent || agent.status === "working") return false;
    if (agent.status === "asleep" && agent.sleepUntil && this.now() < agent.sleepUntil) return false;
    return true;
  }

  private agentBusy(agentId: string): boolean {
    return this.office.agents.get(agentId)?.status === "working";
  }

  /**
   * Whether a ticket may start another round. A ticket that waits for another is skipped until that one is done.
   * One that has reached its token budget or round limit stops and asks you, instead of spending more.
   */
  private ready(t: Ticket): boolean {
    const store = this.office.tickets;
    const before = store.blockedBy(t);
    if (before) {
      if (before.status === "failed" || before.status === "cancelled") {
        store.update(t.id, { status: "waiting_user", question: `${before.id} (${before.title}) ended as ${before.status}, and this ticket was waiting for it. Reply to go on without it, or cancel this ticket.` },
          { kind: "blocked", actor: "office", text: `${before.id} ${before.status}` });
      }
      return false;
    }
    const why = store.overLimit(t);
    if (why) {
      store.update(t.id, { status: "waiting_user", question: `${why} Reply to let it continue with more room, or cancel it.` }, { kind: "limit_reached", actor: "office", text: why });
      return false;
    }
    return true;
  }

  /** Starts whatever can start now. Returns without waiting for the runs. */
  tick(): void {
    const tickets = this.office.tickets;
    const slots = () => this.max() - this.busy.size;
    // Oldest first, high priority before the rest.
    const rank = { high: 0, normal: 1, low: 2 } as const;
    const order = (a: Ticket, b: Ticket) => rank[a.priority] - rank[b.priority] || a.createdAt - b.createdAt;

    for (const t of tickets.list({ status: "assigned" }).sort(order)) {
      if (slots() <= 0) return;
      const agent = t.assigneeId ? this.office.agents.get(t.assigneeId) : undefined;
      if (this.busy.has(t.id) || !this.free(agent) || this.agentBusy(agent.id) || !this.ready(t)) continue;
      this.launch(t.id, (sig) => this.work(t.id, agent, sig));
    }
    for (const t of tickets.list({ status: "new" }).sort(order)) {
      if (slots() <= 0) return;
      const manager = this.office.managerFor(t.projectId);
      if (this.busy.has(t.id) || !this.free(manager) || this.agentBusy(manager.id) || !this.ready(t)) continue;
      this.launch(t.id, (sig) => this.triage(t.id, manager, sig));
    }
  }

  private launch(ticketId: string, fn: (signal: AbortSignal) => Promise<void>): void {
    this.busy.add(ticketId);
    const ac = new AbortController();
    this.aborts.set(ticketId, ac);
    const p: Promise<void> = fn(ac.signal)
      .catch((e) => { this.office.tickets.update(ticketId, { status: "failed" }, { kind: "failed", actor: "office", text: e instanceof Error ? e.message : String(e) }); })
      .finally(() => { this.busy.delete(ticketId); this.aborts.delete(ticketId); this.inflight.delete(p); this.kick(); });
    this.inflight.add(p);
  }

  /** Waits until nothing is running and nothing more can start. For tests and for shutdown. */
  async drain(): Promise<void> {
    for (let pass = 0; pass < 500; pass++) {
      this.tick();
      if (this.inflight.size === 0) return;
      await Promise.race(this.inflight);
    }
  }

  // ---- 1. triage ----
  private roster(projectId: string, managerId: string): string {
    return [...this.office.agents.values()]
      .filter((a) => a.projectId === projectId && a.id !== managerId && a.kind !== "manager")
      .map((a) => `- ${a.id}: ${a.name}, ${a.role}${a.skills ? `, skills: ${a.skills}` : ""} (${a.status === "asleep" ? "resting" : a.status})`)
      .join("\n") || "(no one else is on the team yet)";
  }

  private async triage(ticketId: string, manager: AgentRecord, signal: AbortSignal): Promise<void> {
    const store = this.office.tickets;
    const t0 = store.get(ticketId)!;
    store.update(ticketId, { status: "planning", triageBy: manager.id, question: undefined }, { kind: "triage_started", actor: manager.id });
    const answer = this.lastUserReply(t0);
    const prompt =
      `You are triaging ticket ${t0.id}. Pick the ONE team member best suited, judging only by their role and skills, ` +
      `and call assign_ticket with ticketId "${t0.id}", their agentId and a one-sentence note. ` +
      `If nobody is suited or the ticket is unclear, call ask_user with one short question instead. Do not do the work yourself.\n\n` +
      `Ticket ${t0.id} (${t0.priority}): ${t0.title}\n${clip(t0.description, 3000)}\n` +
      (answer ? `\nThe user answered your earlier question: ${answer}\n` : "") +
      `\nTeam:\n${this.roster(t0.projectId, manager.id)}`;
    const out = await this.office.runTask(manager.id, prompt, { runId: `${ticketId}-triage-${this.now().toString(36)}`, signal });
    this.record(ticketId, manager.id, out);
    const after = store.get(ticketId)!;
    if (after.status === "cancelled") return;
    if (after.status === "planning") {
      // The Manager finished without assigning or asking. Never leave a ticket in limbo, and never guess for it.
      if (out.status === "rate_limited") store.update(ticketId, { status: "new" }, { kind: "rate_limited", actor: manager.id, text: out.message });
      else store.update(ticketId, { status: "waiting_user", question: "The Manager could not decide who should take this. Assign it to someone yourself, or add detail and reply." },
        { kind: "asked_user", actor: manager.id, text: out.status === "finished" ? clip(out.text, 300) : `Triage ended: ${out.status}` });
    }
  }

  private lastUserReply(t: Ticket): string | undefined {
    for (let i = t.events.length - 1; i >= 0; i--) if (t.events[i]!.kind === "user_replied") return t.events[i]!.text;
    return undefined;
  }

  // ---- 2. work ----
  private async work(ticketId: string, agent: AgentRecord, signal: AbortSignal): Promise<void> {
    const store = this.office.tickets;
    const t = store.get(ticketId)!;
    const note = [...t.events].reverse().find((e) => e.kind === "assigned" && e.text?.startsWith("To "))?.text;
    const answer = this.lastUserReply(t);
    const prompt =
      `Ticket ${t.id} (${t.priority}): ${t.title}\n${clip(t.description, 4000)}\n` +
      (note ? `\nManager's note: ${note}\n` : "") +
      (answer ? `\nThe user added: ${answer}\n` : "") +
      `\nDo this ticket with the tools you have. When you finish, reply with a short result: what you did or found.`;
    store.update(ticketId, { status: "progress" }, { kind: "started", actor: agent.id });
    const out = await this.office.runTask(agent.id, prompt, { runId: `${ticketId}-${this.now().toString(36)}`, signal });
    this.finish(ticketId, agent, out);
  }

  /** Adds the run's tokens and cost to the ticket, whoever ran it. */
  private record(ticketId: string, agentId: string, out: EngineOutcome): void {
    if (out.status === "finished" || out.status === "waiting_approval") this.office.tickets.addUsage(ticketId, agentId, { tokens: out.tokens, costUsd: out.equivalentCostUsd });
  }

  private finish(ticketId: string, agent: AgentRecord, out: EngineOutcome): void {
    const store = this.office.tickets;
    this.record(ticketId, agent.id, out);
    if (store.get(ticketId)?.status === "cancelled") return; // the user cancelled while it ran
    const usage = out.status === "finished" || out.status === "waiting_approval" ? { tokens: out.tokens, costUsd: out.equivalentCostUsd } : {};
    switch (out.status) {
      case "finished":
        store.update(ticketId, { status: "done", result: clip(out.text, 4000), question: undefined }, { kind: "finished", actor: agent.id, text: clip(out.text, 300), ...usage });
        break;
      case "waiting_approval":
        this.paused.set(ticketId, { state: out.resume, approvals: out.approvals, answered: new Map() });
        store.update(ticketId, { status: "waiting_approval" }, { kind: "approval_requested", actor: agent.id, text: out.approvals.map((a) => a.summary).join("; "), ...usage });
        break;
      case "rate_limited":
        store.update(ticketId, { status: "assigned" }, { kind: "rate_limited", actor: agent.id, text: "Usage limit reached. It will be tried again when the agent is rested." });
        break;
      case "cancelled":
        store.update(ticketId, { status: "cancelled" }, { kind: "cancelled", actor: agent.id });
        break;
      case "not_signed_in":
      case "network_problem":
        store.update(ticketId, { status: "failed" }, { kind: "failed", actor: agent.id, text: out.message });
        break;
      case "timeout":
        store.update(ticketId, { status: "failed" }, { kind: "failed", actor: agent.id, text: "It took too long and was stopped." });
        break;
      case "failed":
        store.update(ticketId, { status: "failed" }, { kind: "failed", actor: agent.id, text: clip(out.error, 500) });
        break;
    }
  }

  // ---- 3. approvals ----
  /** Called with every answer to an approval. Once a paused ticket has all of its answers, it continues. */
  approvalResolved(approvalId: string, result: CallResult): void {
    for (const [ticketId, p] of this.paused) {
      const a = p.approvals.find((x) => x.approvalId === approvalId);
      if (!a) continue;
      p.answered.set(approvalId, result);
      this.office.tickets.note(ticketId, "approval_resolved", "user", `${a.tool}: ${result.status === "denied" ? "not approved" : "approved"}`);
      if (p.answered.size < p.approvals.length) return;
      this.paused.delete(ticketId);
      const items = p.approvals.map((x) => ({ approval: x, result: p.answered.get(x.approvalId)! }));
      const agent = this.office.agents.get(p.state.agent.id);
      if (!agent) return;
      this.office.tickets.update(ticketId, { status: "progress" }, { kind: "started", actor: agent.id, text: "Continuing after your answer" });
      this.launch(ticketId, async (signal) => {
        const out = await this.office.continueRun(p.state, approvalFollowUp(items), { signal });
        this.finish(ticketId, agent, out);
      });
      return;
    }
  }

  /** Stops a ticket's run if there is one, and forgets any paused conversation. */
  cancel(ticketId: string): void { this.paused.delete(ticketId); this.aborts.get(ticketId)?.abort(); }

  /** Stops everything and waits for the runs to end. */
  async shutdown(): Promise<void> {
    this.stop();
    for (const ac of this.aborts.values()) ac.abort();
    await Promise.allSettled([...this.inflight]);
  }
  isRunning(ticketId: string): boolean { return this.busy.has(ticketId); }
}

import { z } from "zod";
import type { Ticket } from "@agent-office/shared";
import { ApprovalMode, TicketStatus } from "@agent-office/shared";
import type { Office } from "./office";
import { isOpen, type TicketStore } from "./tickets";
import { TEAM_CONNECTION } from "./team-tools";

/*
 * The commands a paired device may send about tickets and the team. They arrive through the usual
 * signed-command path, so only a device paired with this machine can reach them. Sizes are capped:
 * whatever is typed here is later shown to a model, and costs tokens.
 */

const Id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "use lowercase letters, digits, - and _");
const TicketId = z.string().regex(/^T-\d{1,9}$/);

const summary = (t: Ticket, store?: TicketStore) => ({
  id: t.id, projectId: t.projectId, title: t.title, status: t.status, priority: t.priority, assigneeId: t.assigneeId,
  question: t.question, usage: t.usage, createdAt: t.createdAt, updatedAt: t.updatedAt,
  parentId: t.parentId, afterId: t.afterId, budgetTokens: t.budgetTokens, maxRounds: t.maxRounds,
  ...(store ? { rolledUp: store.rolledUp(t.id), subtickets: store.children(t.id).length, blockedBy: store.blockedBy(t)?.id } : {}),
});

const RUNNING = new Set(["planning", "progress", "waiting_approval"]);

export async function handleTeamCommand(office: Office, type: string, payload: Record<string, unknown>, deviceId: string): Promise<{ handled: false } | { handled: true; result: unknown }> {
  const ok = (result: unknown) => { office.dispatcher.kick(); return { handled: true as const, result }; };
  const ticket = (id: string) => { const t = office.tickets.get(id); if (!t) throw new Error("unknown ticket"); return t; };
  const user = "user";

  switch (type) {
    case "tickets.list": {
      const a = z.object({ projectId: Id.optional(), status: TicketStatus.optional(), open: z.boolean().optional() }).parse(payload);
      return ok(office.tickets.list(a).slice(0, 200).map((t) => summary(t, office.tickets)));
    }
    case "tickets.get": {
      const a = z.object({ id: TicketId }).parse(payload);
      const t = ticket(a.id);
      return ok({ ...t, rolledUp: office.tickets.rolledUp(t.id), subtickets: office.tickets.children(t.id).map((c) => summary(c, office.tickets)), blockedBy: office.tickets.blockedBy(t)?.id });
    }
    case "tickets.create": {
      const a = z.object({
        projectId: Id, title: z.string().trim().min(1).max(200), description: z.string().max(8000).optional(),
        priority: z.enum(["low", "normal", "high"]).optional(), assigneeId: Id.optional(),
        parentId: TicketId.optional(), afterId: TicketId.optional(),
        budgetTokens: z.number().int().min(1000).max(100_000_000).optional(), maxRounds: z.number().int().min(1).max(50).optional(),
      }).parse(payload);
      if (!office.projects.has(a.projectId)) throw new Error("unknown project");
      if (a.assigneeId) {
        const w = office.agents.get(a.assigneeId);
        if (!w || w.projectId !== a.projectId) throw new Error("that agent is not in this project");
        if (!w.engine) throw new Error(`${w.name} has no engine yet`);
      }
      const t = office.tickets.create({ ...a, createdBy: user });
      office.audit.append({ kind: "ticket.created", projectId: t.projectId, ticketId: t.id, deviceId });
      return ok(summary(t, office.tickets));
    }
    case "tickets.reply": {
      const a = z.object({ id: TicketId, text: z.string().trim().min(1).max(4000) }).parse(payload);
      const t = ticket(a.id);
      if (t.status !== "waiting_user") {
        office.tickets.note(t.id, "comment", user, a.text);
        return ok(summary(t));
      }
      // A restart, a limit, a broken "after" link, or the assigned agent asking itself: that agent runs again.
      // A question from the Manager goes back to the Manager, who decides again with the answer.
      const lastAsk = [...t.events].reverse().find((e) => ["asked_user", "interrupted", "limit_reached", "blocked"].includes(e.kind));
      const workerAsked = lastAsk?.kind === "asked_user" && lastAsk.actor === t.assigneeId;
      const back = ((lastAsk && lastAsk.kind !== "asked_user") || workerAsked) && t.assigneeId ? "assigned" : "new";
      if (lastAsk?.kind === "limit_reached") office.tickets.raiseLimits(t.id);
      office.tickets.update(t.id, { status: back, question: undefined, ...(lastAsk?.kind === "blocked" ? { afterId: undefined } : {}), ...(back === "new" ? { assigneeId: undefined } : {}) }, { kind: "user_replied", actor: user, text: a.text });
      return ok(summary(office.tickets.get(t.id)!));
    }
    case "tickets.assign": {
      const a = z.object({ id: TicketId, agentId: Id }).parse(payload);
      const t = ticket(a.id);
      if (RUNNING.has(t.status)) throw new Error("it is being worked on right now. Cancel it first.");
      const w = office.agents.get(a.agentId);
      if (!w || w.projectId !== t.projectId) throw new Error("that agent is not in this project");
      if (w.kind === "manager") throw new Error("the Manager hands tickets out, it does not take them");
      if (!w.engine) throw new Error(`${w.name} has no engine yet`);
      office.tickets.update(t.id, { status: "assigned", assigneeId: w.id, question: undefined, result: undefined }, { kind: "assigned", actor: user, text: `To ${w.name}` });
      office.audit.append({ kind: "ticket.assigned", projectId: t.projectId, ticketId: t.id, agentId: w.id, deviceId });
      return ok(summary(office.tickets.get(t.id)!));
    }
    case "tickets.cancel": {
      const a = z.object({ id: TicketId }).parse(payload);
      const t = ticket(a.id);
      if (!isOpen(t.status)) throw new Error("it is already finished");
      office.dispatcher.cancel(t.id);
      office.tickets.update(t.id, { status: "cancelled", question: undefined }, { kind: "cancelled", actor: user });
      return ok(summary(office.tickets.get(t.id)!));
    }
    case "tickets.retry": {
      const a = z.object({ id: TicketId }).parse(payload);
      const t = ticket(a.id);
      if (t.status !== "failed" && t.status !== "cancelled") throw new Error("only a failed or cancelled ticket can be retried");
      office.tickets.update(t.id, { status: t.assigneeId ? "assigned" : "new" }, { kind: "assigned", actor: user, text: "Retry" });
      return ok(summary(office.tickets.get(t.id)!));
    }
    case "team.list": {
      const a = z.object({ projectId: Id.optional() }).parse(payload);
      const open = office.tickets.list({ open: true });
      return ok({
        projects: [...office.projects.values()].filter((p) => !a.projectId || p.id === a.projectId),
        agents: [...office.agents.values()].filter((g) => !a.projectId || g.projectId === a.projectId).map((g) => ({
          id: g.id, name: g.name, role: g.role, skills: g.skills, projectId: g.projectId, status: g.status, kind: g.kind,
          sleepUntil: g.sleepUntil, tokensToday: g.tokensToday, hasEngine: Boolean(g.engine),
          paused: Boolean(g.paused), mode: g.mode, engineModel: g.engineModel,
          openTickets: open.filter((t) => t.assigneeId === g.id).length,
        })),
      });
    }
    case "team.ensureManager": {
      const a = z.object({ projectId: Id }).parse(payload);
      const m = office.ensureManager(a.projectId);
      return ok({ id: m.id, name: m.name });
    }
    case "projects.add": {
      const a = z.object({ id: Id, name: z.string().trim().min(1).max(80) }).parse(payload);
      if (office.projects.has(a.id)) throw new Error("a project with that id already exists");
      office.addProject(a.id, a.name);
      return ok({ id: a.id });
    }
    case "agents.get": {
      const a = z.object({ id: Id }).parse(payload);
      const g = office.agents.get(a.id);
      if (!g) throw new Error("unknown agent");
      const now = office.opts.now?.() ?? Date.now();
      const mine = office.grants.filter((x) => x.agentId === g.id);
      const conns = office.listConnections(g.projectId);
      // Names only: the panel shows what this agent can and cannot do, never a credential.
      const access = mine.filter((x) => x.connectionId !== TEAM_CONNECTION).map((x) => {
        const c = conns.find((k) => k.id === x.connectionId);
        return { grantId: x.id, connectionId: x.connectionId, service: c?.service ?? x.connectionId, label: c?.label, tools: x.tools, resources: x.resources, expiresAt: x.expiresAt, expired: x.expiresAt !== undefined && now >= x.expiresAt };
      });
      const cannot = g.kind === "manager" ? [] : conns.map((c) => {
        const allowed = new Set(access.filter((x) => x.connectionId === c.id && !x.expired).flatMap((x) => x.tools));
        return { connectionId: c.id, service: c.service, label: c.label, tools: office.discoveredTools(c.projectId, c.id).map((t) => t.name).filter((n) => !allowed.has(n)) };
      }).filter((c) => c.tools.length > 0);
      const open = office.tickets.list({ open: true }).filter((t) => t.assigneeId === g.id).map((t) => summary(t));
      return ok({
        id: g.id, name: g.name, role: g.role, skills: g.skills, projectId: g.projectId, kind: g.kind, mode: g.mode, engineModel: g.engineModel,
        status: g.status, paused: Boolean(g.paused), sleepUntil: g.sleepUntil, tokensToday: g.tokensToday, tickets: open, access, cannot,
        managerTools: g.kind === "manager" ? mine.filter((x) => x.connectionId === TEAM_CONNECTION).flatMap((x) => x.tools) : undefined,
      });
    }
    case "agents.update": {
      const a = z.object({
        id: Id, name: z.string().trim().min(1).max(40).optional(), role: z.string().trim().min(1).max(60).optional(),
        skills: z.string().trim().max(300).optional(), mode: ApprovalMode.optional(), engineModel: z.string().regex(/^([a-z0-9.-]{1,40})?$/).optional(),
      }).parse(payload);
      const { id, ...patch } = a;
      const g = office.updateAgent(id, patch);
      return ok({ id: g.id });
    }
    case "agents.pause":
    case "agents.resume": {
      const a = z.object({ id: Id }).parse(payload);
      office.setPaused(a.id, type === "agents.pause");
      return ok({ id: a.id, paused: type === "agents.pause" });
    }
    case "agents.fire": {
      const a = z.object({ id: Id }).parse(payload);
      office.audit.append({ kind: "agent.fire_requested", agentId: a.id, deviceId });
      return ok(office.fireAgent(a.id));
    }
    case "agents.add": {
      const a = z.object({
        id: Id, name: z.string().trim().min(1).max(40), role: z.string().trim().min(1).max(60), projectId: Id,
        skills: z.string().trim().max(300).optional(), mode: ApprovalMode.optional(), engineModel: z.string().regex(/^[a-z0-9.-]{1,40}$/).optional(),
      }).parse(payload);
      if (office.agents.has(a.id)) throw new Error("an agent with that id already exists");
      // No tools are granted here. Granting is a separate, deliberate step.
      office.addAgent({ id: a.id, name: a.name, role: a.role, projectId: a.projectId, skills: a.skills, mode: a.mode ?? "risky", model: "mid", engine: "claude-code", engineModel: a.engineModel });
      office.audit.append({ kind: "agent.added", projectId: a.projectId, agentId: a.id, deviceId });
      return ok({ id: a.id });
    }
    default:
      return { handled: false };
  }
}

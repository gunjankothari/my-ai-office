import { z } from "zod";
import type { ToolDef } from "@agent-office/shared";
import type { ToolServer } from "./gateway";
import type { TicketStore } from "./tickets";
import type { AgentRecord } from "./office";

/*
 * The Manager's tools. They are an ordinary connection to the gateway, so the Manager needs a grant,
 * every call is audited, and they can only touch this project's tickets and agents. There are two on
 * purpose: each tool the model is shown costs tokens on every run.
 */

export const TEAM_CONNECTION = "team";
export const TEAM_TOOLS = ["assign_ticket", "ask_user"];

export interface TeamHost {
  tickets: TicketStore;
  agents: Map<string, AgentRecord>;
}

const Assign = z.object({ ticketId: z.string().max(20), agentId: z.string().max(40), note: z.string().max(500).optional() });
const Ask = z.object({ ticketId: z.string().max(20), question: z.string().min(1).max(500) });

const DEFS: ToolDef[] = [
  { name: "assign_ticket", description: "Give a ticket to the best-suited team member, with a one-sentence note.", risk: "write" },
  { name: "ask_user", description: "Ask the user one short question when no one is suited or the ticket is unclear.", risk: "write" },
];

const SCHEMAS: Record<string, unknown> = {
  assign_ticket: { type: "object", properties: { ticketId: { type: "string" }, agentId: { type: "string" }, note: { type: "string" } }, required: ["ticketId", "agentId"] },
  ask_user: { type: "object", properties: { ticketId: { type: "string" }, question: { type: "string" } }, required: ["ticketId", "question"] },
};

export class TeamServer implements ToolServer {
  constructor(private readonly projectId: string, private readonly host: TeamHost) {}

  tools(): ToolDef[] { return DEFS; }
  schema(tool: string): unknown { return SCHEMAS[tool]; }

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (tool === "assign_ticket") return this.assign(Assign.parse(args));
    if (tool === "ask_user") return this.ask(Ask.parse(args));
    throw new Error("unknown tool");
  }

  /** Only a ticket in this project that is currently being triaged can be moved by the Manager. */
  private triaging(ticketId: string) {
    const t = this.host.tickets.get(ticketId);
    if (!t || t.projectId !== this.projectId) throw new Error("no such ticket in this project");
    if (t.status !== "planning") throw new Error(`${t.id} is not waiting for triage (it is ${t.status})`);
    return t;
  }

  private assign(a: z.infer<typeof Assign>): string {
    const t = this.triaging(a.ticketId);
    const who = this.host.agents.get(a.agentId);
    if (!who || who.projectId !== this.projectId) throw new Error(`no team member "${a.agentId}" in this project`);
    if (who.kind === "manager") throw new Error("the Manager cannot assign a ticket to itself");
    if (!who.engine) throw new Error(`${who.name} cannot take tickets yet (no engine)`);
    this.host.tickets.update(t.id, { status: "assigned", assigneeId: who.id, question: undefined }, { kind: "assigned", actor: t.triageBy ?? "manager", text: a.note ? `To ${who.name}: ${a.note}` : `To ${who.name}` });
    return `Assigned ${t.id} to ${who.name}. Done: reply with one short line.`;
  }

  private ask(a: z.infer<typeof Ask>): string {
    const t = this.triaging(a.ticketId);
    this.host.tickets.update(t.id, { status: "waiting_user", question: a.question }, { kind: "asked_user", actor: t.triageBy ?? "manager", text: a.question });
    return `Asked the user about ${t.id}. Done: reply with one short line.`;
  }
}

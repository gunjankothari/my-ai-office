import { z } from "zod";

export const Risk = z.enum(["read", "write", "destructive"]);
export type Risk = z.infer<typeof Risk>;

/** How an agent behaves around risky actions. */
export const ApprovalMode = z.enum(["every", "risky", "dry"]);
export type ApprovalMode = z.infer<typeof ApprovalMode>;

export const ToolDef = z.object({
  name: z.string().min(1).max(100),
  /** One short line. This is what the model sees, so keep it cheap. */
  description: z.string().max(200),
  risk: Risk,
  /** Leaves the machine in a way a person would notice (sends a message, posts, emails). */
  outbound: z.boolean().optional(),
  /** Name of the argument that selects a resource (repo, channel, project). Used for grant limits. */
  resourceArg: z.string().optional(),
  /**
   * Several arguments that together name the resource, joined with "/" (GitHub: ["owner", "repo"]
   * gives "acme/app"). Takes the place of resourceArg.
   */
  resourceArgs: z.array(z.string().min(1)).min(1).max(4).optional(),
  /**
   * The user has not reviewed this tool's current definition (new, or changed since it was
   * reviewed). Such tools always ask for approval, whatever risk the server claims.
   */
  unreviewed: z.boolean().optional(),
});
export type ToolDef = z.infer<typeof ToolDef>;

/** What an agent may do with one connection. */
export const Grant = z.object({
  id: z.string(),
  projectId: z.string(),
  agentId: z.string(),
  connectionId: z.string(),
  tools: z.array(z.string()),
  /** Empty means any resource. Entries ending in * match by prefix. */
  resources: z.array(z.string()).default([]),
  expiresAt: z.number().int().optional(),
});
export type Grant = z.infer<typeof Grant>;

/**
 * Where a ticket is. "new" waits for the Manager, "planning" is the Manager deciding who takes it,
 * "assigned" is queued for a worker, "progress" is a worker on it. The two "waiting" states are the
 * only ones that need the user.
 */
export const TicketStatus = z.enum(["new", "planning", "assigned", "progress", "waiting_approval", "waiting_user", "done", "failed", "cancelled"]);
export type TicketStatus = z.infer<typeof TicketStatus>;

export type TicketPriority = "low" | "normal" | "high";
export type TicketEventKind =
  | "created" | "triage_started" | "assigned" | "started" | "approval_requested" | "approval_resolved"
  | "asked_user" | "user_replied" | "comment" | "finished" | "failed" | "cancelled" | "rate_limited" | "interrupted" | "limit_reached" | "blocked";

export interface TicketEvent {
  ts: number;
  kind: TicketEventKind;
  /** "user", or an agent id. */
  actor: string;
  text?: string;
  tokens?: number;
  /** What this run would have cost on the pay-per-use API. On a flat plan nothing extra is charged. */
  costUsd?: number;
}

export interface TicketUsage { tokens: number; costUsd: number; runs: number }

export interface Ticket {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  assigneeId?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** The Manager that is (or last was) deciding who takes this. */
  triageBy?: string;
  /** The question the user is being asked, while status is waiting_user. */
  question?: string;
  /** The agent's final answer when the ticket is done. */
  result?: string;
  /** The ticket this one is a part of. Set when created, never changed. */
  parentId?: string;
  /** This ticket starts only when that one is done. Set when created, never changed. */
  afterId?: string;
  /** Stop and ask you once the ticket (with its subtickets) has used this many tokens. */
  budgetTokens?: number;
  /** Stop and ask you after this many runs on the ticket, the Manager's triage included. */
  maxRounds: number;
  usage: TicketUsage;
  /** Who worked on it, and what each cost. The Manager's triage counts. */
  workers: Record<string, TicketUsage>;
  events: TicketEvent[];
}

/** What the cloud hub is allowed to store about an office: counts and names only. */
export const StatusSnapshot = z.object({
  officeName: z.string(),
  version: z.string(),
  agents: z.object({ total: z.number().int(), working: z.number().int(), waiting: z.number().int() }),
  pendingApprovals: z.number().int(),
  tokensToday: z.number().int(),
  projects: z.array(z.object({ id: z.string(), name: z.string(), agents: z.number().int() })),
  /** Counts only. Ticket titles and text never leave the machine. */
  tickets: z.object({ open: z.number().int(), working: z.number().int(), waitingForYou: z.number().int() }).optional(),
});
export type StatusSnapshot = z.infer<typeof StatusSnapshot>;

export const RunEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.started"), runId: z.string(), agentId: z.string(), ts: z.number(), task: z.string() }),
  z.object({ type: z.literal("step.started"), runId: z.string(), agentId: z.string(), ts: z.number(), step: z.number() }),
  z.object({ type: z.literal("tool.called"), runId: z.string(), agentId: z.string(), ts: z.number(), connectionId: z.string(), tool: z.string(), outcome: z.string() }),
  z.object({ type: z.literal("approval.requested"), runId: z.string(), agentId: z.string(), ts: z.number(), approvalId: z.string(), tool: z.string() }),
  z.object({ type: z.literal("run.finished"), runId: z.string(), agentId: z.string(), ts: z.number(), tokens: z.number() }),
  z.object({ type: z.literal("run.failed"), runId: z.string(), agentId: z.string(), ts: z.number(), reason: z.string() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;

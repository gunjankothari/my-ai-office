import { randomId, type Risk } from "@agent-office/shared";

export interface Approval {
  id: string;
  projectId: string;
  agentId: string;
  connectionId: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  risk: Risk;
  reason: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied" | "expired";
  resolvedBy?: string;
}

export type ResolveResult =
  | { ok: true; approval: Approval }
  | { ok: false; reason: "unknown" | "expired" | "already_resolved" };

/** Approvals expire instead of running late, for example after the phone was offline. */
export class ApprovalQueue {
  private items = new Map<string, Approval>();

  constructor(private readonly ttlMs = 10 * 60_000, private readonly now: () => number = Date.now) {}

  create(p: Omit<Approval, "id" | "createdAt" | "expiresAt" | "status">): Approval {
    const a: Approval = { ...p, id: randomId("ap_"), createdAt: this.now(), expiresAt: this.now() + this.ttlMs, status: "pending" };
    this.items.set(a.id, a);
    return a;
  }

  private refresh(a: Approval): Approval {
    if (a.status === "pending" && this.now() >= a.expiresAt) a.status = "expired";
    return a;
  }

  get(id: string): Approval | undefined {
    const a = this.items.get(id);
    return a ? this.refresh(a) : undefined;
  }

  pending(): Approval[] {
    return [...this.items.values()].map((a) => this.refresh(a)).filter((a) => a.status === "pending");
  }

  resolve(id: string, approve: boolean, by: string): ResolveResult {
    const a = this.get(id);
    if (!a) return { ok: false, reason: "unknown" };
    if (a.status === "expired") return { ok: false, reason: "expired" };
    if (a.status !== "pending") return { ok: false, reason: "already_resolved" };
    a.status = approve ? "approved" : "denied";
    a.resolvedBy = by;
    return { ok: true, approval: a };
  }
}

import type { RunEvent } from "@agent-office/shared";
import type { PendingApproval } from "./gateway-mcp";

/*
 * An engine is whatever actually thinks for an agent. The host owns the tools, the
 * credentials, the limits and the approvals. An engine only decides what to ask for.
 *   - "claude-code": the official Claude Code program, signed in as the user (flat subscription).
 *   - "api": our own loop calling a provider API with a key (built, not yet wired to a real provider).
 */

export interface EngineAgent {
  id: string;
  name: string;
  role: string;
  projectId: string;
  model?: string;
}

export interface EngineRunInput {
  agent: EngineAgent;
  task: string;
  runId: string;
  emit?: (e: RunEvent) => void;
  signal?: AbortSignal;
}

/** Enough to continue the same conversation after the user answered an approval. */
export interface ResumeState {
  sessionId: string;
  agent: EngineAgent;
  runId: string;
}

export type EngineOutcome =
  | { status: "finished"; text: string; tokens?: number; equivalentCostUsd?: number }
  | { status: "waiting_approval"; text: string; approvals: PendingApproval[]; resume: ResumeState }
  | { status: "rate_limited"; message: string; resetAt?: number }
  | { status: "not_signed_in"; message: string }
  | { status: "network_problem"; message: string }
  | { status: "failed"; error: string }
  | { status: "timeout" }
  | { status: "cancelled" };

export interface AgentEngine {
  readonly kind: string;
  run(input: EngineRunInput): Promise<EngineOutcome>;
  resume(state: ResumeState, followUp: string, opts?: { emit?: (e: RunEvent) => void; signal?: AbortSignal }): Promise<EngineOutcome>;
}

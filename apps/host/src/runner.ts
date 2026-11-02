import type { RunEvent } from "@agent-office/shared";
import { BudgetExceeded, BudgetTracker, type ChatMessage, type ModelProvider, type ToolCall } from "./model";
import type { ToolGateway } from "./gateway";

/*
 * A small, budgeted agent loop: ask the model, run the tools it asks for through
 * the gateway, feed back scrubbed results, repeat. It stops when the model has
 * no more tool calls, when a budget runs out, or when an action needs approval.
 *
 * Not done yet (Phase 2+): resuming after approval inside the same run,
 * context compaction, streaming, and real sandboxed process execution.
 */

export interface RunAgent {
  id: string;
  name: string;
  role: string;
  model: string;
}

export type RunOutcome =
  | { status: "finished"; text: string; tokens: number; messages: ChatMessage[] }
  | { status: "waiting_approval"; approvalId: string; pendingCall: ToolCall; tokens: number; messages: ChatMessage[] }
  | { status: "budget_exceeded"; what: "tokens" | "steps"; tokens: number; messages: ChatMessage[] }
  | { status: "failed"; error: string; tokens: number; messages: ChatMessage[] };

export interface RunOptions {
  agent: RunAgent;
  runId: string;
  task: string;
  provider: ModelProvider;
  gateway: ToolGateway;
  limits?: { maxTokens: number; maxSteps: number };
  emit?: (e: RunEvent) => void;
  /** Continue an earlier conversation instead of starting from the task. */
  messages?: ChatMessage[];
  now?: () => number;
}

export async function runAgent(o: RunOptions): Promise<RunOutcome> {
  const now = o.now ?? Date.now;
  const emit = o.emit ?? (() => {});
  const budget = new BudgetTracker(o.limits ?? { maxTokens: 50_000, maxSteps: 12 });
  const messages: ChatMessage[] = o.messages ? [...o.messages] : [{ role: "user", content: o.task }];
  const base = { runId: o.runId, agentId: o.agent.id };
  if (!o.messages) emit({ type: "run.started", ...base, ts: now(), task: o.task });

  try {
    for (;;) {
      budget.startStep();
      emit({ type: "step.started", ...base, ts: now(), step: budget.steps });
      // Rebuilt every step so a revoked grant disappears from the tool list immediately.
      const tools = o.gateway.listTools(o.agent.id);
      const system =
        `You are ${o.agent.name}, the ${o.agent.role}. Use only the tools listed. ` +
        `Credentials are handled for you and are never visible. Be brief.\n` +
        (tools.length ? "Tools:\n" + tools.map((t) => `${t.connectionId}/${t.name} [${t.risk}]: ${t.description}`).join("\n") : "No tools.");
      const res = await o.provider.complete({ model: o.agent.model, system, messages, tools, maxOutputTokens: 1024 });
      budget.charge(res.usage);
      messages.push({ role: "assistant", content: res.text });

      if (res.toolCalls.length === 0) {
        emit({ type: "run.finished", ...base, ts: now(), tokens: budget.tokens });
        return { status: "finished", text: res.text, tokens: budget.tokens, messages };
      }

      for (const call of res.toolCalls) {
        const r = await o.gateway.call(o.agent.id, call.connectionId, call.tool, call.args);
        emit({ type: "tool.called", ...base, ts: now(), connectionId: call.connectionId, tool: call.tool, outcome: r.status });
        if (r.status === "needs_approval") {
          emit({ type: "approval.requested", ...base, ts: now(), approvalId: r.approvalId, tool: call.tool });
          return { status: "waiting_approval", approvalId: r.approvalId, pendingCall: call, tokens: budget.tokens, messages };
        }
        const content =
          r.status === "ok" ? r.output :
          r.status === "denied" ? `Denied: ${r.reason}` :
          r.status === "dry_run" ? `Dry run, not executed: ${r.wouldDo}` :
          r.status === "error" ? `Error: ${r.message}` : "";
        messages.push({ role: "tool", content, toolCallId: call.id });
      }
    }
  } catch (e) {
    if (e instanceof BudgetExceeded) {
      emit({ type: "run.failed", ...base, ts: now(), reason: e.message });
      return { status: "budget_exceeded", what: e.what, tokens: budget.tokens, messages };
    }
    const error = e instanceof Error ? e.message : String(e);
    emit({ type: "run.failed", ...base, ts: now(), reason: error });
    return { status: "failed", error, tokens: budget.tokens, messages };
  }
}

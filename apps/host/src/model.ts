import type { ToolIndexEntry } from "./gateway";

/*
 * Model access sits behind one small interface so any provider (Anthropic,
 * OpenAI, Google, a local model, or a LiteLLM proxy) can be plugged in per agent.
 * Only a scripted provider exists so far, for tests and demos. Real adapters
 * are the next piece of work (see docs/PLAN.md, section 5).
 */

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  connectionId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the provider's prompt cache (billed at a lower rate). */
  cachedTokens: number;
}

export interface ModelRequest {
  model: string;
  /** Stable text first (rules, tool index) so provider prompt caching can hit. */
  system: string;
  messages: ChatMessage[];
  tools: ToolIndexEntry[];
  maxOutputTokens: number;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
}

export interface ModelProvider {
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export class BudgetExceeded extends Error {
  constructor(readonly what: "tokens" | "steps") {
    super(`budget exceeded: ${what}`);
  }
}

export class BudgetTracker {
  tokens = 0;
  steps = 0;
  constructor(private readonly limits: { maxTokens: number; maxSteps: number }) {}

  startStep(): void {
    if (this.steps >= this.limits.maxSteps) throw new BudgetExceeded("steps");
    this.steps++;
  }

  charge(u: Usage): void {
    this.tokens += u.inputTokens + u.outputTokens;
    if (this.tokens > this.limits.maxTokens) throw new BudgetExceeded("tokens");
  }
}

type Step = (req: ModelRequest) => Partial<ModelResponse>;

/** Deterministic provider for tests and demos: plays back a list of steps. */
export class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  private i = 0;
  constructor(private readonly steps: Step[]) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const step = this.steps[Math.min(this.i++, this.steps.length - 1)];
    const r = step ? step(req) : {};
    return {
      text: r.text ?? "",
      toolCalls: r.toolCalls ?? [],
      usage: r.usage ?? { inputTokens: 200, outputTokens: 50, cachedTokens: 0 },
    };
  }
}

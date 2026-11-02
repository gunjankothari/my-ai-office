/*
 * Reads the output of `claude -p --output-format stream-json --verbose`, one JSON object per line.
 * Based on Anthropic's documentation and on a real start-up event. It is deliberately forgiving:
 * unknown events and lines that are not JSON are counted and ignored, never fatal.
 */

export interface StreamResult {
  isError: boolean;
  subtype?: string;
  text: string;
  costUsd?: number;
  tokens?: number;
}

export interface ParsedStream {
  sessionId?: string;
  model?: string;
  apiKeySource?: string;
  mcp: { name: string; status: string }[];
  tools: string[];
  retries: { attempt: number; error: string; status: number | null }[];
  assistantText?: string;
  result?: StreamResult;
  badLines: number;
}

export const newParsed = (): ParsedStream => ({ mcp: [], tools: [], retries: [], badLines: 0 });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Adds one line to the parsed state and returns the event type it was, if any. */
export function feed(line: string, into: ParsedStream): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let j: unknown;
  try { j = JSON.parse(trimmed); } catch { into.badLines++; return undefined; }
  if (!isObj(j) || typeof j.type !== "string") { into.badLines++; return undefined; }
  if (typeof j.session_id === "string") into.sessionId = j.session_id;

  if (j.type === "system" && j.subtype === "init") {
    if (typeof j.model === "string") into.model = j.model;
    if (typeof j.apiKeySource === "string") into.apiKeySource = j.apiKeySource;
    if (Array.isArray(j.tools)) into.tools = j.tools.filter((t): t is string => typeof t === "string");
    if (Array.isArray(j.mcp_servers)) {
      into.mcp = j.mcp_servers.filter(isObj).map((s) => ({ name: String(s.name ?? ""), status: String(s.status ?? "") }));
    }
  } else if (j.type === "system" && j.subtype === "api_retry") {
    into.retries.push({ attempt: Number(j.attempt ?? into.retries.length + 1), error: String(j.error ?? "unknown"), status: typeof j.error_status === "number" ? j.error_status : null });
  } else if (j.type === "assistant" && isObj(j.message) && Array.isArray(j.message.content)) {
    const t = j.message.content.filter(isObj).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
    if (t) into.assistantText = t;
  } else if (j.type === "result") {
    const usage = isObj(j.usage) ? j.usage : {};
    const tokens = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].reduce((n, k) => n + (typeof usage[k] === "number" ? (usage[k] as number) : 0), 0);
    into.result = {
      isError: j.is_error === true || (typeof j.subtype === "string" && j.subtype !== "success"),
      subtype: typeof j.subtype === "string" ? j.subtype : undefined,
      text: typeof j.result === "string" ? j.result : "",
      costUsd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : undefined,
      tokens: tokens || undefined,
    };
  }
  return j.type;
}

export type FailureKind = "not_signed_in" | "rate_limited" | "network" | "other";

const AUTH_RETRY = new Set(["authentication_failed", "oauth_org_not_allowed"]);

/** Decides why a run failed, from the documented retry categories first and wording second. */
export function classifyFailure(p: ParsedStream, extraText = ""): { kind: FailureKind; resetAt?: number } {
  const errs = new Set(p.retries.map((r) => r.error));
  const text = `${p.result?.isError ? p.result.text : ""} ${extraText}`;
  const reset = /\|\s*(\d{10})\b/.exec(text);
  const resetAt = reset ? Number(reset[1]) * 1000 : undefined;
  if ([...errs].some((e) => AUTH_RETRY.has(e)) || /not logged in|please run \/login|invalid api key|oauth token (has )?expired/i.test(text)) return { kind: "not_signed_in" };
  if (errs.has("rate_limit") || /usage limit|rate limit|limit reached|hit your limit/i.test(text)) return { kind: "rate_limited", resetAt };
  if (p.retries.length > 0 && !p.result) return { kind: "network" };
  return { kind: "other" };
}

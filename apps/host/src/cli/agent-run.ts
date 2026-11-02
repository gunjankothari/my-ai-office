import type { RunEvent } from "@agent-office/shared";
import { Office } from "../office";
import { approvalFollowUp } from "../engines/followup";
import type { CallResult } from "../gateway";
import type { EngineOutcome } from "../engines/types";
import type { PendingApproval } from "../engines/gateway-mcp";

/*
 * Runs one task for one agent on the Claude Code engine, in a terminal. If the agent asks for an
 * action that needs approval, you are asked right here (until the phone screen exists), and the
 * same conversation continues with the answer. Written against small IO functions so it can be tested.
 */

export interface RunIO {
  ask(question: string): Promise<string>;
  say(line: string): void;
}

export interface AgentRunOptions {
  home: string;
  masterKey: Buffer;
  task: string;
  agentId?: string;
  /** Claude model alias (for example "sonnet" or "haiku"). Default: what your Claude Code uses. */
  model?: string;
  claude?: { command?: string; commandArgs?: string[]; timeoutMs?: number };
  signal?: AbortSignal;
  maxRounds?: number;
  now?: () => number;
  restMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface AgentRunResult { ok: boolean; status: EngineOutcome["status"] | "no_agent" | "busy"; text?: string }

const usd = (n?: number) => (n === undefined ? "" : ` Claude Code estimates this would cost about $${n.toFixed(4)} on the pay-per-use API. On your plan it is covered by the flat fee, within its usage limits.`);

/** Says so when the answer cannot be trusted to rest on real tool results. */
export function explainOddRun(d: { toolUses: string[]; permissionDenials: string[] } | undefined, gatewayCalls: number, grantedTools: number): string[] {
  const w: string[] = [];
  if (grantedTools === 0) w.push("This agent has no tools, so nothing above was checked against GitHub or any other system. Treat any facts in it as unverified. Run `npm run github` to connect GitHub and grant Ada a tool.");
  if (!d) return w;
  if (d.permissionDenials.length) w.push(`Claude Code blocked ${d.permissionDenials.length} tool request(s) itself: ${[...new Set(d.permissionDenials)].join(", ")}. Those never reached Agent Office, so the answer above is not based on them.`);
  if (grantedTools > 0 && gatewayCalls === 0) w.push(`The agent has ${grantedTools} granted tool(s) but no tool call reached Agent Office${d.toolUses.length ? ` (Claude Code asked for: ${d.toolUses.join(", ")})` : " (Claude Code asked for none)"}. Treat the answer above as unverified: it was not based on real data.`);
  return w;
}

export async function runAgentTask(io: RunIO, o: AgentRunOptions): Promise<AgentRunResult> {
  const office = await Office.open({ home: o.home, name: "Agent run", masterKey: o.masterKey, claude: o.claude, now: o.now, restMs: o.restMs });
  try {
    const agentId = o.agentId ?? "ada";
    const agent = office.agents.get(agentId);
    if (!agent) {
      const names = [...office.agents.keys()];
      io.say(`There is no agent "${agentId}" in this office.${names.length ? ` Agents: ${names.join(", ")}.` : " Run `npm run github` first to create one."}`);
      return { ok: false, status: "no_agent" };
    }
    if (agent.engine !== "claude-code" || (o.model && agent.engineModel !== o.model)) office.setAgentEngine(agentId, "claude-code", o.model);

    const tools = office.gateway.listTools(agentId);
    io.say(`${agent.name} will work with your own Claude Code sign-in. No API key is used.`);
    if ((o.env ?? process.env).ANTHROPIC_API_KEY) io.say("Note: ANTHROPIC_API_KEY is set in your shell. It is not passed to Claude Code, so your subscription is what gets used.");
    if (!tools.length) io.say(`Heads up: ${agent.name} has no tools, so she cannot look anything up. She can only answer from what you write.`);
    io.say(tools.length ? `Tools ${agent.name} may use: ${tools.map((t) => `${t.connectionId}/${t.name}`).join(", ")}` : `${agent.name} has no tools granted, so can only answer from what you write.`);
    io.say("");

    let gatewayCalls = 0;
    const track = (e: RunEvent) => { if (e.type === "tool.called") { gatewayCalls++; io.say(`  . ${e.connectionId}/${e.tool}: ${e.outcome}`); } };

    let outcome: EngineOutcome;
    try {
      outcome = await office.runTask(agentId, o.task, { emit: track, signal: o.signal });
    } catch (e) {
      io.say((e as Error).message);
      return { ok: false, status: "busy" };
    }

    for (let round = 0; outcome.status === "waiting_approval" && round < (o.maxRounds ?? 5); round++) {
      const answered: { approval: PendingApproval; result: CallResult }[] = [];
      for (const a of outcome.approvals) {
        const detail = office.approvals.get(a.approvalId)?.summary ?? a.tool;
        const answer = await io.ask(`\n${agent.name} wants to run: ${detail}\n  Approve? [y/N] `);
        const yes = /^y/i.test(answer.trim());
        answered.push({ approval: a, result: await office.gateway.resolveApproval(a.approvalId, yes, "terminal") });
      }
      io.say("");
      outcome = await office.continueRun(outcome.resume, approvalFollowUp(answered), { emit: track, signal: o.signal });
    }

    switch (outcome.status) {
      case "finished":
        io.say(`${agent.name}:\n${outcome.text}\n`);
        for (const w of explainOddRun(outcome.diagnostics, gatewayCalls, tools.length)) io.say(`Warning: ${w}`);
        io.say(`Done.${usd(outcome.equivalentCostUsd)}`);
        return { ok: true, status: "finished", text: outcome.text };
      case "waiting_approval":
        io.say(`${agent.name} is still waiting for approval after ${o.maxRounds ?? 5} rounds. Stopping here.`);
        return { ok: false, status: "waiting_approval" };
      case "rate_limited":
        io.say(`Your Claude usage limit was reached. ${agent.name} will rest until ${new Date(office.agents.get(agentId)!.sleepUntil!).toLocaleTimeString()}. ${outcome.message}`);
        return { ok: false, status: "rate_limited" };
      case "not_signed_in":
        io.say(outcome.message);
        return { ok: false, status: "not_signed_in" };
      case "network_problem":
        io.say(outcome.message);
        return { ok: false, status: "network_problem" };
      case "timeout":
        io.say("It took too long and was stopped.");
        return { ok: false, status: "timeout" };
      case "cancelled":
        io.say("Cancelled.");
        return { ok: false, status: "cancelled" };
      case "failed":
        io.say(`It did not finish: ${outcome.error}`);
        return { ok: false, status: "failed" };
    }
  } finally {
    await office.close();
  }
}

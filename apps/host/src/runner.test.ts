import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunEvent } from "@agent-office/shared";
import { SECRET, makeEnv } from "../test/helpers";
import { ScriptedProvider } from "./model";
import { runAgent } from "./runner";

const agent = { id: "ada", name: "Ada", role: "Developer", model: "mid" };

test("a run calls tools through the gateway and finishes; the model never sees the credential", async () => {
  const e = makeEnv();
  e.addAgent("ada");
  e.addGrant({ agentId: "ada", tools: ["list_pull_requests", "leaky_debug"] });
  const provider = new ScriptedProvider([
    () => ({ text: "Checking.", toolCalls: [{ id: "1", connectionId: "gh", tool: "leaky_debug", args: {} }, { id: "2", connectionId: "gh", tool: "list_pull_requests", args: { repo: "r" } }] }),
    () => ({ text: "Done: 1 open PR." }),
  ]);
  const events: RunEvent[] = [];
  const out = await runAgent({ agent, runId: "run1", task: "Check PRs", provider, gateway: e.gateway, emit: (x) => events.push(x) });

  assert.equal(out.status, "finished");
  assert.deepEqual(events.map((x) => x.type), ["run.started", "step.started", "tool.called", "tool.called", "step.started", "run.finished"]);
  const everything = JSON.stringify(provider.requests) + JSON.stringify(out);
  assert.ok(!everything.includes(SECRET), "credential never appears in anything the model saw or produced");
  assert.ok(everything.includes("[hidden]"));
});

test("the model is only told about tools it was granted", async () => {
  const e = makeEnv();
  e.addAgent("ada");
  e.addGrant({ agentId: "ada", tools: ["list_pull_requests"] });
  const provider = new ScriptedProvider([() => ({ text: "ok" })]);
  await runAgent({ agent, runId: "r", task: "t", provider, gateway: e.gateway });
  const sys = provider.requests[0]!.system;
  assert.ok(sys.includes("list_pull_requests"));
  assert.ok(!sys.includes("delete_branch") && !sys.includes("send_message"));
});

test("a denied call is reported to the model as text and the run continues", async () => {
  const e = makeEnv();
  e.addAgent("ada");
  e.addGrant({ agentId: "ada", tools: ["list_pull_requests"] });
  const provider = new ScriptedProvider([
    () => ({ toolCalls: [{ id: "1", connectionId: "gh", tool: "delete_branch", args: { repo: "r" } }] }),
    (req) => ({ text: req.messages.at(-1)?.content ?? "" }),
  ]);
  const out = await runAgent({ agent, runId: "r", task: "t", provider, gateway: e.gateway });
  assert.ok(out.status === "finished" && out.text === "Denied: not granted");
  assert.equal(e.server.calls.length, 0);
});

test("a risky call pauses the run and returns the pending approval", async () => {
  const e = makeEnv();
  e.addAgent("ada");
  e.addGrant({ agentId: "ada", tools: ["delete_branch"] });
  const provider = new ScriptedProvider([() => ({ toolCalls: [{ id: "1", connectionId: "gh", tool: "delete_branch", args: { repo: "r" } }] })]);
  const events: RunEvent[] = [];
  const out = await runAgent({ agent, runId: "r", task: "t", provider, gateway: e.gateway, emit: (x) => events.push(x) });
  assert.equal(out.status, "waiting_approval");
  assert.ok(events.some((x) => x.type === "approval.requested"));
  assert.equal(e.approvals.pending().length, 1);
  assert.equal(e.server.calls.length, 0);
});

test("token and step budgets stop a run", async () => {
  const e = makeEnv();
  e.addAgent("ada");
  e.addGrant({ agentId: "ada", tools: ["list_pull_requests"] });
  const loop = () => ({ toolCalls: [{ id: "x", connectionId: "gh", tool: "list_pull_requests", args: { repo: "r" } }], usage: { inputTokens: 600, outputTokens: 100, cachedTokens: 0 } });
  const byTokens = await runAgent({ agent, runId: "r", task: "t", provider: new ScriptedProvider([loop]), gateway: e.gateway, limits: { maxTokens: 1500, maxSteps: 50 } });
  assert.deepEqual([byTokens.status, byTokens.status === "budget_exceeded" && byTokens.what], ["budget_exceeded", "tokens"]);
  const bySteps = await runAgent({ agent, runId: "r", task: "t", provider: new ScriptedProvider([loop]), gateway: e.gateway, limits: { maxTokens: 1e9, maxSteps: 3 } });
  assert.deepEqual([bySteps.status, bySteps.status === "budget_exceeded" && bySteps.what], ["budget_exceeded", "steps"]);
});

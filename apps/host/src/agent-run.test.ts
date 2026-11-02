import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SECRET, tmp } from "../test/helpers";
import { Office } from "./office";
import { runAgentTask, type RunIO } from "./cli/agent-run";
import { approvalFollowUp } from "./engines/followup";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(HERE, "../test/fixtures/fake-claude.mjs");
const FAKE_GITHUB = join(HERE, "../test/fixtures/fake-github-mcp.mjs");

const opened: Office[] = [];
// Whatever a test does, its office (and the server processes it started) is closed at the end.
after(async () => { for (const o of opened) await o.close(); });

/** An office with a GitHub-shaped MCP server, one reviewed repo-limited tool, and Ada granted it plus an unreviewed merge tool. */
async function world(now?: () => number, timeoutMs = 20_000) {
  const home = tmp();
  const masterKey = randomBytes(32);
  const claude = { command: process.execPath, commandArgs: [FAKE_CLAUDE], timeoutMs };
  const office = await Office.open({ home, name: "t", masterKey, claude, now, restMs: 30 * 60_000 });
  office.addProject("p", "Project");
  office.addAgent({ id: "ada", name: "Ada", role: "Developer", projectId: "p", mode: "risky", model: "mid" });
  office.vault.put("p", "github", SECRET);
  await office.addMcpConnection({ id: "github", projectId: "p", service: "GitHub", label: "fixture", credentialHandle: "github", spec: { kind: "stdio", command: process.execPath, args: [FAKE_GITHUB], secretEnv: "GITHUB_PERSONAL_ACCESS_TOKEN" } });
  office.reviewTool("p", "github", "list_pull_requests", { risk: "read", resourceArgs: ["owner", "repo"] });
  office.addGrant({ id: "g1", projectId: "p", agentId: "ada", connectionId: "github", tools: ["list_pull_requests"], resources: ["acme/app"] });
  office.addGrant({ id: "g2", projectId: "p", agentId: "ada", connectionId: "github", tools: ["merge_pull_request"], resources: [] });
  opened.push(office);
  return { home, masterKey, claude, office };
}

const term = (answers: string[] = []) => {
  const said: string[] = [];
  const io: RunIO = { say: (l) => said.push(l), ask: async (q) => { said.push(q); const a = answers.shift(); if (a === undefined) throw new Error("unexpected question " + q); return a; } };
  return { io, said };
};

test("a task runs end to end: Ada works through the gateway, the answer and the estimate are shown, usage is counted", async () => {
  const w = await world();
  await w.office.close();
  const { io, said } = term();
  const r = await runAgentTask(io, { home: w.home, masterKey: w.masterKey, claude: w.claude, task: "Summarise. [scenario:read]", env: { ANTHROPIC_API_KEY: "x" } });
  assert.equal(r.ok, true, said.join("\n"));
  const out = said.join("\n");
  assert.ok(out.includes("no API key") || out.includes("No API key is used"));
  assert.ok(out.includes("ANTHROPIC_API_KEY is set") && out.includes("not passed"));
  assert.ok(out.includes("github/list_pull_requests") && out.includes("github/merge_pull_request"));
  assert.ok(out.includes(". github/list_pull_requests: ok"), "tool calls are shown as they happen");
  assert.ok(out.includes("Settings: dark mode toggle") && out.includes("$0.0123") && out.includes("flat fee"));
  assert.ok(!out.includes(SECRET));

  const again = await Office.open({ home: w.home, name: "t", masterKey: w.masterKey, claude: w.claude });
  assert.equal(again.agents.get("ada")!.engine, "claude-code");
  assert.equal(again.agents.get("ada")!.status, "idle");
  assert.equal(again.agents.get("ada")!.tokensToday, 120);
  await again.close();
});

test("approval round: you are asked, the answer runs or blocks the action, and the same conversation continues", async () => {
  for (const [answer, expect] of [["y", "was approved and has now run"], ["n", "was NOT approved"]] as const) {
    const w = await world();
    await w.office.close();
    const { io, said } = term([answer]);
    const r = await runAgentTask(io, { home: w.home, masterKey: w.masterKey, claude: w.claude, task: "Merge it. [scenario:approval]" });
    assert.equal(r.ok, true, said.join("\n"));
    const out = said.join("\n");
    assert.ok(out.includes("wants to run: merge_pull_request("), out);
    assert.ok(out.includes(expect), `${answer}: ${out}`);
    assert.ok(out.includes("RESUMED=sess-"), "continued the same session");
    if (answer === "y") assert.ok(out.includes("merged"), "the approved action's output reached the agent");
    else assert.ok(!out.includes("merged"));
  }
});

test("a usage limit puts the agent to sleep; it refuses work until the reset, then wakes", async () => {
  let t = 1_700_000_000_000;
  const w = await world(() => t);
  w.office.setAgentEngine("ada", "claude-code");
  const first = await w.office.runTask("ada", "x [scenario:ratelimit]");
  assert.equal(first.status, "rate_limited");
  const ada = w.office.agents.get("ada")!;
  assert.deepEqual([ada.status, ada.sleepUntil], ["asleep", t + 30 * 60_000], "no reset time given: rests for the default period");
  await assert.rejects(w.office.runTask("ada", "again [scenario:read]"), /resting until/);
  t += 31 * 60_000;
  const next = await w.office.runTask("ada", "again [scenario:read]");
  assert.equal(next.status, "finished");
  assert.equal(w.office.agents.get("ada")!.status, "idle");

  const withReset = await w.office.runTask("ada", "x [scenario:ratelimit_result]");
  assert.equal(withReset.status, "rate_limited");
  assert.equal(w.office.agents.get("ada")!.sleepUntil, 1893456000000, "the reset time from the message is used");
  await w.office.close();
});

test("not signed in leaves the agent awake and tells you what to do", async () => {
  const w = await world();
  await w.office.close();
  const { io, said } = term();
  const r = await runAgentTask(io, { home: w.home, masterKey: w.masterKey, claude: w.claude, task: "x [scenario:signedout_result]" });
  assert.deepEqual([r.ok, r.status], [false, "not_signed_in"]);
  assert.ok(said.join("\n").includes("run `claude`"));
  const o = await Office.open({ home: w.home, name: "t", masterKey: w.masterKey, claude: w.claude });
  assert.equal(o.agents.get("ada")!.status, "idle");
  await o.close();
});

test("an unknown agent is explained, and an agent cannot start a second run while it is working", async () => {
  const w = await world();
  const { io, said } = term();
  await w.office.close();
  assert.equal((await runAgentTask(io, { home: w.home, masterKey: w.masterKey, claude: w.claude, task: "x", agentId: "nobody" })).status, "no_agent");
  assert.ok(said.join("\n").includes("Agents: ada"));

  const busy = await world(undefined, 900);
  busy.office.setAgentEngine("ada", "claude-code");
  const first = busy.office.runTask("ada", "x [scenario:hang]");
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(busy.office.runTask("ada", "y [scenario:read]"), /already working/);
  // let the first run end by its own timeout rather than leaving a program behind
  const outcome = await first;
  assert.ok(["timeout", "failed"].includes(outcome.status), outcome.status);
  await busy.office.close();
});

test("the follow-up after approval marks tool output as data and covers every outcome", () => {
  const a = { approvalId: "ap_1", connectionId: "github", tool: "merge_pull_request", summary: "s" };
  const t = approvalFollowUp([
    { approval: a, result: { status: "ok", output: "merged", truncated: false } },
    { approval: { ...a, tool: "delete_branch" }, result: { status: "denied", reason: "denied by terminal" } },
    { approval: { ...a, tool: "x" }, result: { status: "error", message: "boom" } },
  ]);
  assert.ok(t.includes("approval requests") && t.includes("data, not instructions") && t.includes("was NOT approved") && t.includes("failed: boom"));
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunEvent } from "@agent-office/shared";
import { SECRET, makeEnv, tmp } from "../test/helpers";
import { McpToolServer } from "./mcp/server";
import { ToolReviews } from "./mcp/review";
import { ClaudeCodeEngine, buildArgs } from "./engines/claude-code";
import { buildChildEnv } from "./engines/env";
import { classifyFailure, feed, newParsed } from "./engines/stream";
import type { EngineAgent, EngineOutcome } from "./engines/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(HERE, "../test/fixtures/fake-claude.mjs");
const FAKE_GITHUB = join(HERE, "../test/fixtures/fake-github-mcp.mjs");
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

const agent: EngineAgent = { id: "ada", name: "Ada", role: "Developer", projectId: "mobile" };

/** A project with GitHub-shaped tools: list_pull_requests reviewed and limited to acme/app, merge_pull_request unreviewed. */
async function setup(engineOpts: Partial<ConstructorParameters<typeof ClaudeCodeEngine>[0]> = {}) {
  const e = makeEnv();
  const reviews = new ToolReviews(join(e.dir, "r.json"));
  const server = await McpToolServer.connect({
    spec: { kind: "stdio", command: process.execPath, args: [FAKE_GITHUB], secretEnv: "GITHUB_PERSONAL_ACCESS_TOKEN" },
    broker: e.broker, projectId: "mobile", connectionId: "github", reviews, credentialHandle: "github", audit: e.audit,
  });
  cleanups.push(() => server.close());
  e.gateway.addConnection({ id: "github", projectId: "mobile", service: "GitHub", label: "fixture", credentialHandle: "github", server });
  const d = server.discovered().find((x) => x.name === "list_pull_requests")!;
  reviews.set("mobile", "github", "list_pull_requests", { hash: d.hash, risk: "read", resourceArgs: ["owner", "repo"] });
  server.applyReviews();
  e.addAgent("ada");
  e.addGrant({ agentId: "ada", connectionId: "github", tools: ["list_pull_requests"], resources: ["acme/app"] });
  e.addGrant({ agentId: "ada", connectionId: "github", tools: ["merge_pull_request"], resources: [] });
  const workRoot = tmp();
  const privateRoot = tmp();
  const engine = new ClaudeCodeEngine({
    gateway: e.gateway, workRoot, privateRoot, command: process.execPath, commandArgs: [FAKE_CLAUDE],
    scrub: (p, t) => e.broker.scrub(p, t), ...engineOpts,
  });
  return { e, engine, workRoot, privateRoot };
}

const run = (engine: ClaudeCodeEngine, scenario: string, extra = "", more: { signal?: AbortSignal; emit?: (e: RunEvent) => void; who?: EngineAgent } = {}) =>
  engine.run({ agent: more.who ?? agent, runId: "r1", task: `Do the job. [scenario:${scenario}] ${extra}`, signal: more.signal, emit: more.emit });

/** An agent whose name is unique to one test, so that test can find exactly its own programs. Tests run side by side. */
const unique = (): EngineAgent => ({ ...agent, name: `Ada${Math.random().toString(36).slice(2, 8)}` });

const text = (o: EngineOutcome) => (o.status === "finished" || o.status === "waiting_approval" ? o.text : JSON.stringify(o));
const part = (t: string, name: string) => t.split(`${name}=`)[1]!.split(" | ")[0]!;
const strays = (who: EngineAgent) => { try { return execSync("ps -eo cmd", { encoding: "utf8" }).split("\n").filter((l) => l.includes("fake-claude.mjs") && l.includes(`You are ${who.name},`)).length; } catch { return 0; } };

test("a run goes through our gateway; the program is started safely and gets almost nothing from our environment", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-api-key-that-must-never-reach-the-program";
  process.env.AGENT_OFFICE_MASTER_KEY = "master-key-that-must-never-reach-the-program";
  process.env.GITHUB_PERSONAL_ACCESS_TOKEN = SECRET;
  const me = unique();
  const { engine, workRoot, privateRoot } = await setup();
  try {
    const events: RunEvent[] = [];
    const out = await run(engine, "read", "", { emit: (x) => events.push(x), who: me });
    assert.equal(out.status, "finished", JSON.stringify(out));
    assert.ok(out.status === "finished" && out.tokens === 120 && out.equivalentCostUsd === 0.0123);

    const t = text(out);
    assert.ok(t.includes("Settings: dark mode toggle"), "a real tool call went through the gateway");
    assert.equal(part(t, "TOOLS"), "github__list_pull_requests,github__merge_pull_request", "only the granted tools were offered");

    const dbg = JSON.parse(t.split("DEBUG=")[1]!) as { argv: string[]; cwd: string; envKeys: string[] };
    assert.equal(realpathSync(dbg.cwd), realpathSync(join(workRoot, "ada")), "runs in the agent's own empty folder");
    assert.deepEqual(readdirSync(join(workRoot, "ada")), [], "and that folder is empty");
    for (const k of dbg.envKeys) assert.ok(!/^(ANTHROPIC_|AGENT_OFFICE_|GITHUB_|HUB_)/.test(k), `leaked ${k}`);
    assert.ok(dbg.envKeys.includes("PATH"));
    assert.ok(!JSON.stringify(dbg).includes(SECRET) && !JSON.stringify(dbg).includes("must-never-reach"), "no secret in anything the program received");

    assert.deepEqual(events.map((x) => x.type), ["run.started", "tool.called", "run.finished"]);
    assert.ok(events.some((x) => x.type === "tool.called" && x.outcome === "ok"));
  } finally {
    delete process.env.ANTHROPIC_API_KEY; delete process.env.AGENT_OFFICE_MASTER_KEY; delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  }
  assert.deepEqual(readdirSync(privateRoot), [], "the private config folder (with the run token) is deleted afterwards");
  assert.equal(strays(me), 0);
});

test("an action that needs approval pauses the run; after approval the same conversation continues", async () => {
  const { e, engine } = await setup();
  const first = await run(engine, "approval");
  assert.equal(first.status, "waiting_approval", JSON.stringify(first));
  if (first.status !== "waiting_approval") return;
  assert.equal(first.approvals.length, 1);
  assert.equal(first.approvals[0]!.tool, "merge_pull_request");
  assert.equal(e.approvals.pending().length, 1, "queued for the user, not executed");
  assert.ok(first.resume.sessionId.startsWith("sess-") && first.resume.runId === "r1");

  const done = await e.gateway.resolveApproval(first.approvals[0]!.approvalId, true, "phone");
  assert.equal(done.status, "ok");

  const second = await engine.resume(first.resume, `[scenario:resume] The user approved your request. It ran and returned: ${done.status === "ok" ? done.output : ""}`);
  assert.equal(second.status, "finished", JSON.stringify(second));
  assert.ok(text(second).includes(`RESUMED=${first.resume.sessionId}`) && text(second).includes("merged"));
});

test("usage limit: stopped at the first sign of it (not after minutes of retries), and when it resets is read from the message", async () => {
  const { engine } = await setup();
  const me = unique();
  const started = Date.now();
  const a = await run(engine, "ratelimit", "", { who: me });
  assert.equal(a.status, "rate_limited");
  assert.ok(Date.now() - started < 8000, "killed quickly");
  const b = await run(engine, "ratelimit_result", "", { who: me });
  assert.deepEqual([b.status, b.status === "rate_limited" && b.resetAt], ["rate_limited", 1893456000000]);
  assert.equal(strays(me), 0, "no program left running");
});

test("not signed in is reported plainly, with what to do", async () => {
  const { engine } = await setup();
  for (const s of ["signedout", "signedout_result"]) {
    const o = await run(engine, s);
    assert.equal(o.status, "not_signed_in", s);
    assert.ok(o.status === "not_signed_in" && /run `claude`/.test(o.message));
  }
});

test("no network: gives up after a few retry events instead of waiting for all of them", async () => {
  const { engine } = await setup();
  const me = unique();
  const o = await run(engine, "network", "", { who: me });
  assert.equal(o.status, "network_problem");
  assert.equal(strays(me), 0);
});

test("if the program cannot reach our tool server, nothing runs and it says so", async () => {
  const { engine } = await setup();
  const o = await run(engine, "badmcp");
  assert.ok(o.status === "failed" && /tool server/.test(o.error), JSON.stringify(o));
});

test("timeout and cancel stop the program", async () => {
  const me = unique();
  const { engine } = await setup({ timeoutMs: 700 });
  assert.equal((await run(engine, "hang", "", { who: me })).status, "timeout");

  const { engine: e2 } = await setup();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 600);
  assert.equal((await run(e2, "hang", "", { signal: ac.signal, who: me })).status, "cancelled");
  assert.equal(strays(me), 0);
});

test("a crash message is shortened and any secret in it is removed", async () => {
  const { engine } = await setup();
  const o = await run(engine, "crash", `[leak:${SECRET}]`);
  assert.ok(o.status === "failed" && /exit code 3/.test(o.error), JSON.stringify(o));
  assert.ok(o.status === "failed" && !o.error.includes(SECRET) && o.error.length < 400);
});

test("noise in the output stream is ignored", async () => {
  const { engine } = await setup();
  const o = await run(engine, "garbage");
  assert.ok(o.status === "finished" && o.text === "survived noise", JSON.stringify(o));
});

test("a missing program is explained", async () => {
  const { engine } = await setup({ command: "definitely-not-an-installed-program-xyz", commandArgs: [] });
  const o = await run(engine, "read");
  assert.ok(o.status === "failed" && /installed/.test(o.error), JSON.stringify(o));
});

test("environment: only an allowlist is passed, API keys never are, extras only when asked", () => {
  const src = { PATH: "/bin", HOME: "/home/u", HTTPS_PROXY: "http://p:1", CLAUDE_CONFIG_DIR: "/c", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", AGENT_OFFICE_MASTER_KEY: "m", GITHUB_TOKEN: "g", HUB_ADMIN_TOKEN: "h", RANDOM: "x" };
  const loop = "127.0.0.1,localhost,::1";
  assert.deepEqual(buildChildEnv(src), { PATH: "/bin", HOME: "/home/u", HTTPS_PROXY: "http://p:1", CLAUDE_CONFIG_DIR: "/c", NO_PROXY: loop, no_proxy: loop });
  assert.equal(buildChildEnv(src, ["RANDOM"]).RANDOM, "x");
  // loopback is always exempt from a proxy (a real Claude Code failed to reach our local server without this), and the user's own exemptions are kept
  assert.equal(buildChildEnv({ ...src, NO_PROXY: "corp.example, 127.0.0.1" }).NO_PROXY, "corp.example,127.0.0.1,localhost,::1");
  assert.equal(buildChildEnv({ ...src, no_proxy: "internal" }).no_proxy, "internal,127.0.0.1,localhost,::1");
});

test("arguments: built-in tools off, our server only, no bypass flags, model and resume optional", () => {
  const a = buildArgs({ mcpConfigPath: "/p/mcp.json", systemPrompt: "sys" });
  assert.deepEqual(a.slice(a.indexOf("--tools"), a.indexOf("--tools") + 2), ["--tools", ""]);
  assert.ok(a.includes("--strict-mcp-config") && a.includes("--disable-slash-commands"));
  assert.equal(a[a.indexOf("--allowedTools") + 1], "mcp__office__*");
  assert.equal(a[a.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(a[a.indexOf("--setting-sources") + 1], "");
  for (const bad of ["--bare", "--dangerously-skip-permissions", "bypassPermissions", "acceptEdits", "--model", "--resume"]) assert.ok(!a.includes(bad), bad);
  const b = buildArgs({ mcpConfigPath: "/p/mcp.json", systemPrompt: "sys", model: "sonnet", resume: "abc" });
  assert.equal(b[b.indexOf("--model") + 1], "sonnet");
  assert.equal(b[b.indexOf("--resume") + 1], "abc");
});

test("stream parser: reads the events we rely on and survives everything else", () => {
  const p = newParsed();
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "m", apiKeySource: "none", tools: [], mcp_servers: [{ name: "office", status: "connected" }] }),
    "not json",
    JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, error: "rate_limit", error_status: 429 }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }, { type: "tool_use", name: "x" }] } }),
    JSON.stringify({ type: "something_new", whatever: 1 }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 85 } }),
  ];
  assert.deepEqual(lines.map((l) => feed(l, p)), ["system", undefined, "system", "assistant", "something_new", "result"]);
  assert.equal(p.sessionId, "s1");
  assert.deepEqual(p.mcp, [{ name: "office", status: "connected" }]);
  assert.equal(p.assistantText, "hello");
  assert.deepEqual(p.result, { isError: false, subtype: "success", text: "done", costUsd: 0.5, tokens: 100 });
  assert.equal(p.badLines, 1);
});

test("failure classification: documented retry categories first, wording second, success is never a failure", () => {
  const withRetry = (error: string) => { const p = newParsed(); feed(JSON.stringify({ type: "system", subtype: "api_retry", error }), p); return p; };
  assert.equal(classifyFailure(withRetry("authentication_failed")).kind, "not_signed_in");
  assert.equal(classifyFailure(withRetry("oauth_org_not_allowed")).kind, "not_signed_in");
  assert.equal(classifyFailure(withRetry("rate_limit")).kind, "rate_limited");
  assert.equal(classifyFailure(withRetry("overloaded")).kind, "network");
  const err = (t: string) => { const p = newParsed(); feed(JSON.stringify({ type: "result", is_error: true, result: t }), p); return p; };
  assert.equal(classifyFailure(err("Please run /login")).kind, "not_signed_in");
  assert.equal(classifyFailure(err("You've hit your limit")).kind, "rate_limited");
  assert.equal(classifyFailure(err("limit reached|1893456000")).resetAt, 1893456000000);
  assert.equal(classifyFailure(err("something else broke")).kind, "other");
  const ok = newParsed();
  feed(JSON.stringify({ type: "result", is_error: false, result: "The rate limit in the docs is 100/min" }), ok);
  assert.equal(classifyFailure(ok).kind, "other", "words in a successful answer are not a failure");
});

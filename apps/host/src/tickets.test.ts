import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SECRET, tmp } from "../test/helpers";
import { Office, type OfficeOptions } from "./office";
import { handleTeamCommand } from "./team-commands";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(HERE, "../test/fixtures/fake-claude.mjs");
const FAKE_GITHUB = join(HERE, "../test/fixtures/fake-github-mcp.mjs");

const opened: Office[] = [];
after(async () => { for (const o of opened) await o.close(); });

/** Project "p" with a Manager, Ada (developer, GitHub read) and Quinn (QA). Project "q" has Zed. */
async function world(extra: Partial<OfficeOptions> = {}, existing?: { home: string; masterKey: Buffer }) {
  const home = existing?.home ?? tmp();
  const masterKey = existing?.masterKey ?? randomBytes(32);
  const claude = { command: process.execPath, commandArgs: [FAKE_CLAUDE], timeoutMs: 20_000 };
  const office = await Office.open({ home, name: "t", masterKey, claude, restMs: 30 * 60_000, ...extra });
  opened.push(office);
  if (!existing) {
    office.addProject("p", "Project");
    office.addProject("q", "Other project");
    office.ensureManager("p");
    office.addAgent({ id: "ada", name: "Ada", role: "Developer", projectId: "p", mode: "risky", model: "mid", engine: "claude-code", skills: "typescript, github" });
    office.addAgent({ id: "quinn", name: "Quinn", role: "QA Reviewer", projectId: "p", mode: "risky", model: "mid", engine: "claude-code" });
    office.addAgent({ id: "zed", name: "Zed", role: "Developer", projectId: "q", mode: "risky", model: "mid", engine: "claude-code" });
    office.vault.put("p", "github", SECRET);
    await office.addMcpConnection({ id: "github", projectId: "p", service: "GitHub", label: "fixture", credentialHandle: "github", spec: { kind: "stdio", command: process.execPath, args: [FAKE_GITHUB], secretEnv: "GITHUB_PERSONAL_ACCESS_TOKEN" } });
    office.reviewTool("p", "github", "list_pull_requests", { risk: "read", resourceArgs: ["owner", "repo"] });
    office.addGrant({ id: "g1", projectId: "p", agentId: "ada", connectionId: "github", tools: ["list_pull_requests"], resources: ["acme/app"] });
    office.addGrant({ id: "g2", projectId: "p", agentId: "ada", connectionId: "github", tools: ["merge_pull_request"], resources: [] });
  }
  return { home, masterKey, office };
}

const kinds = (o: Office, id: string) => o.tickets.get(id)!.events.map((e) => e.kind);
const cmd = (o: Office, type: string, payload: Record<string, unknown> = {}) => handleTeamCommand(o, type, payload, "dev1").then((r) => { assert.ok(r.handled, type); return (r as { result: any }).result; });

test("a ticket goes to the Manager, who hands it to the right agent. It gets done, and tokens and cost are counted per person", async () => {
  const { office } = await world();
  const t = office.tickets.create({ projectId: "p", title: "Check the open PRs", description: "Summarise. [to:ada] [scenario:read]", createdBy: "user" });
  await office.dispatcher.drain();
  const done = office.tickets.get(t.id)!;
  assert.equal(done.status, "done", JSON.stringify(done.events));
  assert.equal(done.assigneeId, "ada");
  assert.deepEqual(kinds(office, t.id), ["created", "triage_started", "assigned", "started", "finished"]);
  assert.ok(done.result?.includes("Settings: dark mode toggle"));
  // Two runs (triage and work), 120 tokens each, each credited to who did it.
  assert.equal(done.usage.runs, 2);
  assert.equal(done.usage.tokens, 240);
  assert.equal(done.workers["manager-p"]!.tokens, 120);
  assert.equal(done.workers["ada"]!.tokens, 120);
  assert.ok(Math.abs(done.usage.costUsd - 0.0246) < 1e-9);
  assert.equal(office.agents.get("ada")!.tokensToday, 120);
  assert.ok(!JSON.stringify(done).includes(SECRET));
});

test("the Manager sees exactly two tools and nothing else, and cannot use anyone else's", async () => {
  const { office } = await world();
  assert.deepEqual(office.gateway.listTools("manager-p").map((t) => t.name).sort(), ["ask_user", "assign_ticket"]);
  const r = await office.gateway.call("manager-p", "github", "list_pull_requests", { owner: "acme", repo: "app" });
  assert.equal(r.status, "denied");
  // Workers do not get the team tools.
  assert.ok(!office.gateway.listTools("ada").some((t) => t.connectionId === "team"));
});

test("with no Manager, a ticket waits for you to assign it, then runs", async () => {
  const { office } = await world();
  office.agents.delete("manager-p");
  const t = office.tickets.create({ projectId: "p", title: "x", description: "[scenario:read]", createdBy: "user" });
  await office.dispatcher.drain();
  assert.equal(office.tickets.get(t.id)!.status, "new");
  await cmd(office, "tickets.assign", { id: t.id, agentId: "ada" });
  await office.dispatcher.drain();
  assert.equal(office.tickets.get(t.id)!.status, "done");
  assert.equal(office.tickets.get(t.id)!.usage.runs, 1);
});

test("when the Manager is unsure it asks you, and your answer lets it decide", async () => {
  const { office } = await world();
  const t = office.tickets.create({ projectId: "p", title: "Fix the thing", description: "[ask:Which repo?] [scenario:read]", createdBy: "user" });
  await office.dispatcher.drain();
  let cur = office.tickets.get(t.id)!;
  assert.equal(cur.status, "waiting_user");
  assert.equal(cur.question, "Which repo?");
  assert.equal(office.tickets.counts().waitingForYou, 1);
  await cmd(office, "tickets.reply", { id: t.id, text: "The app repo. [to:ada]" });
  assert.equal(office.tickets.get(t.id)!.status, "new");
  await office.dispatcher.drain();
  cur = office.tickets.get(t.id)!;
  assert.equal(cur.status, "done", JSON.stringify(cur.events));
  assert.deepEqual(kinds(office, t.id), ["created", "triage_started", "asked_user", "user_replied", "triage_started", "assigned", "started", "finished"]);
});

test("a Manager that neither assigns nor asks never leaves the ticket in limbo, and never guesses", async () => {
  const { office } = await world();
  const t = office.tickets.create({ projectId: "p", title: "x", description: "[silent]", createdBy: "user" });
  await office.dispatcher.drain();
  const cur = office.tickets.get(t.id)!;
  assert.equal(cur.status, "waiting_user");
  assert.match(cur.question!, /could not decide/);
  assert.equal(cur.assigneeId, undefined);
});

test("the Manager cannot assign to a missing agent, to an agent in another project, or to itself", async () => {
  const { office } = await world();
  for (const to of ["ghost", "zed", "manager-p"]) {
    const t = office.tickets.create({ projectId: "p", title: "x", description: `[to:${to}]`, createdBy: "user" });
    await office.dispatcher.drain();
    const cur = office.tickets.get(t.id)!;
    assert.equal(cur.status, "waiting_user", `${to}: ${JSON.stringify(cur.events)}`);
    assert.equal(cur.assigneeId, undefined);
  }
});

test("a risky action pauses the ticket for your approval, and it carries on after your answer", async () => {
  for (const approve of [true, false]) {
    const { office } = await world();
    const t = office.tickets.create({ projectId: "p", title: "Merge it", description: "[scenario:approval]", createdBy: "user", assigneeId: "ada" });
    await office.dispatcher.drain();
    assert.equal(office.tickets.get(t.id)!.status, "waiting_approval");
    assert.equal(office.agents.get("ada")!.status, "idle", "the agent is free to take other work while it waits for you");
    const pending = office.approvals.pending();
    assert.equal(pending.length, 1);
    await office.resolveApproval(pending[0]!.id, approve, "dev1");
    await office.dispatcher.drain();
    const cur = office.tickets.get(t.id)!;
    assert.equal(cur.status, "done", JSON.stringify(cur.events));
    assert.ok(kinds(office, t.id).includes("approval_requested") && kinds(office, t.id).includes("approval_resolved"));
    assert.match(cur.events.find((e) => e.kind === "approval_resolved")!.text!, approve ? /approved/ : /not approved/);
    assert.equal(cur.usage.runs, 2, "both halves of the run are counted");
  }
});

test("one run per agent at a time: two tickets for the same agent run one after the other", async () => {
  const { office } = await world({ maxParallel: 4 });
  const a = office.tickets.create({ projectId: "p", title: "a", description: "[scenario:read]", createdBy: "user", assigneeId: "ada" });
  const b = office.tickets.create({ projectId: "p", title: "b", description: "[scenario:read]", createdBy: "user", assigneeId: "ada" });
  office.dispatcher.tick();
  assert.equal(office.agents.get("ada")!.status, "working");
  assert.equal([a, b].filter((x) => office.tickets.get(x.id)!.status === "progress").length, 1, "only one of them started");
  await office.dispatcher.drain();
  assert.deepEqual([a, b].map((x) => office.tickets.get(x.id)!.status), ["done", "done"]);
});

test("a usage limit puts the agent to rest and the ticket back in the queue, to be tried again when it is rested", async () => {
  let clock = Date.now();
  const { office } = await world({ now: () => clock });
  const t = office.tickets.create({ projectId: "p", title: "x", description: "[scenario:ratelimit_result]", createdBy: "user", assigneeId: "ada" });
  await office.dispatcher.drain();
  assert.equal(office.tickets.get(t.id)!.status, "assigned");
  assert.equal(office.agents.get("ada")!.status, "asleep");
  await office.dispatcher.drain();
  assert.equal(kinds(office, t.id).filter((k) => k === "rate_limited").length, 1, "not retried while resting");
  clock = office.agents.get("ada")!.sleepUntil! + 1000;
  await office.dispatcher.drain();
  assert.equal(kinds(office, t.id).filter((k) => k === "rate_limited").length, 2, "tried again once rested");
});

test("after a restart nothing is silently re-run: a half-done ticket asks you, triage simply starts over", async () => {
  const w = await world();
  const half = w.office.tickets.create({ projectId: "p", title: "half", description: "[scenario:read]", createdBy: "user", assigneeId: "ada" });
  const triage = w.office.tickets.create({ projectId: "p", title: "triage", description: "[to:ada]", createdBy: "user" });
  w.office.tickets.update(half.id, { status: "progress" });
  w.office.tickets.update(triage.id, { status: "planning" });
  await w.office.close();
  const again = (await world({}, w)).office;
  assert.equal(again.tickets.get(half.id)!.status, "waiting_user");
  assert.match(again.tickets.get(half.id)!.question!, /restarted/);
  assert.equal(again.tickets.get(triage.id)!.status, "new");
  await cmd(again, "tickets.reply", { id: half.id, text: "yes, run it again" });
  assert.equal(again.tickets.get(half.id)!.status, "assigned", "the same agent runs it again");
});

test("cancelling stops a run that is in progress, and the ticket stays cancelled", async () => {
  const { office } = await world();
  const t = office.tickets.create({ projectId: "p", title: "x", description: "[scenario:hang]", createdBy: "user", assigneeId: "ada" });
  office.dispatcher.tick();
  for (let i = 0; i < 100 && office.tickets.get(t.id)!.status !== "progress"; i++) await new Promise((r) => setTimeout(r, 20));
  await cmd(office, "tickets.cancel", { id: t.id });
  await office.dispatcher.drain();
  assert.equal(office.tickets.get(t.id)!.status, "cancelled");
  assert.equal(office.agents.get("ada")!.status, "idle");
  await assert.rejects(cmd(office, "tickets.cancel", { id: t.id }), /already finished/);
});

test("commands reject bad input, other projects' agents, and busy tickets", async () => {
  const { office } = await world();
  await assert.rejects(cmd(office, "tickets.create", { projectId: "nope", title: "x" }), /unknown project/);
  await assert.rejects(cmd(office, "tickets.create", { projectId: "p", title: "" }));
  await assert.rejects(cmd(office, "tickets.create", { projectId: "p", title: "x".repeat(201) }));
  await assert.rejects(cmd(office, "tickets.create", { projectId: "p", title: "x", assigneeId: "zed" }), /not in this project/);
  await assert.rejects(cmd(office, "tickets.get", { id: "../etc" }));
  await assert.rejects(cmd(office, "tickets.get", { id: "T-999" }), /unknown ticket/);
  const t = await cmd(office, "tickets.create", { projectId: "p", title: "ok", assigneeId: "ada", description: "[scenario:hang]" });
  office.tickets.update(t.id, { status: "progress" });
  await assert.rejects(cmd(office, "tickets.assign", { id: t.id, agentId: "quinn" }), /being worked on/);
  await assert.rejects(cmd(office, "tickets.assign", { id: office.tickets.create({ projectId: "p", title: "y", createdBy: "user" }).id, agentId: "manager-p" }), /hands tickets out/);
  office.tickets.update(t.id, { status: "cancelled" });
});

test("team commands: add a project and an agent, list the team, add a Manager. A new agent has no tools", async () => {
  const { office } = await world();
  await cmd(office, "projects.add", { id: "web", name: "Website" });
  await assert.rejects(cmd(office, "projects.add", { id: "web", name: "again" }), /already exists/);
  await cmd(office, "agents.add", { id: "sam", name: "Sam", role: "Marketer", projectId: "web", skills: "copywriting, seo" });
  await assert.rejects(cmd(office, "agents.add", { id: "sam", name: "Sam", role: "x", projectId: "web" }), /already exists/);
  await assert.rejects(cmd(office, "agents.add", { id: "Bad Id!", name: "x", role: "x", projectId: "web" }));
  await assert.rejects(cmd(office, "agents.add", { id: "lee", name: "Lee", role: "x", projectId: "ghost" }), /unknown project/);
  assert.equal(office.gateway.listTools("sam").length, 0);
  await cmd(office, "team.ensureManager", { projectId: "web" });
  await cmd(office, "team.ensureManager", { projectId: "web" });
  const team = await cmd(office, "team.list", { projectId: "web" });
  assert.deepEqual(team.agents.map((a: any) => a.id).sort(), ["manager-web", "sam"]);
  assert.equal(team.agents.find((a: any) => a.id === "sam").skills, "copywriting, seo");
});

test("the cloud only ever hears counts, never ticket text", async () => {
  const { office } = await world();
  office.tickets.create({ projectId: "p", title: "Rotate the production database password", description: "details", createdBy: "user" });
  const snap = JSON.stringify(office.statusSnapshot());
  assert.ok(!snap.includes("password") && !snap.includes("details"));
  assert.deepEqual(office.statusSnapshot().tickets, { open: 1, working: 0, waitingForYou: 0 });
});

test("tickets survive a restart", async () => {
  const w = await world();
  const t = w.office.tickets.create({ projectId: "p", title: "keep me", createdBy: "user" });
  await w.office.close();
  const again = (await world({}, w)).office;
  assert.equal(again.tickets.get(t.id)!.title, "keep me");
  assert.equal(again.tickets.create({ projectId: "p", title: "next", createdBy: "user" }).id, "T-2");
});

test("subtickets and 'after' links stay inside one project, and a parent's usage includes its subtickets", async () => {
  const { office } = await world();
  const parent = office.tickets.create({ projectId: "p", title: "Parent", createdBy: "user" });
  const kid = office.tickets.create({ projectId: "p", title: "Kid", createdBy: "user", parentId: parent.id });
  const other = office.tickets.create({ projectId: "q", title: "Elsewhere", createdBy: "user" });
  assert.throws(() => office.tickets.create({ projectId: "p", title: "x", createdBy: "user", parentId: other.id }), /not a ticket in this project/);
  assert.throws(() => office.tickets.create({ projectId: "p", title: "x", createdBy: "user", afterId: "T-999" }), /not a ticket in this project/);
  office.tickets.addUsage(parent.id, "ada", { tokens: 100, costUsd: 0.01 });
  office.tickets.addUsage(kid.id, "quinn", { tokens: 50, costUsd: 0.005 });
  assert.equal(office.tickets.rolledUp(parent.id).tokens, 150);
  assert.equal(office.tickets.get(parent.id)!.usage.tokens, 100, "its own usage is unchanged");
  const got = await cmd(office, "tickets.get", { id: parent.id });
  assert.equal(got.subtickets.length, 1);
  assert.equal(got.rolledUp.tokens, 150);
});

test("a ticket that comes 'after' another waits until it is done", async () => {
  const { office } = await world();
  const a = office.tickets.create({ projectId: "p", title: "First", createdBy: "user" });
  const b = office.tickets.create({ projectId: "p", title: "Second", description: "[scenario:read]", createdBy: "user", assigneeId: "ada", afterId: a.id });
  office.dispatcher.tick();
  await office.dispatcher.drain();
  assert.equal(office.tickets.get(b.id)!.status, "assigned", "still waiting for the first");
  assert.equal(office.tickets.blockedBy(office.tickets.get(b.id)!)?.id, a.id);
  office.tickets.update(a.id, { status: "done" });
  await office.dispatcher.drain();
  assert.equal(office.tickets.get(b.id)!.status, "done");
});

test("if the ticket it waits for fails, it asks you, and goes on without the link when you say so", async () => {
  const { office } = await world();
  const a = office.tickets.create({ projectId: "p", title: "First", createdBy: "user" });
  const b = office.tickets.create({ projectId: "p", title: "Second", description: "[scenario:read]", createdBy: "user", assigneeId: "ada", afterId: a.id });
  office.tickets.update(a.id, { status: "failed" });
  await office.dispatcher.drain();
  const asked = office.tickets.get(b.id)!;
  assert.equal(asked.status, "waiting_user");
  assert.equal(kinds(office, b.id).at(-1), "blocked");
  await cmd(office, "tickets.reply", { id: b.id, text: "go on without it" });
  assert.equal(office.tickets.get(b.id)!.afterId, undefined);
  assert.equal(office.tickets.get(b.id)!.assigneeId, "ada", "it stays with the same agent");
  await office.dispatcher.drain();
  assert.equal(office.tickets.get(b.id)!.status, "done");
});

test("a ticket that reaches its token budget stops and asks, and a yes gives it more room", async () => {
  const { office } = await world();
  const t = office.tickets.create({ projectId: "p", title: "Costly", description: "[scenario:read]", createdBy: "user", assigneeId: "ada", budgetTokens: 100 });
  office.tickets.addUsage(t.id, "ada", { tokens: 120 });
  await office.dispatcher.drain();
  const stopped = office.tickets.get(t.id)!;
  assert.equal(stopped.status, "waiting_user");
  assert.equal(kinds(office, t.id).at(-1), "limit_reached");
  assert.match(stopped.question!, /budget/);
  assert.equal(office.agents.get("ada")!.tokensToday, 0, "no run was started");

  await cmd(office, "tickets.reply", { id: t.id, text: "yes, continue" });
  assert.ok(office.tickets.get(t.id)!.budgetTokens! > 120, "the budget grew past what was used");
  await office.dispatcher.drain();
  assert.equal(office.tickets.get(t.id)!.status, "done");
});

test("the budget counts a ticket's subtickets, and the round limit counts every run", async () => {
  const { office } = await world();
  const parent = office.tickets.create({ projectId: "p", title: "Big", description: "[scenario:read]", createdBy: "user", assigneeId: "ada", budgetTokens: 100 });
  const kid = office.tickets.create({ projectId: "p", title: "Part", createdBy: "user", parentId: parent.id });
  office.tickets.addUsage(kid.id, "quinn", { tokens: 150 });
  await office.dispatcher.drain();
  assert.equal(office.tickets.get(parent.id)!.status, "waiting_user", "the subticket's tokens counted");

  const r = office.tickets.create({ projectId: "p", title: "Many rounds", description: "[scenario:read]", createdBy: "user", assigneeId: "ada", maxRounds: 2 });
  office.tickets.addUsage(r.id, "ada", {});
  office.tickets.addUsage(r.id, "ada", {});
  await office.dispatcher.drain();
  assert.match(office.tickets.get(r.id)!.question!, /2 rounds/);
});

test("limits are validated, and tickets saved before limits existed get the default", async () => {
  const { office } = await world();
  await assert.rejects(cmd(office, "tickets.create", { projectId: "p", title: "x", budgetTokens: 5 }));
  await assert.rejects(cmd(office, "tickets.create", { projectId: "p", title: "x", maxRounds: 0 }));
  await assert.rejects(cmd(office, "tickets.create", { projectId: "p", title: "x", parentId: "T-999" }));
  const ok = await cmd(office, "tickets.create", { projectId: "p", title: "x", budgetTokens: 50_000, maxRounds: 3 });
  assert.equal(ok.maxRounds, 3);
  assert.equal(ok.budgetTokens, 50_000);
});

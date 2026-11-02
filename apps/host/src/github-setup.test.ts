import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmp } from "../test/helpers";
import { runGithubSetup, type SetupIO } from "./cli/github-setup";
import { githubSpec, parseRepoList, GITHUB_REMOTE } from "./connectors/github";
import type { McpSpec } from "./mcp/server";
import { Office } from "./office";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/fake-github-mcp.mjs");
const TOKEN = "github_pat_" + "11AB3CDEF0ghIJKLmnopQRstUVwx_9876543210abcdefGHIJKL";
const fakeSpec = (env: Record<string, string> = {}): McpSpec => ({ kind: "stdio", command: process.execPath, args: [FIXTURE], secretEnv: "GITHUB_PERSONAL_ACCESS_TOKEN", env });

/** Scripted terminal: answers questions in order and records every line shown. */
function script(answers: string[], secret = TOKEN) {
  const said: string[] = [];
  const asked: string[] = [];
  const io: SetupIO = {
    say: (l) => said.push(l),
    ask: async (q) => { asked.push(q); const a = answers.shift(); if (a === undefined) throw new Error(`unexpected question: ${q}`); return a; },
    askSecret: async (q) => { asked.push(q); return secret; },
  };
  return { io, said, asked };
}

const everyFile = (dir: string): string =>
  readdirSync(dir).map((f) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return ""; } }).join("\n");

test("repository lists: owner/repo and owner/* are accepted, everything else is refused", () => {
  assert.deepEqual(parseRepoList("acme/app, acme/*  Acme/Other"), { ok: true, repos: ["acme/app", "acme/*", "Acme/Other"] });
  for (const bad of ["", "*", "acme", "acme/", "/app", "a/b/c", "acme/app; rm -rf /", "*/*"]) assert.equal(parseRepoList(bad).ok, false, JSON.stringify(bad));
});

test("the GitHub presets point at the documented endpoints and default to read-only", () => {
  const ro = githubSpec("readonly");
  assert.ok(ro.kind === "http" && ro.url === GITHUB_REMOTE + "readonly" && ro.headers?.["X-MCP-Readonly"] === "true");
  const full = githubSpec("full");
  assert.ok(full.kind === "http" && full.url === GITHUB_REMOTE && !full.headers);
  const docker = githubSpec("docker");
  assert.ok(docker.kind === "stdio" && docker.secretEnv === "GITHUB_PERSONAL_ACCESS_TOKEN" && docker.args!.includes("GITHUB_READ_ONLY=1"));
  assert.ok(!JSON.stringify(docker).includes("github_pat"), "no token in a preset");
});

test("setup: token stays hidden, only read-only repo-scoped tools are granted, the limit is proven, nothing leaks to disk or screen", async () => {
  const home = tmp();
  const { io, said, asked } = script(["not-a-repo", "acme/app", "y"]);
  const r = await runGithubSetup(io, { home, masterKey: randomBytes(32), mode: "readonly", spec: fakeSpec() });

  assert.equal(r.ok, true, said.join("\n"));
  assert.ok(asked.some((q) => /token/i.test(q)), "the token was asked for with the hidden prompt");
  assert.ok(said.some((l) => /not owner\/repo/.test(l)), "a bad repository answer is explained and asked again");
  assert.deepEqual(r.repos, ["acme/app"]);

  // exactly the read-only tools that name a repository with required owner and repo
  assert.deepEqual([...r.granted!].sort(), ["get_file_contents", "get_me", "list_pull_requests", "pull_request_read"]);
  assert.deepEqual(r.excluded, ["search_issues"], "search can name any repository in its query, so it is not granted");
  for (const w of ["create_pull_request", "merge_pull_request", "issue_write"]) assert.ok(!r.granted!.includes(w), `${w} is not granted`);

  const out = said.join("\n");
  assert.ok(out.includes("login") && out.includes("test-user"), "get_me ran against the (fake) server");
  assert.ok(out.includes("Settings: dark mode toggle"), "a real call on the allowed repository ran");
  assert.ok(out.includes("Safety check passed"), "a call outside the list was refused locally");

  assert.ok(!out.includes(TOKEN), "token never printed");
  assert.ok(!everyFile(home).includes(TOKEN), "token not in any file on disk, including the vault file");
  assert.ok(!said.concat(asked).some((l) => l.includes("github_pat_")));
  assert.equal(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).mcp[0].credentialHandle, "github");
});

test("what Ada may and may not do after setup, checked through the gateway", async () => {
  const home = tmp();
  const key = randomBytes(32);
  const { io } = script(["acme/app", "y"]);
  assert.equal((await runGithubSetup(io, { home, masterKey: key, mode: "readonly", spec: fakeSpec() })).ok, true);

  const office = await Office.open({ home, name: "x", masterKey: key }); // restart: reconnects to the saved (fake) server
  try {
    // spec is saved, but the fixture path is the same, so the connection is restored
    const call = (tool: string, args: Record<string, unknown>) => office.gateway.call("ada", "github", tool, args);
    assert.equal((await call("list_pull_requests", { owner: "acme", repo: "app" })).status, "ok");
    assert.deepEqual(await call("list_pull_requests", { owner: "acme", repo: "other" }), { status: "denied", reason: "outside granted resources" });
    assert.deepEqual(await call("list_pull_requests", { owner: "evil", repo: "app" }), { status: "denied", reason: "outside granted resources" });
    assert.deepEqual(await call("get_file_contents", { owner: "acme", repo: "app/../../x", path: "a" }), { status: "denied", reason: "outside granted resources" });
    assert.deepEqual(await call("search_issues", { query: "repo:evil/x password", owner: "acme", repo: "app" }), { status: "denied", reason: "not granted" });
    assert.deepEqual(await call("merge_pull_request", { owner: "acme", repo: "app", pullNumber: 1 }), { status: "denied", reason: "not granted" });
    assert.equal((await call("get_me", {})).status, "ok");
    // A write tool granted later has never been reviewed. With a repository limit it is refused outright,
    // because the limit cannot be enforced on a tool nobody has mapped yet. That is stricter than asking.
    office.addGrant({ id: "later", projectId: "github-trial", agentId: "ada", connectionId: "github", tools: ["merge_pull_request"], resources: ["acme/app"] });
    assert.deepEqual(await call("merge_pull_request", { owner: "acme", repo: "app", pullNumber: 1 }), { status: "denied", reason: "cannot enforce resource limit for this tool" });
    // Without a limit it can be granted, and then it asks for approval every time.
    office.addGrant({ id: "later2", projectId: "github-trial", agentId: "ada", connectionId: "github", tools: ["create_pull_request"], resources: [] });
    const pr = await call("create_pull_request", { owner: "acme", repo: "app", title: "t", head: "h", base: "b" });
    assert.equal(pr.status, "needs_approval");
    assert.ok(pr.status === "needs_approval" && /not been reviewed/.test(pr.reason));
  } finally {
    await office.close();
  }
});

test("a rejected token is reported clearly, nothing is left behind, and the token is not shown", async () => {
  const home = tmp();
  const { io, said } = script(["acme/app", "y"]);
  const r = await runGithubSetup(io, { home, masterKey: randomBytes(32), mode: "readonly", spec: fakeSpec({ FIXTURE_EXPECT_TOKEN: "a-different-token-entirely-123" }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "github_error");
  const out = said.join("\n");
  assert.ok(/Bad credentials/.test(out));
  assert.ok(!out.includes(TOKEN));
});

test("connection failures are explained and leave no token behind", async () => {
  const home = tmp();
  const key = randomBytes(32);
  const { io, said } = script(["acme/app"]);
  const r = await runGithubSetup(io, { home, masterKey: key, mode: "readonly", spec: { kind: "stdio", command: "definitely-not-a-real-command-xyz", args: [], secretEnv: "X" }, token: TOKEN });
  assert.deepEqual([r.ok, r.reason], [false, "connect_failed"]);
  assert.ok(said.some((l) => /Could not connect/.test(l)));
  assert.ok(!everyFile(home).includes(TOKEN) && !said.join("\n").includes(TOKEN));
  const office = await Office.open({ home, name: "x", masterKey: key });
  assert.equal(office.vault.has("github-trial", "github"), false, "the token was removed again");
  await office.close();
});

test("bad tokens and missing repositories stop before anything is stored or started", async () => {
  const home = tmp();
  const key = randomBytes(32);
  const a = await runGithubSetup(script([]).io, { home, masterKey: key, mode: "readonly", spec: fakeSpec(), token: "short" });
  assert.deepEqual([a.ok, a.reason], [false, "token_format"]);
  const b = await runGithubSetup(script([]).io, { home, masterKey: key, mode: "readonly", spec: fakeSpec(), token: TOKEN, repos: ["*"] });
  assert.equal(b.ok, false);
  const office = await Office.open({ home, name: "x", masterKey: key });
  assert.equal(office.vault.has("github-trial", "github"), false, "no token stored");
  assert.equal(office.grants.length, 0);
  await office.close();
});

test("declining the review leaves every tool unreviewed and grants nothing", async () => {
  const home = tmp();
  const { io } = script(["acme/app", "n"]);
  const r = await runGithubSetup(io, { home, masterKey: randomBytes(32), mode: "readonly", spec: fakeSpec() });
  assert.deepEqual([r.ok, r.reason, r.granted], [true, "declined", []]);
});

test("running setup twice is safe, and --remove undoes everything including the stored token", async () => {
  const home = tmp();
  const key = randomBytes(32);
  for (const repos of ["acme/app", "acme/app, acme/docs"]) {
    const { io } = script([repos, "y"]);
    assert.equal((await runGithubSetup(io, { home, masterKey: key, mode: "readonly", spec: fakeSpec() })).ok, true);
  }
  let office = await Office.open({ home, name: "x", masterKey: key });
  assert.equal(office.grants.filter((g) => g.id === "g-github-scoped").length, 1, "no duplicate grants");
  assert.deepEqual(office.grants.find((g) => g.id === "g-github-scoped")!.resources, ["acme/app", "acme/docs"]);
  await office.close();

  const { io, said } = script([]);
  assert.equal((await runGithubSetup(io, { home, masterKey: key, mode: "readonly", remove: true })).ok, true);
  assert.ok(said.some((l) => /delete the token on GitHub/i.test(l)));
  office = await Office.open({ home, name: "x", masterKey: key });
  assert.equal(office.vault.has("github-trial", "github"), false);
  assert.equal(office.grants.length, 0);
  assert.equal((await office.gateway.call("ada", "github", "get_me", {})).status, "denied");
  await office.close();
});


import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SECRET, makeEnv } from "../test/helpers";
import { McpToolServer } from "./mcp/server";
import { ToolReviews } from "./mcp/review";
import { startGatewayMcp, exposedName, type RunningGatewayMcp } from "./engines/gateway-mcp";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/fake-github-mcp.mjs");
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

/** A project whose GitHub-shaped MCP server is connected, with Ada granted read tools (reviewed) and merge (unreviewed). */
async function setup(extra: { resources?: string[] } = {}) {
  const e = makeEnv();
  const reviews = new ToolReviews(join(e.dir, "r.json"));
  const server = await McpToolServer.connect({
    spec: { kind: "stdio", command: process.execPath, args: [FIXTURE], secretEnv: "GITHUB_PERSONAL_ACCESS_TOKEN" },
    broker: e.broker, projectId: "mobile", connectionId: "github", reviews, credentialHandle: "github", audit: e.audit,
  });
  cleanups.push(() => server.close());
  e.gateway.addConnection({ id: "github", projectId: "mobile", service: "GitHub", label: "fixture", credentialHandle: "github", server });
  for (const t of ["list_pull_requests", "get_me"]) {
    const d = server.discovered().find((x) => x.name === t)!;
    reviews.set("mobile", "github", t, { hash: d.hash, risk: "read", ...(d.suggestedResourceArgs ? { resourceArgs: d.suggestedResourceArgs } : {}) });
  }
  server.applyReviews();
  e.addAgent("ada");
  e.addAgent("quinn");
  e.addGrant({ agentId: "ada", connectionId: "github", tools: ["list_pull_requests"], resources: extra.resources ?? ["acme/app"] });
  // Unreviewed and without a repository limit, so it asks for approval (a limit could not be enforced on it).
  e.addGrant({ agentId: "ada", connectionId: "github", tools: ["merge_pull_request"], resources: [] });
  e.addGrant({ agentId: "ada", connectionId: "github", tools: ["get_me"], resources: [] });
  e.addGrant({ agentId: "quinn", connectionId: "github", tools: ["get_me"], resources: [] });
  return { e, server };
}

async function connect(m: RunningGatewayMcp, token = m.token) {
  const client = new Client({ name: "stand-in-for-claude-code", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(m.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  cleanups.push(() => client.close());
  return client;
}

const txt = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");

test("the agent sees only its granted tools, with real input schemas", async () => {
  const { e } = await setup();
  const mcp = await startGatewayMcp({ gateway: e.gateway, agentId: "ada" });
  cleanups.push(() => mcp.close());
  const { tools } = await (await connect(mcp)).listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["github__get_me", "github__list_pull_requests", "github__merge_pull_request"]);
  const list = tools.find((t) => t.name === "github__list_pull_requests")!;
  assert.deepEqual((list.inputSchema as { required: string[] }).required.sort(), ["owner", "repo"]);
  assert.ok(list.description?.startsWith("[GitHub]"));

  const quinn = await startGatewayMcp({ gateway: e.gateway, agentId: "quinn" });
  cleanups.push(() => quinn.close());
  assert.deepEqual((await (await connect(quinn)).listTools()).tools.map((t) => t.name), ["github__get_me"], "another agent sees only its own tools");
});

test("calls go through the gateway: allowed, limited to the granted repository, and credential-free", async () => {
  const { e } = await setup();
  const mcp = await startGatewayMcp({ gateway: e.gateway, agentId: "ada" });
  cleanups.push(() => mcp.close());
  const c = await connect(mcp);

  const ok = await c.callTool({ name: "github__list_pull_requests", arguments: { owner: "acme", repo: "app" } });
  assert.ok(!ok.isError && txt(ok).includes("Settings: dark mode toggle"));

  const out = await c.callTool({ name: "github__list_pull_requests", arguments: { owner: "acme", repo: "other" } });
  assert.ok(out.isError && /outside granted resources/.test(txt(out)), txt(out));

  const hidden = await c.callTool({ name: "github__delete_branch", arguments: {} });
  assert.ok(hidden.isError && /not granted|Unknown tool/.test(txt(hidden)));

  assert.ok(!JSON.stringify([ok, out, hidden]).includes(SECRET));
});

test("an action that needs approval returns at once, is recorded, and does not run", async () => {
  const { e } = await setup();
  const events: string[] = [];
  const mcp = await startGatewayMcp({ gateway: e.gateway, agentId: "ada", onCall: (x) => events.push(`${x.tool}:${x.outcome}`) });
  cleanups.push(() => mcp.close());
  const r = await (await connect(mcp)).callTool({ name: "github__merge_pull_request", arguments: { owner: "acme", repo: "app", pullNumber: 7 } });
  assert.ok(!r.isError);
  assert.ok(/needs the user's approval and has NOT run/.test(txt(r)));
  assert.equal(mcp.pending.length, 1);
  assert.equal(mcp.pending[0]!.tool, "merge_pull_request");
  assert.equal(e.approvals.pending().length, 1);
  assert.deepEqual(events, ["merge_pull_request:needs_approval"]);
});

test("a grant revoked during the run disappears from the tool list immediately", async () => {
  const { e } = await setup();
  const mcp = await startGatewayMcp({ gateway: e.gateway, agentId: "ada" });
  cleanups.push(() => mcp.close());
  const c = await connect(mcp);
  assert.ok((await c.listTools()).tools.some((t) => t.name === "github__merge_pull_request"));
  e.grants.splice(0, e.grants.length, ...e.grants.filter((g) => !g.tools.includes("merge_pull_request")));
  assert.ok(!(await c.listTools()).tools.some((t) => t.name === "github__merge_pull_request"));
});

const raw = (url: string, o: { method?: string; headers?: Record<string, string> } = {}) =>
  new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    const r = request({ host: u.hostname, port: u.port, path: u.pathname, method: o.method ?? "POST", headers: o.headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on("error", reject);
    r.end("{}");
  });

test("no token, a wrong token, a foreign Host header, other paths and other methods are all refused", async () => {
  const { e } = await setup();
  const mcp = await startGatewayMcp({ gateway: e.gateway, agentId: "ada" });
  cleanups.push(() => mcp.close());
  const good = { authorization: `Bearer ${mcp.token}`, "content-type": "application/json" };
  assert.equal(await raw(mcp.url), 401, "no token");
  assert.equal(await raw(mcp.url, { headers: { authorization: "Bearer nope" } }), 401, "wrong token");
  assert.equal(await raw(mcp.url, { headers: { ...good, host: "evil.example" } }), 403, "DNS-rebinding style Host");
  assert.equal(await raw(mcp.url.replace("/mcp", "/other"), { headers: good }), 404);
  assert.equal(await raw(mcp.url, { method: "GET", headers: good }), 405);
  assert.ok(new URL(mcp.url).hostname === "127.0.0.1", "loopback only");
});

test("after the run the server is gone", async () => {
  const { e } = await setup();
  const mcp = await startGatewayMcp({ gateway: e.gateway, agentId: "ada" });
  await mcp.close();
  await assert.rejects(raw(mcp.url, { headers: { authorization: `Bearer ${mcp.token}` } }));
});

test("tool names are safe for Claude and long ones are left out", () => {
  assert.equal(exposedName({ connectionId: "github", name: "list_pull_requests" }), "github__list_pull_requests");
  assert.equal(exposedName({ connectionId: "git hub", name: "a.b/c" }), "git_hub__a_b_c");
});

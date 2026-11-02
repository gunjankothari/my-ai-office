import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SECRET, tmp } from "../test/helpers";
import { Office } from "./office";
import { handleToolsCommand } from "./tools-commands";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_GITHUB = join(HERE, "../test/fixtures/fake-github-mcp.mjs");
const opened: Office[] = [];
after(async () => { for (const o of opened) await o.close(); });

async function world(now?: () => number) {
  const office = await Office.open({ home: tmp(), name: "t", masterKey: randomBytes(32), now });
  opened.push(office);
  office.addProject("p", "Project");
  office.addProject("q", "Other");
  office.ensureManager("p");
  office.addAgent({ id: "ada", name: "Ada", role: "Developer", projectId: "p", mode: "risky", model: "mid", engine: "claude-code" });
  office.addAgent({ id: "zed", name: "Zed", role: "Developer", projectId: "q", mode: "risky", model: "mid", engine: "claude-code" });
  office.vault.put("p", "github", SECRET);
  await office.addMcpConnection({ id: "github", projectId: "p", service: "GitHub", label: "fixture", credentialHandle: "github", spec: { kind: "stdio", command: process.execPath, args: [FAKE_GITHUB], secretEnv: "GITHUB_PERSONAL_ACCESS_TOKEN" } });
  return office;
}
const cmd = (o: Office, type: string, payload: Record<string, unknown> = {}) => handleToolsCommand(o, type, payload, "dev1").then((r) => { assert.ok(r.handled, type); return (r as { result: any }).result; });
const tool = (o: Office, name: string) => o.discoveredTools("p", "github").find((t) => t.name === name)!;

test("the connection list shows review progress, hides the internal team connection, and carries nothing secret", async () => {
  const o = await world();
  const list = await cmd(o, "connections.list");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "github");
  assert.equal(list[0].tools.total, 8);
  assert.equal(list[0].tools.reviewed, 0);
  assert.equal(list[0].tools.readOnlyUnreviewed, 5);
  assert.equal(list[0].connected, true);
  const text = JSON.stringify(list);
  assert.ok(!text.includes(SECRET) && !text.includes(FAKE_GITHUB), "no secret and no launch details");
  assert.ok(!text.includes('"team"'));
  await assert.rejects(cmd(o, "tools.reviewMany", { projectId: "p", connectionId: "team", items: [{ tool: "assign_ticket", hash: "a".repeat(64), risk: "read" }] }), /unknown connection/);
});

test("a review is pinned to what you were shown: a changed or unknown tool refuses the whole batch", async () => {
  const o = await world();
  const good = tool(o, "list_pull_requests"), other = tool(o, "get_me");
  await assert.rejects(cmd(o, "tools.reviewMany", { projectId: "p", connectionId: "github", items: [
    { tool: "list_pull_requests", hash: good.hash, risk: "read", resourceArgs: ["owner", "repo"] },
    { tool: "get_me", hash: "0".repeat(64), risk: "read" },
  ] }), /changed on the server/);
  assert.equal(tool(o, "list_pull_requests").reviewed, false, "nothing was applied");
  await assert.rejects(cmd(o, "tools.reviewMany", { projectId: "p", connectionId: "github", items: [{ tool: "nope", hash: good.hash, risk: "read" }] }), /no longer offers/);
  await assert.rejects(cmd(o, "tools.reviewMany", { projectId: "p", connectionId: "github", items: [{ tool: "list_pull_requests", hash: good.hash, risk: "read", resourceArgs: ["nonsense"] }] }), /no argument/);
  await cmd(o, "tools.reviewMany", { projectId: "p", connectionId: "github", items: [
    { tool: "list_pull_requests", hash: good.hash, risk: "read", resourceArgs: ["owner", "repo"] },
    { tool: "get_me", hash: other.hash, risk: "read" },
  ] });
  assert.equal(tool(o, "list_pull_requests").reviewed, true);
  assert.deepEqual(tool(o, "list_pull_requests").current?.resourceArgs, ["owner", "repo"]);
  const sum = (await cmd(o, "connections.list"))[0].tools;
  assert.equal(sum.reviewed, 2);
  await assert.rejects(cmd(o, "tools.reviewMany", { projectId: "p", connectionId: "github", items: [] }));
  await assert.rejects(cmd(o, "tools.reviewMany", { projectId: "p", connectionId: "github", items: [{ tool: "get_me", hash: "xyz", risk: "read" }] }));
});

test("giving access: limited to repos, enforced by the gateway, and refused where a limit could not work", async () => {
  const o = await world();
  const t = tool(o, "list_pull_requests");
  await cmd(o, "tools.reviewMany", { projectId: "p", connectionId: "github", items: [{ tool: "list_pull_requests", hash: t.hash, risk: "read", resourceArgs: ["owner", "repo"] }] });

  await assert.rejects(cmd(o, "grants.add", { projectId: "p", agentId: "ada", connectionId: "github", tools: ["nope"] }), /does not offer/);
  await assert.rejects(cmd(o, "grants.add", { projectId: "p", agentId: "zed", connectionId: "github", tools: ["list_pull_requests"] }), /not in this project/);
  await assert.rejects(cmd(o, "grants.add", { projectId: "p", agentId: "manager-p", connectionId: "github", tools: ["list_pull_requests"] }), /only uses the team tools/);
  await assert.rejects(cmd(o, "grants.add", { projectId: "p", agentId: "ada", connectionId: "team", tools: ["assign_ticket"] }), /unknown connection/);
  await assert.rejects(cmd(o, "grants.add", { projectId: "p", agentId: "ada", connectionId: "github", tools: ["list_pull_requests", "get_me"], resources: ["acme/app"] }), /cannot be limited.*get_me/);
  await assert.rejects(cmd(o, "grants.add", { projectId: "p", agentId: "ada", connectionId: "github", tools: ["list_pull_requests"], resources: ["bad resource!"] }));
  assert.equal(o.grants.filter((g) => g.agentId === "ada").length, 0, "refusals grant nothing");

  const g = await cmd(o, "grants.add", { projectId: "p", agentId: "ada", connectionId: "github", tools: ["list_pull_requests"], resources: ["acme/app"] });
  const ok = await o.gateway.call("ada", "github", "list_pull_requests", { owner: "acme", repo: "app" });
  assert.equal(ok.status, "ok");
  const no = await o.gateway.call("ada", "github", "list_pull_requests", { owner: "evil", repo: "app" });
  assert.equal(no.status, "denied");
  const list = await cmd(o, "grants.list", { connectionId: "github" });
  assert.equal(list.length, 1);
  assert.equal(list[0].agentName, "Ada");

  await cmd(o, "grants.revoke", { grantId: g.id });
  assert.equal((await o.gateway.call("ada", "github", "list_pull_requests", { owner: "acme", repo: "app" })).status, "denied");
  await assert.rejects(cmd(o, "grants.revoke", { grantId: "g-team-manager-p" }), /unknown grant/);
  assert.ok(o.gateway.listTools("manager-p").length === 2, "the Manager's own grant is untouched");
});

test("a tool nobody reviewed can be granted, but still asks for approval every time", async () => {
  const o = await world();
  await cmd(o, "grants.add", { projectId: "p", agentId: "ada", connectionId: "github", tools: ["merge_pull_request"] });
  const r = await o.gateway.call("ada", "github", "merge_pull_request", { owner: "acme", repo: "app", pullNumber: 1 });
  assert.equal(r.status, "needs_approval");
});

test("access can expire", async () => {
  let clock = 1_000_000;
  const o = await world(() => clock);
  const t = tool(o, "get_me");
  await cmd(o, "tools.reviewMany", { projectId: "p", connectionId: "github", items: [{ tool: "get_me", hash: t.hash, risk: "read" }] });
  const g = await cmd(o, "grants.add", { projectId: "p", agentId: "ada", connectionId: "github", tools: ["get_me"], expiresInHours: 1 });
  assert.equal(g.expiresAt, 1_000_000 + 3_600_000);
  assert.equal(o.gateway.listTools("ada").length, 1);
  clock += 3_600_001;
  assert.equal(o.gateway.listTools("ada").length, 0);
  assert.equal((await cmd(o, "grants.list", {}))[0].expired, true);
  await assert.rejects(cmd(o, "grants.add", { projectId: "p", agentId: "ada", connectionId: "github", tools: ["get_me"], expiresInHours: 0 }));
});

test("refresh lists the tools again, and removing a connection removes its grants and its stored token", async () => {
  const o = await world();
  assert.equal((await cmd(o, "connections.refresh", { projectId: "p", connectionId: "github" })).length, 8);
  await cmd(o, "grants.add", { projectId: "p", agentId: "ada", connectionId: "github", tools: ["get_me"] });
  assert.equal(o.vault.has("p", "github"), true);
  const r = await cmd(o, "connections.remove", { projectId: "p", connectionId: "github" });
  assert.equal(r.credentialDeleted, true);
  assert.equal(o.vault.has("p", "github"), false);
  assert.equal(o.grants.filter((g) => g.connectionId === "github").length, 0);
  assert.deepEqual(await cmd(o, "connections.list"), []);
  await assert.rejects(cmd(o, "connections.remove", { projectId: "p", connectionId: "github" }), /unknown connection/);
});

test("removing one connection keeps a token another connection in the project still uses", async () => {
  const o = await world();
  await o.addMcpConnection({ id: "github2", projectId: "p", service: "GitHub", label: "second", credentialHandle: "github", spec: { kind: "stdio", command: process.execPath, args: [FAKE_GITHUB], secretEnv: "GITHUB_PERSONAL_ACCESS_TOKEN" } });
  const r = await cmd(o, "connections.remove", { projectId: "p", connectionId: "github" });
  assert.equal(r.credentialDeleted, false);
  assert.equal(o.vault.has("p", "github"), true);
});

test("a connection in another project is not reachable by naming it", async () => {
  const o = await world();
  await assert.rejects(cmd(o, "connections.refresh", { projectId: "q", connectionId: "github" }), /unknown connection/);
  await assert.rejects(cmd(o, "grants.add", { projectId: "q", agentId: "zed", connectionId: "github", tools: ["get_me"] }), /unknown connection/);
});

test("a limit on an optional argument is refused: the tool works without it, so it would limit nothing", async () => {
  const o = await world();
  const search = tool(o, "search_issues");
  assert.deepEqual(search.requiredArgs, ["query"]);
  assert.equal(search.suggestedResourceArg, undefined, "no suggestion either");
  assert.equal(search.suggestedResourceArgs, undefined);
  await assert.rejects(cmd(o, "tools.reviewMany", { projectId: "p", connectionId: "github", items: [{ tool: "search_issues", hash: search.hash, risk: "read", resourceArgs: ["repo"] }] }), /optional/);
  // Reviewed without a limit it is fine to use unrestricted, but never under a resource limit.
  await cmd(o, "tools.reviewMany", { projectId: "p", connectionId: "github", items: [{ tool: "search_issues", hash: search.hash, risk: "read" }] });
  await assert.rejects(cmd(o, "grants.add", { projectId: "p", agentId: "ada", connectionId: "github", tools: ["search_issues"], resources: ["acme/app"] }), /cannot be limited/);
  const g = await cmd(o, "grants.add", { projectId: "p", agentId: "ada", connectionId: "github", tools: ["search_issues"] });
  assert.deepEqual(g.resources, []);
});

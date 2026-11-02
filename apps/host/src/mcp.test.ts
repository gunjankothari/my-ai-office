import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { generateKeyPair, signerFromExported, signCommand, verifyObject, type CommandReplyBody } from "@agent-office/shared";
import { SECRET, makeEnv, tmp } from "../test/helpers";
import { McpToolServer, flattenContent, type McpSpec } from "./mcp/server";
import { SAFE_TOOL_NAME, ToolReviews, shortDescription } from "./mcp/review";
import { Office } from "./office";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/fake-mcp-server.mjs");
const stdio = (env: Record<string, string> = {}): McpSpec => ({ kind: "stdio", command: process.execPath, args: [FIXTURE], secretEnv: "GITHUB_TOKEN", env });

const closers: (() => Promise<void> | void)[] = [];
after(async () => { for (const c of closers.reverse()) await c(); });

/** A project with a vault credential, the gateway, and one granted agent, wired to the fixture MCP server. */
async function setup(opts: { env?: Record<string, string>; timeoutMs?: number; maxOutputChars?: number; tools?: string[]; resources?: string[]; mode?: "every" | "risky" | "dry" } = {}) {
  const e = makeEnv({ maxOutputChars: opts.maxOutputChars });
  const reviews = new ToolReviews(join(e.dir, "tool-reviews.json"));
  const server = await McpToolServer.connect({
    spec: stdio(opts.env), broker: e.broker, projectId: "mobile", connectionId: "mcp", reviews, credentialHandle: "github", audit: e.audit, timeoutMs: opts.timeoutMs,
  });
  closers.push(() => server.close());
  e.gateway.addConnection({ id: "mcp", projectId: "mobile", service: "GitHub", label: "fixture", credentialHandle: "github", server });
  e.addAgent("ada", "mobile", opts.mode ?? "risky");
  e.addGrant({
    agentId: "ada", connectionId: "mcp", resources: opts.resources ?? [],
    tools: opts.tools ?? ["list_pull_requests", "comment_on_pull_request", "delete_branch", "sync_repo", "whoami", "leaky", "fails", "big", "image", "slow", "crash", "noisy"],
  });
  const review = (tool: string, risk: "read" | "write" | "destructive", extra: { outbound?: boolean; resourceArg?: string } = {}) => {
    const d = server.discovered().find((t) => t.name === tool)!;
    reviews.set("mobile", "mcp", tool, { hash: d.hash, risk, ...extra });
    server.applyReviews();
  };
  return { e, server, reviews, review };
}

test("the credential reaches the server process, but the host's own environment does not", async () => {
  process.env.LEAK_CANARY = "host-only-value-that-must-not-leak";
  try {
    const { server } = await setup();
    const seen = JSON.parse((await server.call("whoami", {})) as string);
    assert.equal(seen.TOKEN, SECRET, "credential injected from the vault");
    assert.equal(seen.LEAK_CANARY, null, "host environment variables are not inherited");
    assert.equal(seen.HAS_PATH, true, "the safe default environment still applies");
  } finally {
    delete process.env.LEAK_CANARY;
  }
});

test("discovered tools start unreviewed; server hints are only suggestions and can only make things stricter", async () => {
  const { server } = await setup();
  const by = Object.fromEntries(server.discovered().map((t) => [t.name, t]));
  assert.equal(by.list_pull_requests!.suggestedRisk, "read");
  assert.equal(by.list_pull_requests!.reviewed, false);
  assert.equal(by.list_pull_requests!.suggestedResourceArg, "repo");
  assert.equal(by.sync_repo!.suggestedRisk, "write", "no hint means write, not read");
  const defs = Object.fromEntries(server.tools().map((t) => [t.name, t]));
  assert.ok(server.tools().every((t) => t.unreviewed), "everything is unreviewed at first");
  assert.equal(defs.list_pull_requests!.risk, "write", "a read-only claim is not believed before review");
  assert.equal(defs.delete_branch!.risk, "destructive", "a destructive claim is believed immediately");
});

test("an unreviewed tool asks for approval even when the server says it is read-only; after review it runs", async () => {
  const { e, review } = await setup();
  const first = await e.gateway.call("ada", "mcp", "list_pull_requests", { repo: "mobile-app" });
  assert.equal(first.status, "needs_approval");
  assert.ok(first.status === "needs_approval" && /not been reviewed/.test(first.reason));

  review("list_pull_requests", "read", { resourceArg: "repo" });
  const second = await e.gateway.call("ada", "mcp", "list_pull_requests", { repo: "mobile-app" });
  assert.equal(second.status, "ok");
  assert.ok(second.status === "ok" && second.output.includes("Dark mode toggle"));
});

test("a changed tool definition puts a reviewed tool back to unreviewed and is audited", async () => {
  const e = makeEnv();
  const reviews = new ToolReviews(join(e.dir, "r.json"));
  const connect = (env?: Record<string, string>) =>
    McpToolServer.connect({ spec: stdio(env), broker: e.broker, projectId: "mobile", connectionId: "mcp", reviews, credentialHandle: "github", audit: e.audit });

  const v1 = await connect();
  for (const t of v1.discovered().filter((x) => ["list_pull_requests", "sync_repo"].includes(x.name))) reviews.set("mobile", "mcp", t.name, { hash: t.hash, risk: "read" });
  v1.applyReviews();
  assert.deepEqual(v1.tools().filter((t) => !t.unreviewed).map((t) => t.name).sort(), ["list_pull_requests", "sync_repo"]);
  await v1.close();

  const v2 = await connect({ FIXTURE_VARIANT: "v2" });
  closers.push(() => v2.close());
  const by = Object.fromEntries(v2.discovered().map((t) => [t.name, t]));
  assert.equal(by.list_pull_requests!.reviewed, false);
  assert.equal(by.list_pull_requests!.changed, true, "flagged as changed, not just new");
  assert.equal(by.sync_repo!.reviewed, true, "unchanged tools stay reviewed");
  const audit = readFileSync(join(e.dir, "audit.jsonl"), "utf8");
  assert.ok(audit.includes("mcp.tool_changed") && audit.includes("list_pull_requests"));
});

test("the model sees one short clean line per tool, never the server's full text", async () => {
  const { e } = await setup();
  const noisy = e.gateway.listTools("ada").find((t) => t.name === "noisy")!;
  assert.ok(noisy.description.length <= 160);
  assert.ok(!/[\n\u0007]/.test(noisy.description));
  assert.equal(shortDescription("a\n\n b\t c"), "a b c");
  assert.equal(shortDescription(undefined), "");
});

test("tool names with odd characters are not accepted", () => {
  for (const ok of ["list_pull_requests", "a.b-c", "X1"]) assert.ok(SAFE_TOOL_NAME.test(ok), ok);
  for (const bad of ["", "has space", "new\nline", "a".repeat(101), "ünï", "../x"]) assert.ok(!SAFE_TOOL_NAME.test(bad), JSON.stringify(bad));
});

test("a credential in tool output or in an error message never reaches the agent", async () => {
  const { e, review } = await setup();
  review("leaky", "read");
  review("fails", "read");
  const out = await e.gateway.call("ada", "mcp", "leaky", {});
  assert.ok(out.status === "ok" && !out.output.includes(SECRET) && out.output.includes("[hidden]"));
  const err = await e.gateway.call("ada", "mcp", "fails", {});
  assert.equal(err.status, "error");
  assert.ok(err.status === "error" && !err.message.includes(SECRET));
});

test("images are named not inlined, and large output is truncated", async () => {
  const { e, review } = await setup({ maxOutputChars: 400 });
  review("image", "read");
  review("big", "read");
  const img = await e.gateway.call("ada", "mcp", "image", {});
  assert.ok(img.status === "ok" && img.output.includes("chart attached") && img.output.includes("[image omitted, image/png]") && !img.output.includes("iVBOR"));
  const big = await e.gateway.call("ada", "mcp", "big", {});
  assert.ok(big.status === "ok" && big.truncated && big.output.length < 500);
  assert.equal(flattenContent({ content: [], structuredContent: { a: 1 } }), '{"a":1}');
});

test("resource limits work on MCP tools once the review maps the resource argument", async () => {
  const { e, review } = await setup({ resources: ["mobile-app"], tools: ["list_pull_requests", "sync_repo"] });
  review("list_pull_requests", "read", { resourceArg: "repo" });
  review("sync_repo", "write"); // reviewed, but no resource argument mapped
  assert.equal((await e.gateway.call("ada", "mcp", "list_pull_requests", { repo: "mobile-app" })).status, "ok");
  assert.deepEqual(await e.gateway.call("ada", "mcp", "list_pull_requests", { repo: "billing" }), { status: "denied", reason: "outside granted resources" });
  const unmapped = await e.gateway.call("ada", "mcp", "sync_repo", { repo: "mobile-app" });
  assert.deepEqual(unmapped, { status: "denied", reason: "cannot enforce resource limit for this tool" }, "fails closed");
});

test("dry-run mode never executes an unreviewed tool", async () => {
  const { e } = await setup({ mode: "dry" });
  const r = await e.gateway.call("ada", "mcp", "sync_repo", { repo: "x" });
  assert.equal(r.status, "dry_run");
});

test("a slow tool is stopped by the timeout and reported as an error", async () => {
  const { e, review } = await setup({ timeoutMs: 400 });
  review("slow", "read");
  const r = await e.gateway.call("ada", "mcp", "slow", {});
  assert.equal(r.status, "error");
});

test("if the server process dies, the next call reconnects and the credential is injected again", async () => {
  const { e, review } = await setup({ timeoutMs: 5000 });
  review("crash", "read");
  review("whoami", "read");
  await e.gateway.call("ada", "mcp", "crash", {});
  await new Promise((r) => setTimeout(r, 300));
  const again = await e.gateway.call("ada", "mcp", "whoami", {});
  assert.ok(again.status === "ok", JSON.stringify(again));
  assert.equal(JSON.parse(again.status === "ok" ? again.output : "{}").HAS_PATH, true);
});

test("HTTP servers get the credential in a header; wrong credentials fail; cleartext remote URLs are refused", async () => {
  const e = makeEnv();
  const reviews = new ToolReviews(join(e.dir, "r.json"));
  const seenAuth: (string | undefined)[] = [];
  const http: Server = createServer(async (req, res) => {
    seenAuth.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${SECRET}`) { res.writeHead(401).end(); return; }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const mcp = new McpServer({ name: "http-fake", version: "1.0.0" });
    mcp.registerTool("ping", { description: "Ping.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: "text", text: "pong" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString() || "null"));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => { http.closeAllConnections(); http.close(() => r()); }));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;

  const server = await McpToolServer.connect({ spec: { kind: "http", url }, broker: e.broker, projectId: "mobile", connectionId: "h", reviews, credentialHandle: "github" });
  closers.push(() => server.close());
  assert.deepEqual(server.tools().map((t) => t.name), ["ping"]);
  assert.equal(await server.call("ping", {}), "pong");
  assert.ok(seenAuth.length > 0 && seenAuth.every((a) => a === `Bearer ${SECRET}`), "every request carried the credential");

  e.vault.put("mobile", "wrong", "not-the-right-token-123456");
  await assert.rejects(McpToolServer.connect({ spec: { kind: "http", url }, broker: e.broker, projectId: "mobile", connectionId: "h2", reviews, credentialHandle: "wrong", timeoutMs: 3000 }));

  await assert.rejects(McpToolServer.connect({ spec: { kind: "http", url: "http://mcp.example.com/mcp" }, broker: e.broker, projectId: "mobile", connectionId: "h3", reviews, credentialHandle: "github" }), /must use https/);
});

test("Office: connections persist, reviews are validated, risky review changes are audited, and a restart reconnects", async () => {
  const home = tmp();
  const masterKey = randomBytes(32);
  const office = await Office.open({ home, name: "Test", masterKey });
  closers.push(() => office.close());
  office.addProject("mobile", "Mobile");
  office.vault.put("mobile", "github", SECRET);
  office.addAgent({ id: "ada", name: "Ada", role: "Developer", projectId: "mobile", mode: "risky", model: "mid" });

  const found = await office.addMcpConnection({ id: "gh", projectId: "mobile", service: "GitHub", label: "fixture", credentialHandle: "github", spec: stdio() });
  assert.ok(found.length >= 10 && found.every((t) => !t.reviewed));
  await assert.rejects(office.addMcpConnection({ id: "x", projectId: "mobile", service: "S", label: "l", credentialHandle: "missing", spec: stdio() }), /no credential/);

  assert.throws(() => office.reviewTool("mobile", "gh", "list_pull_requests", { risk: "read", resourceArg: "nonexistent" }), /no argument/);
  assert.throws(() => office.reviewTool("mobile", "gh", "no_such_tool", { risk: "read" }), /unknown tool/);
  office.reviewTool("mobile", "gh", "list_pull_requests", { risk: "read", resourceArg: "repo" });
  office.addGrant({ id: "g1", projectId: "mobile", agentId: "ada", connectionId: "gh", tools: ["list_pull_requests"], resources: ["mobile-app"] });
  assert.equal((await office.gateway.call("ada", "gh", "list_pull_requests", { repo: "mobile-app" })).status, "ok");
  await office.close();

  // restart: same home and key, no re-adding anything
  const again = await Office.open({ home, name: "Test", masterKey });
  closers.push(() => again.close());
  assert.equal((await again.gateway.call("ada", "gh", "list_pull_requests", { repo: "mobile-app" })).status, "ok", "connection, grant and review all survived");
  assert.equal(again.discoveredTools("mobile", "gh").find((t) => t.name === "list_pull_requests")?.reviewed, true);
  assert.ok(!readFileSync(join(home, "state.json"), "utf8").includes(SECRET), "no secret in saved state");

  await again.removeMcpConnection("mobile", "gh");
  assert.equal(again.grants.length, 0, "removing a connection removes its grants");
  assert.equal((await again.gateway.call("ada", "gh", "list_pull_requests", { repo: "mobile-app" })).status, "denied");
});

test("review decisions can be made from a paired device with a signed command", async () => {
  const office = await Office.open({ home: tmp(), name: "Test", masterKey: randomBytes(32) });
  closers.push(() => office.close());
  office.officeId = "off1";
  office.addProject("mobile", "Mobile");
  office.vault.put("mobile", "github", SECRET);
  await office.addMcpConnection({ id: "gh", projectId: "mobile", service: "GitHub", label: "fixture", credentialHandle: "github", spec: stdio() });

  const kp = await generateKeyPair();
  const signer = await signerFromExported(kp);
  office.trust.add({ deviceId: "phone", name: "Phone", publicKey: kp.publicKey, addedAt: Date.now() });
  const send = async (type: string, payload: Record<string, unknown>) => {
    const env = (await office.handleRelay(await signCommand(signer, "phone", "off1", { type, payload }))) as { body: CommandReplyBody; sig: string };
    assert.equal(await verifyObject(office.publicKey, env), true);
    return env.body;
  };

  const list = await send("tools.discovered", { projectId: "mobile", connectionId: "gh" });
  assert.equal(list.ok, true);
  assert.ok((list.result as { name: string }[]).some((t) => t.name === "delete_branch"));
  assert.equal((await send("tools.review", { projectId: "mobile", connectionId: "gh", tool: "list_pull_requests", risk: "read", resourceArg: "repo" })).ok, true);
  assert.equal(office.discoveredTools("mobile", "gh").find((t) => t.name === "list_pull_requests")?.reviewed, true);
  const bad = await send("tools.review", { projectId: "mobile", connectionId: "gh", tool: "list_pull_requests", risk: "banana" });
  assert.equal(bad.ok, false);
});

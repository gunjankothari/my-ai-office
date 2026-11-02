import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SECRET, makeEnv } from "../test/helpers";
import { AuditLog } from "./audit";

test("a granted read call runs, the credential is injected, the model-facing output is clean", async () => {
  const e = makeEnv();
  e.addAgent("ada");
  e.addGrant({ agentId: "ada", tools: ["list_pull_requests"], resources: ["mobile-app"] });
  const r = await e.gateway.call("ada", "gh", "list_pull_requests", { repo: "mobile-app" });
  assert.equal(r.status, "ok");
  assert.equal(e.server.calls[0]?.secret, SECRET, "the server received the real credential");
  assert.ok(JSON.stringify(r).includes("Dark mode"));
});

test("a tool that leaks its credential in its output is scrubbed", async () => {
  const e = makeEnv();
  e.addAgent("ada");
  e.addGrant({ agentId: "ada", tools: ["leaky_debug"] });
  const r = await e.gateway.call("ada", "gh", "leaky_debug", {});
  assert.equal(r.status, "ok");
  assert.ok(r.status === "ok" && !r.output.includes(SECRET));
  assert.ok(r.status === "ok" && r.output.includes("[hidden]"));
});

test("errors that contain the credential are scrubbed too", async () => {
  const e = makeEnv();
  e.addAgent("ada");
  e.addGrant({ agentId: "ada", tools: ["list_pull_requests"] });
  e.gateway.removeConnection("mobile", "gh");
  e.gateway.addConnection({
    id: "gh", projectId: "mobile", service: "GitHub", label: "x", credentialHandle: "github",
    server: { tools: () => [{ name: "list_pull_requests", description: "", risk: "read" }], call: async (_t, _a, auth) => { throw new Error(`401 for token ${auth.secret}`); } },
  });
  const r = await e.gateway.call("ada", "gh", "list_pull_requests", {});
  assert.equal(r.status, "error");
  assert.ok(r.status === "error" && !r.message.includes(SECRET));
});

test("ungranted tools are denied and are not listed to the model", async () => {
  const e = makeEnv();
  e.addAgent("quinn");
  e.addGrant({ agentId: "quinn", tools: ["list_pull_requests"] });
  assert.deepEqual(e.gateway.listTools("quinn").map((t) => t.name), ["list_pull_requests"]);
  const r = await e.gateway.call("quinn", "gh", "delete_branch", { repo: "mobile-app" });
  assert.deepEqual(r, { status: "denied", reason: "not granted" });
  assert.equal(e.server.calls.length, 0);
});

test("an agent in another project cannot use this project's connection", async () => {
  const e = makeEnv();
  e.addAgent("spy", "site");
  e.addGrant({ agentId: "spy", projectId: "site", tools: ["list_pull_requests"] });
  const r = await e.gateway.call("spy", "gh", "list_pull_requests", { repo: "x" });
  assert.deepEqual(r, { status: "denied", reason: "unknown connection" });
  // even a forged grant that names the other project's connection id does not help
  e.addGrant({ agentId: "spy", projectId: "mobile", tools: ["list_pull_requests"] });
  const r2 = await e.gateway.call("spy", "gh", "list_pull_requests", { repo: "x" });
  assert.equal(r2.status, "denied");
  assert.equal(e.server.calls.length, 0);
});

test("grant expiry and resource limits are enforced", async () => {
  let t = 1_000_000;
  const e = makeEnv({ now: () => t });
  e.addAgent("ada");
  e.addGrant({ agentId: "ada", tools: ["list_pull_requests"], resources: ["mobile-app"], expiresAt: t + 1000 });
  assert.equal((await e.gateway.call("ada", "gh", "list_pull_requests", { repo: "billing" })).status, "denied");
  assert.equal((await e.gateway.call("ada", "gh", "list_pull_requests", { repo: "mobile-app" })).status, "ok");
  t += 2000;
  assert.equal((await e.gateway.call("ada", "gh", "list_pull_requests", { repo: "mobile-app" })).status, "denied");
  assert.deepEqual(e.gateway.listTools("ada"), []);
});

test("destructive calls wait for approval, then run only if approved", async () => {
  const e = makeEnv();
  e.addAgent("ada");
  e.addGrant({ agentId: "ada", tools: ["delete_branch"] });
  const r = await e.gateway.call("ada", "gh", "delete_branch", { repo: "mobile-app", branch: "old" });
  assert.equal(r.status, "needs_approval");
  assert.equal(e.server.calls.length, 0, "nothing ran yet");
  const id = r.status === "needs_approval" ? r.approvalId : "";
  assert.equal(e.approvals.pending().length, 1);
  const ok = await e.gateway.resolveApproval(id, true, "dev1");
  assert.equal(ok.status, "ok");
  assert.equal(e.server.calls.length, 1);
  assert.equal((await e.gateway.resolveApproval(id, true, "dev1")).status, "denied", "cannot approve twice");
});

test("a denied approval never runs the tool", async () => {
  const e = makeEnv();
  e.addAgent("ada");
  e.addGrant({ agentId: "ada", tools: ["delete_branch"] });
  const r = await e.gateway.call("ada", "gh", "delete_branch", { repo: "mobile-app" });
  const id = r.status === "needs_approval" ? r.approvalId : "";
  assert.equal((await e.gateway.resolveApproval(id, false, "dev1")).status, "denied");
  assert.equal(e.server.calls.length, 0);
});

test("approvals expire, and a grant revoked while waiting still blocks the call", async () => {
  let t = 1_000_000;
  const e = makeEnv({ now: () => t, ttlMs: 60_000 });
  e.addAgent("ada");
  e.addGrant({ agentId: "ada", tools: ["delete_branch"] });
  const r1 = await e.gateway.call("ada", "gh", "delete_branch", { repo: "a" });
  t += 120_000;
  assert.deepEqual(await e.gateway.resolveApproval(r1.status === "needs_approval" ? r1.approvalId : "", true, "dev1"), { status: "denied", reason: "approval expired" });

  const r2 = await e.gateway.call("ada", "gh", "delete_branch", { repo: "a" });
  e.grants.length = 0; // revoked
  const res = await e.gateway.resolveApproval(r2.status === "needs_approval" ? r2.approvalId : "", true, "dev1");
  assert.equal(res.status, "denied");
  assert.equal(e.server.calls.length, 0);
});

test("modes: outbound asks in risky mode, dry mode runs nothing that writes", async () => {
  const e = makeEnv();
  e.addAgent("mina", "mobile", "risky");
  e.addAgent("dry", "mobile", "dry");
  for (const id of ["mina", "dry"]) e.addGrant({ agentId: id, tools: ["send_message", "comment_on_pull_request", "list_pull_requests"] });
  assert.equal((await e.gateway.call("mina", "gh", "send_message", { channel: "#x", text: "hi" })).status, "needs_approval");
  assert.equal((await e.gateway.call("mina", "gh", "comment_on_pull_request", { repo: "r" })).status, "ok");
  const dry = await e.gateway.call("dry", "gh", "comment_on_pull_request", { repo: "r" });
  assert.equal(dry.status, "dry_run");
  assert.equal((await e.gateway.call("dry", "gh", "list_pull_requests", { repo: "r" })).status, "ok");
  assert.deepEqual(e.server.calls.map((c) => c.tool), ["comment_on_pull_request", "list_pull_requests"]);
});

test("long output is truncated before it can flood the model's context", async () => {
  const e = makeEnv({ maxOutputChars: 500 });
  e.addAgent("ada");
  e.addGrant({ agentId: "ada", tools: ["whoami"] });
  const r = await e.gateway.call("ada", "gh", "whoami", {});
  assert.ok(r.status === "ok" && r.truncated && r.output.length < 600);
});

test("the audit log records every decision, has no secrets, and detects tampering", async () => {
  const e = makeEnv();
  e.addAgent("ada");
  e.addGrant({ agentId: "ada", tools: ["list_pull_requests", "leaky_debug"] });
  await e.gateway.call("ada", "gh", "list_pull_requests", { repo: "r" });
  await e.gateway.call("ada", "gh", "leaky_debug", {});
  await e.gateway.call("ada", "gh", "delete_branch", { repo: "r" });
  const file = join(e.dir, "audit.jsonl");
  const raw = readFileSync(file, "utf8");
  assert.ok(!raw.includes(SECRET));
  assert.deepEqual(e.audit.verify(), { ok: true, count: 3 });
  assert.deepEqual(new AuditLog(file).verify(), { ok: true, count: 3 }, "chain survives a restart");

  const lines = raw.trim().split("\n");
  lines[1] = lines[1]!.replace('"outcome":"ok"', '"outcome":"denied"');
  writeFileSync(file, lines.join("\n") + "\n");
  assert.deepEqual(new AuditLog(file).verify(), { ok: false, brokenAt: 2 });
});

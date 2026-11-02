import { test } from "node:test";
import assert from "node:assert/strict";
import type { Grant, ToolDef } from "@agent-office/shared";
import { decide } from "./policy";

const read: ToolDef = { name: "r", description: "", risk: "read", resourceArg: "repo" };
const write: ToolDef = { name: "w", description: "", risk: "write", resourceArg: "repo" };
const send: ToolDef = { name: "s", description: "", risk: "write", outbound: true, resourceArg: "repo" };
const del: ToolDef = { name: "d", description: "", risk: "destructive", resourceArg: "repo" };
const noRes: ToolDef = { name: "n", description: "", risk: "read" };

const grant = (tools: string[], extra: Partial<Grant> = {}): Grant => ({
  id: "g", projectId: "p", agentId: "a", connectionId: "c", tools, resources: [], ...extra,
});
const base = { args: { repo: "mobile-app" }, now: 1000 };

test("no grant or tool not in grant is denied", () => {
  assert.equal(decide({ ...base, tool: read, grant: undefined, mode: "risky" }).action, "deny");
  assert.equal(decide({ ...base, tool: read, grant: grant(["other"]), mode: "risky" }).action, "deny");
  assert.equal(decide({ ...base, tool: undefined, grant: grant(["r"]), mode: "risky" }).action, "deny");
});

test("expired grant is denied", () => {
  assert.equal(decide({ ...base, tool: read, grant: grant(["r"], { expiresAt: 1000 }), mode: "risky" }).action, "deny");
  assert.equal(decide({ ...base, tool: read, grant: grant(["r"], { expiresAt: 1001 }), mode: "risky" }).action, "allow");
});

test("resource limits: exact, prefix, missing arg, and unenforceable all fail closed", () => {
  const g = grant(["r", "n"], { resources: ["mobile-app", "docs-*"] });
  assert.equal(decide({ ...base, tool: read, grant: g, mode: "risky" }).action, "allow");
  assert.equal(decide({ ...base, tool: read, grant: g, mode: "risky", args: { repo: "docs-site" } }).action, "allow");
  assert.equal(decide({ ...base, tool: read, grant: g, mode: "risky", args: { repo: "billing" } }).action, "deny");
  assert.equal(decide({ ...base, tool: read, grant: g, mode: "risky", args: {} }).action, "deny");
  assert.equal(decide({ ...base, tool: read, grant: g, mode: "risky", args: { repo: ["mobile-app"] } }).action, "deny");
  assert.equal(decide({ ...base, tool: noRes, grant: g, mode: "risky" }).action, "deny", "limit cannot be enforced on this tool");
});

test("an unreviewed tool always asks, even if it claims to be read-only; dry mode never runs it", () => {
  const unreviewed: ToolDef = { ...read, unreviewed: true };
  const g = grant(["r"]);
  assert.equal(decide({ ...base, tool: unreviewed, grant: g, mode: "risky" }).action, "ask");
  assert.equal(decide({ ...base, tool: unreviewed, grant: g, mode: "every" }).action, "ask");
  assert.equal(decide({ ...base, tool: unreviewed, grant: g, mode: "dry" }).action, "dry");
  // grants and resource limits still come first
  assert.equal(decide({ ...base, tool: unreviewed, grant: undefined, mode: "risky" }).action, "deny");
  assert.equal(decide({ ...base, tool: unreviewed, grant: grant(["r"], { resources: ["other"] }), mode: "risky" }).action, "deny");
});

test("composite resources: owner and repo are checked together", () => {
  const gh: ToolDef = { name: "g", description: "", risk: "read", resourceArgs: ["owner", "repo"] };
  const g = (resources: string[]) => grant(["g"], { resources });
  const run = (resources: string[], args: Record<string, unknown>) => decide({ now: 1000, tool: gh, grant: g(resources), mode: "risky", args }).action;
  assert.equal(run(["acme/app"], { owner: "acme", repo: "app" }), "allow");
  assert.equal(run(["acme/*"], { owner: "acme", repo: "anything" }), "allow", "owner wildcard");
  assert.equal(run(["acme/app"], { owner: "acme", repo: "other" }), "deny");
  assert.equal(run(["acme/app"], { owner: "evil", repo: "app" }), "deny");
  assert.equal(run(["acme/app"], { owner: "acme" }), "deny", "missing repo");
  assert.equal(run(["acme/app"], { owner: "acme", repo: "" }), "deny", "empty repo");
  assert.equal(run(["acme/app"], { owner: "acme", repo: 5 }), "deny", "wrong type");
  assert.equal(run(["acme/*"], { owner: "acme/other", repo: "x" }), "deny", "a slash inside a part cannot pose as a different resource");
  assert.equal(decide({ now: 1000, tool: gh, grant: grant(["g"]), mode: "risky", args: {} }).action, "allow", "no limit means no check");
});

test("approval modes", () => {
  const g = grant(["r", "w", "s", "d"]);
  const act = (tool: ToolDef, mode: "every" | "risky" | "dry") => decide({ ...base, tool, grant: g, mode }).action;
  assert.deepEqual([read, write, send, del].map((t) => act(t, "risky")), ["allow", "allow", "ask", "ask"]);
  assert.deepEqual([read, write, send, del].map((t) => act(t, "every")), ["ask", "ask", "ask", "ask"]);
  assert.deepEqual([read, write, send, del].map((t) => act(t, "dry")), ["allow", "dry", "dry", "dry"]);
});

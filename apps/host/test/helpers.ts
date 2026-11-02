import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ApprovalMode, Grant, ToolDef } from "@agent-office/shared";
import { Vault } from "../src/vault";
import { CredentialBroker } from "../src/broker";
import { AuditLog } from "../src/audit";
import { ApprovalQueue } from "../src/approvals";
import { ToolGateway, type AgentCtx, type ToolServer } from "../src/gateway";

export const tmp = (): string => mkdtempSync(join(tmpdir(), "agent-office-test-"));

export interface FakeServer extends ToolServer {
  calls: { tool: string; args: Record<string, unknown>; secret: string }[];
}

export const TOOLS: ToolDef[] = [
  { name: "list_pull_requests", description: "List open pull requests.", risk: "read", resourceArg: "repo" },
  { name: "comment_on_pull_request", description: "Add a comment to a pull request.", risk: "write", resourceArg: "repo" },
  { name: "delete_branch", description: "Delete a branch.", risk: "destructive", resourceArg: "repo" },
  { name: "send_message", description: "Post a message to a channel.", risk: "write", outbound: true, resourceArg: "channel" },
  { name: "whoami", description: "Show the connected account.", risk: "read" },
  { name: "leaky_debug", description: "A badly written tool that echoes its credential.", risk: "read" },
];

export function fakeServer(): FakeServer {
  const calls: FakeServer["calls"] = [];
  return {
    calls,
    tools: () => TOOLS,
    async call(tool, args, auth) {
      calls.push({ tool, args, secret: auth.secret });
      if (tool === "leaky_debug") return `Authorization: Bearer ${auth.secret}`;
      if (tool === "list_pull_requests") return [{ n: 1, title: "Dark mode" }];
      if (tool === "whoami") return "x".repeat(10_000);
      return { ok: true };
    },
  };
}

export const SECRET = "ghp_" + "Zk3Qp9Xw2LmN8vB4tY7uR1eC5hJ0aD6sF2gH";

export function makeEnv(opts: { now?: () => number; ttlMs?: number; maxOutputChars?: number } = {}) {
  const dir = tmp();
  const now = opts.now ?? (() => 1_000_000);
  const vault = new Vault(join(dir, "vault.json"), randomBytes(32));
  const broker = new CredentialBroker(vault);
  const audit = new AuditLog(join(dir, "audit.jsonl"), now);
  const approvals = new ApprovalQueue(opts.ttlMs ?? 600_000, now);
  const agents = new Map<string, { projectId: string; mode: ApprovalMode }>();
  const grants: Grant[] = [];
  const agentCtx = (id: string): AgentCtx | undefined => {
    const a = agents.get(id);
    return a ? { agentId: id, projectId: a.projectId, mode: a.mode, grants: grants.filter((g) => g.agentId === id) } : undefined;
  };
  const gateway = new ToolGateway({ broker, audit, approvals, agentCtx, now, maxOutputChars: opts.maxOutputChars });
  const server = fakeServer();

  vault.put("mobile", "github", SECRET);
  gateway.addConnection({ id: "gh", projectId: "mobile", service: "GitHub", label: "acme-mobile", credentialHandle: "github", server });

  const addAgent = (id: string, projectId = "mobile", mode: ApprovalMode = "risky") => agents.set(id, { projectId, mode });
  const addGrant = (g: Partial<Grant> & { agentId: string; tools: string[] }) => {
    grants.push({ id: `g${grants.length}`, projectId: "mobile", connectionId: "gh", resources: [], ...g });
  };
  return { dir, vault, broker, audit, approvals, gateway, server, agents, grants, addAgent, addGrant };
}

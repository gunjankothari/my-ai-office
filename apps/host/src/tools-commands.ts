import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Risk } from "@agent-office/shared";
import type { Office } from "./office";
import { TEAM_CONNECTION } from "./team-tools";

/*
 * Commands behind the tool review screen: which connections exist, what each tool does and how
 * you rated it, and who may use what. Everything arrives through the signed-command path.
 *
 * Rules the screen cannot get around, because they are enforced here:
 *   - a review decision is pinned to the tool definition you were looking at (its hash). If the server
 *     changed it in between, the decision is refused and you look again,
 *   - a grant can only name tools the server really offers, for an agent in the same project,
 *   - a grant with resource limits is refused if any of its tools cannot be limited (it would only ever be denied),
 *   - the Manager gets no outside tools, and the internal "team" connection is not listed or grantable here.
 */

const Id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const ToolName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
const Resource = z.string().regex(/^[A-Za-z0-9_.*@:/-]{1,120}$/, "a resource may use letters, digits and . _ - * @ : /");

const ReviewItem = z.object({
  tool: ToolName,
  /** The hash of the definition you were shown. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  risk: Risk,
  outbound: z.boolean().optional(),
  resourceArgs: z.array(z.string().min(1).max(60)).min(1).max(4).optional(),
});

const connectionOf = (office: Office, projectId: string, connectionId: string) => {
  if (connectionId === TEAM_CONNECTION) throw new Error("unknown connection");
  const c = office.listConnections(projectId).find((x) => x.id === connectionId);
  if (!c) throw new Error("unknown connection");
  return c;
};

const summarize = (office: Office, c: ReturnType<Office["listConnections"]>[number]) => {
  const tools = office.discoveredTools(c.projectId, c.id);
  return {
    ...c,
    tools: {
      total: tools.length,
      reviewed: tools.filter((t) => t.reviewed).length,
      needReview: tools.filter((t) => !t.reviewed && !t.changed).length,
      changed: tools.filter((t) => t.changed).length,
      readOnlyUnreviewed: tools.filter((t) => !t.reviewed && t.suggestedRisk === "read").length,
    },
  };
};

export async function handleToolsCommand(office: Office, type: string, payload: Record<string, unknown>, deviceId: string): Promise<{ handled: false } | { handled: true; result: unknown }> {
  const ok = (result: unknown) => ({ handled: true as const, result });

  switch (type) {
    case "connections.list": {
      const a = z.object({ projectId: Id.optional() }).parse(payload);
      return ok(office.listConnections(a.projectId).filter((c) => c.id !== TEAM_CONNECTION).map((c) => summarize(office, c)));
    }
    case "connections.refresh": {
      const a = z.object({ projectId: Id, connectionId: Id }).parse(payload);
      connectionOf(office, a.projectId, a.connectionId);
      return ok(await office.refreshConnection(a.projectId, a.connectionId));
    }
    case "connections.remove": {
      const a = z.object({ projectId: Id, connectionId: Id }).parse(payload);
      connectionOf(office, a.projectId, a.connectionId);
      const r = await office.removeConnectionAndSecret(a.projectId, a.connectionId);
      office.audit.append({ kind: "connection.removed_by_user", projectId: a.projectId, connectionId: a.connectionId, deviceId, ...r });
      return ok(r);
    }
    case "tools.reviewMany": {
      const a = z.object({ projectId: Id, connectionId: Id, items: z.array(ReviewItem).min(1).max(200) }).parse(payload);
      connectionOf(office, a.projectId, a.connectionId);
      const now = new Map(office.discoveredTools(a.projectId, a.connectionId).map((t) => [t.name, t]));
      // Check everything first, so a bad item cannot leave the review half applied.
      for (const i of a.items) {
        const d = now.get(i.tool);
        if (!d) throw new Error(`the server no longer offers "${i.tool}". Refresh and look again.`);
        if (d.hash !== i.hash) throw new Error(`"${i.tool}" changed on the server since you looked at it. Refresh and read it again before confirming.`);
        for (const arg of i.resourceArgs ?? []) {
          if (!d.args.includes(arg)) throw new Error(`"${i.tool}" has no argument "${arg}"`);
          if (!d.requiredArgs.includes(arg)) throw new Error(`"${arg}" is optional for "${i.tool}", so the tool can work without it and a limit on it would not really limit anything. Leave this tool unlimited, or do not give it to anyone who must be restricted.`);
        }
      }
      for (const i of a.items) office.reviewTool(a.projectId, a.connectionId, i.tool, { risk: i.risk, outbound: i.outbound, resourceArgs: i.resourceArgs });
      return ok({ reviewed: a.items.length });
    }
    case "grants.list": {
      const a = z.object({ projectId: Id.optional(), connectionId: Id.optional() }).parse(payload);
      const now = office.opts.now?.() ?? Date.now();
      return ok(office.grants
        .filter((g) => g.connectionId !== TEAM_CONNECTION && (!a.projectId || g.projectId === a.projectId) && (!a.connectionId || g.connectionId === a.connectionId))
        .map((g) => ({ ...g, agentName: office.agents.get(g.agentId)?.name ?? g.agentId, expired: g.expiresAt !== undefined && now >= g.expiresAt })));
    }
    case "grants.add": {
      const a = z.object({
        projectId: Id, agentId: Id, connectionId: Id, tools: z.array(ToolName).min(1).max(100),
        resources: z.array(Resource).max(20).default([]), expiresInHours: z.number().int().min(1).max(24 * 365).optional(),
      }).parse(payload);
      connectionOf(office, a.projectId, a.connectionId);
      const agent = office.agents.get(a.agentId);
      if (!agent || agent.projectId !== a.projectId) throw new Error("that agent is not in this project");
      if (agent.kind === "manager") throw new Error("the Manager only uses the team tools. Give outside tools to a teammate.");
      const tools = new Map(office.discoveredTools(a.projectId, a.connectionId).map((t) => [t.name, t]));
      for (const t of a.tools) if (!tools.has(t)) throw new Error(`the server does not offer "${t}"`);
      if (a.resources.length > 0) {
        const unlimitable = a.tools.filter((t) => { const c = tools.get(t)!.current; return !c || !(c.resourceArgs?.length || c.resourceArg); });
        if (unlimitable.length) throw new Error(`These tools cannot be limited to specific resources, so a limited grant would only ever be refused: ${unlimitable.join(", ")}. Review them with a "limit by" choice first, or give them without a limit.`);
      }
      const now = office.opts.now?.() ?? Date.now();
      const grant = { id: `g-${randomBytes(5).toString("hex")}`, projectId: a.projectId, agentId: a.agentId, connectionId: a.connectionId, tools: [...new Set(a.tools)], resources: a.resources, ...(a.expiresInHours ? { expiresAt: now + a.expiresInHours * 3_600_000 } : {}) };
      office.addGrant(grant);
      office.audit.append({ kind: "grant.added_by_user", grantId: grant.id, deviceId });
      return ok(grant);
    }
    case "grants.revoke": {
      const a = z.object({ grantId: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/) }).parse(payload);
      const g = office.grants.find((x) => x.id === a.grantId);
      if (!g || g.connectionId === TEAM_CONNECTION) throw new Error("unknown grant");
      office.revokeGrant(a.grantId);
      office.audit.append({ kind: "grant.revoked_by_user", grantId: a.grantId, deviceId });
      return ok({ revoked: a.grantId });
    }
    default:
      return { handled: false };
  }
}

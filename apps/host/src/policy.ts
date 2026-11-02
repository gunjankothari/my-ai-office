import type { ApprovalMode, Grant, ToolDef } from "@agent-office/shared";

export type Decision =
  | { action: "allow" }
  | { action: "ask"; reason: string }
  | { action: "deny"; reason: string }
  | { action: "dry"; reason: string };

export interface PolicyInput {
  tool: ToolDef | undefined;
  grant: Grant | undefined;
  args: Record<string, unknown>;
  mode: ApprovalMode;
  now: number;
}

const matches = (value: string, pattern: string): boolean =>
  pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;

/**
 * Pure decision function. Fails closed: anything not explicitly granted is denied,
 * and a resource limit that cannot be enforced is a denial, not a pass.
 */
export function decide({ tool, grant, args, mode, now }: PolicyInput): Decision {
  if (!tool) return { action: "deny", reason: "unknown tool" };
  if (!grant || !grant.tools.includes(tool.name)) return { action: "deny", reason: "not granted" };
  if (grant.expiresAt !== undefined && now >= grant.expiresAt) return { action: "deny", reason: "grant expired" };

  if (grant.resources.length > 0) {
    const names = tool.resourceArgs ?? (tool.resourceArg ? [tool.resourceArg] : []);
    if (names.length === 0) return { action: "deny", reason: "cannot enforce resource limit for this tool" };
    const parts = names.map((n) => args[n]);
    const bad = names.find((_, i) => typeof parts[i] !== "string" || parts[i] === "");
    if (bad !== undefined) return { action: "deny", reason: `missing ${bad}` };
    const value = (parts as string[]).join("/");
    // "/" is the separator, so a part that contains one could pose as a different resource.
    if ((parts as string[]).some((p) => p.includes("/")) && names.length > 1) return { action: "deny", reason: "outside granted resources" };
    if (!grant.resources.some((r) => matches(value, r))) return { action: "deny", reason: "outside granted resources" };
  }

  // A tool nobody has reviewed is never trusted to run on its own, even if its server says it is read-only.
  if (tool.unreviewed) {
    return mode === "dry"
      ? { action: "dry", reason: "tool has not been reviewed yet" }
      : { action: "ask", reason: "this tool has not been reviewed yet" };
  }
  if (mode === "dry") return tool.risk === "read" ? { action: "allow" } : { action: "dry", reason: "dry-run mode" };
  if (tool.risk === "destructive") return { action: "ask", reason: "destructive actions always need approval" };
  if (mode === "every") return { action: "ask", reason: "approval mode: ask before every action" };
  if (tool.outbound) return { action: "ask", reason: "leaves the machine (message, post or email)" };
  return { action: "allow" };
}

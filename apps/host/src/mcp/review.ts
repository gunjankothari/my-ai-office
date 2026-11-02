import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, type Risk, type ToolDef } from "@agent-office/shared";

/*
 * An MCP server describes its own tools, and that description is text written by whoever
 * runs the server. We never take it at its word:
 *   - the model only sees a short, cleaned one-line description (cheaper, and less room for tricks),
 *   - the server's safety hints (read-only, destructive) are suggestions shown to the user, never grants,
 *   - a tool is "unreviewed" until the user confirms its risk, and again whenever its definition changes
 *     (a pinned hash of name, description, schema and hints), and unreviewed tools always ask for approval.
 */

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface ReviewEntry {
  hash: string;
  risk: Risk;
  outbound?: boolean;
  resourceArg?: string;
  resourceArgs?: string[];
}

export interface DiscoveredTool {
  name: string;
  /** Short and cleaned: this is what the model sees. */
  description: string;
  suggestedRisk: Risk;
  suggestedOutbound: boolean;
  suggestedResourceArg: string | undefined;
  /** Several arguments that together name a resource, such as ["owner", "repo"]. Preferred over suggestedResourceArg when present. */
  suggestedResourceArgs: string[] | undefined;
  /** Argument names, so a UI can offer a drop-down for the resource limit. */
  args: string[];
  /** The arguments the tool cannot be called without. Only these can honestly limit what a tool reaches. */
  requiredArgs: string[];
  hash: string;
  reviewed: boolean;
  /** Was reviewed before, but the server has since changed the definition. */
  changed: boolean;
  current: { risk: Risk; outbound?: boolean; resourceArg?: string; resourceArgs?: string[] } | undefined;
}

export const SAFE_TOOL_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export const toolHash = (t: McpToolInfo): string =>
  createHash("sha256")
    .update(canonicalJson({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? null, annotations: t.annotations ?? null }))
    .digest("hex");

/** One clean line, at most 160 characters. */
export function shortDescription(d: string | undefined): string {
  const clean = (d ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length <= 160 ? clean : clean.slice(0, 159).trimEnd() + "…";
}

/** What the server claims, as a starting point for the user's review. Never applied automatically. */
export function suggestRisk(t: McpToolInfo): Risk {
  if (t.annotations?.destructiveHint === true) return "destructive";
  if (t.annotations?.readOnlyHint === true) return "read";
  return "write";
}

const RESOURCE_NAMES = ["repo", "repository", "repo_name", "channel", "channel_id", "project", "project_key", "project_id", "path", "folder", "calendar", "database", "table"];

export const argNames = (t: McpToolInfo): string[] => {
  const p = (t.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return p ? Object.keys(p) : [];
};

export const requiredArgNames = (t: McpToolInfo): string[] => {
  const required = (t.inputSchema as { required?: unknown } | undefined)?.required;
  return Array.isArray(required) ? required.filter((x): x is string => typeof x === "string") : [];
};

/**
 * A single argument is only suggested as a limit when it is required. If it is optional the tool can
 * work without it (a search whose query names any repository), so a limit on it would look like
 * protection without being any.
 */
export const suggestResourceArg = (t: McpToolInfo): string | undefined => {
  const names = argNames(t), req = requiredArgNames(t);
  return RESOURCE_NAMES.find((n) => names.includes(n) && req.includes(n));
};

/**
 * GitHub-style tools name a repository with two arguments. Only suggested when BOTH are required:
 * a tool where they are optional (a search whose query can name any repository) cannot honestly be
 * limited to one repository by looking at those arguments.
 */
export const suggestResourceArgs = (t: McpToolInfo): string[] | undefined => {
  const names = argNames(t);
  const required = (t.inputSchema as { required?: unknown } | undefined)?.required;
  const req = Array.isArray(required) ? required : [];
  return names.includes("owner") && names.includes("repo") && req.includes("owner") && req.includes("repo") ? ["owner", "repo"] : undefined;
};

/**
 * The tool as the gateway sees it. Without a matching review it is `unreviewed`, and its
 * risk can only be the stricter reading of the server's own hint.
 */
export function toToolDef(t: McpToolInfo, entry: ReviewEntry | undefined): ToolDef {
  const base = { name: t.name, description: shortDescription(t.description) };
  if (entry && entry.hash === toolHash(t)) {
    return {
      ...base, risk: entry.risk,
      ...(entry.outbound ? { outbound: true } : {}),
      ...(entry.resourceArgs ? { resourceArgs: entry.resourceArgs } : entry.resourceArg ? { resourceArg: entry.resourceArg } : {}),
    };
  }
  return { ...base, risk: t.annotations?.destructiveHint === true ? "destructive" : "write", unreviewed: true };
}

export function describe(t: McpToolInfo, entry: ReviewEntry | undefined): DiscoveredTool {
  const hash = toolHash(t);
  const reviewed = Boolean(entry && entry.hash === hash);
  return {
    name: t.name,
    description: shortDescription(t.description),
    suggestedRisk: suggestRisk(t),
    suggestedOutbound: t.annotations?.openWorldHint === true && suggestRisk(t) !== "read",
    suggestedResourceArg: suggestResourceArg(t),
    suggestedResourceArgs: suggestResourceArgs(t),
    args: argNames(t),
    requiredArgs: requiredArgNames(t),
    hash,
    reviewed,
    changed: Boolean(entry && !reviewed),
    current: reviewed && entry ? { risk: entry.risk, outbound: entry.outbound, resourceArg: entry.resourceArg, resourceArgs: entry.resourceArgs } : undefined,
  };
}

type Store = Record<string, Record<string, Record<string, ReviewEntry>>>;

/** The user's decisions, per project and connection, stored on this machine. */
export class ToolReviews {
  private data: Store;

  constructor(private readonly file: string) {
    this.data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Store) : {};
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get(projectId: string, connectionId: string): Record<string, ReviewEntry> {
    return this.data[projectId]?.[connectionId] ?? {};
  }

  set(projectId: string, connectionId: string, tool: string, entry: ReviewEntry): void {
    ((this.data[projectId] ??= {})[connectionId] ??= {})[tool] = entry;
    this.save();
  }

  clear(projectId: string, connectionId: string): void {
    if (this.data[projectId]?.[connectionId]) {
      delete this.data[projectId][connectionId];
      this.save();
    }
  }
}

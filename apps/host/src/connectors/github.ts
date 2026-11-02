import type { McpSpec } from "../mcp/server";

/*
 * How to reach GitHub's own MCP server (github/github-mcp-server). Endpoints, headers and
 * environment variable names come from its documentation. Nothing here has been run against
 * the real service by the author, so treat the first real connection as a test.
 */

export type GithubMode =
  /** GitHub's hosted server, read tools only (path /readonly plus the X-MCP-Readonly header). The default. */
  | "readonly"
  /** GitHub's hosted server with all its tools. Tools other than read-only ones stay unreviewed and ask every time. */
  | "full"
  /** The server in a local Docker container, read-only. Needs Docker. */
  | "docker";

export const GITHUB_REMOTE = "https://api.githubcopilot.com/mcp/";

export function githubSpec(mode: GithubMode): McpSpec {
  switch (mode) {
    case "readonly":
      return { kind: "http", url: GITHUB_REMOTE + "readonly", headers: { "X-MCP-Readonly": "true" } };
    case "full":
      return { kind: "http", url: GITHUB_REMOTE };
    case "docker":
      return {
        kind: "stdio",
        command: "docker",
        args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "-e", "GITHUB_READ_ONLY=1", "ghcr.io/github/github-mcp-server"],
        secretEnv: "GITHUB_PERSONAL_ACCESS_TOKEN",
      };
  }
}

export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+|\*)$/;

/** "acme/app, acme/*" becomes ["acme/app", "acme/*"]. A bare "*" or an owner alone is refused. */
export function parseRepoList(input: string): { ok: true; repos: string[] } | { ok: false; problem: string } {
  const repos = input.split(/[,\s]+/).map((r) => r.trim()).filter(Boolean);
  if (repos.length === 0) return { ok: false, problem: "Enter at least one repository, like acme/app." };
  const bad = repos.find((r) => !REPO_PATTERN.test(r));
  if (bad) return { ok: false, problem: `"${bad}" is not owner/repo or owner/*. A bare * (everything) is not accepted here.` };
  return { ok: true, repos: [...new Set(repos)] };
}

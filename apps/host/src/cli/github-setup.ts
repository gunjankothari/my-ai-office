import { Office } from "../office";
import type { McpSpec } from "../mcp/server";
import type { CallResult } from "../gateway";
import { githubSpec, parseRepoList, type GithubMode } from "../connectors/github";

/*
 * Guided GitHub setup for one project on this machine. The token is read with hidden input,
 * goes straight into the encrypted vault, and is never printed. Safe defaults:
 *   - GitHub's read-only endpoint,
 *   - only tools the server itself marks read-only are reviewed, and only for tools that
 *     name a repository with required owner and repo arguments,
 *   - a repository list is mandatory ("everything" is refused),
 *   - a safety check proves the limit works before you rely on it.
 * Everything else stays unreviewed, which means it asks for approval every time.
 */

export interface SetupIO {
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  say(line: string): void;
}

export interface SetupOptions {
  home: string;
  masterKey: Buffer;
  mode: GithubMode;
  projectId?: string;
  agentId?: string;
  connectionId?: string;
  /** Skip the question. */
  repos?: string[];
  /** Skip the hidden prompt (tests, or read from an environment variable by the caller). */
  token?: string;
  /** Replace the GitHub server (tests only). */
  spec?: McpSpec;
  /** Undo the setup: remove the connection, its grants and the stored token. */
  remove?: boolean;
}

export interface SetupResult {
  ok: boolean;
  reason?: "token_format" | "connect_failed" | "declined" | "github_error" | "limit_not_enforced";
  tools?: number;
  granted?: string[];
  excluded?: string[];
  repos?: string[];
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n - 1) + " " : s + " ".repeat(n - s.length));

function show(io: SetupIO, label: string, r: CallResult): void {
  if (r.status === "ok") io.say(`  ${label}: ${r.output.replace(/\s+/g, " ").slice(0, 400)}${r.output.length > 400 ? "…" : ""}`);
  else if (r.status === "error") io.say(`  ${label}: GitHub returned an error: ${r.message.slice(0, 300)}`);
  else if (r.status === "denied") io.say(`  ${label}: denied (${r.reason})`);
  else if (r.status === "needs_approval") io.say(`  ${label}: waiting for approval (${r.reason})`);
  else io.say(`  ${label}: ${r.status}`);
}

export async function runGithubSetup(io: SetupIO, o: SetupOptions): Promise<SetupResult> {
  const projectId = o.projectId ?? "github-trial";
  const conn = o.connectionId ?? "github";
  const agentId = o.agentId ?? "ada";
  const office = await Office.open({ home: o.home, name: "GitHub trial", masterKey: o.masterKey });
  try {
    if (!office.projects.has(projectId)) office.addProject(projectId, "GitHub trial");

    if (o.remove) {
      await office.removeMcpConnection(projectId, conn);
      office.vault.delete(projectId, "github");
      io.say("Removed the GitHub connection, its grants and the stored token from this machine.");
      io.say("Also delete the token on GitHub (Settings > Developer settings > Personal access tokens).");
      return { ok: true };
    }

    if (!office.agents.has(agentId)) office.addAgent({ id: agentId, name: "Ada", role: "Developer", projectId, mode: "risky", model: "mid" });

    // 1. token, never echoed, never printed
    const token = (o.token ?? (await io.askSecret("GitHub token (input is hidden): "))).trim();
    if (!/^\S{20,}$/.test(token)) {
      io.say("That does not look like a GitHub token (no spaces, at least 20 characters). Nothing was saved.");
      return { ok: false, reason: "token_format" };
    }
    if (token.startsWith("ghp_")) io.say("Note: this is a classic token, which has broad access. A fine-grained token limited to one test repository is safer.");

    // 2. which repositories, before anything connects
    let repos: string[];
    if (o.repos) {
      const r = parseRepoList(o.repos.join(","));
      if (!r.ok) { io.say(r.problem); return { ok: false, reason: "declined" }; }
      repos = r.repos;
    } else {
      for (;;) {
        const r = parseRepoList(await io.ask("Which repositories may Ada read? (owner/repo, comma separated, owner/* allowed): "));
        if (r.ok) { repos = r.repos; break; }
        io.say(r.problem);
      }
    }

    // 3. store and connect
    try { await office.removeMcpConnection(projectId, conn); } catch { /* first run */ }
    office.vault.put(projectId, "github", token);
    io.say(`Token stored in the encrypted vault on this machine. Connecting (${o.mode})…`);
    let found;
    try {
      found = await office.addMcpConnection({ id: conn, projectId, service: "GitHub", label: `GitHub (${o.mode})`, credentialHandle: "github", spec: o.spec ?? githubSpec(o.mode) });
    } catch (e) {
      const msg = office.broker.scrub(projectId, e instanceof Error ? e.message : String(e)).slice(0, 300);
      io.say(`Could not connect: ${msg}`);
      if (/401|403|unauthori[sz]ed|forbidden|bad credentials/i.test(msg)) io.say("GitHub did not accept the token, or your organization blocks it. Check its permissions and expiry.");
      else if (/ENOENT|docker/i.test(msg)) io.say("Docker was not found. Install Docker, or use the default hosted mode.");
      else if (/ENOTFOUND|ECONN|fetch failed|timed out|EAI_AGAIN/i.test(msg)) io.say("The network could not reach GitHub from this machine (proxy or firewall?).");
      office.vault.delete(projectId, "github");
      return { ok: false, reason: "connect_failed" };
    }

    io.say(`\nGitHub offered ${found.length} tools:`);
    io.say("  " + pad("tool", 30) + pad("server says", 13) + "arguments");
    for (const t of found.slice(0, 60)) io.say("  " + pad(t.name, 30) + pad(t.suggestedRisk, 13) + t.args.join(", "));
    if (found.length > 60) io.say(`  …and ${found.length - 60} more`);

    // 4. review: only what the server itself calls read-only
    const readTools = found.filter((t) => t.suggestedRisk === "read");
    io.say(`\n${readTools.length} tools are marked read-only by the server. Anything else stays unreviewed: it can still be granted later, but asks for your approval every time.`);
    if (/^n/i.test((await io.ask("Review those read-only tools as read? [Y/n] ")).trim())) {
      io.say("Left everything unreviewed. The connection is saved; nothing runs without approval.");
      return { ok: true, reason: "declined", tools: found.length, granted: [], repos };
    }
    for (const t of readTools) {
      office.reviewTool(projectId, conn, t.name, { risk: "read", ...(t.suggestedResourceArgs ? { resourceArgs: t.suggestedResourceArgs } : {}) });
    }

    // 5. grants: repo-limited tools together, identity check on its own, everything else left out
    const scoped = readTools.filter((t) => t.suggestedResourceArgs).map((t) => t.name);
    const me = readTools.some((t) => t.name === "get_me") ? ["get_me"] : [];
    const excluded = readTools.filter((t) => !t.suggestedResourceArgs && t.name !== "get_me").map((t) => t.name);
    for (const id of ["g-github-scoped", "g-github-me"]) if (office.grants.some((g) => g.id === id)) office.revokeGrant(id);
    if (scoped.length) office.addGrant({ id: "g-github-scoped", projectId, agentId, connectionId: conn, tools: scoped, resources: repos });
    if (me.length) office.addGrant({ id: "g-github-me", projectId, agentId, connectionId: conn, tools: me, resources: [] });
    io.say(`\nAda may now use ${scoped.length} tools, only on: ${repos.join(", ")}`);
    if (me.length) io.say("Plus get_me (shows which account the token belongs to).");
    if (excluded.length) io.say(`Not granted, because they cannot be limited to your repositories: ${excluded.join(", ")}`);

    // 6. prove it
    io.say("\nTrying it:");
    let sawError = false;
    const run = async (label: string, tool: string, args: Record<string, unknown>) => {
      const r = await office.gateway.call(agentId, conn, tool, args);
      show(io, label, r);
      if (r.status === "error") sawError = true;
      return r;
    };
    if (me.length) await run("get_me", "get_me", {});
    const first = repos.find((r) => !r.endsWith("*"));
    if (first && scoped.includes("list_pull_requests")) {
      const [owner, repo] = first.split("/");
      await run(`list_pull_requests ${first}`, "list_pull_requests", { owner, repo });
    }
    let enforced = true;
    if (scoped.includes("list_pull_requests")) {
      const r = await office.gateway.call(agentId, conn, "list_pull_requests", { owner: "definitely-not-granted", repo: "x" });
      enforced = r.status === "denied";
      io.say(enforced
        ? "  Safety check passed: a repository outside your list was refused here, before anything was sent to GitHub."
        : `  WARNING: a repository outside your list was NOT refused (${r.status}). Do not use this setup.`);
    }

    io.say(`\nDone. State lives in ${o.home}. Start the host there and it reconnects on its own.`);
    io.say("To undo: run this command again with --remove, and delete the token on GitHub.");
    if (!enforced) return { ok: false, reason: "limit_not_enforced", tools: found.length, granted: [...scoped, ...me], excluded, repos };
    if (sawError) return { ok: false, reason: "github_error", tools: found.length, granted: [...scoped, ...me], excluded, repos };
    return { ok: true, tools: found.length, granted: [...scoped, ...me], excluded, repos };
  } finally {
    await office.close();
  }
}

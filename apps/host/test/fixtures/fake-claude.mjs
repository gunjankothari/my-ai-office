// A stand-in for the `claude` program, for tests only. It checks that it is started the way a
// safe engine must start it, then behaves like Claude Code would in a chosen scenario:
// it connects to the MCP server named in --mcp-config with the given bearer token, lists and
// calls tools, and prints stream-json lines. It never contacts any real service.
import { readFileSync, statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const out = (o) => console.log(JSON.stringify(o));
const die = (m) => { console.error("FAKE-CLAUDE REFUSES: " + m); process.exit(2); };

for (const f of ["-p", "--verbose", "--strict-mcp-config", "--disable-slash-commands"]) if (!has(f)) die(`missing ${f}`);
if (val("--output-format") !== "stream-json") die("--output-format");
if (val("--tools") !== "") die("built-in tools must be switched off with --tools \"\"");
if (val("--allowedTools") !== "mcp__office__*") die("--allowedTools");
if (val("--permission-mode") !== "dontAsk") die("--permission-mode");
if (val("--setting-sources") !== "") die("--setting-sources must be empty");
for (const bad of ["--bare", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions"]) if (argv.includes(bad)) die(`forbidden ${bad}`);
for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AGENT_OFFICE_MASTER_KEY", "AGENT_OFFICE_HOME", "GITHUB_PERSONAL_ACCESS_TOKEN", "HUB_ADMIN_TOKEN"]) if (process.env[k]) die(`leaked ${k}`);

const cfgPath = val("--mcp-config");
if (!cfgPath) die("--mcp-config");
if ((statSync(cfgPath).mode & 0o077) !== 0) die("mcp config is readable by others");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8")).mcpServers?.office;
if (!cfg || cfg.type !== "http") die("bad mcp config");

let prompt = "";
for await (const c of process.stdin) prompt += c;
const resumed = val("--resume");
const triage = prompt.startsWith("You are triaging ticket");
const scenario = triage ? "triage" : (/\[scenario:([a-z_]+)\]/.exec(prompt)?.[1] ?? (resumed ? "resume" : "read"));
const sessionId = resumed ?? "sess-" + Math.random().toString(36).slice(2, 10);
const sleepForever = () => setInterval(() => {}, 1000);
const result = (text, extra = {}) => out({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId, total_cost_usd: 0.0123, usage: { input_tokens: 100, output_tokens: 20 }, ...extra });

let client, status = "failed";
if (scenario !== "badmcp") {
  try {
    client = new Client({ name: "fake-claude", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    status = "connected";
  } catch { status = "failed"; }
}
out({ type: "system", subtype: "init", session_id: sessionId, tools: [], mcp_servers: [{ name: "office", status }], model: "fake", apiKeySource: "none", permissionMode: "dontAsk", cwd: process.cwd() });

const retry = (error, n) => { for (let i = 1; i <= n; i++) out({ type: "system", subtype: "api_retry", attempt: i, max_retries: 10, retry_delay_ms: 10, error_status: null, error, session_id: sessionId }); };
const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
const debug = () => JSON.stringify({ argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort() });

switch (scenario) {
  case "read": {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    const text = await call("github__list_pull_requests", { owner: "acme", repo: "app" });
    out({ type: "assistant", message: { content: [{ type: "text", text: "Looking." }] }, session_id: sessionId });
    result(`TOOLS=${names.join(",")} | RESULT=${text} | DEBUG=${debug()}`);
    break;
  }
  case "approval": {
    const text = await call("github__merge_pull_request", { owner: "acme", repo: "app", pullNumber: 7 });
    result(`I am waiting for approval. (${text.slice(0, 40)})`);
    break;
  }
  case "triage": {
    // Plays the Manager. The ticket text steers it: [to:agent] assigns, [ask:question] asks the user, [silent] does neither.
    const ticketId = /triaging ticket (T-\d+)/.exec(prompt)?.[1];
    const answered = prompt.split("The user answered your earlier question:")[1];
    const to = /\[to:([a-z0-9_-]+)\]/.exec(answered ?? prompt)?.[1];
    const ask = answered ? undefined : /\[ask:([^\]]+)\]/.exec(prompt)?.[1];
    const names = (await client.listTools()).tools.map((t) => t.name).sort().join(",");
    let said = "silent";
    if (!prompt.includes("[silent]")) {
      if (ask) said = await call("team__ask_user", { ticketId, question: ask });
      else if (to) said = await call("team__assign_ticket", { ticketId, agentId: to, note: "best fit" });
    }
    result(`TRIAGE tools=${names} -> ${said}`);
    break;
  }
  case "notool": {
    // The model writes an answer as if it had data, but never asks for a tool.
    out({ type: "assistant", message: { content: [{ type: "text", text: "The tool results will be available shortly." }] }, session_id: sessionId });
    result("The tool results will be available shortly.");
    break;
  }
  case "blocked": {
    // The model asks for a tool, but Claude Code's own permission system blocks it before our server hears of it.
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__office__github__list_pull_requests", input: {} }] }, session_id: sessionId });
    result("I could not read the pull requests.", { permission_denials: [{ tool_name: "mcp__office__github__list_pull_requests", tool_use_id: "t1", tool_input: {} }] });
    break;
  }
  case "resume": result(`RESUMED=${resumed} PROMPT=${prompt.slice(0, 200)}`); break;
  case "ratelimit": retry("rate_limit", 2); sleepForever(); break;
  case "ratelimit_result": result("Claude usage limit reached|1893456000", { is_error: true, subtype: "error_during_execution" }); process.exitCode = 1; break;
  case "signedout": retry("authentication_failed", 1); sleepForever(); break;
  case "signedout_result": result("Not logged in · Please run /login", { is_error: true, subtype: "error_during_execution" }); process.exitCode = 1; break;
  case "network": retry("unknown", 6); sleepForever(); break;
  case "badmcp": sleepForever(); break;
  case "hang": sleepForever(); break;
  case "crash": console.error(`boom, details: ${/\[leak:([^\]]+)\]/.exec(prompt)?.[1] ?? ""}`); process.exit(3); break;
  case "garbage": console.log("this is not json"); console.log("{broken"); console.log(JSON.stringify({ no_type: true })); result("survived noise"); break;
  default: die("unknown scenario " + scenario);
}
if (["read", "approval", "resume", "triage", "notool", "blocked", "ratelimit_result", "signedout_result", "garbage"].includes(scenario)) { await client?.close(); }

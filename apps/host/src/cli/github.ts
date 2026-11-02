import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { loadMasterKey } from "../vault";
import { runGithubSetup, type SetupIO } from "./github-setup";
import type { GithubMode } from "../connectors/github";

const HELP = `Connect GitHub to a project on this machine (safe, read-only by default).

  npm run github                         interactive: asks for a token (hidden) and repositories
  npm run github -- --repos acme/app     skip the repository question
  npm run github -- --token-env GH_PAT   read the token from an environment variable instead of the prompt
  npm run github -- --mode full          GitHub's hosted server with all tools (writes still ask every time)
  npm run github -- --mode docker        run GitHub's server locally in Docker (read-only)
  npm run github -- --remove             undo everything
  --project <id>   project name inside the office (default github-trial)
  --home <dir>     office folder (default ~/.agent-office, or AGENT_OFFICE_HOME)

Never paste a token into a chat or a shell command line. Use the hidden prompt or --token-env.`;

function askLine(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a); }));
}

/** Reads a line without echoing it. If stdin is not a terminal (a pipe), reads it plainly. */
function askHidden(q: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(q);
    let buf = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (value: string) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") return done(buf);
        if (c === "\u0003") { stdin.setRawMode?.(false); process.stdout.write("\n"); process.exit(130); }
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

const io: SetupIO = { ask: askLine, askSecret: askHidden, say: (l) => console.log(l) };

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "readonly" },
    project: { type: "string" },
    repos: { type: "string" },
    home: { type: "string" },
    "token-env": { type: "string" },
    remove: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) { console.log(HELP); process.exit(0); }
if (!["readonly", "full", "docker"].includes(values.mode!)) { console.error(`Unknown --mode "${values.mode}". Use readonly, full or docker.`); process.exit(2); }

let token: string | undefined;
if (values["token-env"]) {
  token = process.env[values["token-env"]];
  if (!token) { console.error(`The environment variable ${values["token-env"]} is empty or not set.`); process.exit(2); }
}

const home = values.home ?? process.env.AGENT_OFFICE_HOME ?? join(homedir(), ".agent-office");
const result = await runGithubSetup(io, {
  home,
  masterKey: loadMasterKey(home),
  mode: values.mode as GithubMode,
  projectId: values.project,
  repos: values.repos?.split(","),
  token,
  remove: values.remove,
});
process.exit(result.ok ? 0 : 1);

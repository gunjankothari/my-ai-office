import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { loadMasterKey } from "../vault";
import { runAgentTask } from "./agent-run";

const HELP = `Run one task for an agent, on your own Claude Code sign-in (no API key).

  npm run agent -- --task "List the open pull requests in acme/app and summarise them"
  --agent <id>     which agent (default ada)
  --model <alias>  Claude model alias, for example sonnet or haiku (default: what your Claude Code uses)
  --home <dir>     office folder (default ~/.agent-office, or AGENT_OFFICE_HOME)

Needs Claude Code installed and signed in (run \`claude\` once). The agent only gets the tools you granted it.`;

const { values } = parseArgs({
  options: { task: { type: "string" }, agent: { type: "string" }, model: { type: "string" }, home: { type: "string" }, help: { type: "boolean", default: false } },
});
if (values.help || !values.task) { console.log(HELP); process.exit(values.help ? 0 : 2); }

const ask = (q: string) => new Promise<string>((resolve) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); resolve(a); }); });
const home = values.home ?? process.env.AGENT_OFFICE_HOME ?? join(homedir(), ".agent-office");

const ac = new AbortController();
process.on("SIGINT", () => ac.abort());

const r = await runAgentTask({ ask, say: (l) => console.log(l) }, { home, masterKey: loadMasterKey(home), task: values.task, agentId: values.agent, model: values.model, signal: ac.signal });
process.exit(r.ok ? 0 : 1);

import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fingerprint } from "@agent-office/shared";
import { seedDemo } from "./demo";
import { HostLink } from "./link";
import { Office } from "./office";
import { loadMasterKey } from "./vault";

const home = process.env.AGENT_OFFICE_HOME ?? join(homedir(), ".agent-office");
const name = process.env.OFFICE_NAME ?? hostname();
const hubUrl = process.env.HUB_URL ?? "ws://127.0.0.1:8787";

const office = await Office.open({ home, name, masterKey: loadMasterKey(home) });
if (process.argv.includes("--demo")) await seedDemo(office);

const link = new HostLink({
  url: hubUrl,
  office,
  stateFile: join(home, "hub.json"),
  enrollToken: process.env.ENROLL_TOKEN,
  log: (m) => console.log(`[host] ${m}`),
});
link.start();

console.log(`[host] office "${name}", home ${home}`);
console.log(`[host] host key fingerprint: ${await fingerprint(office.publicKey)}`);

const showCode = () => {
  const { code, expiresAt } = office.pairing.start();
  console.log(`\n  Pairing code: ${code}   (valid until ${new Date(expiresAt).toLocaleTimeString()}, 3 tries)\n  Type it into the new device. Never share it through the hub or chat.\n`);
};
if (office.trust.list().length === 0 || process.argv.includes("--pair")) showCode();
console.log("[host] commands: pair (new pairing code), devices (list), quit");

createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = line.trim();
  if (cmd === "pair") showCode();
  else if (cmd === "devices") console.table(office.trust.list().map((d) => ({ id: d.deviceId, name: d.name, revoked: Boolean(d.revoked) })));
  else if (cmd === "quit") void link.stop().then(() => process.exit(0));
});

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void link.stop().then(() => process.exit(0)));

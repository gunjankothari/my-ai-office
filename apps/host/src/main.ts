import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fingerprint } from "@agent-office/shared";
import { seedDemo } from "./demo";
import { HostLink, readLinkState } from "./link";
import { Office } from "./office";
import { loadMasterKey } from "./vault";

const home = process.env.AGENT_OFFICE_HOME ?? join(homedir(), ".agent-office");
const name = process.env.OFFICE_NAME ?? hostname();
const saved = readLinkState(join(home, "hub.json"));
const hubUrl = process.env.HUB_URL ?? saved.url ?? "ws://127.0.0.1:8787";
if (!process.env.HUB_URL && !saved.url) console.log("[host] no hub address known: using the local default. Set HUB_URL (and ENROLL_TOKEN the first time) to use a hub elsewhere.");

const office = await Office.open({ home, name, masterKey: loadMasterKey(home), autoDispatch: true, maxParallel: Number(process.env.MAX_PARALLEL ?? 2) });
if (process.argv.includes("--demo")) await seedDemo(office);

const link = new HostLink({
  url: hubUrl,
  office,
  stateFile: join(home, "hub.json"),
  enrollToken: process.env.ENROLL_TOKEN,
  log: (m) => console.log(`[host] ${m}`),
});
link.start();
office.dispatcher.start();

console.log(`[host] office "${name}", home ${home}, hub ${hubUrl}`);
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

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void link.stop().then(() => office.close()).then(() => process.exit(0)));

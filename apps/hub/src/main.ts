import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { startHub } from "./server";

const adminToken = process.env.HUB_ADMIN_TOKEN;
if (!adminToken || adminToken.length < 16) {
  console.error("Set HUB_ADMIN_TOKEN to a random string of at least 16 characters, for example:\n  HUB_ADMIN_TOKEN=$(openssl rand -hex 24) npm run dev:hub");
  process.exit(1);
}

const dbPath = resolve(process.env.HUB_DB ?? "hub.db");
mkdirSync(dirname(dbPath), { recursive: true });

// On Railway the database must live on a volume, or every redeploy would erase the enrolled machines.
const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (process.env.RAILWAY_ENVIRONMENT_NAME) {
  if (!volume) console.warn("[hub] WARNING: running on Railway with NO VOLUME attached. The database will be erased on every redeploy and every machine would have to be enrolled again. Attach a volume and set HUB_DB inside it.");
  else if (!dbPath.startsWith(resolve(volume))) console.warn(`[hub] WARNING: the database (${dbPath}) is not inside the volume (${volume}). It will be erased on redeploy. Set HUB_DB to a path under ${volume}.`);
}

const webDir = process.env.WEB_DIR ? resolve(process.env.WEB_DIR) : undefined;
if (webDir && !existsSync(resolve(webDir, "index.html"))) console.warn(`[hub] WARNING: WEB_DIR ${webDir} has no index.html, so the web app will not load.`);

const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
const hub = await startHub({
  port: Number(process.env.PORT ?? 8787),
  adminToken,
  dbPath,
  bindHost: process.env.BIND_HOST ?? "127.0.0.1",
  allowedOrigin: process.env.HUB_ALLOWED_ORIGIN ?? (publicDomain ? `https://${publicDomain}` : "http://localhost:5173"),
  webDir,
  log: (m) => console.log(`[hub] ${m}`),
});
console.log(`[hub] database: ${dbPath}${webDir ? `, serving the web app from ${webDir}` : ""}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void hub.close().then(() => process.exit(0)));

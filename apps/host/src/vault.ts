import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/*
 * The vault keeps credentials on this machine only, encrypted at rest.
 *
 * - Every project has its own key, derived from the master key with HKDF, so a
 *   project's credentials cannot be decrypted in the context of another one.
 * - Each entry is bound to its project and handle (AES-GCM associated data), so
 *   moving ciphertext between handles or projects makes decryption fail.
 * - The API can write and delete but there is deliberately no public "get".
 *   Only the CredentialBroker may call readSecret / allSecrets. A test checks this.
 *
 * Dev default: the master key is a 0600 file in the office home. For real use,
 * move it into the OS keychain (macOS Keychain, Windows DPAPI, libsecret).
 */

interface Entry { iv: string; tag: string; ct: string }
interface ProjectBlock { salt: string; entries: Record<string, Entry> }
interface VaultFile { v: 1; projects: Record<string, ProjectBlock> }

const HANDLE_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

export class Vault {
  private data: VaultFile;

  constructor(private readonly file: string, private readonly master: Buffer) {
    if (master.length !== 32) throw new Error("vault master key must be 32 bytes");
    this.data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as VaultFile) : { v: 1, projects: {} };
  }

  private key(projectId: string, salt: string): Buffer {
    return Buffer.from(hkdfSync("sha256", this.master, Buffer.from(salt, "base64"), `agent-office/project/${projectId}`, 32));
  }

  private aad = (projectId: string, handle: string) => Buffer.from(`${projectId}\0${handle}`);

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }

  /** Store or replace a secret. The value can never be read back through this class's public API. */
  put(projectId: string, handle: string, value: string): void {
    if (!HANDLE_RE.test(handle)) throw new Error(`invalid handle "${handle}"`);
    if (!projectId) throw new Error("projectId required");
    const block = (this.data.projects[projectId] ??= { salt: randomBytes(16).toString("base64"), entries: {} });
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key(projectId, block.salt), iv);
    c.setAAD(this.aad(projectId, handle));
    const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
    block.entries[handle] = { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
    this.save();
  }

  has(projectId: string, handle: string): boolean {
    return Boolean(this.data.projects[projectId]?.entries[handle]);
  }

  /** Handle names only, never values. */
  handles(projectId: string): string[] {
    return Object.keys(this.data.projects[projectId]?.entries ?? {});
  }

  delete(projectId: string, handle: string): void {
    const block = this.data.projects[projectId];
    if (block && block.entries[handle]) {
      delete block.entries[handle];
      this.save();
    }
  }

  /** Removes every credential of a project and its key material. */
  deleteProject(projectId: string): void {
    if (this.data.projects[projectId]) {
      delete this.data.projects[projectId];
      this.save();
    }
  }

  /** @internal Only CredentialBroker may call this. */
  readSecret(projectId: string, handle: string): string | undefined {
    const block = this.data.projects[projectId];
    const e = block?.entries[handle];
    if (!block || !e) return undefined;
    const d = createDecipheriv("aes-256-gcm", this.key(projectId, block.salt), Buffer.from(e.iv, "base64"));
    d.setAAD(this.aad(projectId, handle));
    d.setAuthTag(Buffer.from(e.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(e.ct, "base64")), d.final()]).toString("utf8");
  }

  /** @internal Only CredentialBroker may call this (used for scrubbing). */
  allSecrets(projectId: string): string[] {
    return this.handles(projectId).map((h) => this.readSecret(projectId, h)).filter((s): s is string => s !== undefined);
  }
}

export function loadMasterKey(home: string): Buffer {
  const env = process.env.AGENT_OFFICE_MASTER_KEY;
  if (env) {
    const k = Buffer.from(env, "base64url");
    if (k.length !== 32) throw new Error("AGENT_OFFICE_MASTER_KEY must be 32 bytes, base64url");
    return k;
  }
  const file = join(home, "master.key");
  if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "base64url");
  mkdirSync(home, { recursive: true });
  const k = randomBytes(32);
  writeFileSync(file, k.toString("base64url"), { mode: 0o600 });
  return k;
}

import { b64u, utf8 } from "./b64";

/*
 * Ed25519 via WebCrypto, so the same code runs in Node (host, hub) and in the
 * browser (web app, phone). Public keys are raw 32 bytes, base64url. Private
 * keys are PKCS8, base64url, only where extraction is needed (the host).
 * Browsers keep their private key as a non-extractable CryptoKey.
 */

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const bs = (b: Uint8Array): BufferSource => b as unknown as BufferSource;

export interface Signer {
  /** Raw public key, base64url. */
  readonly publicKey: string;
  sign(data: Uint8Array | string): Promise<string>;
}

export interface ExportedKeyPair {
  publicKey: string;
  /** PKCS8, base64url. Treat as a secret. */
  privateKey: string;
}

const toBytes = (d: Uint8Array | string): Uint8Array => (typeof d === "string" ? utf8.enc(d) : d);

export async function generateKeyPair(): Promise<ExportedKeyPair> {
  const kp = (await subtle().generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle().exportKey("raw", kp.publicKey));
  const priv = new Uint8Array(await subtle().exportKey("pkcs8", kp.privateKey));
  return { publicKey: b64u.enc(pub), privateKey: b64u.enc(priv) };
}

/** For browsers: the private key can never be exported. */
export async function generateNonExtractableKeyPair(): Promise<{ keys: CryptoKeyPair; publicKey: string }> {
  const keys = (await subtle().generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle().exportKey("raw", keys.publicKey));
  return { keys, publicKey: b64u.enc(pub) };
}

export function signerFromCryptoKey(privateKey: CryptoKey, publicKey: string): Signer {
  return {
    publicKey,
    async sign(data) {
      const sig = new Uint8Array(await subtle().sign({ name: "Ed25519" }, privateKey, bs(toBytes(data))));
      return b64u.enc(sig);
    },
  };
}

export async function signerFromExported(pair: ExportedKeyPair): Promise<Signer> {
  const key = await subtle().importKey("pkcs8", bs(b64u.dec(pair.privateKey)), { name: "Ed25519" }, false, ["sign"]);
  return signerFromCryptoKey(key, pair.publicKey);
}

export async function verifySignature(publicKey: string, data: Uint8Array | string, signature: string): Promise<boolean> {
  try {
    const key = await subtle().importKey("raw", bs(b64u.dec(publicKey)), { name: "Ed25519" }, false, ["verify"]);
    return await subtle().verify({ name: "Ed25519" }, key, bs(b64u.dec(signature)), bs(toBytes(data)));
  } catch {
    return false;
  }
}

/** Short, human-checkable identifier for a public key. */
export async function fingerprint(publicKey: string): Promise<string> {
  const d = new Uint8Array(await subtle().digest("SHA-256", bs(b64u.dec(publicKey))));
  return Array.from(d.slice(0, 8), (x) => x.toString(16).padStart(2, "0")).join("").replace(/(.{4})/g, "$1 ").trim();
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const d = new Uint8Array(await subtle().digest("SHA-256", bs(toBytes(data))));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Deterministic JSON: sorted keys, no whitespace, undefined dropped. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}

/** Sign any JSON body. Used for host replies so a relay cannot alter them. */
export async function signObject<T>(signer: Signer, body: T): Promise<{ body: T; sig: string }> {
  return { body, sig: await signer.sign(canonicalJson(body)) };
}

export async function verifyObject(publicKey: string, env: { body: unknown; sig: string }): Promise<boolean> {
  return verifySignature(publicKey, canonicalJson(env.body), env.sig);
}

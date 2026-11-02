import { generateNonExtractableKeyPair, randomId, signerFromCryptoKey, type Signer } from "@agent-office/shared";

/*
 * This browser (or phone) is a "device". Its Ed25519 private key is created as
 * non-extractable and kept in IndexedDB as a CryptoKey object, so page scripts
 * can use it to sign but can never read it out. Pinned host keys are stored
 * next to it: once pairing succeeded, a host key can never be swapped by the hub.
 */

const DB = "agent-office";
const STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function get<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const q = db.transaction(STORE).objectStore(STORE).get(key);
    q.onsuccess = () => resolve(q.result as T | undefined);
    q.onerror = () => reject(q.error);
  });
}

async function set(key: string, value: unknown): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export interface Device {
  deviceId: string;
  name: string;
  publicKey: string;
  signer: Signer;
}

interface StoredDevice { deviceId: string; name: string; publicKey: string; keys: CryptoKeyPair }

export async function getDevice(): Promise<Device> {
  let d = await get<StoredDevice>("device");
  if (!d) {
    const { keys, publicKey } = await generateNonExtractableKeyPair();
    d = { deviceId: randomId("dev_"), name: guessName(), publicKey, keys };
    await set("device", d);
  }
  return { deviceId: d.deviceId, name: d.name, publicKey: d.publicKey, signer: signerFromCryptoKey(d.keys.privateKey, d.publicKey) };
}

function guessName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android phone" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows PC" : "Browser";
  return `${os} (${/Firefox/.test(ua) ? "Firefox" : /Edg/.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : "Safari"})`;
}

export async function getPinnedHosts(): Promise<Record<string, string>> {
  return (await get<Record<string, string>>("hosts")) ?? {};
}

export async function pinHost(officeId: string, hostPublicKey: string): Promise<void> {
  const all = await getPinnedHosts();
  all[officeId] = hostPublicKey;
  await set("hosts", all);
}

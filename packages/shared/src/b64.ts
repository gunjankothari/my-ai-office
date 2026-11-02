/** Base64url helpers that work in Node and in the browser (no Buffer). */
export const b64u = {
  enc(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str: string): Uint8Array {
    const pad = "=".repeat((4 - (str.length % 4)) % 4);
    const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

export const utf8 = {
  enc: (s: string): Uint8Array => new TextEncoder().encode(s),
  dec: (b: Uint8Array): string => new TextDecoder().decode(b),
};

export function randomId(prefix = "", bytes = 12): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return prefix + b64u.enc(b);
}

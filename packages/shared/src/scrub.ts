/*
 * Secret scrubbing. Everything that flows back toward the model, the logs or
 * the cloud passes through here first. Two layers:
 *   1. exact values of the project's own secrets (plain, URL-encoded, base64),
 *   2. well-known token formats and long high-entropy strings.
 */

export const HIDDEN = "[hidden]";

const TOKEN_PATTERNS: RegExp[] = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function variants(secret: string): string[] {
  const out = new Set<string>([secret, encodeURIComponent(secret)]);
  try {
    out.add(btoa(secret));
    out.add(btoa(secret).replace(/=+$/, ""));
  } catch {
    /* non-latin1 secret: skip the base64 variant */
  }
  return [...out].filter((v) => v.length >= 6);
}

export function scrubText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length < 6) continue;
    for (const v of variants(s)) out = out.split(v).join(HIDDEN);
  }
  for (const re of TOKEN_PATTERNS) out = out.replace(re, HIDDEN);
  // Long random-looking strings. Hex (git SHAs) stays under 4 bits per char and is kept.
  out = out.replace(/[A-Za-z0-9+/_-]{40,}/g, (m) => (shannonEntropy(m) > 4.2 ? HIDDEN : m));
  return out;
}

/** Scrub a JSON-compatible value and return a JSON-compatible value. */
export function scrubValue<T>(value: T, secrets: readonly string[]): T {
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  const cleaned = scrubText(json, secrets);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return cleaned as unknown as T;
  }
}

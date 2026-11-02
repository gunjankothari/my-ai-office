/*
 * The environment handed to the Claude Code program. An allowlist, not a copy of ours:
 *   - ANTHROPIC_API_KEY and friends are NOT passed. If one were set, Claude Code would bill the
 *     API instead of the subscription, which is the opposite of what this engine is for.
 *   - Nothing of this host leaks into it: no vault key, no GitHub token, no hub address.
 * What is passed is only what the program needs to run, find the user's own login, and
 * reach the network through the user's own proxy.
 *
 * One thing is added: loopback is always exempt from the proxy. Claude Code sends even its
 * connection to our local tool server through a configured proxy, which then cannot reach
 * 127.0.0.1 and the server shows as "failed". (Seen with the real program.)
 */

const KEEP = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TEMP", "TMP",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "SYSTEMROOT", "ComSpec", "PATHEXT",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "CLAUDE_CONFIG_DIR",
];

const LOOPBACK = ["127.0.0.1", "localhost", "::1"];

function withLoopback(existing: string | undefined): string {
  const parts = (existing ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const l of LOOPBACK) if (!parts.includes(l)) parts.push(l);
  return parts.join(",");
}

export function buildChildEnv(source: NodeJS.ProcessEnv, passEnv: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [...KEEP, ...passEnv]) {
    const v = source[k];
    if (typeof v === "string") out[k] = v;
  }
  const noProxy = withLoopback(source.NO_PROXY ?? source.no_proxy);
  out.NO_PROXY = noProxy;
  out.no_proxy = noProxy;
  return out;
}

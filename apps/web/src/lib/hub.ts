import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { HubToClient, type StatusSnapshot } from "@agent-office/shared";

export interface OfficeInfo {
  id: string;
  name: string;
  hostPublicKey: string | null;
  online: boolean;
  lastSeen: number | null;
  status: StatusSnapshot | null;
}

interface Pending { officeId: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

/** Talks to the cloud hub. The hub is only a relay: nothing it returns is trusted without a host signature. */
export class HubClient {
  private ws: WebSocket | undefined;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(o: { officeId: string; online: boolean; lastSeen: number | null; status: StatusSnapshot | null }) => void>();

  constructor(readonly baseUrl: string, private readonly token: string) {}

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await fetch(this.baseUrl + path, { ...init, headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" } });
    if (r.status === 401) throw new Error("The hub refused that token.");
    if (!r.ok) throw new Error(`Hub error ${r.status}`);
    return (await r.json()) as T;
  }

  /** Does this hub have a passkey to sign in with? Needs no sign-in. */
  static async passkeyCount(baseUrl: string): Promise<number> {
    try {
      const r = await fetch(baseUrl + "/auth/status");
      return r.ok ? ((await r.json()) as { passkeys: number }).passkeys : 0;
    } catch { return 0; }
  }

  /** Asks this device for a passkey and returns a session token. */
  static async passkeyLogin(baseUrl: string): Promise<string> {
    const post = (path: string, body: unknown) => fetch(baseUrl + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const o = await post("/auth/options", {});
    if (!o.ok) throw new Error("This hub has no passkey yet. Sign in with the admin token and add one.");
    const response = await startAuthentication({ optionsJSON: await o.json() });
    const v = await post("/auth/verify", { response });
    if (v.status === 429) throw new Error("Too many wrong attempts. Wait a minute.");
    if (!v.ok) throw new Error("That passkey was not accepted.");
    return ((await v.json()) as { token: string }).token;
  }

  listPasskeys = () => this.api<{ id: string; name: string; created: number }[]>("/api/passkeys");
  removePasskey = (id: string) => this.api<{ ok: true }>(`/api/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
  async addPasskey(name: string): Promise<void> {
    const optionsJSON = await this.api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/passkeys/options", { method: "POST", body: "{}" });
    const response = await startRegistration({ optionsJSON });
    await this.api("/api/passkeys/verify", { method: "POST", body: JSON.stringify({ name, response }) });
  }
  logout = () => this.api<{ ok: true }>("/api/logout", { method: "POST", body: "{}" }).catch(() => undefined);

  listOffices = () => this.api<OfficeInfo[]>("/api/offices");
  createOffice = (name: string) => this.api<{ id: string; enrollToken: string }>("/api/offices", { method: "POST", body: JSON.stringify({ name }) });

  deleteOffice = (id: string) => this.api<{ ok: true }>(`/api/offices/${encodeURIComponent(id)}`, { method: "DELETE" });

  /** Opens the live connection. The token is sent as the first message, never in the address. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.baseUrl.replace(/^http/, "ws") + "/client");
      this.ws = ws;
      let ready = false;
      ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: this.token }));
      ws.onerror = () => { if (!ready) reject(new Error("Could not open a live connection to the hub.")); };
      ws.onclose = () => { if (!ready) reject(new Error("The hub refused that token.")); };
      ws.onmessage = (ev) => {
        const m = HubToClient.safeParse(JSON.parse(String(ev.data)));
        if (!m.success) return;
        const msg = m.data;
        if (msg.type === "hello") { ready = true; resolve(); }
        else if (msg.type === "office.status") this.listeners.forEach((l) => l(msg));
        else if (msg.type === "reply") this.settle(msg.payload);
        else if (msg.type === "error" && msg.officeId) this.failAll(msg.officeId, msg.code);
      };
    });
  }

  onOfficeStatus(fn: (o: { officeId: string; online: boolean; lastSeen: number | null; status: StatusSnapshot | null }) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  subscribe(officeId: string): void {
    this.ws?.send(JSON.stringify({ type: "subscribe", officeId }));
  }

  /** Sends a payload through the relay and waits for the reply with the same correlation key. */
  request<T>(officeId: string, payload: unknown, key: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(key); reject(new Error("The office did not answer in time.")); }, 8000);
      this.pending.set(key, { officeId, resolve, reject, timer });
      this.ws?.send(JSON.stringify({ type: "relay", officeId, payload }));
    });
  }

  private settle(payload: any): void {
    const key = typeof payload?.body?.nonce === "string" ? payload.body.nonce : typeof payload?.type === "string" && payload.type.startsWith("pair.") ? "pair" : "";
    const p = this.pending.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(key);
    p.resolve(payload);
  }

  private failAll(officeId: string, code: string): void {
    for (const [k, p] of this.pending) {
      if (p.officeId !== officeId) continue;
      clearTimeout(p.timer);
      this.pending.delete(k);
      p.reject(new Error(code === "office_offline" ? "That office is offline right now." : `Hub error: ${code}`));
    }
  }

  close(): void {
    this.ws?.close();
  }
}

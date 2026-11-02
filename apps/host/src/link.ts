import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "ws";
import { HubToHost, MAX_MESSAGE_BYTES, hostAuthMessage, type HostToHub } from "@agent-office/shared";
import type { Office } from "./office";

/**
 * Keeps one outbound WebSocket to the cloud hub. Nothing listens on this machine.
 * First run: enrolls with a one-time token. After that: signs the hub's challenge.
 * Reconnects with backoff. Everything the hub relays goes to Office.handleRelay,
 * which only obeys commands signed by devices paired with this host.
 */
export interface LinkOptions {
  url: string;
  office: Office;
  stateFile: string;
  enrollToken?: string;
  statusEveryMs?: number;
  log?: (m: string) => void;
}

export class HostLink {
  private ws: WebSocket | undefined;
  private stopped = false;
  private backoff = 1000;
  private retry: NodeJS.Timeout | undefined;
  private statusTimer: NodeJS.Timeout | undefined;
  private waiters: (() => void)[] = [];
  private ready = false;
  private readonly log: (m: string) => void;

  constructor(private readonly o: LinkOptions) {
    this.log = o.log ?? (() => {});
    const saved = this.loadState();
    if (saved.officeId) o.office.officeId = saved.officeId;
  }

  private loadState(): { officeId?: string } {
    return existsSync(this.o.stateFile) ? (JSON.parse(readFileSync(this.o.stateFile, "utf8")) as { officeId?: string }) : {};
  }

  private saveOfficeId(id: string): void {
    mkdirSync(dirname(this.o.stateFile), { recursive: true });
    writeFileSync(this.o.stateFile, JSON.stringify({ officeId: id }), { mode: 0o600 });
  }

  start(): void {
    this.connect();
  }

  whenReady(): Promise<void> {
    return this.ready ? Promise.resolve() : new Promise((r) => this.waiters.push(r));
  }

  pushStatus(): void {
    this.send({ type: "status", status: this.o.office.statusSnapshot() });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.statusTimer);
    this.ws?.close();
  }

  private send(m: HostToHub): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.o.url.replace(/\/$/, "") + "/host", { maxPayload: MAX_MESSAGE_BYTES });
    this.ws = ws;
    ws.on("error", (e) => this.log(`link error: ${e.message}`));

    ws.on("message", async (data) => {
      let parsed;
      try { parsed = HubToHost.safeParse(JSON.parse(data.toString())); } catch { return; }
      if (!parsed.success) return;
      const m = parsed.data;
      const office = this.o.office;

      switch (m.type) {
        case "challenge":
          if (office.officeId) {
            const signature = await office.signer.sign(hostAuthMessage(m.nonce, office.officeId));
            this.send({ type: "host.auth", officeId: office.officeId, signature });
          } else if (this.o.enrollToken) {
            this.send({ type: "host.enroll", enrollToken: this.o.enrollToken, hostPublicKey: office.publicKey });
          } else {
            this.log("this office is not enrolled. Set ENROLL_TOKEN from the hub and start again.");
            this.stopped = true;
            ws.close();
          }
          break;
        case "enrolled":
          office.officeId = m.officeId;
          this.saveOfficeId(m.officeId);
          this.onReady();
          break;
        case "authed":
          this.onReady();
          break;
        case "relay": {
          let payload: unknown;
          try { payload = await office.handleRelay(m.payload); } catch (e) { this.log(`relay error: ${(e as Error).message}`); return; }
          this.send({ type: "reply", to: m.from, payload });
          break;
        }
        case "error":
          this.log(`hub error: ${m.code}`);
          break;
      }
    });

    ws.on("close", () => {
      this.ready = false;
      clearInterval(this.statusTimer);
      if (this.stopped) return;
      this.log(`disconnected, retrying in ${this.backoff / 1000}s`);
      this.retry = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
  }

  private onReady(): void {
    this.ready = true;
    this.backoff = 1000;
    this.log(`connected as office ${this.o.office.officeId}`);
    this.pushStatus();
    this.statusTimer = setInterval(() => this.pushStatus(), this.o.statusEveryMs ?? 15_000);
    this.waiters.splice(0).forEach((r) => r());
  }
}

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { fingerprint, pairingProof, verifyPairingProof } from "@agent-office/shared";
import { getDevice, getPinnedHosts, pinHost, type Device } from "./lib/device";
import { HubClient, type OfficeInfo } from "./lib/hub";
import { officeRunner } from "./lib/commands";
import { OfficeView } from "./OfficeView";

// Served by the hub itself in production, so the hub is simply this site. In development the web app runs on 5173 and the hub on 8787.
const DEFAULT_HUB = import.meta.env.VITE_HUB_URL ?? (location.port === "5173" ? "http://localhost:8787" : location.origin);

const ago = (t: number | null): string => {
  if (!t) return "never";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 20 ? "just now" : s < 3600 ? `${Math.round(s / 60) || 1} min ago` : `${Math.round(s / 3600)} h ago`;
};

export function App() {
  const [hub, setHub] = useState<HubClient | null>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [pinned, setPinned] = useState<Record<string, string>>({});
  const [offices, setOffices] = useState<OfficeInfo[]>([]);
  const officesRef = useRef<OfficeInfo[]>([]);
  officesRef.current = offices;
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    void getDevice().then(setDevice);
    void getPinnedHosts().then(setPinned);
  }, []);

  const refresh = useCallback(async (h: HubClient) => {
    const list = await h.listOffices();
    setOffices(list);
    list.forEach((o) => h.subscribe(o.id));
  }, []);

  async function connect(url: string, token: string) {
    setError("");
    try {
      const h = new HubClient(url.replace(/\/$/, ""), token);
      await h.listOffices();
      await h.connect();
      h.onOfficeStatus((u) => {
        // A host that enrolls after this page loaded has no public key in our list yet. Fetch it.
        const known = officesRef.current.find((o) => o.id === u.officeId);
        if (u.online && known && !known.hostPublicKey) void h.listOffices().then((list) => setOffices((all) => list.map((l) => ({ ...l, status: all.find((a) => a.id === l.id)?.status ?? l.status }))));
        setOffices((all) => all.map((o) => (o.id === u.officeId ? { ...o, online: u.online, lastSeen: u.lastSeen, status: u.status ?? o.status } : o)));
      });
      await refresh(h);
      sessionStorage.setItem("hub", JSON.stringify({ url, token }));
      setHub(h);
    } catch (e) {
      setError((e as Error).message || "Could not reach the hub.");
    }
  }

  useEffect(() => {
    const saved = sessionStorage.getItem("hub");
    if (saved) {
      const { url, token } = JSON.parse(saved) as { url: string; token: string };
      void connect(url, token);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="shell">
      <header className="top">
        <div className="brand"><span className="logo" aria-hidden="true">AO</span>Agent Office</div>
        {hub && (
          <button className="ghost" onClick={() => { void hub.logout(); hub.close(); sessionStorage.removeItem("hub"); setHub(null); setOffices([]); }}>
            Disconnect
          </button>
        )}
      </header>
      <main>
        {!hub ? (
          <ConnectForm onConnect={connect} error={error} onError={setError} />
        ) : openId && offices.find((o) => o.id === openId) ? (
          <OfficeView
            office={offices.find((o) => o.id === openId)!}
            hub={hub}
            device={device}
            pinnedKey={pinned[openId]}
            onBack={() => setOpenId(null)}
          />
        ) : (
          <>
            <h1>Offices</h1>
            <p className="muted">Each office is a machine running the Office Host. This page only relays to it. It never sees your credentials.</p>
            <AddOffice hub={hub} onCreated={() => void refresh(hub)} />
            <Passkeys hub={hub} />
            <div className="cards">
              {offices.map((o) => (
                <OfficeCard
                  key={o.id}
                  office={o}
                  hub={hub}
                  device={device}
                  pinnedKey={pinned[o.id]}
                  onPinned={(k) => setPinned((p) => ({ ...p, [o.id]: k }))}
                  onOpen={() => setOpenId(o.id)}
                  onDelete={() => {
                    if (!confirm(`Delete "${o.name}"? Its host is disconnected and must be set up again. Nothing on that machine is erased.`)) return;
                    hub.deleteOffice(o.id).then(() => refresh(hub)).catch((e: Error) => setError(e.message));
                  }}
                />
              ))}
              {offices.length === 0 && <div className="empty">No offices yet. Add one, then run the Office Host on that machine.</div>}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function ConnectForm({ onConnect, error, onError }: { onConnect: (url: string, token: string) => Promise<void>; error: string; onError: (m: string) => void }) {
  const [url, setUrl] = useState(DEFAULT_HUB);
  const [passkeys, setPasskeys] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => void HubClient.passkeyCount(url.replace(/\/$/, "")).then(setPasskeys), 300);
    return () => clearTimeout(t);
  }, [url]);
  const withPasskey = async () => {
    setBusy(true);
    onError("");
    try { await onConnect(url, await HubClient.passkeyLogin(url.replace(/\/$/, ""))); }
    catch (e) { onError((e as Error).name === "NotAllowedError" ? "Sign-in was cancelled." : (e as Error).message); }
    setBusy(false);
  };
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await onConnect(url, token);
    setBusy(false);
  };
  return (
    <form className="panel form" onSubmit={submit}>
      <h1>Connect to your hub</h1>
      {passkeys > 0 && (
        <>
          <button type="button" className="primary" disabled={busy} onClick={() => void withPasskey()}>Sign in with passkey</button>
          <p className="muted">Or use the admin token, if this hub still allows it.</p>
        </>
      )}
      {passkeys === 0 && <p className="muted">Sign in with the hub's admin token, then add a passkey from the Offices page.</p>}
      <label htmlFor="hub-url">Hub address</label>
      <input id="hub-url" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" />
      <label htmlFor="hub-token">Admin token</label>
      <input id="hub-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required />
      {error && <p className="err" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? "Connecting…" : "Connect"}</button>
    </form>
  );
}

function AddOffice({ hub, onCreated }: { hub: HubClient; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [made, setMade] = useState<{ id: string; enrollToken: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMade(await hub.createOffice(name.trim()));
    setName("");
    onCreated();
  };
  return (
    <section className="panel">
      <form className="inline" onSubmit={submit}>
        <label htmlFor="office-name" className="sr">Office name</label>
        <input id="office-name" placeholder="Name this machine, for example Home lab" value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="primary">Add office</button>
      </form>
      {made && (
        <div className="note">
          <p>Run this once on that machine. The token works one time and is not stored here.</p>
          <pre>{`ENROLL_TOKEN=${made.enrollToken} HUB_URL=${hub.baseUrl.replace(/^http/, "ws")} npm run dev:host`}</pre>
        </div>
      )}
    </section>
  );
}

function Passkeys({ hub }: { hub: HubClient }) {
  const [keys, setKeys] = useState<{ id: string; name: string; created: number }[]>([]);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const load = useCallback(() => { void hub.listPasskeys().then(setKeys).catch(() => undefined); }, [hub]);
  useEffect(load, [load]);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setMsg("");
    try { await hub.addPasskey(name.trim() || "This device"); setName(""); load(); }
    catch (err) { setMsg((err as Error).name === "NotAllowedError" ? "Cancelled." : (err as Error).message); }
  };
  const remove = async (id: string, label: string) => {
    if (!confirm(`Remove "${label}"? Everyone is signed out, including this page.`)) return;
    try { await hub.removePasskey(id); location.reload(); } catch (err) { setMsg((err as Error).message); }
  };
  return (
    <section className="panel">
      <h2>Passkeys</h2>
      <p className="muted">Sign in with your fingerprint, face or device lock instead of the admin token. Add one for each device you use.</p>
      <ul className="projects">
        {keys.map((k) => <li key={k.id}>{k.name}<button className="ghost danger" onClick={() => void remove(k.id, k.name)}>Remove</button></li>)}
      </ul>
      <form className="inline" onSubmit={add}>
        <label htmlFor="passkey-name" className="sr">Passkey name</label>
        <input id="passkey-name" placeholder="Name this device, for example Phone" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary">Add a passkey</button>
      </form>
      {msg && <p className="err" role="alert">{msg}</p>}
    </section>
  );
}

type Approval = { id: string; agent: string; summary: string; risk: string; reason: string };

function OfficeCard(p: { office: OfficeInfo; hub: HubClient; device: Device | null; pinnedKey: string | undefined; onPinned: (k: string) => void; onOpen: () => void; onDelete: () => void }) {
  const { office: o, hub, device, pinnedKey } = p;
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [fp, setFp] = useState("");
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const st = o.status;

  const run = useMemo(() => officeRunner(hub, device, o.id, pinnedKey), [device, hub, o.id, pinnedKey]);

  const guard = async (fn: () => Promise<void>) => {
    setMsg(null);
    try { await fn(); } catch (e) { setMsg({ kind: "err", text: (e as Error).message }); }
  };

  useEffect(() => { if (pinnedKey) void fingerprint(pinnedKey).then(setFp); }, [pinnedKey]);

  const loadApprovals = useCallback(async () => {
    try { setApprovals(await run<Approval[]>("approvals.list")); } catch { /* shown on demand */ }
  }, [run]);
  useEffect(() => { if (pinnedKey && o.online) void loadApprovals(); }, [pinnedKey, o.online, st?.pendingApprovals, loadApprovals]);

  const pair = (e: FormEvent) => {
    e.preventDefault();
    void guard(async () => {
      if (!device || !o.hostPublicKey) throw new Error("This office has not connected yet.");
      const proof = await pairingProof(code, "device", device.publicKey, o.hostPublicKey);
      const res = await hub.request<any>(o.id, { type: "pair.request", deviceId: device.deviceId, deviceName: device.name, devicePublicKey: device.publicKey, hostPublicKey: o.hostPublicKey, proof }, "pair");
      if (res.type !== "pair.accepted") throw new Error(res.reason === "bad_proof" ? "That code is not right. After 3 wrong tries the host asks for a new one." : `Pairing refused: ${res.reason}`);
      const genuine = res.hostPublicKey === o.hostPublicKey && (await verifyPairingProof(code, "host", device.publicKey, res.hostPublicKey, res.proof));
      if (!genuine) throw new Error("The host did not prove it knows the code. Do not trust this connection.");
      await pinHost(o.id, res.hostPublicKey);
      p.onPinned(res.hostPublicKey);
      setCode("");
      setMsg({ kind: "ok", text: "Paired. Check that the fingerprint below matches the one printed on the machine." });
    });
  };

  const resolve = (a: Approval, approve: boolean) =>
    guard(async () => {
      const r = await run<{ status: string; reason?: string }>("approval.resolve", { approvalId: a.id, approve });
      setMsg({ kind: "ok", text: approve ? `Approved. Result: ${r.status}.` : "Denied." });
      await loadApprovals();
    });

  const chip = useMemo(() => (o.online ? <span className="chip on">Online</span> : <span className="chip">Offline</span>), [o.online]);

  return (
    <article className={"panel office" + (o.online ? "" : " off")}>
      <div className="row"><h2>{o.name}</h2>{chip}</div>
      <p className="muted">{o.hostPublicKey ? (o.online ? "Connected now" : `Last seen ${ago(o.lastSeen)}`) : "Waiting for the host to enroll"}</p>
      {st && (
        <dl className="stats">
          <div><dt>Working</dt><dd>{st.agents.working} / {st.agents.total}</dd></div>
          <div><dt>Waiting for you</dt><dd>{st.pendingApprovals}</dd></div>
          <div><dt>Tokens today</dt><dd>{st.tokensToday.toLocaleString()}</dd></div>
          {st.tickets && <div><dt>Open tickets</dt><dd>{st.tickets.open}</dd></div>}
        </dl>
      )}
      {st && st.projects.length > 0 && <ul className="projects">{st.projects.map((pr) => <li key={pr.id}>{pr.name}<span className="muted">{pr.agents} agents</span></li>)}</ul>}

      {o.hostPublicKey && !pinnedKey && (
        <form className="inline" onSubmit={pair}>
          <label htmlFor={`code-${o.id}`} className="sr">Pairing code</label>
          <input id={`code-${o.id}`} placeholder="Pairing code from the machine" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" required />
          <button className="primary" disabled={!o.online}>Pair this device</button>
        </form>
      )}

      {pinnedKey && (
        <>
          <p className="muted">Paired. Host key fingerprint: <code>{fp}</code></p>
          <div className="btns">
            <button className="primary" disabled={!o.online} onClick={p.onOpen}>Open office</button>
            <button className="ghost" disabled={!o.online} onClick={() => void guard(async () => { const r = await run<{ officeName: string }>("ping"); setMsg({ kind: "ok", text: `${r.officeName} answered and the reply was signed by its host.` }); })}>Send test command</button>
            <button className="ghost" disabled={!o.online} onClick={() => void loadApprovals()}>Refresh approvals</button>
          </div>
          {approvals.map((a) => (
            <div className="approval" key={a.id}>
              <b>{a.agent}</b> wants to <code>{a.summary}</code>
              <p className="muted">{a.reason}</p>
              <div className="btns">
                <button className="primary" onClick={() => void resolve(a, true)}>Approve</button>
                <button className="ghost danger" onClick={() => void resolve(a, false)}>Deny</button>
              </div>
            </div>
          ))}
        </>
      )}
      {msg && <p className={msg.kind === "ok" ? "ok" : "err"} role="status">{msg.text}</p>}
      <div className="btns"><button className="ghost danger" onClick={p.onDelete}>Delete office</button></div>
    </article>
  );
}

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { Runner } from "./lib/commands";

/* The tool review screen: what each connection offers, how you rated each tool, and who may use it. */

type Risk = "read" | "write" | "destructive";
interface Conn {
  id: string; projectId: string; service: string; label: string; kind: string; hasCredential: boolean; connected: boolean;
  tools: { total: number; reviewed: number; needReview: number; changed: number; readOnlyUnreviewed: number };
}
interface Tool {
  name: string; description: string; suggestedRisk: Risk; suggestedOutbound: boolean; suggestedResourceArg?: string; suggestedResourceArgs?: string[];
  args: string[]; requiredArgs: string[]; hash: string; reviewed: boolean; changed: boolean;
  current?: { risk: Risk; outbound?: boolean; resourceArg?: string; resourceArgs?: string[] };
}
interface Grant { id: string; projectId: string; agentId: string; agentName: string; connectionId: string; tools: string[]; resources: string[]; expiresAt?: number; expired: boolean }
interface Member { id: string; name: string; role: string; projectId: string; kind?: string; hasEngine: boolean }
interface Team { projects: { id: string; name: string }[]; agents: Member[] }

const RISK: Record<Risk, string> = { read: "Only looks", write: "Changes things", destructive: "Can destroy things" };
const limitOf = (c: Tool["current"]) => (c?.resourceArgs?.length ? c.resourceArgs.join(" + ") : c?.resourceArg ?? "");

export function ToolsTab({ run, team }: { run: Runner; team: Team }) {
  const [conns, setConns] = useState<Conn[] | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [c, g] = await Promise.all([run<Conn[]>("connections.list"), run<Grant[]>("grants.list")]);
      setConns(c); setGrants(g); setError("");
    } catch (e) { setError((e as Error).message); }
  }, [run]);
  useEffect(() => { void load(); }, [load]);

  if (!conns) return error ? <p className="err" role="alert">{error}</p> : <p className="muted">Loading…</p>;
  return (
    <>
      {error && <p className="err" role="alert">{error}</p>}
      {conns.length === 0 && (
        <div className="empty">
          <p><b>No tools connected yet.</b></p>
          <p>Connecting a service needs a key or token. That must never pass through this page or the cloud hub, so it is typed on the office machine:</p>
          <pre>npm run github</pre>
          <p>Once connected, it appears here and you decide what each tool may do and who may use it.</p>
        </div>
      )}
      {team.projects.map((pr) => {
        const list = conns.filter((c) => c.projectId === pr.id);
        if (list.length === 0) return null;
        return (
          <section key={pr.id}>
            <h2 className="proj">{pr.name}</h2>
            {list.map((c) => <Connection key={c.id} conn={c} run={run} team={team} grants={grants.filter((g) => g.projectId === c.projectId && g.connectionId === c.id)} reload={load} />)}
          </section>
        );
      })}
      <p className="muted small">How approval works: a tool you rated <b>Only looks</b> runs on its own. <b>Changes things</b> runs on its own for teammates in the normal mode, but not in "ask before every action". <b>Destructive</b> tools, tools that send messages out, and any tool you have not reviewed always ask you first.</p>
    </>
  );
}

function Connection({ conn: c, run, team, grants, reload }: { conn: Conn; run: Runner; team: Team; grants: Grant[]; reload: () => Promise<void> }) {
  const [panel, setPanel] = useState<"" | "review" | "access">(c.tools.needReview + c.tools.changed > 0 ? "review" : "access");
  const [msg, setMsg] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const act = async (fn: () => Promise<unknown>) => { setMsg(""); try { await fn(); await reload(); } catch (e) { setMsg((e as Error).message); } };
  const t = c.tools;

  return (
    <article className="panel conn">
      <div className="row">
        <div><h3 className="ctitle">{c.service} <span className="muted">· {c.label}</span></h3>
          <p className="muted small">{t.total} tools · {c.hasCredential ? "token in the vault on the office machine" : "no credential"} · {c.connected ? "connected" : "reconnects when used"}</p></div>
        <div className="chips">
          <span className="chip tone-ok">{t.reviewed} reviewed</span>
          {t.needReview > 0 && <span className="chip tone-you">{t.needReview} to review</span>}
          {t.changed > 0 && <span className="chip tone-bad">{t.changed} changed</span>}
        </div>
      </div>
      <div className="tabs sub" role="tablist">
        <button role="tab" aria-selected={panel === "review"} className={panel === "review" ? "on" : ""} onClick={() => setPanel(panel === "review" ? "" : "review")}>Review tools</button>
        <button role="tab" aria-selected={panel === "access"} className={panel === "access" ? "on" : ""} onClick={() => setPanel(panel === "access" ? "" : "access")}>Who can use it ({grants.length})</button>
      </div>
      {msg && <p className="err" role="alert">{msg}</p>}
      {panel === "review" && <Review conn={c} run={run} reload={reload} />}
      {panel === "access" && <Access conn={c} run={run} team={team} grants={grants} reload={reload} />}
      <div className="btns">
        <button className="ghost" onClick={() => void act(() => run("connections.refresh", { projectId: c.projectId, connectionId: c.id }))}>Check the server for changes</button>
        {!confirmRemove ? <button className="ghost danger" onClick={() => setConfirmRemove(true)}>Remove</button> : (
          <span className="inline"><span className="err">Removes this connection, every grant on it, and the stored token.</span>
            <button className="ghost danger" onClick={() => void act(() => run("connections.remove", { projectId: c.projectId, connectionId: c.id }))}>Yes, remove it</button>
            <button className="ghost" onClick={() => setConfirmRemove(false)}>Keep</button></span>
        )}
      </div>
    </article>
  );
}

// ------------------------------------------------------------------ review

interface Draft { risk: Risk | ""; outbound: boolean; limit: string }

function Review({ conn: c, run, reload }: { conn: Conn; run: Runner; reload: () => Promise<void> }) {
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [filter, setFilter] = useState<"todo" | "all">("todo");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [msg, setMsg] = useState("");
  const base = { projectId: c.projectId, connectionId: c.id };

  const fetchTools = useCallback(async () => {
    try { setTools(await run<Tool[]>("tools.discovered", { projectId: c.projectId, connectionId: c.id })); } catch (e) { setMsg((e as Error).message); }
  }, [run, c.projectId, c.id]);
  useEffect(() => { void fetchTools(); }, [fetchTools, c.tools.reviewed, c.tools.changed, c.tools.needReview]);

  const draftOf = (t: Tool): Draft => drafts[t.name] ?? { risk: t.current?.risk ?? "", outbound: t.current?.outbound ?? false, limit: limitOf(t.current) };
  const set = (t: Tool, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [t.name]: { ...draftOf(t), ...patch } }));
  const item = (t: Tool, d: Draft) => ({ tool: t.name, hash: t.hash, risk: d.risk as Risk, ...(d.outbound ? { outbound: true } : {}), ...(d.limit ? { resourceArgs: d.limit.split(" + ") } : {}) });
  const after = async () => { setDrafts({}); await fetchTools(); await reload(); };
  const save = (items: ReturnType<typeof item>[]) => { setMsg(""); run("tools.reviewMany", { ...base, items }).then(after).catch(async (e) => { setMsg((e as Error).message); await fetchTools(); }); };

  const shown = useMemo(() => (tools ?? []).filter((t) => filter === "all" || !t.reviewed), [tools, filter]);
  const readOnly = (tools ?? []).filter((t) => !t.reviewed && !t.changed && t.suggestedRisk === "read");
  if (!tools) return <p className="muted">{msg || "Loading…"}</p>;

  return (
    <div className="review">
      {readOnly.length > 0 && (
        <div className="note bulk">
          <p><b>{readOnly.length} tools say they only read.</b> A server can be wrong or lie, so nothing is trusted until you confirm it. If you agree, this marks them "Only looks" and limits each to a repository where it names one.</p>
          <button className="primary" onClick={() => save(readOnly.map((t) => item(t, { risk: "read", outbound: false, limit: (t.suggestedResourceArgs ?? (t.suggestedResourceArg ? [t.suggestedResourceArg] : [])).join(" + ") })))}>Confirm these {readOnly.length} as "Only looks"</button>
        </div>
      )}
      <div className="filters" role="group" aria-label="Show tools">
        <button className={filter === "todo" ? "on" : ""} aria-pressed={filter === "todo"} onClick={() => setFilter("todo")}>Needs review</button>
        <button className={filter === "all" ? "on" : ""} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All {tools.length}</button>
      </div>
      {msg && <p className="err" role="alert">{msg}</p>}
      {shown.length === 0 && <div className="empty">{filter === "todo" ? "Every tool has been reviewed." : "No tools."}</div>}
      <ul className="toolrows">
        {shown.map((t) => {
          const d = draftOf(t);
          const dirty = t.current?.risk !== d.risk || Boolean(t.current?.outbound) !== d.outbound || limitOf(t.current) !== d.limit;
          const limits = [...new Set([...(t.suggestedResourceArgs ? [t.suggestedResourceArgs.join(" + ")] : []), ...t.requiredArgs])];
          return (
            <li key={t.name} className={"tool" + (t.changed ? " changed" : "")}>
              <div className="thead">
                <code className="tname">{t.name}</code>
                {t.changed ? <span className="chip tone-bad">Changed since you reviewed it</span> : t.reviewed ? <span className="chip tone-ok">Reviewed</span> : <span className="chip tone-you">Not reviewed</span>}
                <span className="chip">server says: {RISK[t.suggestedRisk].toLowerCase()}</span>
              </div>
              <p className="tdesc">{t.description || <span className="muted">No description.</span>}</p>
              {t.changed && <p className="err">The server changed this tool after you approved it, so it asks for approval every time until you read it again and confirm.</p>}
              <div className="tedit">
                <div><label htmlFor={`r-${c.id}-${t.name}`}>What it does</label>
                  <select id={`r-${c.id}-${t.name}`} value={d.risk} onChange={(e) => set(t, { risk: e.target.value as Risk })}>
                    <option value="">Choose…</option>
                    {(Object.keys(RISK) as Risk[]).map((r) => <option key={r} value={r}>{RISK[r]}</option>)}
                  </select></div>
                <div><label htmlFor={`l-${c.id}-${t.name}`}>Limit to a resource by</label>
                  <select id={`l-${c.id}-${t.name}`} value={d.limit} onChange={(e) => set(t, { limit: e.target.value })}>
                    <option value="">Cannot be limited (no required argument names a resource)</option>
                    {limits.map((l) => <option key={l} value={l}>{l}</option>)}
                  </select></div>
                <label className="check"><input type="checkbox" checked={d.outbound} onChange={(e) => set(t, { outbound: e.target.checked })} /> Sends something out (message, post, email)</label>
                <button className="ghost" disabled={!d.risk || (!dirty && t.reviewed)} onClick={() => save([item(t, d)])}>{t.reviewed ? "Save" : "Confirm"}</button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ access

const EXPIRY = [["", "Never expires"], ["1", "1 hour"], ["24", "1 day"], ["168", "7 days"], ["720", "30 days"]] as const;
const when = (t: number) => new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function Access({ conn: c, run, team, grants, reload }: { conn: Conn; run: Runner; team: Team; grants: Grant[]; reload: () => Promise<void> }) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [agent, setAgent] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [resources, setResources] = useState("");
  const [expiry, setExpiry] = useState("");
  const [err, setErr] = useState("");
  const members = team.agents.filter((a) => a.projectId === c.projectId && a.kind !== "manager" && a.hasEngine);

  useEffect(() => { void run<Tool[]>("tools.discovered", { projectId: c.projectId, connectionId: c.id }).then(setTools).catch((e) => setErr((e as Error).message)); }, [run, c.projectId, c.id, c.tools.reviewed]);

  const limitable = (t: Tool) => Boolean(t.current && (t.current.resourceArgs?.length || t.current.resourceArg));
  const wantsLimit = resources.trim() !== "";
  const blocked = wantsLimit ? tools.filter((t) => picked.has(t.name) && !limitable(t)) : [];
  const toggle = (n: string) => setPicked((p) => { const x = new Set(p); x.has(n) ? x.delete(n) : x.add(n); return x; });

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr("");
    try {
      await run("grants.add", {
        projectId: c.projectId, connectionId: c.id, agentId: agent, tools: [...picked],
        resources: resources.split(/[,\n]/).map((s) => s.trim()).filter(Boolean), ...(expiry ? { expiresInHours: Number(expiry) } : {}),
      });
      setPicked(new Set()); setResources(""); await reload();
    } catch (x) { setErr((x as Error).message); }
  };
  const revoke = (id: string) => run("grants.revoke", { grantId: id }).then(reload).catch((x) => setErr((x as Error).message));

  const reviewedFirst = [...tools].sort((a, b) => Number(b.reviewed) - Number(a.reviewed) || a.name.localeCompare(b.name));

  return (
    <div className="access">
      {grants.length === 0 ? <p className="muted">No one can use this connection yet.</p> : (
        <ul className="grants">
          {grants.map((g) => (
            <li key={g.id} className={g.expired ? "expired" : ""}>
              <div><b>{g.agentName}</b> may use <span title={g.tools.join(", ")}>{g.tools.length} tool{g.tools.length === 1 ? "" : "s"}</span>
                {g.resources.length > 0 ? <> only on <code>{g.resources.join(", ")}</code></> : <> on <b>anything</b> the connection can reach</>}
                {g.expiresAt && <span className="muted"> · {g.expired ? "expired" : "until"} {when(g.expiresAt)}</span>}
                <div className="muted small">{g.tools.join(", ")}</div></div>
              <button className="ghost danger" onClick={() => void revoke(g.id)}>Take away</button>
            </li>
          ))}
        </ul>
      )}
      {members.length === 0 ? <p className="muted">Add a teammate on the Team tab to give them access.</p> : (
        <form className="note" onSubmit={submit}>
          <h4>Give access</h4>
          <div className="grid2">
            <div><label htmlFor={`ga-${c.id}`}>Who</label>
              <select id={`ga-${c.id}`} value={agent} onChange={(e) => setAgent(e.target.value)} required><option value="">Choose a teammate…</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}, {m.role}</option>)}</select></div>
            <div><label htmlFor={`ge-${c.id}`}>For how long</label>
              <select id={`ge-${c.id}`} value={expiry} onChange={(e) => setExpiry(e.target.value)}>{EXPIRY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          </div>
          <label htmlFor={`gr-${c.id}`}>Only on these resources (optional, comma separated)</label>
          <input id={`gr-${c.id}`} value={resources} onChange={(e) => setResources(e.target.value)} placeholder="owner/repo, owner/*" />
          <fieldset className="picks"><legend>Which tools</legend>
            <div className="btns"><button type="button" className="ghost" onClick={() => setPicked(new Set(tools.filter((t) => t.reviewed && t.current?.risk === "read" && (!wantsLimit || limitable(t))).map((t) => t.name)))}>Pick every reviewed "only looks" tool</button>
              <button type="button" className="ghost" onClick={() => setPicked(new Set())}>Clear</button></div>
            <ul>
              {reviewedFirst.map((t) => (
                <li key={t.name}><label className="check"><input type="checkbox" checked={picked.has(t.name)} onChange={() => toggle(t.name)} />
                  <code>{t.name}</code>
                  {!t.reviewed ? <span className="chip tone-you">asks every time</span> : t.current?.risk === "destructive" ? <span className="chip tone-bad">destructive: asks every time</span> : t.current?.outbound ? <span className="chip tone-you">sends out: asks every time</span> : <span className="chip">{RISK[t.current!.risk].toLowerCase()}</span>}
                  {wantsLimit && !limitable(t) && <span className="muted small"> cannot be limited</span>}</label></li>
              ))}
            </ul>
          </fieldset>
          {blocked.length > 0 && <p className="err">With a resource limit, these cannot be used: {blocked.map((t) => t.name).join(", ")}. Review them with a "limit to a resource by" choice, or clear the limit.</p>}
          {!wantsLimit && picked.size > 0 && <p className="warn">No resource limit: this teammate can use these tools on <b>anything</b> the token can reach. Add a limit unless you mean that.</p>}
          {err && <p className="err" role="alert">{err}</p>}
          <button className="primary" disabled={!agent || picked.size === 0 || blocked.length > 0}>Give access</button>
        </form>
      )}
    </div>
  );
}

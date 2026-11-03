import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { Ticket, TicketStatus, TicketUsage } from "@agent-office/shared";
import type { Device } from "./lib/device";
import type { HubClient, OfficeInfo } from "./lib/hub";
import { officeRunner, type Runner } from "./lib/commands";
import { ToolsTab } from "./Tools";

type Summary = Pick<Ticket, "id" | "projectId" | "title" | "status" | "priority" | "assigneeId" | "question" | "usage" | "createdAt" | "updatedAt" | "parentId" | "afterId" | "budgetTokens" | "maxRounds"> & {
  rolledUp?: TicketUsage; subtickets?: number; blockedBy?: string;
};
type Detailed = Ticket & { rolledUp: TicketUsage; subtickets: Summary[]; blockedBy?: string };
interface Member { id: string; name: string; role: string; skills?: string; projectId: string; status: string; kind?: string; tokensToday: number; hasEngine: boolean; openTickets: number; sleepUntil?: number }
interface Team { projects: { id: string; name: string }[]; agents: Member[] }
interface Approval { id: string; agent: string; summary: string; risk: string; reason: string }

const STATUS: Record<TicketStatus, { label: string; tone: "idle" | "work" | "you" | "ok" | "bad" }> = {
  new: { label: "Waiting for the Manager", tone: "idle" },
  planning: { label: "Manager is deciding", tone: "work" },
  assigned: { label: "Queued", tone: "idle" },
  progress: { label: "Working", tone: "work" },
  waiting_approval: { label: "Needs your approval", tone: "you" },
  waiting_user: { label: "Needs your answer", tone: "you" },
  done: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "idle" },
};
// The board's columns. Failed and cancelled tickets sit with Done, marked by their own chip.
const COLUMNS: { title: string; statuses: TicketStatus[] }[] = [
  { title: "New", statuses: ["new"] },
  { title: "Planning", statuses: ["planning", "assigned"] },
  { title: "In progress", statuses: ["progress"] },
  { title: "Waiting for you", statuses: ["waiting_approval", "waiting_user"] },
  { title: "Done", statuses: ["done", "failed", "cancelled"] },
];
const OPEN: TicketStatus[] = ["new", "planning", "assigned", "progress", "waiting_approval", "waiting_user"];

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const usd = (n: number) => (n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

function StatusChip({ status }: { status: TicketStatus }) {
  const s = STATUS[status];
  return <span className={`chip tone-${s.tone}`}>{s.label}</span>;
}

function Usage({ u }: { u: TicketUsage }) {
  if (!u.runs) return <span className="muted">no usage yet</span>;
  return (
    <span title="What these runs would have cost on the pay-per-use API. On a flat Claude plan nothing extra is charged, but they count towards your plan's usage limit.">
      {u.tokens.toLocaleString()} tokens · ≈{usd(u.costUsd)} API value
    </span>
  );
}

export function OfficeView(p: { office: OfficeInfo; hub: HubClient; device: Device | null; pinnedKey: string | undefined; onBack: () => void }) {
  const { office, hub } = p;
  const run = useMemo(() => officeRunner(hub, p.device, office.id, p.pinnedKey), [hub, p.device, office.id, p.pinnedKey]);
  const [tab, setTab] = useState<"tickets" | "team" | "tools">("tickets");
  const [team, setTeam] = useState<Team>({ projects: [], agents: [] });
  const [tickets, setTickets] = useState<Summary[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [error, setError] = useState("");

  const name = useCallback((id: string) => team.agents.find((a) => a.id === id)?.name ?? (id === "user" ? "You" : id === "office" ? "The office" : id), [team]);

  const load = useCallback(async () => {
    try {
      const [t, tk, ap] = await Promise.all([run<Team>("team.list"), run<Summary[]>("tickets.list"), run<Approval[]>("approvals.list")]);
      setTeam(t); setTickets(tk); setApprovals(ap); setError("");
    } catch (e) { setError((e as Error).message); }
  }, [run]);

  // Refresh now, every few seconds, and whenever the office reports a change.
  const snapshotKey = JSON.stringify(office.status?.tickets) + String(office.status?.pendingApprovals);
  useEffect(() => { void load(); }, [load, snapshotKey]);
  useEffect(() => { const t = setInterval(() => void load(), 5000); return () => clearInterval(t); }, [load]);

  return (
    <>
      <div className="row">
        <div>
          <button className="ghost" onClick={p.onBack}>← Offices</button>
        </div>
        <span className={"chip" + (office.online ? " on" : "")}>{office.online ? "Online" : "Offline"}</span>
      </div>
      <h1 style={{ marginTop: 14 }}>{office.name}</h1>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "tickets"} className={tab === "tickets" ? "on" : ""} onClick={() => setTab("tickets")}>
          Tickets{tickets.filter((t) => t.status === "waiting_user" || t.status === "waiting_approval").length > 0 && <span className="dot" aria-label="needs you" />}
        </button>
        <button role="tab" aria-selected={tab === "team"} className={tab === "team" ? "on" : ""} onClick={() => setTab("team")}>Team</button>
        <button role="tab" aria-selected={tab === "tools"} className={tab === "tools" ? "on" : ""} onClick={() => setTab("tools")}>Tools</button>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      {tab === "tickets" ? (
        <Tickets run={run} team={team} tickets={tickets} approvals={approvals} name={name} reload={load} />
      ) : tab === "team" ? (
        <TeamTab run={run} team={team} reload={load} />
      ) : (
        <ToolsTab run={run} team={team} />
      )}
    </>
  );
}

// ---------------------------------------------------------------- tickets

function Tickets(p: { run: Runner; team: Team; tickets: Summary[]; approvals: Approval[]; name: (id: string) => string; reload: () => Promise<void> }) {
  const [filter, setFilter] = useState<"open" | "done" | "all">("open");
  const [selected, setSelected] = useState<string | null>(null);
  const [showNew, setShowNew] = useState<false | { parentId?: string }>(false);
  const [view, setView] = useState<"list" | "board">("list");
  const [showSub, setShowSub] = useState(false);
  const [query, setQuery] = useState("");
  const [msg, setMsg] = useState("");
  // "Open" also keeps tickets that finished in the last 10 minutes, so you see the result of what you just asked for.
  const recent = (t: Summary) => Date.now() - t.updatedAt < 10 * 60_000;
  const q = query.trim().toLowerCase();
  const byFilter = (t: Summary) => (filter === "all" ? true : filter === "open" ? OPEN.includes(t.status) || recent(t) : !OPEN.includes(t.status));
  // A search looks at every ticket, subtickets included. Otherwise subtickets are tucked under their parent unless you ask for them.
  const matches = (t: Summary) => !q || t.id.toLowerCase() === q || t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q);
  const shown = p.tickets.filter((t) => byFilter(t) && matches(t) && (showSub || q !== "" || !t.parentId));
  const needsYou = p.tickets.filter((t) => t.status === "waiting_user");

  const act = async (fn: () => Promise<unknown>) => {
    setMsg("");
    try { await fn(); await p.reload(); } catch (e) { setMsg((e as Error).message); }
  };

  return (
    <>
      {(needsYou.length > 0 || p.approvals.length > 0) && (
        <section className="panel needs" aria-label="Needs you">
          <h2>Needs you</h2>
          {p.approvals.map((a) => (
            <div className="approval" key={a.id}>
              <b>{a.agent}</b> wants to <code>{a.summary}</code>
              <p className="muted">{a.reason}</p>
              <div className="btns">
                <button className="primary" onClick={() => void act(() => p.run("approval.resolve", { approvalId: a.id, approve: true }))}>Approve</button>
                <button className="ghost danger" onClick={() => void act(() => p.run("approval.resolve", { approvalId: a.id, approve: false }))}>Deny</button>
              </div>
            </div>
          ))}
          {needsYou.map((t) => <Question key={t.id} t={t} onReply={(text) => act(() => p.run("tickets.reply", { id: t.id, text }))} onOpen={() => setSelected(t.id)} name={p.name} />)}
        </section>
      )}

      {showNew || p.team.projects.length === 0 ? (
        <NewTicket run={p.run} team={p.team} tickets={p.tickets} parentId={showNew ? showNew.parentId : undefined} onCancel={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); setSelected(id); void p.reload(); }} />
      ) : (
        <div className="btns"><button className="primary" onClick={() => setShowNew({})}>+ New ticket</button></div>
      )}

      <div className="filters" role="group" aria-label="Show">
        {(["open", "done", "all"] as const).map((f) => (
          <button key={f} className={filter === f ? "on" : ""} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === "open" ? "Open and recent" : f === "done" ? "Finished" : "All"}
          </button>
        ))}
      </div>
      <div className="toolbar">
        <label className="sr" htmlFor="t-search">Search tickets</label>
        <input id="t-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by number or words" />
        <label className="check"><input type="checkbox" checked={showSub} onChange={(e) => setShowSub(e.target.checked)} /> Show subtickets</label>
        <div className="filters" role="group" aria-label="View">
          {(["list", "board"] as const).map((v) => <button key={v} className={view === v ? "on" : ""} aria-pressed={view === v} onClick={() => setView(v)}>{v === "list" ? "List" : "Board"}</button>)}
        </div>
      </div>
      {msg && <p className="err" role="alert">{msg}</p>}
      {view === "board" ? (
        <div className="board">
          {COLUMNS.map((c) => {
            const col = shown.filter((t) => c.statuses.includes(t.status));
            return (
              <section key={c.title} className="col" aria-label={c.title}>
                <h3>{c.title} <span className="muted">{col.length}</span></h3>
                {col.map((t) => (
                  <button key={t.id} className={"card" + (selected === t.id ? " sel" : "")} onClick={() => setSelected(selected === t.id ? null : t.id)}>
                    <span className="tid">{t.id}</span> <span className="ttitle">{t.title}</span>
                    {(t.status === "failed" || t.status === "cancelled") && <StatusChip status={t.status} />}
                    <span className="tmeta muted">{t.assigneeId ? p.name(t.assigneeId) : "No one yet"}{t.rolledUp?.runs ? ` · ${t.rolledUp.tokens.toLocaleString()} tokens` : ""}</span>
                    {t.blockedBy && <span className="tmeta muted">Waits for {t.blockedBy}</span>}
                    {t.subtickets ? <span className="tmeta muted">{t.subtickets} subticket{t.subtickets === 1 ? "" : "s"}</span> : null}
                  </button>
                ))}
              </section>
            );
          })}
          {selected && <div className="boarddetail"><Detail id={selected} run={p.run} team={p.team} name={p.name} reload={p.reload} onSub={(parentId) => setShowNew({ parentId })} onOpen={setSelected} /></div>}
        </div>
      ) : (
        <div className="tickets">
          {shown.map((t) => (
            <div key={t.id}>
              <button className={"ticket" + (selected === t.id ? " sel" : "")} onClick={() => setSelected(selected === t.id ? null : t.id)} aria-expanded={selected === t.id}>
                <span className="tid">{t.id}</span>
                <span className="ttitle">{t.parentId ? <span className="muted">↳ {t.parentId} · </span> : null}{t.title}</span>
                <StatusChip status={t.status} />
                <span className="tmeta muted">{t.assigneeId ? p.name(t.assigneeId) : "No one yet"} · {ago(t.updatedAt)}{t.subtickets ? ` · ${t.subtickets} subticket${t.subtickets === 1 ? "" : "s"}` : ""}{t.blockedBy ? ` · waits for ${t.blockedBy}` : ""}</span>
              </button>
              {selected === t.id && <Detail id={t.id} run={p.run} team={p.team} name={p.name} reload={p.reload} onSub={(parentId) => setShowNew({ parentId })} onOpen={setSelected} />}
            </div>
          ))}
          {shown.length === 0 && <div className="empty">{q ? "No ticket matches that." : filter === "open" ? "Nothing open or recent. Create a ticket above." : "Nothing here yet."}</div>}
        </div>
      )}
    </>
  );
}

function Question({ t, onReply, onOpen, name }: { t: Summary; onReply: (text: string) => Promise<void>; onOpen: () => void; name: (id: string) => string }) {
  const [text, setText] = useState("");
  return (
    <form className="approval" onSubmit={(e) => { e.preventDefault(); void onReply(text).then(() => setText("")); }}>
      <button type="button" className="linkish" onClick={onOpen}><b>{t.id}</b> {t.title}</button>
      <p>{t.question}</p>
      <div className="inline">
        <label className="sr" htmlFor={`reply-${t.id}`}>Your answer</label>
        <input id={`reply-${t.id}`} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Answer ${t.assigneeId ? name(t.assigneeId) : "the Manager"}`} required />
        <button className="primary">Send</button>
      </div>
    </form>
  );
}

function NewTicket({ run, team, tickets, parentId: presetParent, onCreated, onCancel }: { run: Runner; team: Team; tickets: Summary[]; parentId?: string; onCreated: (id: string) => void; onCancel: () => void }) {
  const preset = presetParent ? tickets.find((x) => x.id === presetParent) : undefined;
  const [projectId, setProjectId] = useState(preset?.projectId ?? "");
  const [parent, setParent] = useState(presetParent ?? "");
  const [after, setAfter] = useState("");
  const [budget, setBudget] = useState("");
  const [rounds, setRounds] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("normal");
  const [assignee, setAssignee] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const pid = projectId || team.projects[0]?.id || "";
  const related = tickets.filter((x) => x.projectId === pid);
  const members = team.agents.filter((a) => a.projectId === pid && a.kind !== "manager" && a.hasEngine);
  const hasManager = team.agents.some((a) => a.projectId === pid && a.kind === "manager");

  if (team.projects.length === 0) return <div className="empty">Add a project on the Team tab first, then you can create tickets.</div>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const t = await run<Summary>("tickets.create", { projectId: pid, title, description, priority, ...(assignee ? { assigneeId: assignee } : {}),
        ...(parent ? { parentId: parent } : {}), ...(after ? { afterId: after } : {}),
        ...(budget ? { budgetTokens: Number(budget) } : {}), ...(rounds ? { maxRounds: Number(rounds) } : {}) });
      setTitle(""); setDescription(""); setAssignee(""); setParent(""); setAfter(""); setBudget(""); setRounds("");
      onCreated(t.id);
    } catch (x) { setErr((x as Error).message); }
    setBusy(false);
  };

  return (
    <form className="panel newticket" onSubmit={submit}>
      <h2>New ticket</h2>
      <div className="grid2">
        <div><label htmlFor="nt-title">What needs doing?</label><input id="nt-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required placeholder="Short title" /></div>
        <div><label htmlFor="nt-project">Project</label>
          <select id="nt-project" value={pid} onChange={(e) => { setProjectId(e.target.value); setAssignee(""); setParent(""); setAfter(""); }}>{team.projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
      </div>
      <label htmlFor="nt-desc">Details (optional)</label>
      <textarea id="nt-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={8000} rows={3} placeholder="Anything the agent should know. This never leaves your machine except to your own Claude Code." />
      <div className="grid2">
        <div><label htmlFor="nt-who">Who takes it?</label>
          <select id="nt-who" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">{hasManager ? "Let the Manager decide" : "No one yet (no Manager in this project)"}</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}, {m.role}</option>)}
          </select></div>
        <div><label htmlFor="nt-pri">Priority</label>
          <select id="nt-pri" value={priority} onChange={(e) => setPriority(e.target.value)}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></div>
      </div>
      <div className="grid2">
        <div><label htmlFor="nt-parent">Part of (optional)</label>
          <select id="nt-parent" value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">Not a subticket</option>
            {related.map((x) => <option key={x.id} value={x.id}>{x.id} {x.title}</option>)}
          </select></div>
        <div><label htmlFor="nt-after">Starts after (optional)</label>
          <select id="nt-after" value={after} onChange={(e) => setAfter(e.target.value)}>
            <option value="">No need to wait</option>
            {related.map((x) => <option key={x.id} value={x.id}>{x.id} {x.title}</option>)}
          </select></div>
      </div>
      <div className="grid2">
        <div><label htmlFor="nt-budget">Token budget (optional)</label>
          <input id="nt-budget" type="number" min={1000} step={1000} value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="Ask me after this many tokens" /></div>
        <div><label htmlFor="nt-rounds">Most rounds (default 6)</label>
          <input id="nt-rounds" type="number" min={1} max={50} value={rounds} onChange={(e) => setRounds(e.target.value)} placeholder="6" /></div>
      </div>
      {err && <p className="err" role="alert">{err}</p>}
      <div className="btns"><button className="primary" disabled={busy}>{busy ? "Creating…" : "Create ticket"}</button><button type="button" className="ghost" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

function Detail({ id, run, team, name, reload, onSub, onOpen }: { id: string; run: Runner; team: Team; name: (id: string) => string; reload: () => Promise<void>; onSub: (parentId: string) => void; onOpen: (id: string) => void }) {
  const [t, setT] = useState<Detailed | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [who, setWho] = useState("");
  const refresh = useCallback(async () => { try { setT(await run<Detailed>("tickets.get", { id })); } catch (e) { setErr((e as Error).message); } }, [run, id]);
  useEffect(() => { void refresh(); const i = setInterval(() => void refresh(), 4000); return () => clearInterval(i); }, [refresh]);
  if (!t) return <div className="detail muted">{err || "Loading…"}</div>;

  const act = async (fn: () => Promise<unknown>) => { setErr(""); try { await fn(); await refresh(); await reload(); } catch (e) { setErr((e as Error).message); } };
  const running = t.status === "planning" || t.status === "progress" || t.status === "waiting_approval";
  const open = OPEN.includes(t.status);
  const members = team.agents.filter((a) => a.projectId === t.projectId && a.kind !== "manager" && a.hasEngine);
  const worked = Object.entries(t.workers);

  return (
    <div className="detail">
      {t.description && <p className="desc">{t.description}</p>}
      {t.result && <div className="result"><b>Result</b><p>{t.result}</p></div>}
      {t.question && <p className="ask"><b>Question:</b> {t.question}</p>}
      {(t.parentId || t.afterId) && (
        <p className="muted">
          {t.parentId && <>Part of <button className="linkish" onClick={() => onOpen(t.parentId!)}>{t.parentId}</button>. </>}
          {t.afterId && <>{t.blockedBy ? "Waits for " : "Started after "}<button className="linkish" onClick={() => onOpen(t.afterId!)}>{t.afterId}</button>.</>}
        </p>
      )}
      <p className="muted limits">
        Budget: {t.budgetTokens ? `${t.rolledUp.tokens.toLocaleString()} of ${t.budgetTokens.toLocaleString()} tokens` : "no token limit"} · Rounds: {t.usage.runs} of {t.maxRounds}
        {t.budgetTokens ? <meter min={0} max={t.budgetTokens} value={Math.min(t.rolledUp.tokens, t.budgetTokens)} aria-label="Tokens used of budget" /> : null}
      </p>

      <h3>Who worked on it</h3>
      {worked.length === 0 ? <p className="muted">No one yet.</p> : (
        <table className="who"><tbody>
          {worked.map(([id, u]) => <tr key={id}><th scope="row">{name(id)}</th><td>{u.runs} run{u.runs === 1 ? "" : "s"}</td><td><Usage u={u} /></td></tr>)}
          <tr className="total"><th scope="row">Total</th><td>{t.usage.runs} runs</td><td><Usage u={t.usage} /></td></tr>
        </tbody></table>
      )}

      {(t.subtickets.length > 0 || open) && (
        <>
          <h3>Subtickets</h3>
          {t.subtickets.length > 0 && (
            <>
              <ul className="subs">
                {t.subtickets.map((c) => <li key={c.id}><button className="linkish" onClick={() => onOpen(c.id)}>{c.id} {c.title}</button> <StatusChip status={c.status} /></li>)}
              </ul>
              <p className="muted">With subtickets: <Usage u={t.rolledUp} /></p>
            </>
          )}
          {open && <div className="btns"><button className="ghost" onClick={() => onSub(t.id)}>+ Add a subticket</button></div>}
        </>
      )}

      <h3>Timeline</h3>
      <ol className="timeline">
        {t.events.map((e, i) => (
          <li key={i}><span className="when muted">{ago(e.ts)}</span> <b>{name(e.actor)}</b> {VERB[e.kind]}{e.text ? <span className="etext">: {e.text}</span> : null}{e.tokens ? <span className="muted"> ({e.tokens.toLocaleString()} tokens)</span> : null}</li>
        ))}
      </ol>

      {err && <p className="err" role="alert">{err}</p>}
      <div className="btns">
        {!running && open && members.length > 0 && (
          <>
            <label className="sr" htmlFor={`as-${t.id}`}>Give to</label>
            <select id={`as-${t.id}`} value={who} onChange={(e) => setWho(e.target.value)}><option value="">Give to…</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
            <button className="ghost" disabled={!who} onClick={() => void act(() => run("tickets.assign", { id: t.id, agentId: who }))}>Assign</button>
          </>
        )}
        {(t.status === "failed" || t.status === "cancelled") && <button className="ghost" onClick={() => void act(() => run("tickets.retry", { id: t.id }))}>Try again</button>}
        {open && <button className="ghost danger" onClick={() => void act(() => run("tickets.cancel", { id: t.id }))}>Cancel ticket</button>}
      </div>
      <form className="inline" onSubmit={(e) => { e.preventDefault(); void act(async () => { await run("tickets.reply", { id: t.id, text: note }); setNote(""); }); }}>
        <label className="sr" htmlFor={`note-${t.id}`}>Add a note</label>
        <input id={`note-${t.id}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t.status === "waiting_user" ? "Your answer" : "Add a note (kept on the ticket)"} required maxLength={4000} />
        <button className="ghost">{t.status === "waiting_user" ? "Answer" : "Add note"}</button>
      </form>
    </div>
  );
}

const VERB: Record<string, string> = {
  created: "created the ticket", triage_started: "started deciding who should take it", assigned: "assigned it", started: "started work",
  approval_requested: "asked for your approval", approval_resolved: "got your answer", asked_user: "asked you a question", user_replied: "answered",
  comment: "added a note", finished: "finished", failed: "could not finish", cancelled: "cancelled it", rate_limited: "hit the usage limit and will try again", interrupted: "was interrupted", limit_reached: "stopped at its limit", blocked: "could not start because the ticket it waits for ended badly",
};

// ---------------------------------------------------------------- team

function TeamTab({ run, team, reload }: { run: Runner; team: Team; reload: () => Promise<void> }) {
  const [msg, setMsg] = useState("");
  const act = async (fn: () => Promise<unknown>) => { setMsg(""); try { await fn(); await reload(); } catch (e) { setMsg((e as Error).message); } };
  return (
    <>
      {msg && <p className="err" role="alert">{msg}</p>}
      {team.projects.length === 0 && <div className="empty">No projects yet. Add one below.</div>}
      {team.projects.map((pr) => {
        const members = team.agents.filter((a) => a.projectId === pr.id);
        const hasManager = members.some((m) => m.kind === "manager");
        return (
          <section className="panel" key={pr.id}>
            <div className="row"><h2>{pr.name}</h2>{!hasManager && <button className="ghost" onClick={() => void act(() => run("team.ensureManager", { projectId: pr.id }))}>Add a Manager</button>}</div>
            {!hasManager && <p className="muted">Without a Manager you give each ticket to someone yourself.</p>}
            <ul className="roster">
              {members.map((m) => (
                <li key={m.id}>
                  <span className="avatar" aria-hidden="true">{m.name.slice(0, 1)}</span>
                  <span className="who"><b>{m.name}</b> <span className="muted">{m.role}{m.skills ? ` · ${m.skills}` : ""}</span></span>
                  <span className={"chip" + (m.status === "working" ? " tone-work" : "")}>{m.status === "asleep" ? "Resting" : m.status === "working" ? "Working" : "Free"}</span>
                  <span className="muted small">{m.openTickets} open · {m.tokensToday.toLocaleString()} tokens today</span>
                </li>
              ))}
            </ul>
            <AddAgent run={run} projectId={pr.id} onDone={reload} />
          </section>
        );
      })}
      <AddProject run={run} onDone={reload} />
      <p className="muted small">New teammates start with no tools. Give them access on the Tools tab.</p>
    </>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

function AddProject({ run, onDone }: { run: Runner; onDone: () => Promise<void> }) {
  const [name, setName] = useState(""); const [err, setErr] = useState("");
  return (
    <form className="panel" onSubmit={(e) => { e.preventDefault(); setErr(""); void run("projects.add", { id: slug(name), name }).then(() => { setName(""); return onDone(); }).catch((x) => setErr((x as Error).message)); }}>
      <h2>Add a project</h2>
      <div className="inline"><label className="sr" htmlFor="pj-name">Project name</label><input id="pj-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="For example Mobile app" required maxLength={80} /><button className="primary" disabled={!slug(name)}>Add project</button></div>
      {err && <p className="err" role="alert">{err}</p>}
    </form>
  );
}

function AddAgent({ run, projectId, onDone }: { run: Runner; projectId: string; onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(""); const [role, setRole] = useState(""); const [skills, setSkills] = useState(""); const [err, setErr] = useState("");
  if (!open) return <button className="ghost" onClick={() => setOpen(true)}>Add a teammate</button>;
  return (
    <form className="note" onSubmit={(e) => { e.preventDefault(); setErr(""); void run("agents.add", { id: slug(name), name, role, skills: skills || undefined, projectId }).then(() => { setOpen(false); setName(""); setRole(""); setSkills(""); return onDone(); }).catch((x) => setErr((x as Error).message)); }}>
      <div className="grid2">
        <div><label htmlFor={`an-${projectId}`}>Name</label><input id={`an-${projectId}`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} /></div>
        <div><label htmlFor={`ar-${projectId}`}>Role</label><input id={`ar-${projectId}`} value={role} onChange={(e) => setRole(e.target.value)} placeholder="Developer, DevOps, Marketer…" required maxLength={60} /></div>
      </div>
      <label htmlFor={`as-${projectId}`}>Skills, in a few words (the Manager picks by these)</label>
      <input id={`as-${projectId}`} value={skills} onChange={(e) => setSkills(e.target.value)} maxLength={300} placeholder="typescript, code review, github" />
      {err && <p className="err" role="alert">{err}</p>}
      <div className="btns"><button className="primary" disabled={!slug(name)}>Add</button><button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

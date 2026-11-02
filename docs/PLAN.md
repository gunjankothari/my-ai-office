# Agent Office: product and architecture plan

> **Build status:** Phase 0 and the security core of Phase 1 are implemented in this repository. See the root `README.md` for what exists, what is tested, and what is still a prototype.

Working name: **Agent Office**. A UI where you manage AI agents as employees, across projects and across your own machines, with credentials that never reach the AI.

UI prototype: https://claude.ai/artifact/WPTJ3fwgQMd1D17p74pRBe

## 1. Decisions so far

| Topic | Decision |
|---|---|
| Users | Solo for now. Teams later. |
| Agents | Many per project. Each has one narrow role (developer only develops, DevOps only does DevOps). Roles span development, sales, marketing, support and more. |
| Where the UI lives | In the cloud, so it works from the web and a phone. |
| Where the AI runs | On your own machines. Each machine is an **office**. |
| Offices | Each office has its own projects, agents, keys and memory. They are fully separate. Cross-office help is a later feature. |
| Mobile | PWA first, native app (Expo) later. Same API. |
| Skills | Built and tested inside the UI. Stored as plain `SKILL.md` files in git. |
| Credentials | Each project has its own connections (its own GitHub, Slack, Jira, Teams accounts). Nothing is shared between projects, even on the same machine. |
| Models | Any provider (OpenAI, Anthropic, Google, local). Chosen per agent. You bring your own keys. |
| Gamification | An office view over the same data, plus a classic list view. XP rewards passed checks and low tokens per task, never raw usage. |
| Marketplace | Future. Only keep the data model open (section 8). |

## 2. Structure

```
Account
 └── Office (one per machine)
      └── Project
           ├── Connections  (this project's own GitHub, Slack, Jira, Teams ... accounts)
           └── Agent  (role, model, skills, access grants, memory, budget)
```

A project lives in exactly one office, because its code and credentials are on that machine.

## 3. Architecture

```
Phone app · Web UI ──► Cloud Hub ◄── outbound connection ── Office Host (Home lab)
                        accounts                            vault · credential broker
                        paired-device registry              policy · approvals · audit
                        relay · status · push               model gateway · MCP gateway
                        (no secrets, no code)               RAG · memory · scheduler
                              ▲                             sandboxed agent runners
                              └─────── outbound connection ── Office Host (Studio laptop)
```

- **Office Host:** a program installed on each machine. It only dials out, so no inbound ports are opened.
- **Cloud Hub:** accounts, paired-machine list, a relay between UI and host, push notifications. It stores status and short summaries only.
- **Event stream:** every run emits events (`step_started`, `tool_called`, `approval_requested`, ...). The web UI, phone app and office view all just render this stream, and a client can reconnect and catch up.

## 4. Security model

The cloud hub is treated as untrusted.

1. **Secrets never leave the machine.** They live in the host's vault (OS keychain). The UI can write a secret but can never read it back.
2. **Handles, not values.** The model sees only a name such as `github_app`. A credential broker outside the model injects the real key when a tool runs.
3. **Signed commands.** Each phone and browser holds a device key. The host runs a command only if it is signed by a paired device, so a hacked hub cannot make agents act.
4. **Content on demand.** The hub keeps status only. Task text, diffs and logs are fetched live from the host over an encrypted channel.
5. **Push notifications are generic** ("Rex needs your OK"). Details load from the host after you open the app.
6. **Scoped access.** Agents start with no access. Grants are explicit, per connection and per scope, and can expire.
7. **Sandboxed execution** with an egress allowlist, so a prompt-injected agent cannot send data out.
8. **Approval gates and audit log.** Risky actions pause for approval. Every tool call and secret use is logged.
9. **Output scrubbing.** Known secret values and high-entropy strings are removed from tool output before it returns to the model or is stored.
10. **Offline is normal.** An offline office shows its last known state. Commands and approvals expire instead of running late.
11. **Per-project isolation.** Each project has its own vault namespace and encryption key, its own MCP gateway and sandbox, and its own egress allowlist. An agent can only be granted connections from its own project.

Limits to keep in mind:
- Hosted model providers still see the prompts and files you send them. For a truly confidential project, mark it sensitive and allow only local models or zero-retention providers.
- Prompt injection from web pages, issues and files is the main real-world attack. Items 6 to 8 limit the damage.

## 5. Keeping token use low

In order of impact:
1. **Use code, not the model, where code will do.** Skills can bundle scripts. Scheduled and triggered agents wake on events and never poll with the model.
2. **Prompt caching.** Stable content first (system prompt, skill index, tool list), changing content last.
3. **Model routing.** Small model for routine steps, escalate only for planning or failures. Skill Studio shows which tier is cheapest while still passing tests.
4. **Progressive skill loading.** Only each skill's name and one-line description go into every request. Full instructions load when the skill is picked.
5. **Lazy tool loading.** Short tool index first, full schemas on demand.
6. **Trim tool output.** Truncate, paginate, return IDs and summaries.
7. **Compact context.** Rolling summary plus retrieved memory notes, not whole transcripts.
8. **Batch APIs** for non-urgent jobs.
9. **Hard budgets** per step, run, agent and day, with tokens shown per step.

Candidate libraries (check current status before adopting): LiteLLM (model gateway, routing, budgets), LLMLingua (optional prompt compression), Langfuse or OpenTelemetry (cost tracking), tree-sitter (code map), sqlite-vec or LanceDB (embedded vector search), tiktoken (token counting).

## 6. Tools, knowledge and memory

- **MCP** is the tool standard, behind our own gateway: per-agent allowlist, credential injection, output truncation, audit log, lazy schemas. Third-party MCP servers run sandboxed and version-pinned, and are treated as untrusted.
- **RAG:** per project, on demand (a tool the agent calls, not text added to every prompt). Hybrid keyword plus vector search, top 4 results with citations, local embeddings. Code uses grep plus a symbol map instead of embeddings. Retrieved text is untrusted.
- **Memory:** working (current context), episodic (short run summaries), semantic (durable facts). Always viewable, editable and deletable in the UI.
- **Not now:** knowledge graphs, fine-tuning, a separate vector database server.

## 6a. Connections and MCP access (per project)

**Connect, grant, enforce.** A connection is added once to a project. It gives agents nothing until you grant it to a specific agent. The gateway then checks every call.

**Connect** (inside the project, never at office level):
- GitHub: your own GitHub App installed on chosen repos (short-lived, repo-scoped tokens, bot identity).
- Slack: a Slack app in that project's workspace, OAuth with chosen scopes.
- Jira: Atlassian OAuth or API token, using Atlassian's MCP server.
- Teams: Microsoft Entra app registration (Graph API). If no good MCP server exists, wrap the API in a thin connector that follows the same grant rules.
- Anything else: a custom MCP server URL or command.
- OAuth keeps tokens off the cloud: the host keeps a PKCE verifier, the hub only passes a one-time code, and the host exchanges it and stores the tokens in the vault.
- Every connection has a visible account label (for example "GitHub: acme-mobile") so you can see which account a project uses.

**Isolation rules:**
- Connections, tokens, MCP servers, files, memory and knowledge belong to one project and are invisible to every other project.
- The same real account used in two projects is authorized twice. Revoking one does not affect the other.
- Deleting a project deletes its vault namespace.
- Cross-office help (later) never moves a connection. The other office would get its own, separately approved access.

**Grant** (per agent) has four limits:
1. Provider permissions: the token is as narrow as possible (the service enforces this).
2. Tool allowlist: only chosen MCP tools are visible to the agent.
3. Resource limits: one repo, certain channels, one Jira project.
4. Risk tier and expiry: reads auto-run, writes follow the agent's approval mode, destructive actions always ask or are blocked.

**Gateway** (every call): shows only granted tools (also saves tokens), checks the call against the grant, pauses for approval when needed, injects the credential, trims and scrubs output, logs the call. MCP servers run sandboxed on the host and the model never connects to them directly.

**Third-party server hygiene:** pin versions, hash tool descriptions and warn when they change, treat tool text as untrusted. (Implemented: the MCP client is the official TypeScript SDK behind the gateway; tools are unreviewed until the user confirms them, and a changed definition needs review again.)

**Connector catalog (per project):** each project has a Connectors page like Claude's directory. It lists every available connector with category filters and search. Each card shows what the connector does, how it signs in, how many tools it offers, and whether this project has connected it (with the account name). A project can connect more than one account of the same service. Initial catalog: GitHub, Railway, Sentry, Slack, Microsoft Teams, Gmail, Jira, Linear, Notion, Google Drive, Figma, HubSpot, Zendesk, PostHog, and a Custom MCP server. Each tool is tagged read, write or destructive, and destructive tools always ask for approval.

**Decision:** model-provider API keys (OpenAI, Anthropic, ...) are not project connections. They are stored per office, with an optional per-project override (for example when a client pays for their own key).

## 6b. How work flows: tickets, manager, team and Slack watcher

**Everything is a ticket.** Every request, whether it is a Jira number, a written definition, or a Slack triage card, becomes an internal ticket with an ID per project (for example `MOB-142`). The Manager splits it into subtickets, each assigned to one agent.

A ticket records:
- **Status:** New, Planning, In progress, In review, Waiting for you, Done.
- **Source and links:** where it came from (You, Jira number, Slack message) and any external ticket number. Entering a Jira number that is already tracked opens the existing ticket instead of creating a duplicate.
- **Who is on it now,** and **who has worked on it** (every agent that spent tokens on it or its subtickets, with their share).
- **Tokens and cost,** rolled up from its subtickets and compared with a budget. Plus back-and-forth rounds against a limit.
- **Parent and subtickets,** with an "after" link so a review ticket starts only when its work ticket is done.
- **Timeline:** every assignment, question, answer, approval and result, with actor and time.
- **Links and files:** pull requests, documents and other outputs.

The **Tickets** page has a board and a list view, a search box that finds a ticket by ID, external number or words, and a "Show subtickets" switch. Each agent's desk shows the ticket it is working on.

Each project has a **Manager** agent and optionally a **Communicator** agent. Both are ordinary agents with their own role template, skills and access grants.

**Task flow**
1. **Intake.** You give the Manager a ticket number or a written definition, from the web, the phone, or a Slack triage card.
2. **Understand.** The Manager reads the ticket (through its own Jira read grant) and writes a short brief: goal, acceptance criteria, links. It asks you in the Inbox only when something is genuinely unclear.
3. **Delegate.** The Manager picks team members using a roster: each agent's name, role, one-line skills, current status and queue length. If the best person is busy, the task waits in their queue or goes to another capable agent.
4. **Work.** Agents talk through a task thread using short typed messages (assign, question, answer, result, blocked, review request). Long outputs (diffs, logs, files) are stored as artifacts and linked, never pasted back and forth.
5. **Check.** The Manager checks results against the acceptance criteria. For code, a QA Reviewer reviews first (configurable per project).
6. **Report.** You get a push notification: what was done, links, time and cost. You accept or reopen.

**Rules for delegation**
- **No privilege escalation.** The Manager delegates but cannot use other agents' grants. Each agent works only with its own.
- **Event-driven.** Agents wake on events (new task, result, question) and never poll with the model. Task state lives in the database, not in anyone's context.
- **Limits.** Each task has a token and cost budget and a maximum number of back-and-forth rounds. If either is hit, the Manager escalates to you instead of looping.
- **Cheap routing.** The Manager's context is the project brief, the roster and the task state, not transcripts. A small model tier handles routing, and a stronger tier is used only to plan unclear tickets.
- **Approvals still apply.** Anything risky an agent does along the way pauses for your OK, as before.

**Communicator**
- One agent per project that listens to the project's Slack, Teams and email accounts, and tells you when something is for you.
- Each channel is a normal connection with a read-only grant. The host keeps outbound connections (for example Slack Socket Mode where the workspace allows it), so no inbound ports are needed.
- **Filter before the model.** Plain rules decide what is "pointed at you": mentions, DMs, replies in your threads, mail addressed to you, and chosen channels, chats and senders. Anything that matches no rule never reaches the model, which keeps tokens very low.
- **Classify and summarize.** For matching messages, a small model tier labels them (task, bug, question, info, urgent), summarizes in one or two lines and suggests an action.
- **Triage inbox.** You see a card with the source (Slack, Teams or Email), sender, a one-line summary and buttons: Send to Manager, Snooze, Dismiss. Urgent items push immediately, the rest arrive as a digest.
- **You are the gate.** Nothing from a message reaches the Manager until you send it. It arrives labeled as untrusted quoted text, so a hostile message or email cannot give orders.
- **Read-only.** The Communicator can read chosen sources and create triage cards. It cannot send, post or reply, and it cannot message the Manager. Any reply goes through the Manager and the relevant agent, and still needs your approval.
- **Learns from you.** Dismissing and accepting cards improves the rules, and its precision is shown as its score.
- It can later cover more sources (Jira assigned to you, GitHub review requests) with the same pattern.

**Manager autonomy (decided):** the Manager assigns work on its own when the roster shows an agent who can do it (busy agents get a queued ticket). If nobody on the project can do it, the ticket moves to Waiting for you with a question, such as hiring someone or choosing who should take it. Anything risky still needs your approval, and every ticket has a token budget and round limit.

**Engines (implemented for Claude Code).** An agent's thinking is done by an engine the host launches: the official Claude Code program signed in as the user (flat subscription), or later an API engine with a provider key. Either way the host owns the tools, credentials, limits and approvals. For Claude Code, its built-in tools are switched off and the agent's granted tools are offered over a loopback-only MCP server for the length of one run. Usage limits put the agent to sleep until the reset. See `docs/CLAUDE-CODE.md`.

## 7. UI screens (prototype exists)

- **Office:** departments with agents at desks, status ring and level badge, meeting room, library, your desk, activity feed.
- **Classic list:** the same agents as a table.
- **Inbox:** approvals from all agents, plus Slack triage cards.
- **Tasks:** a board (New, Planning, In progress, In review, Waiting for you, Done) with ticket numbers, assignees and cost. Each task opens a thread showing the Manager and team messages, subtasks and linked artifacts.
- **New task:** one box that takes a ticket number or a written definition and sends it to the Manager.
- **Agent panel:** overview (task, budget, cache hits, level), skills, access (handles only, plus a "Cannot" list), approval mode, assign, pause, fire.
- **Hire:** pick a role template. New agents start with zero access.
- **Skill Studio:** edit `SKILL.md`, see context cost, run tests across model tiers.
- **All offices and Directory:** every machine's status, and which agents work on which projects in which office. Offline offices show the last known state.

## 8. Marketplace hooks (do now, build later)

- Agents have a `source` field: `local` or `package@version`.
- An agent package is a signed bundle with a manifest: id, version, publisher, skills, required permissions, model requirements, pricing placeholder.
- An `Entitlement` record (active, cancelled, expired) sits behind a billing-provider interface. Firing an agent cancels the entitlement and stops billing. The agent's data stays with you.
- Hired agents run in your office with the permissions you approve at hire time. The publisher never sees your data or keys.

## 9. Data model sketch

`Account`, `Device` (public key, name, revoked), `Office` (host key, name, last seen), `Project`, `Agent` (role, model, mode, budget, level, xp, source), `Skill` (name, version, path), `Connection` (project, service, account label, vault reference), `Grant` (agent, connection, allowed tools, resource limits, expiry), `Ticket` (project, key, title, type, source, external number, status, assignee, parent, after, budget, token usage per agent, rounds, timeline, links), `TriageItem` (project, source message reference, label, summary, suggested action), `Run`, `Event` (append-only), `Approval`, `Budget`, `Entitlement` (future).

## 10. Roadmap

| Phase | Scope |
|---|---|
| 0 | Stack choice, data model, event schema. Model gateway with two providers. Vault and credential broker prototype. Device pairing and signed commands. |
| 1: Engine | Office Host plus Cloud Hub. Projects and agents. Chat and run with live trace. Access grants. Approvals. Audit log. Budgets and caching. Web UI as a PWA with passkey login. |
| 2: Skills | Skill Studio, versions, test cases, model comparison, progressive loading. |
| 3: Teamwork | Manager agent, task board and task threads, delegation rules and limits, Communicator and triage inbox, push when a task is done. |
| 4: Office and knowledge | Office view, XP and levels, performance reviews, push approvals. RAG, memory and triggers. |
| 5: Native mobile | Expo app on the same API. |
| 6: Cross-office help | One office asks another for help on a project, approved by you. |
| 7: Marketplace | Packages, entitlements, billing. |

Phases 1 and 2 stay useful without any later phase.

## 11. Open questions

1. Stack for the Office Host and Hub. Suggested: TypeScript for UI, hub and host, with a LiteLLM sidecar for model routing.
2. Name and domain.
3. Which machines first, and whether the first one is always on.
4. Whether to self-host the hub as an option from the start, or only run it as a service.

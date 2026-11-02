# Agent Office

A control room for AI agents you run on your own machines, with credentials that never reach the model. The full product plan is in [`docs/PLAN.md`](docs/PLAN.md). The clickable UI prototype is [`docs/ui-prototype.html`](docs/ui-prototype.html) (a page fragment; it is also published as an artifact).

This repository has the engine (vault, credential broker, policy, signed commands, MCP tools, the Claude Code engine), the cloud hub, and **tickets with a Manager** (Phase 3). The Communicator, the office view, Skill Studio and the tool review screens from the prototype come next.

## Layout

```
packages/shared   crypto (Ed25519), signed commands, pairing proofs, secret scrubber, wire protocol, domain types
apps/host         the Office Host: vault, credential broker, policy, tool gateway, approvals, audit log, agent runner, hub link
apps/hub          the cloud hub: office registry and an untrusted relay (HTTP + WebSocket, SQLite)
apps/web          React shell: connect, add an office, pair this device, signed commands, approvals
docs              plan and UI prototype
```

```
 Browser / phone ──► Cloud Hub (relay) ◄── outbound WebSocket ── Office Host (your machine)
                      sees: names, counts            holds: vault, grants, agents, audit log
                      never: secrets, code, tasks    obeys: commands signed by devices paired with it
```

## Run it (three terminals)

Requires Node 22.13 or newer.

```bash
npm install
```

1. Hub (pick any token of 16+ characters):

```bash
HUB_ADMIN_TOKEN=$(openssl rand -hex 24) npm run dev:hub
```

2. Web app, then open http://localhost:5173 and sign in with that token. Add an office and copy the command it shows.

```bash
npm run dev:web
```

3. On the machine that should be the office, run the command from the page, adding `--demo` to get a sample project and one pending approval:

```bash
ENROLL_TOKEN=<from the page> HUB_URL=ws://localhost:8787 npm run dev -w @agent-office/host -- --demo
```

The host prints a one-time **pairing code** and its **key fingerprint**. Type the code into the page under "Pair this device". Check that the fingerprint shown in the browser matches the one on the host console. Then you can send a signed test command and approve the pending action from the browser.

State lives in `~/.agent-office` on the host (override with `AGENT_OFFICE_HOME`) and in `hub.db` for the hub.

## Tickets and the Manager

Open an office in the web app: the **Team** tab adds projects, teammates (name, role, and a few words of skills) and a **Manager**. The **Tools** tab reviews what each connected service's tools can do and gives teammates access ([`docs/TOOLS.md`](docs/TOOLS.md)). The **Tickets** tab creates tickets, either given to someone yourself or left for the Manager. Details: [`docs/TICKETS.md`](docs/TICKETS.md).

- A new ticket goes to the project's Manager, who reads the team's roles and skills and either **assigns** it or **asks you one question**. It works through two tools only, so it cannot do the work or touch anything else.
- The assigned agent runs it on your own Claude Code sign-in. A risky action pauses the ticket under **Needs you** until you approve it, then the ticket carries on.
- Every ticket shows **who worked on it**, a timeline, and tokens and API-equivalent cost per person and in total.
- Ticket text stays on your machine. The cloud hub only learns how many tickets are open, working, and waiting for you.

## Trying GitHub

```bash
npm run github
```

A guided setup that stores your token with hidden input, connects GitHub's MCP server read-only, limits Ada to the repositories you name, and proves the limit works. Step by step, including how to create a safe token and what has not been verified against the real service: [`docs/GITHUB.md`](docs/GITHUB.md).

## Deploying the hub to Railway

The remote half (hub plus web app) is one service built from the `Dockerfile`. Your agents and credentials stay on your own machines. Steps, settings, and what has and has not been checked: [`docs/RAILWAY.md`](docs/RAILWAY.md).

## Running an agent on your Claude subscription

```bash
npm run agent -- --task "List the open pull requests in yourname/test-repo"
```

Runs the agent with the official Claude Code program, signed in as you (a flat plan such as Claude Pro, no API key). Claude Code's own tools are switched off, so the agent can only use what you granted it, through the gateway: credentials stay hidden and limits and approvals still apply. Guide, limits and what has and has not been verified: [`docs/CLAUDE-CODE.md`](docs/CLAUDE-CODE.md).

## Connecting any other MCP server (from code, for now)

There is no screen for this yet. Until there is, a connection is added through the `Office` API:

```ts
office.vault.put("mobile", "github", "<token>");   // goes straight into the encrypted vault
const tools = await office.addMcpConnection({
  id: "gh", projectId: "mobile", service: "GitHub", label: "acme-mobile", credentialHandle: "github",
  spec: { kind: "stdio", command: "npx", args: ["-y", "<an MCP server package>"], secretEnv: "GITHUB_TOKEN" },
});
// every tool is unreviewed. Review each one, then grant it to an agent:
office.reviewTool("mobile", "gh", "list_pull_requests", { risk: "read", resourceArg: "repo" });
office.addGrant({ id: "g1", projectId: "mobile", agentId: "ada", connectionId: "gh", tools: ["list_pull_requests"], resources: ["acme-mobile/app"] });
```

Remote servers use `spec: { kind: "http", url: "https://..." }` and receive the credential as an `Authorization: Bearer` header by default.

## Tests

```bash
npm test            # 144 tests across shared, host (real MCP servers, a stand-in for Claude Code) and hub
npm run typecheck   # all four packages
```

What the tests prove, in plain terms:

- **Credentials:** encrypted at rest, per-project keys, ciphertext cannot be moved between handles or projects, a source-scan test fails if anything but the broker reads a secret.
- **Never reaches the model:** a tool that echoes its credential, and one that throws it in an error, both come back scrubbed. A full agent run is checked so the secret appears in nothing the model saw or produced.
- **Least privilege:** ungranted tools are denied and not even listed to the model. Grants expire. Resource limits fail closed. Another project's connection is invisible.
- **Approvals:** destructive and outbound actions wait for a human, run once, expire, and re-check the grant at execution time.
- **Untrusted hub:** only commands signed by paired devices run. Replays, expired, future-dated, tampered, unknown-device, revoked-device, and pre-restart commands are rejected. Host replies are signed. A hostile hub cannot pair its own device: wrong code, swapped host key, and a burned code are all covered.
- **MCP servers (official SDK, tested against real stdio and HTTP servers):**
  - The credential reaches the server process, but the host's own environment variables do not.
  - Every tool starts unreviewed and always asks for approval, even if the server says it is read-only. A server's hints can only make a tool stricter.
  - Tool definitions are pinned by hash: if a server changes a description or schema, that tool goes back to unreviewed and the change is audited.
  - The model sees one short cleaned line per tool, never the server's full text.
  - Credentials in output or error messages are scrubbed, images are named not inlined, large output is truncated, slow tools time out, and a crashed server is reconnected on the next call.
  - HTTP servers get the credential in a header and cleartext remote URLs are refused. Connections, reviews and grants survive a host restart.
- **Audit log:** hash-chained, contains no secrets, detects edits.
- **Hub:** wrong signatures, reused enrollment tokens, spoofed replies, malformed, flooding and oversized messages are refused.

A separate live run (real hub and host processes, real Chromium) pairs a device, verifies the fingerprint, sends a signed command, approves an action, and reloads the page.

## Status: what exists and what does not

| Area | State |
|---|---|
| Ed25519 signing, signed commands, replay protection, pairing | Done and tested |
| Vault, credential broker, scrubber, per-project isolation | Done and tested |
| Policy (grants, resources, expiry, approval modes), approvals | Done and tested |
| Tool gateway (`ToolServer` interface), audit log, budgeted agent loop | Done and tested, against fake tool servers |
| Hub relay, enrollment, host challenge auth, limits | Done and tested |
| Host to hub link with reconnect, web shell | Done, smoke-tested live |
| MCP adapter on the official `@modelcontextprotocol/sdk` (pinned to 1.32.2): stdio and Streamable HTTP, review and pinning of tools, `owner/repo` limits | Done and tested against fixture servers |
| Claude Code engine (`npm run agent`): the agent runs on your own Claude Code sign-in, with the gateway as its only tools; sleeps on usage limits; resumes after approval | Done. Tested with a stand-in program, and with the real `claude` program for startup, connecting to our tool server, tool list and failure handling (with no login, so no model call). **Not yet run with a real signed-in account** |
| GitHub setup command (`npm run github`), read-only by default | Done and tested against a GitHub-shaped fake server and a real terminal. **Not yet run against the real GitHub**, because the build sandbox cannot reach it. Slack, Jira and Teams are not started |
| OAuth for remote MCP servers (the SDK's `authProvider` hook, tokens stored in the vault) | Not started. Static tokens and API keys work today |
| API engine with real model providers (Anthropic, OpenAI, local, LiteLLM) | Not started. `ModelProvider` interface and a scripted test provider exist. The Claude Code engine covers Anthropic on a subscription; OpenAI's Codex CLI would be a second engine of the same kind |
| **Sandboxed execution** (containers, egress allowlist) for MCP server processes | Not started. A stdio server currently runs as a normal child process with a trimmed environment |
| Tools screen: connections, tool review pinned to the definition you saw, access with resource limits and expiry, removal | Done and tested, including in a real browser. See [`docs/TOOLS.md`](docs/TOOLS.md). Adding a connection still happens on the office machine (`npm run github`), because a token must not pass through the hub |
| Connectors catalog, sealed token entry from the browser | Not started |
| Tickets, Manager (assign or ask), per-person tokens and cost, approvals inside tickets, Tickets and Team screens | Done and tested, including a real browser against a real hub and host with a stand-in for Claude Code. **Not yet run with a real signed-in Claude Code as the Manager** |
| Communicator (Slack, Teams, mail), sub-tickets, ticket threads with attachments | Not started |
| Office view, XP, Skill Studio | Prototype only |
| Passkey sign-in | Not started. The hub uses one admin token (long and random, sent as the first message of the live connection, never in an address) |
| Push notifications, native mobile app | Not started |
| Migration of the host master key into the OS keychain | Not started. It is a 0600 file for now |
| TLS | Provided by Railway. The hub itself speaks plain HTTP behind it |
| Hub on Railway | Image and start-up checks done, tested with a real browser in a production-like run. The Docker image has not been built (no Docker engine in the build environment), and nothing is deployed yet |

## Known limits worth knowing

- Host and device clocks should agree within a few seconds. Commands expire after at most 5 minutes, and commands issued before the host started are refused.
- The audit log's hash chain detects edits in the middle of the file, but someone who can rewrite the whole file can rewrite the whole chain. Periodic anchors to the hub or to external storage would close that.
- A run that pauses for approval returns its state, but resuming inside the same run is not wired up yet.
- The hub stores office names, host public keys and the last status snapshot. Nothing else.

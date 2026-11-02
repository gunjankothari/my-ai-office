# Trying the GitHub integration

This connects one GitHub token to one test project on your machine, with a read-only token, a short list of repositories, and a check that the limits hold. It takes about five minutes.

**What it proves:** the token stays on your machine, GitHub's MCP server connects, tools are reviewed and limited to your repositories, and anything outside the list is refused before it leaves your machine.

**What it does not do yet:** no model is wired in, so no agent will decide to use these tools on its own. The setup calls them itself to show they work.

**Not yet verified against the real service:** this was built from GitHub's documentation and tested against a fake server with the same tool shapes. Your run is the first real one. See "What I could not check" at the end.

## Before you start

- Node 22.13 or newer, and `npm install` run in this repository.
- A throwaway or low-stakes repository to test with.
- Never paste the token into a chat, a ticket or a command line. The setup asks for it with hidden input.

## 1. Create a read-only token

On GitHub: Settings, Developer settings, Personal access tokens, Fine-grained tokens, Generate new token.

- Resource owner: you (or your organization).
- Expiration: 7 days.
- Repository access: **Only select repositories**, and pick the one test repository.
- Repository permissions: **Metadata: Read**, **Contents: Read**, **Pull requests: Read**, **Issues: Read**. Nothing else.

If your organization owns the repository, it may need to approve the token, or it may block personal tokens or Copilot's MCP server. If so the setup says GitHub refused the token.

GitHub's server documentation lists the classic scopes `repo`, `read:packages` and `read:org` as the minimum. It does not say which fine-grained permissions each tool needs. If a tool answers "not found" or "forbidden" on your repository, that is the first thing to check. A classic token is broader than you want, so use one only on a throwaway account or repository.

## 2. Run the setup

```bash
npm run github
```

It asks for:

1. **The token**, typed or pasted with nothing shown on screen.
2. **The repositories** Ada may read: `owner/repo`, several separated by commas, or `owner/*`. A bare `*` is refused.

To read the token from an environment variable instead of the prompt (the variable lives only in your own shell):

```bash
GH_PAT=... npm run github -- --token-env GH_PAT --repos acme/app
```

Other options: `--mode docker` runs GitHub's server locally in Docker, read-only. `--mode full` uses GitHub's hosted server with all tools; anything that is not read-only stays unreviewed and asks for approval every time. `npm run github -- --help` lists everything.

## 3. What you should see

- A table of the tools GitHub offers, with what the server says about each (read-only or not) and their arguments.
- "Review those read-only tools as read? [Y/n]". Yes reviews only the tools the server marks read-only.
- A list of what Ada may use, and a list of tools **not** granted because they cannot be limited to your repositories (for example, search tools, whose query can name any repository).
- `get_me` showing which GitHub account the token belongs to, and a real call on your first repository.
- **"Safety check passed"**: a request for a repository outside your list was refused locally. If you see `WARNING` instead, stop and tell me.

## 4. Afterwards

The connection, reviews and grants are saved in `~/.agent-office` (or `AGENT_OFFICE_HOME`). Starting the host from that folder reconnects on its own:

```bash
npm run dev -w @agent-office/host
```

## Troubleshooting

| You see | Likely cause |
|---|---|
| `Could not connect` and GitHub did not accept the token | Wrong or expired token, missing permissions, or the organization blocks it |
| The network could not reach GitHub | A proxy or firewall on your side. Hosted mode needs HTTPS to `api.githubcopilot.com` |
| Docker was not found | `--mode docker` needs Docker running |
| A call returns "Not Found" on your repository | The token does not cover that repository or lacks a permission |
| `get_me` fails but listing tools worked | The token is valid for MCP but a permission is missing for that call |

## Clean up

```bash
npm run github -- --remove
```

removes the connection, its grants, the review decisions and the stored token from this machine. Then delete the token on GitHub. To remove everything, delete `~/.agent-office`.

## What I could not check

- I could not reach GitHub from the build environment, so the hosted server has not been connected to by this code. The URLs (`https://api.githubcopilot.com/mcp/` and its `/readonly` variant), the `Authorization: Bearer` header, the `X-MCP-Readonly` header and the Docker environment variable names come from GitHub's own documentation.
- The Docker mode and the exact fine-grained permissions each tool needs are untested.
- The hosted server's read-only setting is a second layer on top of your token's permissions and this project's own review and limits. Do not rely on any single layer.

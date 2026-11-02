# Running an agent on your Claude subscription

This runs an agent using the **Claude Code** program on your own computer, signed in with your own Claude account (for example Claude Pro). There is no API key and no pay-per-use bill. The agent only gets the tools you granted it, through the same gateway as everything else.

## What it does, and what it never does

- **It never touches your login.** Claude Code finds your sign-in itself, exactly as when you run `claude` by hand. This project does not read, copy, store or send it, and the hub on Railway never sees it.
- **It never uses an API key.** If `ANTHROPIC_API_KEY` is set in your shell, it is deliberately not passed on, because that would switch Claude Code to pay-per-use billing.
- **Claude Code's own tools are switched off** (shell, file editing, web). The only tools the agent has are the ones granted to it. So credentials stay hidden, repository limits and approvals still apply, and everything is recorded in the audit log.
- **It runs in an empty folder** with a minimal environment: none of your other variables, no project settings, no plugins, no other MCP servers.
- **It stops itself** if it times out, if you cancel (Ctrl-C), or as soon as it is clearly stuck: not signed in, usage limit reached, no network, or its tool server unreachable.

## Before you start

1. **Claude Code installed and signed in.** Install it from Anthropic's instructions at https://code.claude.com/docs, then open a terminal, run `claude` once and sign in with your Claude account. Type `/exit` afterwards.
2. **This project set up:** `npm install`, then the GitHub trial (`npm run github`, see `docs/GITHUB.md`). That creates the project, the agent Ada, and a read-only, repository-limited GitHub connection.

## Run a task

```bash
npm run agent -- --task "List the open pull requests in yourname/test-repo and summarise each in one line"
```

You will see something like:

```
Ada will work with your own Claude Code sign-in. No API key is used.
Tools Ada may use: github/list_pull_requests, github/get_file_contents, ...

  . github/list_pull_requests: ok

Ada:
There are 2 open pull requests: ...

Done. Claude Code estimates this would cost about $0.0412 on the pay-per-use API. On your plan it is covered by the flat fee, within its usage limits.
```

Useful options: `--agent <id>` to pick another agent, `--model sonnet` or `--model haiku` to use a lighter model (it stretches your plan's usage limits), `--home <dir>` for another office folder.

## Approvals

If the agent asks for something that needs your approval (for example a write action you granted), it stops and you are asked in the terminal: `Approve? [y/N]`. Your answer runs or blocks the action, and the same conversation continues with the result. Later this will arrive on your phone.

## When something goes wrong

| You see | What it means |
|---|---|
| `Claude Code is not signed in` | Run `claude` in a terminal and sign in |
| `Your Claude usage limit was reached` | The agent rests until the reset time (or 30 minutes if none is given) and refuses new work until then |
| `could not reach Anthropic` | No network, a proxy problem, or a sign-in problem. It gives up after a few retries instead of waiting minutes |
| `could not connect to this host's tool server` | A proxy is in the way of the local connection. Loopback is exempted automatically, but check `NO_PROXY` for `127.0.0.1` and `localhost` if you use a proxy |
| `could not start claude ... installed?` | Claude Code is not installed, or not on your PATH |
| `Ada is resting until ...` / `already working` | A usage limit is being waited out, or a run is still going |

## Limits and rules you should know

- **Usage limits.** Subscription plans have usage windows. Several agents running at once, or long tasks, use them up. Anthropic says the limits assume "ordinary, individual usage". I can't tell from its page whether always-on automation counts, and Anthropic may enforce limits without notice.
- **Your own use.** Anthropic allows you to sign in to the unmodified Claude Code with your own account. It does not allow offering Claude.ai login in other products, or routing other people's requests through your plan. If this ever becomes a product for others, each person must use their own login, and running Claude Code inside a product requires Anthropic's Commercial Terms. Ask Anthropic before then.
- **The dollar figure** is Claude Code's own estimate of what the same work would cost on the API. It is not a bill.
- **Conversations are stored** by Claude Code in your own `~/.claude` folder, as they are for any Claude Code session. Tool output is scrubbed of credentials before it gets there.

## What has and has not been checked

Checked, using the real `claude` program with no login and no network (so no model call could happen): it accepts every flag used here, connects to our local tool server, lists exactly the granted tools and no built-in ones, and the engine reacts correctly when it cannot reach Anthropic. The rest is tested with a stand-in program that behaves like Claude Code.

**Not checked:** a real run with a real login. I cannot do that from the build environment. The wording of Claude Code's usage-limit and sign-in messages is matched on a best-effort basis, using its documented retry categories first. Your first real run is the real test, so please send me what the terminal printed.

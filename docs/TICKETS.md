# Tickets and the Manager

Everything about a ticket lives on your machine in `~/.agent-office/tickets.json`. The cloud hub is only told three numbers: open, working, waiting for you.

## The flow

```
you create a ticket ──► Manager (cheap model) reads the team's roles and skills
                         ├─► assign_ticket → the agent runs it on your Claude Code sign-in
                         └─► ask_user      → "Needs you": you answer, the Manager decides again
agent finishes ─► Done (result, who worked, tokens, cost)
agent wants a risky action ─► "Needs you" ─► you approve ─► it carries on from where it stopped
```

## What the Manager can and cannot do

- Its **only** tools are `assign_ticket` and `ask_user`. It has no access to GitHub, files or anything else, so a hostile ticket text cannot make it act outside the office.
- It can only assign a ticket in its own project, to a teammate of that project who has an engine, never to itself. Anything else is refused and the ticket comes back to you.
- If it ends without assigning or asking, the ticket goes to you with "could not decide". It never guesses.
- The team roster is put in the prompt, so the Manager needs no extra look-ups. Each tool it is shown costs tokens on every run, which is why there are only two.

## Rules the dispatcher follows

- One run per agent at a time. At most `MAX_PARALLEL` agents at once (default 2), because every run draws on the same plan allowance.
- Higher priority first, then oldest first.
- An agent that hit its usage limit rests until the reset time Claude reported. If that time is missing or already in the past, it rests for 30 minutes instead, so a stale time cannot cause a retry loop. Its ticket waits in the queue.
- A ticket waiting for approval does not hold its agent: the agent is free for other work until you answer.
- If the office restarts, a half-done ticket is **not** re-run on its own. It asks you first, because the work may already have had effects. Triage, which has none, simply starts again.
- Cancelling stops the run if there is one.

## Tokens and cost

Each run's tokens and its "API value" (what the same run would cost on the pay-per-use API) are added to the ticket and to whoever did it, the Manager's triage included. On a flat Claude plan nothing extra is charged, but the runs do count against your plan's usage limit. Token counts include cached input, so they look larger than the new text you wrote.

## Not built yet

- A teammate added in the app starts with **no tools**. Give them access on the Tools tab ([`TOOLS.md`](TOOLS.md)).
- Sub-tickets, attachments, notifications on your phone, and the Communicator.
- The Manager has only been run against a stand-in for Claude Code. With the real one, check that `haiku` is accepted as the model name; if not, change the Manager's model in `state.json` or run `npm run agent -- --model sonnet`.

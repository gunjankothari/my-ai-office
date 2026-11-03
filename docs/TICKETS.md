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

## Limits, subtickets and "after"

- **Budget and rounds.** A ticket can have a token budget (counted across its subtickets) and a most-rounds limit (default 6; every run counts, the Manager's triage included). When either is reached the ticket stops **before** the next run and asks you. Your reply lets it carry on with more room: a reached budget doubles, a reached round limit grows by 6.
- **Subtickets.** A ticket can be "part of" another. The link is set when the ticket is created and never changed. The parent shows its subtickets and the combined usage. Subtickets are hidden from the list unless you tick "Show subtickets" or search. The parent is an ordinary ticket and is not finished automatically when its subtickets are.
- **After.** A ticket can start only after another is done. It waits in the queue until then. If that ticket fails or is cancelled, this one asks you whether to go on without it.
- Links must point to a ticket in the same project, and can only be made at creation, so they can never form a loop.
- The **Board** view groups tickets into New, Planning, In progress, Waiting for you and Done.

## Team: hiring, pausing, firing

- **Hire** from a role template (Developer, QA Reviewer, DevOps, Support, Marketer, Sales, Researcher) or a blank form. A template only fills in the form. A new teammate always has **no tool access**.
- **Pause** stops new work for an agent. A run in progress, or one you have just approved, finishes.
- **Fire** removes the agent and all its grants. Its queued tickets go back to the Manager. It is refused while the agent is working or waiting for your answer, because a run cut off half-way may already have had effects. History stays on the tickets and in the audit log.
- The agent panel lists what an agent can do and, separately, the tools it **cannot** use. Names only, never credentials.

## Tokens and cost

Each run's tokens and its "API value" (what the same run would cost on the pay-per-use API) are added to the ticket and to whoever did it, the Manager's triage included. On a flat Claude plan nothing extra is charged, but the runs do count against your plan's usage limit. Token counts include cached input, so they look larger than the new text you wrote.

## Not built yet

- A teammate added in the app starts with **no tools**. Give them access on the Tools tab ([`TOOLS.md`](TOOLS.md)).
- The Manager splitting a ticket into subtickets by itself (you create them for now), an "In review" step with a QA reviewer, attachments, notifications on your phone, and the Communicator.
- The Manager has only been run against a stand-in for Claude Code. With the real one, check that `haiku` is accepted as the model name; if not, change the Manager's model in `state.json` or run `npm run agent -- --model sonnet`.

# The Tools screen: review and access

Open an office, then the **Tools** tab. For every connected service it shows what the service offers, how you rated each tool, and who may use it.

## Connecting a service

A key or token is never typed into this page. The page travels through the cloud hub, and a secret must not. Connect on the office machine instead:

```bash
npm run github
```

The connection then appears on the Tools tab. (Entering a token in the browser, sealed so only your machine can open it, is possible to build, but is not built yet.)

## 1. Review tools

A server describes its own tools, and anyone can write that description. So nothing is trusted until you confirm it:

- **What it does:** Only looks, Changes things, or Can destroy things. "Server says" is shown next to it, but it is only a suggestion.
- **Limit to a resource by:** which argument names the thing the tool touches, such as `owner + repo`. Only arguments the tool cannot be called without are offered. An optional argument cannot limit anything, because the tool can work without it (a search whose query can name any repository), so the screen and the host both refuse it.
- **Sends something out:** messages, posts and emails always ask you first.
- **Confirm these N as "Only looks"** confirms every tool that claims to be read-only in one click, limiting each to a repository where it names one.
- Your decision is pinned to the exact definition you were shown. If the server changes a tool afterwards, it is marked **Changed since you reviewed it** and asks for approval every time until you read it again. If it changes between you looking and clicking Confirm, the confirmation is refused.
- **Check the server for changes** asks the server for its tools again.

## 2. Who can use it

- Give a teammate a set of tools, optionally limited to resources (`owner/repo`, `owner/*`), optionally for a set time (1 hour to 30 days).
- A limit is refused if any chosen tool cannot be limited, because it would only ever be denied.
- With no limit, the screen warns that the teammate can use those tools on anything the token can reach.
- **Take away** removes a grant at once. The Manager gets no outside tools, and the internal team tools do not appear here.

## When something still asks you

| | Normal mode | "Ask before every action" |
|---|---|---|
| Only looks, reviewed | runs | asks |
| Changes things, reviewed | runs | asks |
| Destructive, sends something out, or not reviewed | asks | asks |

## Removing a connection

Removes the connection, every grant on it and its reviews, and deletes the stored token unless another connection in the project uses it. Also delete the token at the service itself.

## Not built yet

Sealed token entry from the browser, a catalog of services to pick from, OAuth for remote servers, setting a teammate's approval mode from the app, and an audit log screen.

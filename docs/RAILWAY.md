# Deploying the hub to Railway

This puts the **remote half** on Railway: the hub (accounts, the list of machines, the relay) and the web app, as one service. Your agents, credentials and AI stay on your own machines. Railway never holds a secret, a token for GitHub or Slack, or your Claude login.

```
 Your browser or phone ──► https://<your-name>.up.railway.app  (hub + web app)
                                      ▲
                                      └── wss:// ◄── Office Host on your machine (connects out, no open ports)
```

## What gets deployed

One service built from the `Dockerfile` in this repository (Railway finds it by itself):

- builds the web app, then runs the hub, which serves the app and the live connection from one address,
- listens on `0.0.0.0` and the `PORT` Railway gives it,
- keeps its database (office names, each machine's public key, last status) on a **volume** mounted at `/data`.

## What you need to decide or do yourself

1. **A GitHub repository** containing this project. Railway deploys from GitHub, and it can be private. Steps below.
2. **The admin token.** It is the only key to the hub's web page, so make it long and random, and **type it into Railway yourself** (never into a chat):
   ```bash
   openssl rand -hex 32
   ```
   Copy the result. You also paste it into the web page to sign in, so keep it in a password manager.
3. **Cost.** Railway bills for what the service and the volume use. This is one small always-on service and one small volume. Check your plan's pricing; I could not confirm a figure.

## Step 1: put the project on GitHub

In the folder you unzipped:

```bash
git init -b main
git add .
git commit -m "Agent Office"
```

On github.com create a new **private** repository (no README, no .gitignore), then:

```bash
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`.gitignore` already keeps keys, databases and `node_modules` out. In Railway, the GitHub connection must be allowed to see that repository (Railway account settings, GitHub, add the repository).

## Step 2: create the service

I can do this part through the Railway tools once you say go: a project, an empty service, a volume mounted at `/data`, and the repository connected. Or by hand in the Railway dashboard:

1. New Project, Deploy from GitHub repo, pick the repository.
2. In the service, add a **Volume** with mount path `/data`.
3. In **Variables**, add `HUB_ADMIN_TOKEN` with your token.
4. In **Settings**, Deploy: set the **Healthcheck Path** to `/healthz`. Railway then only switches traffic to a new version once it answers `200`.
5. In **Settings**, Networking: **Generate Domain**.

`railway.toml` is not used: Railway has deprecated it for new services, so those settings live on the service itself.

## Step 3: check it

Open the generated address. You should see "Connect to your hub", with the hub address already filled in. Sign in with your token.

In the service logs you should see `hub listening on` and `database: /data/hub.db`. If you see a line starting with `WARNING`, read it: it means the volume is missing or the database is outside it, and **every redeploy would erase your enrolled machines**.

## Step 4: connect your machine

In the web page: add an office, copy the command it shows, and run it on the machine that should be the office. It looks like:

```bash
ENROLL_TOKEN=enr_... HUB_URL=wss://<your-name>.up.railway.app npm run dev:host
```

The first run prints a one-time pairing code. Type it into the page under "Pair this device", and check that the fingerprint shown in the page matches the one printed on the machine.

## Good to know

- **One instance only.** The hub keeps the list of connected machines in memory and uses a single database file. Do not add replicas. Railway's default is a short pause between the old and new version, not an overlap, which is right for this.
- **If the database is lost** (no volume, or it was deleted): create a new office in the page. On the machine, delete `~/.agent-office/hub.json` and start the host with the new `ENROLL_TOKEN`. Pairings made with the machine's own devices stay valid.
- **Changing the admin token:** change the variable in Railway and redeploy. Everyone must sign in again.
- **What the token can and cannot do.** Whoever has it can sign in to the page, list your offices and create new ones. They still cannot make any machine do anything: a machine only obeys commands signed by devices you paired with it directly. The hub never sees secrets or task contents.
- **Sign-in is still one shared token.** Passkeys are planned before this is used by anyone but you. Until then, treat the token like a password and use a long one.
- **The token is not in any web address.** The page sends it as the first message on the live connection, so it does not appear in logs.
- **Logs and the database** contain office names, public keys and status counts. No secrets.

## What happened on the first real deploy

- The `Dockerfile` built on Railway without changes, and the volume mounted at `/data`.
- A variable added through Railway's tools (or the dashboard's "staged changes") is **not live until you deploy the staged changes**. The first deploy started without `HUB_ADMIN_TOKEN` and the hub exited with its "Set HUB_ADMIN_TOKEN" message. After the staged change was applied, the next deploy succeeded. If you see that message in the logs, look for a pending staged change first.
- Generate the domain **before** the first deploy, so the hub learns its own address (`RAILWAY_PUBLIC_DOMAIN`) from the start. If you add the domain later, redeploy once.
- Healthy start-up looks like: `hub listening on 8080` and `database: /data/hub.db, serving the web app from /app/apps/web/dist`, with no `WARNING` line. The `ExperimentalWarning: SQLite` line is normal.

## What has been checked, and what has not

Checked: `npm ci` from the lockfile and the production build in a clean copy (the same steps as the Dockerfile), then the hub started with the container's settings and driven by a real browser: sign-in (including a wrong token), adding an office, enrolling a machine through it, pairing, a signed command, an approval, reload, deep links, no content-security-policy violations, no token in the log, and path-traversal attempts refused. The start-up warnings for a missing or misplaced volume were exercised.

Not checked: the Docker image itself. The Docker engine is not running in the build environment, so the first build on Railway is the real test of the `Dockerfile`. Also not checked: how Railway's network behaves with long-lived connections over days. The host reconnects by itself if the connection drops.

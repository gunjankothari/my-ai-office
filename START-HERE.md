# GitHub trial: what to do, in order

This takes about 10 minutes. You will connect one **read-only** GitHub token to a test project on your own computer. The token never leaves your computer and is never shown on screen.

## 0. What you need

- A computer with **Node.js 22 or newer**. To check, open a terminal and type `node -v`. If it says v22 or higher, you are fine. If not, install the "LTS" version from https://nodejs.org
- A GitHub account and **one repository you do not mind testing with** (a private test repository is ideal).
- A real terminal window (Terminal on Mac, PowerShell or Windows Terminal on Windows). Not the output panel inside an editor, because those cannot hide what you type.

## 1. Unpack and install

1. Unzip `agent-office.zip` somewhere, for example your Documents folder.
2. Open a terminal **inside** the `agent-office` folder.
3. Run:

```
npm install
```

It downloads what it needs and takes about a minute.

## 2. Create a read-only token on GitHub

1. Go to GitHub, click your picture, then **Settings**.
2. At the bottom of the left menu: **Developer settings**, then **Personal access tokens**, then **Fine-grained tokens**, then **Generate new token**.
3. Fill in:
   - Token name: `agent-office-test`
   - Expiration: **7 days**
   - Repository access: **Only select repositories**, then choose your one test repository
   - Permissions, under "Repository permissions": set **Metadata**, **Contents**, **Pull requests** and **Issues** to **Read-only**. Leave everything else as "No access".
4. Click **Generate token** and **copy it** (you only see it once). Keep it in your clipboard. Do not paste it into a chat, an email or a document.

## 3. Run the setup

In the same terminal:

```
npm run github
```

It asks two things:

1. `GitHub token (input is hidden):` Paste the token and press Enter. **Nothing will appear on screen. That is normal.**
2. `Which repositories may Ada read?` Type your repository as `your-github-name/test-repo` and press Enter.

Then it shows a list of tools and asks `Review those read-only tools as read? [Y/n]`. Type `y` and press Enter.

## 4. What success looks like

You should see a few lines under "Trying it:", including your GitHub username and your repository's pull requests (or an empty list if it has none). The last line should say:

**Safety check passed**

If you see `Could not connect` or `WARNING`, that is useful too. Copy everything the terminal printed.

## 5. Tell me what happened

Copy the text the terminal printed (from `Token stored` to the end) and paste it to me. It never contains your token, but please read it once before sending.

## 6. Clean up when you are done

```
npm run github -- --remove
```

Then delete the token on GitHub (the same Developer settings page).

## If you get stuck

- `npm: command not found` or `node: command not found`: Node.js is not installed. See step 0.
- The prompt shows your token as you type: you are not in a real terminal. Close it and open Terminal or PowerShell.
- Anything else: copy the exact message and send it to me.

## After this works: run an agent on your Claude subscription

Once the GitHub trial has worked, you can have the agent do real work on your own Claude Code sign-in (no API key). See `docs/CLAUDE-CODE.md`.

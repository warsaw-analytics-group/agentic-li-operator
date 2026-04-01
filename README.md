# LI Local Automation

Local LinkedIn browser automation for daily operator use.

This project is built around a persistent local LinkedIn browser session and a guided review flow. It can:

- reuse your local LinkedIn login
- collect feed, inbox, and invitation data
- read message threads
- draft replies and post ideas
- run an approval-gated daily session
- send messages only when you explicitly approve
- search people and send a batch of connection invites in one browser session
- send connection invites with a custom note on supported profile layouts
- post comments on direct LinkedIn post URLs

## What this is

This is not an official LinkedIn integration. It is a local browser automation tool built with Playwright.

The intended operating model is:

- collect LinkedIn state locally
- let the tool suggest actions
- review and approve those actions in the terminal
- execute only the actions you confirm

That makes it useful as a daily operator while keeping direct control over anything risky.

## Important constraints

- LinkedIn does not provide a general-purpose public API for the full member inbox/feed workflow this tool targets.
- LinkedIn can change its UI at any time, which can break selectors and parsing.
- Browser automation can trigger account restrictions if used aggressively.
- You are responsible for compliance with LinkedIn's terms and your own risk tolerance.
- This tool should be treated as a local assistant, not an unattended bot.

## Setup

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Create a persistent LinkedIn login session

```bash
npm start -- login
```

This opens Chromium with a persistent profile under `.auth/linkedin`.

Log into LinkedIn manually, complete any 2FA or checkpoint flow, then press Enter in the terminal when prompted.

### 3. Optional: enable better drafting with OpenAI

If `OPENAI_API_KEY` is set, the tool uses the OpenAI Responses API for draft generation. If not, it falls back to heuristic drafting.

If you want Codex to be the planner and drafter, you can ignore this entirely and use the local CLI only as an execution layer. The local Codex skill contract is in [SKILL.md](/Users/karol/Documents/Lectures/GenAI%20playground/LI/SKILL.md).

Environment variables:

```bash
export OPENAI_API_KEY=your_key_here
export OPENAI_MODEL=gpt-4.1-mini
```

Defaults:

- `OPENAI_MODEL` defaults to `gpt-4.1-mini`
- without `OPENAI_API_KEY`, all drafting still works, but quality is lower

## Daily routine

### Recommended daily command

Run the guided operator session:

```bash
npm start -- session
```

By default, the CLI tries to use your installed Chrome via Playwright's `chrome` channel for maximum stability. If that fails, it falls back to Playwright's bundled Chromium. You can override this:

```bash
npm start -- --browser-channel chromium inbox --limit 10
```

If Playwright cannot find or launch your system browser via a channel, you can pin the exact executable:

```bash
npm start -- --browser-executable "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" inbox --limit 10
```

What it does:

1. collects inbox, feed, and invitation data
2. drafts candidate actions
3. presents them one by one in the terminal
4. lets you approve, edit, skip, or quit
5. only executes message sends when explicitly approved

Approval options in the current session loop:

- `a`: approve the proposed action
- `e`: edit the draft before approving
- `s`: skip the action
- `o`: print the target URL for manual review
- `q`: quit the session

## Core commands

### Login

```bash
npm start -- login
```

Use this whenever the LinkedIn session expires.

### Collect everything

```bash
npm start -- collect --output .output/collect.json
```

This collects:

- inbox threads
- feed items
- invitation/networking state

Use this when you want a raw snapshot without running the approval flow.

### Run a guided session

```bash
npm start -- session
```

This is the main daily-use command.

### Save a proposed action queue without executing anything

```bash
npm start -- plan
```

This writes a session file under `.output/sessions/` with collected data and proposed actions.

### Execute one saved action manually

```bash
npm start -- act --session-file .output/sessions/<file>.json --action-id reply-1
```

Current limitation:

- only `send_message` actions are executable through `act`

### Feed

```bash
npm start -- feed --limit 10
```

With debug artifacts:

```bash
npm start -- feed --limit 10 --debug-artifacts
```

### Inbox

```bash
npm start -- inbox --limit 20
```

### Read a thread

```bash
npm start -- thread --thread-url "https://www.linkedin.com/messaging/thread/..."
```

### Send a message directly

```bash
npm start -- send --thread-url "https://www.linkedin.com/messaging/thread/..." --message "Thanks, happy to connect."
```

This bypasses the session approval flow, so use it carefully.

### Comment on a post directly

```bash
npm start -- comment --post-url "https://www.linkedin.com/feed/update/..." --message "Useful perspective. The part about distribution is especially important."
```

This also bypasses the session approval flow, so use it carefully.

### Send a connection invite directly

```bash
node ./scripts/send-connection-invite.mjs "https://www.linkedin.com/in/some-profile/" "Short invite note"
```

This uses the saved local LinkedIn session and targets the primary action area in the top profile card. It currently supports the direct `custom-invite` link variant and visible `Connect` actions in the hero section.

### Search people and invite the top matches in one session

Review-only search:

```bash
npm start -- search-people --query "ai founders in berlin" --limit 10
```

Approved batch invite flow:

```bash
npm start -- invite-search --query "ai founders in berlin" --limit 5
```

With a custom note:

```bash
npm start -- invite-search --query "b2b saas cmos in london" --limit 5 --note "Building in this space too. Open to connecting."
```

This runs the search and invite attempts inside one persistent browser session, then returns a per-profile status report so Codex can tell you which invites were sent and which failed or were already pending.

### Draft a post

```bash
npm start -- draft-post --prompt "Write a short post about..."
```

## Operator architecture

The project is split into a few layers:

- `src/linkedin-client.js`
  Browser automation and LinkedIn page interactions
- `src/operator.js`
  Session collection, action proposal, and approval workflow
- `src/agent-backend.js`
  Draft generation backend with OpenAI or heuristic fallback
- `src/cli.js`
  Command-line entrypoint
- `scripts/send-connection-invite.mjs`
  Direct connection invite executor for approved profile outreach
- `SKILL.md`
  Codex-first operating contract for using this repo as a LinkedIn executor skill

## Session files

Session and planning runs write JSON files under:

```bash
.output/sessions/
```

These files contain:

- collected inbox/feed/networking data
- proposed actions
- approval history

They are useful for:

- replaying or inspecting recommendations
- executing a saved action with `act`
- debugging parser quality

## Examples

### Example 1: morning inbox + feed review

```bash
npm start -- --show-browser session
```

### Example 2: collect a raw snapshot for analysis

```bash
npm start -- collect --output .output/collect.json
```

### Example 3: plan actions without sending anything

```bash
npm start -- plan
```

### Example 4: send an approved connection invite

```bash
node ./scripts/send-connection-invite.mjs "https://www.linkedin.com/in/barbararodziewicz/" "Dzień dobry, zapraszam do mojej sieci kontaktów. Prowadzę obszary ML/AI i engineering, chętnie pozostanę w kontakcie."
```

### Example 4: draft a post with OpenAI enabled

```bash
export OPENAI_API_KEY=your_key_here
npm start -- draft-post --prompt "Write a post about using local browser agents safely in production workflows."
```

## Safety model

Current defaults:

- message sends happen only after explicit approval
- feed engagement suggestions can be executed as comments when a direct post URL is available
- connection/invitation workflows are collected and surfaced for review
- the tool does not run as a background daemon
- the tool does not auto-post
- the tool does not auto-connect

This is deliberate. The project is meant to support delegation without turning into an opaque unattended bot.

## Troubleshooting

### The browser closes before I can log in

Use:

```bash
npm start -- --show-browser login
```

The current login flow keeps the browser open until you press Enter in the terminal.

### Feed returns empty items

Run:

```bash
npm start -- --show-browser feed --limit 10 --debug-artifacts
```

Then inspect:

- `.output/feed-debug.png`
- `.output/feed-debug.html`

LinkedIn changes its feed DOM frequently, so feed parsing is best-effort.

### Inbox or collect feels slow

This usually means LinkedIn is slow to load or the session is being revalidated.

Try:

```bash
npm start -- --show-browser inbox --limit 10
```

If that works but `collect` feels slow, the combined workflow is spending time across multiple LinkedIn surfaces.

### Session expired or redirected to login/checkpoint

Run:

```bash
npm start -- --show-browser login
```

and refresh the saved browser session.

### Draft quality is weak

Set:

```bash
export OPENAI_API_KEY=your_key_here
```

Without an API key, the project falls back to heuristic drafts.

### A selector stops matching

Update parsing logic in:

```bash
src/linkedin-client.js
```

and use the debug artifacts to inspect the current LinkedIn DOM.

## Current limitations

- Feed parsing is heuristic because LinkedIn’s feed markup is highly dynamic.
- Inbox and thread parsing depend on LinkedIn’s current messaging DOM.
- `act` currently supports only message-send actions.
- Feed engagement, networking actions, and posting are still approval/review oriented rather than fully executable flows.
- This tool is designed for supervised local use, not always-on autonomous operation.

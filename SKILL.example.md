---
name: linkedin-operator
description: Use this project as a local LinkedIn execution layer that Codex drives. Trigger when the user wants Codex to review LinkedIn feed or inbox activity, draft replies or comments, plan outreach, or execute approved LinkedIn actions through the local CLI.
---

# LinkedIn Operator

Codex is the planner and drafter. The CLI in this repo is the deterministic browser executor.

Use this skill when the user wants LinkedIn work handled through Codex rather than through an in-app LLM workflow.

## Required local context

Before making LinkedIn decisions in this project, read:

- [operator-profile.md](/Users/karol/Documents/Lectures/GenAI%20playground/LI/operator-profile.md)

Treat that file as the project-local policy for tone, priorities, approvals, and engagement preferences. If it conflicts with generic skill guidance, follow `operator-profile.md`.

## Non-negotiable approval rule

Never send a LinkedIn message, post a comment, publish a post, send a connection request, or perform any other mutating LinkedIn action unless the user explicitly approves that exact action in the current conversation.

Default behavior:

- collect and analyze automatically
- draft replies and comments automatically
- propose actions
- stop and ask before execution

This rule overrides any convenience or automation preference. When in doubt, do not execute.

## Operating model

- Collect LinkedIn state with the local CLI.
- Read the returned JSON yourself.
- Decide what matters.
- Draft reply or comment text yourself.
- Only execute risky actions after explicit user approval.

Do not treat the CLI's own draft generation as the source of truth. If the user wants Codex in control, use the collected data and write the text in Codex.

## Primary commands

Run from the project root.

```bash
npm start -- collect --output .output/collect.json
npm start -- inbox --limit 10 --output .output/inbox.json
npm start -- feed --limit 10 --output .output/feed.json
npm start -- thread --thread-url "https://www.linkedin.com/messaging/thread/..."
npm start -- send --thread-url "https://www.linkedin.com/messaging/thread/..." --message "..."
npm start -- comment --post-url "https://www.linkedin.com/feed/update/..." --message "..."
```

Visible browser mode is the default. Use `--headless` only if you explicitly want background execution and it works reliably in your environment.
By default the CLI uses Playwright's `chrome` channel (system Chrome) and falls back to bundled Chromium if needed. You can override with `--browser-channel chromium`.
If channels are unreliable, pin the executable with `--browser-executable`.

```bash
npm start -- login
npm start -- feed --limit 10
npm start -- session
```

## Recommended Codex workflow

## Daily routines

### Morning

Use an inbox-first pass to clear important conversations and prepare replies.

```bash
npm start -- inbox --limit 10 --output .output/inbox-morning.json
```

Then:

1. Review recent threads.
2. Open full threads for the important ones.
3. Draft replies in Codex using `operator-profile.md`.
4. Ask for approval.
5. Execute with `send`.

### Midday

Use a feed-engagement pass to maintain visibility with selective comments.

```bash
npm start -- feed --limit 10 --output .output/feed-midday.json
```

Then:

1. Select 1-3 posts worth engaging with.
2. Draft comments in Codex using `operator-profile.md`.
3. Ask for approval.
4. Execute with `comment` when a direct post URL is available.

### End of day

Use a collection and planning pass to prepare follow-ups and networking actions.

```bash
npm start -- collect --output .output/collect-evening.json
```

Then:

1. Review invitations, unanswered threads, and feed opportunities.
2. Identify follow-ups for tomorrow.
3. Draft messages or notes in Codex.
4. Execute only approved actions.

### Inbox

1. Run `collect` or `inbox`.
2. Identify threads worth replying to.
3. For selected threads, run `thread`.
4. Draft the reply in Codex.
5. Ask for approval.
6. Execute with `send`.

### Feed

1. Run `collect` or `feed`.
2. Select posts that warrant engagement.
3. Draft the comment in Codex.
4. Ask for approval.
5. Execute with `comment` when the item has a real post URL.

If the feed item only contains a profile URL or the page structure is ambiguous, stop at draft plus manual review instead of trying to mutate the page.

## Safety rules

- Never auto-send messages without explicit approval in the current conversation.
- Never auto-comment without explicit approval in the current conversation.
- Treat connection actions and networking actions as manual-review unless there is an explicit executor command for them.
- If parsing looks wrong, inspect `.output/feed-debug.*`, `.output/inbox-debug.*`, or `.output/sessions/*.json`.
- If LinkedIn redirects to login, checkpoint, or authwall, have the user refresh the session with `npm start -- login`.

## Current executor coverage

- Read feed items
- Read inbox threads
- Read full message threads
- Send a message
- Post a comment on a direct post URL

## Current limitations

- Feed parsing is heuristic and can break when LinkedIn changes markup.
- Comment execution depends on a direct post URL and current LinkedIn comment composer selectors.
- Connection acceptance, connection sending, and reactions are not yet implemented as executor commands.

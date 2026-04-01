#!/usr/bin/env node

import { Command } from "commander";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { LinkedInClient } from "./linkedin-client.js";
import { ensureProjectDirs } from "./config.js";
import { createDraftBackend } from "./agent-backend.js";
import {
  collectSessionData,
  executeActionFile,
  proposeActions,
  runInteractiveSession,
  saveSessionFile,
} from "./operator.js";

async function confirmMutation(summary) {
  const rl = readline.createInterface({ input, output });

  try {
    output.write(`${summary}\n`);
    const response = (await rl.question("Confirm execution? [y/n] > ")).trim().toLowerCase();
    return response === "y";
  } finally {
    rl.close();
  }
}

async function emitResult(result, outputPath) {
  const data = `${JSON.stringify(result, null, 2)}\n`;

  if (outputPath) {
    const client = new LinkedInClient();
    await client.writeOutput(path.resolve(outputPath), result);
    process.stdout.write(`Wrote output to ${path.resolve(outputPath)}\n`);
    return;
  }

  process.stdout.write(data);
}

function buildClient(options) {
  return new LinkedInClient({
    headless: options.headless ?? false,
    slowMo: options.slowMo ?? 0,
    browserChannel: options.browserChannel ?? "chrome",
    browserExecutablePath: options.browserExecutable ?? null,
  });
}

async function main() {
  await ensureProjectDirs();

  const program = new Command();
  program
    .name("li-tool")
    .description("Local LinkedIn automation CLI")
    .option("--headless", "run without a visible browser window", false)
    .option("--browser-channel <name>", "Playwright browser channel (default: chrome)", "chrome")
    .option("--browser-executable <path>", "browser executable path (overrides channel)")
    .option("-y, --yes", "skip interactive confirmation prompts for mutating actions", false)
    .option("--slow-mo <ms>", "slow down browser actions", (value) => Number.parseInt(value, 10), 0);

  program
    .command("login")
    .description("open LinkedIn and persist a logged-in browser session")
    .action(async () => {
      const client = buildClient(program.opts());
      const result = await client.login();
      await emitResult(result);
    });

  program
    .command("feed")
    .description("fetch feed cards")
    .option("--limit <n>", "maximum number of items", (value) => Number.parseInt(value, 10), 10)
    .option("--debug-artifacts", "save screenshot and HTML for selector debugging")
    .option("--output <path>", "write JSON output to a file")
    .action(async (options) => {
      const client = buildClient(program.opts());
      const result = await client.getFeed(options.limit, {
        debugArtifacts: options.debugArtifacts,
      });
      await emitResult(result, options.output);
    });

  program
    .command("inbox")
    .description("list recent message threads")
    .option("--limit <n>", "maximum number of threads", (value) => Number.parseInt(value, 10), 20)
    .option("--debug-artifacts", "save screenshot and HTML for selector debugging")
    .option("--output <path>", "write JSON output to a file")
    .action(async (options) => {
      const client = buildClient(program.opts());
      const result = await client.getInbox(options.limit, {
        debugArtifacts: options.debugArtifacts,
      });
      await emitResult(result, options.output);
    });

  program
    .command("collect")
    .description("collect inbox, feed, and networking data into one JSON payload")
    .option("--inbox-limit <n>", "maximum number of threads", (value) => Number.parseInt(value, 10), 8)
    .option("--feed-limit <n>", "maximum number of feed items", (value) => Number.parseInt(value, 10), 8)
    .option("--networking-limit <n>", "maximum number of invitations", (value) => Number.parseInt(value, 10), 10)
    .option("--debug-artifacts", "save screenshot and HTML for selector debugging")
    .option("--output <path>", "write JSON output to a file")
    .action(async (options) => {
      const client = buildClient(program.opts());
      const result = await collectSessionData(client, options);
      await emitResult(result, options.output);
    });

  program
    .command("search-people")
    .description("search LinkedIn people results without sending invites")
    .requiredOption("--query <text>", "free-text LinkedIn people search query")
    .option("--limit <n>", "maximum number of people", (value) => Number.parseInt(value, 10), 10)
    .option("--debug-artifacts", "save screenshot and HTML for selector debugging")
    .option("--output <path>", "write JSON output to a file")
    .action(async (options) => {
      const client = buildClient(program.opts());
      const result = await client.searchPeople(options.query, options.limit, {
        debugArtifacts: options.debugArtifacts,
      });
      await emitResult(result, options.output);
    });

  program
    .command("invite-search")
    .description("search LinkedIn people results and send invites to the top matches in one session")
    .requiredOption("--query <text>", "free-text LinkedIn people search query")
    .option("--limit <n>", "maximum number of invites to attempt", (value) => Number.parseInt(value, 10), 5)
    .option("--note <text>", "optional custom invite note")
    .option("--output <path>", "write JSON output to a file")
    .action(async (options) => {
      const noteSummary = options.note ? `\n\nInvite note:\n${options.note}` : "\n\nInvite note: none";
      const confirmed = program.opts().yes
        ? true
        : await confirmMutation(
            `About to search LinkedIn people and send up to ${options.limit} connection invites.\n\nQuery:\n${options.query}${noteSummary}`,
          );
      if (!confirmed) {
        await emitResult({ ok: false, canceled: true, reason: "User declined confirmation." });
        return;
      }

      const client = buildClient(program.opts());
      const result = await client.invitePeopleFromSearch(options.query, options.limit, {
        note: options.note,
      });
      await emitResult(result, options.output);
    });

  program
    .command("thread")
    .description("read a specific message thread")
    .requiredOption("--thread-url <url>", "LinkedIn thread URL")
    .option("--output <path>", "write JSON output to a file")
    .action(async (options) => {
      const client = buildClient(program.opts());
      const result = await client.getThread(options.threadUrl);
      await emitResult(result, options.output);
    });

  program
    .command("send")
    .description("send a message into a specific thread")
    .requiredOption("--thread-url <url>", "LinkedIn thread URL")
    .requiredOption("--message <text>", "message body")
    .action(async (options) => {
      const confirmed = program.opts().yes
        ? true
        : await confirmMutation(
            `About to send LinkedIn message to:\n${options.threadUrl}\n\nMessage:\n${options.message}`,
          );
      if (!confirmed) {
        await emitResult({ ok: false, canceled: true, reason: "User declined confirmation." });
        return;
      }

      const client = buildClient(program.opts());
      const result = await client.sendMessage(options.threadUrl, options.message);
      await emitResult(result);
    });

  program
    .command("comment")
    .description("post a comment on a specific LinkedIn post URL")
    .requiredOption("--post-url <url>", "LinkedIn post URL")
    .requiredOption("--message <text>", "comment body")
    .action(async (options) => {
      const confirmed = program.opts().yes
        ? true
        : await confirmMutation(
            `About to post LinkedIn comment to:\n${options.postUrl}\n\nComment:\n${options.message}`,
          );
      if (!confirmed) {
        await emitResult({ ok: false, canceled: true, reason: "User declined confirmation." });
        return;
      }

      const client = buildClient(program.opts());
      const result = await client.commentOnPost(options.postUrl, options.message);
      await emitResult(result);
    });

  program
    .command("session")
    .description("run an interactive daily LinkedIn review session")
    .option("--inbox-limit <n>", "maximum number of threads", (value) => Number.parseInt(value, 10), 8)
    .option("--feed-limit <n>", "maximum number of feed items", (value) => Number.parseInt(value, 10), 8)
    .option("--networking-limit <n>", "maximum number of invitations", (value) => Number.parseInt(value, 10), 10)
    .option("--reply-limit <n>", "maximum number of reply drafts", (value) => Number.parseInt(value, 10), 5)
    .option("--feed-action-limit <n>", "maximum number of feed actions", (value) => Number.parseInt(value, 10), 4)
    .option("--networking-action-limit <n>", "maximum number of networking actions", (value) => Number.parseInt(value, 10), 4)
    .option("--debug-artifacts", "save screenshot and HTML for selector debugging")
    .action(async (options) => {
      const client = buildClient(program.opts());
      const result = await runInteractiveSession(client, options);
      await emitResult(result);
    });

  program
    .command("act")
    .description("execute one saved action from a session file")
    .requiredOption("--session-file <path>", "saved session JSON file")
    .requiredOption("--action-id <id>", "action identifier")
    .option("--message <text>", "override the saved draft text")
    .action(async (options) => {
      const confirmed = program.opts().yes
        ? true
        : await confirmMutation(
            `About to execute saved action:\n${path.resolve(options.sessionFile)}\nAction ID: ${options.actionId}${options.message ? `\nOverride message:\n${options.message}` : ""}`,
          );
      if (!confirmed) {
        await emitResult({ ok: false, canceled: true, reason: "User declined confirmation." });
        return;
      }

      const client = buildClient(program.opts());
      const result = await executeActionFile(
        client,
        path.resolve(options.sessionFile),
        options.actionId,
        { message: options.message },
      );
      await emitResult(result);
    });

  program
    .command("draft-post")
    .description("draft a LinkedIn post from a prompt")
    .requiredOption("--prompt <text>", "prompt or source text")
    .option("--output <path>", "write JSON output to a file")
    .action(async (options) => {
      const backend = createDraftBackend();
      const result = {
        backendMode: backend.mode,
        draft: await backend.draftPost(options.prompt),
      };
      await emitResult(result, options.output);
    });

  program
    .command("plan")
    .description("collect data and write a saved action queue without executing anything")
    .option("--inbox-limit <n>", "maximum number of threads", (value) => Number.parseInt(value, 10), 8)
    .option("--feed-limit <n>", "maximum number of feed items", (value) => Number.parseInt(value, 10), 8)
    .option("--networking-limit <n>", "maximum number of invitations", (value) => Number.parseInt(value, 10), 10)
    .option("--reply-limit <n>", "maximum number of reply drafts", (value) => Number.parseInt(value, 10), 5)
    .option("--feed-action-limit <n>", "maximum number of feed actions", (value) => Number.parseInt(value, 10), 4)
    .option("--networking-action-limit <n>", "maximum number of networking actions", (value) => Number.parseInt(value, 10), 4)
    .option("--debug-artifacts", "save screenshot and HTML for selector debugging")
    .action(async (options) => {
      const client = buildClient(program.opts());
      const collected = await collectSessionData(client, options);
      const proposed = await proposeActions(client, collected, options);
      const session = { collected, proposed, approvals: [] };
      const result = await saveSessionFile(session);
      await emitResult({ ...result, actionCount: proposed.actions.length });
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  const details = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${details}\n`);
  process.exitCode = 1;
});

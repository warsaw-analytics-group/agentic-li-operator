import path from "node:path";
import readline from "node:readline/promises";
import { readFile, writeFile } from "node:fs/promises";
import { stdin as input, stdout as output } from "node:process";
import { createDraftBackend } from "./agent-backend.js";
import { paths } from "./config.js";

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function summarize(text, max = 220) {
  const clean = text?.replace(/\s+/g, " ").trim() ?? "";
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function isCommentablePostUrl(url) {
  return Boolean(url && /linkedin\.com\/.*(?:\/feed\/update\/|\/posts\/|\/pulse\/)/i.test(url));
}

export async function collectSessionData(client, options = {}) {
  const inboxLimit = options.inboxLimit ?? 8;
  const feedLimit = options.feedLimit ?? 8;

  const inbox = await client.getInbox(inboxLimit, {
    debugArtifacts: options.debugArtifacts,
  });
  const feed = await client.getFeed(feedLimit, {
    debugArtifacts: options.debugArtifacts,
  });
  const networking = await client.getNetworking(options.networkingLimit ?? 10);

  return {
    collectedAt: new Date().toISOString(),
    inbox,
    feed,
    networking,
  };
}

export async function proposeActions(client, collected, options = {}) {
  const backend = createDraftBackend();
  const actions = [];

  for (const thread of collected.inbox.threads.slice(0, options.replyLimit ?? 5)) {
    if (!thread.threadUrl) {
      continue;
    }

    const details = await client.getThread(thread.threadUrl);
    const draftText = await backend.draftReply(details);

    actions.push({
      id: `reply-${actions.length + 1}`,
      type: "reply_message",
      targetId: thread.threadUrl,
      targetLabel: thread.title || "Untitled thread",
      targetUrl: thread.threadUrl,
      reason: thread.preview || "Recent LinkedIn conversation",
      draftText,
      requiresApproval: true,
      execution: {
        type: "send_message",
        threadUrl: thread.threadUrl,
      },
      source: {
        kind: "message_thread",
        thread,
        details,
      },
    });
  }

  for (const item of collected.feed.items.slice(0, options.feedActionLimit ?? 4)) {
    const draftText = await backend.draftComment(item);
    const isCommentable = isCommentablePostUrl(item.url);
    actions.push({
      id: `feed-${actions.length + 1}`,
      type: "engage_feed_post",
      targetId: item.url || item.actor,
      targetLabel: item.actor || "Feed item",
      targetUrl: item.url,
      reason: summarize(item.body, 140),
      draftText,
      requiresApproval: true,
      execution: {
        type: isCommentable ? "comment_post" : "manual_review",
        postUrl: isCommentable ? item.url : undefined,
      },
      source: {
        kind: "feed_post",
        item,
      },
    });
  }

  for (const invite of collected.networking.invitations.slice(0, options.networkingActionLimit ?? 4)) {
    actions.push({
      id: `network-${actions.length + 1}`,
      type: "review_connection_request",
      targetId: invite.profileUrl || invite.name,
      targetLabel: invite.name,
      targetUrl: invite.profileUrl,
      reason: invite.headline || "Incoming invitation",
      draftText: "",
      requiresApproval: true,
      execution: {
        type: "manual_review",
      },
      source: {
        kind: "connection_request",
        invite,
      },
    });
  }

  return {
    backendMode: backend.mode,
    proposedAt: new Date().toISOString(),
    actions,
  };
}

export async function saveSessionFile(sessionState) {
  const sessionId = nowStamp();
  const sessionFile = path.join(paths.sessionsDir, `${sessionId}.json`);
  await writeFile(sessionFile, `${JSON.stringify(sessionState, null, 2)}\n`, "utf8");
  return { sessionId, sessionFile };
}

function printAction(action, index) {
  output.write(`\n[${index + 1}] ${action.type} -> ${action.targetLabel}\n`);
  output.write(`Reason: ${summarize(action.reason, 220)}\n`);
  if (action.targetUrl) {
    output.write(`URL: ${action.targetUrl}\n`);
  }
  if (action.draftText) {
    output.write(`Draft:\n${action.draftText}\n`);
  }
}

async function confirmActionExecution(rl, action, draftText) {
  output.write("Execution preview:\n");
  output.write(`Action: ${action.type}\n`);
  if (action.targetUrl) {
    output.write(`Target: ${action.targetUrl}\n`);
  }
  if (draftText) {
    output.write(`Draft:\n${draftText}\n`);
  }

  const response = (await rl.question("Execute this action now? [y/n] > ")).trim().toLowerCase();
  return response === "y";
}

export async function runInteractiveSession(client, options = {}) {
  const collected = await collectSessionData(client, options);
  const proposed = await proposeActions(client, collected, options);
  const session = {
    collected,
    proposed,
    approvals: [],
  };

  const { sessionFile } = await saveSessionFile(session);
  const rl = readline.createInterface({ input, output });

  try {
    output.write(`Session file: ${sessionFile}\n`);
    output.write(`Draft backend: ${proposed.backendMode}\n`);

    for (let index = 0; index < proposed.actions.length; index += 1) {
      const action = proposed.actions[index];
      printAction(action, index);

      const response = (
        await rl.question("Choose: [a]pprove, [e]dit, [s]kip, [o]pen-url, [q]uit > ")
      )
        .trim()
        .toLowerCase();

      if (response === "q") {
        break;
      }

      if (response === "o") {
        output.write(`Open this manually: ${action.targetUrl || "No URL"}\n`);
        index -= 1;
        continue;
      }

      if (response === "s") {
        session.approvals.push({ actionId: action.id, decision: "skipped" });
        continue;
      }

      let draftText = action.draftText;
      if (response === "e") {
        draftText = await rl.question("Enter replacement draft text:\n");
      }

      if (action.execution.type === "send_message") {
        const confirmed = await confirmActionExecution(rl, action, draftText);
        if (!confirmed) {
          session.approvals.push({ actionId: action.id, decision: "declined_execution", draftText });
          continue;
        }

        await client.sendMessage(action.execution.threadUrl, draftText);
        output.write("Message sent.\n");
        session.approvals.push({ actionId: action.id, decision: "approved", draftText });
        continue;
      }

      if (action.execution.type === "comment_post") {
        const confirmed = await confirmActionExecution(rl, action, draftText);
        if (!confirmed) {
          session.approvals.push({ actionId: action.id, decision: "declined_execution", draftText });
          continue;
        }

        await client.commentOnPost(action.execution.postUrl, draftText);
        output.write("Comment posted.\n");
        session.approvals.push({ actionId: action.id, decision: "approved", draftText });
        continue;
      }

      output.write("Manual-review action recorded. No browser mutation was performed.\n");
      session.approvals.push({ actionId: action.id, decision: "approved_manual", draftText });
    }
  } finally {
    rl.close();
    await writeFile(sessionFile, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  }

  return {
    ok: true,
    sessionFile,
    actionCount: proposed.actions.length,
    approvals: session.approvals.length,
  };
}

export async function executeActionFile(client, actionFile, actionId, options = {}) {
  const raw = JSON.parse(await readFile(actionFile, "utf8"));
  const action = raw.proposed?.actions?.find((entry) => entry.id === actionId);

  if (!action) {
    throw new Error(`Action ${actionId} not found in ${actionFile}`);
  }

  if (action.execution.type === "send_message") {
    const message = options.message || action.draftText;
    await client.sendMessage(action.execution.threadUrl, message);

    return {
      ok: true,
      actionId,
      message,
    };
  }

  if (action.execution.type === "comment_post") {
    const message = options.message || action.draftText;
    await client.commentOnPost(action.execution.postUrl, message);

    return {
      ok: true,
      actionId,
      message,
      postUrl: action.execution.postUrl,
    };
  }

  if (action.execution.type !== "send_message") {
    return {
      ok: false,
      actionId,
      message: "This action is manual-review only in the current implementation.",
    };
  }
}

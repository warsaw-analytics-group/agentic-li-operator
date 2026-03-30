const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

function clip(value, max = 4000) {
  const text = value?.trim() ?? "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function heuristicReplyDraft(thread) {
  const latest = thread.messages?.at(-1)?.body || "";
  const shorter = latest.split(/[.!?]\s/)[0]?.trim() || "your note";

  return `Thanks for your message. I saw your note about "${clip(shorter, 120)}". Happy to continue the conversation here. Let me know what would be most useful to discuss next.`;
}

function heuristicCommentDraft(feedItem) {
  const actor = feedItem.actor || "you";
  return `Interesting perspective, ${actor}. Thanks for sharing this.`;
}

async function openAiResponsesRequest(payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${details}`);
  }

  return response.json();
}

async function draftWithOpenAi(prompt) {
  const data = await openAiResponsesRequest({
    model: DEFAULT_MODEL,
    input: prompt,
  });

  return data.output_text?.trim() ?? "";
}

export function createDraftBackend() {
  const mode = process.env.OPENAI_API_KEY ? "openai" : "heuristic";

  return {
    mode,
    async draftReply(thread) {
      if (mode === "heuristic") {
        return heuristicReplyDraft(thread);
      }

      const prompt = [
        "Draft a concise professional LinkedIn reply.",
        "Style: warm, direct, no fluff, 3-5 sentences max.",
        "Do not invent facts or commitments.",
        `Thread title: ${thread.title || ""}`,
        "Recent messages:",
        clip(
          (thread.messages || [])
            .slice(-6)
            .map((message) => `${message.sender || "Unknown"}: ${message.body || ""}`)
            .join("\n"),
        ),
      ].join("\n");

      return draftWithOpenAi(prompt);
    },
    async draftComment(feedItem) {
      if (mode === "heuristic") {
        return heuristicCommentDraft(feedItem);
      }

      const prompt = [
        "Draft a concise professional LinkedIn comment.",
        "Style: natural, useful, non-generic, 1-3 sentences.",
        "Do not overpraise. Avoid emoji.",
        `Post author: ${feedItem.actor || ""}`,
        `Post content: ${clip(feedItem.body || "")}`,
      ].join("\n");

      return draftWithOpenAi(prompt);
    },
    async draftPost(prompt) {
      if (mode === "heuristic") {
        return `Working draft:\n\n${prompt.trim()}\n\nKey takeaway: add a concrete opinion, one example, and a closing takeaway or question.`;
      }

      return draftWithOpenAi(
        [
          "Draft a LinkedIn post.",
          "Style: clear, credible, professional, compact paragraphs.",
          "Length: 120-220 words unless the prompt clearly requires shorter.",
          "No emoji unless explicitly requested.",
          `Prompt: ${clip(prompt, 5000)}`,
        ].join("\n"),
      );
    },
  };
}

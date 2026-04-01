import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import fs from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { ensureProjectDirs, paths } from "./config.js";

const DEFAULT_TIMEOUT_MS = 20000;

function normalizeText(value) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function normalizeProfileUrl(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function buildPeopleSearchUrl(query) {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}&origin=GLOBAL_SEARCH_HEADER`;
}

async function textContent(locator) {
  try {
    return normalizeText(await locator.textContent({ timeout: 3000 }));
  } catch {
    return "";
  }
}

async function maybeAttribute(locator, name) {
  try {
    return await locator.getAttribute(name, { timeout: 3000 });
  } catch {
    return null;
  }
}

async function boundedNetworkIdle(page, timeoutMs = 5000) {
  await Promise.race([
    page.waitForLoadState("networkidle"),
    page.waitForTimeout(timeoutMs),
  ]).catch(() => {});
}

async function isLoggedIn(page) {
  const currentUrl = page.url();
  if (/linkedin\.com\/(login|checkpoint|authwall)/.test(currentUrl)) {
    return false;
  }

  const signedInMarker = page
    .locator("nav a[href*='/feed/'], nav a[href*='/messaging/'], .global-nav")
    .first();

  return signedInMarker.isVisible().catch(() => false);
}

async function ensureSignedIn(page) {
  if (await isLoggedIn(page)) {
    return;
  }

  throw new Error("LinkedIn session is not signed in. Run `npm start -- --show-browser login` first.");
}

async function collectFeedCards(page, limit) {
  const cardSelectors = [
    "div.feed-shared-update-v2",
    "div.occludable-update",
    "main [data-urn*='urn:li:activity:']",
    "main [data-id^='urn:li:activity:']",
  ];

  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (const selector of cardSelectors) {
      const locator = page.locator(selector);
      const count = await locator.count();
      if (count > 0) {
        return locator;
      }
    }

    await page.mouse.wheel(0, 1800).catch(() => {});
    await page.waitForTimeout(1500);
  }

  return page.locator(cardSelectors.join(", "));
}

async function captureDebugArtifacts(page, name) {
  const safeName = name.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  const screenshotPath = path.join(paths.outputDir, `${safeName}.png`);
  const htmlPath = path.join(paths.outputDir, `${safeName}.html`);

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await writeFile(htmlPath, await page.content(), "utf8").catch(() => {});

  return {
    screenshotPath,
    htmlPath,
  };
}

async function clickFirstVisible(scope, selectors) {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const enabled = await locator.isEnabled().catch(() => true);
    if (enabled) {
      await locator.click();
      return true;
    }
  }

  return false;
}

async function scrollSearchResults(page, targetCount) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const count = await page.locator("main a[href*='/in/']").count();
    if (count >= targetCount) {
      return;
    }

    await page.mouse.wheel(0, 2200).catch(() => {});
    await page.waitForTimeout(1200);
  }
}

async function extractPeopleSearchResults(page, limit) {
  return page.evaluate((maxItems) => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
    const root = document.querySelector("main") || document.body;
    const anchors = Array.from(root.querySelectorAll('a[href*="/in/"]'));
    const items = [];
    const seen = new Set();

    for (const anchor of anchors) {
      const anchorText = normalize(anchor.textContent || "");
      if (
        !anchorText ||
        anchorText.length < 40 ||
        !/(connect|message|follow|current:|current )/i.test(anchorText) ||
        /mutual connection/i.test(anchorText)
      ) {
        continue;
      }

      const profileUrl = anchor.href.split("?")[0].replace(/\/+$/, "");
      if (!profileUrl || seen.has(profileUrl)) {
        continue;
      }

      const text = anchorText;
      const leadingSegment = text.split(/Connect|Message|Follow|Current:|Current /i)[0];
      const name = normalize(leadingSegment.split("•")[0]);

      if (!name || name.length < 2) {
        continue;
      }

      const cleaned = text
        .replace(name, "")
        .replace(/^Follow\s*/i, "")
        .replace(/\s*Message\s*/gi, " ")
        .trim();

      const parts = cleaned
        .split(/\n| · |Current:|Current /)
        .map((part) => normalize(part))
        .filter(Boolean);

      let headline = "";
      let location = "";
      for (const part of parts) {
        if (
          !headline &&
          part.length > 6 &&
          !/(connect|message|follow|mutual connection|2nd|3rd\+|3rd)/i.test(part)
        ) {
          headline = part;
          continue;
        }

        if (
          !location &&
          /(remote|united states|usa|europe|poland|germany|france|spain|italy|uk|united kingdom|warsaw|krakow|berlin|london|paris|madrid|rome|metropolitan area)/i.test(part)
        ) {
          location = part;
        }
      }

      seen.add(profileUrl);
      items.push({
        name,
        headline,
        location,
        profileUrl,
        rawText: text,
      });

      if (items.length >= maxItems) {
        break;
      }
    }

    return items;
  }, limit);
}

function summarizeInviteState(text) {
  const haystack = normalizeText(text).toLowerCase();
  if (!haystack) {
    return "unknown";
  }
  if (/\bpending\b|oczekuje/.test(haystack)) {
    return "pending";
  }
  if (/\bmessage\b|wiadomość/.test(haystack) && !/\bconnect\b|zaproś/.test(haystack)) {
    return "connected";
  }
  if (/\bfollow\b|obserwuj/.test(haystack) && !/\bconnect\b|zaproś/.test(haystack)) {
    return "follow_only";
  }
  if (/\bconnect\b|zaproś/.test(haystack)) {
    return "invitable";
  }
  return "unknown";
}

async function completeInviteDialog(page, note) {
  const dialog = page.locator("[role='dialog']").last();
  const visible = await dialog.isVisible().catch(() => false);

  if (!visible) {
    return { ok: false, reason: "Invite dialog did not appear." };
  }

  if (note) {
    const addNoteClicked = await clickFirstVisible(dialog, [
      "button:has-text('Add a note')",
      "button:has-text('Dodaj notatkę')",
    ]);

    if (addNoteClicked) {
      await page.waitForTimeout(600);
    }

    const textarea = dialog.locator("textarea, #custom-message").first();
    if (await textarea.isVisible().catch(() => false)) {
      await textarea.fill(note);
    }
  }

  const sent = await clickFirstVisible(
    dialog,
    note
      ? [
          "button:has-text('Send')",
          "button:has-text('Wyślij')",
          "button:has-text('Done')",
          "button:has-text('Got it')",
        ]
      : [
          "button:has-text('Send without a note')",
          "button:has-text('Wyślij bez notatki')",
          "button:has-text('Send')",
          "button:has-text('Wyślij')",
          "button:has-text('Done')",
          "button:has-text('Got it')",
        ],
  );

  if (!sent) {
    return { ok: false, reason: "Could not submit the invitation dialog." };
  }

  await page.waitForTimeout(1500);
  return { ok: true };
}

async function inviteSearchResult(page, result, note) {
  const profileUrl = normalizeProfileUrl(result.profileUrl);
  await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await boundedNetworkIdle(page);
  await ensureSignedIn(page);

  const hero = page.locator("main section").first();
  await hero.waitFor({ state: "visible", timeout: 10000 });

  const preState = summarizeInviteState(await hero.innerText().catch(() => ""));
  if (preState === "pending") {
    return { ok: false, status: "pending", reason: "Invite already pending." };
  }
  if (preState === "connected") {
    return { ok: false, status: "connected", reason: "Already connected." };
  }
  if (preState === "follow_only") {
    return { ok: false, status: "follow_only", reason: "Profile exposes Follow instead of Connect." };
  }

  let connectClicked = await clickFirstVisible(hero, [
    "a[href*='/preload/custom-invite/']",
    "button:has-text('Connect')",
    "button:has-text('Zaproś')",
    "a:has-text('Connect')",
    "a:has-text('Zaproś')",
  ]);

  if (!connectClicked) {
    const moreClicked = await clickFirstVisible(hero, [
      "button[aria-label*='More actions']",
      "button[aria-label*='Więcej działań']",
      "button:has-text('More')",
      "button:has-text('Więcej')",
      ]);

    if (moreClicked) {
      await page.waitForTimeout(700);
      connectClicked = await clickFirstVisible(page, [
        "div[role='button']:has-text('Connect')",
        "div[role='button']:has-text('Zaproś')",
        "button:has-text('Connect')",
        "button:has-text('Zaproś')",
      ]);
    }
  }

  if (!connectClicked) {
    return {
      ok: false,
      status: preState === "invitable" ? "connect_not_clickable" : preState,
      reason: "Could not trigger the connect action from the profile.",
    };
  }

  await page.waitForTimeout(700);
  const dialogResult = await completeInviteDialog(page, note);
  if (!dialogResult.ok) {
    return {
      ok: false,
      status: "invite_failed",
      reason: dialogResult.reason,
    };
  }

  return {
    ok: true,
    status: "invited",
  };
}

async function extractFeedHeuristically(page, limit) {
  return page.evaluate((maxItems) => {
    const normalize = (value) => value.replace(/\s+/g, " ").trim();
    const cleanupFeedText = (value) =>
      normalize(value)
        .replace(/Video Player is loading\..*?End of dialog window\./gi, "")
        .replace(/Show translation/gi, "")
        .replace(/Play Video|Play|Skip Backward|Skip Forward|Unmute|Fullscreen/gi, "")
        .replace(/Current Time \d+:\d+\/Duration \d+:\d+/gi, "")
        .replace(/Loaded: \d+(?:\.\d+)?%/gi, "")
        .replace(/Stream Type LIVE|Playback Rate|Chapters|Descriptions|Captions|Audio Track|Picture-in-Picture/gi, "")
        .replace(/\s+/g, " ")
        .trim();
    const main = document.querySelector("main");
    if (!main) {
      return [];
    }

    const containers = Array.from(main.querySelectorAll("div, section, article"));
    const feedRoot =
      containers.find((node) => {
        const text = normalize(node.textContent || "");
        return text.includes("Start a post") && text.includes("Feed post");
      }) || main;

    const items = [];
    const seen = new Set();
    const candidates = Array.from(feedRoot.querySelectorAll("div, section, article"))
      .map((node) => ({ node, text: normalize(node.textContent || "") }))
      .filter(
        ({ text }) =>
          text.includes("Feed post") &&
          /LikeCommentRepostSend/i.test(text) &&
          text.length > 120 &&
          text.length < 5000,
      );

    for (const { node, text } of candidates) {
      if (
        /My pages|Grow your business faster|Try Premium Page|Advertise on LinkedIn|About Accessibility Help Center|View all recommendations|Get the LinkedIn app/i.test(
          text,
        )
      ) {
        continue;
      }

      const profileLink =
        node.querySelector('a[href*="/in/"]') ||
        node.querySelector('a[href*="/company/"][href*="/posts/"]') ||
        node.querySelector('a[href*="/company/"]') ||
        node.querySelector('a[href*="/showcase/"]');
      const postLink =
        node.querySelector('a[href*="/feed/update/"]') ||
        node.querySelector('a[href*="/posts/"]') ||
        node.querySelector('a[href*="/pulse/"]');
      const href = postLink?.href || profileLink?.href || "";

      const actor =
        normalize(profileLink?.querySelector("span[aria-hidden='true']")?.textContent || "") ||
        normalize(profileLink?.textContent || "") ||
        normalize(text.replace(/^.*?Feed post/, "").split("•")[0] || "");

      const body = cleanupFeedText(
        text
        .replace(/^.*?Feed post/, "")
        .replace(/LikeCommentRepostSend.*$/i, "")
        .replace(/^Promoted/i, "")
        .trim(),
      );
      if (!href || body.length < 40 || !actor) {
        continue;
      }

      const key = `${href}|${body.slice(0, 160)}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      items.push({
        actor,
        headline: "",
        body,
        url: href,
      });

      if (items.length >= maxItems) {
        break;
      }
    }

    return items;
  }, limit);
}

export class LinkedInClient {
  constructor(options = {}) {
    this.headless = options.headless ?? true;
    this.slowMo = options.slowMo ?? 0;
    this.browserChannel = options.browserChannel ?? null;
    this.browserExecutablePath = options.browserExecutablePath ?? null;
  }

  detectExecutablePath() {
    if (this.browserExecutablePath) {
      return this.browserExecutablePath;
    }

    if (process.platform !== "darwin") {
      return null;
    }

    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  async launchContext() {
    await ensureProjectDirs();

    const executablePath = this.detectExecutablePath();
    const launchOptions = {
      headless: this.headless,
      slowMo: this.slowMo,
      viewport: { width: 1440, height: 1100 },
      channel: executablePath ? undefined : this.browserChannel || undefined,
      executablePath: executablePath || undefined,
    };

    try {
      return await chromium.launchPersistentContext(paths.authDir, launchOptions);
    } catch (error) {
      // Some environments (or sandboxes) may block Playwright's bundled browsers.
      // If a specific channel fails, retry with Playwright's default Chromium.
      if (launchOptions.channel || launchOptions.executablePath) {
        return chromium.launchPersistentContext(paths.authDir, {
          ...launchOptions,
          executablePath: undefined,
          channel: undefined,
        });
      }
      throw error;
    }
  }

  async withPage(task) {
    const context = await this.launchContext();

    context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    const page = context.pages()[0] ?? (await context.newPage());

    try {
      return await task(page, context);
    } finally {
      await context.close();
    }
  }

  async login() {
    await ensureProjectDirs();

    const context = await chromium.launchPersistentContext(paths.authDir, {
      headless: this.headless,
      slowMo: this.slowMo,
      viewport: { width: 1440, height: 1100 },
      channel: this.browserChannel || undefined,
    });

    context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    const page = context.pages()[0] ?? (await context.newPage());

    try {
      await page.goto("https://www.linkedin.com/login", {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(1000);

      const rl = readline.createInterface({ input, output });
      try {
        await rl.question(
          "Complete LinkedIn login in the opened browser, then press Enter here to save the session.",
        );
      } finally {
        rl.close();
      }

      return {
        ok: true,
        authDir: paths.authDir,
      };
    } finally {
      await context.close();
    }
  }

  async getFeed(limit = 10, options = {}) {
    return this.withPage(async (page) => {
      await page.goto("https://www.linkedin.com/feed/", {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(2500);
      await boundedNetworkIdle(page);
      await ensureSignedIn(page);

      await page
        .locator("main, .scaffold-layout__main, .feed-identity-module")
        .first()
        .waitFor({ state: "visible", timeout: 15000 });

      const cards = await collectFeedCards(page, limit);
      const count = Math.min(await cards.count(), limit);
      const items = [];

      for (let index = 0; index < count; index += 1) {
        const card = cards.nth(index);
        const actor = await textContent(
          card.locator(
            "a[href*='/in/'] span[aria-hidden='true'], .update-components-actor__title span[aria-hidden='true'], .update-components-actor__name span[aria-hidden='true'], .feed-shared-actor__name span[aria-hidden='true']",
          ).first(),
        );
        const headline = await textContent(
          card.locator(
            ".update-components-actor__description, .update-components-actor__sub-description, .feed-shared-actor__description",
          ).first(),
        );
        const body = await textContent(
          card.locator(
            ".update-components-text, .feed-shared-inline-show-more-text, .feed-shared-update-v2__description, .update-components-update-v2__commentary",
          ).first(),
        );
        const link = await maybeAttribute(
          card.locator("a[href*='/feed/update/'], a[href*='/posts/'], a[href*='/pulse/']").first(),
          "href",
        );

        if (!actor && !body) {
          continue;
        }

        items.push({
          actor,
          headline,
          body,
          url: link,
        });
      }

      if (items.length === 0) {
        const fallbackItems = await extractFeedHeuristically(page, limit);
        items.push(...fallbackItems);
      }

      const result = {
        count: items.length,
        items,
        debug: {
          url: page.url(),
          rawCardCount: await cards.count(),
        },
      };

      if (options.debugArtifacts || items.length === 0) {
        result.debug.artifacts = await captureDebugArtifacts(page, "feed-debug");
      }

      return result;
    });
  }

  async getInbox(limit = 20, options = {}) {
    return this.withPage(async (page) => {
      await page.goto("https://www.linkedin.com/messaging/", {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(2000);
      await boundedNetworkIdle(page);
      await ensureSignedIn(page);
      const list = page.locator(
        "ul.msg-conversations-container__conversations-list, [aria-label='Conversation List']",
      ).first();
      await list.waitFor({ state: "visible", timeout: 15000 });

      let cardCount = await page.locator("li.msg-conversation-listitem").count();
      if (cardCount < limit) {
        await page.mouse.wheel(0, 1800).catch(() => {});
        await page.waitForTimeout(1200);
        cardCount = await page.locator("li.msg-conversation-listitem").count();
      }

      const threads = [];
      const seen = new Set();
      const maxItems = Math.min(cardCount, limit);

      for (let index = 0; index < maxItems; index += 1) {
        const card = page.locator("li.msg-conversation-listitem").nth(index);
        const title = await textContent(
          card.locator(
            ".msg-conversation-listitem__participant-names .truncate, .msg-conversation-card__participant-names .truncate",
          ).first(),
        );
        const preview = await textContent(
          card.locator(".msg-conversation-card__message-snippet").first(),
        );
        const time = await textContent(
          card.locator("time.msg-conversation-listitem__time-stamp, time").first(),
        );

        const clickable = card.locator(".msg-conversation-listitem__link").first();
        await clickable.scrollIntoViewIfNeeded().catch(() => {});
        await clickable.click().catch(() => {});
        await page.waitForTimeout(700);
        await boundedNetworkIdle(page, 1500);

        const threadUrl = page.url();
        if (!threadUrl.includes("/messaging/thread/") || seen.has(threadUrl)) {
          continue;
        }

        seen.add(threadUrl);
        threads.push({
          title,
          preview,
          time,
          threadUrl,
        });
      }

      const result = {
        count: threads.length,
        threads,
        debug: {
          url: page.url(),
          rawThreadCount: threads.length,
        },
      };

      if (options.debugArtifacts || threads.length === 0) {
        result.debug.artifacts = await captureDebugArtifacts(page, "inbox-debug");
      }

      return result;
    });
  }

  async getThread(threadUrl) {
    return this.withPage(async (page) => {
      await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
      await boundedNetworkIdle(page);

      const title = await textContent(
        page.locator("h2.msg-thread__thread-title, .msg-thread__thread-title").first(),
      );
      const nodes = page.locator(
        ".msg-s-message-list__event, .msg-s-message-group__messages li, .msg-s-message-list-content li",
      );
      const count = await nodes.count();
      const messages = [];

      for (let index = 0; index < count; index += 1) {
        const node = nodes.nth(index);
        const sender = await textContent(
          node.locator(".msg-s-message-group__name, .visually-hidden").first(),
        );
        const body = await textContent(
          node.locator(".msg-s-event-listitem__body, .msg-s-message-group__message-bubble").first(),
        );
        const time = await textContent(node.locator("time").first());

        if (!body) {
          continue;
        }

        messages.push({ sender, body, time });
      }

      return {
        title,
        threadUrl,
        count: messages.length,
        messages,
      };
    });
  }

  async sendMessage(threadUrl, message) {
    return this.withPage(async (page) => {
      await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
      await boundedNetworkIdle(page);

      const composer = page.locator(
        "div.msg-form__contenteditable[contenteditable='true'], div[role='textbox'][contenteditable='true']",
      ).first();

      await composer.waitFor({ state: "visible" });
      await composer.click();
      await composer.fill(message);

      const sendButton = page.locator(
        "button.msg-form__send-button, button[type='submit'][aria-label*='Send']",
      ).first();

      await sendButton.waitFor({ state: "visible" });
      await sendButton.click();
      await page.waitForTimeout(1500);

      return {
        ok: true,
        threadUrl,
        message,
      };
    });
  }

  async commentOnPost(postUrl, message) {
    return this.withPage(async (page) => {
      await page.goto(postUrl, { waitUntil: "domcontentloaded" });
      await boundedNetworkIdle(page);
      await ensureSignedIn(page);

      const commentButton = page.locator(
        "button[aria-label*='Comment'], button[aria-label*='comment'], button:has-text('Comment')",
      ).first();
      await commentButton.waitFor({ state: "visible" });
      await commentButton.click();
      await page.waitForTimeout(1000);

      const composer = page.locator(
        "div[role='textbox'][contenteditable='true'], div.comments-comment-box__contenteditable, div.ql-editor[contenteditable='true']",
      ).last();
      await composer.waitFor({ state: "visible" });
      await composer.click();
      await composer.fill(message);

      const submitButton = page.locator(
        "button.comments-comment-box__submit-button--cr, button.comments-comment-box__submit-button, button[aria-label*='Post comment'], button:has-text('Post')",
      ).last();
      await submitButton.waitFor({ state: "visible" });
      await submitButton.click();
      await page.waitForTimeout(1500);

      return {
        ok: true,
        postUrl,
        message,
      };
    });
  }

  async getNetworking(limit = 10) {
    return this.withPage(async (page) => {
      await page.goto("https://www.linkedin.com/mynetwork/invitation-manager/received/", {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(2000);
      await boundedNetworkIdle(page);
      await ensureSignedIn(page);

      const invitations = await page.evaluate((maxItems) => {
        const normalize = (value) => value.replace(/\s+/g, " ").trim();
        const main = document.querySelector("main");
        if (!main) {
          return [];
        }

        const cards = Array.from(main.querySelectorAll("li, article, section, div"));
        const items = [];
        const seen = new Set();

        for (const card of cards) {
          const text = normalize(card.textContent || "");
          if (!text || text.includes("No new invitations")) {
            continue;
          }

          const profileLink = card.querySelector('a[href*="/in/"]');
          const buttonText = normalize(
            Array.from(card.querySelectorAll("button"))
              .map((button) => button.textContent || "")
              .join(" "),
          );

          if (!profileLink || !/Accept|Ignore|Dismiss/i.test(buttonText)) {
            continue;
          }

          const name = normalize(profileLink.textContent || "");
          const headline = text.replace(name, "").replace(buttonText, "").trim();
          const key = `${name}|${profileLink.href}`;
          if (seen.has(key)) {
            continue;
          }

          seen.add(key);
          items.push({
            name,
            headline,
            profileUrl: profileLink.href,
          });

          if (items.length >= maxItems) {
            break;
          }
        }

        return items;
      }, limit);

      return {
        count: invitations.length,
        invitations,
        debug: {
          url: page.url(),
        },
      };
    });
  }

  async searchPeople(query, limit = 10, options = {}) {
    return this.withPage(async (page) => {
      await page.goto(buildPeopleSearchUrl(query), {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(2500);
      await boundedNetworkIdle(page);
      await ensureSignedIn(page);
      await scrollSearchResults(page, limit);

      const results = await extractPeopleSearchResults(page, limit);
      const payload = {
        query,
        count: results.length,
        results,
        debug: {
          url: page.url(),
        },
      };

      if (options.debugArtifacts || results.length === 0) {
        payload.debug.artifacts = await captureDebugArtifacts(page, "people-search-debug");
      }

      return payload;
    });
  }

  async invitePeopleFromSearch(query, limit = 5, options = {}) {
    return this.withPage(async (page) => {
      await page.goto(buildPeopleSearchUrl(query), {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(2500);
      await boundedNetworkIdle(page);
      await ensureSignedIn(page);
      await scrollSearchResults(page, limit);

      const candidates = await extractPeopleSearchResults(page, limit);
      const results = [];

      for (const candidate of candidates.slice(0, limit)) {
        const inviteResult = await inviteSearchResult(page, candidate, options.note);
        results.push({
          name: candidate.name,
          headline: candidate.headline,
          location: candidate.location,
          profileUrl: candidate.profileUrl,
          ...inviteResult,
        });
      }

      return {
        ok: true,
        query,
        requestedLimit: limit,
        matchedCount: candidates.length,
        invitedCount: results.filter((entry) => entry.status === "invited").length,
        results,
      };
    });
  }

  async writeOutput(outputPath, payload) {
    await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}

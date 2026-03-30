import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const authDir = path.join(rootDir, ".auth", "linkedin");

function detectExecutablePath() {
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

async function boundedNetworkIdle(page, timeoutMs = 5000) {
  await Promise.race([
    page.waitForLoadState("networkidle"),
    page.waitForTimeout(timeoutMs),
  ]).catch(() => {});
}

async function ensureSignedIn(page) {
  const currentUrl = page.url();
  if (/linkedin\.com\/(login|checkpoint|authwall)/.test(currentUrl)) {
    throw new Error("LinkedIn session is not signed in.");
  }
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click();
      return true;
    }
  }

  return false;
}

async function clickFirstVisibleIn(scope, selectors) {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click();
      return true;
    }
  }

  return false;
}

async function main() {
  const profileUrl = process.argv[2];
  const note = process.argv[3];

  if (!profileUrl || !note) {
    throw new Error("Usage: node ./scripts/send-connection-invite.mjs <profile-url> <note>");
  }

  const executablePath = detectExecutablePath();
  const context = await chromium.launchPersistentContext(authDir, {
    headless: false,
    viewport: { width: 1440, height: 1100 },
    executablePath: executablePath || undefined,
    channel: executablePath ? undefined : "chrome",
  });
  context.setDefaultTimeout(20000);

  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await boundedNetworkIdle(page);
    await ensureSignedIn(page);

    const hero = page.locator("main section").first();
    await hero.waitFor({ state: "visible", timeout: 10000 });

    let connectClicked = await clickFirstVisibleIn(hero, [
      "a[href*='/preload/custom-invite/']",
      "button:has-text('Connect')",
      "button:has-text('Zaproś')",
      "a:has-text('Connect')",
      "a:has-text('Zaproś')",
      "text=Connect",
      "text=Zaproś",
    ]);

    if (!connectClicked) {
      const moreClicked = await clickFirstVisibleIn(hero, [
        "button[aria-label*='More actions']",
        "button[aria-label*='Więcej działań']",
        "button:has-text('More')",
        "button:has-text('Więcej')",
        "button[aria-label='More']",
      ]);

      if (!moreClicked) {
        throw new Error("Could not find Connect button or More actions menu.");
      }

      await page.waitForTimeout(1000);
      connectClicked = await clickFirstVisible(page, [
        "div[role='button']:has-text('Connect')",
        "div[role='button']:has-text('Zaproś')",
        "button:has-text('Connect')",
        "button:has-text('Zaproś')",
        "text=Connect",
        "text=Zaproś",
      ]);
    }

    if (!connectClicked) {
      const status = await hero.innerText().catch(() => "");
      if (/pending|oczekuje/i.test(status)) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, profileUrl, reason: "Invite already pending." }, null, 2)}\n`,
        );
        return;
      }
      if (/message|wiadomość/i.test(status) && !/connect|zaproś/i.test(status)) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, profileUrl, reason: "Profile already connected." }, null, 2)}\n`,
        );
        return;
      }
      throw new Error("Could not trigger connection invite flow.");
    }

    await page.waitForTimeout(1000);

    await clickFirstVisible(page, [
      "button:has-text('Add a note')",
      "button:has-text('Dodaj notatkę')",
    ]);

    await page.waitForTimeout(1000);

    const textarea = page.locator("textarea, #custom-message").first();
    await textarea.waitFor({ state: "visible", timeout: 10000 });
    await textarea.fill(note);

    const sent = await clickFirstVisible(page, [
      "button:has-text('Send')",
      "button:has-text('Wyślij')",
    ]);

    if (!sent) {
      throw new Error("Could not submit the invitation.");
    }

    await page.waitForTimeout(2000);

    process.stdout.write(`${JSON.stringify({ ok: true, profileUrl, note }, null, 2)}\n`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

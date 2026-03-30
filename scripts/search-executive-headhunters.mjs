import { chromium } from "playwright";
import fs from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const authDir = path.join(rootDir, ".auth", "linkedin");
const outputDir = path.join(rootDir, ".output");

function normalizeText(value) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

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

async function main() {
  await mkdir(outputDir, { recursive: true });

  const queries = [
    "\"executive search consultant\" technology poland",
    "\"executive recruiter\" ai poland",
    "\"technology recruiter\" cto poland",
    "\"digital executive search\" poland",
    "\"headhunter\" engineering leadership poland",
    "\"rekrutacja executive\" technologia polska",
    "\"executive search\" warsaw technology",
    "\"ai recruiter\" poland",
  ];

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
    const allResults = [];
    const seen = new Set();

    for (const query of queries) {
      const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}&origin=GLOBAL_SEARCH_HEADER`;
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      await boundedNetworkIdle(page);
      await ensureSignedIn(page);

      await page.mouse.wheel(0, 2500).catch(() => {});
      await page.waitForTimeout(1500);
      await page.mouse.wheel(0, 2500).catch(() => {});
      await page.waitForTimeout(1500);

      const results = await page.evaluate((currentQuery) => {
        const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
        const anchors = Array.from(document.querySelectorAll('a[href*="/in/"]'));
        const items = [];
        const seenLocal = new Set();

        for (const anchor of anchors) {
          const href = anchor.href?.split("?")[0] ?? "";
          if (!href.includes("/in/") || seenLocal.has(href)) {
            continue;
          }

          const card =
            anchor.closest("li") ||
            anchor.closest(".reusable-search__result-container") ||
            anchor.closest(".linked-area") ||
            anchor.parentElement;

          const text = normalize(card?.textContent || "");
          const name = normalize(anchor.textContent || "");
          if (!name || !text) {
            continue;
          }

          const cleaned = text
            .replace(name, "")
            .replace(/^Follow\s*/i, "")
            .replace(/\s*Message\s*/gi, " ")
            .trim();
          const parts = cleaned
            .split(/ {2,}| · |\n/)
            .map((part) => normalize(part))
            .filter(Boolean);

          let headline = "";
          let location = "";
          for (const part of parts) {
            if (!headline && part.length > 8 && part !== name) {
              headline = part;
              continue;
            }
            if (!location && /poland|polska|warsaw|krakow|wroclaw|poznan|gdansk|katowice|lodz|remote/i.test(part)) {
              location = part;
            }
          }

          items.push({
            query: currentQuery,
            name,
            headline,
            location,
            profileUrl: href,
            rawText: text,
          });
          seenLocal.add(href);
        }

        return items;
      }, query);

      for (const result of results) {
        if (seen.has(result.profileUrl)) {
          continue;
        }
        seen.add(result.profileUrl);
        allResults.push(result);
      }
    }

    const filtered = allResults.filter((item) => {
      const haystack = `${item.name} ${item.headline} ${item.location} ${item.rawText}`.toLowerCase();
      const looksRelevant =
        /(executive|headhunt|search|recruit|talent|board|c-level|leadership|direct search|partner|principal|practice lead|managing consultant)/i.test(haystack);
      const looksPoland =
        /(poland|polska|warsaw|krakow|wroclaw|poznan|gdansk|katowice|lodz)/i.test(haystack);
      const looksTechFocused =
        /(technology|tech|digital|data|ai|ml|engineering|software|product|innovation|robotics)/i.test(haystack);
      return looksRelevant && looksPoland && looksTechFocused;
    });

    const ranked = filtered
      .map((item) => {
        const haystack = `${item.name} ${item.headline} ${item.location} ${item.rawText}`.toLowerCase();
        let score = 0;
        if (/executive search/.test(haystack)) score += 4;
        if (/partner|principal|practice lead|managing consultant/.test(haystack)) score += 3;
        if (/technology|tech|digital|engineering|software/.test(haystack)) score += 3;
        if (/\bai\b|\bml\b|data|robotics/.test(haystack)) score += 2;
        if (/cto|vp|chief|head of engineering|head of ai/.test(haystack)) score += 2;
        if (/poland|polska|warsaw/.test(haystack)) score += 1;
        return { ...item, score };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    const output = {
      generatedAt: new Date().toISOString(),
      queryCount: queries.length,
      resultCount: ranked.length,
      results: ranked,
    };

    const outputPath = path.join(outputDir, "executive-headhunters-poland.json");
    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    await page.screenshot({ path: path.join(outputDir, "executive-headhunters-poland.png"), fullPage: true }).catch(() => {});
    await writeFile(path.join(outputDir, "executive-headhunters-poland.html"), await page.content(), "utf8");

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const authDir = path.join(rootDir, ".auth", "linkedin");

const queries = [
  { name: "Bogumila Żelazna-Wdowiak", company: "Kancelaria Prawa Gospodarczego PFW" },
  { name: "Bartosz Uniejewski", company: "Kancelaria Prawa Gospodarczego PFW" },
  { name: "Izabela Florys", company: "Kancelaria Prawa Gospodarczego PFW" },
  { name: "Krzysztof Fiedziuk", company: "Kancelaria Prawa Gospodarczego PFW" },
  { name: "Mariusz T. Kłoda", company: "Bytelaw" },
  { name: "Julia Wrzecionkowska", company: "Bytelaw" },
  { name: "Wiktoria Rogowska", company: "Bytelaw" },
  { name: "Karol Kicun", company: "Reon Legal" },
  { name: "Jacek Pietrzela", company: "Kancelaria Prawa Restrukturyzacyjnego i Upadłościowego Jacek Pietrzela" },
  { name: "Robert Glanc", company: "Kancelaria Prawa Restrukturyzacyjnego i Upadłościowego Jacek Pietrzela" },
  { name: "Joanna Ogorzały", company: "Kancelaria Prawa Restrukturyzacyjnego i Upadłościowego Jacek Pietrzela" },
  { name: "Daniel Łowisz", company: "Kancelaria Prawa Restrukturyzacyjnego i Upadłościowego Jacek Pietrzela" },
  { name: "Dawid Rosa", company: "Porczyński Owczarek" },
  { name: "Artur Owczarek", company: "Porczyński Owczarek" },
  { name: "Bogumił Sieczkowski", company: "OBLIGO" },
  { name: "Roman Kaczynski", company: "OBLIGO" },
  { name: "Emilia Waśkowska-Drąg", company: "Krajewska i Wspólnicy" },
  { name: "Piotr Rożek", company: "Krajewska i Wspólnicy" },
  { name: "Barbara Krajewska", company: "Krajewska i Wspólnicy" },
  { name: "Magdalena Greiner-Grzembka", company: "Krajewska i Wspólnicy" },
  { name: "Monika Kantowicz-Gdańska", company: "MKG Consulting" },
  { name: "Weronika Pruss", company: "MKG Consulting" },
  { name: "Dominika Woźniak", company: "MKG Consulting" },
  { name: "Magdalena Dykowska", company: "MKG Consulting" },
];

function normalizeText(value) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function normalizeUrl(value) {
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
  await Promise.race([page.waitForLoadState("networkidle"), page.waitForTimeout(timeoutMs)]).catch(() => {});
}

async function ensureSignedIn(page) {
  const currentUrl = page.url();
  if (/linkedin\.com\/(login|checkpoint|authwall)/.test(currentUrl)) {
    throw new Error("LinkedIn session is not signed in.");
  }
}

async function scrollResults(page) {
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.wheel(0, 1800).catch(() => {});
    await page.waitForTimeout(900);
  }
}

async function extractFirstResult(page) {
  return page.evaluate(() => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
    const anchors = Array.from(document.querySelectorAll("main a[href*='/in/']"));
    const seen = new Set();
    const items = [];

    for (const anchor of anchors) {
      const href = (anchor.href || "").split("?")[0].replace(/\/+$/, "");
      if (!href.includes("/in/") || seen.has(href)) {
        continue;
      }

      const card =
        anchor.closest("li") ||
        anchor.closest(".reusable-search__result-container") ||
        anchor.closest(".linked-area") ||
        anchor.parentElement;
      const text = normalize(card?.textContent || "");
      const nameText = normalize(anchor.textContent || "");
      if (!nameText || !text) {
        continue;
      }

      items.push({
        profileUrl: href,
        text,
        nameText,
      });
      seen.add(href);
      if (items.length >= 5) {
        break;
      }
    }

    return items;
  });
}

async function main() {
  const executablePath = detectExecutablePath();
  const context = await chromium.launchPersistentContext(authDir, {
    headless: true,
    viewport: { width: 1440, height: 1100 },
    executablePath: executablePath || undefined,
    channel: executablePath ? undefined : "chrome",
  });
  context.setDefaultTimeout(20000);

  const page = context.pages()[0] ?? (await context.newPage());

  try {
    const results = [];

    for (const [index, item] of queries.entries()) {
      const query = `"${item.name}" "${item.company}"`;
      const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}&origin=GLOBAL_SEARCH_HEADER`;
      process.stdout.write(`lookup ${index + 1}/${queries.length}: ${item.name}\n`);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1800);
      await boundedNetworkIdle(page);
      await ensureSignedIn(page);
      await scrollResults(page);
      const candidates = await extractFirstResult(page);

      const selected =
        candidates.find((candidate) => {
          const haystack = `${candidate.nameText} ${candidate.text}`.toLowerCase();
          return haystack.includes(item.name.toLowerCase().split(" ")[0]) && haystack.includes(item.company.toLowerCase().split(" ")[0]);
        }) || candidates[0] || null;

      results.push({
        name: item.name,
        company: item.company,
        linkedin: selected ? normalizeUrl(selected.profileUrl) : "",
        matchedText: selected?.text || "",
      });
    }

    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

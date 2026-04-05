import { chromium } from "playwright";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const authDir = path.join(rootDir, ".auth", "linkedin");
const outputDir = path.join(rootDir, ".output");
const outputPath = path.join(rootDir, "KANCELARIE.md");
const targetCount = 110;

const companyQueries = [
  "kancelaria prawna Polska",
  "kancelaria adwokacka Polska",
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

function buildCompanySearchUrl(query) {
  return `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(query)}&origin=GLOBAL_SEARCH_HEADER`;
}

function buildPeopleSearchUrl(query) {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}&origin=GLOBAL_SEARCH_HEADER`;
}

function parseCompanySize(value) {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }

  if (/2.?10/.test(text)) {
    return 10;
  }

  if (/11.?50/.test(text)) {
    return 50;
  }

  if (/1\b/.test(text)) {
    return 1;
  }

  const match = text.match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function isEligibleCompany(details) {
  const sizeCap = parseCompanySize(details.sizeLabel);
  if (sizeCap === null || sizeCap > 50) {
    return false;
  }

  const haystack = `${details.name} ${details.location} ${details.industry} ${details.description}`.toLowerCase();
  const looksLegal = /(kancelaria|adwokat|radca prawny|usługi prawne|praktyki prawnicze|legal)/i.test(haystack);
  const looksPolish =
    /(warszawa|kraków|wrocław|poznań|gdańsk|gdynia|sopot|katowice|łódź|lublin|szczecin|bydgoszcz|toruń|rzeszów|białystok|olsztyn|opole|kielce|gliwice|częstochowa|zielona góra|polska|poland|, pl\b)/i.test(
      haystack,
    );

  return looksLegal && looksPolish;
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.mouse.wheel(0, 2200).catch(() => {});
    await page.waitForTimeout(1000);
  }
}

async function clickNextPage(page) {
  const selectors = [
    "[data-testid='pagination-controls-next-button-visible']",
    "button[aria-label='Next']",
    "button:has-text('Next')",
  ];

  for (const selector of selectors) {
    const button = page.locator(selector).first();
    const visible = await button.isVisible().catch(() => false);
    const enabled = await button.isEnabled().catch(() => false);
    if (!visible || !enabled) {
      continue;
    }

    await button.click().catch(() => {});
    await page.waitForTimeout(1500);
    await boundedNetworkIdle(page);
    return true;
  }

  return false;
}

async function extractCompanyResults(page) {
  return page.evaluate(() => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
    const anchors = Array.from(document.querySelectorAll("main a[href*='/company/']"));
    const items = [];
    const seen = new Set();

    for (const anchor of anchors) {
      const href = (anchor.href || "").split("?")[0].replace(/\/+$/, "");
      if (!href.includes("/company/") || seen.has(href)) {
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

      items.push({
        name,
        companyUrl: href,
        rawText: text,
      });
      seen.add(href);
    }

    return items;
  });
}

async function extractCompanyDetails(page) {
  return page.evaluate(() => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
    const bodyText = normalize(document.body?.innerText || "");
    const companyAnchor =
      document.querySelector("a[href*='/company/'][href*='linkedin.com/company/']") ||
      document.querySelector("link[rel='canonical']");

    const sizeMatch = bodyText.match(/Wielkość firmy\s+([^\n]+)/i) || bodyText.match(/Company size\s+([^\n]+)/i);
    const industryMatch = bodyText.match(/Branża\s+([^\n]+)/i) || bodyText.match(/Industry\s+([^\n]+)/i);
    const locationMatch =
      bodyText.match(/Siedziba główna\s+([^\n]+)/i) ||
      bodyText.match(/Headquarters\s+([^\n]+)/i) ||
      bodyText.match(/Lokalizacje\s+Główna\s+([^\n]+)/i);

    const employeeAnchors = Array.from(document.querySelectorAll("a[href*='/in/']"));
    const employees = [];
    const seenEmployees = new Set();

    for (const anchor of employeeAnchors) {
      const href = (anchor.href || "").split("?")[0].replace(/\/+$/, "");
      const name = normalize(anchor.textContent || "");
      if (!href.includes("/in/") || !name || seenEmployees.has(href)) {
        continue;
      }

      employees.push({ name, profileUrl: href });
      seenEmployees.add(href);

      if (employees.length >= 6) {
        break;
      }
    }

    const headerName =
      normalize(document.querySelector("h1")?.textContent) ||
      normalize(document.title.replace(/\s*\|\s*LinkedIn\s*$/, ""));

    return {
      name: headerName,
      sizeLabel: normalize(sizeMatch?.[1] || ""),
      industry: normalize(industryMatch?.[1] || ""),
      location: normalize(locationMatch?.[1] || ""),
      description: bodyText.slice(0, 4000),
      companyUrl:
        normalize(companyAnchor?.href || "") ||
        normalize(location.href),
      employeeCards: employees,
    };
  });
}

async function extractPeopleResults(page, limit = 3) {
  return page.evaluate((maxItems) => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
    const anchors = Array.from(document.querySelectorAll("main a[href*='/in/']"));
    const items = [];
    const seen = new Set();

    for (const anchor of anchors) {
      const href = (anchor.href || "").split("?")[0].replace(/\/+$/, "");
      const text = normalize(anchor.textContent || "");
      if (!href.includes("/in/") || !text || seen.has(href)) {
        continue;
      }

      const card =
        anchor.closest("li") ||
        anchor.closest(".reusable-search__result-container") ||
        anchor.closest(".linked-area") ||
        anchor.parentElement;
      const rawText = normalize(card?.textContent || "");
      const leadingSegment = text.split(/Connect|Message|Follow|Current:|Current /i)[0];
      const name = normalize(leadingSegment.split("•")[0]);
      if (!name || name.length < 3) {
        continue;
      }

      const cleaned = rawText.replace(name, "").trim();
      const headline = cleaned
        .split(/\n| · /)
        .map((part) => normalize(part))
        .find((part) => part && part.length > 8 && !/(connect|message|follow|1st|2nd|3rd)/i.test(part)) || "";

      items.push({
        name,
        headline,
        profileUrl: href,
      });
      seen.add(href);

      if (items.length >= maxItems) {
        break;
      }
    }

    return items;
  }, limit);
}

async function findPeopleForCompany(page, companyName) {
  const queries = [
    `"${companyName}" prawnik Polska`,
    `"${companyName}" adwokat`,
    `"${companyName}" radca prawny`,
  ];

  const collected = [];
  const seen = new Set();

  for (const query of queries) {
    await page.goto(buildPeopleSearchUrl(query), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);
    await boundedNetworkIdle(page);
    await ensureSignedIn(page);
    await scrollResults(page);
    const results = await extractPeopleResults(page, 5);

    for (const item of results) {
      if (seen.has(item.profileUrl)) {
        continue;
      }
      seen.add(item.profileUrl);
      collected.push(item);
      if (collected.length >= 3) {
        return collected;
      }
    }
  }

  return collected;
}

function renderMarkdown(records) {
  const lines = [
    "# KANCELARIE",
    "",
    `Wygenerowano: ${new Date().toISOString()}`,
    "",
    "Checklista kancelarii w Polsce do dalszego outreachu na LinkedIn. Kryterium: firmy z LinkedIna oznaczone jako `<=50` pracowników.",
    "",
  ];

  for (const record of records) {
    const meta = [
      record.sizeLabel ? `size: ${record.sizeLabel}` : null,
      record.location ? `lokacja: ${record.location}` : null,
      record.companyUrl ? `firma LI: ${record.companyUrl}` : null,
    ].filter(Boolean);

    const contacts =
      record.contacts.length > 0
        ? record.contacts
            .map((contact) => {
              const headline = contact.headline ? ` (${contact.headline})` : "";
              return `[${contact.name}](${contact.profileUrl})${headline}`;
            })
            .join(", ")
        : "brak profili znalezionych automatycznie";

    lines.push(`- [ ] ${record.name} | ${meta.join(" | ")} | kontakty: ${contacts}`);
  }

  lines.push("");
  return lines.join("\n");
}

async function main() {
  await mkdir(outputDir, { recursive: true });

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
    const candidates = [];
    const seenCompanies = new Set();

    for (const [queryIndex, query] of companyQueries.entries()) {
      if (candidates.length >= targetCount * 2) {
        break;
      }

      process.stdout.write(`search companies ${queryIndex + 1}/${companyQueries.length}: ${query}\n`);

      await page.goto(buildCompanySearchUrl(query), { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
      await boundedNetworkIdle(page);
      await ensureSignedIn(page);

      for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
        await scrollResults(page);
        const results = await extractCompanyResults(page);

        for (const item of results) {
          const companyUrl = normalizeUrl(item.companyUrl);
          if (!companyUrl || seenCompanies.has(companyUrl)) {
            continue;
          }
          seenCompanies.add(companyUrl);
          candidates.push({
            query,
            name: item.name,
            companyUrl,
            rawText: item.rawText,
          });
        }

        const moved = await clickNextPage(page);
        if (!moved) {
          break;
        }
      }
    }

    const records = [];
      for (const [candidateIndex, candidate] of candidates.entries()) {
      if (records.length >= targetCount) {
        break;
      }

      if (candidateIndex % 5 === 0) {
        process.stdout.write(`process companies ${candidateIndex + 1}/${candidates.length} | kept ${records.length}\n`);
      }

      await page.goto(candidate.companyUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1800);
      await boundedNetworkIdle(page);
      await ensureSignedIn(page);

      const details = await extractCompanyDetails(page);
      details.companyUrl = normalizeUrl(candidate.companyUrl);

      if (!isEligibleCompany(details)) {
        continue;
      }

      const contacts = [];
      const localSeen = new Set();

      for (const employee of details.employeeCards) {
        const profileUrl = normalizeUrl(employee.profileUrl);
        if (!profileUrl || localSeen.has(profileUrl)) {
          continue;
        }
        localSeen.add(profileUrl);
        contacts.push({
          name: employee.name,
          headline: "",
          profileUrl,
        });
        if (contacts.length >= 3) {
          break;
        }
      }

      if (contacts.length < 2) {
        const foundPeople = await findPeopleForCompany(page, details.name);
        for (const person of foundPeople) {
          const profileUrl = normalizeUrl(person.profileUrl);
          if (!profileUrl || localSeen.has(profileUrl)) {
            continue;
          }
          localSeen.add(profileUrl);
          contacts.push(person);
          if (contacts.length >= 3) {
            break;
          }
        }
      }

      records.push({
        name: details.name,
        companyUrl: details.companyUrl,
        sizeLabel: details.sizeLabel,
        location: details.location,
        industry: details.industry,
        contacts: contacts.slice(0, 3),
      });

      await writeFile(outputPath, renderMarkdown(records), "utf8");
      await writeFile(path.join(outputDir, "polish-law-firms.json"), `${JSON.stringify(records, null, 2)}\n`, "utf8");
      process.stdout.write(`kept ${records.length}: ${details.name}\n`);
    }

    const markdown = renderMarkdown(records);
    await writeFile(outputPath, markdown, "utf8");
    await writeFile(path.join(outputDir, "polish-law-firms.json"), `${JSON.stringify(records, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ok: true, count: records.length, outputPath }, null, 2)}\n`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

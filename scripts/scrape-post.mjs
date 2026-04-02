import { chromium } from "playwright";
import path from "node:path";

function normalize(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

const postUrl = process.argv[2];

if (!postUrl) {
  console.error("Usage: node ./scripts/scrape-post.mjs <linkedin-post-url>");
  process.exit(1);
}

const authDir = path.join(process.cwd(), ".auth", "linkedin");

const context = await chromium
  .launchPersistentContext(authDir, { headless: true, channel: "chrome" })
  .catch(() => chromium.launchPersistentContext(authDir, { headless: true }));

context.setDefaultTimeout(20000);

try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(postUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await Promise.race([page.waitForLoadState("networkidle"), page.waitForTimeout(5000)]).catch(
    () => {},
  );

  const data = await page.evaluate(() => {
    const normalizeInner = (value) => (value || "").replace(/\s+/g, " ").trim();
    const article = document.querySelector(
      "main article, article, div.feed-shared-update-v2, div[data-urn*='urn:li:activity:'], main",
    );

    const actor = normalizeInner(
      article?.querySelector(
        "a[href*='/company/'], .update-components-actor__title span[aria-hidden='true'], .feed-shared-actor__name span[aria-hidden='true']",
      )?.textContent,
    );
    const headline = normalizeInner(
      article?.querySelector(
        ".update-components-actor__description, .update-components-actor__sub-description, .feed-shared-actor__description",
      )?.textContent,
    );
    const body =
      normalizeInner(
        article?.querySelector(
          ".update-components-text, .feed-shared-inline-show-more-text, .feed-shared-update-v2__description, .update-components-update-v2__commentary, [data-test-id='main-feed-activity-card__commentary']",
        )?.textContent,
      ) || normalizeInner(article?.textContent);

    const comments = Array.from(
      document.querySelectorAll(".comments-comment-item, article.comments-comment-item"),
    )
      .slice(0, 10)
      .map((node) => normalizeInner(node.textContent))
      .filter(Boolean);

    return {
      url: location.href,
      title: document.title,
      actor,
      headline,
      body,
      comments,
    };
  });

  console.log(`${JSON.stringify({ ...data, bodyPreview: normalize(data.body).slice(0, 600) }, null, 2)}\n`);
} finally {
  await context.close();
}

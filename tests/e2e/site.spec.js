// Browser smoke tests over a local server that serves the repository under
// the production base path, /matw_pb/.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MD_FILE = path.join(ROOT, "senior-fullstack-engineering-answers.md");

test.describe("the questionnaire page", () => {
  test("renders the 21 questions and the 7 categories", async ({ page }) => {
    await page.goto("index.html");

    await expect(page).toHaveTitle(/Nicolas Van Klaveren/);
    await expect(page.locator("section.q")).toHaveCount(21);
    await expect(page.locator("#nav .nav-group")).toHaveCount(7);
    await expect(page.locator("#nav .nav-link")).toHaveCount(21);
    await expect(page.locator("#q1 h2")).toHaveText(
      "How do you handle concurrency in Go? How do you avoid goroutine leaks?"
    );
    await expect(page.locator("#q21 h2")).toHaveText(
      "Product asks you for a feature you think is a bad idea or is not well defined. What do you do?"
    );
  });

  test("navigates from the sidebar to a question", async ({ page }) => {
    await page.goto("index.html");

    await page.locator('#navToggle').click();
    await page.locator('#nav .nav-link[data-q="12"]').click();
    await expect(page.locator('#answerPanel')).toBeVisible();
    await expect(page.locator('#navToggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#nav .nav-link[data-q="13"]')).toBeVisible();
    await expect(page.locator("#q12")).toBeInViewport();
    await expect(page.locator('#nav .nav-link[data-q="12"]')).toHaveAttribute("aria-current", "true");
  });

  test("filters the questions with the search box", async ({ page }) => {
    await page.goto("index.html");

    await page.locator("#search").fill("kafka");
    await expect(page.locator("#toast")).toContainText("match");
    const visible = page.locator("#nav .nav-link:visible");
    await expect(visible).toHaveCount(1);
    await expect(visible).toHaveAttribute("data-q", "12");

    await page.locator("#search").press("Enter");
    await expect(page.locator("#q12")).toBeInViewport();

    await page.locator('#closeAnswer').click();
    await page.locator("#search").fill("");
    await expect(page.locator('#navToggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator("#nav .nav-link:visible")).toHaveCount(21);
  });

  test("toggles the theme", async ({ page }) => {
    await page.goto("index.html");

    const html = page.locator("html");
    const before = await html.getAttribute("data-theme");
    await page.locator('#actionsMenu summary').click();
    await page.locator("#themeBtn").click();
    const after = await html.getAttribute("data-theme");
    expect(after).not.toBe(before);
    await page.locator("#themeBtn").click();
    expect(await html.getAttribute("data-theme")).toBe(before);
  });

  test("exports the same bytes as the committed Markdown", async ({ page }) => {
    await page.goto("index.html");
    await page.locator('#actionsMenu summary').click();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("#exportBtn").click()
    ]);
    expect(download.suggestedFilename()).toBe("senior-fullstack-engineering-answers.md");

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const exported = Buffer.concat(chunks);
    const expected = fs.readFileSync(MD_FILE);

    expect(exported.length).toBe(expected.length);
    expect(exported.equals(expected)).toBe(true);
  });

  test("serves the LLM-friendly version as a local static file", async ({ page, request }) => {
    await page.goto("index.html");

    const href = await page.locator("#llmLink").getAttribute("href");
    expect(href).toBe("senior-fullstack-engineering-answers.md");
    expect(href.startsWith("http")).toBe(false);

    const response = await request.get(href);
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe(fs.readFileSync(MD_FILE, "utf8"));
  });
});

test.describe("the delivery appendix", () => {
  test("is reachable from the header and is not a question", async ({ page }) => {
    await page.goto("index.html");

    await expect(page.locator("section.q")).toHaveCount(21);
    const appendix = page.locator("#delivery");
    await expect(appendix).toHaveCount(1);
    await expect(appendix.locator("h2")).toHaveText("Delivery & CI/CD");

    await page.locator('#actionsMenu summary').click();
    await page.locator("#deliveryLink").click();
    await expect(appendix).toBeInViewport();
  });

  test("links to the public repository and to the workflow runs", async ({ page }) => {
    await page.goto("index.html");

    const links = page.locator("#delivery a");
    const hrefs = await links.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href")));
    expect(hrefs).toContain("https://github.com/nklaveren/matw-playbook");
    expect(hrefs).toContain("https://github.com/nklaveren/matw-playbook/actions/workflows/site.yml");
  });

  test("states the delivery contract", async ({ page }) => {
    await page.goto("index.html");
    await page.locator('#actionsMenu summary').click();
    await page.locator('#deliveryLink').click();

    const text = await page.locator("#delivery").innerText();
    expect(text).toContain("Validate site");
    expect(text).toContain("manual trigger");
    expect(text).toContain("private");
    for (const file of ['index.html', 'senior-fullstack-engineering-answers.md', 'senior-fullstack-engineering-answers.docx']) expect(text).toContain(file);
  });
});

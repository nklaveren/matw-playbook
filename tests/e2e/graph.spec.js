import { test, expect } from '@playwright/test';

const pageErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
});
test.afterEach(async ({ page }) => { expect(pageErrors.get(page)).toEqual([]); });

test('the spatial home renders 29 real Three.js nodes across the full viewport', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('index.html');
  const graph = page.locator('#competencyGraph');
  await expect(graph).toHaveAttribute('data-engine', 'threejs');
  await expect(graph).toHaveAttribute('data-webgl', 'ready');
  await expect(graph).toHaveAttribute('data-node-count', '29');
  await expect(page.locator('.map-question-hit')).toHaveCount(21);
  await expect(page.locator('.map-label')).toHaveCount(8);
  const dimensions = await graph.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight, viewportWidth: innerWidth, viewportHeight: innerHeight, webgl: !!el.querySelector('canvas').getContext('webgl2') }));
  expect(dimensions.width).toBe(dimensions.viewportWidth);
  expect(dimensions.height).toBe(dimensions.viewportHeight);
  expect(dimensions.webgl).toBe(true);
  await expect(page.locator('#aboutPanel')).not.toBeVisible();
  await expect(page.locator('#topicPanel')).not.toBeVisible();
  expect(errors).toEqual([]);
});

test('hovering a question shows its complete statement beside the sphere; click opens its answer', async ({ page }) => {
  await page.goto('index.html');
  const question = page.locator('.map-question-hit[data-question="1"]');
  await question.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText('Q1 · How do you handle concurrency in Go? How do you avoid goroutine leaks?');
  const node = await question.boundingBox(), tip = await tooltip.boundingBox();
  const centerY = node.y + node.height / 2;
  const gap = Math.min(Math.abs(centerY - tip.y), Math.abs(centerY - tip.y - tip.height));
  expect(gap).toBeLessThanOrEqual(30);
  await question.click();
  await expect(page.locator('#answerPanel')).toBeVisible();
  await expect(page.locator('#q1')).toBeVisible();
  await expect(page.locator('#competencyGraph')).toHaveAttribute('data-focus', 'q1');
  await expect(page.locator('#previousQuestion')).toBeEnabled();
  await expect(page.locator('#previousQuestion')).toHaveText('← About me');
  await expect(page.locator('#answerCounter')).toHaveText('01 / 21');
});

test('all seven topics expose their own questions and focus the matching cluster', async ({ page }) => {
  await page.goto('index.html');
  for (const [id, count] of [['go', 5], ['sql', 3], ['fe', 1], ['arc', 4], ['qa', 3], ['ai', 3], ['own', 2]]) {
    await page.locator(`#topicShortcuts button[data-topic="${id}"]`).click();
    await expect(page.locator('#topicPanel')).toBeVisible();
    await expect(page.locator('#topicQuestions button')).toHaveCount(count);
    await expect(page.locator('#competencyGraph')).toHaveAttribute('data-focus', id);
  }
  await page.locator('#closeTopic').click();
  await expect(page.locator('#topicPanel')).not.toBeVisible();
  await expect(page.locator('#competencyGraph')).toHaveAttribute('data-focus', 'overview');
});

test('Previous and Next traverse topics, update the graph, reset scroll, and respect both boundaries', async ({ page }) => {
  await page.goto('index.html#q5');
  await expect(page.locator('#q5')).toBeVisible();
  await page.locator('#doc').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.locator('#nextQuestion').click();
  await expect(page.locator('#q6')).toBeVisible();
  await expect(page.locator('#q5')).not.toBeVisible();
  await expect(page.locator('#answerCounter')).toHaveText('06 / 21');
  await expect(page.locator('#competencyGraph')).toHaveAttribute('data-focus', 'q6');
  expect(await page.locator('#doc').evaluate(el => el.scrollTop)).toBe(0);
  await page.locator('#previousQuestion').click();
  await expect(page.locator('#q5')).toBeVisible();
  await expect(page.locator('#competencyGraph')).toHaveAttribute('data-focus', 'q5');
  await page.goto('index.html#q21');
  await expect(page.locator('#q21')).toBeVisible();
  await expect(page.locator('#nextQuestion')).toBeEnabled();
  await expect(page.locator('#nextQuestion')).toHaveText('Source & CI/CD →');
  await expect(page.locator('#previousQuestion')).toBeEnabled();
});

test('the Nicolas hub opens the profile, and Escape returns to the overview', async ({ page }) => {
  await page.goto('index.html');
  await page.locator('.map-label-center').click();
  await expect(page.locator('#aboutPanel')).toBeVisible();
  await expect(page.locator('#profileName')).toHaveText('Nicolas Van Klaveren');
  await expect(page.locator('#profileRole')).toHaveText('Senior Software Architect & AI Engineer');
  expect(await page.locator('#profilePortrait').evaluate(img => img.complete && img.naturalWidth > 0 && img.src.startsWith('data:image/jpeg;base64,'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('#aboutPanel')).not.toBeVisible();
  await expect(page.locator('#competencyGraph')).toHaveAttribute('data-focus', 'overview');
});

test('About me precedes the topics and opens the same profile with professional links', async ({ page }) => {
  await page.goto('index.html#q1');
  await page.locator('#toggleAnswerMenu').click();
  await expect(page.locator('#sidebarAbout')).toBeVisible();
  expect(await page.locator('#sidebarAbout').evaluate(button => !!(button.compareDocumentPosition(document.querySelector('#nav')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await page.locator('#sidebarAbout').click();
  await expect(page.locator('#aboutPanel')).toBeVisible();
  await expect(page.locator('#answerPanel')).not.toBeVisible();
  await expect(page.locator('#profileLinkedIn')).toHaveAttribute('href', 'https://www.linkedin.com/in/nklaveren/');
  await expect(page.locator('#profileRepository')).toHaveAttribute('href', 'https://github.com/nklaveren/matw-playbook');
  await page.locator('#closeAbout').click();
  await expect(page.locator('#navToggle')).toHaveAttribute('aria-expanded', 'true');
});

test('mobile has a full-screen map, a readable profile, and a floating answer with fixed navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('index.html');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const rect = await page.locator('#competencyGraph').boundingBox();
  expect(rect.width).toBe(390); expect(rect.height).toBe(844);
  await page.locator('.map-label-center').click();
  await expect(page.locator('#profileName')).toBeVisible();
  await page.locator('#closeAbout').click();
  await page.locator('#topicShortcuts button[data-topic="go"]').click();
  await page.locator('#topicQuestions button[data-question="1"]').click();
  await expect(page.locator('#q1')).toBeVisible();
  const answer = await page.locator('#answerPanel').boundingBox();
  expect(answer.width).toBe(366);
  expect(answer.x).toBe(12);
  await expect(page.locator('#nextQuestion')).toBeInViewport();
  await page.locator('#nextQuestion').click();
  await expect(page.locator('#q2')).toBeVisible();
  await page.locator('#closeAnswer').click();
  await expect(page.locator('#answerPanel')).not.toBeVisible();
});

test('without WebGL all topics, questions and the profile remain available', async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      return type.startsWith('webgl') ? null : getContext.call(this, type, ...args);
    };
  });
  await page.goto('index.html');
  await expect(page.locator('#competencyGraph')).toHaveAttribute('data-webgl', 'fallback');
  await page.locator('#topicShortcuts button[data-topic="ai"]').click();
  await page.locator('#topicQuestions button[data-question="19"]').click();
  await expect(page.locator('#q19')).toBeVisible();
  await page.locator('#closeAnswer').click();
  await page.locator('#actionsMenu summary').click();
  await page.locator('#aboutButton').click();
  await expect(page.locator('#profileName')).toBeVisible();
});

test('the menu has its own fixed header and an independent scrolling list on desktop and mobile', async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('index.html#q1');
    await page.locator('#toggleAnswerMenu').click();
    await page.locator('.sidebar-scroll').evaluate(el => { el.scrollTop = 0; });
    await expect(page.locator('.sidebar-brand')).toBeVisible();
    await expect(page.locator('#sidebarToggle')).toHaveText('×');
    await expect(page.locator('#sidebarToggle')).toHaveAttribute('aria-label', 'Close question menu');
    const visibleAboveMenu = await page.locator('.sidebar-brand').evaluate(brand => {
      const rect = brand.getBoundingClientRect();
      return brand.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    });
    expect(visibleAboveMenu).toBe(true);
    const header = await page.locator('.sidebar-header').boundingBox();
    const profile = await page.locator('#sidebarAbout').boundingBox();
    expect(profile.y).toBeGreaterThanOrEqual(header.y + header.height);
    await page.locator('.sidebar-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
    const afterScroll = await page.locator('.sidebar-header').boundingBox();
    expect(afterScroll.y).toBe(header.y);
    const scrollArea = await page.locator('.sidebar-scroll').boundingBox();
    expect(scrollArea.y).toBeGreaterThanOrEqual(header.y + header.height);
    await page.locator('#sidebarToggle').click();
    await expect(page.locator('#navToggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#navToggle')).toHaveText('☰');
  }
});

test('the active question floats gently while the reading view leaves the world sharp', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('index.html#q1');
  await expect(page.locator('#q1')).toBeVisible();
  await page.waitForTimeout(1200);
  const active = page.locator('.map-question-hit[data-question="1"]');
  const samples = [];
  for (let i = 0; i < 3; i++) {
    samples.push((await active.boundingBox()).y);
    await page.waitForTimeout(250);
  }
  const movement = Math.max(...samples) - Math.min(...samples);
  expect(movement).toBeGreaterThan(.05);
  expect(movement).toBeLessThan(15);
  expect(await page.locator('#answerPanel').evaluate(el => getComputedStyle(el, '::backdrop').backdropFilter)).toBe('none');
  await expect(page.locator('#answerPanel')).toHaveAttribute('aria-modal', 'false');
});

test('the floating introduction starts a connected About me, Q1, Q2 reading sequence', async ({ page }) => {
  await page.goto('index.html');
  await page.locator('.map-label-center').click();
  await expect(page.locator('#aboutPanel')).toBeVisible();
  await page.locator('#startQuestions').click();
  await expect(page.locator('#aboutPanel')).not.toBeVisible();
  await expect(page.locator('#q1')).toBeVisible();
  const card = await page.locator('#answerPanel').boundingBox();
  const viewport = page.viewportSize();
  expect(card.x).toBeGreaterThan(0);
  expect(card.y).toBeGreaterThan(0);
  const gutter = Math.min(100, Math.max(40, viewport.width * .07));
  const node = await page.locator('.map-question-hit[data-question="1"]').boundingBox();
  const unchangedCameraTarget = (viewport.width - gutter - card.width + 12) / 2;
  expect(Math.abs(node.x + node.width / 2 - unchangedCameraTarget)).toBeLessThan(2);
  expect(Math.abs(card.x - (node.x + node.width / 2) - 150)).toBeLessThan(2);
  await expect(page.locator('#answerConnector')).toBeVisible();
  await page.locator('#nextQuestion').click();
  await expect(page.locator('#q2')).toBeVisible();
  await page.locator('#previousQuestion').click();
  await expect(page.locator('#q1')).toBeVisible();
  await page.locator('#previousQuestion').click();
  await expect(page.locator('#aboutPanel')).toBeVisible();
  await expect(page.locator('#answerPanel')).not.toBeVisible();
});

test('the direct DOCX download is byte-for-byte the provided Word file', async ({ page }) => {
  await page.goto('index.html');
  await expect(page.locator('#quickDocx')).toHaveText('Just give me the DOCX ↓');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#quickDocx').click()
  ]);
  expect(download.suggestedFilename()).toBe('Questions - Senior Full Stack Engineer (Backend-focused)-r.docx');
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const { readFileSync } = await import('node:fs');
  expect(Buffer.concat(chunks).equals(readFileSync(new URL('../../senior-fullstack-engineering-answers.docx', import.meta.url)))).toBe(true);
});

test('mobile tables stack without horizontal overflow and question 21 continues to repository details', async ({ page }) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const id of [10, 21]) {
      await page.goto(`index.html#q${id}`);
      await expect(page.locator(`#q${id}`)).toBeVisible();
      const table = page.locator(`#q${id} .tblwrap`);
      expect(await table.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.locator('#doc').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const panel = await page.locator('#answerPanel').boundingBox();
      const document = await page.locator('#doc').boundingBox();
      const pager = await page.locator('.answer-pager').boundingBox();
      expect(document.x + document.width).toBeLessThanOrEqual(panel.x + panel.width);
      expect(pager.x + pager.width).toBeLessThanOrEqual(panel.x + panel.width);
      await expect(table.locator('tbody tr').first()).toHaveCSS('display', 'block');
      await expect(page.locator('#nextQuestion')).toBeInViewport();
    }
    await page.locator('#nextQuestion').click();
    await expect(page.locator('#deliveryDialog')).toBeVisible();
    await expect(page.locator('#delivery')).toContainText('Delivery & CI/CD');
    await expect(page.locator('#delivery a[href="https://github.com/nklaveren/matw-playbook"]')).toBeVisible();
    await page.locator('#deliveryPrevious').click();
    await expect(page.locator('#q21')).toBeVisible();
    await page.locator('#nextQuestion').click();
    await page.locator('#deliveryFinish').click();
    await expect(page.locator('#deliveryDialog')).not.toBeVisible();
    await expect(page.locator('#competencyGraph')).toHaveAttribute('data-focus', 'overview');
  }
});

test('desktop reading leaves the active orb visible and connected, including with the menu open', async ({ page }) => {
  for (const width of [907, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('index.html#q21');
    for (const menuOpen of [false, true]) {
      if (menuOpen) await page.locator('#toggleAnswerMenu').click();
      const card = await page.locator('#answerPanel').boundingBox();
      const node = await page.locator('.map-question-hit[data-question="21"]').boundingBox();
      expect(card.x).toBeGreaterThan(0);
      expect(card.y).toBeGreaterThan(0);
      expect(card.width).toBeLessThanOrEqual(560);
      expect(card.x + card.width).toBeLessThanOrEqual(width - 23);
      expect(node.x + node.width).toBeLessThan(card.x);
      if (menuOpen) expect(node.x).toBeGreaterThan(320);
      await expect(page.locator('#answerConnector')).toBeVisible();
      const doc = await page.locator('#doc').boundingBox();
      expect(doc.x + doc.width).toBeLessThanOrEqual(card.x + card.width);
      expect(await page.locator('#doc').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      if (menuOpen) await page.locator('#sidebarToggle').click();
    }
  }
});

test('desktop places the card opposite the orb without colliding with the open menu', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [id, side] of [[1, 'right'], [11, 'left']]) {
    await page.goto(`index.html#q${id}`);
    await expect(page.locator('#answerPanel')).toHaveAttribute('data-side', side);
    await page.locator('#toggleAnswerMenu').click();
    const card = await page.locator('#answerPanel').boundingBox();
    const menu = await page.locator('#sidebar').boundingBox();
    const orb = await page.locator(`.map-question-hit[data-question="${id}"]`).boundingBox();
    expect(card.x).toBeGreaterThanOrEqual(menu.x + menu.width + 20);
    if (side === 'left') expect(orb.x).toBeGreaterThan(card.x + card.width);
    else expect(orb.x + orb.width).toBeLessThan(card.x);
    const orbCenter = orb.x + orb.width / 2;
    const gap = side === 'left' ? orbCenter - (card.x + card.width) : card.x - orbCenter;
    expect(gap).toBeCloseTo(150, 0);
    await expect(page.locator('#answerConnector')).toBeVisible();
    await page.locator('#sidebarToggle').click();
  }
});

test('question changes preserve card dimensions and the shared reading scale', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('index.html#q1');
  const first = await page.locator('#answerPanel').boundingBox();
  await expect(page.locator('#q1 .answer')).toHaveCSS('font-size', '14px');
  await expect(page.locator('#q1 .qtitle')).toHaveCSS('font-size', '24px');
  await page.locator('#nextQuestion').click();
  await page.locator('#nextQuestion').click();
  await expect(page.locator('#q3')).toBeVisible();
  const third = await page.locator('#answerPanel').boundingBox();
  expect(third.width).toBe(first.width);
  expect(third.height).toBe(first.height);
  await expect(page.locator('#q3 .answer')).toHaveCSS('font-size', '14px');
  await expect(page.locator('#q3 pre')).toHaveCSS('font-size', '13px');
});

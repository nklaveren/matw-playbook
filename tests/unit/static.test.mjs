// Static checks on the published page: the inline script parses, the page
// loads no remote resource, and the LLM-friendly link is a local file.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { inlineScript, loadSource, readHtml } from "../../scripts/lib/source.mjs";

const html = readHtml();
const js = inlineScript(html);
const source = loadSource(html);

const RESOURCE_PATTERNS = [
  { kind: "script", re: /<script[^>]*\ssrc\s*=\s*["']([^"']*)["']/gi },
  { kind: "link", re: /<link[^>]*\shref\s*=\s*["']([^"']*)["']/gi },
  { kind: "img", re: /<img[^>]*\ssrc\s*=\s*["']([^"']*)["']/gi },
  { kind: "iframe", re: /<iframe[^>]*\ssrc\s*=\s*["']([^"']*)["']/gi },
  { kind: "source", re: /<source[^>]*\ssrc\s*=\s*["']([^"']*)["']/gi },
  { kind: "embed", re: /<embed[^>]*\ssrc\s*=\s*["']([^"']*)["']/gi },
  { kind: "object", re: /<object[^>]*\sdata\s*=\s*["']([^"']*)["']/gi },
  { kind: "css url()", re: /url\(\s*["']?([^"')]+)["']?\s*\)/gi }
];

test("the inline script is valid JavaScript", () => {
  assert.doesNotThrow(() => new vm.Script(js, { filename: "index.html#inline" }));
});

test("the page loads no remote resource", () => {
  for (const { kind, re } of RESOURCE_PATTERNS) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(html)) !== null) {
      const value = m[1];
      assert.ok(
        !/^(?:https?:)?\/\//i.test(value),
        kind + " loads a remote resource: " + value
      );
    }
  }
  assert.ok(!/@import/i.test(html), "the page has a CSS import");
  assert.ok(!/<iframe/i.test(html), "the page has an iframe");
});

test("external links are limited to the requested professional profile and public repository", () => {
  const links = [...html.matchAll(/<a[^>]*\shref\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]);
  const remote = links.filter((h) => /^https?:/i.test(h));
  assert.deepEqual([...new Set(remote)].sort(), [
    "https://github.com/nklaveren/matw-playbook",
    "https://github.com/nklaveren/matw-playbook/actions/workflows/site.yml",
    "https://www.linkedin.com/in/nklaveren/"
  ]);
});

test("the LLM-friendly version is a local static file", () => {
  assert.match(html, /id="llmLink"[^>]*href="senior-fullstack-engineering-answers\.md"/);
  assert.match(html, /href="senior-fullstack-engineering-answers\.md"/);
  assert.equal(source.exportName, "senior-fullstack-engineering-answers.md");
});

test("the appendix is rendered by the page, not as a question", () => {
  assert.match(html, /id="deliveryLink"[^>]*href="#delivery"/);
  assert.match(html, /href="#delivery"/);
  assert.equal(source.appendix.id, "delivery");
  assert.equal(source.appendix.title, "Delivery & CI/CD");
  assert.ok(!source.questions.some((q) => q.id === 22));
  assert.ok(!source.cats.some((c) => c.id === "delivery"));
});

test("the compiled page is self-contained, with no runtime module loading", () => {
  assert.equal((html.match(/<script/g) || []).length, 1, "more than one inline script");
  assert.ok(!/<script[^>]*type=["'](module|importmap)/i.test(html), "the page uses a module or an import map");
  assert.ok(!/<script[^>]*\ssrc=/i.test(html), "the page loads an external script");
  assert.ok(!/<link[^>]*\shref=/i.test(html), "the page loads an external stylesheet");
  assert.ok(!/\brequire\(|\bimport\s+.*\bfrom\b/i.test(js), "the inline script uses modules");
  assert.match(js, /THREE_GRAPH_BUNDLE_START/);
  assert.match(js, /MATWGraph\.mountGraph/);
});

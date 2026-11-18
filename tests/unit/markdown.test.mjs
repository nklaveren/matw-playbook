// The Markdown export: same serializer as the page, appendix included, and
// the committed file always in sync with the generated one.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MD_NAME, MD_PATH, loadSource, renderMarkdown } from "../../scripts/lib/source.mjs";

const source = loadSource();
const generated = renderMarkdown();
const onDisk = fs.readFileSync(MD_PATH, "utf8");

test("the committed Markdown is exactly what the page serializer produces", () => {
  assert.equal(onDisk, generated);
});

test("the serializer is deterministic", () => {
  assert.equal(renderMarkdown(), renderMarkdown());
});

test("the Markdown holds the 21 questions with their full statements", () => {
  const headings = generated.match(/^### \d+\. .+$/gm) || [];
  assert.equal(headings.length, 21);
  for (const q of source.questions) {
    assert.ok(
      generated.includes("### " + q.id + ". " + q.q),
      "question " + q.id + " is missing or truncated in the Markdown"
    );
  }
});

test("the Markdown keeps the categories and the order of the questionnaire", () => {
  const order = (generated.match(/^## .+$/gm) || []).map((h) => h.slice(3));
  assert.deepEqual(order, source.cats.map((c) => c.name).concat([source.appendix.title]));
});

test("the appendix is part of the export", () => {
  assert.ok(generated.includes("## " + source.appendix.title), "the appendix heading is missing");
  assert.ok(generated.includes(source.appendix.lede), "the appendix lede is missing");
  assert.ok(generated.includes(source.appendix.note), "the appendix note is missing");
  for (const block of source.appendix.blocks) {
    assert.ok(generated.includes("### " + block.h), "appendix block " + block.h + " is missing");
    assert.ok(generated.includes(block.p), "appendix block " + block.h + " has no text");
    if (block.p2) assert.ok(generated.includes(block.p2), "appendix block " + block.h + " lost its second paragraph");
    for (const link of block.links || []) {
      assert.ok(generated.includes("[" + link.label + "](" + link.href + ")"), "link " + link.label + " is missing");
    }
  }
});

test("the appendix states the real delivery contract", () => {
  assert.ok(generated.includes("https://github.com/nklaveren/matw-playbook"));
  assert.ok(generated.includes("https://github.com/nklaveren/matw-playbook/actions/workflows/site.yml"));
  assert.ok(/manual trigger/i.test(generated), "the manual promotion is not stated");
  assert.ok(/private/i.test(generated), "the private pipeline is not stated");
});

test("the export is the file the page links to", () => {
  assert.equal(source.exportName, MD_NAME);
  assert.ok(onDisk.endsWith("\n"));
  assert.ok(!/\r/.test(onDisk), "the Markdown has carriage returns");
});

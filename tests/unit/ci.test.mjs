// The public workflow: GitHub-hosted, read-only, validates and packages.
// It must never deploy and must never carry a secret.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../scripts/lib/source.mjs";

const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "site.yml");
const yaml = fs.readFileSync(WORKFLOW, "utf8");

test("the workflow is named Validate site", () => {
  assert.match(yaml, /^name:\s*Validate site\s*$/m);
});

test("it runs on pushes to main, on pull requests and on a manual dispatch", () => {
  assert.match(yaml, /^on:/m);
  assert.match(yaml, /^\s{2}push:/m);
  assert.match(yaml, /^\s{4}branches:\s*\[main\]\s*$/m);
  assert.match(yaml, /^\s{2}pull_request:\s*$/m);
  assert.match(yaml, /^\s{2}workflow_dispatch:\s*$/m);
});

test("it runs on a GitHub-hosted runner with read-only permissions", () => {
  assert.match(yaml, /runs-on:\s*ubuntu-latest/);
  assert.match(yaml, /^permissions:\s*$/m);
  assert.match(yaml, /^\s{2}contents:\s*read\s*$/m);
  assert.ok(!/permissions:\s*write/.test(yaml), "the workflow asks for write permissions");
});

test("it installs Node and the dependencies", () => {
  assert.match(yaml, /actions\/setup-node@v\d/);
  assert.match(yaml, /node-version:\s*"?\d+/);
  assert.match(yaml, /npm ci/);
});

test("it runs the unit, static and browser tests", () => {
  assert.match(yaml, /npm run test:unit/);
  assert.match(yaml, /npm run check:md/);
  assert.match(yaml, /npm run test:e2e/);
  assert.match(yaml, /playwright install/);
});

test("it uploads the site artifact only for a successful push to main", () => {
  assert.match(yaml, /actions\/upload-artifact@v4/);
  assert.match(yaml, /if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(yaml, /name:\s*site\s*$/m);
  assert.match(yaml, /retention-days:\s*14/);
});

test("the artifact holds the page and the Markdown, and nothing else", () => {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^\s*path:\s*\|/.test(l));
  assert.ok(start !== -1, "the workflow has no artifact path");
  const indent = lines[start].length - lines[start].trimStart().length;

  const files = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.length - line.trimStart().length <= indent) break;
    files.push(line.trim());
  }
  assert.deepEqual(files, ["index.html", "senior-fullstack-engineering-answers.md"]);
});

test("the workflow carries no secret, no registry and no cluster access", () => {
  assert.ok(!/secrets\./.test(yaml), "the workflow reads a secret");
  assert.ok(!/docker/i.test(yaml), "the workflow touches docker");
  assert.ok(!/kubectl|helm|kubeconfig/i.test(yaml), "the workflow touches the cluster");
  assert.ok(!/ssh/i.test(yaml), "the workflow uses ssh");
  assert.ok(!/environments:/i.test(yaml), "the workflow declares an environment");
});

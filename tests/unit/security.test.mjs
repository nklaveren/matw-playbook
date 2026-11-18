// The repository is public: it must not carry infrastructure metadata,
// credentials or internal addresses. The deployment contract is described in
// words, never in configuration.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../scripts/lib/source.mjs";

const SKIP_DIRS = new Set([".git", "node_modules", "test-results", "playwright-report"]);
// The lockfile is generated metadata: it is published, but not scanned for
// infrastructure strings.
const SCAN_SKIP_FILES = new Set(["package-lock.json"]);

function publicFiles(dir = REPO_ROOT, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      publicFiles(path.join(dir, entry.name), acc);
    } else {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

const FORBIDDEN = [
  { name: "private IPv4 address", re: /\b(?:10\.\d{1,3}|192\.168\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g },
  { name: "IPv4 address", re: /\b(?!127\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  { name: "IPv6 address", re: /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/g },
  { name: "kubeconfig", re: /kubeconfig|\.kube\/|\bKUBECONFIG\b/g },
  { name: "kubectl", re: /\bkubectl\b/g },
  { name: "helm release", re: /\bhelm\s+(?:upgrade|install|repo|pull)\b/g },
  { name: "container registry", re: /\bdocker\s+(?:login|build|push|pull)\b|\bghcr\.io\/|\bdocker\.io\//g },
  { name: "ssh key", re: /ssh-rsa|ssh-ed25519|BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/g },
  { name: "cloud credentials", re: /\b(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GOOGLE_APPLICATION_CREDENTIALS|AZURE_CLIENT_SECRET)\b/g },
  { name: "inline secret", re: /\b(?:password|passwd|api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-]{6,}/gi },
  { name: "github secrets context", re: /\$\{\{\s*secrets\./g },
  { name: "internal hostname", re: /\b[a-z0-9-]+\.(?:internal|intranet|corp|local|lan)\b/gi }
];

const EXPECTED_FILES = [
  ".github/workflows/site.yml",
  ".gitignore",
  "index.html",
  "package.json",
  "package-lock.json",
  "playwright.config.js",
  "scripts/export-md.mjs",
  "scripts/lib/source.mjs",
  "scripts/serve.mjs",
  "senior-fullstack-engineering-answers.md",
  "tests/e2e/site.spec.js",
  "tests/unit/ci.test.mjs",
  "tests/unit/markdown.test.mjs",
  "tests/unit/questions.test.mjs",
  "tests/unit/security.test.mjs",
  "tests/unit/static.test.mjs"
];

const UNEXPECTED_FILES = [
  /^\.env/,
  /^Dockerfile/i,
  /^docker-compose/i,
  /\.pem$/i,
  /\.key$/i,
  /kubeconfig/i,
  /\.tf$/i,
  /^readme/i
];

const files = publicFiles();
// The test files hold the patterns themselves, so they are not scanned.
const scanned = files.filter(
  (f) => !SCAN_SKIP_FILES.has(path.basename(f)) && !path.relative(REPO_ROOT, f).startsWith("tests" + path.sep)
);

test("the repository holds the expected public files", () => {
  const names = files.map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/"));
  for (const expected of EXPECTED_FILES) {
    assert.ok(names.includes(expected), expected + " is missing");
  }
  for (const name of names) {
    for (const pattern of UNEXPECTED_FILES) {
      assert.ok(!pattern.test(name), name + " does not belong to a public repository");
    }
  }
});

test("no file carries infrastructure metadata or credentials", () => {
  for (const file of scanned) {
    const text = fs.readFileSync(file, "utf8");
    for (const { name, re } of FORBIDDEN) {
      re.lastIndex = 0;
      const hits = text.match(re);
      assert.equal(
        hits,
        null,
        path.relative(REPO_ROOT, file) + " contains a " + name + ": " + (hits || []).join(", ")
      );
    }
  }
});

test("no file mentions a private repository", () => {
  for (const file of scanned) {
    const text = fs.readFileSync(file, "utf8");
    assert.ok(
      !/\bprivate repo(?:sitory)?\b[^\n]*github\.com\/[^/\s]+\/[^/\s]+/i.test(text),
      path.relative(REPO_ROOT, file) + " names a private repository"
    );
  }
});

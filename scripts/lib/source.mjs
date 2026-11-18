// Reads the single source of truth out of index.html.
//
// The page is a single file with an inline <script> that declares the data
// arrays (QUESTIONS, CATS, APPENDIX), the serializer (buildMarkdown) and the
// renderer. This module slices those declarations out of the inline script and
// evaluates them in a Node vm context, so the Markdown export and the tests
// use the very same code that the browser runs.
//
// Node built-ins only: no dependency, no build step.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const HTML_PATH = path.join(REPO_ROOT, "index.html");
export const MD_PATH = path.join(REPO_ROOT, "senior-fullstack-engineering-answers.md");
export const MD_NAME = "senior-fullstack-engineering-answers.md";

/* ------------------------------------------------------------------ scanning */

const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await"
]);
const REGEX_PRECEDING = "(,=:[!&|?{};+-*%~^<>";

function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const c = src[j];
  if (REGEX_PRECEDING.includes(c)) return true;
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
  return REGEX_KEYWORDS.has(src.slice(k + 1, j + 1));
}

function skipRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) { j++; break; }
    else if (c === "\n") break;
    j++;
  }
  while (j < src.length && /[a-z]/.test(src[j])) j++;
  return j;
}

// src[i] is the opening quote; returns the index just after the closing quote.
function skipString(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") { j += 2; continue; }
    if (quote === "`" && c === "$" && src[j + 1] === "{") {
      j = matchBraces(src, j + 1);
      continue;
    }
    if (c === quote) return j + 1;
    j++;
  }
  throw new Error("unterminated string literal");
}

// src[i] is "{", returns the index just after the matching "}".
function matchBraces(src, i) {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === "`") { j = skipString(src, j); continue; }
    if (c === "/" && src[j + 1] === "/") { while (j < src.length && src[j] !== "\n") j++; continue; }
    if (c === "/" && src[j + 1] === "*") {
      const end = src.indexOf("*/", j + 2);
      if (end === -1) throw new Error("unterminated block comment");
      j = end + 2;
      continue;
    }
    if (c === "/" && isRegexStart(src, j)) { j = skipRegex(src, j); continue; }
    if (c === "{") { depth++; j++; continue; }
    if (c === "}") { depth--; j++; if (depth === 0) return j; continue; }
    j++;
  }
  throw new Error("unbalanced braces");
}

// Returns the index just after the balanced block that starts at src[start].
export function balancedEnd(src, start) {
  const open = src[start];
  if (open !== "{" && open !== "[") throw new Error("not a block start: " + open);
  let depth = 0;
  let j = start;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === "`") { j = skipString(src, j); continue; }
    if (c === "/" && src[j + 1] === "/") { while (j < src.length && src[j] !== "\n") j++; continue; }
    if (c === "/" && src[j + 1] === "*") {
      const end = src.indexOf("*/", j + 2);
      if (end === -1) throw new Error("unterminated block comment");
      j = end + 2;
      continue;
    }
    if (c === "/" && isRegexStart(src, j)) { j = skipRegex(src, j); continue; }
    if (c === "{" || c === "[" || c === "(") { depth++; j++; continue; }
    if (c === "}" || c === "]" || c === ")") {
      depth--;
      j++;
      if (depth === 0) return j;
      continue;
    }
    j++;
  }
  throw new Error("unbalanced block");
}

// Returns the source of the balanced block that starts at src[start].
export function extractBalanced(src, start) {
  return src.slice(start, balancedEnd(src, start));
}

function declarationStart(src, name) {
  const re = new RegExp("\\bvar\\s+" + name + "\\s*=");
  const m = re.exec(src);
  if (!m) throw new Error("declaration not found: " + name);
  let start = m.index + m[0].length;
  while (start < src.length && /\s/.test(src[start])) start++;
  return start;
}

export function sliceVarLiteral(src, name) {
  return extractBalanced(src, declarationStart(src, name));
}

export function sliceVarString(src, name) {
  const start = declarationStart(src, name);
  return src.slice(start, skipString(src, start));
}

export function sliceFunction(src, name) {
  const marker = "function " + name + "(";
  const idx = src.indexOf(marker);
  if (idx === -1) throw new Error("function not found: " + name);
  const brace = src.indexOf("{", idx);
  if (brace === -1) throw new Error("function body not found: " + name);
  return src.slice(idx, balancedEnd(src, brace));
}

/* ------------------------------------------------------------------ loading */

export function readHtml(file = HTML_PATH) {
  return fs.readFileSync(file, "utf8");
}

export function inlineScript(html = readHtml()) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no inline <script> found in index.html");
  return m[1];
}

/**
 * Evaluates the page data and the Markdown serializer in a fresh vm context.
 * Returns the parsed data plus the serializer bound to that context.
 */
export function loadSource(html = readHtml()) {
  const js = inlineScript(html);
  const sources = [
    "var QUESTIONS = " + sliceVarLiteral(js, "QUESTIONS") + ";",
    "var CATS = " + sliceVarLiteral(js, "CATS") + ";",
    "var APPENDIX = " + sliceVarLiteral(js, "APPENDIX") + ";",
    "var AUTHOR = " + sliceVarString(js, "AUTHOR") + ";",
    "var ROLE = " + sliceVarString(js, "ROLE") + ";",
    "var EXPORT_NAME = " + sliceVarString(js, "EXPORT_NAME") + ";",
    sliceFunction(js, "mdCell"),
    sliceFunction(js, "buildMarkdown")
  ];
  const context = {
    QUESTIONS: null, CATS: null, APPENDIX: null,
    AUTHOR: null, ROLE: null, EXPORT_NAME: null,
    mdCell: null, buildMarkdown: null
  };
  vm.createContext(context);
  vm.runInContext(sources.join("\n"), context, { filename: "index.html#inline" });
  // Plain copies: the values above live in the vm realm, and the tests want
  // ordinary arrays and objects to compare.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  return {
    js,
    questions: plain(context.QUESTIONS),
    cats: plain(context.CATS),
    appendix: plain(context.APPENDIX),
    author: context.AUTHOR,
    role: context.ROLE,
    exportName: context.EXPORT_NAME,
    buildMarkdown: context.buildMarkdown
  };
}

/** The Markdown file, exactly as it is written to disk. */
export function renderMarkdown(html = readHtml()) {
  const { buildMarkdown } = loadSource(html);
  return buildMarkdown().replace(/\s+$/, "") + "\n";
}

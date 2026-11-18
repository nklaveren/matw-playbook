#!/usr/bin/env node
// Writes senior-fullstack-engineering-answers.md from the same data array and
// the same buildMarkdown() serializer that the page uses.
//
//   node scripts/export-md.mjs            write the file
//   node scripts/export-md.mjs --check    compare only, write nothing
import fs from "node:fs";
import path from "node:path";
import { MD_PATH, REPO_ROOT, renderMarkdown } from "./lib/source.mjs";

const check = process.argv.includes("--check");
const md = renderMarkdown();

if (check) {
  const current = fs.existsSync(MD_PATH) ? fs.readFileSync(MD_PATH, "utf8") : "";
  if (current !== md) {
    const currentLines = current.split("\n").length;
    const expectedLines = md.split("\n").length;
    console.error(
      "out of sync: " + path.relative(REPO_ROOT, MD_PATH) +
      " (file has " + currentLines + " lines, generated has " + expectedLines + ")"
    );
    process.exit(1);
  }
  console.log("in sync: " + path.relative(REPO_ROOT, MD_PATH));
} else {
  fs.writeFileSync(MD_PATH, md, "utf8");
  const headings = (md.match(/^### \d+\. /gm) || []).length;
  console.log("wrote " + path.relative(REPO_ROOT, MD_PATH));
  console.log("questions: " + headings + " | bytes: " + Buffer.byteLength(md, "utf8"));
}

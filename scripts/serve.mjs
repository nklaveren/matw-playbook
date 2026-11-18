#!/usr/bin/env node
// Static file server for the local browser tests. It serves the repository
// under the same base path the production site uses, /matw_pb/, so the
// relative links of the page are exercised the way they are deployed.
//
// Node built-ins only.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_PATH = "/matw_pb/";
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function resolveTarget(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null;
  }
  if (!decoded.startsWith(BASE_PATH)) return null;
  const relative = decoded.slice(BASE_PATH.length);
  if (relative === "" || relative.endsWith("/")) {
    return path.join(ROOT, relative, "index.html");
  }
  const target = path.join(ROOT, relative);
  if (!target.startsWith(ROOT + path.sep)) return null;
  return target;
}

const server = http.createServer((req, res) => {
  const target = resolveTarget(req.url || "/");
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[path.extname(target)] || "application/octet-stream",
    "cache-control": "no-store"
  });
  fs.createReadStream(target).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log("serving " + ROOT + " on http://" + HOST + ":" + PORT + BASE_PATH);
});

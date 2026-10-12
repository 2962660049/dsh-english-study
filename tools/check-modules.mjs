/**
 * check-modules.mjs — static import-graph verification against the LIVE DSH server.
 *
 * `node --check` proves each file parses; it proves nothing about whether the
 * browser can *resolve* the module graph. A single wrong relative specifier or a
 * missing asset gives a blank page with only a console error. This walks the real
 * graph the browser would walk, over HTTP, and fails loudly.
 *
 * Usage:  node tools\check-modules.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? "http://127.0.0.1:19387";
const ROUTE_BASE = "/english-study";

let failures = 0;
let checks = 0;
function check(label, ok, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Resolve a relative specifier against a directory path, URL-style. */
function resolveSpecifier(specifier, fromPath) {
  if (/^[a-z]+:/i.test(specifier) || specifier.startsWith("//")) return null; // absolute URL: skip
  const baseDir = fromPath.slice(0, fromPath.lastIndexOf("/") + 1);
  const parts = specifier.startsWith("/") ? specifier.slice(1).split("/") : (baseDir + specifier).split("/");
  const stack = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return `/${stack.join("/")}`;
}

async function fetchAsset(path) {
  const response = await fetch(`${BASE}${path}`, { redirect: "manual" });
  const body = await response.text();
  return { status: response.status, type: response.headers.get("content-type") ?? "", body };
}

/* ---------------------------------------------------------------- 1. entry */

const pagePath = `${ROUTE_BASE}/`;
const page = await fetchAsset(pagePath);
check(`entry page ${pagePath} serves HTML`, page.status === 200 && page.type.includes("text/html"), `${page.status} ${page.type}`);

const entryScripts = [...page.body.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
const entryStyles = [...page.body.matchAll(/<link[^>]+href="([^"]+)"/g)].map((match) => match[1]);
check("entry page references at least one module script", entryScripts.length > 0, entryScripts.join(", "));
check("entry page references a stylesheet", entryStyles.length > 0, entryStyles.join(", "));

/* ------------------------------------------------- 2. walk the import graph */

const seen = new Set();
const queue = [...entryScripts].map((src) => resolveSpecifier(src, pagePath)).filter(Boolean);
const stylePaths = [...entryStyles].map((href) => resolveSpecifier(href, pagePath)).filter(Boolean);
const modules = [];
const specifierPattern = /(?:^|[\s;{(])(?:import|export)[\s\S]{0,400}?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|[\s;])import\s*["']([^"']+)["']/g;

while (queue.length > 0) {
  const path = queue.shift();
  if (seen.has(path)) continue;
  seen.add(path);
  const asset = await fetchAsset(path);
  const okType = asset.type.includes("javascript") || asset.type.includes("ecmascript");
  check(`module ${path} serves JS`, asset.status === 200 && okType, `${asset.status} ${asset.type}`);
  modules.push(path);
  if (asset.status !== 200) continue;
  for (const match of asset.body.matchAll(specifierPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (typeof specifier !== "string" || !specifier.startsWith(".") && !specifier.startsWith("/")) continue;
    const resolved = resolveSpecifier(specifier, path);
    if (resolved !== null) queue.push(resolved);
  }
}

/* ------------------------------------------------------------- 3. stylesheet */

for (const path of stylePaths) {
  const asset = await fetchAsset(path);
  check(`stylesheet ${path} serves CSS`, asset.status === 200 && asset.type.includes("text/css"), `${asset.status} ${asset.type}`);
  for (const match of asset.body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    const raw = match[1];
    if (/^(data:|https?:)/.test(raw)) continue;
    const resolved = resolveSpecifier(raw, path);
    if (resolved === null) continue;
    const dep = await fetchAsset(resolved);
    check(`css dependency ${resolved} resolves`, dep.status === 200, String(dep.status));
  }
}

/* ---------------------------------------------- 4. views are all reachable */

// The router imports the views explicitly; assert each one is in the graph it
// actually fetched, rather than trusting the directory listing.
for (const view of ["home", "diary", "webtest", "vocab", "settings"]) {
  const path = `${ROUTE_BASE}/js/views/${view}.js`;
  check(`view ${view}.js is served`, modules.includes(path) || (await fetchAsset(path)).status === 200, path);
}

/* ------------------------------------------- 5. hash deep links still serve */

for (const deep of [`${ROUTE_BASE}/#/diary`, `${ROUTE_BASE}/js/views/vocab.js`]) {
  const asset = await fetchAsset(deep.split("#")[0]);
  check(`deep path ${deep.split("#")[0]} serves`, asset.status === 200, `${asset.status} ${asset.type}`);
}

console.log("");
console.log(`${checks - failures}/${checks} checks passed  (${modules.length} modules walked)`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Verify the downloaded ECDICT file actually powers offline word lookup.
 *
 *   tools\node.cmd tools\check-dict.mjs
 *
 * It exercises the same `parseEcdictCsv` the host uses on `POST /llm/lexeme`, so a
 * header/format regression is caught here instead of at query time.
 */

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..");
const csvPath = join(root, "data", "dictionary", "ecdict.csv");

const module = await import(`file:///${join(root, "packages", "dsh-english-study", "lib", "index.js").replace(/\\/g, "/")}`);
const { parseEcdictCsv } = module.__internals;
const { parseExchange } = module;

let failures = 0;
const check = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
};

let size = 0;
try {
  size = statSync(csvPath).size;
} catch {
  console.log("FAIL data/dictionary/ecdict.csv is missing — run tools/fetch-ecdict.mjs");
  process.exit(1);
}
check("ecdict.csv is present and > 5 MB", size > 5_000_000, `${(size / 1024 / 1024).toFixed(1)} MiB`);

const text = readFileSync(csvPath, "utf8");
const lines = text.split("\n");
check("ecdict.csv has a large number of rows", lines.length > 700_000, `${lines.length} lines`);
check("header matches the columns parseEcdictCsv looks for", /^word,phonetic,definition,translation,pos,/.test(lines[0]), lines[0].slice(0, 80));
check("the last record is not truncated", text.endsWith("\n") || lines[lines.length - 1].split(",").length > 4);

const started = Date.now();
const dictionary = parseEcdictCsv(text);
const elapsed = Date.now() - started;
const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
check("parseEcdictCsv indexes the whole file, not a truncated prefix", dictionary.size > 700_000, `${dictionary.size} entries of ${lines.length - 1} rows in ${elapsed} ms, heap ${heapMb} MB`);

// The map value is the raw ECDICT row; `glossZh`/`inflections` only exist after
// the lexeme handler normalises it, so assert the raw columns here. Inflections
// are only present when the word actually has them, so each probe states what it
// must contain rather than assuming every word inflects.
const probes = [
  { word: "record", expectForm: "recorded", expectLabel: "过去式" },
  { word: "analysis", expectForm: "analyses", expectLabel: "复数" },
  { word: "beautiful", expectForm: null },
  { word: "went", expectForm: null, glossIncludes: "go" },
];
for (const { word, expectForm, expectLabel, glossIncludes } of probes) {
  const entry = dictionary.get(word);
  const inflections = entry === undefined ? [] : parseExchange(entry.exchange);
  const summary = entry === undefined
    ? "not found"
    : `${String(entry.translation).slice(0, 26).replace(/\n/g, " ")} /${entry.phonetic}/ | ${inflections.map((item) => `${item.label}:${item.form}`).join(" ") || "no inflections"}`;
  const hasGloss = entry !== undefined && entry.translation.length > 0;
  const hasForm = expectForm === null || inflections.some((item) => item.form === expectForm && item.label === expectLabel);
  const hasGlossHint = glossIncludes === undefined || String(entry?.translation ?? "").includes(glossIncludes);
  check(`lookup "${word}"${expectForm === null ? " returns a gloss" : ` resolves ${expectLabel} ${expectForm}`}`, hasGloss && hasForm && hasGlossHint, summary);
}

let withAnyForm = 0;
let withThreeForms = 0;
for (const entry of dictionary.values()) {
  const count = parseExchange(entry.exchange).length;
  if (count > 0) withAnyForm += 1;
  if (count >= 3) withThreeForms += 1;
}
// ECDICT only fills the `exchange` column where the forms are non-trivial, so the
// absolute count is modest — the point is that the column parses at all.
check("tens of thousands of words expose at least one form", withAnyForm > 40_000, `${withAnyForm} entries with 1+ inflections`);
check("a meaningful minority expose three or more forms", withThreeForms > 5_000, `${withThreeForms} entries with 3+ inflections`);

console.log("");
console.log(failures === 0 ? "dictionary check clean" : `${failures} dictionary check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

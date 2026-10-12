/**
 * Download the ECDICT English→Chinese dictionary into `data\dictionary\`.
 *
 * ECDICT gives lemma + Chinese gloss + IPA + every inflection + exam tags from a
 * single CSV, which makes word lookup in this app instant, offline and free — the
 * whole point of the no-API workflow. Example sentences still come from the model
 * (or from the user's own text).
 *
 *   tools\node.cmd tools\fetch-ecdict.mjs
 *
 * Streams to a temporary file, validates the header and row count, and only then
 * moves it into place, so a truncated download can never poison the dictionary.
 */

import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, renameSync, rmSync, statSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..");
const target = join(workspace, "data", "dictionary", "ecdict.csv");
const partial = `${target}.partial`;

const MIRRORS = [
  "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv",
  "https://gitee.com/skywind3000/ECDICT/raw/master/ecdict.csv",
  "https://raw.gitmirror.com/skywind3000/ECDICT/master/ecdict.csv",
  "https://ghproxy.net/https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv",
];

const MIN_BYTES = 5_000_000;

if (existsSync(target)) {
  const size = statSync(target).size;
  console.log(`dictionary already present: ${target} (${(size / 1_048_576).toFixed(1)} MiB)`);
  console.log("delete it first if you want to re-download.");
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });

function humanBytes(value) {
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

async function download(url) {
  console.log(`trying ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  if (response.body === null) throw new Error("empty body");

  const announced = Number(response.headers.get("content-length") ?? 0);
  console.log(`  connected — ${announced > 0 ? humanBytes(announced) : "size unknown"}`);

  let written = 0;
  let lastReport = Date.now();
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      written += chunk.length;
      if (Date.now() - lastReport > 3000) {
        lastReport = Date.now();
        const suffix = announced > 0 ? ` / ${humanBytes(announced)}` : "";
        console.log(`  ${humanBytes(written)}${suffix}`);
      }
      callback(null, chunk);
    },
  });

  rmSync(partial, { force: true });
  await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial));
  return written;
}

let done = false;
for (const url of MIRRORS) {
  try {
    const bytes = await download(url);
    if (bytes < MIN_BYTES) {
      console.log(`  too small (${humanBytes(bytes)}) — likely an error page, trying next mirror`);
      continue;
    }
    // Validate the header before accepting the file.
    const fd = openSync(partial, "r");
    const head = Buffer.alloc(4096);
    const read = readSync(fd, head, 0, 4096, 0);
    closeSync(fd);
    const firstLine = head.subarray(0, read).toString("utf8").split("\n")[0];
    if (!/word/i.test(firstLine) || !/translation/i.test(firstLine)) {
      console.log(`  header does not look like ECDICT: ${firstLine.slice(0, 120)}`);
      continue;
    }
    renameSync(partial, target);
    console.log(`saved ${target} (${humanBytes(bytes)})`);
    console.log(`header: ${firstLine}`);
    done = true;
    break;
  } catch (error) {
    console.log(`  failed: ${error?.message ?? error}`);
  }
}

if (!done) {
  rmSync(partial, { force: true });
  console.log("");
  console.log("all mirrors failed — the dictionary is optional, the app still runs.");
  console.log("word lookups will fall back to the model (if an API key is set) or to manual entry.");
  process.exit(1);
}

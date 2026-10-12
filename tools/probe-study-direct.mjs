/**
 * LIVE vision probe WITHOUT a DSH restart.
 *
 *   tools\node.cmd tools\probe-study-direct.mjs [imagePath] [storePath]
 *
 * tools\probe-study.mjs goes through the running server, so it only reflects
 * host-side edits after DSH restarts. This one imports the plugin's own modules
 * and calls the same registry, the same study contract and the same
 * shapeLlmResult, so the vision path can be proven the moment it is edited.
 *
 * It uses the GLM key already stored in data/store.json. Nothing is written to
 * the store.
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as llm from "../packages/dsh-english-study/lib/llm.js";
import { __internals } from "../packages/dsh-english-study/lib/index.js";
import { reportStudy } from "./study-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const imagePath = process.argv[2] ?? resolve(here, "fixtures", "handwriting-01.png");
const storePath = process.argv[3] ?? resolve(here, "..", "data", "store.json");

const store = JSON.parse(readFileSync(storePath, "utf8"));
const apiKey = store?.settings?.credentials?.glm?.apiKey;
if (typeof apiKey !== "string" || apiKey.length === 0) {
  console.log(`no GLM apiKey in ${storePath} — set one in 设置 first`);
  process.exit(1);
}

const settings = {
  activeProvider: "glm",
  credentials: {
    glm: {
      apiKey,
      model: store?.settings?.providers?.glm?.model ?? llm.DEFAULT_GLM_MODEL,
      baseUrl: store?.settings?.providers?.glm?.baseUrl ?? llm.DEFAULT_GLM_BASE,
    },
  },
};

const bytes = readFileSync(imagePath);
// Format the image exactly the way the host does: resolveImages produces
// { base64, mimeType }, and the route turns each one into an image_url content
// part before handing the message list to the adapter.
const resolved = await __internals.resolveImages([{ base64: bytes.toString("base64"), mimeType: "image/png" }], here);
const images = resolved.map((image) => llm.imagePartFromBase64(image.base64, image.mimeType));
console.log(`direct GLM study · ${imagePath} · ${bytes.length} B · max_tokens=${llm.GLM_MAX_TOKENS}`);

const started = Date.now();
// The SAME three-call orchestration the route runs, so this probe cannot drift
// from production.
const read = await __internals.runStudyPage({
  registry: new llm.LlmRegistry(),
  settings,
  images,
  prompts: store?.settings?.prompts,
  timeoutMs: 120_000,
});
const elapsed = Date.now() - started;
for (const [stage, call] of Object.entries(read.calls ?? {})) {
  console.log(
    `call ${stage}: adapter=${call.adapter ?? "?"} elapsed=${call.elapsedMs ?? "?"} ms usage=${JSON.stringify(call.usage ?? null)}${call.error ? ` error=${call.error}` : ""}`,
  );
}
const shaped = __internals.studyEnvelope(read);
// The host describes the circled words from the local ECDICT dictionary rather
// than spending its 1024-token budget on them. Mirror that step here, or this
// probe would be measuring a pipeline the server never runs.
const dictionary = new __internals.LocalDictionary(resolve(here, "..", "data", "dictionary", "ecdict.csv"));
await dictionary.ensureLoaded();
const enriched =
  shaped.degraded === true
    ? shaped
    : { ...shaped, data: __internals.enrichWordsFromDictionary(shaped.data, (key) => dictionary.lookup(key)) };
process.exit(reportStudy(enriched, elapsed) === 0 ? 0 : 1);

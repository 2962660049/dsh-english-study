/**
 * Live end-to-end check of the LLM adapter layer against the REAL DeepSeek API.
 *
 * This is deliberately NOT part of the offline suite (it needs network + a key and
 * it costs tokens). It exercises the plugin's actual production code path: the same
 * `registry.chat()` + `buildCorrectMessages()` + `imagePartFromBase64()` the host
 * route uses, including the host's exact "prepend image parts" step.
 *
 * Run:  tools\node.cmd tools\check-llm-live.mjs
 * Exits 0 only when OCR, translation and lexeme lookup all come back well-formed.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE = fileURLToPath(new URL("..", import.meta.url));
const {
  createDefaultRegistry,
  buildCorrectMessages,
  buildTranslateMessages,
  buildLexemeMessages,
  imagePartFromBase64,
  extractJson,
} = await import(new URL("../packages/dsh-english-study/lib/llm.js", import.meta.url).href);

let passed = 0;
let failed = 0;
function check(name, condition, extra = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// ---- the user's own DSH DeepSeek credential (never printed) --------------------
const creds = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
const apiKey = creds.match(/DEEPSEEK_API_KEY:\s*"?([^"\s]+)"?/)?.[1];
if (!apiKey) {
  console.log("SKIP: no DEEPSEEK_API_KEY in ~/.dsh/.credentials.yaml");
  process.exit(1);
}

const settings = {
  activeProvider: "deepseek",
  credentials: { deepseek: { apiKey, model: "deepseek-flash" } },
  providers: {},
};

// ---- registry description -----------------------------------------------------
console.log("\n[1] registry description");
const registry = createDefaultRegistry();
const described = registry.describe(settings);
const deepseek = described.find((d) => d.id === "deepseek");
const manual = described.find((d) => d.id === "manual");
check("deepseek is offered", deepseek !== undefined);
check("deepseek reports configured=true from the seeded key", deepseek?.configured === true);
check("deepseek now advertises vision", deepseek?.capabilities?.vision === true, JSON.stringify(deepseek?.capabilities));
check("manual is still offered as the zero-cost fallback", manual !== undefined);
check("describe() never leaks the key", !JSON.stringify(described).includes(apiKey));
check("manual.chat() still refuses (must not call out)", await (async () => {
  try {
    await registry.chat({ activeProvider: "manual" }, { messages: [{ role: "user", content: "hi" }] });
    return false;
  } catch (error) {
    return error.code === "config" && /手动模式/.test(error.message);
  }
})());

// ---- STEP 1: OCR the photo + correct ------------------------------------------
console.log("\n[2] photo -> OCR + correction (the diary pipeline, step 1)");
const png = readFileSync(`${WORKSPACE}data/cache/vision-test.png`);
const base64 = png.toString("base64");

// exactly what the host route does: build messages, then PREPEND the image parts
const messages = buildCorrectMessages({ text: "", context: "", images: [] });
messages[0].content = [
  imagePartFromBase64(base64, "image/png"),
  ...messages[0].content,
];
check("image part is first, text parts follow (lastUserText contract)", messages[0].content[0].type === "image_url");

const correctResponse = await registry.chat(settings, { messages, timeoutMs: 90_000, json: true });
const correctParsed = extractJson(correctResponse.text);
console.log(`     adapter=${correctResponse.adapter} elapsed=${correctResponse.elapsedMs}ms`);
check("correction JSON parsed (not degraded)", correctParsed.error === null, String(correctParsed.error));
const correct = correctParsed.value ?? {};
console.log(`     corrected: ${JSON.stringify(correct.corrected)?.slice(0, 220)}`);
check("OCR read the image: mentions the cat", /cat/i.test(String(correct.corrected)));
check("OCR read the image: mentions the ink bottle", /ink bottle/i.test(String(correct.corrected)));
check("OCR read the image: mentions rewriting the page", /rewrite/i.test(String(correct.corrected)));
check("corrections is an array", Array.isArray(correct.corrections), typeof correct.corrections);
check("segments is a non-empty array", Array.isArray(correct.segments) && correct.segments.length > 0);
console.log(`     corrections=${correct.corrections?.length ?? 0} segments=${correct.segments?.length ?? 0}`);

// ---- STEP 2: translate the confirmed English ----------------------------------
console.log("\n[3] translate (the diary pipeline, step 2)");
const translateResponse = await registry.chat(settings, {
  messages: buildTranslateMessages({ text: correct.corrected ?? "" }),
  timeoutMs: 90_000,
  json: true,
});
const translateParsed = extractJson(translateResponse.text);
check("translation JSON parsed", translateParsed.error === null, String(translateParsed.error));
const sentences = translateParsed.value?.sentences ?? [];
check("translation returned sentence pairs", sentences.length > 0);
check("every pair has English", sentences.every((s) => typeof s.en === "string" && s.en.length > 0));
check("every pair has Chinese", sentences.every((s) => typeof s.zh === "string" && /[\u4e00-\u9fff]/.test(s.zh)));
if (sentences[0]) console.log(`     first pair: ${JSON.stringify(sentences[0])}`);

// ---- STEP 3: per-word enrichment ---------------------------------------------
console.log("\n[4] lexeme lookup (word detail: IPA, inflections, examples)");
const lexemeResponse = await registry.chat(settings, {
  messages: buildLexemeMessages({
    word: "knocked",
    sentence: sentences[0]?.en ?? "My cat knocked over the ink bottle.",
  }),
  timeoutMs: 90_000,
  json: true,
});
const lexemeParsed = extractJson(lexemeResponse.text);
check("lexeme JSON parsed", lexemeParsed.error === null, String(lexemeParsed.error));
const lex = lexemeParsed.value ?? {};
console.log(`     ${JSON.stringify(lex).slice(0, 400)}`);
check("lemma reduces to the base form", String(lex.lemma).toLowerCase() === "knock", String(lex.lemma));
check("glossZh is Chinese", /[\u4e00-\u9fff]/.test(String(lex.glossZh)));
check("phonetic present", typeof lex.phonetic === "string" && lex.phonetic.length > 0);
check("inflections is a non-empty array", Array.isArray(lex.inflections) && lex.inflections.length > 0);
check("inflections carry Chinese labels", Array.isArray(lex.inflections) && lex.inflections.every((i) => i.form && i.label));
check("examples is a non-empty array", Array.isArray(lex.examples) && lex.examples.length > 0);

console.log(`\n${passed}/${passed + failed} live checks passed`);
process.exit(failed === 0 ? 0 : 1);

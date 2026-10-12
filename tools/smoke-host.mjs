/**
 * Smoke test for the 英语学习小助手 host half.
 *
 * Runs without DSH: it exercises the JSON store, the LLM adapter registry, the
 * mock adapter, JSON extraction, the ECDICT exchange parser, and the provider
 * output normalisers that absorb the differences between models. This is the fast
 * inner loop for host-side work, because the full plugin only loads inside DSH.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results = [];
function check(label, condition, detail = "") {
  results.push({ label, ok: Boolean(condition), detail });
  const mark = condition ? "PASS" : "FAIL";
  console.log(`${mark}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const host = await import("../packages/dsh-english-study/lib/index.js");
const llm = await import("../packages/dsh-english-study/lib/llm.js");
const { JsonStore } = await import("../packages/dsh-english-study/lib/store.js");
const internals = host.__internals;

/* ------------------------------------------------------------- module shape */
check("host exports apply", typeof host.apply === "function");
check("host injects webServer", Array.isArray(host.inject) && host.inject.includes("webServer"));
check("host exports a name", typeof host.name === "string" && host.name.length > 0);

/* --------------------------------------------------------------- JSON store */
const dir = await mkdtemp(join(tmpdir(), "english-study-"));
const storePath = join(dir, "store.json");
const store = new JsonStore(storePath);
const empty = await store.snapshot();
check("store starts empty", Array.isArray(empty.diary) && Array.isArray(empty.vocabWords));

const first = await store.mutateIdempotent("req-1", (data) => {
  data.diary.push({ id: "d1", date: "2026-02-14", corrected: "Hello." });
  return { id: "d1" };
});
check("first idempotent mutation applies", first.replayed === false && first.result.id === "d1");

const replay = await store.mutateIdempotent("req-1", () => {
  throw new Error("the mutator must not run on replay");
});
check("replaying the same requestId does not re-run the mutator", replay.replayed === true);
check("replay returns the recorded result", replay.result?.id === "d1");

const afterReplay = await store.snapshot();
check("replay did not duplicate data", afterReplay.diary.length === 1, `diary.length=${afterReplay.diary.length}`);

const other = await store.mutateIdempotent("req-2", (data) => {
  data.diary.push({ id: "d2", date: "2026-02-15" });
  return { id: "d2" };
});
check("a different requestId applies normally", other.replayed === false && (await store.snapshot()).diary.length === 2);

await store.flush();
const onDisk = JSON.parse(await readFile(storePath, "utf8"));
check("store persisted to disk atomically", onDisk.diary.length === 2 && typeof onDisk.updatedAt === "string");
check("store records a schema version", onDisk.version === 1);

// A corrupt store must be preserved, not silently discarded.
const { writeFile, readdir } = await import("node:fs/promises");
await writeFile(storePath, "{ this is not json", "utf8");
const recovered = new JsonStore(storePath, { onError: () => {} });
const recoveredData = await recovered.snapshot();
check("corrupt store recovers to an empty document", recoveredData.diary.length === 0);
const backups = (await readdir(dir)).filter((f) => f.includes(".corrupt-"));
check("corrupt store is backed up rather than destroyed", backups.length === 1, backups.join(","));

await rm(dir, { recursive: true, force: true });

/* -------------------------------------------------------------- LLM layer */
const registry = llm.createDefaultRegistry();
// The user's requirement is absolute: the page offers 智谱 and nothing else. The
// priced providers that used to exist must be gone from the registry entirely, not
// merely hidden, or a stale stored setting could route to one.
check("registry ships only glm + the hidden mock", registry.ids().join(",") === "glm,mock", registry.ids().join(","));
check("priced providers are gone from the registry", ["doubao", "deepseek", "manual"].every((id) => !registry.ids().includes(id)));
check("glm is the first provider offered", registry.ids()[0] === "glm");

const keyless = registry.describe({ credentials: {}, providers: {} });
const withKey = registry.describe({ credentials: { glm: { apiKey: "x" } }, providers: {} });
check(
  "glm advertises vision so the photo pipeline can use it",
  keyless.find((entry) => entry.id === "glm")?.capabilities?.vision === true,
);
check(
  "glm reports itself unconfigured until a key is supplied",
  keyless.find((entry) => entry.id === "glm")?.configured === false,
);
check(
  "glm reports itself configured once a key exists",
  withKey.find((entry) => entry.id === "glm")?.configured === true,
);
check("the mock double is flagged hidden", keyless.find((entry) => entry.id === "mock")?.hidden === true);
check(
  "the hidden filter leaves only glm for the browser",
  keyless.filter((entry) => entry.hidden !== true).map((entry) => entry.id).join(",") === "glm",
);

let glmError = null;
try {
  await registry.chat({ activeProvider: "glm", credentials: {}, providers: {} }, {
    messages: llm.buildStudyTextMessages({ images: [] }),
    timeoutMs: 5000,
  });
} catch (error) {
  glmError = error;
}
check("glm without a key fails as a config error", glmError !== null && glmError.code === "config");

/* ------------------------------------------------- R5: single-flight queue */
// The reliability spec allows exactly ONE provider request in flight. The queue is
// what enforces it, so it is asserted directly rather than inferred.
{
  const order = [];
  let concurrent = 0;
  let peak = 0;
  const job = (name, ms) => () => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    order.push(`start:${name}`);
    return new Promise((resolve) => {
      setTimeout(() => {
        order.push(`end:${name}`);
        concurrent -= 1;
        resolve(name);
      }, ms);
    });
  };
  const queue = registry.queue;
  const [first, second] = await Promise.all([queue.run(job("a", 20)), queue.run(job("b", 1))]);
  check("R5: two provider requests never overlap", peak === 1, `peak=${peak}`);
  check("R5: the provider queue is FIFO", order.join(",") === "start:a,end:a,start:b,end:b", order.join(","));
  check("R5: a queued call still resolves with its own result", first === "a" && second === "b");
}

/* ---------------------------------------------------- the shipped prompts */
// These ARE the product: the user handed over their own wording and expects to see
// it, and to be able to edit it in 设置. It is split across three diary prompts
// because the combined wording measurably lost ringed words (see lib/llm.js).
check(
  "the page-text prompt keeps the user's wording",
  llm.DEFAULT_PROMPTS.pageText.includes("这是一篇翻译完成的手写英文") &&
    llm.DEFAULT_PROMPTS.pageText.includes("提取出其中的英文"),
);
check("the word prompt asks for the ellipse-ringed words", llm.DEFAULT_PROMPTS.pageWords.includes("椭圆包裹标注"));
check("the collocation prompt asks for 固定搭配", llm.DEFAULT_PROMPTS.collocations.includes("固定搭配"));
check(
  "the normalize prompt promises English out",
  llm.DEFAULT_PROMPTS.normalize.includes("最终结果里不要保留任何中文"),
);
check(
  "the four default prompts are exported together",
  Object.keys(llm.DEFAULT_PROMPTS).join(",") === "pageText,pageWords,collocations,normalize",
);

/* ------------------------------------------- the offline mock pipeline */
const mockSettings = { activeProvider: "mock", credentials: {}, providers: {} };

const studiedText = await registry.chat(mockSettings, {
  messages: llm.buildStudyTextMessages({ images: [] }),
  timeoutMs: 5000,
});
const studiedJson = llm.extractJson(studiedText.text);
check("mock adapter answers the page-text call", studiedJson.error === null && typeof studiedJson.value.text === "string");
const studiedWords = await registry.chat(mockSettings, {
  messages: llm.buildStudyWordsMessages({ images: [] }),
  timeoutMs: 5000,
});
check(
  "mock adapter answers the ringed-word call as a bare list",
  internals.parseWordList(studiedWords.text).map((entry) => entry.word).join(",") === "uneasy",
);
check("adapter id is reported back", studiedText.adapter === "mock");

const normalized = await registry.chat(mockSettings, {
  messages: llm.buildNormalizeMessages({ text: "Hello there.\n\nHow are you?" }),
  timeoutMs: 5000,
});
const normalizedJson = llm.extractJson(normalized.text);
check(
  "mock adapter answers the text-area task one entry per line",
  (normalizedJson.value?.lines ?? []).length === 3 &&
    normalizedJson.value.lines[1].en === "" &&
    normalizedJson.value.lines[2].en === "How are you?",
  JSON.stringify(normalizedJson.value?.lines),
);

const lexeme = await registry.chat(mockSettings, {
  messages: llm.buildLexemeMessages({ word: "record" }),
  timeoutMs: 5000,
});
check("mock adapter answers the lexeme task", llm.extractJson(lexeme.text).value?.lemma === "record");

/* ------------------------------------- provider-output normalisation (GLM) */
// Regressions measured against real GLM-4V-Flash output: correction entries that
// carry only a reason (blank diff rows), and a whole page returned as ONE segment.
check(
  "corrections with no text are dropped, not rendered as blank rows",
  internals.normalizeCorrections([
    { reason: "Typographical error" },
    { original: "blance", corrected: "balance", reason: "spelling" },
  ]).length === 1,
);
check(
  "correction aliases are normalised",
  internals.normalizeCorrections([{ from: "must expensive", to: "much more expensive", why: "comparative" }])[0]?.original ===
    "must expensive",
);
check(
  "a single blob segment is re-split into sentences",
  internals.normalizeSegments([{ en: "I went home. It was late.", zh: "" }], "I went home. It was late.").length === 2,
);

/* ------------------------------- circled-word normalisation (the diary path) */
const labelForm = internals.normalizeStudyWords([
  {
    word: "postponed",
    lemma: "postpone",
    partOfSpeech: "v.",
    glossZh: "推迟",
    inflections: [
      { label: "过去式", form: "postponed" },
      { label: "过去分词", form: "postponed" },
      { label: "现在进行时", form: "postponing" },
    ],
    collocations: ["postpone till"],
    sentence: "I postponed balance till the very end.",
  },
]);
check("a circled word survives normalisation", labelForm.length === 1 && labelForm[0].lemma === "postpone");
check(
  "the base form is always present",
  labelForm[0].inflections.some((item) => item.label === "原形" && item.form === "postpone"),
);
check(
  "现在进行时 is mapped onto the canonical 现在分词 label",
  labelForm[0].inflections.some((item) => item.label === "现在分词" && item.form === "postponing"),
);
check("collocations are carried through", labelForm[0].collocations[0] === "postpone till");

const flatForm = internals.normalizeStudyWords([
  { word: "insufficient", lemma: "insufficient", past: "", plural: "insufficients", comparative: "more insufficient" },
]);
check(
  "flat form fields are accepted when no label array is given",
  flatForm[0].inflections.some((item) => item.label === "比较级" && item.form === "more insufficient"),
);
check(
  "an empty form field is not turned into a bogus inflection",
  flatForm[0].inflections.every((item) => item.form.trim().length > 0),
);
check(
  "duplicate lemmas from one page are collapsed",
  internals.normalizeStudyWords([{ word: "track", lemma: "track" }, { word: "track", lemma: "track" }]).length === 1,
);
check("a wordless entry is discarded", internals.normalizeStudyWords([{ glossZh: "无" }]).length === 0);

/* ---------------------------- the three-call read that replaced one big call */
// GLM-4V-Flash rejects max_tokens outside [1,1024] with code 1210, and a single
// JSON call carrying the page AND seventeen fully described words hit that ceiling:
// the model dropped circled words and emptied the inflection objects to fit.
// Measured on a real page, the split below is what recovered 17/17 ringed words
// (50 completion tokens) plus 16/17 collocations (111), where the one-shot call
// managed 13-16/17 and never returned a single collocation.
check("the GLM output ceiling is pinned at the API maximum", llm.GLM_MAX_TOKENS === 1024);

const textContract = llm
  .buildStudyTextMessages({ images: [] })[0]
  .content.map((part) => String(part.text))
  .join("\n");
const wordsContract = llm
  .buildStudyWordsMessages({ images: [] })[0]
  .content.map((part) => String(part.text))
  .join("\n");
const collocationContract = llm
  .buildStudyCollocationsMessages({ text: "x", words: [{ word: "uneasy" }] })[0]
  .content.map((part) => String(part.text))
  .join("\n");
check("call 1 asks for the page text and nothing else", textContract.includes('{"text"') && !textContract.includes('"words"'));
check("call 2 asks for a bare word list, not JSON", wordsContract.includes("one word per line") && !wordsContract.includes('{"words"'));
check("call 3 asks for word = phrase lines", collocationContract.includes("word = phrase"));
check(
  "each call carries its OWN editable prompt, not the old combined one",
  textContract.includes("提取出其中的英文") &&
    wordsContract.includes("椭圆包裹标注") &&
    collocationContract.includes("固定搭配") &&
    !wordsContract.includes("过去式"),
);
check(
  "the combined prompt is gone, so the word call is not asked for inflections",
  !Object.values(llm.DEFAULT_PROMPTS).some((prompt) => prompt.includes("现在进行时")),
);
check(
  "the sentence is no longer requested from the model",
  !/"sentence"/.test(textContract + wordsContract),
);
// Only the JSON-returning tasks may ask the provider for JSON output mode; the two
// line-list tasks must not, or a strict provider would turn a right answer into an
// unparseable one.
check(
  "the JSON tasks ask for JSON output mode",
  llm.isJsonTask(llm.buildStudyTextMessages({ images: [] })) &&
    llm.isJsonTask(llm.buildNormalizeMessages({ text: "你好。", images: [] })) &&
    llm.isJsonTask([{ role: "user", content: [{ type: "text", text: llm.TASK_MARKERS.lexeme }] }]),
);
check(
  "the two line-list tasks never ask for JSON output mode",
  !llm.isJsonTask(llm.buildStudyWordsMessages({ images: [] })) &&
    !llm.isJsonTask(llm.buildStudyCollocationsMessages({ text: "x", words: [{ word: "uneasy" }] })) &&
    !llm.isJsonTask([]),
);
check("the GLM adapter advertises JSON output support", new llm.LlmRegistry().create("glm", { apiKey: "k" }).capabilities.json === true);

/* ------------------------------------------- reading a bare word list back */
// The two word passes are unioned, because a single pass can drop a ringed word.
{
  const page = "I felt uneasy. I postponed balance till the very end. I sampled noodles.";
  const merged = internals.mergeWordPasses(
    [
      [{ word: "uneasy" }, { word: "sampled" }],
      [{ word: "postponed" }, { word: "sampled" }],
    ],
    page,
  );
  check(
    "the word passes are unioned, not intersected",
    merged.map((entry) => entry.word).join(",") === "uneasy,postponed,sampled",
  );
  check(
    "the union is ordered by position in the page, not by pass",
    internals
      .mergeWordPasses([[{ word: "sampled" }], [{ word: "uneasy" }]], page)
      .map((entry) => entry.word)
      .join(",") === "uneasy,sampled",
  );
  check(
    "a word absent from the page still survives, at the end",
    internals.mergeWordPasses([[{ word: "zzzz" }, { word: "uneasy" }]], page).map((entry) => entry.word).join(",") ===
      "uneasy,zzzz",
  );
  check(
    "ordering uses word boundaries, not raw substrings",
    internals
      .mergeWordPasses([[{ word: "till" }, { word: "uneasy" }]], "I still felt uneasy, till the end.")
      .map((entry) => entry.word)
      .join(",") === "uneasy,till",
  );
}
check(
  "a bare newline list is the fast path",
  internals.parseWordList("uneasy\naccomplish\ntrack").map((entry) => entry.word).join(",") === "uneasy,accomplish,track",
);
check("a JSON array is still accepted", internals.parseWordList('["uneasy","tackle"]').length === 2);
check(
  "a JSON array of objects is still accepted",
  internals.parseWordList('[{"word":"uneasy"},{"word":"tackle"}]').map((entry) => entry.word).join(",") === "uneasy,tackle",
);
check("a numbered list is still accepted", internals.parseWordList("1. uneasy\n2. tackle").length === 2);
check("a 'word -> lemma' line keeps the word", internals.parseWordList("postponed -> postpone")[0].word === "postponed");
check("an empty ringed list is not a word", internals.parseWordList("none").length === 0);
check("prose is not mistaken for a word list", internals.parseWordList("Here are the words I found on the page:").length === 0);
check("duplicate words collapse", internals.parseWordList("uneasy\nuneasy").length === 1);

/* ------------------------------------------- reading the collocation lines */
const collocationMap = internals.parseCollocationList("uneasy = feel uneasy\ntrack - on track\ntill: till the very end");
check("collocations parse with every separator", collocationMap.get("uneasy")?.[0] === "feel uneasy" && collocationMap.get("track")?.[0] === "on track" && collocationMap.get("till")?.[0] === "till the very end");
check("a quoted phrase loses its quotes", internals.parseCollocationList('accomplish = "ought to"').get("accomplish")?.[0] === "ought to");
check(
  "a quoted-back sentence is not a collocation",
  internals.parseCollocationList("sampled = sampled yesterday and I liked the noodles very much").size === 0,
);

/* --------------------------------- the dictionary supplies every description */
// This is the point of the split: the model never has to know a part of speech,
// a gloss or an inflection, because ECDICT already knows all three.
check("ECDICT's 0: code names the lemma", internals.lemmaFromExchange("0:postpone/1:dp/d:postponed") === "postpone");
check("an exchange with no 0: code yields no lemma", internals.lemmaFromExchange("d:postponed/p:postponed") === "");
const stubDictionary = {
  postponed: {
    word: "postponed",
    phonetic: "pəʊstˈpəʊnd",
    translation: "vt. 推迟, 延期",
    pos: "v.",
    exchange: "0:postpone/1:dp/d:postponed/p:postponed",
  },
  postpone: {
    word: "postpone",
    phonetic: "pəʊstˈpəʊn",
    translation: "vt. 延迟, 使延期",
    pos: "v.",
    exchange: "0:postpone/1:dp/d:postponed/p:postponed/i:postponing",
  },
};
const enriched = internals.enrichWordsFromDictionary(
  { text: "", words: [{ word: "postponed", lemma: "", collocations: ["postponed balance"] }] },
  (key) => stubDictionary[key] ?? null,
);
check("an inflected surface form reaches its lemma through ECDICT", enriched.words[0].lemma === "postpone");
check("the description comes from the lemma's own entry", enriched.words[0].phonetic === "pəʊstˈpəʊn" && enriched.words[0].glossZh === "vt. 延迟, 使延期");
check(
  "the full inflection set arrives, 原形 first",
  enriched.words[0].inflections[0].label === "原形" &&
    enriched.words[0].inflections.map((entry) => entry.label).join(",") === "原形,过去分词,过去式,现在分词",
);
check("the model's collocation survives enrichment", enriched.words[0].collocations[0] === "postponed balance");
check(
  "an unknown word keeps its surface form as its lemma",
  internals.enrichWordsFromDictionary({ text: "", words: [{ word: "zzzz" }] }, () => null).words[0].lemma === "zzzz",
);

/* ---------------------------------------- a truncated page is still usable */
const truncatedPage = '{"text":"I felt uneasy. I postponed balance till the very';
check("a page cut off mid-text is a parse failure", llm.extractJson(truncatedPage).error !== null);
check(
  "the transcription survives a truncation",
  internals.salvageStudyPayload(truncatedPage)?.text === "I felt uneasy. I postponed balance till the very",
);
check("a reply with nothing usable is not salvaged", internals.salvageStudyPayload("not json at all") === null);
check(
  "the host finds the sentence for an inflected surface form",
  internals.sentenceForWord({ word: "postponed", lemma: "postpone" }, [
    { en: "I felt uneasy.", zh: "" },
    { en: "I postponed balance till the very end.", zh: "" },
  ]) === "I postponed balance till the very end.",
);

/* ------------------------------- the whole read, driven by the offline mock */
const mockRead = await internals.runStudyPage({
  registry,
  settings: mockSettings,
  images: [],
  prompts: undefined,
  timeoutMs: 5000,
});
check("the three-call read returns the page", mockRead.degraded === false && mockRead.text.length > 0);
check("the three-call read returns the ringed word", mockRead.words.length === 1 && mockRead.words[0].word === "uneasy");
check("the three-call read attaches the collocation", mockRead.words[0].collocations[0] === "feel uneasy");
check("the read reports every call it made", ["text", "words", "collocations"].every((key) => mockRead.calls[key]?.adapter === "mock"));
check("the word call is attempted twice and both passes are recorded", mockRead.calls.wordsAgain?.adapter === "mock");
check("the reader gets sentences to click", mockRead.sentences.length >= 1);
const mockEnvelope = internals.studyEnvelope(mockRead);
check("the envelope shape the views read is preserved", mockEnvelope.degraded === false && mockEnvelope.data.words.length === 1 && mockEnvelope.task === "study");
check("the envelope sums the elapsed time of all three calls", mockEnvelope.elapsedMs >= 0);
const degradedEnvelope = internals.studyEnvelope({ degraded: true, parseError: "boom", text: "", words: [], rawText: "raw", calls: { text: { adapter: "glm", elapsedMs: 3, usage: null } } });
check("a degraded read keeps the raw text for 重新解析", degradedEnvelope.degraded === true && degradedEnvelope.rawText === "raw" && degradedEnvelope.data === null);

/* ------------------------------------ the text-area path must ALWAYS give English */
// Two live bugs: an English or Chinese paste produced a blank preview, and a
// Chinese-only paste reached the reader as Chinese, which cannot be pronounced.
// Three more (measured live): a blank line truncated the result, a list number
// reflowed onto the previous paragraph, and 同人 survived inside English output.
check(
  "an empty model answer falls back to the pasted text",
  internals.normalizeNormalizeResult({}, "I go to school yesterday.").corrected === "I go to school yesterday.",
);
check(
  "a blank line between paragraphs survives the round trip",
  internals.normalizeNormalizeResult(
    { lines: [{ n: 1, en: "First para." }, { n: 2, en: "" }, { n: 3, en: "Second para." }] },
    "第一段。\n\n第二段。",
  ).corrected === "First para.\n\nSecond para.",
);
check(
  "a list number stays at the start of its own line",
  internals.normalizeNormalizeResult(
    { lines: [{ n: 1, en: "I need to plan." }, { n: 2, en: "1. Message Manager Ge." }, { n: 3, en: "2. Prepare the lesson plan." }] },
    "我需要做计划。\n1. 给葛经理发消息。\n2. 准备教学计划。",
  ).corrected === "I need to plan.\n1. Message Manager Ge.\n2. Prepare the lesson plan.",
);
check(
  "a line the model omitted is kept verbatim and reported, never dropped",
  (() => {
    const shaped = internals.normalizeNormalizeResult(
      { lines: [{ n: 1, en: "First." }, { n: 3, en: "Third." }] },
      "第一行。\n第二行。\n第三行。",
    );
    return shaped.corrected === "First.\n第二行。\nThird." && shaped.missing.join(",") === "2";
  })(),
);
check(
  "Chinese left inside an English line is reported so it can be repaired",
  (() => {
    const shaped = internals.normalizeNormalizeResult(
      { lines: [{ n: 1, en: "Learn to make同人 videos." }, { n: 2, en: "Fine." }] },
      "学习制作同人视频。\n很好。",
    );
    return shaped.impure.join(",") === "1" && shaped.missing.length === 0;
  })(),
);
check(
  "the corrected text is never allowed to be empty",
  internals.normalizeNormalizeResult({ corrected: "" }, "").corrected.length >= 0 &&
    internals.normalizeNormalizeResult({ corrected: "" }, "原文").corrected === "原文",
);
check(
  "a text with no segments still yields one pronounceable segment",
  internals.normalizeNormalizeResult({ corrected: "One single line." }, "").segments.length === 1,
);
check(
  "segments alone are enough to build the corrected text",
  internals.normalizeNormalizeResult({ segments: [{ en: "I went home." }, { en: "It was late." }] }, "x").corrected ===
    "I went home.\nIt was late.",
);
check(
  "a repair answer is merged by its original line number",
  (() => {
    const source = "第一行。\n第二行。\n第三行。";
    const first = internals.normalizeEntries({ lines: [{ n: 1, en: "First." }, { n: 3, en: "Third." }] }).entries;
    const repair = internals.normalizeEntries({ lines: [{ n: 2, en: "Second." }] }).entries;
    const merged = internals.composeNormalized(llm.splitSourceLines(source), [...first, ...repair]);
    return merged.corrected === "First.\nSecond.\nThird." && merged.missing.length === 0;
  })(),
);

const shapedNormalize = internals.shapeLlmResult(
  { text: JSON.stringify({ language: "zh", segments: [{ en: "First." }, { en: "Second." }] }), adapter: "glm", elapsedMs: 1, usage: null },
  "normalize",
  "第一句。第二句。",
);
check(
  "shapeLlmResult normalises the text-area task",
  shapedNormalize.degraded === false && shapedNormalize.data.corrected === "First.\nSecond.",
);
check(
  "the request text is what the fallback uses (sourceText plumbing)",
  internals.shapeLlmResult(
    { text: "{}", adapter: "glm", elapsedMs: 1, usage: null },
    "normalize",
    "我昨天的日记。",
  ).data.corrected === "我昨天的日记。",
);
check(
  "unparseable output degrades instead of throwing",
  internals.shapeLlmResult({ text: "not json at all", adapter: "glm", elapsedMs: 1, usage: null }, "normalize", "x").degraded === true,
);

// The live repair loop: the model skipped a line, so a second call is sent with
// ONLY that line's original number and the answer is merged back by number.
const repairSeen = [];
const repairRegistry = {
  async chat(_settings, request) {
    const parts = request.messages[0].content;
    const payload = String(parts[parts.length - 1].text);
    const numbers = payload
      .split("\n")
      .map((line) => Number(/^L(\d+)/.exec(line)?.[1] ?? 0))
      .filter((n) => Number.isFinite(n) && n > 0);
    repairSeen.push(numbers.join(","));
    // First pass deliberately drops line 2, exactly like the live failure.
    const answered = repairSeen.length === 1 ? numbers.filter((n) => n !== 2) : numbers;
    return {
      text: JSON.stringify({
        language: "zh",
        lines: answered.map((n) => ({ n, en: `Line ${n} in English.`, zh: `第 ${n} 行` })),
        corrections: [],
      }),
      adapter: "fake",
      elapsedMs: 5,
      usage: { completion_tokens: 9 },
    };
  },
};
const repairedEnvelope = await internals.runNormalize({
  registry: repairRegistry,
  settings: mockSettings,
  text: "第一行。\n第二行。\n第三行。",
  timeoutMs: 5000,
});
check("a skipped line is re-requested by its own original number", repairSeen.join(" | ") === "1,2,3 | 2");
check(
  "the repaired line is merged back into the final text",
  repairedEnvelope.data.corrected === "Line 1 in English.\nLine 2 in English.\nLine 3 in English." &&
    repairedEnvelope.data.missing.length === 0 &&
    repairedEnvelope.data.repaired === true,
);
check("both text-area requests are counted in the elapsed time", repairedEnvelope.elapsedMs === 10);

// Chunking: a long paste must not be asked for in ONE reply, because the 1024-token
// ceiling silently truncates it (the measured cause of the dropped line).
const eighteen = Array.from({ length: 18 }, (_, index) => `第 ${index + 1} 行。`);
const chunkBlocks = internals.buildNormalizeBlocks(eighteen);
check(
  "long input is split into bounded blocks with original line numbers",
  chunkBlocks.length === 3 &&
    chunkBlocks[0].labelled.startsWith("L1: ") &&
    chunkBlocks[1].labelled.startsWith("L9: ") &&
    chunkBlocks[2].numbers.join(",") === "17,18",
  chunkBlocks.map((block) => `${block.numbers[0]}..${block.numbers[block.numbers.length - 1]}`).join(" | "),
);
check(
  "a block of nothing but blank lines is skipped",
  internals.buildNormalizeBlocks(["", "", "", "", "", "", "", "", "第一行。"]).length === 1,
);

// A reply cut off by the output ceiling is unparseable JSON. That says the block was
// too big, so the block is bisected and re-asked rather than the lines being lost.
const bisectSeen = [];
const bisectRegistry = {
  async chat(_settings, request) {
    const parts = request.messages[0].content;
    const payload = String(parts[parts.length - 1].text);
    const numbers = payload
      .split("\n")
      .map((line) => Number(/^L(\d+)/.exec(line)?.[1] ?? 0))
      .filter((n) => n > 0);
    bisectSeen.push(numbers.join(","));
    if (numbers.length > 4) {
      return { text: '{"language":"zh","lines":[{"n":1,"en":"cut off', adapter: "fake", elapsedMs: 3, usage: null };
    }
    return {
      text: JSON.stringify({ language: "zh", lines: numbers.map((n) => ({ n, en: `Line ${n}.` })) }),
      adapter: "fake",
      elapsedMs: 3,
      usage: null,
    };
  },
};
const bisectEnvelope = await internals.runNormalize({
  registry: bisectRegistry,
  settings: mockSettings,
  text: Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 行。`).join("\n"),
  timeoutMs: 5000,
});
check(
  "an unparseable block is bisected instead of losing its lines",
  bisectSeen.join(" | ") === "1,2,3,4,5,6,7,8 | 1,2,3,4 | 5,6,7,8",
  bisectSeen.join(" | "),
);
check(
  "every line of the bisected block still reaches the output",
  bisectEnvelope.data.missing.length === 0 &&
    bisectEnvelope.data.corrected === "Line 1.\nLine 2.\nLine 3.\nLine 4.\nLine 5.\nLine 6.\nLine 7.\nLine 8.",
);

check(
  "the page supplies sentences for the reader",
  Array.isArray(mockEnvelope.data.sentences) && mockEnvelope.data.sentences.length >= 1,
);

/* --------------------------------------------- uploaded-photo references */
// The diary page re-imports an already-saved entry, so it sends stored ids
// rather than fresh base64. This broke silently once: normalizeImages knew the
// `id` spelling but not `storedImageId`, so every re-import 400'd.
const storedId = `${"a".repeat(32)}.jpg`;
const byStoredId = internals.normalizeImages([{ storedImageId: storedId, role: "annotated" }]);
check(
  "a storedImageId reference survives normalisation with its role",
  byStoredId.length === 1 && byStoredId[0].storedImageId === storedId && byStoredId[0].role === "annotated",
);
const byId = internals.normalizeImages([{ id: storedId }]);
check(
  "the legacy `id` spelling still resolves to a stored reference",
  byId.length === 1 && byId[0].storedImageId === storedId && byId[0].role === undefined,
);
check(
  "a bare string stays an inline data-url payload",
  internals.normalizeImages(["data:image/png;base64,QUJD"])[0]?.mimeType === "image/png",
);
check(
  "an unusable image entry is dropped rather than failing the request",
  internals.normalizeImages([{ role: "annotated" }, null, 42]).length === 0,
);
check(
  "a stored id whose file is gone is skipped, not fatal",
  (await internals.resolveImages([{ storedImageId: storedId }], process.cwd())).length === 0,
);

/* -------------------------------------------------- multi-page diary (seq) */
check(
  "an entry written before pagination is page 1",
  internals.entrySeq({}) === 1 && internals.entrySeq({ seq: 0 }) === 1 && internals.entrySeq({ seq: "2" }) === 2,
);
check(
  "a page number off the wire defaults to 1 when absent or unusable",
  internals.parseSeq({ seq: 4 }) === 4 && internals.parseSeq({}) === 1 && internals.parseSeq({ seq: -2 }) === 1,
);
check(
  "page 1 needs no predecessor",
  (() => {
    try {
      internals.assertPageOrder({ diary: [] }, "2026-01-01", 1);
      return true;
    } catch {
      return false;
    }
  })(),
);
check(
  "page 2 is allowed once page 1 exists (even an entry with no seq)",
  (() => {
    try {
      internals.assertPageOrder({ diary: [{ date: "2026-01-01" }] }, "2026-01-01", 2);
      return true;
    } catch {
      return false;
    }
  })(),
);
const pageHole = (() => {
  try {
    internals.assertPageOrder({ diary: [{ date: "2026-01-01" }] }, "2026-01-01", 3);
    return "no-throw";
  } catch (error) {
    return error.code;
  }
})();
check("page 3 is refused while page 2 is missing", pageHole === "page-order", pageHole);
check(
  "a page number from ANOTHER date does not satisfy the predecessor rule",
  (() => {
    try {
      internals.assertPageOrder({ diary: [{ date: "2026-01-02" }] }, "2026-01-01", 2);
      return "no-throw";
    } catch (error) {
      return error.code;
    }
  })() === "page-order",
);

/* ----------------------------------------------------- settings and secrets */
const merged = internals.mergeSettings(
  { activeProvider: "glm", credentials: { glm: { apiKey: "stored" } }, prompts: { study: "我的提示词" } },
  { glm: { apiKey: "seeded" } },
);
check("stored credentials win over seeded", merged.credentials.glm.apiKey === "stored");
check(
  "a seeded credential fills a slot the store never had",
  internals.mergeSettings({ credentials: {} }, { glm: { apiKey: "seeded" } }).credentials.glm.apiKey === "seeded",
);
check("a stored prompt overrides the shipped default", merged.prompts.study === "我的提示词");
check("an untouched prompt keeps the shipped default", merged.prompts.normalize === llm.DEFAULT_PROMPTS.normalize);

const publicView = internals.publicSettings(merged, registry);
check("public settings never expose an apiKey", JSON.stringify(publicView).includes("stored") === false);
check("public settings still report configuration", publicView.credentials.glm.configured === true);
check(
  "public settings expose all four editable prompts",
  ["pageText", "pageWords", "collocations", "normalize"].every((key) => typeof publicView.prompts?.[key] === "string"),
);
check(
  "the settings screen can offer 恢复默认 for each prompt",
  ["pageText", "pageWords", "collocations", "normalize"].every((key) => typeof publicView.defaultPrompts?.[key] === "string"),
);
check(
  "public settings never advertise the mock double",
  publicView.availableProviders.every((entry) => entry.id !== "mock"),
);

/* ------------------------------------------- JSON extraction robustness */
check("extractJson parses bare JSON", llm.extractJson('{"a":1}').value?.a === 1);
check("extractJson unwraps a fenced block", llm.extractJson('```json\n{"a":2}\n```').value?.a === 2);
check("extractJson tolerates leading prose", llm.extractJson('Sure! Here you go:\n{"a":3}').value?.a === 3);
check("extractJson tolerates trailing prose", llm.extractJson('{"a":4}\nHope that helps!').value?.a === 4);
check("extractJson handles braces inside strings", llm.extractJson('{"a":"}{ not real }"}').value?.a === "}{ not real }");
check("extractJson reports failure instead of throwing", llm.extractJson("no json here").error !== null);
check("extractJson reports empty output", llm.extractJson("").error !== null);

/* --------------------------------------------------- ECDICT exchange parser */
check("parseExchange decodes past tense", JSON.stringify(host.parseExchange("p:went")) === JSON.stringify([{ label: "过去式", form: "went" }]));
const many = host.parseExchange("p:recorded/d:recorded/i:recording/3:records");
check("parseExchange decodes several forms", many.length === 4, JSON.stringify(many));
check("parseExchange drops the 0: lemma marker", host.parseExchange("0:record/p:recorded").length === 1);
check("parseExchange tolerates empty input", host.parseExchange("").length === 0);

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log("FAILED:");
  for (const entry of failed) console.log(`  - ${entry.label}${entry.detail ? ` (${entry.detail})` : ""}`);
  process.exitCode = 1;
}

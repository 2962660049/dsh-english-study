/**
 * 英语学习小助手 — DSH host half.
 *
 * Responsibilities (all browser-facing; this plugin registers no model tools):
 *   1. Own the HTTP surface: a JSON API plus the static SPA, under one route base.
 *   2. Own durable storage: atomic JSON documents under a configurable data root.
 *   3. Own secret material: provider API keys never leave the host. The browser
 *      only ever learns whether a provider is configured, never the key itself.
 *   4. Own the LLM pipeline: correction (step 1) then translation (step 2), plus
 *      per-word enrichment, all through the pluggable adapter registry.
 *
 * Route layout under `routeBase` (default `/english-study`):
 *   <base>/                 the SPA (static files from web/)
 *   <base>/api/...          JSON API; the API prefix is longer than the SPA
 *                           prefix, so it wins under longest-prefix routing.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { JsonStore } from "./store.js";
import {
  DEFAULT_PROMPTS,
  LlmError,
  TASK_MARKERS,
  buildLexemeMessages,
  buildNormalizeMessages,
  buildStudyCollocationsMessages,
  buildStudyTextMessages,
  buildStudyWordsMessages,
  createDefaultRegistry,
  extractJson,
  imagePartFromBase64,
  MAX_IMAGE_BYTES,
  numberSourceLines,
  splitSentences,
  splitSourceLines,
  stripLineLabels,
} from "./llm.js";

export const name = "dsh-english-study";
/** The only host service this plugin needs. */
export const inject = ["webServer"];

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const DEFAULT_CONFIG = {
  /** Data root. Defaults to <workspace>/data so user data stays out of the code package. */
  dataDir: resolve(PLUGIN_ROOT, "..", "..", "data"),
  /** Static assets shipped with the plugin. */
  webDir: join(PLUGIN_ROOT, "web"),
  routeBase: "/english-study",
  /** Independent LLM timeout (the reliability spec requires its own budget). */
  llmTimeoutMs: 120_000,
  requestTimeoutMs: 30_000,
  /** 智谱 GLM-4V-Flash — free vision. Key is free from https://bigmodel.cn */
  glmApiKey: "",
  glmModel: "",
  glmBaseUrl: "",
};

const JSON_BODY_LIMIT = 12 * 1024 * 1024;

/* ------------------------------------------------------------------ utils */

function logWarn(ctx, message, error) {
  const detail = error instanceof Error ? error.message : String(error ?? "");
  const line = `english-study: ${message}${detail.length > 0 ? ` — ${detail}` : ""}`;
  if (typeof ctx?.logger?.warn === "function") ctx.logger.warn(line);
  else console.warn(line);
}

function logInfo(ctx, message) {
  const line = `english-study: ${message}`;
  if (typeof ctx?.logger?.info === "function") ctx.logger.info(line);
  else console.log(line);
}

/** Register with the webserver and, when available, tie disposal to the fiber. */
function own(ctx, disposer, label) {
  if (typeof ctx.effect === "function") {
    ctx.effect(() => disposer, label);
  }
  return disposer;
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendError(res, status, code, message, detail) {
  sendJson(res, status, { ok: false, error: { code, message, detail: detail ?? null } });
}

/** Read and parse a JSON request body with a hard size limit. */
function readJsonBody(req, limit = JSON_BODY_LIMIT) {
  return new Promise((resolvePromise, rejectPromise) => {
    const declared = Number(req.headers["content-length"] ?? Number.NaN);
    if (Number.isFinite(declared) && declared > limit) {
      rejectPromise(Object.assign(new Error("请求体过大"), { status: 413, code: "too-large" }));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectPromise(Object.assign(new Error("请求体过大"), { status: 413, code: "too-large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", (error) => rejectPromise(error));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) {
        resolvePromise({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          rejectPromise(Object.assign(new Error("请求体必须是 JSON 对象"), { status: 400, code: "bad-json" }));
          return;
        }
        resolvePromise(parsed);
      } catch (error) {
        rejectPromise(
          Object.assign(new Error(`JSON 解析失败：${error.message}`), { status: 400, code: "bad-json" }),
        );
      }
    });
  });
}

/** Only accept the plugin's own prefix routes from a trusted, same-origin shape. */
function pathWithin(baseDir, relative) {
  const cleaned = decodeURIComponent(relative).replace(/^\/+/, "");
  const target = resolve(baseDir, normalize(cleaned));
  const root = resolve(baseDir);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

function nowIso() {
  return new Date().toISOString();
}

/* ------------------------------------------------------- settings & secrets */

/**
 * Seed credentials from (in ascending priority):
 *   1. the persisted store (what the user typed in the UI)
 *   2. plugin config from cordis.patch.yml / profile overrides
 *   3. process environment
 *
 * There is exactly one provider, 智谱 GLM-4V-Flash, and its key is free, so the
 * only secrets this app ever handles are GLM keys.
 */
async function seedCredentials(ctx, config) {
  const credentials = {};
  const env = process.env;

  const glmFromEnv = env.GLM_API_KEY ?? env.ZHIPU_API_KEY ?? env.ZHIPUAI_API_KEY ?? "";

  const glm = config.glmApiKey || glmFromEnv;
  if (glm.length > 0) {
    credentials.glm = {
      apiKey: glm,
      ...(config.glmModel ? { model: config.glmModel } : {}),
      ...(config.glmBaseUrl ? { baseUrl: config.glmBaseUrl } : {}),
    };
  }
  return credentials;
}

const DEFAULT_SETTINGS = {
  // The only provider. OCR + translation run on 智谱 GLM-4V-Flash, which is free;
  // without a key the UI says so plainly instead of silently degrading.
  activeProvider: "glm",
  providers: {},
  credentials: {},
  // The user's own prompts, editable in 设置. Defaults live in lib/llm.js so the
  // settings screen can always offer 「恢复默认」.
  prompts: { ...DEFAULT_PROMPTS },
  tts: { lang: "en-US", rate: 0.9, pitch: 1 },
  review: { intervalsMinutes: [5, 30, 720, 1440, 2880, 5760, 10080, 21600, 43200] },
};

/**
 * Merge persisted settings over defaults, then over seeded credentials.
 * `stored` wins for anything the user explicitly saved.
 */
function mergeSettings(stored, seeded) {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(stored ?? {}),
    providers: { ...DEFAULT_SETTINGS.providers, ...(stored?.providers ?? {}) },
    credentials: { ...seeded, ...(stored?.credentials ?? {}) },
    prompts: { ...DEFAULT_SETTINGS.prompts, ...(stored?.prompts ?? {}) },
    tts: { ...DEFAULT_SETTINGS.tts, ...(stored?.tts ?? {}) },
    review: { ...DEFAULT_SETTINGS.review, ...(stored?.review ?? {}) },
  };
  // An explicitly emptied key must not resurrect the seeded one.
  for (const id of Object.keys(seeded)) {
    if (stored?.credentials?.[id]?.cleared === true) delete merged.credentials[id];
  }
  return merged;
}

/**
 * Strip secrets: the browser learns configuration state, never key material.
 * Adapters flagged `hidden` (the offline test double) are filtered out here, so
 * they can never surface as a choice in the UI.
 */
function publicSettings(settings, registry) {
  const credentials = {};
  for (const [id, value] of Object.entries(settings.credentials ?? {})) {
    credentials[id] = {
      configured: Boolean(value?.apiKey),
      model: value?.model ?? null,
      baseUrl: value?.baseUrl ?? null,
      source: value?.source ?? null,
    };
  }
  return {
    activeProvider: settings.activeProvider,
    providers: settings.providers,
    credentials,
    prompts: settings.prompts,
    // The shipped wording, so 设置 can offer 「恢复默认」 without hard-coding the
    // prompt in the browser (it would drift from the host's copy).
    defaultPrompts: DEFAULT_PROMPTS,
    tts: settings.tts,
    review: settings.review,
    availableProviders: registry.describe(settings).filter((entry) => entry.hidden !== true),
  };
}

/* --------------------------------------------------------------- the plugin */

/**
 * Small dependency-free dictionary over an optional ECDICT-style CSV/TSV.
 * ECDICT (MIT, skywind3000/ECDICT) is the single best offline source for lemma,
 * Chinese gloss, IPA and inflections. It is OPTIONAL: when the file is absent the
 * app falls back to LLM enrichment, so nothing breaks without the download.
 */
class LocalDictionary {
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {Map<string, object> | null} */
    this.index = null;
    this.state = "unloaded";
    this.size = 0;
    this.bytes = 0;
    this.loadedAt = 0;
    this.lastUsedAt = 0;
  }

  /**
   * Cheap existence check that never parses the CSV, so `/health` can report
   * whether the dictionary is installed without paying for the index.
   */
  async probe() {
    try {
      const info = await stat(this.filePath);
      if (!info.isFile()) {
        this.state = "absent";
        return false;
      }
      this.bytes = info.size;
      return true;
    } catch {
      this.state = "absent";
      return false;
    }
  }

  /**
   * ECDICT holds ~770k rows; the parsed index costs roughly 200 MB of heap. Most
   * sessions never look a word up, so the index is built on the first lookup
   * rather than at startup, and released again after an idle period.
   */
  async ensureLoaded() {
    if (this.state === "ready" || this.state === "loading") return this.state;
    if (!(await this.probe())) return this.state;
    this.state = "loading";
    try {
      const text = await readFile(this.filePath, "utf8");
      this.index = parseEcdictCsv(text);
      this.size = this.index.size;
      this.state = "ready";
      this.loadedAt = Date.now();
      this.lastUsedAt = Date.now();
    } catch {
      this.index = null;
      this.state = "absent";
    }
    return this.state;
  }

  /** Drop the index to give the memory back; the next lookup rebuilds it. */
  release(reason = "idle") {
    if (this.index === null) return false;
    this.index = null;
    this.size = 0;
    this.state = "unloaded";
    this.releaseReason = reason;
    return true;
  }

  /** @returns {object | null} */
  lookup(word) {
    if (this.index === null) return null;
    const key = String(word ?? "").trim().toLowerCase();
    if (key.length === 0) return null;
    this.lastUsedAt = Date.now();
    return this.index.get(key) ?? null;
  }
}

/** How long the parsed dictionary may sit unused before its memory is released. */
const DICTIONARY_IDLE_RELEASE_MS = 10 * 60 * 1000;

/**
 * Parse a CSV where the first row is a header. Quoted fields may contain commas
 * and doubled quotes, which is exactly the ECDICT `translation` / `definition`
 * shape, so a naive split is not good enough.
 */
function parseEcdictCsv(text, limit = 1_000_000) {
  const index = new Map();
  let row = [];
  let field = "";
  let inQuotes = false;
  let header = null;
  let count = 0;
  const push = () => {
    row.push(field);
    field = "";
  };
  const commitRow = () => {
    if (header === null) {
      header = row.map((cell) => cell.trim().toLowerCase());
    } else if (row.length > 1) {
      const record = row.slice();
      const word = (record[header.indexOf("word")] ?? "").trim();
      if (word.length > 0) {
        const get = (column) => {
          const position = header.indexOf(column);
          return position === -1 ? "" : (record[position] ?? "").trim();
        };
        index.set(word.toLowerCase(), {
          word,
          phonetic: get("phonetic"),
          translation: get("translation"),
          pos: get("pos"),
          exchange: get("exchange"),
          collins: get("collins"),
          oxford: get("oxford"),
          tag: get("tag"),
          bnc: get("bnc"),
          frq: get("frq"),
        });
        count += 1;
      }
    }
    row = [];
  };
  for (let position = 0; position < text.length; position += 1) {
    const char = text[position];
    if (inQuotes) {
      if (char === '"') {
        if (text[position + 1] === '"') {
          field += '"';
          position += 1;
        } else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ",") push();
    else if (char === "\n") {
      push();
      commitRow();
      if (count >= limit) break;
    } else if (char !== "\r") field += char;
  }
  if (field.length > 0 || row.length > 0) {
    push();
    commitRow();
  }
  return index;
}

/** ECDICT often folds the part of speech into the translation ("a. 心神不安的"). */
function posFromTranslation(translation) {
  const match = /^\s*((?:n|vt|vi|v|a|adj|adv|ad|prep|conj|pron|num|art|int|aux|abbr|pl)\.)/i.exec(
    String(translation ?? ""),
  );
  return match === null ? "" : match[1];
}

/**
 * ECDICT's `0:` code names the lemma an inflected headword belongs to.
 *
 * This is why the model is never asked for a lemma any more: the dictionary ships
 * its own — `postponed` carries `0:postpone`, `felt` carries `0:feel`, `written`
 * carries `0:write` — so the surface form alone is enough to reach the full entry.
 */
export function lemmaFromExchange(exchange) {
  if (typeof exchange !== "string") return "";
  for (const pair of exchange.split("/")) {
    const [type, form] = pair.split(":");
    if (type === "0" && typeof form === "string" && form.trim().length > 0) return form.trim();
  }
  return "";
}

/**
 * Describe each circled word from a LOCAL dictionary lookup.
 *
 * The model is asked for the transcription, the ringed words and their fixed
 * phrases — the three things a dictionary cannot supply — and nothing else. Every
 * descriptive field (lemma, part of speech, Chinese gloss, phonetics, inflected
 * forms) is filled here, instantly, offline, and more reliably than the model did
 * it: measured against a real page, the model dropped circled words and returned
 * empty inflection objects whenever it also had to describe them.
 *
 * @param {object} data the shaped study payload
 * @param {(key: string) => object | null} lookup
 */
export function enrichWordsFromDictionary(data, lookup) {
  if (data === null || typeof data !== "object" || !Array.isArray(data.words) || data.words.length === 0) {
    return data;
  }
  return {
    ...data,
    words: data.words.map((word) => {
      const surface = String(word.word ?? word.lemma ?? "").trim();
      if (surface.length === 0) return word;
      // The surface form may be its own headword ("postponed") — ECDICT lists those
      // too, and their exchange field points at the base form.
      const direct = lookup(surface) ?? lookup(surface.toLowerCase()) ?? null;
      const lemma = lemmaFromExchange(direct?.exchange) || word.lemma || direct?.word || surface;
      // The lemma's own entry carries the complete inflection set; prefer it, but
      // fall back to the inflected entry when the lemma row is missing.
      const canonical = lookup(lemma) ?? direct;
      if (canonical === null || canonical === undefined) {
        return { ...word, word: surface, lemma: lemma || surface };
      }
      const forms = parseExchange(canonical.exchange);
      const base = canonical.word || lemma || surface;
      const inflections = forms.some((item) => item.label === "原形")
        ? forms
        : [{ label: "原形", form: base }, ...forms];
      return {
        ...word,
        word: surface,
        lemma: base,
        phonetic: canonical.phonetic || direct?.phonetic || word.phonetic || "",
        partOfSpeech: canonical.pos || word.partOfSpeech || posFromTranslation(canonical.translation),
        glossZh: canonical.translation || word.glossZh || "",
        inflections: inflections.length > 0 ? inflections : word.inflections,
        source: "ecdict",
      };
    }),
  };
}

/** ECDICT's `exchange` field encodes inflections as `type:form/type:form`. */
const EXCHANGE_LABELS = {
  p: "过去式",
  d: "过去分词",
  i: "现在分词",
  "3": "第三人称单数",
  r: "比较级",
  t: "最高级",
  s: "复数",
  "0": "原形",
  "1": "原形变化",
};

export function parseExchange(exchange) {
  if (typeof exchange !== "string" || exchange.trim().length === 0) return [];
  return exchange
    .split("/")
    .map((pair) => {
      const [type, form] = pair.split(":");
      if (type === undefined || form === undefined || form.length === 0) return null;
      if (type === "0" || type === "1") return null;
      return { label: EXCHANGE_LABELS[type] ?? type, form };
    })
    .filter((entry) => entry !== null);
}

/**
 * Read the ringed words out of a bare line list.
 *
 * The contract asks for one word per line and nothing else, because that is what
 * measured 17/17 on a real page (a JSON array of word objects measured 13-16/17 and
 * cost ten times the tokens). Models drift, though, so a JSON array, a numbered
 * list, bullets and "word -> lemma" lines are all accepted.
 */
export function parseWordList(raw) {
  const source = String(raw ?? "").trim();
  if (source.length === 0) return [];
  const words = [];
  const seen = new Set();
  const push = (value) => {
    const word = String(value ?? "")
      .trim()
      .replace(/^[^A-Za-z]+|[^A-Za-z'-]+$/g, "")
      .toLowerCase();
    if (word.length === 0 || seen.has(word)) return;
    seen.add(word);
    words.push({ word });
  };

  const json = extractJson(source);
  if (json.error === null) {
    const value = Array.isArray(json.value) ? json.value : json.value?.words;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") push(entry);
        else if (entry !== null && typeof entry === "object") push(entry.word ?? entry.text ?? entry.form);
      }
      if (words.length > 0) return words;
    }
  }

  for (const line of source.split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*(?:[-*•·]|\d+[.)、])\s*/, "").trim();
    if (cleaned.length === 0 || /^none$/i.test(cleaned)) continue;
    if (cleaned.includes(":")) continue;
    const tokens = cleaned.split(/\s+/);
    // "word" or "word -> lemma" only; a sentence is not a word list.
    if (tokens.length > 3) continue;
    push(tokens[0]);
  }
  return words;
}

/**
 * Union several word-list passes into one reading-ordered list.
 *
 * A word survives if ANY pass saw it. Order comes from the page itself (the
 * position of the word's first occurrence in `text`), because that is the only
 * ordering the learner can check against the photograph; words that do not occur
 * in the extracted text keep their pass order and are placed at the end.
 */
export function mergeWordPasses(passes, text = "") {
  const haystack = String(text ?? "").toLowerCase();
  const merged = new Map();
  for (const pass of passes ?? []) {
    for (const entry of pass ?? []) {
      const word = String(entry?.word ?? "").trim().toLowerCase();
      if (word.length === 0 || merged.has(word)) continue;
      merged.set(word, { word });
    }
  }
  const position = (word) => {
    // Word boundaries matter: a naive substring search places "till" before
    // "uneasy", because "still" occurs on the first line.
    const exact = new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").exec(haystack);
    if (exact) return exact.index;
    // An inflected listing ("postponed") can still be found by its stem.
    const stem = word.slice(0, Math.max(4, word.length - 2));
    if (stem.length >= 4) {
      const loose = new RegExp(`\\b${escapeRegExp(stem)}`, "i").exec(haystack);
      if (loose) return loose.index;
    }
    return -1;
  };
  return [...merged.values()].sort((a, b) => {
    const left = position(a.word);
    const right = position(b.word);
    if (left < 0 && right < 0) return 0;
    if (left < 0) return 1;
    if (right < 0) return -1;
    return left - right;
  });
}

/**
 * Read `word = phrase` lines into a lemma → phrases map.
 *
 * Separators vary by run ("=", "-", ":", "|"), so all of them are accepted. A
 * phrase longer than five words is context the model quoted back rather than a
 * collocation, and is dropped.
 */
export function parseCollocationList(raw) {
  const map = new Map();
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*(?:[-*•·]|\d+[.)、])\s*/, "").trim();
    if (cleaned.length === 0) continue;
    const match = /^([A-Za-z][A-Za-z'-]*)\s*(?:=|:|＝|\||—|–|-|->|→|至)\s*(.+)$/.exec(cleaned);
    if (match === null) continue;
    const key = match[1].toLowerCase();
    const phrase = match[2]
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .trim();
    if (phrase.length === 0 || /^none$/i.test(phrase)) continue;
    if (phrase.split(/\s+/).length > 5) continue;
    const bucket = map.get(key) ?? [];
    if (!bucket.includes(phrase)) bucket.push(phrase);
    map.set(key, bucket);
  }
  return map;
}

/**
 * Run the three-call diary read and assemble one study payload.
 *
 * Kept as a plain function taking its dependencies explicitly so the offline
 * harness can drive it with the mock registry, and so each call still goes through
 * `registry.chat` — which is what gives every call the R2 retry ladder, the R5
 * single-flight queue, the per-attempt timeout and the R6 offline failure without
 * a second implementation of any of them.
 *
 * @param {{ registry: object, settings: object, images: unknown[], prompts?: object, timeoutMs?: number }} request
 */
export async function runStudyPage({ registry, settings, images = [], prompts, timeoutMs }) {
  const calls = {};
  const prompt = prompts ?? settings?.prompts ?? {};

  // 1/3 — the page itself. Measured: 219 completion tokens, transcribed verbatim.
  const pageResponse = await registry.chat(settings, {
    messages: buildStudyTextMessages({ images, pageTextPrompt: prompt.pageText }),
    timeoutMs,
  });
  calls.text = {
    adapter: pageResponse.adapter,
    elapsedMs: pageResponse.elapsedMs,
    usage: pageResponse.usage,
  };
  const pageJson = extractJson(pageResponse.text);
  // A long page can still be cut off at the 1024-token ceiling; salvage the text.
  const salvaged = pageJson.error === null ? null : salvageStudyPayload(pageResponse.text);
  const pageValue = pageJson.error === null ? pageJson.value : salvaged;
  let text = "";
  if (typeof pageValue === "string") text = pageValue;
  else if (pageValue !== null && typeof pageValue === "object") {
    text = pickKey(pageValue, ["text", "article", "english", "content", "page"]);
  }
  text = String(text ?? "").trim();
  if (text.length === 0) {
    return {
      degraded: true,
      parseError: pageJson.error ?? "未能从图片中提取英文",
      text: "",
      words: [],
      rawText: pageResponse.text,
      calls,
    };
  }

  // 2/3 — which words are ringed. Two independent passes, unioned.
  //
  // Why two: the plain word list is accurate but not perfectly reproducible — over
  // six live runs on tools/fixtures/handwriting-01.png it returned 17/17 four times
  // and 15/17 twice, and the two misses were ALWAYS the same pair of words on the
  // same line, replaced by one plausible-but-unringed word from elsewhere on the
  // page. Recall is what matters here (a ringed word the learner never sees is a
  // silent failure; an extra word is visible and deleteable), so a second cheap
  // pass — measured at 44 completion tokens and ~2.4 s — is unioned in. If the
  // second pass fails outright the first still stands.
  let words = [];
  const wordPasses = [];
  let partial = pageJson.error !== null;
  let parseError = partial ? pageJson.error : null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const wordsResponse = await registry.chat(settings, {
        messages: buildStudyWordsMessages({ images, pageWordsPrompt: prompt.pageWords }),
        timeoutMs,
      });
      calls[attempt === 0 ? "words" : "wordsAgain"] = {
        adapter: wordsResponse.adapter,
        elapsedMs: wordsResponse.elapsedMs,
        usage: wordsResponse.usage,
      };
      wordPasses.push(parseWordList(wordsResponse.text));
    } catch (error) {
      const message = error?.message ?? String(error);
      calls[attempt === 0 ? "words" : "wordsAgain"] = { error: message };
      // A first-pass failure leaves nothing to work with, so it is a partial read;
      // a failed second pass just means we keep the first pass's list.
      if (attempt === 0) {
        partial = true;
        parseError = message;
      }
    }
  }
  if (wordPasses.length > 0) {
    words = mergeWordPasses(wordPasses, text).map((word) => ({
      word: word.word,
      lemma: "",
      collocations: [],
    }));
  }

  // 3/3 — the fixed phrases, the one thing only the model can supply. Text only,
  // so it is the cheapest call of the three and its failure is not fatal.
  let collocationsFailed = false;
  if (words.length > 0) {
    try {
      const collocationResponse = await registry.chat(settings, {
        messages: buildStudyCollocationsMessages({ text, words, collocationsPrompt: prompt.collocations }),
        timeoutMs,
      });
      calls.collocations = {
        adapter: collocationResponse.adapter,
        elapsedMs: collocationResponse.elapsedMs,
        usage: collocationResponse.usage,
      };
      const map = parseCollocationList(collocationResponse.text);
      words = words.map((word) => ({ ...word, collocations: map.get(word.word.toLowerCase()) ?? [] }));
    } catch {
      collocationsFailed = true;
      calls.collocations = { error: "collocation pass failed" };
    }
  }

  const sentences = normalizeStudySentences(null, text);
  return {
    degraded: false,
    partial,
    complete: !partial,
    parseError,
    collocationsFailed,
    text,
    sentences,
    // The containing sentence is located by the HOST, not requested from the model:
    // echoing the same sentence once per word was what consumed the output budget.
    words: words.map((word) => ({ ...word, sentence: sentenceForWord(word, sentences) })),
    rawText: pageResponse.text,
    calls,
  };
}

/**
 * @param {object} ctx cordis context
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) };
  const routeBase = config.routeBase.replace(/\/+$/, "");
  const registry = createDefaultRegistry();

  const store = new JsonStore(join(config.dataDir, "store.json"), {
    onError: (error) => logWarn(ctx, "存储写入失败", error),
  });

  const dictionary = new LocalDictionary(join(config.dataDir, "dictionary", "ecdict.csv"));
  const imagesDir = join(config.dataDir, "images");

  /** Guard so `apply` stays idempotent if cordis re-runs it. */
  let cleanedUp = false;

  /**
   * Fill each circled word's lemma, part of speech, gloss and inflections from
   * the LOCAL ECDICT dictionary.
   *
   * Why the model is not asked for these: GLM-4V-Flash caps a reply at 1024
   * tokens (code 1210 above that), and a page with seventeen circled words
   * cannot hold the page text AND seventeen fully inflected entries inside that
   * budget. Measured: the model consumed exactly 1024 output tokens and
   * silently dropped words to fit, and under that pressure it degenerated to
   * emitting form labels with no forms at all. ECDICT has the real forms, costs
   * nothing, works offline, and is already the first source for /llm/lexeme —
   * so the model keeps only what it alone knows: which words were circled, and
   * the collocations those words form in the text.
   */
  async function enrichStudyWords(data) {
    if (data === null || typeof data !== "object" || !Array.isArray(data.words) || data.words.length === 0) {
      return data;
    }
    const stateBefore = dictionary.state;
    await dictionary.ensureLoaded();
    if (stateBefore !== "ready" && dictionary.state === "ready") {
      logInfo(ctx, `本地词典已载入（${dictionary.size} 词条）`);
    }
    return enrichWordsFromDictionary(data, (key) => dictionary.lookup(key));
  }

  /* ------------------------------------------------------------- API routes */

  /** Resolve merged settings (persisted over seeded). */
  async function currentSettings() {
    const data = await store.load();
    return mergeSettings(data.settings, seedCache);
  }

  /** Seed once; refreshed if the config object changes. */
  let seedCache = {};
  const seedReady = seedCredentials(ctx, config).then(
    (seeded) => {
      seedCache = seeded;
      return seeded;
    },
    (error) => {
      logWarn(ctx, "读取凭据失败", error);
      seedCache = {};
      return {};
    },
  );

  /** Wrap an API handler with uniform error handling and a request-scoped timeout. */
  function handler(fn) {
    // Every argument is forwarded: a parameterised route still needs its `params`
    // object and the parsed `query`, and dropping them showed up as a live 500 on
    // `/vocab/export` (reading 'get' of undefined) and `/images/:id`.
    return async (req, res, ...rest) => {
      res.setHeader("cache-control", "no-store");
      // The reliability spec requires a server-side fallback: never let a handler
      // hold a socket open forever.
      const guard = setTimeout(() => {
        if (!res.writableEnded) {
          sendError(res, 504, "timeout", "服务端处理超时");
        }
      }, Math.max(config.requestTimeoutMs, config.llmTimeoutMs + 10_000));
      try {
        await fn(req, res, ...rest);
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500;
        const code = typeof error?.code === "string" ? error.code : "internal";
        if (status >= 500) logWarn(ctx, `${req.method} ${req.url} 失败`, error);
        sendError(res, status, code, error?.message ?? "内部错误", error?.detail ?? null);
      } finally {
        clearTimeout(guard);
      }
    };
  }

  /**
   * Every route that can carry a photo needs the same vision check. Naming the
   * capable providers (instead of hard-coding a brand) keeps the message useful
   * even if the provider list ever changes.
   */
  function assertVision(settings) {
    if (providerSupportsVision(settings, registry)) return;
    const visionIds = registry
      .describe(settings)
      .filter((entry) => entry.capabilities?.vision === true)
      .map((entry) => entry.label)
      .join(" / ");
    throw new LlmError(
      `当前模型（${settings.activeProvider}）不支持图片。` +
        (visionIds.length > 0
          ? `请在设置里改用「${visionIds}」并填入免费 API Key，或把文字粘贴进来。`
          : "请把文字粘贴进来。"),
      { code: "config" },
    );
  }

  /** Route table for the JSON API. */
  const routes = {
    "GET /health": handler(async (req, res) => {
      await seedReady;
      const settings = await currentSettings();
      sendJson(res, 200, {
        ok: true,
        plugin: name,
        version: "0.1.0",
        time: nowIso(),
        routeBase,
        dataDir: config.dataDir,
        dictionary: {
          state: dictionary.state,
          size: dictionary.size,
          bytes: dictionary.bytes,
          file: dictionary.filePath.replace(/^.*[\\/]/, ""),
        },
        activeProvider: settings.activeProvider,
        providers: registry.describe(settings).filter((entry) => entry.hidden !== true),
      });
    }),

    "GET /state": handler(async (req, res) => {
      await seedReady;
      const settings = await currentSettings();
      const data = await store.snapshot();
      sendJson(res, 200, {
        ok: true,
        revision: data.updatedAt,
        diary: data.diary,
        vocabEvents: data.vocabEvents,
        vocabWords: data.vocabWords,
        settings: publicSettings(settings, registry),
      });
    }),

    "GET /settings": handler(async (req, res) => {
      await seedReady;
      const settings = await currentSettings();
      sendJson(res, 200, { ok: true, settings: publicSettings(settings, registry) });
    }),

    "POST /settings": handler(async (req, res) => {
      await seedReady;
      const body = await readJsonBody(req, 256 * 1024);
      const patch = body.settings ?? {};
      const outcome = await store.mutateIdempotent(requestIdOf(req, body), (data) => {
        const next = { ...(data.settings ?? {}) };
        if (typeof patch.activeProvider === "string") next.activeProvider = patch.activeProvider;
        if (patch.tts !== undefined) next.tts = { ...(next.tts ?? {}), ...patch.tts };
        if (patch.review !== undefined) next.review = { ...(next.review ?? {}), ...patch.review };
        if (patch.prompts !== undefined) {
          next.prompts = { ...DEFAULT_PROMPTS, ...(next.prompts ?? {}), ...patch.prompts };
        }
        if (patch.providers !== undefined) {
          next.providers = { ...(next.providers ?? {}) };
          for (const [id, value] of Object.entries(patch.providers)) {
            next.providers[id] = { ...(next.providers[id] ?? {}), ...value };
          }
        }
        if (patch.credentials !== undefined) {
          next.credentials = { ...(next.credentials ?? {}) };
          for (const [id, value] of Object.entries(patch.credentials)) {
            const previous = next.credentials[id] ?? {};
            const merged = { ...previous };
            if (typeof value?.apiKey === "string" && value.apiKey.trim().length > 0) {
              merged.apiKey = value.apiKey.trim();
            }
            if (value?.cleared === true) {
              delete merged.apiKey;
              merged.cleared = true;
            } else if (value?.cleared === false) {
              delete merged.cleared;
            }
            if (typeof value?.model === "string") merged.model = value.model;
            if (typeof value?.baseUrl === "string") merged.baseUrl = value.baseUrl;
            next.credentials[id] = merged;
          }
        }
        data.settings = next;
        return true;
      });
      const settings = await currentSettings();
      sendJson(res, 200, {
        ok: true,
        replayed: outcome.replayed,
        settings: publicSettings(settings, registry),
      });
    }),

    /* ---------------- images: uploaded once, served back by id ---------------- */

    "POST /images": handler(async (req, res) => {
      const body = await readJsonBody(req);
      const base64 = typeof body.base64 === "string" ? body.base64.replace(/^data:[^;]+;base64,/, "") : "";
      if (base64.length === 0) throw Object.assign(new Error("缺少 base64 图像数据"), { status: 400, code: "bad-request" });
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length === 0) throw Object.assign(new Error("图像数据为空"), { status: 400, code: "bad-request" });
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw Object.assign(new Error(`图像过大（${bytes.length} 字节，上限 ${MAX_IMAGE_BYTES}）`), {
          status: 413,
          code: "too-large",
        });
      }
      const mime = typeof body.mimeType === "string" && MIME_TYPES[`.${body.mimeType.split("/")[1]}`]
        ? body.mimeType
        : "image/jpeg";
      const extension = mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : ".jpg";
      const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
      const id = `${digest}${extension}`;
      await mkdir(imagesDir, { recursive: true });
      const target = join(imagesDir, id);
      // Content-addressed: writing the same photo twice is a no-op, which makes
      // the upload step naturally idempotent.
      try {
        await stat(target);
      } catch {
        await writeFile(target, bytes);
      }
      sendJson(res, 200, {
        ok: true,
        image: { id, url: `${routeBase}/api/images/${id}`, bytes: bytes.length, mimeType: mime },
      });
    }),

    "GET /images": handler(async (req, res, params) => {
      // The bare `/images` suffix lands here with `params = {}`, so the id is
      // validated rather than dereferenced: a missing image is a 404, not a 500.
      const id = params?.id;
      if (typeof id !== "string" || !/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(id)) {
        sendError(res, 404, "not-found", "图片不存在");
        return;
      }
      let bytes;
      try {
        bytes = await readFile(join(imagesDir, id));
      } catch {
        sendError(res, 404, "not-found", "图片不存在");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME_TYPES[extname(id)] ?? "application/octet-stream",
        "content-length": bytes.length,
        "cache-control": "public, max-age=31536000, immutable",
      });
      res.end(bytes);
    }),

    /* ----------------------------- LLM pipeline ------------------------------ */

    /**
     * Diary task. The page is ALREADY-translated English with the learner's own
     * ellipses around unknown words, so this is extraction + mark reading: no
     * correction, no rewriting, and — per the design — images only. Pasted text
     * belongs to 其它文本处理区, which owns translation and correction.
     */
    "POST /llm/study": handler(async (req, res) => {
      await seedReady;
      const body = await readJsonBody(req);
      const settings = await currentSettings();
      const images = await resolveImages(body.images, imagesDir);
      if (images.length === 0) {
        throw Object.assign(new Error("缺少要识别的手写图片"), { status: 400, code: "bad-request" });
      }
      assertVision(settings);
      const result = await runStudyPage({
        registry,
        settings,
        images: images.map((image) => imagePartFromBase64(image.base64, image.mimeType)),
        prompts: settings.prompts,
        timeoutMs: Number(body.timeoutMs) || config.llmTimeoutMs,
      });
      const shaped = studyEnvelope(result);
      // The model names the ringed words; the local dictionary describes them.
      if (shaped.degraded !== true) shaped.data = await enrichStudyWords(shaped.data);
      sendJson(res, 200, shaped);
    }),

    /**
     * Text-area task. Whatever went in — Chinese, English or mixed — ENGLISH must
     * come out, because the reader screen is English and has to be pronounceable.
     */
    "POST /llm/normalize": handler(async (req, res) => {
      await seedReady;
      const body = await readJsonBody(req);
      const text = String(body.text ?? "");
      const images = await resolveImages(body.images, imagesDir);
      if (text.trim().length === 0 && images.length === 0) {
        throw Object.assign(new Error("缺少要处理的文本或图片"), { status: 400, code: "bad-request" });
      }
      if (images.length > 0) {
        const settings = await currentSettings();
        assertVision(settings);
      }
      const settings = await currentSettings();
      const result = await runNormalize({
        registry,
        settings,
        text,
        images: images.map((image) => imagePartFromBase64(image.base64, image.mimeType)),
        timeoutMs: Number(body.timeoutMs) || config.llmTimeoutMs,
      });
      sendJson(res, 200, result);
    }),

    "POST /llm/lexeme": handler(async (req, res) => {
      await seedReady;
      const body = await readJsonBody(req);
      const word = String(body.word ?? "").trim();
      if (word.length === 0) {
        throw Object.assign(new Error("缺少单词"), { status: 400, code: "bad-request" });
      }
      // Local dictionary first: instant, offline, and higher quality than a model
      // for gloss/IPA/inflections. The LLM only fills the gaps it is good at.
      const stateBefore = dictionary.state;
      await dictionary.ensureLoaded();
      if (stateBefore !== "ready" && dictionary.state === "ready") {
        logInfo(ctx, `本地词典已载入（${dictionary.size} 词条，约 ${(dictionary.bytes / 1024 / 1024).toFixed(0)} MiB 文件）`);
      }
      const local = dictionary.lookup(word);
      if (local !== null && body.preferLocal !== false) {
        const inflections = parseExchange(local.exchange);
        if (inflections.length > 0 || local.phonetic.length > 0 || local.translation.length > 0) {
          sendJson(res, 200, {
            ok: true,
            source: "ecdict",
            degraded: false,
            word,
            data: {
              lemma: local.word,
              phonetic: local.phonetic,
              glossZh: local.translation,
              partOfSpeech: local.pos,
              inflections,
              examples: [],
              tags: local.tag,
              collins: local.collins,
              oxford: local.oxford,
            },
          });
          return;
        }
      }
      const settings = await currentSettings();
      const response = await registry.chat(settings, {
        messages: buildLexemeMessages({ word, sentence: body.sentence ?? "" }),
        timeoutMs: Number(body.timeoutMs) || config.llmTimeoutMs,
        json: true,
      });
      const shaped = shapeLlmResult(response, "lexeme");
      sendJson(res, 200, { ...shaped, word, source: "llm" });
    }),

    /* ------------------------------ vocabulary ------------------------------- */

    "POST /vocab/annotate": handler(async (req, res) => {
      const body = await readJsonBody(req);
      const word = String(body.word ?? "").trim();
      if (word.length === 0) throw Object.assign(new Error("缺少单词"), { status: 400, code: "bad-request" });
      const event = {
        id: randomUUID(),
        word,
        lemma: typeof body.lemma === "string" && body.lemma.trim().length > 0 ? body.lemma.trim() : word.toLowerCase(),
        glossZh: typeof body.glossZh === "string" ? body.glossZh : "",
        phonetic: typeof body.phonetic === "string" ? body.phonetic : "",
        partOfSpeech: typeof body.partOfSpeech === "string" ? body.partOfSpeech : "",
        inflections: Array.isArray(body.inflections) ? body.inflections : [],
        examples: Array.isArray(body.examples) ? body.examples : [],
        source: body.source === "diary" ? "diary" : "webtest",
        sourceRef: typeof body.sourceRef === "string" ? body.sourceRef : "",
        sentence: typeof body.sentence === "string" ? body.sentence : "",
        sentenceZh: typeof body.sentenceZh === "string" ? body.sentenceZh : "",
        status: "new",
        createdAt: nowIso(),
      };
      const outcome = await store.mutateIdempotent(requestIdOf(req, body), (data) => {
        data.vocabEvents.unshift(event);
        upsertWord(data, event);
        return event;
      });
      const data = await store.snapshot();
      sendJson(res, 200, {
        ok: true,
        replayed: outcome.replayed,
        event: outcome.result,
        vocabWords: data.vocabWords,
      });
    }),

    "POST /vocab/update": handler(async (req, res) => {
      const body = await readJsonBody(req);
      const id = String(body.id ?? "");
      const patch = body.patch ?? {};
      const outcome = await store.mutateIdempotent(requestIdOf(req, body), (data) => {
        const word = data.vocabWords.find((entry) => entry.id === id);
        if (word === undefined) {
          throw Object.assign(new Error(`未找到单词记录 ${id}`), { status: 404, code: "not-found" });
        }
        if (typeof patch.status === "string") word.status = patch.status;
        if (typeof patch.note === "string") word.note = patch.note;
        if (typeof patch.starred === "boolean") word.starred = patch.starred;
        if (typeof patch.lemma === "string" && patch.lemma.trim().length > 0) word.lemma = patch.lemma.trim();
        if (typeof patch.glossZh === "string") word.glossZh = patch.glossZh;
        if (typeof patch.phonetic === "string") word.phonetic = patch.phonetic;
        if (Array.isArray(patch.inflections)) word.inflections = patch.inflections;
        if (Array.isArray(patch.examples)) word.examples = patch.examples;
        if (patch.review !== undefined) {
          word.review = { ...(word.review ?? {}), ...patch.review };
        }
        word.updatedAt = nowIso();
        return word;
      });
      sendJson(res, 200, { ok: true, replayed: outcome.replayed, word: outcome.result });
    }),

    "POST /vocab/delete": handler(async (req, res) => {
      const body = await readJsonBody(req);
      const id = String(body.id ?? "");
      const outcome = await store.mutateIdempotent(requestIdOf(req, body), (data) => {
        const before = data.vocabWords.length;
        data.vocabWords = data.vocabWords.filter((entry) => entry.id !== id);
        if (data.vocabWords.length === before) {
          throw Object.assign(new Error(`未找到单词记录 ${id}`), { status: 404, code: "not-found" });
        }
        if (body.removeEvents === true) {
          data.vocabEvents = data.vocabEvents.filter((event) => event.lemma !== id);
        }
        return true;
      });
      sendJson(res, 200, { ok: true, replayed: outcome.replayed });
    }),

    "GET /vocab/export": handler(async (req, res, params, query) => {
      const format = query.get("format") ?? "csv";
      const data = await store.snapshot();
      const rows = data.vocabWords;
      if (format === "json") {
        sendJson(res, 200, { ok: true, words: rows, events: data.vocabEvents });
        return;
      }
      if (format === "anki") {
        const body = rows
          .map((word) => [word.lemma, buildAnkiBack(word)].join("\t"))
          .join("\n");
        res.writeHead(200, {
          "content-type": "text/tab-separated-values; charset=utf-8",
          "content-disposition": 'attachment; filename="english-study-anki.txt"',
        });
        res.end(`${body}\n`);
        return;
      }
      const header = ["lemma", "phonetic", "glossZh", "partOfSpeech", "inflections", "collocations", "status", "source", "sentence", "sentenceZh", "createdAt"];
      const lines = [header.join(",")];
      for (const word of rows) {
        lines.push(
          [
            word.lemma,
            word.phonetic,
            word.glossZh,
            word.partOfSpeech,
            (word.inflections ?? []).map((entry) => `${entry.label}:${entry.form}`).join(" "),
            (word.collocations ?? []).join(" / "),
            word.status,
            word.source,
            word.sentence ?? "",
            word.sentenceZh ?? "",
            word.createdAt ?? "",
          ]
            .map(csvCell)
            .join(","),
        );
      }
      // A BOM keeps Excel from mangling the Chinese columns.
      const payload = `\ufeff${lines.join("\r\n")}\r\n`;
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="english-study-vocab.csv"',
      });
      res.end(payload);
    }),

    /* -------------------------------- diary ---------------------------------- */

    "POST /diary": handler(async (req, res) => {
      const body = await readJsonBody(req);
      const date = String(body.date ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw Object.assign(new Error("date 必须是 YYYY-MM-DD"), { status: 400, code: "bad-request" });
      }
      const seq = parseSeq(body);
      const outcome = await store.mutateIdempotent(requestIdOf(req, body), (data) => {
        const existing = typeof body.id === "string" ? data.diary.find((entry) => entry.id === body.id) : undefined;
        if (existing !== undefined) {
          Object.assign(existing, {
            date,
            seq,
            title: body.title ?? existing.title,
            images: Array.isArray(body.images) ? body.images : existing.images,
            corrected: body.corrected ?? existing.corrected,
            corrections: Array.isArray(body.corrections) ? body.corrections : existing.corrections,
            sentences: Array.isArray(body.sentences) ? body.sentences : existing.sentences,
            words: Array.isArray(body.words) ? body.words : existing.words,
            source: body.source ?? existing.source,
            updatedAt: nowIso(),
          });
          return existing;
        }
        assertPageOrder(data, date, seq);
        const entry = {
          id: randomUUID(),
          date,
          seq,
          title: typeof body.title === "string" ? body.title : "",
          images: Array.isArray(body.images) ? body.images : [],
          corrected: typeof body.corrected === "string" ? body.corrected : "",
          corrections: Array.isArray(body.corrections) ? body.corrections : [],
          sentences: Array.isArray(body.sentences) ? body.sentences : [],
          words: Array.isArray(body.words) ? body.words : [],
          source: typeof body.source === "string" ? body.source : "diary",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        data.diary.push(entry);
        return entry;
      });
      sendJson(res, 200, { ok: true, replayed: outcome.replayed, entry: outcome.result });
    }),

    /**
     * The diary page's ONE-CLICK path: handwritten photo in, extracted English
     * article + the circled words + their vocabulary-bank entries out.
     *
     * The model call deliberately happens BEFORE the mutation: `mutateIdempotent`
     * serialises the whole store and must never hold a 15–60 s provider request
     * inside that lock. A double-click therefore costs at most one extra model
     * call, while the mutation itself still applies exactly once per requestId.
     */
    "POST /diary/import": handler(async (req, res) => {
      await seedReady;
      const body = await readJsonBody(req);
      const settings = await currentSettings();
      const pad = (value) => String(value).padStart(2, "0");
      const today = new Date();
      const requested = String(body.date ?? "").trim();
      const date = requested.length > 0
        ? requested
        : `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw Object.assign(new Error("date 必须是 YYYY-MM-DD"), { status: 400, code: "bad-request" });
      }
      const seq = parseSeq(body);
      const incoming = normalizeImages(body.images);
      const storedRefs = incoming
        .map((image) => {
          const storedImageId = image.storedImageId;
          if (typeof storedImageId !== "string" || !/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(storedImageId)) return null;
          return typeof image.role === "string" && image.role.length > 0
            ? { storedImageId, role: image.role }
            : { storedImageId };
        })
        .filter((item) => item !== null);
      const images = await resolveImages(incoming, imagesDir);
      if (images.length === 0) {
        throw Object.assign(new Error("缺少要识别的手写图片"), { status: 400, code: "bad-request" });
      }
      assertVision(settings);

      const result = await runStudyPage({
        registry,
        settings,
        images: images.map((image) => imagePartFromBase64(image.base64, image.mimeType)),
        prompts: settings.prompts,
        timeoutMs: Number(body.timeoutMs) || config.llmTimeoutMs,
      });
      const shaped = studyEnvelope(result);
      if (shaped.degraded !== true) shaped.data = await enrichStudyWords(shaped.data);

      // A degraded parse must NOT create an empty diary entry: the page shows the
      // raw text plus a 重新解析 button, and nothing is written.
      if (shaped.degraded || shaped.data === null) {
        sendJson(res, 200, {
          ok: true,
          replayed: false,
          degraded: true,
          parseError: shaped.parseError,
          rawText: shaped.rawText,
          elapsedMs: shaped.elapsedMs,
          adapter: shaped.adapter,
          entry: null,
          addedWords: [],
          addedCount: 0,
        });
        return;
      }

      const text = shaped.data.text ?? "";
      const sentences = Array.isArray(shaped.data.sentences) ? shaped.data.sentences : [];
      const words = Array.isArray(shaped.data.words) ? shaped.data.words : [];

      const outcome = await store.mutateIdempotent(requestIdOf(req, body), (data) => {
        let entry = typeof body.id === "string" ? data.diary.find((item) => item.id === body.id) : undefined;
        let created = false;
        if (entry === undefined) {
          // Fall back to the page this request is FOR, so re-importing page 2
          // updates page 2 instead of stacking a second copy of it.
          entry = data.diary.find((item) => item.date === date && entrySeq(item) === seq);
        }
        if (entry === undefined) {
          assertPageOrder(data, date, seq);
          created = true;
          entry = {
            id: randomUUID(),
            date,
            seq,
            title: typeof body.title === "string" ? body.title : "",
            images: [],
            corrected: "",
            corrections: [],
            sentences: [],
            words: [],
            source: "diary",
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          data.diary.push(entry);
        }
        entry.date = date;
        entry.seq = seq;
        if (storedRefs.length > 0) entry.images = storedRefs;
        if (text.length > 0) entry.corrected = text;
        if (sentences.length > 0) entry.sentences = sentences;
        entry.words = words;
        entry.updatedAt = nowIso();

        // Every circled word goes straight into the bank — this is the step that
        // replaces the old click-a-word-to-annotate flow in the diary area.
        const added = [];
        for (const item of words) {
          const lemma = String(item.lemma ?? item.word ?? "").trim().toLowerCase();
          if (lemma.length === 0) continue;
          const event = {
            id: randomUUID(),
            word: String(item.word ?? item.lemma ?? "").trim(),
            lemma,
            glossZh: item.glossZh ?? "",
            phonetic: "",
            partOfSpeech: item.partOfSpeech ?? "",
            inflections: Array.isArray(item.inflections) ? item.inflections : [],
            collocations: Array.isArray(item.collocations) ? item.collocations : [],
            examples: [],
            source: "diary",
            sourceRef: entry.id,
            sentence: item.sentence ?? "",
            sentenceZh: "",
            status: "new",
            createdAt: nowIso(),
          };
          data.vocabEvents.unshift(event);
          upsertWord(data, event);
          added.push(event);
        }
        return { entryId: entry.id, created, addedIds: added.map((event) => event.id) };
      });

      const snapshot = await store.snapshot();
      const saved = snapshot.diary.find((item) => item.id === outcome.result.entryId) ?? null;
      sendJson(res, 200, {
        ok: true,
        replayed: outcome.replayed,
        created: outcome.result.created,
        degraded: false,
        parseError: null,
        elapsedMs: shaped.elapsedMs,
        adapter: shaped.adapter,
        entry: saved,
        addedWords: words,
        addedCount: outcome.result.addedIds.length,
        vocabWords: snapshot.vocabWords,
      });
    }),

    "POST /diary/delete": handler(async (req, res) => {
      const body = await readJsonBody(req);
      const id = String(body.id ?? "");
      const outcome = await store.mutateIdempotent(requestIdOf(req, body), (data) => {
        const before = data.diary.length;
        data.diary = data.diary.filter((entry) => entry.id !== id);
        if (data.diary.length === before) {
          throw Object.assign(new Error(`未找到日记 ${id}`), { status: 404, code: "not-found" });
        }
        return true;
      });
      sendJson(res, 200, { ok: true, replayed: outcome.replayed });
    }),
  };

  /** Static assets, served last so the API prefix always wins. */
  async function serveStatic(req, res, relative) {
    const target = pathWithin(config.webDir, relative.length === 0 ? "index.html" : relative);
    if (target === null) {
      sendError(res, 403, "forbidden", "路径越界");
      return;
    }
    let bytes;
    // The path that actually gets served: the SPA history fallback replaces the
    // requested path with `index.html`, and the MIME type must follow the file
    // that was really read (otherwise the shell is sent as octet-stream).
    let servedPath = target;
    try {
      bytes = await readFile(target);
    } catch {
      // SPA history fallback: an unknown extensionless path renders the shell.
      if (extname(relative).length === 0) {
        servedPath = join(config.webDir, "index.html");
        bytes = await readFile(servedPath);
      } else {
        sendError(res, 404, "not-found", `未找到静态资源 ${relative}`);
        return;
      }
    }
    const servedExt = extname(servedPath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[servedExt] ?? "application/octet-stream",
      "content-length": bytes.length,
      // The SPA shell must never be cached across a rebuild; hashed assets may be.
      "cache-control": servedExt === ".html" ? "no-store" : "no-cache",
    });
    res.end(bytes);
  }

  /** Dispatch an API request by `METHOD /path-suffix`. */
  async function handleApi(req, res, suffix, query) {
    const key = `${req.method} ${suffix}`;
    const direct = routes[key];
    if (direct !== undefined) {
      await direct(req, res, {}, query);
      return;
    }
    // Parameterised routes: /images/:id
    const imageMatch = /^\/images\/([^/]+)$/.exec(suffix);
    if (imageMatch !== null) {
      if (req.method !== "GET") {
        sendError(res, 405, "method-not-allowed", `${req.method} 不被支持`);
        return;
      }
      await routes["GET /images"](req, res, { id: decodeURIComponent(imageMatch[1]) }, query);
      return;
    }
    sendError(res, 404, "not-found", `未知的 API 端点 ${key}`);
  }

  // Longest prefix wins, so the API must be registered before (and be longer
  // than) the SPA prefix.
  own(
    ctx,
    ctx.webServer.register({
      kind: "prefix",
      path: `${routeBase}/api`,
      handler: handler(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const suffix = url.pathname.slice(`${routeBase}/api`.length) || "/";
        await handleApi(req, res, suffix, url.searchParams);
      }),
    }),
    "english-study: api route",
  );

  own(
    ctx,
    ctx.webServer.register({
      kind: "prefix",
      path: routeBase,
      handler: handler(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const raw = url.pathname.slice(routeBase.length);
        // `/english-study` without a trailing slash breaks the shell's relative
        // asset paths (`./js/app.js` would resolve to `/js/app.js`), so redirect.
        if (raw === "") {
          res.writeHead(302, { location: `${routeBase}/`, "cache-control": "no-store" });
          res.end();
          return;
        }
        await serveStatic(req, res, raw === "/" ? "" : raw);
      }),
    }),
    "english-study: static route",
  );

  // Only probe ECDICT at startup. Parsing it costs ~200 MB of heap for ~770k rows,
  // and most sessions never look a word up, so the index is built on the first
  // lookup and released again once it has been idle.
  void dictionary.probe().then((available) => {
    logInfo(
      ctx,
      available
        ? `本地词典已就绪（${(dictionary.bytes / 1024 / 1024).toFixed(1)} MiB，首次查词时载入）`
        : "本地词典未提供，将使用 LLM 查词",
    );
  });
  const dictionaryIdleTimer = setInterval(() => {
    if (dictionary.index !== null && Date.now() - dictionary.lastUsedAt > DICTIONARY_IDLE_RELEASE_MS) {
      dictionary.release("idle");
      logInfo(ctx, "本地词典已释放（长时间未查词）");
    }
  }, 60_000);
  dictionaryIdleTimer.unref?.();
  own(ctx, () => clearInterval(dictionaryIdleTimer), "english-study: dictionary idle timer");

  logInfo(
    ctx,
    `已挂载：${routeBase}/ （界面）与 ${routeBase}/api （接口）；数据目录 ${config.dataDir}`,
  );

  if (typeof ctx.on === "function") {
    ctx.on("dispose", () => {
      if (cleanedUp) return;
      cleanedUp = true;
      void store.flush().catch(() => {});
    });
  }
}

/* ------------------------------------------------------------- small helpers */

/** Accept both a plain string and a `Idempotency-Key` style header. */
function requestIdOf(req, body) {
  const header = req.headers["idempotency-key"];
  if (typeof header === "string" && header.length > 0) return header;
  if (typeof body?.requestId === "string" && body.requestId.length > 0) return body.requestId;
  return undefined;
}

function normalizeImages(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry) => {
      if (typeof entry === "string") {
        const match = /^data:([^;]+);base64,(.*)$/.exec(entry);
        return match === null ? { base64: entry, mimeType: "image/jpeg" } : { mimeType: match[1], base64: match[2] };
      }
      if (typeof entry?.base64 === "string") {
        const match = /^data:([^;]+);base64,(.*)$/.exec(entry.base64);
        return match === null
          ? { base64: entry.base64, mimeType: entry.mimeType ?? "image/jpeg" }
          : { mimeType: match[1], base64: match[2] };
      }
      // Accept both key spellings the browser uses for an already-uploaded photo,
      // and keep the caller's `role` so the diary page can still tell the
      // handwritten original from the circled copy after a reload.
      const storedImageId = typeof entry?.storedImageId === "string"
        ? entry.storedImageId
        : typeof entry?.id === "string"
          ? entry.id
          : null;
      if (storedImageId !== null) {
        return typeof entry?.role === "string" && entry.role.length > 0
          ? { storedImageId, role: entry.role }
          : { storedImageId };
      }
      return null;
    })
    .filter((entry) => entry !== null && (entry.base64 === undefined || entry.base64.length > 0));
}

function providerSupportsVision(settings, registry) {
  const described = registry.describe(settings).find((entry) => entry.id === settings.activeProvider);
  return described?.capabilities?.vision === true;
}

/**
 * Providers name the same fields differently, and the difference is invisible
 * until a real call is made.
 *
 * Measured with GLM-4V-Flash on real handwriting: every correction entry came
 * back carrying only a `reason` ("Typographical error", "Past tense correction")
 * with NO original/corrected text. Rendered as-is that is a column of blank diff
 * rows, which is worse than showing nothing, so entries without any text are
 * dropped rather than displayed.
 */
const CORRECTION_TEXT_KEYS = {
  original: ["original", "from", "before", "wrong", "error", "src"],
  corrected: ["corrected", "to", "after", "right", "fix", "dst"],
  reason: ["reason", "why", "explanation", "note", "type"],
};

function pickKey(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function normalizeCorrections(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === "string") return { original: "", corrected: entry.trim(), reason: "" };
      if (entry === null || typeof entry !== "object") return null;
      return {
        original: pickKey(entry, CORRECTION_TEXT_KEYS.original),
        corrected: pickKey(entry, CORRECTION_TEXT_KEYS.corrected),
        reason: pickKey(entry, CORRECTION_TEXT_KEYS.reason),
      };
    })
    .filter((entry) => entry !== null && (entry.original.length > 0 || entry.corrected.length > 0));
}

/**
 * The other measured GLM behaviour: it returned the whole page as ONE segment.
 * The diary reader's sentence-by-sentence bilingual toggle and its read-aloud
 * both depend on real sentence boundaries, so when the model under-segments we
 * fall back to the local splitter. No translation is attached in that case —
 * a single blob's translation must never be presented as one sentence's.
 */
function normalizeSegments(raw, correctedText) {
  const cleaned = (Array.isArray(raw) ? raw : [])
    .map((entry) => {
      if (typeof entry === "string") return { en: entry.trim(), zh: "" };
      if (entry === null || typeof entry !== "object") return null;
      return {
        en: pickKey(entry, ["en", "english", "text"]),
        zh: pickKey(entry, ["zh", "chinese", "translation"]),
      };
    })
    .filter((entry) => entry !== null && entry.en.length > 0);

  const locallySplit = splitSentences(correctedText ?? "");
  if (cleaned.length >= 2 || locallySplit.length <= 1) return cleaned;
  return locallySplit.map((en) => ({ en, zh: "" }));
}

/**
 * Resolve a request's images to base64, accepting BOTH shapes:
 *   · inline  `{ base64, mimeType }`   — a fresh paste
 *   · by id   `{ storedImageId }`      — already uploaded, referenced by a diary
 * A missing file is skipped rather than failing the whole call, so a saved entry
 * whose photo was deleted can still be repaired.
 */
async function resolveImages(input, imagesDir) {
  const images = [];
  for (const image of normalizeImages(input)) {
    if (typeof image.base64 === "string" && image.base64.length > 0) {
      images.push(image);
      continue;
    }
    if (typeof image.storedImageId === "string" && /^[a-f0-9]{32}\.(jpg|png|webp)$/.test(image.storedImageId)) {
      try {
        const bytes = await readFile(join(imagesDir, image.storedImageId));
        images.push({
          base64: bytes.toString("base64"),
          mimeType: MIME_TYPES[extname(image.storedImageId)] ?? "image/jpeg",
        });
      } catch {
        /* the photo is gone; the rest of the request is still useful */
      }
    }
  }
  return images;
}

/**
 * Page number of a diary entry inside its own date.
 *
 * A date holds a linked list of pages: page 1 is the day's first sheet of paper,
 * page 2 the second, and so on. Entries written before multi-page support have no
 * `seq` at all, and every one of them is page 1.
 */
function entrySeq(entry) {
  const value = Number(entry?.seq);
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 1;
}

/** Read `seq` off a request body; an absent or unusable value means page 1. */
function parseSeq(body) {
  const value = Number(body?.seq);
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 1;
}

/**
 * The lazy-pagination guard the user asked for: 「未打开第二篇的时候不会建立下一页」.
 *
 * Opening 下一篇 must cost nothing — it only navigates. The page record is created
 * when that page is actually imported, and it is refused unless its predecessor
 * exists, so a stray click can never leave a hole like (page 1, page 3).
 */
function assertPageOrder(data, date, seq) {
  if (seq <= 1) return;
  const exists = data.diary.some((entry) => entry.date === date && entrySeq(entry) === seq - 1);
  if (!exists) {
    throw Object.assign(new Error(`请先完成第 ${seq - 1} 篇`), { status: 400, code: "page-order" });
  }
}

/** Canonical Chinese inflection labels, mapped from every alias a model may emit. */
const INFLECTION_LABELS = {
  原形: ["原形", "原型", "base", "lemma", "root", "infinitive"],
  过去式: ["过去式", "past", "past tense", "pasttense", "v2"],
  过去分词: ["过去分词", "past participle", "pastparticiple", "pp", "v3"],
  现在分词: ["现在分词", "现在进行时", "present participle", "presentparticiple", "ing", "ving"],
  第三人称单数: ["第三人称单数", "三单", "third person", "thirdpersonsingular", "3rd"],
  复数: ["复数", "plural", "pl"],
  比较级: ["比较级", "comparative", "comp"],
  最高级: ["最高级", "superlative", "sup"],
};

/** Normalise one label; returns "" when it is not a form label we know. */
function canonicalInflectionLabel(label) {
  const key = String(label ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (key.length === 0) return "";
  for (const [canonical, aliases] of Object.entries(INFLECTION_LABELS)) {
    if (canonical.toLowerCase() === key) return canonical;
    if (aliases.some((alias) => alias.toLowerCase().replace(/[\s_-]+/g, "") === key)) return canonical;
  }
  return "";
}

/**
 * Normalise the circled words a page yielded.
 *
 * The prompt asks for forms "by category" (verb → 原形/过去式/过去分词/现在分词,
 * noun → 原形/复数, adjective → 原形/比较级/最高级), but models answer in several
 * shapes: a label/form array, or flat `past` / `pastParticiple` / `plural` fields.
 * Both are accepted here so no view has to care which one arrived.
 */
/** Escape a literal so it can be embedded in a RegExp. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find the sentence of the extracted page that contains a circled word.
 *
 * The model is deliberately NOT asked for this: GLM-4V-Flash caps `max_tokens`
 * at 1024, and echoing the same sentence once per word wasted most of that
 * budget. The host already has both the full text and the sentence list, so it
 * can answer the same question for free and without a hallucination risk.
 */
function sentenceForWord(word, sentences) {
  const surface = String(word?.word ?? "").trim();
  const lemma = String(word?.lemma ?? "").trim();
  const candidates = [surface, lemma].filter((item, index, all) => item.length > 0 && all.indexOf(item) === index);
  for (const candidate of candidates) {
    const pattern = new RegExp(`\\b${escapeRegExp(candidate)}\\b`, "i");
    const hit = sentences.find((item) => pattern.test(item.en));
    if (hit !== undefined) return hit.en;
  }
  // Inflected surface forms ("postponed" for "postpone") still deserve a home.
  for (const candidate of candidates) {
    if (candidate.length < 5) continue;
    const stem = escapeRegExp(candidate.slice(0, Math.max(4, candidate.length - 2)));
    const hit = sentences.find((item) => new RegExp(`\\b${stem}`, "i").test(item.en));
    if (hit !== undefined) return hit.en;
  }
  return "";
}

/**
 * Recover every COMPLETE word object from a truncated study reply.
 *
 * A page with many circled words can exceed the 1024-token ceiling and be cut
 * off mid-array. JSON.parse then fails and the naive response is to throw the
 * whole page away — but the fifteen words that did arrive intact are perfectly
 * good, and the user can see exactly what was dropped. So scan for balanced
 * top-level objects and keep the parseable ones.
 */
function salvageStudyPayload(raw) {
  const source = String(raw ?? "");
  let text = "";
  const textMatch = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(source);
  if (textMatch !== null) {
    try {
      text = JSON.parse(`"${textMatch[1]}"`);
    } catch {
      text = textMatch[1];
    }
  } else {
    // A long page can be cut off INSIDE its own text, so the closing quote never
    // arrives. Everything after the opening quote is still good transcription.
    const open = /"text"\s*:\s*"/.exec(source);
    if (open !== null) {
      const rest = source.slice(open.index + open[0].length);
      try {
        text = JSON.parse(`"${rest}"`);
      } catch {
        text = rest.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    }
  }

  const words = [];
  const arrayStart = source.search(/"words"\s*:\s*\[/);
  if (arrayStart !== -1) {
    let depth = 0;
    let objectStart = -1;
    let inString = false;
    let escaped = false;
    for (let index = source.indexOf("[", arrayStart); index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") {
        if (depth === 0) objectStart = index;
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0 && objectStart !== -1) {
          try {
            words.push(JSON.parse(source.slice(objectStart, index + 1)));
          } catch {
            /* this one object was damaged; the next may not be */
          }
          objectStart = -1;
        }
      }
    }
  }

  if (text.trim().length === 0 && words.length === 0) return null;
  return { text, words };
}

function normalizeStudyWords(raw) {
  if (!Array.isArray(raw)) return [];
  const flatKeys = {
    过去式: ["past", "pastTense"],
    过去分词: ["pastParticiple", "pp", "v3"],
    现在分词: ["presentParticiple", "ing", "ving"],
    第三人称单数: ["thirdPerson", "thirdPersonSingular"],
    复数: ["plural"],
    比较级: ["comparative"],
    最高级: ["superlative"],
  };
  const seen = new Set();
  const words = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const word = pickKey(entry, ["word", "text", "form", "original"]);
    const lemma = pickKey(entry, ["lemma", "base", "原型", "原形"]) || word;
    if (word.length === 0 && lemma.length === 0) continue;
    const key = (lemma || word).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    /** @type {{ label: string, form: string }[]} */
    const inflections = [];
    const push = (label, form) => {
      const canonical = canonicalInflectionLabel(label);
      if (canonical.length === 0 || typeof form !== "string" || form.trim().length === 0) return;
      if (inflections.some((item) => item.label === canonical)) return;
      inflections.push({ label: canonical, form: form.trim() });
    };
    if (Array.isArray(entry.inflections)) {
      for (const item of entry.inflections) {
        if (item === null || typeof item !== "object") continue;
        push(pickKey(item, ["label", "name", "type", "kind", "类别"]) || pickKey(item, ["label"]), pickKey(item, ["form", "value", "text", "word"]));
      }
    }
    for (const [label, keys] of Object.entries(flatKeys)) {
      push(label, pickKey(entry, keys));
    }
    // The base form always belongs in the list, exactly as the prompt asks.
    if (lemma.length > 0 && !inflections.some((item) => item.label === "原形")) {
      inflections.unshift({ label: "原形", form: lemma });
    }

    words.push({
      word: word || lemma,
      lemma: lemma || word,
      partOfSpeech: pickKey(entry, ["partOfSpeech", "pos", "词性"]),
      glossZh: pickKey(entry, ["glossZh", "gloss", "meaning", "translation", "zh", "释义", "翻译"]),
      inflections,
      collocations: (Array.isArray(entry.collocations) ? entry.collocations : [])
        .map((item) => (typeof item === "string" ? item.trim() : pickKey(item, ["phrase", "text", "form"])))
        .filter((item) => item.length > 0),
      sentence: pickKey(entry, ["sentence", "example", "context", "句子"]),
    });
  }
  return words;
}

/** Split an extracted English page into sentences for the reader and read-aloud. */
function normalizeStudySentences(raw, text) {
  const fromModel = (Array.isArray(raw) ? raw : [])
    .map((entry) => (typeof entry === "string" ? entry.trim() : pickKey(entry, ["en", "english", "text"])))
    .filter((entry) => entry.length > 0);
  const source = fromModel.length >= 2 ? fromModel : splitSentences(text);
  return source.map((en) => ({ en, zh: "" }));
}

/** Any CJK ideograph in an "en" field means that line was never translated. */
const NORMALIZE_CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/**
 * Read the model's per-line answer into `{ n, en, zh }` entries.
 *
 * Accepts the new `lines` shape and, for older replies and canned fixtures, the
 * old `segments`/`sentences` shape. A missing or unusable `n` falls back to the
 * entry's position, so a reply that forgets the numbers is still usable.
 *
 * @param {unknown} value
 * @returns {{ language: string, corrections: Array<{original: string, corrected: string, reason: string}>, entries: Array<{n: number, en: string, zh: string}> }}
 */
export function normalizeEntries(value) {
  const raw = Array.isArray(value?.lines)
    ? value.lines
    : Array.isArray(value?.segments)
      ? value.segments
      : Array.isArray(value?.sentences)
        ? value.sentences
        : [];
  const entries = raw
    .map((entry, index) => {
      if (typeof entry === "string") {
        return { n: index + 1, en: stripLineLabels(entry).trim(), zh: "" };
      }
      if (entry === null || typeof entry !== "object") return null;
      const numbered = Number(entry.n ?? entry.line ?? entry.number ?? entry.index);
      return {
        n: Number.isFinite(numbered) && numbered > 0 ? Math.trunc(numbered) : index + 1,
        en: stripLineLabels(pickKey(entry, ["en", "english", "text", "corrected"])).trim(),
        zh: pickKey(entry, ["zh", "chinese", "translation", "meaning"]),
      };
    })
    .filter((entry) => entry !== null);
  return {
    language: pickKey(value, ["language", "lang", "sourceLanguage"]) || "unknown",
    corrections: normalizeCorrections(value?.corrections),
    entries,
  };
}

/**
 * Rebuild the final English from per-line entries — one output line per INPUT line.
 *
 * This is the actual fix for the three live bugs, and the rule is deliberately
 * mechanical rather than clever:
 *   · an empty source line stays an empty line, so paragraph breaks survive;
 *   · a line the model omitted or returned empty is kept VERBATIM from the source,
 *     so no pasted text can ever be dropped, and it is reported in `missing`;
 *   · a line whose English still contains Chinese is reported in `impure` so the
 *     caller can repair just that line;
 *   · a list marker ("1. ") therefore stays on the line the reader typed it on,
 *     because nothing ever re-flows text between lines.
 *
 * @param {string[]} sourceLines
 * @param {Array<{n: number, en: string, zh: string}>} entries
 */
export function composeNormalized(sourceLines, entries) {
  const byNumber = new Map();
  for (const entry of entries) {
    if (!byNumber.has(entry.n)) byNumber.set(entry.n, entry);
  }
  const missing = [];
  const impure = [];
  const rows = sourceLines.map((line, index) => {
    const n = index + 1;
    if (line.trim().length === 0) return { en: "", zh: "", blank: true };
    const hit = byNumber.get(n);
    if (hit === undefined || hit.en.length === 0) {
      missing.push(n);
      return { en: line, zh: hit?.zh ?? "", blank: false };
    }
    if (NORMALIZE_CJK_RE.test(hit.en)) impure.push(n);
    return { en: hit.en, zh: hit.zh, blank: false };
  });

  // Robustness only, for a legacy per-sentence reply that returns more entries than
  // the source has lines: its extra English is appended rather than discarded.
  for (const entry of entries) {
    if (entry.n <= sourceLines.length || entry.en.length === 0) continue;
    rows.push({ en: entry.en, zh: entry.zh, blank: false });
  }

  return {
    corrected: rows
      .map((row) => row.en)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    segments: rows.filter((row) => !row.blank && row.en.length > 0).map((row) => ({ en: row.en, zh: row.zh })),
    missing,
    impure,
  };
}

/**
 * Guarantee the text area always ends up with PRONOUNCEABLE ENGLISH.
 *
 * Two live bugs are fixed here: an English or Chinese paste produced a blank
 * preview, and a Chinese-only paste reached the reader screen as Chinese, which the
 * speech engine cannot pronounce. A third round of bugs (a blank line truncating the
 * result, a list number reflowing onto the previous paragraph, and a Chinese word
 * surviving inside English output) is fixed by composing the answer line by line
 * instead of trusting the model's own blob — see composeNormalized().
 */
function normalizeNormalizeResult(value, originalText) {
  const { language, corrections, entries } = normalizeEntries(value);
  const sourceLines = splitSourceLines(originalText);

  if (entries.length === 0) {
    // No usable per-line answer: fall back to whatever prose the model did return.
    const correctedRaw = pickKey(value, ["corrected", "correct", "text", "output", "result", "en"]);
    const corrected = correctedRaw.length > 0 ? correctedRaw : String(originalText ?? "").trim();
    const segments =
      corrected.length > 0 && splitSentences(corrected).length > 1
        ? splitSentences(corrected).map((en) => ({ en, zh: "" }))
        : corrected.length > 0
          ? [{ en: corrected, zh: "" }]
          : [];
    return { language, corrected, corrections, segments, missing: [], impure: [] };
  }

  const { corrected, segments, missing, impure } = composeNormalized(sourceLines, entries);
  return { language, corrected, corrections, segments, missing, impure };
}

/**
 * Lines per provider call for the text-area task.
 *
 * MEASURED: the 220-character, 10-line paste from the bug report used the whole
 * 1024-token output budget in ONE reply and came back truncated, which is what
 * dropped a line in the first place. Bounding each reply by lines makes the answer
 * scale with the input instead of silently losing its tail.
 */
const NORMALIZE_LINES_PER_CALL = 8;

/**
 * Hard ceiling on provider requests for ONE text-area submission.
 *
 * Bisecting a truncated block doubles the request count, so without a ceiling a
 * pathological reply could keep splitting. 24 calls is far more than any real paste
 * needs (a 100-line paste is ~13 blocks) while still bounding a runaway.
 */
const MAX_NORMALIZE_CALLS = 24;

/**
 * Group source lines into per-call blocks, keeping each line's ORIGINAL number.
 *
 * Blank lines ride along inside their block so `L<n>:` stays exact and the repair
 * pass can address any line by the number the reader's text gives it. A block that
 * is nothing but blank lines is skipped — there is nothing to translate in it.
 */
export function buildNormalizeBlocks(sourceLines, perCall = NORMALIZE_LINES_PER_CALL) {
  const blocks = [];
  for (let start = 0; start < sourceLines.length; start += perCall) {
    const slice = sourceLines.slice(start, start + perCall);
    if (slice.every((line) => line.trim().length === 0)) continue;
    blocks.push({
      numbers: slice.map((_, offset) => start + offset + 1),
      labelled: slice.map((line, offset) => `L${start + offset + 1}: ${line}`).join("\n"),
    });
  }
  return blocks;
}

/**
 * Run the text-area task, in bounded blocks, with ONE repair pass.
 *
 * The lines are sent in blocks (see NORMALIZE_LINES_PER_CALL) and each block is
 * asked for one entry per line. If a block's reply cannot be parsed at all — the
 * measured symptom of hitting the 1024-token ceiling mid-JSON — that block is
 * BISECTED and re-asked in halves, because a truncated reply is a statement about
 * the budget, not about the lines. If any line still came back missing, or with
 * Chinese left inside its English, a FINAL call is sent containing only those
 * original line numbers; its answers merge back by number, so the lines that were
 * already correct are never re-sent (re-sending them risks the model rewriting text
 * it had already got right).
 *
 * A failed block or repair never loses text: the composed result keeps every
 * un-answered line verbatim, and reports it through `missing`/`impure`/
 * `blockErrors`/`repairFailed` rather than silently accepting it.
 */
export async function runNormalize({ registry, settings, text, images = [], timeoutMs }) {
  const sourceLines = splitSourceLines(text);
  const call = (labelled) =>
    registry.chat(settings, {
      messages: buildNormalizeMessages({
        text,
        labelled,
        images,
        normalizePrompt: settings.prompts?.normalize,
      }),
      timeoutMs,
    });

  // With an image the picture IS the payload — chunking it would only duplicate it.
  const blocks =
    images.length > 0
      ? [{ numbers: sourceLines.map((_, index) => index + 1) }]
      : buildNormalizeBlocks(sourceLines);
  if (blocks.length === 0) blocks.push({ numbers: [] });

  const newState = () => ({
    entries: [],
    corrections: [],
    language: "unknown",
    elapsedMs: 0,
    usage: [],
    adapter: null,
    rawText: "",
    answered: false,
  });

  /**
   * Ask for one group of line numbers, bisecting on an unparseable reply.
   * `throwOnFirst` keeps the very first request's failure (offline, bad key,
   * timeout) a real error instead of silently composing the input back.
   */
  const collect = async (numbers, state, throwOnFirst) => {
    const queue = [numbers];
    while (queue.length > 0) {
      const group = queue.shift();
      if (group.length === 0) continue;
      if (state.calls >= MAX_NORMALIZE_CALLS) {
        state.errors.push({ lines: group.join(","), message: "已达单次处理的请求次数上限" });
        continue;
      }
      state.calls += 1;
      const labelled = group.map((n) => `L${n}: ${sourceLines[n - 1] ?? ""}`).join("\n");
      let response = null;
      try {
        response = await call(labelled);
      } catch (caught) {
        if (throwOnFirst && state.calls === 1) throw caught;
        state.errors.push({ lines: group.join(","), message: String(caught?.message ?? caught) });
        continue;
      }
      state.elapsedMs += response.elapsedMs ?? 0;
      if (response.usage !== null && response.usage !== undefined) state.usage.push(response.usage);
      if (state.adapter === null) state.adapter = response.adapter;
      if (state.rawText.length === 0) state.rawText = response.text;
      const extracted = extractJson(response.text);
      if (extracted.error !== null) {
        if (group.length > 1) {
          // A cut-off reply says the group was too big, not that the text is bad.
          const half = Math.ceil(group.length / 2);
          queue.unshift(group.slice(0, half), group.slice(half));
          continue;
        }
        state.errors.push({ lines: group.join(","), message: extracted.error.message });
        continue;
      }
      state.answered = true;
      const part = normalizeEntries(extracted.value);
      state.entries = [...state.entries, ...part.entries];
      state.corrections = [...state.corrections, ...part.corrections];
      if (part.language !== "unknown") state.language = part.language;
    }
  };

  const primary = newState();
  primary.calls = 0;
  primary.errors = [];
  for (const block of blocks) await collect(block.numbers, primary, true);

  if (!primary.answered) {
    // Nothing usable at all: reuse the one degraded envelope the views already read.
    return shapeLlmResult(
      {
        text: primary.rawText,
        adapter: primary.adapter,
        elapsedMs: primary.elapsedMs,
        usage: primary.usage.length === 1 ? primary.usage[0] : primary.usage,
      },
      "normalize",
      text,
    );
  }

  let entries = primary.entries;
  let corrections = primary.corrections;
  let language = primary.language;
  let elapsedMs = primary.elapsedMs;
  let usage = primary.usage;
  const blockErrors = primary.errors;

  const draft = composeNormalized(sourceLines, entries);
  const offenders = [...new Set([...draft.missing, ...draft.impure])].sort((a, b) => a - b);

  let repaired = false;
  let repairFailed = false;
  if (offenders.length > 0) {
    const repair = newState();
    repair.calls = 0;
    repair.errors = [];
    await collect(offenders, repair, false);
    elapsedMs += repair.elapsedMs;
    usage = [...usage, ...repair.usage];
    blockErrors.push(...repair.errors);
    if (repair.entries.length === 0) {
      repairFailed = true;
    } else {
      // The repair REPLACES the offending lines; un-repaired ones stay verbatim.
      const replaced = new Set(offenders);
      entries = [...entries.filter((entry) => !replaced.has(entry.n)), ...repair.entries];
      corrections = [...corrections, ...repair.corrections];
      if (repair.language !== "unknown") language = repair.language;
      repaired = true;
    }
  }

  const final = composeNormalized(sourceLines, entries);
  return {
    ok: true,
    degraded: false,
    task: "normalize",
    adapter: primary.adapter,
    elapsedMs,
    parseError: null,
    rawText: primary.rawText,
    usage: usage.length === 0 ? null : usage.length === 1 ? usage[0] : usage,
    data: {
      language,
      corrected: final.corrected,
      corrections,
      segments: final.segments,
      missing: final.missing,
      impure: final.impure,
      repaired,
      repairFailed,
      blockErrors,
    },
  };
}

/**
 * Wrap a `runStudyPage` result in the envelope every view already reads.
 *
 * `partial` is what lets the page say 「只恢复了一部分」 instead of pretending the
 * read was complete, and `calls` records the per-call adapter/timing so a slow or
 * degraded run can be diagnosed from the response alone.
 */
export function studyEnvelope(result) {
  const calls = result.calls ?? {};
  const elapsedMs =
    (calls.text?.elapsedMs ?? 0) + (calls.words?.elapsedMs ?? 0) + (calls.collocations?.elapsedMs ?? 0);
  const usage = [calls.text?.usage, calls.words?.usage, calls.collocations?.usage].filter(
    (entry) => entry !== null && entry !== undefined,
  );
  if (result.degraded === true) {
    return {
      ok: true,
      degraded: true,
      task: "study",
      adapter: calls.text?.adapter ?? null,
      elapsedMs,
      parseError: result.parseError,
      rawText: result.rawText,
      data: null,
      usage: usage.length > 0 ? usage : null,
      calls,
    };
  }
  return {
    ok: true,
    degraded: false,
    task: "study",
    partial: result.partial === true,
    complete: result.complete !== false,
    collocationsFailed: result.collocationsFailed === true,
    adapter: calls.text?.adapter ?? null,
    elapsedMs,
    parseError: result.parseError ?? null,
    rawText: result.rawText,
    data: {
      text: result.text,
      sentences: Array.isArray(result.sentences) ? result.sentences : [],
      words: Array.isArray(result.words) ? result.words : [],
    },
    usage: usage.length > 0 ? usage : null,
    calls,
  };
}

/**
 * Turn a provider response into the uniform envelope the UI expects.
 * On a format failure we return `ok: true, degraded: true` with the raw text so
 * the page can show the original and offer a 重新解析 button — never a blank page.
 *
 * The diary read does NOT come through here any more: it is three calls assembled
 * by `runStudyPage`/`studyEnvelope`. This covers the single-call tasks.
 */
function shapeLlmResult(response, task, sourceText = "") {
  const extracted = extractJson(response.text);
  if (extracted.error !== null) {
    return {
      ok: true,
      degraded: true,
      task,
      adapter: response.adapter,
      elapsedMs: response.elapsedMs,
      parseError: extracted.error,
      rawText: response.text,
      data: null,
      usage: response.usage,
    };
  }
  const value = extracted.value;
  // Provider differences are absorbed here, once, so no view ever has to know
  // which model answered.
  let data = value;
  if (value !== null && typeof value === "object" && task === "normalize") {
    data = normalizeNormalizeResult(value, sourceText);
  }
  return {
    ok: true,
    degraded: false,
    task,
    adapter: response.adapter,
    elapsedMs: response.elapsedMs,
    parseError: null,
    rawText: response.text,
    data,
    usage: response.usage,
  };
}

/** Merge one annotation event into the derived per-lemma vocabulary record. */
function upsertWord(data, event) {
  const key = event.lemma.toLowerCase();
  let word = data.vocabWords.find((entry) => entry.lemma.toLowerCase() === key);
  if (word === undefined) {
    word = {
      id: key,
      lemma: event.lemma,
      phonetic: event.phonetic,
      glossZh: event.glossZh,
      partOfSpeech: event.partOfSpeech,
      inflections: event.inflections,
      collocations: Array.isArray(event.collocations) ? event.collocations : [],
      examples: event.examples,
      status: "new",
      starred: false,
      note: "",
      sources: [],
      annotations: [],
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
    };
    data.vocabWords.unshift(word);
  }
  // Newer, richer information wins; empty values never overwrite known ones.
  for (const field of ["phonetic", "glossZh", "partOfSpeech"]) {
    if (typeof event[field] === "string" && event[field].length > 0) word[field] = event[field];
  }
  if (Array.isArray(event.inflections) && event.inflections.length > 0) word.inflections = event.inflections;
  // Fixed collocations accumulate across every text the word appeared in — a
  // phrase seen in three different articles is exactly what should be reviewed.
  if (Array.isArray(event.collocations) && event.collocations.length > 0) {
    const merged = new Set([...(Array.isArray(word.collocations) ? word.collocations : []), ...event.collocations]);
    word.collocations = [...merged];
  }
  if (Array.isArray(event.examples) && event.examples.length > 0) word.examples = event.examples;
  word.annotations.unshift({
    id: event.id,
    at: event.createdAt,
    source: event.source,
    sourceRef: event.sourceRef,
    sentence: event.sentence,
    sentenceZh: event.sentenceZh,
    glossZh: event.glossZh,
    collocations: Array.isArray(event.collocations) ? event.collocations : [],
  });
  if (!word.sources.includes(event.source)) word.sources.push(event.source);
  word.updatedAt = event.createdAt;
  return word;
}

function buildAnkiBack(word) {
  const parts = [];
  if (word.phonetic) parts.push(`/${word.phonetic}/`);
  if (word.glossZh) parts.push(word.glossZh);
  const inflections = (word.inflections ?? []).map((entry) => `${entry.label}：${entry.form}`).join("；");
  if (inflections.length > 0) parts.push(inflections);
  for (const example of word.examples ?? []) {
    if (example?.en) parts.push(`${example.en}${example.zh ? `<br>${example.zh}` : ""}`);
  }
  if (word.sentence) parts.push(`原文：${word.sentence}`);
  return parts.join("<br>");
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Exported for the model-facing tool surface and unit tests. */
export const __internals = {
  parseEcdictCsv,
  shapeLlmResult,
  mergeSettings,
  publicSettings,
  TASK_MARKERS,
  normalizeCorrections,
  normalizeSegments,
  normalizeStudyWords,
  normalizeStudySentences,
  normalizeNormalizeResult,
  normalizeEntries,
  composeNormalized,
  buildNormalizeBlocks,
  runNormalize,
  canonicalInflectionLabel,
  normalizeImages,
  resolveImages,
  entrySeq,
  parseSeq,
  assertPageOrder,
  sentenceForWord,
  salvageStudyPayload,
  enrichWordsFromDictionary,
  lemmaFromExchange,
  parseWordList,
  mergeWordPasses,
  parseCollocationList,
  runStudyPage,
  studyEnvelope,
  LocalDictionary,
};

/**
 * LLM adapter layer for 英语学习小助手.
 *
 * There is exactly ONE provider: 智谱 GLM-4V-Flash, the completely free
 * vision-understanding model. It covers 识图 + 翻译 + 纠错 with a single call,
 * so the whole pipeline runs at zero marginal cost.
 *
 * `mock` also exists, but it is a TEST DOUBLE only: it is never listed in the
 * settings UI (`describe()` marks it `hidden: true`) and never chosen by default.
 * It lets the offline suites exercise routing, storage and annotation with no key
 * and no network.
 *
 * Every adapter implements:
 *   id, label, capabilities: { vision: boolean, json: boolean }
 *   async chat({ messages, timeoutMs, signal }) -> { text, usage, raw }
 *
 * Messages use the OpenAI-compatible shape. Adapters receive content that may be
 * a plain string or an array of parts ({ type: "text" } / { type: "image_url" }).
 *
 * Concurrency: exactly ONE in-flight provider request is allowed at a time
 * (required by the reliability spec). Additional calls queue in FIFO order.
 */

/**
 * 智谱 GLM-4V-Flash — the free vision path, and the answer to the hard
 * requirement that OCR + translation must not cost anything per call.
 *
 * 智谱's own documentation describes it as 「智谱推出的首个完全免费的图像理解模型」
 * (the first completely free image-understanding model) and lists 图片 / 视觉理解
 * as supported, so a photo can go in and text can come out at zero marginal cost.
 * The endpoint is OpenAI-compatible — the same `/chat/completions` shape with
 * `image_url` content parts — so it reuses the transport below untouched.
 * Verified against https://docs.bigmodel.cn/cn/guide/models/free/glm-4v-flash.
 *
 * `response_format: {"type":"json_object"}` IS sent, but ONLY for the tasks whose
 * reply is actually JSON (the page text, the normalizer, the single-word lookup).
 * It was verified accepted by glm-4v-flash and it removes the markdown-fence and
 * trailing-prose failure modes on top of the contract's own instructions.
 *
 * It is deliberately NOT sent for the two line-list tasks (ringed words, fixed
 * phrases): those replies are plain lines by design — asking for JSON there would
 * contradict the contract, and a provider that enforced the parameter strictly
 * would turn a correct answer into an unparseable one.
 */
export const DEFAULT_GLM_BASE = "https://open.bigmodel.cn/api/paas/v4";
export const DEFAULT_GLM_MODEL = "glm-4v-flash";
export const GLM_MODEL_CHOICES = ["glm-4v-flash"];

/**
 * GLM-4V-Flash rejects anything outside [1, 1024]:
 *   max_tokens参数非法：限制数值范围[1,1024]   (code 1210, measured live)
 * So 1024 is not a preference, it is the ceiling — and the default when the
 * field is omitted is small enough to truncate a page with many circled words.
 * Ask for the whole allowance. Because the budget is this tight, the study
 * contract deliberately does NOT ask the model to echo the containing sentence
 * (the host locates it in `text` itself) and the host salvages complete word
 * objects from a truncated reply rather than discarding the whole page.
 */
export const GLM_MAX_TOKENS = 1024;

/** Hard ceiling on a single request body we are willing to build (images are base64). */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/* ------------------------------------------------------- default user prompts */

/**
 * The diary read is THREE small calls, and each one has its own editable prompt.
 * The user's original wording covered all three tasks at once, but that combined
 * prompt measurably HURT the word call: asked to also produce inflections and
 * collocations in a bare word list, GLM-4V-Flash dropped ringed words to make
 * room. Measured over four runs each, on tools/fixtures/handwriting-01.png:
 *   combined prompt -> 15/17, 15/17, 17/17, 15/17 recovered
 *   words-only      -> 17/17, 17/17, 15/17, 17/17 recovered
 * So the original sentence is split here along the lines of the three calls, and
 * 「恢复默认」 restores each piece independently. The per-call machine contract is
 * still appended AFTER the user's wording, so a hand-edited prompt cannot break
 * parsing.
 */
export const DEFAULT_PAGE_TEXT_PROMPT = "这是一篇翻译完成的手写英文，请提取出其中的英文。";

/** The 标注单词 call: identify the ellipse-ringed words. */
export const DEFAULT_PAGE_WORDS_PROMPT = "部分单词用椭圆包裹标注，请识别并提取这些单词。";

/** The 固定搭配 call: the one detail a local dictionary cannot supply. */
export const DEFAULT_COLLOCATIONS_PROMPT = "如果这些单词在文中使用了固定搭配，请指出对应的词组。";

/**
 * The text-area prompt. It must leave the user with ENGLISH, always: the reader
 * screen is English, so a Chinese input has to be translated first and an English
 * input has to be corrected — never left untranslated and never left blank.
 */
export const DEFAULT_NORMALIZE_PROMPT = [
  "这是一段我需要学习的文本，可能是中文、英文或中英混合。",
  "请先判断它的语言：如果是中文，请翻译成地道、自然的英文；如果是英文，请纠正其中的语法和单词错误；",
  "如果是中英混合，请把中文部分翻译成英文、把英文部分纠正错误，最后合成完整通顺的英文。",
  "最终结果里不要保留任何中文。",
  "请严格保持我原来的分行结构：输入有几行，就输出几行，一行都不许合并、拆分或遗漏；列表序号要留在原来那一行的开头。",
  "然后给出每一行英文对应的中文意思，并列出你修改过的地方。",
].join("");

export const DEFAULT_PROMPTS = {
  pageText: DEFAULT_PAGE_TEXT_PROMPT,
  pageWords: DEFAULT_PAGE_WORDS_PROMPT,
  collocations: DEFAULT_COLLOCATIONS_PROMPT,
  normalize: DEFAULT_NORMALIZE_PROMPT,
};

export class LlmError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, retryable?: boolean, detail?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "LlmError";
    this.code = options.code ?? "llm-error";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
  }
}

/** Reject a promise after `ms`, aborting the underlying request. */
function withTimeout(ms, run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), ms);
  return run(controller.signal)
    .then((value) => ({ value, timedOut: false }))
    .catch((error) => {
      if (controller.signal.aborted && !(error && error.name === "LlmError")) {
        throw new LlmError(`LLM 请求超时（${ms} ms）`, { code: "timeout", retryable: true });
      }
      throw error;
    })
    .finally(() => clearTimeout(timer));
}

/** Serialize all provider calls: one at a time, FIFO. */
class SerialQueue {
  constructor() {
    this.tail = Promise.resolve();
    this.depth = 0;
  }

  /** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
  run(task) {
    this.depth += 1;
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => {
        this.depth -= 1;
      },
      () => {
        this.depth -= 1;
      },
    );
    return result;
  }
}

/** Shared OpenAI-compatible POST transport used by every HTTP adapter. */
async function postChatCompletions({ base, path = "/chat/completions", apiKey, body, timeoutMs, extraHeaders }) {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new LlmError("未配置 API Key", { code: "config", retryable: false });
  }
  const url = `${base.replace(/\/+$/, "")}${path}`;
  // `withTimeout` resolves to `{ value, timedOut }`, so the inner result MUST be
  // unwrapped here. Forgetting this made every HTTP adapter hand back a shapeless
  // wrapper instead of `{ text, usage, raw }`, which the UI silently rendered as an
  // empty result — a real bug the offline suites could not catch because the mock
  // adapter bypasses this transport entirely.
  const outcome = await withTimeout(timeoutMs, async (signal) => {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey.trim()}`,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new LlmError(`无法连接 ${new URL(url).host}：${error?.message ?? error}`, {
        code: "network",
        retryable: true,
        detail: String(error),
      });
    }
    const raw = await response.text();
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new LlmError(`${new URL(url).host} 返回 HTTP ${response.status}`, {
        code: "http",
        status: response.status,
        retryable,
        detail: raw.slice(0, 2000),
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LlmError("响应不是合法 JSON", { code: "format", retryable: true, detail: raw.slice(0, 2000) });
    }
    const text = extractMessageText(parsed);
    if (typeof text !== "string") {
      throw new LlmError("响应中缺少 choices[0].message.content", {
        code: "format",
        retryable: true,
        detail: JSON.stringify(parsed).slice(0, 2000),
      });
    }
    // MEASURED: a model can answer HTTP 200 with an EMPTY content string. Treating
    // that as success would paint a blank screen and lose the user's photo, so it is
    // a retryable format error instead. The registry retries once, and if it happens
    // again the UI degrades to "show the original + 重新解析".
    if (text.trim().length === 0) {
      throw new LlmError("模型返回了空内容（HTTP 200 但 content 为空）", {
        code: "format",
        retryable: true,
        detail: `finish_reason=${parsed?.choices?.[0]?.finish_reason ?? "?"} usage=${JSON.stringify(parsed?.usage ?? null)}`,
      });
    }
    return { text, usage: parsed.usage ?? null, raw: parsed };
  });
  return outcome.value;
}

/** Pull the assistant text out of an OpenAI-compatible response, tolerating variants. */
function extractMessageText(parsed) {
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return undefined;
}

/** 智谱 GLM-4V-Flash — the only real provider. */
class GlmAdapter {
  constructor(config = {}) {
    this.id = "glm";
    this.label = "智谱 GLM-4V-Flash（免费识图）";
    // `json: true` means the adapter can ask for JSON output mode. It does — but
    // only for the JSON tasks; see `isJsonTask` for why the line-list tasks do not.
    this.capabilities = { vision: true, json: true };
    this.config = config;
  }

  get apiKey() {
    return this.config.apiKey;
  }

  get model() {
    return this.config.model || DEFAULT_GLM_MODEL;
  }

  get base() {
    return this.config.baseUrl || DEFAULT_GLM_BASE;
  }

  /** @param {{ messages: unknown[], timeoutMs: number }} request */
  async chat({ messages, timeoutMs }) {
    return postChatCompletions({
      base: this.base,
      apiKey: this.apiKey,
      body: {
        model: this.model,
        messages,
        max_tokens: GLM_MAX_TOKENS,
        // Extraction, not composition: the same page must yield the same words.
        temperature: 0.1,
        ...(isJsonTask(messages) ? { response_format: { type: "json_object" } } : {}),
      },
      timeoutMs,
    });
  }
}

/**
 * Deterministic offline TEST DOUBLE. Never offered in the UI (`hidden: true`).
 * It lets the entire application — routing, storage, annotation, review — be
 * exercised with no API key and no network. It is never a silent fallback: the
 * caller always knows which adapter answered because the response carries
 * `adapter: "mock"`.
 */
class MockAdapter {
  constructor() {
    this.id = "mock";
    this.label = "mock（仅自动化测试，界面永不显示）";
    this.capabilities = { vision: false, json: true };
    this.hidden = true;
  }

  /** @param {{ messages: unknown[] }} request */
  async chat({ messages }) {
    const prompt = JSON.stringify(messages);
    const wantsPageText = prompt.includes(TASK_MARKERS.pageText);
    const wantsPageWords = prompt.includes(TASK_MARKERS.pageWords);
    const wantsCollocations = prompt.includes(TASK_MARKERS.collocations);
    const wantsNormalize = prompt.includes(TASK_MARKERS.normalize);
    const wantsLexeme = prompt.includes(TASK_MARKERS.lexeme);
    const source = lastUserText(messages);

    if (wantsLexeme) {
      return {
        text: JSON.stringify({
          lemma: String(source).trim(),
          phonetic: "ˈmɒk",
          glossZh: "n. 模拟条目",
          partOfSpeech: "n.",
          inflections: [],
          examples: [{ en: `This is ${String(source).trim()}.`, zh: "这是一个模拟例句。" }],
        }),
        usage: null,
        raw: null,
      };
    }
    if (wantsPageText) {
      // A deterministic "recognised page": one sentence.
      return {
        text: JSON.stringify({ text: "I still felt uneasy about the coming days." }),
        usage: null,
        raw: null,
      };
    }
    if (wantsPageWords) {
      return { text: "uneasy", usage: null, raw: null };
    }
    if (wantsCollocations) {
      return { text: "uneasy = feel uneasy", usage: null, raw: null };
    }
    if (wantsNormalize) {
      // The payload is labelled ("L1: …"); de-label it line by line before echoing.
      const lines = unlabelSourceLines(source);
      return {
        text: JSON.stringify({
          language: CJK_RE.test(source) ? (/[A-Za-z]/.test(source) ? "mixed" : "zh") : "en",
          lines: lines.map((line, index) => {
            const body = line.trim();
            if (body.length === 0) return { n: index + 1, en: "", zh: "" };
            // "en" must stay free of CJK even in the offline double, or the host's
            // purity check would flag the mock's own output.
            return CJK_RE.test(body)
              ? { n: index + 1, en: "(mock: no translation service)", zh: body }
              : { n: index + 1, en: body, zh: "(mock: no translation service)" };
          }),
          corrections: [],
        }),
        usage: null,
        raw: null,
      };
    }
    return { text: "{}", usage: null, raw: null };
  }
}

/**
 * Recover the caller's raw payload from a message list.
 *
 * Convention: every prompt builder puts the user's actual data (text, or the
 * single target word) in the LAST text part of the LAST user message, after all
 * instructions. Two things depend on that: the model reads the data after the
 * rules, and the offline mock adapter can recover the payload without trying to
 * parse prose out of its own instructions.
 */
function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      for (let part = content.length - 1; part >= 0; part -= 1) {
        const candidate = content[part];
        if (candidate?.type === "text" && typeof candidate.text === "string") return candidate.text;
      }
    }
  }
  return "";
}

/** Naive sentence split used by the mock adapter and as a degradation path. */
export function splitSentences(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?。！？])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Registry of adapters. `active` resolves through the caller-supplied settings so
 * the user can switch provider from the UI without a restart.
 */
export class LlmRegistry {
  constructor() {
    /** @type {Map<string, (config: object) => object>} */
    this.factories = new Map();
    this.queue = new SerialQueue();
    this.register("glm", (config) => new GlmAdapter(config));
    this.register("mock", () => new MockAdapter());
  }

  register(id, factory) {
    this.factories.set(id, factory);
  }

  /** @returns {string[]} */
  ids() {
    return [...this.factories.keys()];
  }

  /**
   * Describe every adapter for the settings UI, marking which have credentials.
   * Secrets are never returned — only a boolean. Adapters flagged `hidden` are
   * filtered out by the host before the payload reaches the browser, so internal
   * test doubles never appear as a choice.
   */
  describe(settings) {
    const credentials = settings?.credentials ?? {};
    const providers = settings?.providers ?? {};
    return [...this.factories.keys()].map((id) => {
      const config = credentials[id] ?? {};
      const adapter = this.factories.get(id)(config);
      return {
        id,
        label: adapter.label,
        capabilities: adapter.capabilities,
        hidden: adapter.hidden === true,
        configured: id === "mock" ? true : Boolean(config.apiKey),
        model: providers[id]?.model ?? config.model ?? null,
      };
    });
  }

  /**
   * Instantiate the active adapter.
   * @param {object} settings plugin settings (see resolveSettings in lib/index.js)
   */
  create(settings) {
    const id = settings?.activeProvider ?? "glm";
    const factory = this.factories.get(id);
    if (factory === undefined) {
      throw new LlmError(`未知的 provider "${id}"`, { code: "config" });
    }
    return factory(settings?.credentials?.[id] ?? {});
  }

  /**
   * Run one provider call under the global single-flight queue, with one internal
   * retry for transient failures. The client still owns user-visible retries; this
   * inner retry exists because a single 429/5xx should not surface to the user.
   */
  async chat(settings, request) {
    const adapter = this.create(settings);
    const timeoutMs = Number.isFinite(request.timeoutMs) ? request.timeoutMs : 60_000;
    return this.queue.run(async () => {
      try {
        const started = Date.now();
        const response = await adapter.chat({ ...request, timeoutMs });
        return { ...response, adapter: adapter.id, elapsedMs: Date.now() - started };
      } catch (error) {
        if (error instanceof LlmError && error.retryable) {
          await delay(800);
          const started = Date.now();
          const response = await adapter.chat({ ...request, timeoutMs });
          return { ...response, adapter: adapter.id, elapsedMs: Date.now() - started };
        }
        throw error;
      }
    });
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the first balanced JSON object/array from model output. Models wrap JSON
 * in code fences, prepend prose, or emit trailing commentary; all of that must be
 * tolerated rather than treated as a hard failure.
 * @returns {{ value: unknown, error: null } | { value: null, error: string }}
 */
export function extractJson(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { value: null, error: "模型返回为空" };
  }
  let body = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fence !== null) body = fence[1].trim();

  const direct = tryParse(body);
  if (direct.ok) return { value: direct.value, error: null };

  const start = body.search(/[[{]/);
  if (start === -1) return { value: null, error: "模型返回中未找到 JSON" };
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < body.length; index += 1) {
    const char = body[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        const candidate = tryParse(body.slice(start, index + 1));
        return candidate.ok
          ? { value: candidate.value, error: null }
          : { value: null, error: `JSON 解析失败：${candidate.error}` };
      }
    }
  }
  return { value: null, error: "JSON 括号不匹配（可能被截断）" };
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text), error: null };
  } catch (error) {
    return { ok: false, value: null, error: error?.message ?? String(error) };
  }
}

/* ------------------------------------------------------------------ prompts */

/** Marker strings let the offline mock adapter route without inspecting structure. */
export const TASK_MARKERS = {
  pageText: "__TASK_PAGE_TEXT__",
  pageWords: "__TASK_PAGE_WORDS__",
  collocations: "__TASK_COLLOCATIONS__",
  normalize: "__TASK_NORMALIZE__",
  lexeme: "__TASK_LEXEME__",
};

/** Markers whose task ends in a JSON object, and so may ask for JSON output. */
const JSON_TASK_MARKERS = new Set([TASK_MARKERS.pageText, TASK_MARKERS.normalize, TASK_MARKERS.lexeme]);

/**
 * Does this request expect a JSON object back?
 *
 * The two line-list tasks (ringed words, fixed phrases) must answer with plain
 * lines, so they must NOT carry `response_format`. Read the marker the builder
 * already put in the message rather than widening every call signature.
 */
export function isJsonTask(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      if (typeof part?.text === "string" && JSON_TASK_MARKERS.has(part.text.trim())) return true;
    }
  }
  return false;
}

/**
 * WHY THE DIARY READ IS THREE SMALL CALLS AND NOT ONE BIG ONE.
 *
 * Measured against glm-4v-flash on a real 18-line handwritten page with 17 circled
 * words (see tools/probe-study-direct.mjs):
 *
 *   1 JSON call asking for {text, words[{word,lemma,gloss,inflections,collocations,sentence}]}
 *     -> completion_tokens: 1024 (the hard ceiling, error 1210 above it), and the model
 *        dropped circled words and emptied the inflection objects to fit. Recall 13-16/17,
 *        collocations ALWAYS [].
 *   2 one call for {"text": string}
 *     -> 219 completion tokens, page transcribed VERBATIM (1079 chars).
 *   3 one call for a bare newline list of the circled words
 *     -> 50 completion tokens, 17/17 recalled, 2.4 s.
 *   4 one text-only call for `word = phrase` collocation lines
 *     -> 111 completion tokens, phrases for 16/17 words.
 *
 * The lesson is that the JSON schema and the per-word detail were competing with the
 * words themselves for a 1024-token budget. Asking only for what the model uniquely
 * knows — the transcription, which words are ringed, which phrase each forms — and
 * describing every word from ECDICT locally is both cheaper and far more accurate.
 */
const PAGE_TEXT_CONTRACT = [
  "Respond with JSON only, matching exactly this shape:",
  '{"text": string}',
  "Rules:",
  '- "text" is the English on the page, VERBATIM. Keep every word, punctuation mark and mistake exactly as written.',
  "- Never correct, rewrite, translate, summarise, add or drop a sentence.",
  "Return the JSON object now.",
].join("\n");

const PAGE_WORDS_CONTRACT = [
  "The writer drew an ellipse (an oval ring) around some words on the page.",
  "Scan the page from the first line to the last, and list EVERY ellipsed word in reading order.",
  "Reply with one word per line and NOTHING else — no numbering, no JSON, no commentary:",
  "word",
  "If no word is ringed, reply with the single line: none",
].join("\n");

const COLLOCATIONS_CONTRACT = [
  "The passage is given first, then the words being studied.",
  "For each studied word, name the fixed phrase or collocation it forms IN THIS PASSAGE.",
  'Reply with one line per word that forms one, and nothing else: word = phrase',
  'Examples of the expected answer: "uneasy = feel uneasy", "track = on track".',
  "Skip a word that forms no fixed phrase. Never invent a phrase that is not in the passage.",
].join("\n");

/**
 * The text-area contract. Three live bugs are encoded here, each measured:
 *
 *  1. A blank line between two paragraphs made the model stop writing "corrected"
 *     after the first paragraph, so the preview showed only the top of the paste.
 *  2. With the blank lines removed, the leading number of a list item ("1. ") was
 *     reflowed onto the end of the previous paragraph.
 *  3. A Chinese word inside an English sentence (同人) was left untranslated in the
 *     English output.
 *
 * All three come from the same root cause as the diary read: ONE reply was asked
 * to carry TWO representations of the text — a free-form "corrected" blob AND a
 * per-sentence "segments" list — so the two drifted, and the blob (the one the
 * preview uses) was the one that lost content.
 *
 * The fix is structural: the model is now asked for ONE entry per numbered input
 * line and nothing else. The host composes the final English text by joining those
 * entries, so a line can never be silently dropped or swallowed by its neighbour,
 * and the line structure the reader typed is what comes back.
 */
const NORMALIZE_CONTRACT = [
  'The input is numbered line by line as "L<n>: <text>". The "L<n>:" label is bookkeeping ONLY — never copy it into your answer.',
  "Respond with JSON only, matching exactly this shape:",
  '{"language": "zh" | "en" | "mixed", "lines": [{"n": number, "en": string, "zh": string}], "corrections": [{"from": string, "to": string, "reason": string}]}',
  "Rules:",
  '- Return EXACTLY ONE entry per input line, in the same order, with "n" set to that line\'s number. Never merge two lines into one entry, never skip a line, never split one line into two entries.',
  '- A line whose text is empty is a blank line: give it "en": "" and "zh": "".',
  '- "en" is that ONE line rendered in English. Translate it if it is Chinese, correct its grammar and spelling if it is English, do both if it is mixed. "en" must NEVER contain a Chinese character — write 同人 as "doujin (fan-made)" and 中文 terms as their English equivalent.',
  '- "zh" is that line\'s Chinese meaning. Chinese is expected here.',
  '- A list marker such as "1. " or "- " belongs to the line it is written on: keep it at the START of that line\'s "en", never move it to another line.',
  '- "corrections" lists every grammar, spelling or word-choice change you made; it may be empty.',
  "Return the JSON object now.",
].join("\n");

/** Any CJK ideograph means an "en" field leaked untranslated Chinese. */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/** Split source text into lines, normalising CRLF and lone CR. */
export function splitSourceLines(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
}

/**
 * Label each source line so the model can be asked for one entry per line.
 *
 * @param {string} text
 * @returns {{ lines: string[], labelled: string }}
 */
export function numberSourceLines(text) {
  const lines = splitSourceLines(text);
  return { lines, labelled: lines.map((line, index) => `L${index + 1}: ${line}`).join("\n") };
}

/** Remove a leading "L<n>:" label the model may have echoed back. */
export function stripLineLabels(value) {
  return String(value ?? "").replace(/^\s*L\d+\s*[:：]\s?/, "");
}

/** Undo numberSourceLines(): recover the original lines from a labelled payload. */
export function unlabelSourceLines(text) {
  return splitSourceLines(text).map((line) => stripLineLabels(line));
}


/**
 * Diary task, call 1 of 3: read the page and transcribe it. Nothing else.
 *
 * @param {{ images?: unknown[], studyPrompt?: string }} request
 */
export function buildStudyTextMessages({ images = [], pageTextPrompt = DEFAULT_PAGE_TEXT_PROMPT }) {
  const parts = [
    { type: "text", text: TASK_MARKERS.pageText },
    { type: "text", text: String(pageTextPrompt ?? DEFAULT_PAGE_TEXT_PROMPT) },
    { type: "text", text: PAGE_TEXT_CONTRACT },
  ];
  // The images are the payload, so they come last.
  for (const image of images) parts.push(image);
  return [{ role: "user", content: parts }];
}

/**
 * Diary task, call 2 of 3: name the ringed words. Deliberately NOT JSON — a bare
 * line list is what made recall jump from 13-16/17 to 17/17.
 *
 * @param {{ images?: unknown[], pageWordsPrompt?: string }} request
 */
export function buildStudyWordsMessages({ images = [], pageWordsPrompt = DEFAULT_PAGE_WORDS_PROMPT }) {
  const parts = [
    { type: "text", text: TASK_MARKERS.pageWords },
    { type: "text", text: String(pageWordsPrompt ?? DEFAULT_PAGE_WORDS_PROMPT) },
    { type: "text", text: PAGE_WORDS_CONTRACT },
  ];
  for (const image of images) parts.push(image);
  return [{ role: "user", content: parts }];
}

/**
 * Diary task, call 3 of 3: the fixed phrases. Text only — the page is not needed,
 * so this is the cheapest of the three calls and the only source of collocations.
 *
 * @param {{ text?: string, words?: Array<{ word?: string }>, collocationsPrompt?: string }} request
 */
export function buildStudyCollocationsMessages({ text = "", words = [], collocationsPrompt = DEFAULT_COLLOCATIONS_PROMPT }) {
  const list = words
    .map((word) => String(word?.word ?? "").trim())
    .filter((word) => word.length > 0);
  return [
    {
      role: "user",
      content: [
        { type: "text", text: TASK_MARKERS.collocations },
        { type: "text", text: String(collocationsPrompt ?? DEFAULT_COLLOCATIONS_PROMPT) },
        { type: "text", text: COLLOCATIONS_CONTRACT },
        { type: "text", text: `The passage:\n${String(text ?? "")}` },
        { type: "text", text: `Studied words: ${list.join(", ")}` },
      ],
    },
  ];
}

/**
 * Text-area task: whatever went in, ENGLISH must come out.
 *
 * The bug this exists to prevent: a Chinese (or English) paste was previously sent
 * to a "correct" step that had nothing to correct, so the preview screen rendered
 * blank, and the reader screen ended up with Chinese-only text that could not be
 * pronounced. Normalising first — translate to English, THEN correct — means the
 * reader always has pronounceable English to click.
 *
 * The payload is NUMBERED LINE BY LINE. The model must answer with one entry per
 * line, and the host rebuilds the final text from those entries, so a blank line
 * or a list number can no longer be lost or reflowed (see NORMALIZE_CONTRACT).
 *
 * @param {{ text?: string, labelled?: string, images?: unknown[], normalizePrompt?: string }} request
 *   `labelled` is a pre-labelled payload (e.g. a repair call over specific line
 *   numbers). When given it is used verbatim instead of numbering `text`.
 */
export function buildNormalizeMessages({ text, labelled, images = [], normalizePrompt = DEFAULT_NORMALIZE_PROMPT }) {
  const parts = [
    { type: "text", text: TASK_MARKERS.normalize },
    { type: "text", text: String(normalizePrompt ?? DEFAULT_NORMALIZE_PROMPT) },
    { type: "text", text: NORMALIZE_CONTRACT },
  ];
  for (const image of images) parts.push(image);
  // The raw payload is ALWAYS the final part — see lastUserText().
  const payload = typeof labelled === "string" && labelled.length > 0 ? labelled : numberSourceLines(text).labelled;
  parts.push({ type: "text", text: payload });
  return [{ role: "user", content: parts }];
}

/**
 * Per-word enrichment: lemma, IPA, Chinese gloss, inflections, example sentences.
 * The local ECDICT dictionary is tried first; this only fills what it cannot.
 */
export function buildLexemeMessages({ word, sentence = "" }) {
  const instruction = [
    TASK_MARKERS.lexeme,
    "You are an English learner's dictionary for a Chinese native speaker.",
    "The target word is the final part of this message.",
    sentence.trim().length > 0 ? `It appeared in this sentence: "${sentence}"` : "",
    "Respond with JSON only, matching exactly this shape:",
    '{"lemma": string, "phonetic": string, "glossZh": string, "partOfSpeech": string, "inflections": [{"form": string, "label": string}], "examples": [{"en": string, "zh": string}]}',
    "Rules:",
    '- "lemma" is the dictionary/base form (原形).',
    '- "phonetic" is IPA WITHOUT surrounding slashes, e.g. "rɪˈkɔːd".',
    '- "glossZh" is a concise Simplified Chinese definition; include the part of speech, e.g. "n. 记录；唱片".',
    '- "inflections" lists the word forms that exist for this lemma (过去式/过去分词/现在分词/第三人称单数/复数/比较级/最高级) using those Chinese labels. Omit forms that do not apply.',
    '- "examples" gives at most 2 short example sentences with Chinese translations.',
    "Return the JSON object now.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
  // The raw payload is ALWAYS the final part — see lastUserText().
  return [
    { role: "user", content: [{ type: "text", text: instruction }, { type: "text", text: String(word ?? "") }] },
  ];
}

/** Build an OpenAI-compatible image part from raw bytes. */
export function imagePartFromBase64(base64, mimeType = "image/jpeg") {
  return { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } };
}

export function createDefaultRegistry() {
  return new LlmRegistry();
}

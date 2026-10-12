/**
 * Integration smoke test for the browser half of the plugin.
 *
 * The real page can only be exercised inside DSH, so this runs the same ESM
 * modules under Node against a minimal DOM stub and a canned host API. It is what
 * catches the class of bug a syntax check cannot: a view that throws while
 * rendering, a selector that reads a field the host never sends, or a router
 * navigation that leaves the outlet empty.
 *
 *   tools\node.cmd tools\smoke-web.mjs
 */

/* ============================================================= DOM stub === */

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, extra = "") {
  if (condition) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
  }
  console.log(`${condition ? "ok  " : "FAIL"} ${name}${condition || !extra ? "" : `\n       ${extra}`}`);
}

function define(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

class StubNode {
  constructor(nodeType, nodeName) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.childNodes = [];
    this.parentNode = null;
  }
  get parentElement() {
    return this.parentNode !== null && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  appendChild(child) {
    if (child === null || child === undefined) return child;
    if (child.nodeType === 11) {
      for (const inner of [...child.childNodes]) this.appendChild(inner);
      child.childNodes = [];
      return child;
    }
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }
  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this);
  }
}

class TextNode extends StubNode {
  constructor(text) {
    super(3, "#text");
    this._text = text;
  }
  get textContent() {
    return this._text;
  }
  set textContent(value) {
    this._text = String(value);
  }
}

class Element extends StubNode {
  constructor(tag) {
    super(1, String(tag).toUpperCase());
    this.tagName = String(tag).toUpperCase();
    this.attributes = new Map();
    this.style = {};
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.files = undefined;
    this.checked = false;
    this._text = "";
    this._html = null;
    this._className = "";
    this.classList = {
      add: (name) => {
        const parts = new Set(this._className.split(/\s+/).filter(Boolean));
        parts.add(name);
        this._className = [...parts].join(" ");
      },
      remove: (name) => {
        this._className = this._className
          .split(/\s+/)
          .filter((part) => part.length > 0 && part !== name)
          .join(" ");
      },
      contains: (name) => this._className.split(/\s+/).includes(name),
      toggle: (name) => {
        if (this.classList.contains(name)) this.classList.remove(name);
        else this.classList.add(name);
      },
    };
  }
  get className() {
    return this._className;
  }
  set className(value) {
    this._className = String(value);
  }
  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.childNodes = [];
    this._text = String(value);
    this._html = null;
  }
  get innerHTML() {
    return this._html ?? this.textContent;
  }
  set innerHTML(value) {
    this.childNodes = [];
    this._text = "";
    this._html = String(value);
  }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key === "class") this._className = String(value);
    else if (key === "id") this.id = String(value);
    else if (key in this) this[key] = String(value);
  }
  getAttribute(key) {
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }
  removeAttribute(key) {
    this.attributes.delete(key);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  dispatchEvent(event) {
    const enriched = { type: event.type, target: this, ...event };
    for (const handler of [...(this.listeners.get(event.type) ?? [])]) handler(enriched);
    return true;
  }
  click() {
    this.dispatchEvent({ type: "click" });
  }
  closest(selector) {
    let node = this;
    while (node !== null && node !== undefined) {
      if (typeof selector === "string") {
        if (selector.startsWith(".")) {
          if (String(node.className ?? "").split(/\s+/).includes(selector.slice(1))) return node;
        } else if (String(node.tagName ?? "").toLowerCase() === selector.toLowerCase()) {
          return node;
        }
      }
      node = node.parentNode;
    }
    return null;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}

const registry = new Map();
const documentStub = {
  createElement: (tag) => new Element(tag),
  createTextNode: (text) => new TextNode(String(text)),
  createDocumentFragment: () => new StubNode(11, "#document-fragment"),
  getElementById: (id) => registry.get(id) ?? null,
  addEventListener: () => {},
  removeEventListener: () => {},
  body: new Element("body"),
  documentElement: new Element("html"),
};

define("Node", StubNode);
define("document", documentStub);
define("window", globalThis);

const windowListeners = new Map();
define("addEventListener", (type, handler) => {
  if (!windowListeners.has(type)) windowListeners.set(type, []);
  windowListeners.get(type).push(handler);
});
define("removeEventListener", (type, handler) => {
  const list = windowListeners.get(type) ?? [];
  const index = list.indexOf(handler);
  if (index >= 0) list.splice(index, 1);
});
function fireWindow(type, event = {}) {
  for (const handler of [...(windowListeners.get(type) ?? [])]) handler({ type, ...event });
}

const locationStub = {
  _hash: "#/",
  href: "http://127.0.0.1:19387/english-study/",
  pathname: "/english-study/",
  get hash() {
    return this._hash;
  },
  set hash(value) {
    this._hash = String(value);
    fireWindow("hashchange", { newURL: String(value) });
  },
};
define("location", locationStub);
define("scrollTo", () => {});

define("navigator", { onLine: true, userAgent: "node-smoke" });

const localStore = new Map();
define("localStorage", {
  getItem: (key) => (localStore.has(key) ? localStore.get(key) : null),
  setItem: (key, value) => localStore.set(key, String(value)),
  removeItem: (key) => localStore.delete(key),
  clear: () => localStore.clear(),
});

for (const id of ["toast-layer", "modal-layer", "root"]) {
  registry.set(id, new Element("div"));
}
registry.get("modal-layer").hidden = true;

/* ========================================================= canned host === */

const today = new Date().toLocaleDateString("sv-SE");

const sampleWord = {
  id: "park",
  lemma: "park",
  phonetic: "pɑːk",
  glossZh: "n. 公园；v. 停车",
  partOfSpeech: "n.",
  inflections: [{ form: "parks", label: "复数" }, { form: "parked", label: "过去式" }],
  examples: [{ en: "We walked in the park.", zh: "我们在公园里散步。" }],
  status: "new",
  starred: false,
  note: "",
  sources: ["diary"],
  annotations: [
    {
      id: "e1",
      at: "2026-02-14T10:00:00.000Z",
      source: "diary",
      sourceRef: "d1",
      sentence: "Yesterday I went to the park.",
      sentenceZh: "昨天我去了公园。",
      glossZh: "n. 公园",
    },
  ],
  createdAt: "2026-02-14T10:00:00.000Z",
  updatedAt: "2026-02-14T10:00:00.000Z",
};

const sampleEntry = {
  id: "d1",
  date: "2026-02-14",
  seq: 1,
  title: "A Walk in the Park",
  images: [
    { role: "original", storedImageId: `${"a".repeat(32)}.jpg`, url: "/english-study/api/images/a.jpg", name: "p1.jpg" },
    { role: "annotated", storedImageId: `${"b".repeat(32)}.jpg`, url: "/english-study/api/images/b.jpg", name: "p2.jpg" },
  ],
  corrected: "Yesterday I went to the park. It was sunny.",
  corrections: [{ from: "goed", to: "went", reason: "go 的过去式是 went" }],
  sentences: [
    { en: "Yesterday I went to the park.", zh: "昨天我去了公园。" },
    { en: "It was sunny.", zh: "天气晴朗。" },
  ],
  words: [],
  source: "photo",
  updatedAt: "2026-02-14T10:00:00.000Z",
};

/** The SAME date's second page — the multi-page diary exists only because one did. */
const samplePage2 = {
  ...JSON.parse(JSON.stringify(sampleEntry)),
  id: "d2",
  seq: 2,
  title: "The Second Sheet",
  corrected: "The afternoon turned cold.",
  sentences: [{ en: "The afternoon turned cold.", zh: "下午变冷了。" }],
  updatedAt: "2026-02-14T11:00:00.000Z",
};

const sampleSettings = {
  activeProvider: "glm",
  providers: {},
  credentials: {
    glm: { configured: true, model: "glm-4v-flash", baseUrl: "https://open.bigmodel.cn/api/paas/v4", source: null },
  },
  prompts: {
    study: "这是一篇翻译完成的手写英文，请提取出其中的英文，部分单词用椭圆包裹标注。",
    normalize: "这是一段我需要学习的文本，请先判断它的语言，最终结果里不要保留任何中文。",
  },
  defaultPrompts: {
    study: "这是一篇翻译完成的手写英文，请提取出其中的英文，部分单词用椭圆包裹标注。",
    normalize: "这是一段我需要学习的文本，请先判断它的语言，最终结果里不要保留任何中文。",
  },
  tts: { lang: "en-US", rate: 0.9, pitch: 1 },
  review: { intervalsMinutes: [5, 30, 720, 1440, 2880, 5760, 10080, 21600, 43200] },
  availableProviders: [
    { id: "glm", label: "智谱 GLM-4V-Flash（免费识图）", capabilities: { vision: true, json: true }, configured: true, model: "glm-4v-flash" },
  ],
};

let storeDoc = {
  diary: [JSON.parse(JSON.stringify(sampleEntry)), JSON.parse(JSON.stringify(samplePage2))],
  vocabEvents: [JSON.parse(JSON.stringify(sampleWord.annotations[0]))],
  vocabWords: [JSON.parse(JSON.stringify(sampleWord))],
};

const requestLog = [];
const controls = { flakyRemaining: 0, hangNext: false, lastStatus: 200, importCalls: 0 };

function makeResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return payload === undefined ? "" : JSON.stringify(payload);
    },
    async json() {
      return payload;
    },
  };
}

async function fakeFetch(url, init = {}) {
  const parsed = new URL(String(url), "http://127.0.0.1:19387");
  const path = parsed.pathname;
  const method = String(init.method ?? "GET").toUpperCase();
  const body = typeof init.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
  requestLog.push({ method, path, body, headers: init.headers ?? {} });
  controls.lastStatus = 0;

  if (controls.hangNext) {
    controls.hangNext = false;
    return new Promise((resolve, reject) => {
      const signal = init.signal;
      const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal !== undefined) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  if (controls.flakyRemaining > 0) {
    controls.flakyRemaining -= 1;
    controls.lastStatus = 503;
    return makeResponse(503, { ok: false, error: { code: "unavailable", message: "暂时不可用", detail: null } });
  }

  const json = async (status, payload) => {
    controls.lastStatus = status;
    return makeResponse(status, payload);
  };

  if (path === "/english-study/api/state" && method === "GET") {
    return json(200, { ok: true, revision: 1, ...storeDoc, settings: sampleSettings });
  }
  if (path === "/english-study/api/health") {
    return json(200, {
      ok: true,
      plugin: "dsh-english-study",
      version: "0.1.0",
      time: new Date().toISOString(),
      routeBase: "/english-study",
      dataDir: "D:\\dsh-English-study-workplace\\data",
      dictionary: { state: "absent", size: 0 },
      activeProvider: "mock",
    });
  }
  if (path === "/english-study/api/settings" && method === "POST") {
    Object.assign(sampleSettings, body?.settings ?? {});
    return json(200, { ok: true, settings: sampleSettings });
  }
  if (path === "/english-study/api/images" && method === "POST") {
    return json(200, {
      ok: true,
      image: { id: `${"c".repeat(32)}.jpg`, url: "/english-study/api/images/c.jpg", bytes: 1234, mimeType: body?.mimeType ?? "image/jpeg" },
    });
  }
  if (path === "/english-study/api/vocab/annotate" && method === "POST") {
    const event = body;
    const key = String(event.lemma ?? event.word ?? "").toLowerCase();
    const existing = storeDoc.vocabWords.find((word) => word.lemma.toLowerCase() === key);
    if (existing === undefined) {
      storeDoc.vocabWords.unshift({
        ...sampleWord,
        id: key,
        lemma: event.lemma ?? event.word,
        glossZh: event.glossZh ?? "",
        inflections: event.inflections ?? [],
        examples: event.examples ?? [],
        annotations: [{ ...event, at: event.createdAt }],
        sources: [event.source ?? "webtest"],
      });
    } else {
      existing.annotations.unshift({ ...event, at: event.createdAt });
      if (!existing.sources.includes(event.source)) existing.sources.push(event.source);
    }
    storeDoc.vocabEvents.unshift(event);
    return json(200, { ok: true, replayed: false, event, vocabWords: storeDoc.vocabWords });
  }
  if (path === "/english-study/api/vocab/update" && method === "POST") {
    const word = storeDoc.vocabWords.find((entry) => entry.id === body?.id);
    if (word !== undefined) Object.assign(word, body.patch ?? {});
    return json(200, { ok: true, replayed: false, word });
  }
  if (path === "/english-study/api/vocab/delete" && method === "POST") {
    storeDoc.vocabWords = storeDoc.vocabWords.filter((entry) => entry.id !== body?.id);
    return json(200, { ok: true, vocabWords: storeDoc.vocabWords });
  }
  if (path === "/english-study/api/diary" && method === "POST") {
    const entry = { ...body, id: typeof body?.id === "string" ? body.id : `d-${storeDoc.diary.length + 1}`, updatedAt: new Date().toISOString() };
    const index = storeDoc.diary.findIndex((item) => item.id === entry.id);
    if (index === -1) storeDoc.diary.unshift(entry);
    else storeDoc.diary[index] = entry;
    return json(200, { ok: true, entry });
  }
  if (path === "/english-study/api/diary/delete" && method === "POST") {
    storeDoc.diary = storeDoc.diary.filter((item) => item.id !== body?.id);
    return json(200, { ok: true });
  }
  if (path === "/english-study/api/llm/normalize" && method === "POST") {
    return json(200, {
      ok: true,
      degraded: false,
      task: "normalize",
      adapter: "glm",
      elapsedMs: 12,
      parseError: null,
      rawText: "{}",
      data: {
        language: "mixed",
        corrected: "Yesterday I went to the park.",
        corrections: [{ from: "goed", to: "went", reason: "过去式" }],
        segments: [{ en: "Yesterday I went to the park.", zh: "昨天我去了公园。" }],
      },
      usage: null,
    });
  }
  if (path === "/english-study/api/llm/study" && method === "POST") {
    return json(200, {
      ok: true,
      degraded: false,
      task: "study",
      adapter: "glm",
      elapsedMs: 9,
      parseError: null,
      rawText: "{}",
      data: {
        text: "I still felt uneasy about the coming days.",
        sentences: [{ en: "I still felt uneasy about the coming days.", zh: "" }],
        words: [
          {
            word: "uneasy",
            lemma: "uneasy",
            partOfSpeech: "a.",
            glossZh: "不安的，心神不宁的",
            inflections: [{ label: "原形", form: "uneasy" }, { label: "比较级", form: "uneasier" }],
            collocations: ["feel uneasy"],
            sentence: "I still felt uneasy about the coming days.",
          },
        ],
      },
      usage: null,
    });
  }
  if (path === "/english-study/api/diary/import" && method === "POST") {
    controls.importCalls += 1;
    controls.importSeq = body?.seq;
    const entry = JSON.parse(JSON.stringify(sampleEntry));
    entry.id = body?.id ?? "d-imported";
    entry.date = body?.date ?? sampleEntry.date;
    entry.seq = body?.seq ?? 1;
    entry.words = [
      {
        id: "w-uneasy",
        word: "uneasy",
        lemma: "uneasy",
        partOfSpeech: "a.",
        glossZh: "不安的，心神不宁的",
        inflections: [{ label: "原形", form: "uneasy" }],
        collocations: ["feel uneasy"],
        sentence: "I still felt uneasy about the coming days.",
        sentenceZh: "",
      },
    ];
    const index = storeDoc.diary.findIndex((item) => item.id === entry.id);
    if (index === -1) storeDoc.diary.unshift(entry);
    else storeDoc.diary[index] = entry;
    return json(200, {
      ok: true,
      replayed: false,
      created: index === -1,
      degraded: false,
      parseError: null,
      elapsedMs: 15,
      adapter: "glm",
      entry,
      addedWords: entry.words,
      addedCount: 1,
      vocabWords: storeDoc.vocabWords,
    });
  }
  if (path === "/english-study/api/llm/lexeme" && method === "POST") {
    return json(200, {
      ok: true,
      degraded: false,
      task: "lexeme",
      adapter: "mock",
      source: "llm",
      word: body?.word,
      elapsedMs: 11,
      parseError: null,
      rawText: "{}",
      data: {
        lemma: body?.word ?? "park",
        phonetic: "pɑːk",
        glossZh: "n. 公园",
        partOfSpeech: "n.",
        inflections: [{ form: "parks", label: "复数" }],
        examples: [{ en: `I like the ${body?.word}.`, zh: "例句翻译" }],
      },
      usage: null,
    });
  }
  return json(404, { ok: false, error: { code: "not-found", message: `no canned route for ${method} ${path}`, detail: null } });
}

define("fetch", fakeFetch);

/* ================================================================ tests === */

const PLUGIN_ROOT = "D:/dsh-English-study-workplace/packages/dsh-english-study";
const webModule = (name) => `file:///${PLUGIN_ROOT}/web/js/${name}`;

const ui = await import(webModule("ui.js"));
const db = await import(webModule("db.js"));
const tts = await import(webModule("tts.js"));
const apiModule = await import(webModule("api.js"));
const store = await import(webModule("store.js"));
const routerModule = await import(webModule("router.js"));
const components = await import(webModule("components.js"));
const homeView = (await import(webModule("views/home.js"))).default;
const diaryView = (await import(webModule("views/diary.js"))).default;
const webtestView = (await import(webModule("views/webtest.js"))).default;
const vocabView = (await import(webModule("views/vocab.js"))).default;
const settingsView = (await import(webModule("views/settings.js"))).default;

/* -- ui ------------------------------------------------------------------ */

const built = ui.h("div", { class: "card", style: { color: "red" }, "data-x": "1" }, "hello", ui.h("b", null, "world"));
check("ui.h builds an element with class + style + attribute", built.tagName === "DIV" && built.className === "card" && built.style.color === "red" && built.getAttribute("data-x") === "1");
check("ui.h appends children", built.textContent === "helloworld", built.textContent);

let clicked = 0;
const withHandler = ui.h("button", { onClick: () => { clicked += 1; } }, "go");
withHandler.click();
check("ui.h attaches event handlers", clicked === 1);

const holder = ui.h("div", null, "old");
ui.mount(holder, ui.h("span", null, "new"));
check("ui.mount replaces children", holder.textContent === "new", holder.textContent);

ui.toast("测试提示", "ok");
check("ui.toast appends to #toast-layer", registry.get("toast-layer").childNodes.length === 1);

const modal = ui.openModal({ title: "标题", body: ui.h("div", null, "内容") });
check("ui.openModal renders into #modal-layer", registry.get("modal-layer").childNodes.length === 1 && registry.get("modal-layer").hidden === false);
modal.close();
check("ui.openModal close clears the layer", registry.get("modal-layer").hidden === true && registry.get("modal-layer").childNodes.length === 0);

const guardedOk = ui.guarded(() => ui.h("div", null, "fine"), { label: "x" });
check("ui.guarded passes a healthy render through", guardedOk.textContent === "fine");
const guardedBad = ui.guarded(() => { throw new Error("boom"); }, { label: "坏视图" });
check("ui.guarded catches a throwing view", String(guardedBad.className).includes("alert") && guardedBad.textContent.includes("坏视图"));

/* -- db ------------------------------------------------------------------ */

const mode = await db.storageMode();
check("db degrades to memory without IndexedDB", mode === "memory", String(mode));
await db.kvPut("k", { a: 1 });
check("db kv round-trips", (await db.kvGet("k"))?.a === 1);
await db.outboxPut({ id: "o1", path: "/x", method: "POST", body: {}, requestId: "r1", createdAt: 1, attempts: 0 });
check("db outbox stores and counts", (await db.outboxCount()) === 1);
await db.outboxClear();
check("db outboxClear empties the queue", (await db.outboxCount()) === 0);

/* -- tts ----------------------------------------------------------------- */

check("tts.chunkText keeps short text whole", tts.chunkText("Hello world.").length === 1);
const longText = Array.from({ length: 60 }, (_, index) => `Sentence number ${index}.`).join(" ");
check("tts.chunkText splits text Chromium would truncate", tts.chunkText(longText).length > 1);
check("tts reports unsupported without speechSynthesis", tts.isSupported() === false);

/* -- api ----------------------------------------------------------------- */

const direct = await apiModule.request("/state", { retries: 0 });
check("api.request decodes a JSON body", direct?.ok === true && Array.isArray(direct.vocabWords));

const before = requestLog.length;
controls.flakyRemaining = 1;
const afterRetry = await apiModule.request("/state", { retries: 3 });
const attempts = requestLog.length - before;
check("api.request retries a 503 then succeeds", afterRetry?.ok === true && attempts === 2, `attempts=${attempts}`);

controls.hangNext = true;
let timeoutError = null;
try {
  await apiModule.request("/state", { timeoutMs: 30, retries: 0 });
} catch (error) {
  timeoutError = error;
}
check("api.request times out and force-ends the request", timeoutError?.code === "timeout", String(timeoutError?.code));

let httpError = null;
try {
  await apiModule.request("/nope", { method: "GET", retries: 0 });
} catch (error) {
  httpError = error;
}
check("api.request surfaces a host error message", httpError?.status === 404 && String(httpError.message).includes("no canned route"), String(httpError?.message));

// Offline: a mutation is parked rather than lost.
apiModule.connection.online = false;
const queued = await apiModule.api.annotate({ word: "offline", lemma: "offline", source: "webtest" });
check("api queues a mutation while offline", queued?.queued === true, JSON.stringify(queued));
check("api reports the queued depth", apiModule.connection.queued === 1, String(apiModule.connection.queued));
apiModule.connection.online = true;
const flushed = await apiModule.flushOutbox();
check("api.flushOutbox replays the queued mutation", flushed.delivered === 1 && apiModule.connection.queued === 0, JSON.stringify(flushed));

// The idempotency key must be stable across retries of the same operation.
const idBefore = requestLog.length;
controls.flakyRemaining = 1;
await apiModule.api.annotate({ word: "idem", lemma: "idem", source: "webtest" });
const idempotentCalls = requestLog.slice(idBefore);
check(
  "api reuses one idempotency key across retries",
  idempotentCalls.length === 2 && idempotentCalls[0].headers["idempotency-key"] === idempotentCalls[1].headers["idempotency-key"],
  JSON.stringify(idempotentCalls.map((call) => call.headers["idempotency-key"])),
);

/* -- R2/R4/R5: the reliability guarantees a user actually notices --------- */

// R2 — the retry LADDER, not just "it retried once". Timeouts are stubbed to
// fire immediately while still recording the requested delay, so the exact
// 1s → 2s → 4s sequence and the 3-retry ceiling can be asserted without the
// suite taking 7 seconds.
const realSetTimeout = globalThis.setTimeout;
const observedDelays = [];
globalThis.setTimeout = (fn, ms, ...rest) => {
  // Only the retry ladder is fast-forwarded. The per-attempt TIMEOUT timer
  // (30 s) keeps its real duration so it never races the canned response, and it
  // is cleared by the transport as soon as the response lands.
  if (typeof ms === "number" && ms >= 500 && ms < 10_000) {
    observedDelays.push(ms);
    return realSetTimeout(fn, 0, ...rest);
  }
  return realSetTimeout(fn, ms, ...rest);
};
try {
  const ladderBefore = requestLog.length;
  controls.flakyRemaining = 99; // every attempt answers 503
  let ladderError = null;
  try {
    await apiModule.request("/state", { retries: 3 });
  } catch (error) {
    ladderError = error;
  }
  const ladderAttempts = requestLog.length - ladderBefore;
  check("R2: a failing request is attempted once plus three retries", ladderAttempts === 4, `attempts=${ladderAttempts}`);
  check("R2: the backoff is exactly 1s → 2s → 4s", observedDelays.join(",") === "1000,2000,4000", observedDelays.join(","));
  check("R2: the last error is surfaced after the retries are spent", ladderError !== null && ladderError.status === 503, String(ladderError?.status));
  controls.flakyRemaining = 0;

  // R2 — a 4xx is the user's mistake, not a transient fault: retrying it would
  // burn three round trips and still fail.
  const before4xx = requestLog.length;
  let error4xx = null;
  try {
    await apiModule.request("/nope", { method: "GET", retries: 3 });
  } catch (error) {
    error4xx = error;
  }
  check(
    "R2: a 404 is NOT retried",
    requestLog.length - before4xx === 1 && error4xx?.status === 404,
    `attempts=${requestLog.length - before4xx} status=${error4xx?.status}`,
  );

  // R4/R5 — an LLM call is metered and its result is not replayable later, so it
  // must fail loudly while offline rather than be parked in the outbox.
  const realFetch = globalThis.fetch;
  apiModule.connection.online = false;
  const queuedBeforeLlm = apiModule.connection.queued;
  globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
  let offlineLlmError = null;
  try {
    await apiModule.api.normalize({ text: "我昨天去了公园。" });
  } catch (error) {
    offlineLlmError = error;
  }
  const queuedAfterLlm = apiModule.connection.queued;
  globalThis.fetch = realFetch;
  apiModule.connection.online = true;
  check(
    "R4/R5: an LLM call fails offline instead of being queued",
    offlineLlmError !== null && queuedAfterLlm === queuedBeforeLlm,
    `queued ${queuedBeforeLlm} → ${queuedAfterLlm}, error=${offlineLlmError?.code ?? offlineLlmError?.message}`,
  );
} finally {
  globalThis.setTimeout = realSetTimeout;
}

// R6/R4 — the periodic sync must drain the queue with no user action.
apiModule.connection.online = false;
await apiModule.api.updateWord("sunny", { starred: true });
const queuedDepth = apiModule.connection.queued;
apiModule.connection.online = true;
const stopAutoSync = store.startAutoSync(20);
await new Promise((resolve) => setTimeout(resolve, 140));
stopAutoSync();
check(
  "R6: startAutoSync drains the outbox on its own",
  queuedDepth >= 1 && apiModule.connection.queued === 0,
  `queued ${queuedDepth} → ${apiModule.connection.queued}`,
);


/* -- store --------------------------------------------------------------- */

await store.bootstrap();
check("store.bootstrap loads the snapshot", store.state.loaded === true && store.state.vocabWords.length >= 1);
check("store keeps the host settings", store.state.settings?.activeProvider === "glm");
check("store is not stale after a successful fetch", store.state.stale === false);

const grouped = store.groupByLetter(store.state.vocabWords);
check("store.groupByLetter buckets by first letter", grouped.length >= 1 && grouped[0].letter === "I");
const metrics = store.overview();
check("store.overview reports metrics", typeof metrics.totalWords === "number" && metrics.diaryDays === 1, JSON.stringify(metrics));
check(
  "store.diaryByDate indexes BOTH pages of one date in page order",
  (() => {
    const pages = store.diaryByDate().get("2026-02-14") ?? [];
    return pages.length === 2 && pages[0].id === "d1" && pages[1].id === "d2";
  })(),
);
check("store.sortedEvents returns newest first", store.sortedEvents().length >= 1);

const annotated = await store.annotateWord({ word: "Sunny", lemma: "sunny", glossZh: "晴朗的", source: "webtest", sentence: "It was sunny." });
check("store.annotateWord confirms with the host", annotated.ok === true, JSON.stringify(annotated));
check("store adopts the host's merged word list", store.state.vocabWords.some((word) => word.lemma === "sunny"));
check("store clears the pending flag once confirmed", store.state.pending.sunny === undefined, JSON.stringify(store.state.pending));

const changed = await store.updateWord("sunny", { status: "mastered" });
check("store.updateWord persists a status change", changed.ok === true && store.state.vocabWords.find((word) => word.id === "sunny")?.status === "mastered");

const settingsSave = await store.saveSettings({ tts: { lang: "en-US", rate: 1, pitch: 1 } });
check("store.saveSettings adopts the returned settings", settingsSave.ok === true && settingsSave.settings?.tts?.rate === 1);

/* -- components ---------------------------------------------------------- */

const detail = components.wordDetailBody(store.state.vocabWords.find((word) => word.lemma === "park"), {});
check("components.wordDetailBody renders inflections", detail.textContent.includes("复数") && detail.textContent.includes("parks"));
check("components.wordDetailBody renders examples", detail.textContent.includes("We walked in the park."));
check("components.wordDetailBody renders the annotation source", detail.textContent.includes("日记分区"));
check("components.wordDetailBody renders the status switcher", detail.textContent.includes("已掌握"));
const highlighted = components.highlightWord("Yesterday I went to the park.", "park");
check("components.highlightWord marks the match", highlighted.textContent === "Yesterday I went to the park." && highlighted.childNodes.some((node) => node.nodeName === "EM"));

/* -- views --------------------------------------------------------------- */

const outlet = ui.h("div", { class: "outlet" });
const router = routerModule.createRouter(
  [
    { path: "/", render: homeView },
    { path: "/diary", render: diaryView },
    { path: "/diary/:date", render: diaryView },
    { path: "/diary/:date/:page", render: diaryView },
    { path: "/webtest", render: webtestView },
    { path: "/vocab", render: vocabView },
    { path: "/settings", render: settingsView },
  ],
  { outlet },
);

const rendered = {};
for (const [hash, label] of [
  ["#/", "home"],
  ["#/diary", "diary"],
  ["#/diary/2026-02-14", "diary detail"],
  ["#/diary/2026-02-14/2", "diary page 2"],
  // A date with NO page 1 at all, opened as page 2 — the lazy rule must hold here.
  ["#/diary/2026-03-01/2", "diary orphan page"],
  ["#/webtest", "webtest"],
  ["#/vocab", "vocab"],
  ["#/settings", "settings"],
]) {
  locationStub.hash = hash;
  router.refresh();
  const text = outlet.textContent;
  rendered[label] = text;
  const bad = text.includes("页面渲染失败") || text.includes("界面渲染出错") || text.length === 0;
  check(`view renders: ${label}`, !bad, text.slice(0, 300));
}

check("home view shows the three section entry tiles", rendered.home.includes("日记分区") && rendered.home.includes("其它文本处理区") && rendered.home.includes("标注单词库"));
check("home view shows the overview metrics", rendered.home.includes("今日新增"));
check("diary calendar marks a day with entries", outlet.childNodes.length === 1 && rendered["diary"].includes("2026 年"));
check("diary detail renders the single photo slot", rendered["diary detail"].includes("抄写标注稿") && !rendered["diary detail"].includes("原稿"));
check(
  "diary landing page offers an upload zone",
  rendered.diary.includes("上传今天的抄写标注稿") && rendered.diary.includes("选择图片"),
);
check("diary detail offers the one-click import", rendered["diary detail"].includes("识别并入库"));
check("diary detail shows the extracted English page", rendered["diary detail"].includes("Yesterday I went to the park."));
check(
  "diary detail has no click-to-annotate prompt",
  !rendered["diary detail"].includes("加入标注单词库") && !rendered["diary detail"].includes("仅英文"),
);
check(
  "diary page 1 offers the next page at its top right",
  rendered["diary detail"].includes("下一篇") && rendered["diary detail"].includes("第 1 篇"),
  rendered["diary detail"].slice(0, 200),
);
check(
  "diary page 2 is reachable and shows its own sheet",
  rendered["diary page 2"].includes("第 2 篇") && rendered["diary page 2"].includes("The afternoon turned cold."),
);
check(
  "diary page 2 offers the way back to page 1",
  rendered["diary page 2"].includes("上一篇"),
);
check(
  "a page the day never reached is not offered a next page",
  !rendered["diary orphan page"].includes("下一篇"),
  rendered["diary orphan page"].slice(0, 200),
);
check("webtest view renders the input stage", rendered.webtest.includes("确认识别") || rendered.webtest.includes("输入") || rendered.webtest.includes("粘贴"));
check("vocab view renders both classification modes", rendered.vocab.includes("按标注时间") && rendered.vocab.includes("按首字母"));
check("vocab view lists a known word", rendered.vocab.includes("park"));
check("settings view renders the free GLM provider", rendered.settings.includes("智谱") && !rendered.settings.includes("豆包") && !rendered.settings.includes("DeepSeek"));
check(
  "settings view renders an editor for each of the four prompts",
  ["① 抄写提示词", "② 标注单词提示词", "③ 固定搭配提示词", "其它文本提示词"].every((label) =>
    rendered.settings.includes(label),
  ),
);
check("settings view renders the data card heading", rendered.settings.includes("数据与存储"));

/* -- R1: a real double click must import exactly once --------------------- */

/** Depth-first search of the DOM stub for a BUTTON/LABEL whose text matches. */
function findByText(node, needle, out = []) {
  if (node === null || node === undefined) return out;
  const name = String(node.nodeName ?? "").toUpperCase();
  if ((name === "BUTTON" || name === "LABEL") && String(node.textContent ?? "").includes(needle)) out.push(node);
  for (const child of node.childNodes ?? []) findByText(child, needle, out);
  return out;
}

const settle = async (rounds = 6) => {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** Depth-first search of the DOM stub for nodes whose tag name matches. */
function findByTag(node, tag, out = []) {
  if (node === null || node === undefined) return out;
  if (String(node.nodeName ?? "").toUpperCase() === tag) out.push(node);
  for (const child of node.childNodes ?? []) findByTag(child, tag, out);
  return out;
}

/* -- the photo picker must be reachable without a programmatic click ------- */
// The reported bug: the diary landing page had no upload at all, and the day
// detail only had a small 上传 button. A `<label>` that WRAPS its
// `<input type="file">` opens the picker natively; a button that calls `.click()`
// does not work everywhere and cannot be tested here. So the shape itself is the
// assertion. 2026-03-01 has no entry, which is what renders the empty slot.
locationStub.hash = "#/diary/2026-03-01";
router.refresh();
{
  const labels = findByTag(outlet, "LABEL").filter((node) => String(node.className ?? "").includes("photo-add"));
  const inputs = labels.flatMap((label) => findByTag(label, "INPUT").filter((input) => input.getAttribute("type") === "file"));
  check("picker: the empty photo slot is a clickable label", labels.length === 1, `labels=${labels.length}`);
  check("picker: that label owns the file input", inputs.length === 1, `inputs=${inputs.length}`);
  const slot = labels[0] ?? null;
  const parent = slot?.parentNode ?? null;
  const dropHandlers = parent?.listeners?.get("drop") ?? [];
  const overHandlers = parent?.listeners?.get("dragover") ?? [];
  check(
    "picker: the slot accepts a dropped file",
    String(slot?.getAttribute("title") ?? "").includes("拖") && dropHandlers.length === 1 && overHandlers.length === 1,
    `title=${slot?.getAttribute("title")} drop=${dropHandlers.length} dragover=${overHandlers.length}`,
  );
}

// A day that already has a photo keeps the picture and offers 替换图片 / 移除.
locationStub.hash = "#/diary/2026-02-14";
router.refresh();
{
  const replace = findByText(outlet, "替换图片");
  check("picker: a stored photo offers a replace label", replace.length === 1, `found=${replace.length}`);
  check(
    "picker: no 原稿 slot survives anywhere in the diary",
    !outlet.textContent.includes("原稿"),
  );
}

// The landing page must offer the same thing without a date in the URL.
locationStub.hash = "#/diary";
router.refresh();
{
  const zoneInputs = findByTag(outlet, "INPUT").filter((input) => input.getAttribute("type") === "file");
  const labelForZone = findByTag(outlet, "LABEL").filter((node) => String(node.textContent ?? "").includes("选择图片"));
  const zone = labelForZone[0]?.parentNode ?? null;
  check("picker: the landing page itself has a file input", zoneInputs.length === 1, `inputs=${zoneInputs.length}`);
  check("picker: the landing page label opens it", labelForZone.length === 1 && findByTag(labelForZone[0], "INPUT").length === 1);
  check(
    "picker: the landing page zone accepts a dropped file",
    (zone?.listeners?.get("drop") ?? []).length === 1 && (zone?.listeners?.get("dragover") ?? []).length === 1,
    `class=${zone?.className}`,
  );
}

locationStub.hash = "#/diary/2026-02-14";
router.refresh();
const importButtons = findByText(outlet, "识别并入库");
check("R1: the one-click import button is reachable in the DOM", importButtons.length === 1, `found=${importButtons.length}`);
if (importButtons.length === 1) {
  const before = controls.importCalls;
  // Click one: the guard flips synchronously and the view re-renders, so the
  // node we captured is already detached — exactly like a real fast double click.
  importButtons[0].click();
  const inFlight = findByText(outlet, "识别中");
  check(
    "R1: the import button re-renders disabled and in-flight",
    inFlight.length === 1 && inFlight[0].getAttribute("disabled") !== null,
    `found=${inFlight.length} disabled=${inFlight[0]?.getAttribute("disabled")}`,
  );
  // Click two lands on the NEW button; the stub dispatches even while disabled,
  // so only the `submitting` guard can keep this to a single request.
  if (inFlight.length === 1) inFlight[0].click();
  await settle();
  check(
    "R1: a double click imports exactly once",
    controls.importCalls - before === 1,
    `calls=${controls.importCalls - before}`,
  );
  check(
    "R1: the import carries the page number it was opened on",
    controls.importSeq === 1,
    `seq=${controls.importSeq}`,
  );
}

// The data card fills in from async calls (storageMode / health), so it can only
// be asserted after the microtask queue and the canned /health response settle.
locationStub.hash = "#/settings";
router.refresh();
await new Promise((resolve) => setTimeout(resolve, 60));
const settingsSettled = outlet.textContent;
check(
  "settings data card fills in asynchronously",
  settingsSettled.includes("导出 CSV") && settingsSettled.includes("立即同步"),
  settingsSettled.slice(0, 400),
);

/* router teardown: a view must unsubscribe, or a long session leaks listeners */
locationStub.hash = "#/vocab";
router.refresh();
const vocabNode = outlet.firstChild;
check("router exposes the mounted view node", vocabNode !== null && typeof vocabNode.__dispose === "function", String(typeof vocabNode?.__dispose));
let disposed = false;
if (vocabNode !== null) {
  const originalDispose = vocabNode.__dispose;
  vocabNode.__dispose = () => {
    disposed = true;
    originalDispose();
  };
}
locationStub.hash = "#/settings";
router.refresh();
check("router disposes the outgoing view", disposed === true);
check("router.current reports the active path", router.current() === "/settings", router.current());
check("router falls back for an unknown path", (() => {
  locationStub.hash = "#/nope";
  router.refresh();
  return outlet.textContent.includes("页面不存在");
})());

/* -- hash round trip ----------------------------------------------------- */

locationStub.hash = "#/diary/2026-02-14";
router.refresh();
check("deep link renders the dated detail", outlet.textContent.includes("2026年2月14日"), outlet.textContent.slice(0, 200));

/* ================================================================ report === */

console.log("");
console.log(`${pass}/${pass + fail} checks passed`);
if (fail > 0) {
  console.log("");
  console.log("Failures:");
  for (const item of failures) console.log(`  - ${item}`);
}
process.exit(fail === 0 ? 0 : 1);

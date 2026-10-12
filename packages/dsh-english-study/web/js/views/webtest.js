/**
 * 其它文本处理区 —— 任何不是日记照片的文本都在这里处理：
 * 一个单词、一个长句、粘贴的整段文章，或者粘贴/拖入的一张图片。
 *
 * 三段式流程，每一段都容错：
 *   ① 输入        —— 文本域（可在光标处直接粘贴图片）、拖放区、图片文件选择。
 *   ② 确认与纠错  —— 调 `api.normalize()`：可手改的英文正文、改错对照表、英中逐句对照。
 *   ③ 英文标注    —— 英文里每个单词都能点，确认后入词库；下方实时列出本次标注的词。
 *
 * 只有一家服务商：智谱 GLM-4V-Flash。本文件里没有任何其它服务商的分支。
 *
 * 两个已修复的线上缺陷（用户实测报告）：
 *   (a) 确认之后页面空白 —— 预览永远有内容：`data.corrected` → `segments[].en` → 本地解析/原文。
 *   (b) 纯中文输入之后进入只有中文的最终页，朗读不了 —— 第三步的阅读器只用英文构建，
 *       构建完还要断言里面真的有拉丁字母（`/[A-Za-z]/`），否则明确报错并给「重新解析」。
 *
 * 硬性约定（写错就会白屏，不要改）：
 *   · 无构建 ESM：没有 JSX、没有打包器，DOM 一律走 `h(tag, props, ...children)`。
 *   · 绝不使用 `querySelector` / `querySelectorAll` / `innerHTML` 绑事件 —— 无头测试
 *     （tools\smoke-web.mjs）把 querySelector 打桩成 null、querySelectorAll 打桩成 []。
 *     所有节点都留直接引用，事件走 `h()` 的 onClick / onInput / onPaste。
 *   · `export default function render({ params, query })` 返回 DOM 节点，返回前必须设置
 *     `root.__dispose`，其中的退订函数负责清掉 `subscribe(...)`。
 */

import { h, mount, toast } from "../ui.js";
import { state, subscribe, refresh, updateWord, deleteWord } from "../store.js";
import { api, isOnline } from "../api.js";
import { wordCard, speakButton } from "../components.js";
import { tts } from "../tts.js";
import { parseBilingual, splitEnglish, stemOf, hasLatin } from "../parse.js";

/** 本视图的操作来源标记，主机按它区分日记与文本。 */
const SOURCE = "webtest";

/** 图片按 6 MiB 卡住：主机上限 8 MiB，请求体上限 12 MiB。 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** 一个逻辑操作一个稳定 id，重试时复用，主机据此去重。 */
function makeRequestId() {
  const uuid = globalThis.crypto?.randomUUID;
  if (typeof uuid === "function") {
    try {
      return uuid.call(globalThis.crypto);
    } catch {
      /* 沙箱里 crypto.randomUUID 可能被禁用，退回到时间戳 */
    }
  }
  return `webtest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 展平 children：`h` 允许 null / false / 数组混排。 */
function flatten(children) {
  const list = [];
  for (const child of children ?? []) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) list.push(...flatten(child));
    else list.push(child);
  }
  return list;
}

function compact(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").trim();
}

/** 词形变化 / 例句的形状是主机定的，缺失时退化为空数组，绝不让 view 崩。 */
function inflectionsOf(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (entry === null || typeof entry !== "object") return null;
      const form = compact(entry.form ?? entry.value ?? entry.text);
      if (form.length === 0) return null;
      return { form, label: compact(entry.label ?? entry.type ?? entry.name) || "变形" };
    })
    .filter((entry) => entry !== null);
}

function examplesOf(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === "string") {
        const en = compact(entry);
        return en.length > 0 ? { en, zh: "" } : null;
      }
      if (entry === null || typeof entry !== "object") return null;
      const en = compact(entry.en ?? entry.english ?? entry.text);
      if (en.length === 0) return null;
      return { en, zh: compact(entry.zh ?? entry.chinese ?? entry.translation) };
    })
    .filter((entry) => entry !== null);
}

function collocationsOf(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => compact(entry)).filter((entry) => entry.length > 0);
}

/** 主机历史上用过 `from`/`to` 与 `original`/`corrected` 两套键名，两套都收。 */
function correctionsOf(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === "string") {
        const to = compact(entry);
        return to.length > 0 ? { from: "", to, reason: "" } : null;
      }
      if (entry === null || typeof entry !== "object") return null;
      const from = compact(entry.from ?? entry.original ?? entry.wrong ?? entry.src);
      const to = compact(entry.to ?? entry.corrected ?? entry.right ?? entry.dst);
      const reason = compact(entry.reason ?? entry.why ?? entry.explain ?? entry.note);
      return from.length > 0 || to.length > 0 ? { from, to, reason } : null;
    })
    .filter((entry) => entry !== null);
}

function segmentsOf(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === "string") {
        const en = compact(entry);
        return en.length > 0 ? { en, zh: "" } : null;
      }
      if (entry === null || typeof entry !== "object") return null;
      const en = compact(entry.en ?? entry.english ?? entry.text ?? entry.corrected);
      if (en.length === 0) return null;
      return { en, zh: compact(entry.zh ?? entry.chinese ?? entry.translation ?? entry.meaning) };
    })
    .filter((entry) => entry !== null);
}

/**
 * 缺陷 (a) 的修复点：预览永不空白。
 * 顺序固定为 主机 corrected → segments[].en 拼接 → 本地解析出的英文 → 用户原始输入。
 */
function pickPreviewText(data, fallbackText) {
  const segs = segmentsOf(data?.segments);
  const candidates = [
    normalizeText(data?.corrected),
    segs.map((segment) => segment.en).join(" "),
    localEnglish(fallbackText),
    normalizeText(fallbackText),
  ];
  for (const candidate of candidates) {
    if (candidate.length > 0) return candidate;
  }
  return "";
}

/** 本地解析（parse.js）能拿到的英文，纯中文时为空串。 */
function localEnglish(text) {
  try {
    const parsed = parseBilingual(String(text ?? ""));
    return parsed.pairs
      .map((pair) => normalizeText(pair.en))
      .filter((line) => line.length > 0)
      .join(" ");
  } catch {
    return "";
  }
}

function localPairs(text) {
  try {
    const parsed = parseBilingual(String(text ?? ""));
    return parsed.pairs
      .map((pair) => ({ en: normalizeText(pair.en), zh: normalizeText(pair.zh) }))
      .filter((pair) => pair.en.length > 0 || pair.zh.length > 0);
  } catch {
    return [];
  }
}

/**
 * 把英文正文切成句子，并尽量带上中文。
 * 有主机的 segments 时优先用它的句子边界与译文；用户手改过正文时按句号重切，
 * 再按序对齐原先的译文（对不齐就留空，绝不把整段译文贴到某一句话上）。
 */
function buildPairs(english, segments) {
  const text = normalizeText(english);
  const segs = segmentsOf(segments);
  const sentences = splitEnglish(text).filter((line) => line.length > 0);
  if (sentences.length === 0) return [];
  const segText = segs
    .map((segment) => segment.en)
    .join(" ")
    .trim();
  if (segText === text) return segs.map((segment) => ({ en: segment.en, zh: segment.zh }));
  return sentences.map((en, index) => {
    const matched = segs.find((segment) => segment.en === en);
    if (matched !== undefined) return { en, zh: matched.zh };
    return { en, zh: segs[index]?.zh ?? "" };
  });
}

/** 第三步阅读器的干净数据源：只用英文。 */
function readerPairs(finalText, segments) {
  const text = normalizeText(finalText);
  if (text.length === 0) return [];
  return buildPairs(text, segments);
}

export default function render({ params, query } = {}) {
  void params;
  void query;

  const root = h("div", { class: "view" });

  /* ------------------------------------------------------------------ 状态 */

  let stage = "input";
  let submitting = false;
  /** 同一时刻只允许一个 LLM 请求在飞。 */
  let llmBusy = false;
  /** 正在解析：① 解析并翻译 / ② 重新解析 共用一个锁定。 */
  let normalizing = false;
  /** 正在取词条详情（api.lexeme）。 */
  let lexemeBusy = false;
  /** 正在确认（api.annotate）。 */
  let annotating = false;

  let rawInput = "";
  let requestId = makeRequestId();
  /** 最近一次 api.normalize 的响应。 */
  let normalizeResult = null;
  /** 第三步阅读器的最终英文（可能是用户手改过的）。 */
  let finalText = "";
  /** 生成 finalText 时所用的英中句子对照。 */
  let finalSegments = [];

  let selectedToken = null;
  /** ③ 里确认按钮的直接引用（每次渲染新建，不能用选择器去找）。 */
  let annotateButton = null;
  /** 已确认入词库的单词（小写）。 */
  const annotatedTokens = new Set();
  /** 本次会话标注成功的词条：key 为小写 lemma。 */
  const sessionWords = new Map();
  /** word(小写) -> lexeme 查询状态。 */
  const lexemeCache = new Map();
  /** word(小写) -> 已读到的词条详情。 */
  const lexemeData = new Map();
  /** 已经点过的词，重渲染后仍是选中态。 */
  const lexemeErrors = new Map();
  /** 待发送的粘贴/拖入图片（base64）。 */
  let pendingImages = [];

  /* ------------------------------------------------------------- DOM 骨架 */

  const bodyEl = h("div", { class: "stack" });
  const headerTitle = h("h1", null, "其它文本处理区");
  const headerSub = h("p", { class: "muted" }, "");
  const offlineAlert = h(
    "div",
    { class: "alert warn", hidden: true },
    h("div", { class: "alert-body" }, h("div", { class: "alert-title" }, "当前离线"), h("div", null, "联网后才能调用解析与词条接口；本页的英文阅读与朗读仍可用。")),
  );

  const rootCard = h(
    "div",
    { class: "card" },
    h("div", { class: "card-head" }, headerTitle, h("div", { class: "card-sub" }, headerSub)),
    offlineAlert,
    bodyEl,
  );
  root.appendChild(rootCard);

  /* -------------------------------------------------------------- 小工具 */

  /** 统一的提交入口：重复点击直接返回，按钮立刻禁用并换成加载文案。 */
  async function withSubmit(button, busyLabel, action) {
    if (submitting) return;
    submitting = true;
    const original = button?.dataset?.originalLabel ?? button?.textContent ?? "";
    if (button !== null && button !== undefined) {
      button.dataset.originalLabel = original;
      button.disabled = true;
      button.textContent = busyLabel;
    }
    updateButtons();
    try {
      await action();
    } catch (error) {
      console.error("[english-study] 其它文本处理区操作失败:", error);
      toast(`操作失败：${error?.message ?? error}`, "bad", { timeoutMs: 9000 });
    } finally {
      submitting = false;
      if (button !== null && button !== undefined) {
        button.textContent = button.dataset?.originalLabel ?? original;
      }
      updateButtons();
    }
  }

  /** 主机/网络失败：只提示 + 一个「重试」按钮，重试逻辑在本视图里，不在本视图里自旋。 */
  function failToast(error, label, retry) {
    const message = `${label}失败：${error?.message ?? error}`;
    toast(message, "bad", {
      timeoutMs: 12000,
      action: typeof retry === "function" ? { label: "重试", onClick: () => void retry() } : undefined,
    });
  }

  /** 是否还有请求在飞。 */
  function busy() {
    return llmBusy || normalizing || lexemeBusy || annotating;
  }

  /** 词库里已有的词（按 lemma 小写比对）。 */
  function bankWord(lemma) {
    const key = compact(lemma).toLowerCase();
    if (key.length === 0) return null;
    return state.vocabWords.find((word) => compact(word.lemma).toLowerCase() === key) ?? null;
  }

  /**
   * 这个词（或它的一个形态）是不是已经在词库里？
   * 形态匹配用词形变化表做，不用 stemOf —— stemOf("was") 会得到 "wa"，
   * 那会让 "wa" 之类的无关词条把 "was" 误判成已标注。
   */
  function knownWordInBank(display) {
    const key = compact(display).toLowerCase();
    if (key.length === 0) return null;
    const exact = bankWord(key);
    if (exact !== null) return exact;
    return (
      state.vocabWords.find((word) =>
        (Array.isArray(word.inflections) ? word.inflections : []).some(
          (entry) => compact(entry?.form).toLowerCase() === key,
        ),
      ) ?? null
    );
  }

  /* --------------------------------------------------------- ① 输入阶段 */

  const textareaEl = h("textarea", {
    class: "mono",
    rows: "8",
    placeholder: "粘贴一个单词、一个长句或整段文章；也可以在这里直接粘贴图片（Ctrl+V）。",
    onInput: () => {
      rawInput = textareaEl.value;
    },
    onPaste: (event) => handlePaste(event),
  });

  const fileInputEl = h("input", {
    type: "file",
    accept: "image/*",
    multiple: true,
    style: { display: "none" },
    onChange: () => {
      const files = [...(fileInputEl.files ?? [])];
      for (const file of files) void readImageFile(file);
      fileInputEl.value = "";
    },
  });

  const thumbsEl = h("div", { class: "row wrap gap-8" });

  const dropzoneEl = h(
    "div",
    {
      class: "drop-zone",
      style: { border: "1px dashed var(--border)", borderRadius: "10px", padding: "14px", cursor: "pointer" },
      onClick: () => fileInputEl.click(),
      onPaste: (event) => handlePaste(event),
      onDragover: (event) => {
        event.preventDefault?.();
      },
      onDrop: (event) => {
        event.preventDefault?.();
        const files = [...(event.dataTransfer?.files ?? [])];
        for (const file of files) void readImageFile(file);
      },
    },
    h("div", { class: "muted" }, "把图片拖到这里，或点击选择文件；也可以直接在上面的文本域里粘贴截图。"),
    fileInputEl,
    thumbsEl,
  );

  const submitButton = h(
    "button",
    {
      type: "button",
      class: "primary",
      onClick: (event) => {
        void withSubmit(event?.target ?? submitButton, "解析中…", () => runNormalize({ reuseRequestId: false }));
      },
    },
    "① 解析并翻译",
  );

  const localParseButton = h(
    "button",
    {
      type: "button",
      class: "sm",
      title: "使用本地双语解析（parse.js），不调用任何接口、不产生费用",
      onClick: (event) => {
        void withSubmit(event?.target ?? localParseButton, "解析中…", () => {
          const text = normalizeText(textareaEl.value);
          if (text.length === 0) {
            toast("请先粘贴要处理的文本", "warn");
            return;
          }
          rawInput = text;
          normalizeResult = {
            ok: true,
            degraded: false,
            task: "normalize",
            parseError: null,
            rawText: "",
            data: {
              language: hasLatin(text) ? "en" : "zh",
              corrected: localEnglish(text),
              corrections: [],
              segments: localPairs(text),
            },
          };
          showStage("confirm");
          toast("已使用本地解析（不调用接口）", "ok");
        });
      },
    },
    "本地解析（不调用接口）",
  );

  function renderInput() {
    mount(
      bodyEl,
      h(
        "div",
        { class: "stack" },
        h("div", { class: "segment-tabs" }, h("span", { class: "chip accent" }, "① 输入")),
        textareaEl,
        dropzoneEl,
        h(
          "div",
          { class: "row gap-8" },
          submitButton,
          localParseButton,
          h("div", { class: "spacer" }),
          h("span", { class: "faint small" }, "服务商：智谱 GLM-4V-Flash（免费识图）"),
        ),
      ),
    );
    renderThumbs();
  }

  function renderThumbs() {
    if (pendingImages.length === 0) {
      mount(thumbsEl, h("span", { class: "faint small" }, "尚未添加图片"));
      return;
    }
    mount(
      thumbsEl,
      pendingImages.map((image, index) =>
        h(
          "span",
          { class: "row gap-8", style: { alignItems: "center" } },
          h("img", {
            src: image.dataUrl,
            alt: image.name || `图片 ${index + 1}`,
            style: { maxHeight: "64px", maxWidth: "96px", objectFit: "cover", borderRadius: "6px" },
          }),
          h("span", { class: "faint small" }, image.name || `图片 ${index + 1}`),
          h(
            "button",
            {
              type: "button",
              class: "ghost sm",
              "aria-label": "移除图片",
              onClick: () => {
                pendingImages = pendingImages.filter((_, at) => at !== index);
                renderThumbs();
              },
            },
            "移除",
          ),
        ),
      ),
    );
  }

  /** 读一张图片为 base64；文件读取本身不花接口费用。 */
  function readImageFile(file) {
    return new Promise((resolve) => {
      if (file === null || file === undefined) {
        resolve(null);
        return;
      }
      const type = String(file.type ?? "");
      if (!type.startsWith("image/")) {
        toast(`「${file.name || "文件"}」不是图片，已跳过`, "warn");
        resolve(null);
        return;
      }
      if (typeof FileReader !== "function") {
        toast("当前环境不支持读取本地文件", "warn");
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : "";
        if (base64.length === 0) {
          toast("图片读取失败", "bad");
          resolve(null);
          return;
        }
        if (base64.length * 0.75 > MAX_IMAGE_BYTES) {
          toast(`「${file.name || "图片"}」超过 6 MB，请压缩后再试`, "warn");
          resolve(null);
          return;
        }
        pendingImages.push({ base64, mimeType: type, name: String(file.name ?? ""), dataUrl });
        renderThumbs();
        resolve(base64);
      };
      reader.onerror = () => {
        toast("图片读取失败", "bad");
        resolve(null);
      };
      reader.readAsDataURL(file);
    });
  }

  /** 文本域与拖放区共用的粘贴处理：图片走图片区，文字交给浏览器默认插入。 */
  function handlePaste(event) {
    const items = [...(event?.clipboardData?.items ?? [])];
    const imageItems = items.filter((item) => String(item.type ?? "").startsWith("image/"));
    if (imageItems.length === 0) return;
    event.preventDefault?.();
    for (const item of imageItems) {
      const file = typeof item.getAsFile === "function" ? item.getAsFile() : null;
      if (file !== null && file !== undefined) void readImageFile(file);
    }
  }

  /* ------------------------------------------------------ ② 确认与纠错 */

  const confirmAlertEl = h("div", { class: "stack" });
  const correctionsEl = h("div", { class: "stack" });
  const previewArea = h("textarea", {
    rows: "7",
    placeholder: "英文正文（可手改）",
    onInput: () => {
      /* 手改期间不重新渲染，避免抢走光标；点③时才读回本文。 */
    },
  });
  const parallelEl = h("div", { class: "parallel" });
  const confirmButton = h(
    "button",
    {
      type: "button",
      class: "primary",
      onClick: (event) => {
        void withSubmit(event?.target ?? confirmButton, "处理中…", () => confirmStage());
      },
    },
    "③ 确认，进入英文标注",
  );
  const reparseButton = h(
    "button",
    {
      type: "button",
      onClick: (event) => {
        void withSubmit(event?.target ?? reparseButton, "重新解析中…", () => runNormalize({ reuseRequestId: false }));
      },
    },
    "重新解析",
  );

  function renderConfirm() {
    const data = normalizeResult?.data ?? {};
    const degraded = normalizeResult?.degraded === true;
    const corrections = correctionsOf(data.corrections);
    const segments = segmentsOf(data.segments);
    const previewText = previewArea.value.length > 0 ? previewArea.value : "";

    /* --- 降级提示：解析失败也要把原文摆出来 --- */
    if (degraded) {
      mount(
        confirmAlertEl,
        h(
          "div",
          { class: "alert warn" },
          h(
            "div",
            { class: "alert-body" },
            h("div", { class: "alert-title" }, "结果解析失败，已降级显示原文"),
            h("div", { class: "small faint" }, normalizeResult?.parseError ? `原因：${normalizeResult.parseError}` : "模型返回的内容不是可解析的 JSON。"),
            h("div", { class: "quote mono small pre-wrap" }, String(normalizeResult?.rawText ?? "").slice(0, 4000)),
          ),
          h(
            "button",
            {
              type: "button",
              class: "sm",
              onClick: (event) => {
                void withSubmit(event?.target ?? reparseButton, "重新解析中…", () => runNormalize({ reuseRequestId: false }));
              },
            },
            "重新解析",
          ),
        ),
      );
    } else {
      mount(confirmAlertEl);
    }

    /* --- 改错对照表 --- */
    if (corrections.length === 0) {
      mount(
        correctionsEl,
        h("div", { class: "small faint" }, "未发现需要修改的地方"),
      );
    } else {
      mount(
        correctionsEl,
        h("div", { class: "small faint mb-8" }, `共 ${corrections.length} 处修改`),
        h(
          "div",
          { class: "diff-list" },
          corrections.map((correction) =>
            h(
              "div",
              { class: "diff-row" },
              correction.from.length > 0
                ? h("span", { style: { textDecoration: "line-through" }, class: "mono" }, correction.from)
                : h("span", { class: "faint" }, "（整句）"),
              h("span", { class: "faint" }, "→"),
              h("span", { class: "mono" }, correction.to),
              correction.reason.length > 0 ? h("span", { class: "small faint" }, correction.reason) : null,
            ),
          ),
        ),
      );
    }

    /* --- 英文正文（可手改） --- */
    if (previewArea.value.length === 0) previewArea.value = pickPreviewText(data, rawInput);
    if (previewArea.value.length === 0) {
      // 到这一步仍然空，只能说明输入本身就是空的：明确说出来，不留白屏。
      previewArea.value = "";
    }

    /* --- 英中逐句对照 --- */
    const pairs = buildPairs(previewArea.value, segments);
    if (pairs.length === 0) {
      mount(
        parallelEl,
        h("div", { class: "small faint" }, "还没有可朗读的英文句子：请先把上面的英文正文补全。"),
      );
    } else {
      mount(
        parallelEl,
        pairs.map((pair) =>
          h(
            "div",
            { class: "parallel-row" },
            h(
              "div",
              { class: "row gap-8" },
              h("span", { style: { flex: "1 1 auto" } }, pair.en),
              speakButton(pair.en, { label: "🔊", title: "朗读这句英文" }),
            ),
            pair.zh.length > 0 ? h("div", { class: "small faint" }, pair.zh) : h("div", { class: "small faint" }, "（未提供中文）"),
          ),
        ),
      );
    }

    const language = compact(data.language);
    mount(
      bodyEl,
      h(
        "div",
        { class: "stack" },
        h(
          "div",
          { class: "segment-tabs" },
          h("span", { class: "chip accent" }, "② 确认与纠错"),
          language.length > 0 ? h("span", { class: "chip" }, `识别语言：${language}`) : null,
          h("span", { class: "chip" }, `${pairs.length} 句`),
        ),
        confirmAlertEl,
        h("div", { class: "small faint" }, "英文正文（可手改；改完点③，以这里的内容为准）"),
        previewArea,
        h("div", { class: "small faint mt-12" }, "改错对照"),
        correctionsEl,
        h("div", { class: "small faint mt-12" }, "逐句对照"),
        parallelEl,
        h(
          "div",
          { class: "row gap-8" },
          confirmButton,
          reparseButton,
          h("div", { class: "spacer" }),
          h("span", { class: "faint small" }, "服务商：智谱 GLM-4V-Flash"),
        ),
      ),
    );
    updateButtons();
  }

  /* --------------------------------------------------------- ③ 英文标注 */

  const readerEl = h("div", { class: "reader" });
  const stage3AlertEl = h("div", { class: "stack" });
  const selectionEl = h("div", { class: "stack" });
  const sessionListEl = h("div", { class: "word-list" });
  const readAllButton = h(
    "button",
    {
      type: "button",
      class: "sm",
      onClick: () => {
        const sentences = readerPairs(finalText, finalSegments).map((pair) => pair.en);
        if (sentences.length === 0) {
          toast("没有可朗读的英文", "warn");
          return;
        }
        if (!tts.isSupported()) {
          toast("当前浏览器不支持语音合成", "warn");
          return;
        }
        void tts.speakSequence(sentences, {
          lang: tts.DEFAULT_LANG ?? "en-US",
          rate: tts.DEFAULT_RATE ?? 0.9,
          onError: (error) => toast(`朗读失败：${error?.message ?? error}`, "bad"),
        });
      },
    },
    "🔊 朗读整篇英文",
  );

  /**
   * 用最终英文构建阅读器。
   * 缺陷 (b) 的修复点：只用英文；构建完断言真的有拉丁字母，否则不渲染阅读器。
   */
  function renderStage3() {
    const text = normalizeText(finalText);
    const pairs = readerPairs(text, finalSegments);
    const english = pairs.map((pair) => pair.en).join(" ").trim();

    if (english.length === 0 || !hasLatin(english)) {
      mount(
        stage3AlertEl,
        h(
          "div",
          { class: "alert bad" },
          h(
            "div",
            { class: "alert-body" },
            h("div", { class: "alert-title" }, "没有生成英文，无法朗读"),
            h("div", { class: "small" }, "这一步的阅读器只能由英文构成；当前结果里没有拉丁字母，可能是输入只有中文、或模型没有给出英文。"),
            h("div", { class: "quote mono small pre-wrap" }, String(normalizeResult?.rawText ?? finalText).slice(0, 2000)),
          ),
          h(
            "button",
            {
              type: "button",
              class: "sm",
              onClick: (event) => {
                void withSubmit(event?.target ?? reparseButton, "重新解析中…", () => runNormalize({ reuseRequestId: false }));
              },
            },
            "重新解析",
          ),
        ),
      );
      mount(readerEl);
    } else {
      mount(stage3AlertEl);
      renderReader(pairs);
    }

    mount(
      bodyEl,
      h(
        "div",
        { class: "stack" },
        h(
          "div",
          { class: "segment-tabs" },
          h("span", { class: "chip accent" }, "③ 英文标注"),
          h("span", { class: "chip" }, `${pairs.length} 句`),
          h("span", { class: "chip" }, `本次已标注 ${sessionWords.size} 词`),
        ),
        stage3AlertEl,
        readerEl,
        selectionEl,
        h(
          "div",
          { class: "row gap-8" },
          readAllButton,
          h(
            "button",
            {
              type: "button",
              class: "sm",
              onClick: () => showStage("confirm"),
            },
            "← 返回修改英文",
          ),
          h("div", { class: "spacer" }),
          h("span", { class: "faint small" }, "点一个单词即可加入词库"),
        ),
        h("div", { class: "card-head mt-12" }, h("h2", null, "本次标注的词")),
        sessionListEl,
      ),
    );
    renderSelection();
    renderSession();
    updateButtons();
  }

  /** 逐句渲染：英文里每个单词都是可点的按钮，标点保持原样。 */
  function renderReader(pairs) {
    mount(
      readerEl,
      pairs.map((pair, pairIndex) =>
        h(
          "div",
          { class: "row gap-8", style: { alignItems: "flex-start", marginBottom: "6px" } },
          speakButton(pair.en, { label: "🔊", title: "朗读这句英文" }),
          h(
            "span",
            { style: { flex: "1 1 auto" } },
            ...tokenizeSentence(pair.en, pairIndex),
          ),
          pair.zh.length > 0 ? h("span", { class: "small faint nowrap", style: { maxWidth: "38%" } }, pair.zh) : null,
        ),
      ),
    );
  }

  /** 拆成「单词按钮 + 标点文本」的序列。 */
  function tokenizeSentence(sentence, pairIndex) {
    const parts = String(sentence).split(/([A-Za-z][A-Za-z'’-]*)/g);
    const nodes = [];
    for (const part of parts) {
      if (part.length === 0) continue;
      if (!/^[A-Za-z][A-Za-z'’-]*$/.test(part)) {
        nodes.push(part);
        continue;
      }
      const key = part.toLowerCase();
      const done = annotatedTokens.has(key);
      const selected = selectedToken !== null && selectedToken.word === key;
      const known = knownWordInBank(part) !== null;
      const classNames = ["w"];
      if (done || known) classNames.push("annotated");
      nodes.push(
        h(
          "button",
          {
            type: "button",
            class: classNames.join(" "),
            "data-word": key,
            title: done || known ? `${part} · 已在词库` : `标注 ${part}`,
            style: selected ? { outline: "2px solid var(--accent, #4c8bf5)", outlineOffset: "1px" } : undefined,
            onClick: (event) => {
              void selectToken(part, sentence, pairIndex, event?.target ?? null);
            },
          },
          part,
        ),
      );
    }
    return nodes;
  }

  /** ③ 里点词：先取词条详情（lexeme），失败就只拿已知信息，绝不让标注卡住。 */
  async function selectToken(word, sentence, pairIndex, button) {
    if (busy()) {
      toast("请等当前请求结束再点下一个词", "warn");
      return;
    }
    const key = compact(word).toLowerCase();
    if (key.length === 0) return;
    const lemma = stemOf(key);
    selectedToken = {
      word: key,
      display: compact(word),
      sentence: compact(sentence),
      pairIndex,
      lemma,
      glossZh: "",
      partOfSpeech: "",
      phonetic: "",
      inflections: [],
      collocations: [],
      examples: [],
      degraded: false,
      note: "",
    };
    renderReader(readerPairs(finalText, finalSegments));
    renderSelection();
    updateButtons();

    let status = lexemeCache.get(key);
    if (status === "ready") {
      // 已经读过：直接复用。
      status = "ready";
    } else if (status === "loading") {
      return;
    } else {
      lexemeCache.set(key, "loading");
      lexemeBusy = true;
      if (button !== null) button.disabled = true;
      updateButtons();
      try {
        const lexemeRequestId = makeRequestId();
        const response = await api.lexeme({ word: word, sentence: sentence, requestId: lexemeRequestId }, { requestId: lexemeRequestId });
        const data = response?.data ?? null;
        if (data !== null && typeof data === "object") {
          lexemeData.set(key, {
            lemma: compact(data.lemma) || lemma,
            phonetic: compact(data.phonetic),
            glossZh: compact(data.glossZh),
            partOfSpeech: compact(data.partOfSpeech),
            inflections: inflectionsOf(data.inflections),
            examples: examplesOf(data.examples),
            collocations: collocationsOf(data.collocations),
          });
          lexemeCache.set(key, "ready");
        } else {
          lexemeCache.set(key, "degraded");
          lexemeErrors.set(key, normalizeResult?.parseError ?? "词条详情返回格式异常");
        }
      } catch (error) {
        // 优雅降级：词条接口失败也要能标注，只是信息不全。
        lexemeCache.set(key, "degraded");
        lexemeErrors.set(key, error?.message ?? String(error));
      } finally {
        lexemeBusy = false;
        if (button !== null) button.disabled = false;
      }
      if (selectedToken === null || selectedToken.word !== key) {
        // 用户已经点了别的词，结果写进缓存就好。
        updateButtons();
        return;
      }
    }

    const detail = lexemeData.get(key) ?? null;
    selectedToken = {
      ...selectedToken,
      lemma: detail?.lemma ?? lemma,
      glossZh: detail?.glossZh ?? "",
      partOfSpeech: detail?.partOfSpeech ?? "",
      phonetic: detail?.phonetic ?? "",
      inflections: detail?.inflections ?? [],
      collocations: detail?.collocations ?? [],
      examples: detail?.examples ?? [],
      degraded: detail === null,
      note: detail === null ? `词条详情不可用（${lexemeErrors.get(key) ?? "未知原因"}）` : "",
    };
    renderReader(readerPairs(finalText, finalSegments));
    renderSelection();
    updateButtons();
    if (selectedToken.degraded) {
      toast(`「${selectedToken.display}」的词条详情没取到，仍可标注，但音标/释义可能不全。`, "warn", { timeoutMs: 9000 });
    }
  }

  /** 选中词的确认区：确认按钮的文案随词库状态变化。 */
  function renderSelection() {
    if (selectedToken === null) {
      annotateButton = null;
      mount(selectionEl, h("div", { class: "small faint" }, "点一个单词开始标注。"));
      return;
    }
    const token = selectedToken;
    const banked = knownWordInBank(token.display) ?? knownWordInBank(token.lemma);
    const already = banked !== null || annotatedTokens.has(token.word);
    const confirmLabel = already ? "已在词库 · 更新" : "加入标注单词库";
    annotateButton = h(
      "button",
      {
        type: "button",
        class: "primary",
        onClick: (event) => {
          void withSubmit(event?.target ?? annotateButton, "保存中…", () => confirmAnnotation());
        },
      },
      confirmLabel,
    );
    mount(
      selectionEl,
      h(
        "div",
        { class: "card", style: { padding: "10px 12px" } },
        h(
          "div",
          { class: "row gap-8" },
          h("b", { class: "mono" }, token.display),
          token.phonetic.length > 0 ? h("span", { class: "ipa mono" }, `/${token.phonetic.replace(/^\/|\/$/g, "")}/`) : null,
          token.partOfSpeech.length > 0 ? h("span", { class: "chip" }, token.partOfSpeech) : null,
          token.glossZh.length > 0 ? h("span", { class: "gloss" }, token.glossZh) : null,
          h("span", { class: "chip" }, already ? "已在词库" : "新词"),
          token.degraded ? h("span", { class: "chip warn" }, "信息不全") : null,
        ),
        h("div", { class: "small faint mt-12" }, token.sentence),
        token.degraded && token.note.length > 0 ? h("div", { class: "small faint" }, token.note) : null,
        h(
          "div",
          { class: "row gap-8 mt-12" },
          annotateButton,
          h(
            "button",
            {
              type: "button",
              class: "sm",
              onClick: () => {
                selectedToken = null;
                renderReader(readerPairs(finalText, finalSegments));
                renderSelection();
                updateButtons();
              },
            },
            "取消选择",
          ),
          h("div", { class: "spacer" }),
          h("span", { class: "faint small" }, "确认后写入标注单词库"),
        ),
      ),
    );
  }

  /**
   * 确认标注：调 api.annotate（带稳定 requestId，主机据此去重），成功后刷新词库。
   * 直接调 api 而不是 store.annotateWord，是因为这里必须把 requestId 传给主机的去重逻辑。
   */
  async function confirmAnnotation() {
    const token = selectedToken;
    if (token === null) {
      toast("请先点选一个单词", "warn");
      return;
    }
    annotating = true;
    llmBusy = true;
    updateButtons();
    const payload = {
      word: token.display,
      lemma: token.lemma || token.word,
      glossZh: token.glossZh,
      partOfSpeech: token.partOfSpeech,
      inflections: token.inflections,
      collocations: token.collocations,
      examples: token.examples,
      source: SOURCE,
      sentence: token.sentence,
      sentenceZh: finalSegments[token.pairIndex]?.zh ?? "",
      phonetic: token.phonetic,
      requestId: makeRequestId(),
    };
    try {
      const response = await api.annotate(payload, { requestId: payload.requestId });
      if (response?.queued === true) {
        toast(`「${token.display}」已离线保存，联网后自动同步`, "warn", { timeoutMs: 9000 });
      } else {
        toast(`「${token.display}」已加入单词库`, "ok");
      }
      annotatedTokens.add(token.word);
      lexemeCache.set(token.word, "ready");
      if (!lexemeData.has(token.word)) {
        lexemeData.set(token.word, {
          lemma: payload.lemma,
          phonetic: payload.phonetic,
          glossZh: payload.glossZh,
          partOfSpeech: payload.partOfSpeech,
          inflections: payload.inflections,
          examples: payload.examples,
          collocations: payload.collocations,
        });
      }
      // 以 lemma 做会话列表的键：walked / walking 都归到 walk 同一张卡。
      const entryKey = compact(payload.lemma).toLowerCase() || token.word;
      const existing = sessionWords.get(entryKey) ?? {};
      sessionWords.set(entryKey, {
        ...existing,
        id: entryKey,
        word: token.display,
        lemma: payload.lemma,
        phonetic: payload.phonetic,
        glossZh: payload.glossZh,
        partOfSpeech: payload.partOfSpeech,
        inflections: payload.inflections,
        examples: payload.examples,
        collocations: payload.collocations,
        status: existing.status ?? "new",
        starred: existing.starred ?? false,
        sentence: token.sentence,
        sentenceZh: payload.sentenceZh,
      });
      selectedToken = null;
      void refresh({ silent: true });
    } catch (error) {
      failToast(error, `标注「${token.display}」`, () => confirmAnnotation());
    } finally {
      annotating = false;
      llmBusy = false;
      renderReader(readerPairs(finalText, finalSegments));
      renderSelection();
      renderSession();
      updateButtons();
    }
  }

  /** 会话列表的键：优先 lemma，跟写入时保持一致。 */
  function sessionKey(entry) {
    return compact(entry.lemma).toLowerCase() || compact(entry.word).toLowerCase();
  }

  /** 本次会话已标注的词：实时更新，带译文 / 词形变化 / 固定搭配 / 例句。 */
  function renderSession() {
    if (sessionWords.size === 0) {
      mount(sessionListEl, h("div", { class: "empty" }, "还没有标注任何单词。在英文里点一个单词，再点「加入标注单词库」。"));
      return;
    }
    mount(
      sessionListEl,
      [...sessionWords.values()].map((entry) => {
        const key = sessionKey(entry);
        const live = bankWord(entry.lemma);
        const word = live !== null ? { ...entry, ...live } : entry;
        return wordCard(word, {
          pending: state.pending?.[key],
          onChange: (patch) => {
            const current = sessionWords.get(key);
            if (current !== undefined) sessionWords.set(key, { ...current, ...patch });
            const id = live?.id ?? entry.id;
            if (live === null) {
              // 还在离线队列里，主机没有这条记录：只改本地展示。
              renderSession();
              return;
            }
            void updateWord(id, patch).then((result) => {
              if (result?.ok === true) {
                toast("已更新", "ok");
                renderSession();
              } else {
                toast(`更新失败：${result?.error ?? "未知原因"}`, "bad");
              }
            });
          },
          onDelete: () => {
            const id = live?.id ?? entry.id;
            if (live === null) {
              sessionWords.delete(key);
              renderSession();
              toast("已从本次列表移除", "ok");
              return;
            }
            void deleteWord(id).then((result) => {
              if (result?.ok === true) {
                sessionWords.delete(key);
                annotatedTokens.delete(compact(entry.word).toLowerCase());
                toast("已删除", "ok");
                renderReader(readerPairs(finalText, finalSegments));
                renderSession();
              } else {
                toast(`删除失败：${result?.error ?? "未知原因"}`, "bad");
              }
            });
          },
        });
      }),
    );
  }

  /* ------------------------------------------------------------ 接口调用 */

  /**
   * 调 api.normalize。
   * @param {{ reuseRequestId?: boolean }} options
   */
  async function runNormalize(options = {}) {
    if (!isOnline()) {
      toast("当前离线：解析接口不可用，请联网后重试（也可以先用「本地解析（不调用接口）」）", "warn", { timeoutMs: 9000 });
      return;
    }
    const text = normalizeText(textareaEl.value);
    if (text.length === 0 && pendingImages.length === 0) {
      toast("请先粘贴要处理的文本，或添加图片", "warn");
      return;
    }
    if (!options.reuseRequestId) requestId = makeRequestId();
    rawInput = text;
    normalizing = true;
    llmBusy = true;
    updateButtons();
    try {
      const response = await api.normalize({
        text,
        images: pendingImages.map((image) => ({ base64: image.base64, mimeType: image.mimeType })),
        requestId,
      });
      normalizeResult = response;
      // 预览与阅读器都以主机返回的 corrected 为准，空则依次回退。
      previewArea.value = pickPreviewText(response?.data, text);
      finalText = previewArea.value;
      finalSegments = segmentsOf(response?.data?.segments);
      showStage("confirm");
      if (response?.degraded === true) {
        toast("模型返回的内容无法解析，已降级显示原文，可手动编辑后重新解析。", "warn", { timeoutMs: 9000 });
      }
    } catch (error) {
      failToast(error, "解析", () => runNormalize({ reuseRequestId: true }));
    } finally {
      normalizing = false;
      llmBusy = false;
      updateButtons();
    }
  }

  /** ② → ③：以文本域里的英文为准（可能是用户手改过的）。 */
  function confirmStage() {
    const text = normalizeText(previewArea.value);
    finalText = text;
    finalSegments = segmentsOf(normalizeResult?.data?.segments);
    selectedToken = null;
    showStage("annotation");
  }

  /* ------------------------------------------------------------ 渲染与状态 */

  function showStage(next) {
    stage = next;
    if (stage === "input") renderInput();
    else if (stage === "confirm") renderConfirm();
    else renderStage3();
    updateButtons();
  }

  /** 在线状态 + 单飞约束：所有会打接口的按钮一起开合。 */
  function updateButtons() {
    const online = isOnline();
    offlineAlert.hidden = online;
    const locked = busy() || submitting;
    setEnabled(submitButton, online && !locked);
    setEnabled(localParseButton, !locked);
    setEnabled(reparseButton, online && !locked);
    setEnabled(confirmButton, !locked);
    setEnabled(readAllButton, !locked);
    // ③ 的确认按钮是每次重渲染新建的，所以留了直接引用，不靠选择器去找。
    if (annotateButton !== null) setEnabled(annotateButton, online && !locked);
  }

  /** 状态行的文案随阶段与连接状态变化。 */
  function updateHeader() {
    const labels = {
      input: "① 输入与解析",
      confirm: "② 确认与纠错",
      annotation: "③ 英文标注",
    };
    const label = labels[stage] ?? "";
    mount(
      headerSub,
      h("span", null, `${label} · 处理任何不是日记照片的文本：单词、长句、整段文章或图片。`),
      h("span", { class: "faint small" }, " 服务商只有智谱 GLM-4V-Flash（免费识图）；朗读用浏览器内置语音，断网也可用。"),
    );
  }

  /** 启用/禁用：真 DOM 与无头测试桩都支持 setAttribute/removeAttribute。 */
  function setEnabled(node, enabled) {
    if (node === null || node === undefined) return;
    node.disabled = !enabled;
    if (enabled) node.removeAttribute?.("disabled");
    else node.setAttribute?.("disabled", "");
  }

  /* --------------------------------------------------------------- 启动 */

  const unsubscribe = subscribe(() => {
    if (stage === "annotation") renderSession();
    updateHeader();
    updateButtons();
  });
  root.__dispose = unsubscribe;

  showStage("input");
  updateHeader();
  updateButtons();

  return root;
}

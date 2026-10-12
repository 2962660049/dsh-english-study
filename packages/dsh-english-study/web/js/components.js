/**
 * Shared view components: word detail panels, speak buttons, status chips.
 *
 * These are plain functions returning DOM nodes. They take callbacks rather than
 * reaching into the store, so they are reusable from the diary, the web-text area
 * and the vocabulary bank alike.
 */

import { h, toast } from "./ui.js";
import { tts } from "./tts.js";

/** Chinese labels for the learning status. */
export const STATUS_LABELS = {
  new: "生词",
  learning: "学习中",
  review: "待复习",
  mastered: "已掌握",
};

export const STATUS_ORDER = ["new", "learning", "review", "mastered"];

/** A button that reads its text aloud with the Web Speech API. */
export function speakButton(text, { label = "🔊", title = "朗读", className = "sm" } = {}) {
  const button = h(
    "button",
    {
      class: className,
      title,
      type: "button",
      onClick: () => {
        if (!tts.isSupported()) {
          toast("当前浏览器不支持语音合成（speechSynthesis）", "warn");
          return;
        }
        void tts.speak(text, {
          onError: (error) => toast(`朗读失败：${error?.message ?? error}`, "bad"),
        });
      },
    },
    label,
  );
  return button;
}

/** Status pill for a vocabulary record. */
export function statusChip(status) {
  const kind = status === "mastered" ? "ok" : status === "review" ? "warn" : status === "learning" ? "accent" : "";
  return h("span", { class: `chip ${kind}` }, STATUS_LABELS[status] ?? status ?? "生词");
}

/** The compact line shown in a collapsed word row. */
export function wordSummaryLine(word, { pending } = {}) {
  return [
    h("span", { class: "lemma" }, word.lemma),
    word.phonetic ? h("span", { class: "ipa" }, `/${String(word.phonetic).replace(/^\/|\/$/g, "")}/`) : null,
    word.glossZh ? h("span", { class: "gloss" }, word.glossZh) : null,
    pending === "saving" ? h("span", { class: "chip pending" }, "保存中…") : null,
    pending === "queued" ? h("span", { class: "chip pending" }, "待同步") : null,
    pending === "failed" ? h("span", { class: "chip danger" }, "保存失败") : null,
    word.starred ? h("span", { class: "chip" }, "★") : null,
    statusChip(word.status),
  ];
}

/**
 * The expanded detail body for one word.
 * @param {object} word
 * @param {{ onChange?: (patch: object) => void, onDelete?: () => void }} [handlers]
 */
export function wordDetailBody(word, handlers = {}) {
  const onChange = handlers.onChange ?? (() => {});
  const sections = [];

  /* pronunciation + gloss ------------------------------------------------- */
  sections.push(
    h(
      "div",
      { class: "row" },
      speakButton(word.lemma, { label: "🔊 朗读", title: `朗读 ${word.lemma}` }),
      word.phonetic ? h("span", { class: "mono" }, `/${String(word.phonetic).replace(/^\/|\/$/g, "")}/`) : null,
      word.partOfSpeech ? h("span", { class: "chip" }, word.partOfSpeech) : null,
    ),
  );

  if (word.glossZh) {
    sections.push(h("div", { class: "pre-wrap" }, word.glossZh));
  }

  /* inflections ----------------------------------------------------------- */
  if (Array.isArray(word.inflections) && word.inflections.length > 0) {
    sections.push(
      h(
        "div",
        null,
        h("div", { class: "small faint mb-8" }, "词形变化"),
        h(
          "div",
          { class: "infl-grid" },
          word.inflections.map((entry) =>
            h("span", { class: "infl" }, h("b", null, entry.label), entry.form, speakButton(entry.form, { label: "🔊", title: `朗读 ${entry.form}` })),
          ),
        ),
      ),
    );
  }

  /* fixed collocations ---------------------------------------------------- */
  if (Array.isArray(word.collocations) && word.collocations.length > 0) {
    sections.push(
      h(
        "div",
        null,
        h("div", { class: "small faint mb-8" }, "固定搭配"),
        h(
          "div",
          { class: "infl-grid" },
          word.collocations.map((phrase) => h("span", { class: "infl" }, phrase, speakButton(phrase, { label: "🔊", title: `朗读 ${phrase}` }))),
        ),
      ),
    );
  }

  /* example sentences ----------------------------------------------------- */
  if (Array.isArray(word.examples) && word.examples.length > 0) {
    sections.push(
      h(
        "div",
        null,
        h("div", { class: "small faint mb-8" }, "例句"),
        ...word.examples.map((example) =>
          h(
            "div",
            { class: "quote mb-8" },
            h("div", null, h("em", null, String(example.en ?? "")), speakButton(String(example.en ?? ""), { label: "🔊" })),
            example.zh ? h("div", { class: "small" }, example.zh) : null,
          ),
        ),
      ),
    );
  }

  /* where it came from ---------------------------------------------------- */
  const annotations = Array.isArray(word.annotations) ? word.annotations : [];
  if (annotations.length > 0) {
    sections.push(
      h(
        "div",
        null,
        h("div", { class: "small faint mb-8" }, `来源（${annotations.length} 次标注）`),
        ...annotations.slice(0, 6).map((annotation) =>
          h(
            "div",
            { class: "quote mb-8" },
            annotation.sentence
              ? h(
                  "div",
                  { class: "row" },
                  h("span", null, highlightWord(annotation.sentence, word.lemma)),
                  speakButton(annotation.sentence, { label: "🔊" }),
                )
              : h("div", { class: "faint small" }, "（无原句记录）"),
            annotation.sentenceZh ? h("div", { class: "small" }, annotation.sentenceZh) : null,
            h(
              "div",
              { class: "faint small" },
              `${annotation.source === "diary" ? "日记分区" : "其它文本处理区"} · ${String(annotation.at ?? "").slice(0, 16).replace("T", " ")}`,
            ),
          ),
        ),
      ),
    );
  }

  /* learning state -------------------------------------------------------- */
  const statusRow = h(
    "div",
    { class: "segmented" },
    STATUS_ORDER.map((status) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String((word.status ?? "new") === status),
          onClick: () => onChange({ status }),
        },
        STATUS_LABELS[status],
      ),
    ),
  );

  sections.push(
    h(
      "div",
      { class: "row" },
      statusRow,
      h(
        "button",
        { class: "sm", type: "button", onClick: () => onChange({ starred: !word.starred }) },
        word.starred ? "★ 已收藏" : "☆ 收藏",
      ),
      h("div", { class: "spacer" }),
      handlers.onDelete
        ? h("button", { class: "sm danger", type: "button", onClick: handlers.onDelete }, "删除")
        : null,
    ),
  );

  return h("div", { class: "body" }, ...sections);
}

/** Wrap every occurrence of `word` (or its lemma family) in a highlight span. */
export function highlightWord(sentence, word) {
  const text = String(sentence ?? "");
  if (text.length === 0) return h("span", null, "");
  const stem = String(word ?? "").replace(/[^A-Za-z]/g, "").slice(0, Math.max(3, String(word ?? "").length - 2));
  if (stem.length === 0) return h("span", null, text);
  const pattern = new RegExp(`\\b${stem}[A-Za-z]*\\b`, "gi");
  const nodes = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) nodes.push(document.createTextNode(text.slice(cursor, match.index)));
    nodes.push(h("em", null, match[0]));
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) nodes.push(document.createTextNode(text.slice(cursor)));
  return h("span", null, ...nodes);
}

/** A collapsible word card used by the diary and vocabulary views. */
export function wordCard(word, handlers = {}) {
  const details = h(
    "details",
    { class: "word-card" },
    h("summary", null, ...wordSummaryLine(word, { pending: handlers.pending })),
    wordDetailBody(word, handlers),
  );
  return details;
}

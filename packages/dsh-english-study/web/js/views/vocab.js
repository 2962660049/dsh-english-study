/**
 * Vocabulary bank.
 *
 * Two review modes, exactly as specified:
 *   - 按标注时间 (by annotation time): one row per annotation event. Duplicates are
 *     deliberately NOT merged, because seeing "I looked this up again 3 times" is
 *     itself useful information.
 *   - 按首字母 (by first letter): one row per lemma, duplicates merged, grouped A–Z.
 *
 * Both modes share the search box, the status filter and the star filter.
 */

import { h, mount, toast, fmtDateTime } from "../ui.js";
import { state, subscribe, updateWord, deleteWord, sortedEvents, groupByLetter } from "../store.js";
import { exportUrl } from "../api.js";
import { speakButton, statusChip, wordDetailBody, STATUS_LABELS, STATUS_ORDER } from "../components.js";

const MODE_KEY = "english-study:vocab-mode";
const PAGE_SIZE = 200;

/** Persisted view mode: read defensively, because storage may be unavailable. */
function readMode() {
  try {
    return window.localStorage.getItem(MODE_KEY) === "letter" ? "letter" : "time";
  } catch {
    return "time";
  }
}

function writeMode(mode) {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* storage is optional */
  }
}

export default function render() {
  let mode = readMode();
  let search = "";
  let statusFilter = "all";
  let starredOnly = false;
  let limit = PAGE_SIZE;

  const root = h("div", { class: "view" });
  const toolbarEl = h("div", { class: "card tight" });
  const listEl = h("div");
  const summaryEl = h("div", { class: "card-sub" });

  /* --------------------------------------------------------------- helpers */

  function matches(word, event) {
    if (starredOnly && word !== null && word.starred !== true) return false;
    if (statusFilter !== "all" && word !== null && (word.status ?? "new") !== statusFilter) return false;
    if (search.trim().length === 0) return true;
    const needle = search.trim().toLowerCase();
    const haystack = [event?.word, event?.lemma, word?.lemma, event?.glossZh, word?.glossZh]
      .filter((value) => typeof value === "string")
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  }

  function wordFor(lemma) {
    if (typeof lemma !== "string") return null;
    const key = lemma.toLowerCase();
    return state.vocabWords.find((entry) => entry.lemma.toLowerCase() === key) ?? null;
  }

  function handlerFor(word, lemma) {
    return {
      pending: state.pending[(lemma ?? word?.lemma ?? "").toLowerCase()],
      onChange: (patch) => {
        void updateWord(word.id, patch).then((result) => {
          if (result.queued === true) toast("已离线保存，联网后会自动同步", "warn");
          else if (result.ok !== true) toast(`更新失败：${result.error}`, "bad");
        });
      },
      onDelete: () => {
        if (!window.confirm(`删除「${word.lemma}」及其全部标注记录？`)) return;
        void deleteWord(word.id).then((result) => {
          if (result.ok !== true) toast(`删除失败：${result.error}`, "bad");
          else toast("已删除", "ok");
        });
      },
    };
  }

  /* ---------------------------------------------------------------- toolbar */

  function renderToolbar() {
    const total = state.vocabWords.length;
    const events = state.vocabEvents.length;
    mount(
      toolbarEl,
      h(
        "div",
        { class: "row" },
        h(
          "div",
          { class: "segmented" },
          h(
            "button",
            { type: "button", "aria-pressed": String(mode === "time"), onClick: () => { mode = "time"; writeMode(mode); limit = PAGE_SIZE; renderAll(); } },
            "按标注时间",
          ),
          h(
            "button",
            { type: "button", "aria-pressed": String(mode === "letter"), onClick: () => { mode = "letter"; writeMode(mode); limit = PAGE_SIZE; renderAll(); } },
            "按首字母",
          ),
        ),
        h("input", {
          type: "search",
          placeholder: "搜索单词或释义…",
          value: search,
          style: { maxWidth: "240px" },
          onInput: (event) => {
            search = event.target.value;
            limit = PAGE_SIZE;
            renderList();
          },
        }),
        h(
          "div",
          { class: "segmented" },
          [{ id: "all", label: "全部" }, ...STATUS_ORDER.map((status) => ({ id: status, label: STATUS_LABELS[status] }))].map((option) =>
            h(
              "button",
              {
                type: "button",
                "aria-pressed": String(statusFilter === option.id),
                onClick: () => { statusFilter = option.id; limit = PAGE_SIZE; renderAll(); },
              },
              option.label,
            ),
          ),
        ),
        h("button", { type: "button", class: starredOnly ? "primary sm" : "ghost sm", onClick: () => { starredOnly = !starredOnly; limit = PAGE_SIZE; renderAll(); } }, "★ 仅收藏"),
        h("div", { class: "spacer" }),
        h("a", { class: "btn ghost sm", href: exportUrl("csv"), download: "english-study-vocab.csv" }, "CSV"),
        h("a", { class: "btn ghost sm", href: exportUrl("anki"), download: "english-study-anki.txt" }, "Anki"),
      ),
      h("div", { class: "hint" }, summaryEl),
    );
  }

  /* ------------------------------------------------------------- time mode */

  function renderTimeMode() {
    const rows = sortedEvents().filter((event) => matches(wordFor(event.lemma), event));
    summaryEl.textContent = `${rows.length} 条标注记录 · 共 ${state.vocabWords.length} 个不同单词（此模式不合并重复）`;
    if (rows.length === 0) {
      mount(listEl, h("div", { class: "empty" }, "没有匹配的标注记录。"));
      return;
    }
    const visible = rows.slice(0, limit);
    const cards = visible.map((event) => {
      const word = wordFor(event.lemma);
      const details = h(
        "details",
        { class: "word-card" },
        h(
          "summary",
          null,
          h("span", { class: "lemma" }, event.word ?? event.lemma),
          event.phonetic || word?.phonetic ? h("span", { class: "ipa" }, `/${String(event.phonetic || word.phonetic).replace(/^\/|\/$/g, "")}/`) : null,
          h("span", { class: "gloss" }, event.glossZh || word?.glossZh || "（未收录释义）"),
          state.pending[(event.lemma ?? "").toLowerCase()] ? h("span", { class: "chip pending" }, "待同步") : null,
          h("span", { class: "chip" }, event.source === "diary" ? "日记" : "网页"),
          h("span", { class: "faint small nowrap" }, fmtDateTime(event.createdAt)),
          word ? statusChip(word.status) : null,
        ),
        h(
          "div",
          { class: "body" },
          event.sentence
            ? h(
                "div",
                { class: "quote" },
                h("div", { class: "row" }, h("span", null, event.sentence), speakButton(event.sentence, { label: "🔊" })),
                event.sentenceZh ? h("div", { class: "small" }, event.sentenceZh) : null,
              )
            : h("div", { class: "faint small" }, "（该次标注没有记录原句）"),
          word
            ? wordDetailBody(word, handlerFor(word, event.lemma))
            : h("div", { class: "faint small mt-12" }, "该单词的合并记录暂不可用（可能已被删除）。"),
        ),
      );
      return details;
    });
    mount(listEl, ...cards, rows.length > limit ? moreButton(rows.length) : null);
  }

  /* ----------------------------------------------------------- letter mode */

  function renderLetterMode() {
    const words = state.vocabWords.filter((word) => matches(word, null));
    summaryEl.textContent = `${words.length} 个单词（此模式已合并重复标注）`;
    if (words.length === 0) {
      mount(listEl, h("div", { class: "empty" }, "没有匹配的单词。"));
      return;
    }
    const groups = groupByLetter(words);
    let budget = limit;
    const sections = [];
    for (const group of groups) {
      if (budget <= 0) break;
      const slice = group.words.slice(0, budget);
      budget -= slice.length;
      sections.push(
        h(
          "div",
          { class: "card", id: `letter-${group.letter}` },
          h("div", { class: "card-head" }, h("h3", { style: { margin: "0" } }, group.letter), h("div", { class: "card-sub" }, `${group.words.length} 个`)),
          h(
            "div",
            { class: "word-list" },
            slice.map((word) => {
              const details = h("details", { class: "word-card" });
              const summary = h(
                "summary",
                null,
                h("span", { class: "lemma" }, word.lemma),
                word.phonetic ? h("span", { class: "ipa" }, `/${String(word.phonetic).replace(/^\/|\/$/g, "")}/`) : null,
                h("span", { class: "gloss" }, word.glossZh || "（未收录释义）"),
                state.pending[word.lemma.toLowerCase()] ? h("span", { class: "chip pending" }, state.pending[word.lemma.toLowerCase()] === "failed" ? "保存失败" : "待同步") : null,
                word.starred ? h("span", { class: "chip" }, "★") : null,
                h("span", { class: "faint small" }, `${word.annotations?.length ?? 0} 次`),
                statusChip(word.status),
              );
              details.appendChild(summary);
              details.appendChild(wordDetailBody(word, handlerFor(word, word.lemma)));
              return details;
            }),
          ),
        ),
      );
    }
    const alphabet = h(
      "div",
      { class: "row", style: { flexWrap: "wrap", gap: "4px" } },
      groups.map((group) => h("a", { class: "chip", href: `#/vocab` , onClick: () => { const node = document.getElementById(`letter-${group.letter}`); node?.scrollIntoView({ behavior: "smooth", block: "start" }); } }, group.letter)),
    );
    mount(listEl, h("div", { class: "mb-12" }, alphabet), ...sections, words.length > limit ? moreButton(words.length) : null);
  }

  function moreButton(total) {
    return h(
      "div",
      { class: "center mt-12" },
      h(
        "button",
        { type: "button", onClick: () => { limit += PAGE_SIZE; renderList(); } },
        `显示更多（已显示 ${limit} / ${total}）`,
      ),
    );
  }

  /* ------------------------------------------------------------------ root */

  function renderList() {
    if (mode === "time") renderTimeMode();
    else renderLetterMode();
  }

  function renderAll() {
    renderToolbar();
    renderList();
  }

  root.appendChild(
    h(
      "div",
      { class: "card" },
      h("div", { class: "card-head" }, h("h2", null, "标注单词库"), h("div", { class: "card-sub" }, "来自日记分区与其它文本处理区的全部标注")),
      toolbarEl,
    ),
  );
  root.appendChild(listEl);

  const unsubscribe = subscribe(renderAll);
  root.__dispose = unsubscribe;
  renderAll();
  return root;
}

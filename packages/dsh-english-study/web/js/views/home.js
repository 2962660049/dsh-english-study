/**
 * Home view: the three entry points plus today's study overview.
 *
 * This is the only view that is allowed to be "read-only"; everything it shows is
 * derived from the store, so it stays correct offline from the cached snapshot.
 */

import { h, mount } from "../ui.js";
import { state, subscribe, overview, sortedEvents } from "../store.js";
import { connection } from "../api.js";
import { speakButton } from "../components.js";

const TILES = [
  {
    path: "/diary",
    icon: "📔",
    title: "日记分区",
    desc: "拖入手写日记照片即可识别；自动提取英文与椭圆圈出的单词并入库。",
  },
  {
    path: "/web",
    icon: "📄",
    title: "其它文本处理区",
    desc: "粘贴单词、长句、整段文本或图片：先译成英文并纠正错误，再在英文界面点词入库。",
  },
  {
    path: "/vocab",
    icon: "📚",
    title: "标注单词库",
    desc: "按标注时间或首字母复习，展开查看音标、词形变化、例句与它出现的原句。",
  },
];

function metric(label, value, hint) {
  return h(
    "div",
    { class: "metric" },
    h("div", { class: "metric-value" }, String(value)),
    h("div", { class: "metric-label" }, label),
    hint ? h("div", { class: "faint small" }, hint) : null,
  );
}

export default function render() {
  const root = h("div", { class: "view" });
  const metricsEl = h("div", { class: "grid cols-4" });
  const recentEl = h("div", { class: "word-list" });
  const hintEl = h("p", { class: "muted" });

  function updateMetrics() {
    const summary = overview();
    mount(
      metricsEl,
      metric("今日新增", summary.todayNew, "今天标注的单词数"),
      metric("待复习", summary.dueCount, "生词 + 学习中"),
      metric("已掌握", summary.masteredCount, "标记为已掌握"),
      metric("词汇总量", summary.totalWords, `累计标注 ${summary.totalAnnotations} 次 · 日记 ${summary.diaryDays} 天`),
    );
    hintEl.textContent =
      state.stale && !connection.online
        ? "当前显示的是本地缓存快照（离线）。联网后会自动同步。"
        : state.loaded
          ? ""
          : "正在加载…";
  }

  function updateRecent() {
    const recent = sortedEvents().slice(0, 8);
    if (recent.length === 0) {
      mount(
        recentEl,
        h(
          "div",
          { class: "empty" },
          "还没有标注任何单词。可以在「其它文本处理区」粘贴一段文本开始，或在「日记分区」拖入手写照片自动入库。",
        ),
      );
      return;
    }
    mount(
      recentEl,
      recent.map((event) =>
        h(
          "div",
          { class: "row", style: { padding: "8px 0", borderBottom: "1px solid var(--border)" } },
          h("a", { href: "#/vocab", class: "lemma mono", style: { minWidth: "110px" } }, event.word ?? event.lemma),
          h("span", { class: "gloss" }, event.glossZh || "（未收录释义）"),
          h("div", { class: "spacer" }),
          event.sentence ? speakButton(event.sentence, { label: "🔊", title: "朗读原句" }) : null,
          h("span", { class: "chip" }, event.source === "diary" ? "日记" : "文本"),
          h("span", { class: "faint small nowrap" }, String(event.createdAt ?? "").slice(5, 16).replace("T", " ")),
        ),
      ),
    );
  }

  function update() {
    updateMetrics();
    updateRecent();
  }

  const cards = [
    h(
      "div",
      { class: "card" },
      h("div", { class: "card-head" }, h("h2", null, "今日学习概览"), h("div", { class: "card-sub" }, hintEl)),
      metricsEl,
    ),
    h(
      "div",
      { class: "grid cols-3" },
      TILES.map((tile) =>
        h(
          "a",
          { class: "entry-tile", href: `#${tile.path}` },
          h("div", { class: "entry-tile-icon", "aria-hidden": "true" }, tile.icon),
          h("div", { class: "entry-tile-title" }, tile.title),
          h("div", { class: "entry-tile-desc" }, tile.desc),
        ),
      ),
    ),
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "card-head" },
        h("h2", null, "最近标注"),
        h("div", { class: "card-sub" }, "按标注时间倒序，点词进入单词库查看详情"),
      ),
      recentEl,
    ),
    h(
      "div",
      { class: "card" },
      h("div", { class: "card-head" }, h("h2", null, "使用提示")),
      h(
        "ul",
        { class: "muted", style: { margin: "0", paddingLeft: "20px", lineHeight: "1.9" } },
        h("li", null, "日记路径：在「日记分区」把圈好生词的抄写标注稿拖进来（或点「选择图片」）→ 自动落到今天的日记并识别入库；英文原文与被椭圆圈出的单词会进入单词库，不需要手动点词，也不用先选日期。"),
        h("li", null, "一天可以写多篇：这一篇存好后，页面右上角会出现「下一篇」，点开就是一张全新的页，用法和第一篇完全一样；回到日历再点这一天，打开的始终是第 1 篇。"),
        h("li", null, "文本路径：在「其它文本处理区」粘贴中文、英文或图片 → 先统一译成英文并纠正错误 → 确认后进入英文界面，点词加入单词库。"),
        h("li", null, "复习：单词库支持「按标注时间」（重复不合并）与「按首字母」（重复合并）两种视图切换。"),
        h("li", null, "发音：使用浏览器内置语音合成（en-US，语速 0.9），断网也能朗读。"),
        h("li", null, "数据：本地 IndexedDB 缓存 + 服务端持久化（关联你的 DSH 账号），离线改动会自动排队重发。"),
      ),
    ),
  ];

  mount(root, cards);

  const unsubscribe = subscribe(update);
  root.__dispose = unsubscribe;
  update();
  return root;
}

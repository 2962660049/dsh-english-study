/**
 * Application shell.
 *
 * Responsibilities, in the order they matter for the reliability spec:
 *   1. Build the chrome (title, navigation, connection/queue status, manual sync).
 *   2. Own the route table, wrapping every view in an error boundary so a view
 *      crash can never produce a white screen.
 *   3. Wire the cache-first bootstrap, the periodic auto-sync, and the
 *      "came back online -> flush the outbox" recovery path.
 *   4. Install global `error` / `unhandledrejection` handlers as the last line of
 *      defence, so a stray async rejection surfaces as a toast instead of silence.
 */

import { h, mount, toast, guarded, fmtDateTime } from "./ui.js";
import { createRouter } from "./router.js";
import { state, subscribe, bootstrap, startAutoSync, syncNow } from "./store.js";
import { api, connection, onConnectionChange, refreshQueueDepth, startConnectivityWatch } from "./api.js";
import renderHome from "./views/home.js";
import renderDiary from "./views/diary.js";
import renderWeb from "./views/webtest.js";
import renderVocab from "./views/vocab.js";
import renderSettings from "./views/settings.js";

const NAV = [
  { path: "/", label: "首页", match: (path) => path === "/" },
  { path: "/diary", label: "日记分区", match: (path) => path.startsWith("/diary") },
  { path: "/web", label: "其它文本处理区", match: (path) => path.startsWith("/web") },
  { path: "/vocab", label: "标注单词库", match: (path) => path.startsWith("/vocab") },
  { path: "/settings", label: "设置", match: (path) => path.startsWith("/settings") },
];

const root = document.getElementById("root");
const outlet = h("main", { class: "outlet" });
const navEl = h("nav", { class: "nav", "aria-label": "主导航" });
const statusEl = h("div", { class: "status" });
const offlineBanner = h("div", { class: "alert warn hidden" });

/** Wrap one view so a throw becomes an error card, never a blank page. */
function view(render, label) {
  return (context) => guarded(() => render(context), { label, onRetry: () => router.refresh() });
}

const routes = [
  { path: "/", render: view(renderHome, "首页") },
  { path: "/diary", render: view(renderDiary, "日记分区") },
  { path: "/diary/:date", render: view(renderDiary, "日记详情") },
  { path: "/diary/:date/:page", render: view(renderDiary, "日记详情") },
  { path: "/web", render: view(renderWeb, "其它文本处理区") },
  { path: "/vocab", render: view(renderVocab, "标注单词库") },
  { path: "/settings", render: view(renderSettings, "设置") },
];

let router = null;
let currentPath = "/";

function renderNav(path) {
  currentPath = path;
  mount(
    navEl,
    NAV.map((item) =>
      h(
        "a",
        {
          href: `#${item.path}`,
          "aria-current": item.match(path) ? "page" : null,
        },
        item.label,
      ),
    ),
  );
}

function renderStatus() {
  const online = connection.online;
  const queued = connection.queued ?? 0;
  const busy = connection.inFlight > 0;
  const dot = !online ? "bad" : busy ? "busy" : queued > 0 ? "warn" : "ok";
  const text = !online
    ? "离线 · 提交已暂停"
    : busy
      ? "请求中…"
      : queued > 0
        ? `待同步 ${queued} 项`
        : "已连接";

  mount(
    statusEl,
    h("span", { class: `dot ${dot}`, title: connection.lastError ?? text }),
    h("span", { class: "nowrap" }, text),
    state.lastSyncAt
      ? h("span", { class: "faint small nowrap" }, `上次同步 ${fmtDateTime(new Date(state.lastSyncAt).toISOString())}`)
      : null,
    h(
      "button",
      {
        class: "ghost sm",
        type: "button",
        disabled: state.refreshing,
        onClick: () => {
          void syncNow()
            .then((result) => {
              if (result.remaining > 0) toast(`仍有 ${result.remaining} 项未能同步`, "warn");
              else toast("已同步", "ok");
            })
            .catch((error) => toast(`同步失败：${error?.message ?? error}`, "bad"));
        },
      },
      state.refreshing ? "同步中…" : "立即同步",
    ),
  );

  offlineBanner.classList.toggle("hidden", online);
  if (!online) {
    offlineBanner.textContent = `当前离线，提交已暂停。${queued > 0 ? `已有 ${queued} 项改动排队，联网后会自动重发。` : "联网后会自动恢复。"}`;
  }
}

function buildShell() {
  return h(
    "div",
    { class: "app" },
    h(
      "header",
      { class: "topbar" },
      h(
        "a",
        { class: "brand", href: "#/" },
        h("span", { class: "brand-mark", "aria-hidden": "true" }, "英"),
        h("span", null, "英语学习小助手"),
      ),
      navEl,
      h("div", { class: "topbar-spacer" }),
      statusEl,
    ),
    h("div", { class: "page" }, offlineBanner, outlet),
  );
}

async function main() {
  mount(root, buildShell());
  renderNav("/");

  router = createRouter(routes, {
    outlet,
    fallback: (path) =>
      h("div", { class: "card" }, h("h2", null, "页面不存在"), h("p", { class: "muted" }, `没有找到与 ${path} 匹配的页面。`), h("a", { class: "btn", href: "#/" }, "返回首页")),
    onNavigate: (path) => {
      renderNav(path);
      renderStatus();
    },
  });

  subscribe(renderStatus);
  onConnectionChange(renderStatus);

  startConnectivityWatch({
    onRecovered: () => {
      void (async () => {
        const queued = await refreshQueueDepth();
        if (queued > 0) {
          const { flushOutbox } = await import("./api.js");
          const result = await flushOutbox();
          toast(`网络已恢复，补发 ${result.delivered} 项${result.failed > 0 ? `，${result.failed} 项失败` : ""}`, result.failed > 0 ? "warn" : "ok");
        } else {
          toast("网络已恢复", "ok");
        }
      })();
    },
  });

  await bootstrap();
  startAutoSync(60_000);
  renderStatus();

  // Surface provider/dictionary readiness once, so a missing API key is visible
  // before the user tries to translate something.
  try {
    const health = await api.health();
    const dictionary = health?.dictionary?.state === "ready" ? `本地词典 ${health.dictionary.size} 词条` : "未加载本地词典（将使用 LLM 查词）";
    const glm = (health?.providers ?? []).find((entry) => entry.id === "glm");
    if (glm !== undefined && glm.configured === false) {
      toast("还没有配置「智谱 GLM-4V-Flash」的 API Key，拍照识别无法使用。到「设置」里填入免费 Key 即可。", "warn", { timeoutMs: 9000 });
    }
    console.info(`[english-study] ${health?.plugin} v${health?.version} · ${health?.activeProvider} · ${dictionary} · 数据目录 ${health?.dataDir}`);
  } catch (error) {
    toast(`无法连接本地服务：${error?.message ?? error}`, "bad", {
      timeoutMs: 12_000,
      action: { label: "重试", onClick: () => void bootstrap() },
    });
  }
}

/* Global safety nets: these catch anything that escapes the per-view boundary. */
window.addEventListener("unhandledrejection", (event) => {
  console.error("[english-study] 未处理的异步错误:", event.reason);
  toast(`发生未处理的错误：${event.reason?.message ?? event.reason}`, "bad");
});
window.addEventListener("error", (event) => {
  console.error("[english-study] 全局错误:", event.error ?? event.message);
});

main().catch((error) => {
  console.error("[english-study] 启动失败:", error);
  mount(
    root,
    h("div", { class: "page" }, h("div", { class: "alert bad" }, h("div", { class: "alert-title" }, "界面启动失败"), h("div", { class: "alert-body" }, String(error?.message ?? error)), h("button", { class: "btn primary mt-12", onClick: () => window.location.reload() }, "重新加载"))),
  );
});

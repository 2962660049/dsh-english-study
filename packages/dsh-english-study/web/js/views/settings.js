/**
 * Settings view: the 智谱 provider, the two editable prompts, speech, review
 * schedule and data.
 *
 * The provider block renders whatever adapters the host reports through `/state`,
 * but the page is specified to offer 智谱 GLM-4V-Flash ONLY — the priced providers
 * were deleted from the host registry, not merely hidden here, so nothing can route
 * to them even if an old setting survives. The API key is written but NEVER read
 * back: the host returns only `configured: true/false`, so a key can be replaced or
 * cleared but not displayed.
 *
 * The prompt editors are the heart of this page: the model's behaviour is the
 * product, so the user's own wording is editable and restorable.
 */

import { h, mount, toast } from "../ui.js";
import { state, subscribe, saveSettings, refresh, syncNow } from "../store.js";
import { api, exportUrl } from "../api.js";
import { storageMode, kvDelete } from "../db.js";
import { tts, onTtsChange } from "../tts.js";

export default function render() {
  const root = h("div", { class: "view" });
  const providerBody = h("div");
  const promptBody = h("div");
  const ttsBody = h("div");
  const reviewBody = h("div");
  const dataBody = h("div");

  let health = null;
  let voices = [];
  const draftKeys = {}; // provider id -> typed-but-unsaved key

  /* ------------------------------------------------------------ providers */

  function renderProviders() {
    const settings = state.settings;
    if (settings === null) {
      mount(providerBody, h("div", { class: "skeleton", style: { height: "80px" } }));
      return;
    }
    const providers = settings.availableProviders ?? [];
    const credentials = settings.credentials ?? {};

    mount(
      providerBody,
      h(
        "div",
        { class: "field" },
        h("label", null, "当前使用的识图与翻译服务"),
        h(
          "div",
          { class: "segmented" },
          providers.map((provider) =>
            h(
              "button",
              {
                type: "button",
                "aria-pressed": String(settings.activeProvider === provider.id),
                onClick: () => void apply({ activeProvider: provider.id }),
              },
              provider.label,
            ),
          ),
        ),
        h(
          "div",
          { class: "hint" },
          "本站只使用「智谱 GLM-4V-Flash」。它是智谱官方完全免费的图像理解模型：既能读出手写英文，也能完成纠错与翻译，不产生任何费用。去 bigmodel.cn 免费领一个 API Key 填到下面即可。",
        ),
      ),
      ...providers.map((provider) => {
        const credential = credentials[provider.id] ?? {};
        return h(
          "div",
          { class: "card tight", style: { marginTop: "12px" } },
          h(
            "div",
            { class: "card-head" },
            h("h3", { style: { margin: "0" } }, provider.label),
            h(
              "div",
              { class: "card-sub" },
              credential.configured ? "已配置 API Key" : "未配置 API Key",
              provider.capabilities?.vision ? " · 支持图片" : " · 不支持图片",
            ),
          ),
          h(
            "div",
            { class: "hint" },
            "免费 Key 领取地址：https://bigmodel.cn/usercenter/proj-mgmt/apikeys —— 注册后在「API Key」页新建即可，GLM-4V-Flash 不收费。",
          ),
          h(
            "div",
            { class: "field" },
            h("label", null, "API Key"),
            h("input", {
              type: "password",
              placeholder: credential.configured ? "已保存（留空则不变）" : "粘贴 API Key",
              autocomplete: "off",
              onInput: (event) => {
                draftKeys[provider.id] = event.target.value;
              },
            }),
          ),
          h(
            "div",
            { class: "grid cols-2" },
            h(
              "div",
              { class: "field" },
              h("label", null, "模型名称"),
              h("input", {
                type: "text",
                value: credential.model ?? provider.model ?? "",
                placeholder: "glm-4v-flash",
                onChange: (event) => void apply({ credentials: { [provider.id]: { model: event.target.value.trim() } } }),
              }),
            ),
            h(
              "div",
              { class: "field" },
              h("label", null, "Base URL（留空使用默认）"),
              h("input", {
                type: "text",
                value: credential.baseUrl ?? "",
                placeholder: "https://open.bigmodel.cn/api/paas/v4",
                onChange: (event) => void apply({ credentials: { [provider.id]: { baseUrl: event.target.value.trim() } } }),
              }),
            ),
          ),
          h(
            "div",
            { class: "row" },
            h(
              "button",
              {
                class: "primary",
                type: "button",
                onClick: (event) => {
                  const key = (draftKeys[provider.id] ?? "").trim();
                  if (key.length === 0) {
                    toast("请先粘贴 API Key", "warn");
                    return;
                  }
                  void run(event.currentTarget, "保存中…", async () => {
                    await apply({ credentials: { [provider.id]: { apiKey: key } } });
                    draftKeys[provider.id] = "";
                    toast(`${provider.label} API Key 已保存`, "ok");
                  });
                },
              },
              "保存 API Key",
            ),
            credential.configured
              ? h(
                  "button",
                  {
                    class: "ghost",
                    type: "button",
                    onClick: () =>
                      void apply({ credentials: { [provider.id]: { cleared: true } } }).then(() => toast("已清除该 API Key", "ok")),
                  },
                  "清除",
                )
              : null,
            h("div", { class: "spacer" }),
            h(
              "button",
              {
                type: "button",
                onClick: (event) =>
                  void run(event.currentTarget, "测试中…", async () => {
                    const result = await api.normalize({ text: "Good morning, world.", timeoutMs: 120_000 });
                    if (result?.degraded === true) {
                      toast(`服务已连通，但返回格式异常：${result.parseError ?? "未知"}`, "warn");
                    } else {
                      const first = result?.data?.segments?.[0];
                      toast(
                        `连通正常（${result?.adapter ?? provider.id}，${result?.elapsedMs ?? "?"} ms）：${first?.zh ?? first?.en ?? "已返回结果"}`,
                        "ok",
                      );
                    }
                  }),
              },
              "测试连通",
            ),
          ),
        );
      }),
    );
  }

  async function apply(patch) {
    try {
      await saveSettings(patch);
      await refresh({ silent: true });
    } catch (error) {
      toast(`设置保存失败：${error?.message ?? error}`, "bad");
    }
  }

  /** Run a button action with immediate loading + disabled + double-click guard. */
  async function run(button, busyLabel, action) {
    if (button.disabled) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
    try {
      await action();
    } catch (error) {
      toast(`操作失败：${error?.message ?? error}`, "bad", { timeoutMs: 9000 });
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  /* ----------------------------------------------------------------- prompts */

  /**
   * The user's own wording drives the model, so every prompt is editable here.
   * There are four, not two, because the diary read is three small calls: asking one
   * call to do all three jobs measurably lost ringed words (see lib/llm.js). Each
   * call appends its own machine-readable output contract AFTER whatever is saved,
   * which is why a hand-edited prompt can never break parsing.
   */
  function renderPrompts() {
    const settings = state.settings;
    if (settings === null) {
      mount(promptBody, h("div", { class: "skeleton", style: { height: "120px" } }));
      return;
    }
    const prompts = settings.prompts ?? {};
    const defaults = settings.defaultPrompts ?? {};
    const drafts = {
      pageText: prompts.pageText ?? "",
      pageWords: prompts.pageWords ?? "",
      collocations: prompts.collocations ?? "",
      normalize: prompts.normalize ?? "",
    };

    const makeEditor = (key, title, description) => {
      const area = h("textarea", {
        rows: "6",
        value: drafts[key],
        onInput: (event) => {
          drafts[key] = event.target.value;
        },
      });
      const status = h("span", { class: "faint small" });
      const refreshStatus = () => {
        status.textContent = drafts[key] === (defaults[key] ?? "") ? "当前为默认提示词" : "已自定义（与默认不同）";
      };
      refreshStatus();
      return h(
        "div",
        { class: "card tight", style: { marginTop: "12px" } },
        h(
          "div",
          { class: "card-head" },
          h("h3", { style: { margin: "0" } }, title),
          h("div", { class: "card-sub" }, description),
        ),
        area,
        h(
          "div",
          { class: "row mt-12" },
          h(
            "button",
            {
              class: "primary",
              type: "button",
              onClick: (event) => {
                const value = drafts[key].trim();
                if (value.length === 0) {
                  toast("提示词不能为空；要还原请点「恢复默认」", "warn");
                  return;
                }
                void run(event.currentTarget, "保存中…", async () => {
                  await apply({ prompts: { [key]: value } });
                  refreshStatus();
                  toast("提示词已保存", "ok");
                });
              },
            },
            "保存提示词",
          ),
          h(
            "button",
            {
              class: "ghost",
              type: "button",
              onClick: (event) => {
                const value = defaults[key] ?? "";
                if (value.length === 0) {
                  toast("拿不到默认提示词，请刷新页面重试", "warn");
                  return;
                }
                drafts[key] = value;
                area.value = value;
                refreshStatus();
                void run(event.currentTarget, "恢复中…", async () => {
                  await apply({ prompts: { [key]: value } });
                  toast("已恢复默认提示词", "ok");
                });
              },
            },
            "恢复默认",
          ),
          h("div", { class: "spacer" }),
          status,
        ),
      );
    };

    mount(
      promptBody,
      h(
        "div",
        { class: "hint" },
        "这些提示词会原样发给模型；系统随后自动附加一段「必须返回 JSON」或「每行一个单词」的格式约定，所以你可以自由改写措辞，不会把解析弄坏。识别手写日记会先后发出三次小请求，因此这里分开三段，各自都可以调整。",
      ),
      makeEditor("pageText", "① 抄写提示词", "把照片里的英文原样抄下来"),
      makeEditor("pageWords", "② 标注单词提示词", "找出被椭圆圈出的单词（这一句越短越准）"),
      makeEditor("collocations", "③ 固定搭配提示词", "指出这些单词在文中的固定搭配"),
      makeEditor("normalize", "其它文本提示词", "其它文本处理区：先判断语言，中文译成英文、英文纠正错误"),
    );
  }

  /* ------------------------------------------------------------------ tts */

  function renderTts() {
    const settings = state.settings?.tts ?? { lang: "en-US", rate: 0.9, pitch: 1 };
    const supported = tts.isSupported();
    mount(
      ttsBody,
      supported ? null : h("div", { class: "alert warn" }, "当前浏览器不支持语音合成（speechSynthesis），朗读功能不可用。"),
      h(
        "div",
        { class: "grid cols-3" },
        h(
          "div",
          { class: "field" },
          h("label", null, "朗读音色"),
          h(
            "select",
            {
              onChange: (event) => {
                const value = event.target.value;
                void apply({ tts: { voiceURI: value } });
              },
            },
            h("option", { value: "" }, "自动选择（推荐）"),
            voices.map((voice) =>
              h("option", { value: voice.voiceURI, selected: settings.voiceURI === voice.voiceURI }, `${voice.name} · ${voice.lang}`),
            ),
          ),
        ),
        h(
          "div",
          { class: "field" },
          h("label", null, `语速：${Number(settings.rate ?? 0.9).toFixed(2)}`),
          h("input", {
            type: "range",
            min: "0.5",
            max: "1.5",
            step: "0.05",
            value: String(settings.rate ?? 0.9),
            onInput: (event) => {
              const label = event.target.previousElementSibling;
              if (label) label.textContent = `语速：${Number(event.target.value).toFixed(2)}`;
            },
            onChange: (event) => void apply({ tts: { rate: Number(event.target.value) } }),
          }),
        ),
        h(
          "div",
          { class: "field" },
          h("label", null, "发音区域"),
          h("input", {
            type: "text",
            value: settings.lang ?? "en-US",
            onChange: (event) => void apply({ tts: { lang: event.target.value.trim() || "en-US" } }),
          }),
        ),
      ),
      h(
        "div",
        { class: "row" },
        h(
          "button",
          {
            type: "button",
            onClick: () =>
              void tts.speak("This is how the assistant will read your diary aloud.", {
                lang: settings.lang ?? "en-US",
                rate: Number(settings.rate ?? 0.9),
                onError: (error) => toast(`朗读失败：${error?.message ?? error}`, "bad"),
              }),
          },
          "试听",
        ),
        h("button", { class: "ghost", type: "button", onClick: () => tts.cancel() }, "停止"),
        h("div", { class: "hint" }, "朗读使用浏览器内置语音引擎，离线可用；整篇朗读会按句切分，因此可以逐句高亮。"),
      ),
    );
  }

  /* --------------------------------------------------------------- review */

  function renderReview() {
    const intervals = state.settings?.review?.intervalsMinutes ?? [5, 30, 720, 1440, 2880, 5760, 10080, 21600, 43200];
    const human = intervals.map((minutes) => (minutes < 60 ? `${minutes}分` : minutes < 1440 ? `${Math.round(minutes / 60)}时` : `${Math.round(minutes / 1440)}天`));
    mount(
      reviewBody,
      h("div", { class: "field" }, h("label", null, "遗忘曲线复习间隔（分钟，逗号分隔）"), h("input", {
        type: "text",
        value: intervals.join(", "),
        onChange: (event) => {
          const parsed = event.target.value
            .split(/[,，\s]+/)
            .map((part) => Number(part.trim()))
            .filter((value) => Number.isFinite(value) && value > 0);
          if (parsed.length === 0) {
            toast("间隔必须是正整数分钟", "warn");
            return;
          }
          void apply({ review: { intervalsMinutes: parsed } }).then(() => toast(`已保存 ${parsed.length} 个复习节点`, "ok"));
        },
      })),
      h("div", { class: "hint" }, `当前节点：${human.join(" → ")}`),
    );
  }

  /* ----------------------------------------------------------------- data */

  async function renderData() {
    const mode = await storageMode();
    const settings = state.settings;
    mount(
      dataBody,
      h(
        "div",
        { class: "grid cols-2" },
        h("div", null, h("div", { class: "faint small" }, "本地缓存"), h("div", null, mode === "indexeddb" ? "IndexedDB（持久）" : "内存（隐私模式下不可持久）")),
        h("div", null, h("div", { class: "faint small" }, "服务端数据目录"), h("div", { class: "mono small" }, health?.dataDir ?? "未知（服务未连接）")),
        h("div", null, h("div", { class: "faint small" }, "本地词典"), h("div", null, health?.dictionary?.state === "ready" ? `已加载 ${health.dictionary.size} 词条（ECDICT）` : "未加载，首次查词时载入")),
        h("div", null, h("div", { class: "faint small" }, "当前服务"), h("div", null, `${settings?.activeProvider ?? "?"}`)),
      ),
      h(
        "div",
        { class: "row mt-12" },
        h("a", { class: "btn", href: exportUrl("csv"), download: "english-study-vocab.csv" }, "导出 CSV"),
        h("a", { class: "btn", href: exportUrl("anki"), download: "english-study-anki.txt" }, "导出 Anki"),
        h("a", { class: "btn", href: exportUrl("json"), download: "english-study-backup.json" }, "导出 JSON 备份"),
        h(
          "button",
          {
            class: "ghost",
            type: "button",
            onClick: (event) =>
              void run(event.currentTarget, "同步中…", async () => {
                const result = await syncNow();
                toast(result.remaining > 0 ? `仍有 ${result.remaining} 项未同步` : "已与服务端同步", result.remaining > 0 ? "warn" : "ok");
              }),
          },
          "立即同步",
        ),
        h(
          "button",
          {
            class: "ghost danger",
            type: "button",
            onClick: () => {
              if (!window.confirm("清空本地缓存？服务端数据不受影响，下次刷新会重新拉取。")) return;
              void kvDelete("state:v1").then(() => {
                toast("本地缓存已清空，正在重新拉取…", "ok");
                return refresh();
              });
            },
          },
          "清空本地缓存",
        ),
      ),
    );
  }

  /* ----------------------------------------------------------------- root */

  mount(
    root,
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "识图与翻译服务"), h("div", { class: "card-sub" }, "智谱 GLM-4V-Flash · 官方免费 · 支持手写图片")), providerBody),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "提示词"), h("div", { class: "card-sub" }, "决定模型怎么读你的日记、怎么处理你粘贴的文本；可随时改回默认")), promptBody),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "语音朗读"), h("div", { class: "card-sub" }, "浏览器内置 Web Speech API · en-US · 语速 0.9")), ttsBody),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "复习计划")), reviewBody),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "数据与存储")), dataBody),
  );

  function update() {
    renderProviders();
    renderPrompts();
    renderTts();
    renderReview();
  }

  const unsubscribe = subscribe(update);
  const stopTts = onTtsChange(() => {});
  root.__dispose = () => {
    unsubscribe();
    stopTts();
  };
  update();
  void renderData();

  void api
    .health()
    .then((result) => {
      health = result;
      return renderData();
    })
    .catch(() => {});

  // Voices load asynchronously in Chromium; refresh the list when they arrive.
  if (tts.isSupported()) {
    const collect = () => {
      voices = (window.speechSynthesis?.getVoices?.() ?? []).filter((voice) => /^en/i.test(voice.lang));
      renderTts();
    };
    collect();
    window.speechSynthesis.addEventListener?.("voiceschanged", collect);
  }

  return root;
}

/**
 * Diary section — handwritten photos only.
 *
 *   /diary          -> a month calendar, an upload zone for today, and the list
 *                      of saved days
 *   /diary/<date>   -> one day's detail: the 抄写标注稿 photo, the extracted
 *                      English article with read-aloud, and the circled words
 *                      that were filed into the vocabulary bank.
 *
 * The page being photographed is ALREADY ENGLISH on which the learner has drawn
 * ellipses around the words they do not know. There is deliberately no correction
 * step, no text-paste box and no click-a-word-to-annotate step here: plain text
 * handling lives in 「其它文本处理区」, and the circled words come from the page's
 * own ellipses. Reading the page and filing the words is ONE click — 识别并入库:
 * upload the photo, call the import endpoint, show the result. The vision
 * provider behind that call is 智谱 GLM-4V-Flash.
 *
 * Only ONE photo is kept per day: the 抄写标注稿, the page that carries the
 * ellipses. A separate 原稿 slot used to exist and was removed — the recognition
 * only ever reads the annotated page, so keeping a second photo was pure busywork.
 *
 * DOM rules honoured throughout: nodes are built with `h()`, listeners are passed
 * as props, and the nodes that must be updated are kept in closure variables —
 * no element lookup or raw HTML injection is ever used.
 */

import { h, mount, toast, openLightbox, fmtDate, toDateKey } from "../ui.js";
import { state, subscribe, deleteDiaryEntry, updateWord, deleteWord } from "../store.js";
import { api, connection } from "../api.js";
import { speakButton, wordCard } from "../components.js";
import { tts } from "../tts.js";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

/** The single photo slot of one day. */
const PHOTO_SPEC = {
  role: "annotated",
  label: "抄写标注稿",
  hint: "圈出了生词的那一张——识别用的就是这张",
};

/**
 * A file chosen on the calendar landing page, handed to the day detail it opens.
 * Without this the landing page could only say「先点一个日期」, which is what made
 * the diary section look like it had no upload at all.
 */
let stagedFile = null;

/** True when a dropped or picked file looks like an image we can send. */
function isImageFile(file) {
  if (file === null || file === undefined) return false;
  if (/^image\//.test(String(file.type ?? ""))) return true;
  return /\.(jpe?g|png|webp|heic|heif|bmp)$/i.test(String(file.name ?? ""));
}

/**
 * Best-effort sentence splitter, used only when the host returns no `sentences`.
 * A plain forward scan is used on purpose: no look-behind, works everywhere.
 */
function splitSentences(text) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length === 0) return [];
  const parts = [];
  let start = 0;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    if (char !== "." && char !== "!" && char !== "?") continue;
    const next = clean[index + 1];
    if (next !== undefined && next !== " ") continue;
    parts.push(clean.slice(start, index + 1).trim());
    start = index + 1;
  }
  if (start < clean.length) parts.push(clean.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

/** The URL the host serves a stored, content-addressed image from. */
function imageUrl(storedImageId) {
  return `/english-study/api/images/${encodeURIComponent(String(storedImageId))}`;
}

/**
 * The host persists a day's photos as an array of stored-image ids, so a role is
 * a view-side concept. Entries written by this view keep their role; a bare id
 * list — including one written before 原稿 was dropped — is read as the
 * 抄写标注稿, because that is the only slot the diary keeps now.
 */
function normalizeImages(images) {
  const list = Array.isArray(images) ? images : [];
  if (list.length === 0) return [];
  if (list.every((item) => item !== null && typeof item === "object")) {
    return list
      .map((item) => {
        const id = String(item.storedImageId ?? item.id ?? "");
        return {
          role: typeof item.role === "string" ? item.role : PHOTO_SPEC.role,
          storedImageId: id,
          url: String(item.url ?? (id.length > 0 ? imageUrl(id) : "")),
          name: String(item.name ?? ""),
          uploaded: id.length > 0,
        };
      })
      .filter((item) => item.storedImageId.length > 0 || item.url.length > 0);
  }
  return list
    .map((id) => {
      const stored = String(id ?? "");
      return {
        role: PHOTO_SPEC.role,
        storedImageId: stored,
        url: imageUrl(stored),
        name: stored,
        uploaded: stored.length > 0,
      };
    })
    .filter((item) => item.storedImageId.length > 0);
}

/** The Chinese gloss of one circled word. */
function wordGloss(word) {
  return String(word?.glossZh ?? word?.gloss ?? "").trim();
}

/** The form as it appears on the page. */
function wordForm(word) {
  return String(word?.word ?? word?.lemma ?? "").trim();
}

function wordKey(word) {
  return String(word?.lemma ?? word?.word ?? "").trim().toLowerCase();
}

/* ============================================================== calendar === */

function renderCalendar() {
  const root = h("div", { class: "view" });
  const gridEl = h("div");
  const headEl = h("div", { class: "calendar-head" });
  const listEl = h("div");
  const uploadEl = h("div");
  const cursor = new Date();
  cursor.setDate(1);

  /**
   * Hand the picked file to today's detail page, which uploads it and runs the
   * import automatically. Before this existed the landing page could only tell
   * the reader to open a date first, so it looked like the diary had no upload.
   */
  function startToday(file) {
    if (file === null || file === undefined) return;
    if (!isImageFile(file)) {
      toast("请选择图片文件", "warn");
      return;
    }
    stagedFile = file;
    window.location.hash = `#/diary/${toDateKey()}`;
  }

  function renderUpload() {
    const input = h("input", {
      type: "file",
      accept: "image/*",
      style: { display: "none" },
      onChange: (event) => {
        const file = event.target.files?.[0];
        startToday(file);
        event.target.value = "";
      },
    });
    const stop = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    mount(
      uploadEl,
      h(
        "div",
        {
          class: "upload-zone",
          onDragenter: (event) => {
            stop(event);
            event.currentTarget.classList.add("over");
          },
          onDragover: (event) => {
            stop(event);
            if (event.dataTransfer !== undefined && event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
          },
          onDragleave: (event) => {
            stop(event);
            event.currentTarget.classList.remove("over");
          },
          onDrop: (event) => {
            stop(event);
            event.currentTarget.classList.remove("over");
            const file = event.dataTransfer?.files?.[0];
            if (isImageFile(file)) startToday(file);
            else toast("拖进来的不是图片文件", "warn");
          },
        },
        h(
          "div",
          { class: "upload-text" },
          h("b", null, "上传今天的抄写标注稿"),
          h(
            "div",
            { class: "faint small" },
            `把圈好生词的那张手写英文页面拖到这里，或点右边的按钮选择图片。识别出的英文和圈词会存进 ${toDateKey()} 这一天，单词自动进入单词库——一步完成，不需要先选日期。`,
          ),
        ),
        h("label", { class: "btn primary", style: { cursor: "pointer" } }, "📷 选择图片", input),
        h("a", { class: "btn ghost", href: `#/diary/${toDateKey()}` }, "只看今天"),
      ),
    );
  }

  function renderGrid() {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const byDate = new Map();
    for (const entry of state.diary) {
      if (!byDate.has(entry.date)) byDate.set(entry.date, []);
      byDate.get(entry.date).push(entry);
    }
    const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // Monday-first
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayKey = toDateKey();

    mount(
      headEl,
      h("button", { class: "ghost sm", type: "button", onClick: () => { cursor.setMonth(month - 1); renderGrid(); } }, "← 上月"),
      h("b", null, `${year} 年 ${month + 1} 月`),
      h("button", { class: "ghost sm", type: "button", onClick: () => { cursor.setMonth(month + 1); renderGrid(); } }, "下月 →"),
      h("div", { class: "spacer" }),
      h("button", { class: "ghost sm", type: "button", onClick: () => { cursor.setTime(Date.now()); cursor.setDate(1); renderGrid(); } }, "回到本月"),
      h("a", { class: "btn primary sm", href: `#/diary/${toDateKey()}` }, "＋ 写今天的日记"),
    );

    const cells = [];
    for (let index = 0; index < firstDow; index += 1) cells.push(h("div", { class: "calendar-cell blank" }));
    for (let day = 1; day <= daysInMonth; day += 1) {
      const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const entries = byDate.get(key) ?? [];
      cells.push(
        h(
          "a",
          {
            class: `calendar-cell${entries.length > 0 ? " has-entries" : ""}${key === todayKey ? " today" : ""}`,
            href: `#/diary/${key}`,
            title: entries.length > 0
              ? entries.map((entry) => entry.title || String(entry.corrected ?? "").slice(0, 24) || "日记").join(" / ")
              : "点击记录这一天的日记",
          },
          h("span", { class: "day" }, String(day)),
          entries.length > 0 ? h("span", { class: "badge" }, entries.length > 1 ? String(entries.length) : "●") : null,
        ),
      );
    }

    mount(
      gridEl,
      headEl,
      h("div", { class: "calendar-dow" }, WEEKDAYS.map((label) => h("span", null, label))),
      h("div", { class: "calendar-grid" }, cells),
    );
  }

  function renderList() {
    const entries = [...state.diary].sort((a, b) => {
      const byDate = String(b.date).localeCompare(String(a.date));
      return byDate !== 0 ? byDate : entrySeq(a) - entrySeq(b);
    });
    if (entries.length === 0) {
      mount(listEl, h("div", { class: "empty" }, "还没有日记。点击日历上的任意日期，或「＋ 写今天的日记」，拍一张已经抄好、圈好生词的英文页面。"));
      return;
    }
    mount(
      listEl,
      h(
        "div",
        { class: "word-list" },
        entries.map((entry) =>
          h(
            "div",
            { class: "row", style: { padding: "10px 0", borderBottom: "1px solid var(--border)" } },
            h(
              "a",
              { href: `#/diary/${entry.date}/${entrySeq(entry)}`, class: "mono" },
              entrySeq(entry) > 1 ? `${entry.date} · 第 ${entrySeq(entry)} 篇` : entry.date,
            ),
            h("span", { class: "gloss" }, entry.title || (entry.corrected ? `${String(entry.corrected).slice(0, 48)}…` : "（无内容）")),
            h("span", { class: "chip" }, `${entry.sentences?.length ?? 0} 句`),
            h("span", { class: "chip" }, `${entry.words?.length ?? 0} 词`),
            h("span", { class: "chip" }, `${normalizeImages(entry.images).length} 图`),
            h("div", { class: "spacer" }),
            h("span", { class: "faint small" }, fmtDate(entry.date)),
          ),
        ),
      ),
    );
  }

  function update() {
    renderGrid();
    renderList();
  }

  mount(
    root,
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "card-head" },
        h("h2", null, "日记分区"),
        h("div", { class: "card-sub" }, "把抄写标注稿拖进来即可识别并入库；有日记的日期带标记"),
      ),
      uploadEl,
    ),
    h(
      "div",
      { class: "card mt-12" },
      h("div", { class: "card-head" }, h("h2", null, "日历"), h("div", { class: "card-sub" }, "点任意日期可以查看或补录那一天的日记")),
      gridEl,
    ),
    h("div", { class: "card mt-12" }, h("div", { class: "card-head" }, h("h2", null, "全部日记")), listEl),
  );

  const unsubscribe = subscribe(update);
  root.__dispose = unsubscribe;
  renderUpload();
  update();
  return root;
}

/* ================================================================ detail === */

/** Page number of an entry inside its date; anything without one is page 1. */
function entrySeq(entry) {
  const value = Number(entry?.seq);
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 1;
}

/** All pages of one date, in reading order. */
function pagesOf(list, date) {
  return (list ?? [])
    .filter((entry) => entry.date === date)
    .sort((a, b) => entrySeq(a) - entrySeq(b));
}

function renderDetail(date, seq) {
  const pages = pagesOf(state.diary, date);
  const existing = pages.find((entry) => entrySeq(entry) === seq) ?? null;
  const nextExists = pages.some((entry) => entrySeq(entry) === seq + 1);

  /** The mutable working document. */
  let doc = existing !== null
    ? { ...existing, images: normalizeImages(existing.images) }
    : { id: null, date, seq, title: "", images: [], corrected: "", sentences: [], words: [], source: "diary" };

  /** Last import outcome: drives the alert, the degraded panel and the word list. */
  let outcome = doc.id === null
    ? null
    : {
        ok: true,
        degraded: false,
        addedCount: Array.isArray(doc.words) ? doc.words.length : 0,
        words: Array.isArray(doc.words) ? doc.words : [],
        partial: false,
        collocationsFailed: false,
        rawText: "",
        parseError: "",
      };

  /**
   * Double-submit guard. A disabled attribute alone is not enough — a queued
   * second click or a programmatic dispatch can still enter. This flag is the lock.
   */
  let submitting = false;
  let busy = false;

  const root = h("div", { class: "view" });
  const cardEl = h("div");

  /**
   * Live sub-nodes: they are moved into whatever card node is current, so
   * rebuilding the card never loses the chosen file inputs or the open state of
   * the word cards.
   */
  const photosEl = h("div", { class: "photo-grid" });
  const wordsEl = h("div");

  function offline() {
    return connection.online === false;
  }

  function imageFor(role) {
    return (doc.images ?? []).find((image) => image.role === role) ?? null;
  }

  function pendingImages() {
    return (doc.images ?? []).filter((image) => image.uploaded !== true || String(image.storedImageId ?? "").length === 0);
  }

  function storedImages() {
    return (doc.images ?? [])
      .filter((image) => typeof image.storedImageId === "string" && image.storedImageId.length > 0)
      .map((image) => (typeof image.role === "string" && image.role.length > 0
        ? { storedImageId: image.storedImageId, role: image.role }
        : { storedImageId: image.storedImageId }));
  }

  function sentencesOf(entry) {
    const list = Array.isArray(entry?.sentences) ? entry.sentences : [];
    const mapped = list
      .map((item) => ({ en: String(item?.en ?? item?.english ?? item?.text ?? "").trim() }))
      .filter((item) => item.en.length > 0);
    if (mapped.length > 0) return mapped;
    return splitSentences(entry?.corrected ?? doc.corrected ?? "").map((en) => ({ en }));
  }

  function circledWords() {
    const fromOutcome = Array.isArray(outcome?.words) ? outcome.words : [];
    if (fromOutcome.length > 0) return fromOutcome;
    return Array.isArray(doc.words) ? doc.words : [];
  }

  /** The merged vocabulary-bank record for one circled word, if it exists. */
  function bankWord(word) {
    const key = wordKey(word);
    if (key.length === 0) return null;
    return (state.vocabWords ?? []).find((entry) => String(entry.lemma ?? "").toLowerCase() === key) ?? null;
  }

  /** The circled words that came from one sentence — the 对照, per sentence. */
  function wordsInSentence(sentence, words) {
    const text = String(sentence ?? "").toLowerCase();
    if (text.length === 0) return [];
    return words.filter((word) => {
      const form = wordForm(word).toLowerCase();
      const lemma = wordKey(word);
      if (form.length > 0 && text.includes(form)) return true;
      return lemma.length > 2 && text.includes(lemma);
    });
  }

  /* ---------------------------------------------------------------- photos */

  /**
   * A hidden `<input type="file">` plus the label that opens it.
   *
   * The picker is a `<label>` WRAPPING the input rather than a `<button>` that
   * calls `.click()`: a label activates its own control natively, while a
   * programmatic click is not available in every host. The same container also
   * accepts a dropped file, because dragging a photo in is the natural gesture
   * and the first version of this view silently ignored it.
   */
  function filePicker({ label, onFile }) {
    const input = h("input", {
      type: "file",
      accept: "image/*",
      style: { display: "none" },
      onChange: (event) => {
        const file = event.target.files?.[0];
        onFile(file);
        // Allow re-picking the same file after a 替换.
        event.target.value = "";
      },
    });
    return { input, label: h("label", { class: "btn primary sm", style: { cursor: "pointer" } }, label, input) };
  }

  /** Drop handlers shared by the empty box and the filled slot. */
  function dropHandlers(onFile) {
    const stop = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    return {
      onDragenter: (event) => {
        stop(event);
        event.currentTarget.classList.add("over");
      },
      onDragover: (event) => {
        stop(event);
        if (event.dataTransfer !== undefined && event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
      },
      onDragleave: (event) => {
        stop(event);
        event.currentTarget.classList.remove("over");
      },
      onDrop: (event) => {
        stop(event);
        event.currentTarget.classList.remove("over");
        const file = event.dataTransfer?.files?.[0];
        if (isImageFile(file)) onFile(file);
        else toast("拖进来的不是图片文件", "warn");
      },
    };
  }

  function photoSlot(spec) {
    const image = imageFor(spec.role);
    const hasImage = image !== null && String(image.url ?? "").length > 0;
    const pending = image !== null && image.uploaded !== true;
    const onFile = (file) => {
      if (file === null || file === undefined) return;
      if (!isImageFile(file)) {
        toast("请选择图片文件", "warn");
        return;
      }
      void uploadPhoto(spec, file);
    };
    const picker = filePicker({ label: hasImage ? "替换图片" : "选择图片", onFile });

    if (!hasImage) {
      // The whole dashed box is itself the label, so there is no small button to
      // miss — that was the shape that made the diary look like it could not be
      // clicked. The box also accepts a dropped file.
      return h(
        "div",
        { class: "photo-col", ...dropHandlers(onFile) },
        h(
          "label",
          { class: "photo-add", style: { width: "100%", cursor: "pointer" }, title: "点击选择图片，或把图片拖到这里" },
          h("div", null, pending ? "…" : "📷"),
          h("div", { class: "small" }, pending ? "上传中…" : "点击选择，或把图片拖进来"),
          picker.input,
        ),
        h("div", { class: "photo-cap-line" }, spec.label),
        h("div", { class: "faint small" }, spec.hint),
      );
    }

    return h(
      "div",
      { class: "photo-col", ...dropHandlers(onFile) },
      h(
        "div",
        { class: "photo" },
        h("img", { src: image.url, alt: spec.label, onClick: () => openLightbox(image.url, spec.label) }),
        h("div", { class: "photo-cap" }, spec.label),
      ),
      h(
        "div",
        { class: "row", style: { justifyContent: "center" } },
        picker.label,
        h(
          "button",
          {
            class: "ghost sm",
            type: "button",
            onClick: () => {
              doc.images = (doc.images ?? []).filter((entry) => entry.role !== spec.role);
              renderPhotos();
            },
          },
          "移除",
        ),
      ),
      h("div", { class: "faint small" }, spec.hint),
    );
  }

  function renderPhotos() {
    mount(photosEl, photoSlot(PHOTO_SPEC));
  }

  /** Reads and stores one photo. Resolves to the stored record, or null on failure. */
  async function uploadPhoto(spec, file) {
    if (file === undefined || file === null) return null;
    if (!isImageFile(file)) {
      toast("请选择图片文件", "warn");
      return null;
    }
    if (busy) return null;
    busy = true;
    let stored = null;
    try {
      const base64 = await readFileAsBase64(file);
      const result = await api.uploadImage(base64, file.type);
      const image = result?.image;
      if (image === undefined || image === null) throw new Error("上传返回缺少 image 字段");
      stored = {
        role: spec.role,
        storedImageId: image.id,
        url: image.url ?? imageUrl(image.id),
        name: file.name || String(image.id ?? ""),
        uploaded: true,
      };
      doc.images = [...(doc.images ?? []).filter((entry) => entry.role !== spec.role), stored];
      toast(`${spec.label} 已上传`, "ok");
      renderAll();
    } catch (error) {
      toast(`上传失败：${error?.message ?? error}`, "bad", { timeoutMs: 12000 });
    } finally {
      busy = false;
    }
    return stored;
  }

  /* --------------------------------------------------------------- import */

  /**
   * THE one click: upload whatever is not uploaded yet, then hand the stored ids
   * to the host. Storing is content-addressed by sha256, so re-sending an image
   * that is already stored is a no-op, and the import itself is idempotent per
   * requestId. The api layer already applies its timeout and 1s/2s/4s backoff, so
   * this function never retries by itself.
   */
  async function submit() {
    if (submitting) return;
    if (offline()) {
      toast("当前离线，无法提交照片", "warn");
      return;
    }
    if ((doc.images ?? []).length === 0) {
      toast("请先上传「抄写标注稿」照片", "warn");
      return;
    }

    submitting = true;
    renderAll();

    try {
      for (const image of pendingImages()) {
        const base64 = String(image.base64 ?? "");
        if (base64.length === 0) {
          const spec = image.role === PHOTO_SPEC.role ? PHOTO_SPEC : null;
          throw new Error(`「${spec?.label ?? image.role}」尚未上传完成，请重新选择图片`);
        }
        const result = await api.uploadImage(base64, image.mimeType ?? "image/jpeg");
        const uploaded = result?.image;
        if (uploaded === undefined || uploaded === null) throw new Error("上传返回缺少 image 字段");
        image.storedImageId = uploaded.id;
        image.url = uploaded.url ?? imageUrl(uploaded.id);
        image.uploaded = true;
        image.base64 = undefined;
      }

      const uploads = storedImages();
      if (uploads.length === 0) throw new Error("没有可识别的图片，请重新上传");

      const result = await api.importDiary({
        images: uploads,
        date,
        seq,
        id: doc.id ?? undefined,
      });

      if (result?.degraded === true) {
        // Never a blank screen: the raw model output plus a re-parse button.
        outcome = {
          ok: false,
          degraded: true,
          addedCount: 0,
          words: [],
          partial: false,
          collocationsFailed: false,
          rawText: String(result?.rawText ?? ""),
          parseError: result?.parseError ?? "",
        };
        toast("识别结果解析失败，已显示原文，可点「重新解析」再试一次。", "warn", { timeoutMs: 12000 });
        renderAll();
        return;
      }

      const entry = result?.entry ?? null;
      if (entry === null) throw new Error("识别成功但未返回日记内容");

      const addedWords = Array.isArray(result?.addedWords) && result.addedWords.length > 0
        ? result.addedWords
        : (Array.isArray(entry.words) ? entry.words : []);

      doc = {
        ...doc,
        ...entry,
        // Keep the role-labelled photo objects; the host returns bare ids.
        images: doc.images,
        sentences: Array.isArray(entry.sentences) && entry.sentences.length > 0 ? entry.sentences : sentencesOf(entry),
        words: addedWords,
      };
      const addedCount = Number.isFinite(Number(result?.addedCount)) ? Number(result.addedCount) : addedWords.length;
      // Two soft failures the host reports rather than hides: the second word pass
      // failed (so the list may be short) and the fixed-phrase pass failed. Neither
      // is worth discarding the page for, but the learner should know.
      const collocationsFailed = result?.collocationsFailed === true;
      const partial = result?.partial === true;
      outcome = {
        ok: true,
        degraded: false,
        addedCount,
        words: addedWords,
        partial,
        collocationsFailed,
        rawText: "",
        parseError: "",
      };
      toast(`识别完成：已自动加入单词库（${addedCount} 个）`, "ok");
      if (partial) toast("圈词只完成了一次识别，结果可能偏少；可点「重新识别」再跑一次", "warn", { timeoutMs: 12000 });
      else if (collocationsFailed) toast("这次没取到固定搭配，其余内容已保存", "warn", { timeoutMs: 9000 });
      renderAll();
    } catch (error) {
      const message = error?.message ?? String(error);
      // The api layer already retried; whether to try again is the user's call.
      toast(`识别失败：${message}`, "bad", {
        timeoutMs: 12000,
        action: { label: "重试", onClick: () => { void submit(); } },
      });
    } finally {
      submitting = false;
      renderAll();
    }
  }

  /* ------------------------------------------------------------- articles */

  function sentenceRow(sentence, index, words) {
    const inSentence = wordsInSentence(sentence.en, words);
    return h(
      "div",
      { class: "parallel-row" },
      h(
        "div",
        { class: "en" },
        h("span", null, sentence.en),
        speakButton(sentence.en, { label: "🔊", title: "朗读这一句" }),
        h("div", { class: "spacer" }),
        h("span", { class: "faint small" }, `第 ${index + 1} 句`),
      ),
      // 对照, done cheaply and without a toggle: the sentence, then the Chinese
      // gloss of each word the learner circled inside it.
      inSentence.length === 0
        ? null
        : h(
            "div",
            { class: "small faint" },
            `本句圈词：${inSentence.map((word) => `${wordForm(word)}${wordGloss(word) ? `（${wordGloss(word)}）` : ""}`).join("、")}`,
          ),
    );
  }

  function renderSentences(sentences, words) {
    if (sentences.length === 0) {
      return h("div", { class: "empty" }, "还没有识别出英文正文。上传「抄写标注稿」后点「识别并入库」。");
    }
    return h("div", { class: "parallel" }, sentences.map((sentence, index) => sentenceRow(sentence, index, words)));
  }

  function degradedPanel() {
    return h(
      "div",
      { class: "alert warn" },
      h(
        "div",
        { class: "alert-body" },
        h("div", { class: "alert-title" }, "识别结果解析失败，已显示原文"),
        h(
          "div",
          { class: "small pre-wrap" },
          outcome?.rawText && String(outcome.rawText).length > 0 ? String(outcome.rawText) : "（模型没有返回任何可显示的内容）",
        ),
        outcome?.parseError ? h("div", { class: "faint small" }, `解析错误：${String(outcome.parseError)}`) : null,
      ),
      h("button", { class: "sm", type: "button", disabled: offline(), onClick: () => { void submit(); } }, "重新解析"),
    );
  }

  /* ---------------------------------------------------------------- words */

  function renderWords() {
    const words = circledWords();
    if (words.length === 0) {
      mount(wordsEl, h("div", { class: "empty" }, "这一天还没有圈出的单词。识别完成后，页面上画圈的词会自动进入这里，并同时加入单词库。"));
      return;
    }
    mount(
      wordsEl,
      h(
        "div",
        { class: "word-list" },
        words.map((entry) => {
          const merged = bankWord(entry);
          const record = merged ?? {
            id: wordKey(entry),
            lemma: entry.lemma ?? wordForm(entry),
            word: wordForm(entry),
            phonetic: entry.phonetic ?? "",
            glossZh: wordGloss(entry),
            partOfSpeech: entry.partOfSpeech ?? "",
            inflections: Array.isArray(entry.inflections) ? entry.inflections : [],
            collocations: Array.isArray(entry.collocations) ? entry.collocations : [],
            examples: [],
            status: "new",
            starred: false,
            annotations: entry.sentence
              ? [{ sentence: entry.sentence, sentenceZh: "", source: "diary", sourceRef: doc.id ?? "", at: doc.updatedAt ?? "" }]
              : [],
          };
          return wordCard(record, {
            pending: merged === null ? undefined : state.pending?.[String(merged.lemma ?? "").toLowerCase()],
            onChange: (patch) => {
              if (merged === null) return;
              void updateWord(merged.id, patch).then((result) => {
                if (result.ok !== true) toast(`更新失败：${result.error}`, "bad");
              });
            },
            onDelete: () => {
              if (merged === null) return;
              if (!window.confirm(`从单词库删除「${merged.lemma}」？`)) return;
              void deleteWord(merged.id).then((result) => {
                if (result.ok !== true) toast(`删除失败：${result.error}`, "bad");
                else toast(`「${merged.lemma}」已删除`, "ok");
              });
            },
          });
        }),
      ),
    );
  }

  /* ----------------------------------------------------------------- card */

  function primaryLabel() {
    if (submitting) return "识别中…";
    if (offline()) return "离线，无法提交";
    if ((doc.images ?? []).length === 0) return "请先上传「抄写标注稿」";
    return outcome?.degraded === true ? "重新解析并入库" : "识别并入库";
  }

  /**
   * Page navigation, pinned to the page's top-right.
   *
   * 下一篇 appears only once THIS page exists (or a later page already does), which
   * is the user's rule 「未打开第二篇的时候不会建立下一页」: the link only navigates,
   * and the host writes the record when that page is actually imported.
   */
  function pageNav() {
    const canGoNext = doc.id !== null || nextExists;
    return h(
      "div",
      { class: "page-nav" },
      seq > 1 ? h("a", { class: "btn ghost sm", href: `#/diary/${date}/${seq - 1}` }, "← 上一篇") : null,
      h("span", { class: "faint small" }, `第 ${seq} 篇`),
      canGoNext
        ? h(
            "a",
            {
              class: "btn primary sm",
              href: `#/diary/${date}/${seq + 1}`,
              title: `继续抄写这一天的第 ${seq + 1} 篇`,
            },
            "下一篇 →",
          )
        : null,
    );
  }

  /** Rebuild the whole detail body from the current `doc` / `outcome`. */
  function renderAll() {
    renderPhotos();
    renderWords();
    // Deliberately not named `words`: that would shadow the live `wordsEl` node.
    const sentenceList = sentencesOf(doc);
    const circledList = circledWords();
    const hasImages = (doc.images ?? []).length > 0;

    mount(
      cardEl,
      h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "card-head" },
          h(
            "div",
            null,
            h("h2", null, seq > 1 ? `${fmtDate(date)} 的日记 · 第 ${seq} 篇` : `${fmtDate(date)} 的日记`),
            h(
              "div",
              { class: "card-sub" },
              "拍的是已经抄好的英文页面，在生词上画圈即可",
              " · ",
              doc.id === null ? "新建（尚未保存）" : "已保存",
              doc.updatedAt ? ` · 更新于 ${String(doc.updatedAt).slice(0, 16).replace("T", " ")}` : "",
            ),
          ),
          h("div", { class: "spacer" }),
          pageNav(),
        ),
        h(
          "div",
          { class: "row" },
          h("a", { class: "btn ghost sm", href: "#/diary" }, "← 返回日历"),
          doc.id !== null
            ? h(
                "button",
                {
                  class: "ghost sm danger",
                  type: "button",
                  onClick: async () => {
                    if (!window.confirm("删除这一天的日记？已收录的单词不会被删除。")) return;
                    const result = await deleteDiaryEntry(doc.id);
                    if (result.ok !== true) toast(`删除失败：${result.error}`, "bad");
                    else {
                      toast("已删除", "ok");
                      window.location.hash = "#/diary";
                    }
                  },
                },
                "删除日记",
              )
            : null,
          h("div", { class: "spacer" }),
          h("span", { class: "faint small" }, `照片 ${(doc.images ?? []).length} 张 · 句子 ${sentenceList.length} 句 · 圈词 ${circledList.length} 个`),
        ),
        photosEl,
        h(
          "div",
          { class: "row mt-12" },
          h(
            "button",
            {
              class: "primary",
              type: "button",
              disabled: submitting || offline() || !hasImages,
              title: offline()
                ? "离线时无法提交，联网后再试"
                : !hasImages
                  ? "先上传「抄写标注稿」"
                  : "上传照片 → 识别英文与圈词 → 自动加入单词库（智谱 GLM-4V-Flash）",
              onClick: () => { void submit(); },
            },
            primaryLabel(),
          ),
          h(
            "button",
            {
              class: "ghost",
              type: "button",
              disabled: submitting || offline() || !hasImages,
              title: "用同一批照片再跑一次识别，已入库的单词不会重复",
              onClick: () => { void submit(); },
            },
            "重新识别",
          ),
          h("div", { class: "spacer" }),
          h("span", { class: "faint small" }, offline() ? "离线中" : "在线"),
        ),
        h(
          "div",
          { class: "hint" },
          "「抄写标注稿」上画的每一个圈都会被读成生词，识别的同时直接进入单词库——不需要再确认，也不需要粘贴文本。纯文本请到「其它文本处理区」。",
        ),
        outcome?.degraded === true ? degradedPanel() : null,
        outcome?.ok === true
          ? h(
              "div",
              { class: "alert ok" },
              h("div", { class: "alert-body" }, h("div", { class: "alert-title" }, `已自动加入单词库（${outcome.addedCount} 个）`)),
            )
          : null,
      ),
      h(
        "div",
        { class: "card mt-12" },
        h(
          "div",
          { class: "card-head" },
          h("h2", null, "识别出的英文原文"),
          h("div", { class: "card-sub" }, `共 ${sentenceList.length} 句 · 页面本身已经是英文，所以只需要正文；每个圈词的中文释义就放在它的来源句下方`),
        ),
        h(
          "div",
          { class: "row mb-12" },
          h(
            "button",
            {
              class: "primary sm",
              type: "button",
              disabled: sentenceList.length === 0,
              onClick: () => {
                if (!tts.isSupported()) {
                  toast("当前浏览器不支持语音合成", "warn");
                  return;
                }
                void tts.speakSequence(sentenceList.map((sentence) => sentence.en), {
                  onError: (error) => toast(`朗读失败：${error?.message ?? error}`, "bad"),
                });
              },
            },
            "▶ 整篇朗读",
          ),
          h("button", { class: "ghost sm", type: "button", onClick: () => tts.cancel() }, "停止"),
        ),
        renderSentences(sentenceList, circledList),
      ),
      h(
        "div",
        { class: "card mt-12" },
        h(
          "div",
          { class: "card-head" },
          h("h2", null, "圈出的生词"),
          h("div", { class: "card-sub" }, "原形 / 词形变化 / 固定搭配 / 释义 / 来源句子 —— 全部由页面上的圈自动建立"),
        ),
        wordsEl,
      ),
    );
  }

  mount(root, cardEl);

  // A refreshed snapshot can replace the merged vocabulary records, so re-render.
  const unsubscribe = subscribe(renderAll);
  root.__dispose = unsubscribe;
  renderAll();

  // A photo dropped on the landing page arrives here: upload it and run the
  // import straight away, so dropping a page really is the whole interaction.
  if (stagedFile !== null) {
    const file = stagedFile;
    stagedFile = null;
    if (isImageFile(file)) {
      void uploadPhoto(PHOTO_SPEC, file).then((uploaded) => (uploaded ? submit() : null));
    } else {
      toast("请选择图片文件", "warn");
    }
  }
  return root;
}

/* ================================================================ export === */

export default function render({ params } = {}) {
  const date = params?.date;
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    // A date may hold several pages. The calendar always opens the FIRST one, so a
    // page number is only honoured when the deep link carries it explicitly.
    const page = Number(params?.page);
    const seq = Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1;
    return renderDetail(date, seq);
  }
  return renderCalendar();
}

/**
 * Application state.
 *
 * Pattern required by the spec: optimistic update + pending-sync flag + periodic
 * auto-sync, over a local IndexedDB cache.
 *
 *   - The cached snapshot is rendered immediately, so a cold start never shows a
 *     blank page and a dead network still shows yesterday's data (`stale: true`).
 *   - Mutations update local state first and mark the affected lemma `pending`.
 *     If the request is queued by the offline outbox the word keeps its pending
 *     badge until the replay succeeds.
 *   - A periodic tick flushes the outbox and refreshes the snapshot.
 */

import { api, connection, flushOutbox, onConnectionChange, refreshQueueDepth } from "./api.js";
import { kvGet, kvPut } from "./db.js";

const CACHE_KEY = "state:v1";
const AUTO_SYNC_INTERVAL_MS = 60_000;

export const state = {
  /** True once some snapshot (cache or network) has been applied. */
  loaded: false,
  loading: false,
  refreshing: false,
  /** True when the visible data came from the cache and may be out of date. */
  stale: false,
  /** @type {string | null} */
  error: null,
  /** @type {object[]} */
  diary: [],
  /** @type {object[]} */
  vocabEvents: [],
  /** @type {object[]} */
  vocabWords: [],
  /** @type {object | null} */
  settings: null,
  /** lemma(lowercase) -> "saving" | "queued" | "failed" */
  pending: {},
  lastSyncAt: null,
  lastLoadAt: null,
};

/** @type {Set<(state: object) => void>} */
const listeners = new Set();

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (error) {
      console.error("[english-study] state listener failed:", error);
    }
  }
}

function set(changes) {
  Object.assign(state, changes);
  emit();
}

/* ------------------------------------------------------------------ snapshot */

function applySnapshot(snapshot, { stale }) {
  set({
    diary: Array.isArray(snapshot.diary) ? snapshot.diary : [],
    vocabEvents: Array.isArray(snapshot.vocabEvents) ? snapshot.vocabEvents : [],
    vocabWords: Array.isArray(snapshot.vocabWords) ? snapshot.vocabWords : [],
    settings: snapshot.settings ?? state.settings,
    loaded: true,
    stale,
    lastLoadAt: Date.now(),
    lastSyncAt: Date.now(),
  });
}

/** Load the cache first (instant paint), then the network. */
export async function bootstrap() {
  if (state.loading) return;
  set({ loading: true, error: null });
  try {
    const cached = await kvGet(CACHE_KEY);
    if (cached !== null && cached !== undefined && !state.loaded) {
      applySnapshot(cached, { stale: true });
    }
  } catch (error) {
    console.warn("[english-study] 读取本地缓存失败:", error);
  } finally {
    set({ loading: false });
  }
  await refresh({ silent: state.loaded });
}

/**
 * Fetch the authoritative snapshot.
 * @param {{ silent?: boolean }} [options] silent suppresses the error banner when
 *   cached data is already on screen.
 */
export async function refresh(options = {}) {
  if (state.refreshing) return;
  set({ refreshing: true });
  try {
    const snapshot = await api.fetchState();
    applySnapshot(snapshot, { stale: false });
    set({ error: null });
    await kvPut(CACHE_KEY, {
      diary: snapshot.diary,
      vocabEvents: snapshot.vocabEvents,
      vocabWords: snapshot.vocabWords,
      settings: snapshot.settings,
    });
  } catch (error) {
    const message = error?.message ?? String(error);
    console.error("[english-study] 刷新失败:", error);
    if (!options.silent || !state.loaded) {
      set({ error: message, stale: state.loaded });
    } else {
      set({ stale: true });
    }
  } finally {
    set({ refreshing: false });
  }
}

/* ------------------------------------------------------------- local helpers */

function markPending(lemma, value) {
  const next = { ...state.pending };
  if (value === null) delete next[lemma];
  else next[lemma] = value;
  set({ pending: next });
}

/** Mirror of the host's upsertWord so the UI is correct before the round trip. */
function applyAnnotationLocally(event) {
  const key = event.lemma.toLowerCase();
  const words = [...state.vocabWords];
  let index = words.findIndex((entry) => entry.lemma.toLowerCase() === key);
  if (index === -1) {
    words.unshift({
      id: key,
      lemma: event.lemma,
      phonetic: event.phonetic ?? "",
      glossZh: event.glossZh ?? "",
      partOfSpeech: event.partOfSpeech ?? "",
      inflections: event.inflections ?? [],
      examples: event.examples ?? [],
      status: "new",
      starred: false,
      note: "",
      sources: [event.source],
      annotations: [event],
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
      /** Local-only marker: the write has not been confirmed by the host. */
      optimistic: true,
    });
  } else {
    const merged = { ...words[index] };
    for (const field of ["phonetic", "glossZh", "partOfSpeech"]) {
      if (typeof event[field] === "string" && event[field].length > 0) merged[field] = event[field];
    }
    if (Array.isArray(event.inflections) && event.inflections.length > 0) merged.inflections = event.inflections;
    if (Array.isArray(event.examples) && event.examples.length > 0) merged.examples = event.examples;
    merged.annotations = [event, ...(merged.annotations ?? [])];
    merged.sources = merged.sources?.includes(event.source) ? merged.sources : [...(merged.sources ?? []), event.source];
    merged.updatedAt = event.createdAt;
    merged.optimistic = true;
    words[index] = merged;
  }
  set({ vocabWords: words, vocabEvents: [event, ...state.vocabEvents] });
}

/* -------------------------------------------------------------- mutations */

/**
 * Annotate a word: optimistic insert, then confirm with the host.
 * @param {object} payload the annotation event
 * @returns {Promise<{ ok: boolean, queued?: boolean, error?: string }>}
 */
export async function annotateWord(payload) {
  const event = {
    id: payload.id ?? `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    lemma: (payload.lemma ?? payload.word ?? "").toLowerCase(),
    createdAt: new Date().toISOString(),
    source: payload.source ?? "webtest",
    ...payload,
  };
  applyAnnotationLocally(event);
  markPending(event.lemma.toLowerCase(), "saving");
  try {
    const response = await api.annotate(event);
    if (response?.queued) {
      markPending(event.lemma.toLowerCase(), "queued");
      return { ok: true, queued: true };
    }
    markPending(event.lemma.toLowerCase(), null);
    // The host is authoritative about the merged record; adopt its view.
    if (Array.isArray(response?.vocabWords)) set({ vocabWords: response.vocabWords });
    return { ok: true };
  } catch (error) {
    markPending(event.lemma.toLowerCase(), "failed");
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** Update a word's learning state, optimistically. */
export async function updateWord(id, patch) {
  const words = state.vocabWords.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
  set({ vocabWords: words });
  try {
    const response = await api.updateWord(id, patch);
    if (response?.queued) return { ok: true, queued: true };
    if (response?.word) {
      set({ vocabWords: state.vocabWords.map((entry) => (entry.id === id ? response.word : entry)) });
    }
    return { ok: true };
  } catch (error) {
    await refresh({ silent: true });
    return { ok: false, error: error?.message ?? String(error) };
  }
}

export async function deleteWord(id) {
  const previous = state.vocabWords;
  set({ vocabWords: state.vocabWords.filter((entry) => entry.id !== id) });
  try {
    const response = await api.deleteWord(id);
    if (response?.queued) return { ok: true, queued: true };
    return { ok: true };
  } catch (error) {
    set({ vocabWords: previous });
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** Persist a diary entry (create or update) and adopt the host's record. */
export async function saveDiaryEntry(entry) {
  const response = await api.saveDiary(entry);
  if (response?.queued) return { ok: true, queued: true, entry };
  await refresh({ silent: true });
  return { ok: true, entry: response?.entry ?? entry };
}

export async function deleteDiaryEntry(id) {
  const response = await api.deleteDiary(id);
  if (response?.queued) {
    set({ diary: state.diary.filter((item) => item.id !== id) });
    return { ok: true, queued: true };
  }
  await refresh({ silent: true });
  return { ok: true };
}

export async function saveSettings(patch) {
  const response = await api.saveSettings(patch);
  if (response?.settings) {
    set({ settings: response.settings });
    await kvPut(CACHE_KEY, {
      diary: state.diary,
      vocabEvents: state.vocabEvents,
      vocabWords: state.vocabWords,
      settings: response.settings,
    });
  }
  return { ok: true, queued: Boolean(response?.queued), settings: response?.settings ?? state.settings };
}

/* --------------------------------------------------------------- selectors */

/** Vocabulary grouped by first letter, duplicates merged (one entry per lemma). */
export function groupByLetter(words) {
  const groups = new Map();
  for (const word of words) {
    const first = (word.lemma ?? "?").trim().charAt(0).toUpperCase();
    const key = /[A-Z]/.test(first) ? first : "#";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(word);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b)))
    .map(([letter, entries]) => ({
      letter,
      words: entries.sort((a, b) => a.lemma.localeCompare(b.lemma)),
    }));
}

/** Annotation events newest first — duplicates deliberately NOT merged. */
export function sortedEvents() {
  return [...state.vocabEvents].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function diaryByDate() {
  const map = new Map();
  for (const entry of state.diary) {
    if (!map.has(entry.date)) map.set(entry.date, []);
    map.get(entry.date).push(entry);
  }
  return map;
}

/** Overview metrics for the home screen. */
export function overview() {
  const todayKey = new Date().toLocaleDateString("sv-SE"); // sv-SE yields YYYY-MM-DD
  const today = state.vocabEvents.filter((event) => String(event.createdAt ?? "").slice(0, 10) === todayKey);
  const due = state.vocabWords.filter((word) => word.status === "new" || word.status === "learning");
  const mastered = state.vocabWords.filter((word) => word.status === "mastered");
  return {
    todayNew: today.length,
    dueCount: due.length,
    masteredCount: mastered.length,
    totalWords: state.vocabWords.length,
    totalAnnotations: state.vocabEvents.length,
    diaryDays: new Set(state.diary.map((entry) => entry.date)).size,
  };
}

/* ------------------------------------------------------------------ syncing */

let syncTimer = null;

/**
 * Periodic auto-sync: deliver queued mutations, then refresh the snapshot.
 * Also mirrors connection state into the store so views can react.
 */
export function startAutoSync(intervalMs = AUTO_SYNC_INTERVAL_MS) {
  onConnectionChange((info) => {
    // Keep the UI honest about connectivity and queue depth.
    set({ lastSyncAt: info.lastSyncAt ?? state.lastSyncAt });
  });
  const tick = async () => {
    if (!connection.online) return;
    const queued = await refreshQueueDepth();
    if (queued > 0) {
      const result = await flushOutbox();
      if (result.delivered > 0) await refresh({ silent: true });
      return;
    }
    await refresh({ silent: true });
  };
  if (syncTimer !== null) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    void tick();
  }, intervalMs);
  return () => {
    if (syncTimer !== null) clearInterval(syncTimer);
    syncTimer = null;
  };
}

/** Manual "sync now" used by the status bar button. */
export async function syncNow() {
  const queued = await refreshQueueDepth();
  const result = queued > 0 ? await flushOutbox() : { delivered: 0, failed: 0, remaining: 0 };
  await refresh({ silent: false });
  return result;
}

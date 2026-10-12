/**
 * Read-aloud via the browser's built-in Web Speech API (`speechSynthesis`).
 *
 * Assessment of the user's proposal: correct choice, with three caveats handled
 * here.
 *   1. Offline — yes, this is the browser's own engine (SAPI on Windows, etc.),
 *      not a cloud service, so it keeps working with no network. That is exactly
 *      why it beats a cloud TTS for this app.
 *   2. Voices load asynchronously. `getVoices()` returns an empty list on first
 *      call in Chromium until `voiceschanged` fires, so we wait for it (bounded)
 *      and default to `en-US` as requested.
 *   3. Chromium silently truncates long utterances (roughly >200 characters), so
 *      "read the whole article" must be a SEQUENCE of short utterances, never one
 *      long one. `speakSequence` exists for that and also gives us per-sentence
 *      highlighting.
 *
 * Rate defaults to 0.9 as the user specified — a learner wants it slightly slower
 * than conversational speed.
 */

/**
 * The two speech defaults, exported by name as well as through `tts` so views can
 * import the constant they actually need instead of reaching into the object.
 */
export const DEFAULT_LANG = "en-US";
export const DEFAULT_RATE = 0.9;

/** Longest chunk we hand to a single utterance. */
const MAX_UTTERANCE_CHARS = 180;

/** @type {SpeechSynthesisVoice[]} */
let cachedVoices = [];
let voicesReadyPromise = null;

export function isSupported() {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance === "function";
}

/** Resolve once voices are available, or after `timeoutMs` regardless. */
export function voicesReady(timeoutMs = 1500) {
  if (!isSupported()) return Promise.resolve([]);
  if (cachedVoices.length > 0) return Promise.resolve(cachedVoices);
  if (voicesReadyPromise !== null) return voicesReadyPromise;

  voicesReadyPromise = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      cachedVoices = window.speechSynthesis.getVoices() ?? [];
      resolve(cachedVoices);
    };
    const initial = window.speechSynthesis.getVoices() ?? [];
    if (initial.length > 0) {
      cachedVoices = initial;
      settled = true;
      resolve(cachedVoices);
      return;
    }
    window.speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
    setTimeout(finish, timeoutMs);
  });
  return voicesReadyPromise;
}

/** Best available voice for a language tag: exact match, then same primary subtag. */
export function pickVoice(lang = DEFAULT_LANG) {
  if (cachedVoices.length === 0) return null;
  const wanted = lang.toLowerCase();
  const primary = wanted.split("-")[0];
  return (
    cachedVoices.find((voice) => voice.lang?.toLowerCase() === wanted) ??
    cachedVoices.find((voice) => voice.lang?.toLowerCase().startsWith(`${primary}-`)) ??
    cachedVoices.find((voice) => voice.lang?.toLowerCase().startsWith(primary)) ??
    null
  );
}

/** Split text into utterance-sized chunks at sentence, then clause, then word. */
export function chunkText(text, max = MAX_UTTERANCE_CHARS) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length === 0) return [];
  if (clean.length <= max) return [clean];
  const sentences = clean.match(/[^.!?…]+[.!?…]*\s*/g) ?? [clean];
  const chunks = [];
  let buffer = "";
  const flush = () => {
    if (buffer.trim().length > 0) chunks.push(buffer.trim());
    buffer = "";
  };
  for (const sentence of sentences) {
    if (sentence.length > max) {
      flush();
      // A single long sentence: break on commas, then hard-split.
      const parts = sentence.split(/(?<=[,;:])\s+/);
      for (const part of parts) {
        if (part.length > max) {
          for (let index = 0; index < part.length; index += max) chunks.push(part.slice(index, index + max).trim());
        } else if ((buffer + part).length > max) {
          flush();
          buffer = part;
        } else {
          buffer += part;
        }
      }
      continue;
    }
    if ((buffer + sentence).length > max) flush();
    buffer += sentence;
  }
  flush();
  return chunks.filter((chunk) => chunk.length > 0);
}

/** @type {Set<(state: object) => void>} */
const listeners = new Set();

export const ttsState = {
  supported: isSupported(),
  speaking: false,
  /** Index within the current sequence, or -1 when idle. */
  index: -1,
  total: 0,
  /** The text currently being spoken. */
  current: "",
  voice: null,
};

function emit() {
  for (const listener of listeners) {
    try {
      listener(ttsState);
    } catch (error) {
      console.error("[english-study] tts listener failed:", error);
    }
  }
}

export function onTtsChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let sequenceToken = 0;

export function cancel() {
  if (!isSupported()) return;
  sequenceToken += 1;
  window.speechSynthesis.cancel();
  Object.assign(ttsState, { speaking: false, index: -1, total: 0, current: "" });
  emit();
}

/**
 * Speak one piece of text.
 * @param {string} text
 * @param {{ lang?: string, rate?: number, pitch?: number, onEnd?: () => void, onError?: (error: unknown) => void }} [options]
 */
export async function speak(text, options = {}) {
  const chunks = chunkText(text);
  if (chunks.length === 0) return;
  await speakSequence(chunks, {
    ...options,
    onItem: undefined,
    onEnd: () => {
      Object.assign(ttsState, { speaking: false, index: -1, total: 0, current: "" });
      emit();
      if (typeof options.onEnd === "function") options.onEnd();
    },
  });
}

/**
 * Speak an ordered list of chunks, reporting progress so the UI can highlight the
 * sentence being read. Cancelling (or starting another sequence) stops this one.
 *
 * @param {string[]} items
 * @param {{ lang?: string, rate?: number, onItem?: (index: number, text: string) => void, onEnd?: () => void, onError?: (error: unknown) => void }} [options]
 */
export async function speakSequence(items, options = {}) {
  if (!isSupported()) {
    if (typeof options.onError === "function") options.onError(new Error("当前浏览器不支持语音合成"));
    return;
  }
  const list = items.map((item) => String(item ?? "")).filter((item) => item.trim().length > 0);
  if (list.length === 0) return;

  await voicesReady();
  cancel();
  const token = ++sequenceToken;
  const voice = pickVoice(options.lang ?? DEFAULT_LANG);
  const rate = options.rate ?? DEFAULT_RATE;

  Object.assign(ttsState, {
    speaking: true,
    index: 0,
    total: list.length,
    current: list[0],
    voice: voice?.name ?? null,
  });
  emit();

  for (let index = 0; index < list.length; index += 1) {
    if (token !== sequenceToken) return; // superseded or cancelled
    const text = list[index];
    Object.assign(ttsState, { index, current: text });
    emit();
    if (typeof options.onItem === "function") options.onItem(index, text);

    const finished = await speakOne(text, { voice, rate, pitch: options.pitch, token });
    if (!finished) return;
  }

  if (token === sequenceToken) {
    Object.assign(ttsState, { speaking: false, index: -1, total: 0, current: "" });
    emit();
    if (typeof options.onEnd === "function") options.onEnd();
  }
}

/** Speak a single short chunk; resolves true when it ended naturally. */
function speakOne(text, { voice, rate, pitch, token }) {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = voice?.lang ?? DEFAULT_LANG;
    utterance.rate = rate;
    if (typeof pitch === "number") utterance.pitch = pitch;
    if (voice !== null && voice !== undefined) utterance.voice = voice;
    // Safety net: some engines never fire onend for an aborted utterance.
    const guard = setTimeout(() => resolve(token === sequenceToken), Math.max(4000, text.length * 260));
    const settle = (value) => {
      clearTimeout(guard);
      resolve(value);
    };
    utterance.onend = () => settle(token === sequenceToken);
    utterance.onerror = () => settle(false);
    try {
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      console.error("[english-study] speechSynthesis.speak failed:", error);
      settle(false);
    }
  });
}

/**
 * Speak a whole article: each entry is a sentence; the callback lets the view
 * highlight the active row.
 */
export function speakArticle(sentences, options = {}) {
  return speakSequence(sentences, options);
}

export const tts = {
  isSupported,
  voicesReady,
  pickVoice,
  chunkText,
  speak,
  speakSequence,
  speakArticle,
  cancel,
  onTtsChange,
  state: ttsState,
  DEFAULT_LANG,
  DEFAULT_RATE,
};

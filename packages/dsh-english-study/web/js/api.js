/**
 * HTTP client for the 英语学习小助手 host API — the reliability core.
 *
 * Implements every clause of the request-reliability requirement:
 *   - a hard per-request timeout (30 s default) that force-ends loading;
 *   - exponential-backoff retry at 1 s / 2 s / 4 s, at most 3 retries, and only
 *     for failures that can actually succeed on a retry (timeout, network, 429, 5xx);
 *   - a stable idempotency key reused across every retry of the same logical
 *     operation, so a retried "add word" can never create a duplicate;
 *   - offline detection that queues mutations instead of losing them, and
 *     automatic replay in order once connectivity returns;
 *   - observable request state so the UI can bind precisely to it (no spinner
 *     that outlives its request).
 */

import { outboxAll, outboxDelete, outboxPut } from "./db.js";

export const ROUTE_BASE = "/english-study";
export const API_BASE = `${ROUTE_BASE}/api`;

/** Default API timeout. The reliability spec pins this at 30 seconds. */
export const TIMEOUT_MS = 30_000;
/** LLM calls get their own, independent, longer budget. */
export const LLM_TIMEOUT_MS = 120_000;
/** Exponential backoff: 1s, 2s, 4s, and no more than 3 retries. */
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, retryable?: boolean, detail?: unknown, attempts?: number }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.code = options.code ?? "unknown";
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail ?? null;
    this.attempts = options.attempts ?? 1;
  }
}

/* ------------------------------------------------------------- request state */

/** @type {Set<(state: object) => void>} */
const listeners = new Set();

export const connection = {
  online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
  /** Requests currently in flight. */
  inFlight: 0,
  /** Mutations waiting in the outbox. */
  queued: 0,
  /** Set while the outbox is being replayed. */
  syncing: false,
  lastSuccessAt: null,
  lastSyncAt: null,
  /** @type {{ message: string, code: string, at: number } | null} */
  lastError: null,
};

export function onConnectionChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) {
    try {
      listener(connection);
    } catch (error) {
      console.error("[english-study] connection listener failed:", error);
    }
  }
}

function patch(changes) {
  Object.assign(connection, changes);
  emit();
}

/** Refresh the queued count from the outbox. */
export async function refreshQueueDepth() {
  try {
    const rows = await outboxAll();
    patch({ queued: rows.length });
    return rows.length;
  } catch {
    return connection.queued;
  }
}

export function isOnline() {
  return connection.online;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A stable, unique id for one logical operation. */
export function newRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** True when a failure is caused by connectivity rather than by the request. */
function isConnectivityError(error) {
  return (
    error instanceof ApiError &&
    (error.code === "network" || error.code === "timeout" || error.status === 0 || error.status >= 500)
  );
}

/**
 * Perform exactly one HTTP attempt under a timeout.
 * @returns {Promise<object>} the decoded JSON body
 */
async function attemptOnce({ path, method, body, timeoutMs, requestId, externalSignal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("client-timeout")), timeoutMs);
  const abortFromOutside = () => controller.abort(new Error("aborted"));
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) abortFromOutside();
    else externalSignal.addEventListener("abort", abortFromOutside, { once: true });
  }

  const headers = {};
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(requestId === undefined ? body : { ...body, requestId });
  }
  // Also sent as a header so the host can dedupe even if the body was truncated.
  if (requestId !== undefined) headers["idempotency-key"] = requestId;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: payload,
      signal: controller.signal,
      credentials: "same-origin",
    });
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason?.message;
      const timedOut = reason !== "aborted";
      throw new ApiError(timedOut ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）` : "请求已取消", {
        code: timedOut ? "timeout" : "aborted",
        retryable: timedOut,
        detail: String(error),
      });
    }
    throw new ApiError("网络连接失败，请检查网络后重试", {
      code: "network",
      retryable: true,
      detail: String(error),
    });
  } finally {
    clearTimeout(timer);
    if (externalSignal !== undefined) externalSignal.removeEventListener("abort", abortFromOutside);
  }

  const raw = await response.text();
  let parsed = null;
  if (raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ApiError("服务端返回了无法解析的内容", {
        code: "bad-response",
        status: response.status,
        retryable: response.status >= 500,
        detail: raw.slice(0, 500),
      });
    }
  }

  if (!response.ok) {
    const message = parsed?.error?.message ?? `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, {
      code: parsed?.error?.code ?? `http-${response.status}`,
      status: response.status,
      retryable: isRetryableStatus(response.status),
      detail: parsed?.error?.detail ?? null,
    });
  }
  return parsed ?? { ok: true };
}

/**
 * Queue a mutation for later delivery.
 * The idempotency key is preserved, so replaying it is safe.
 */
async function enqueue({ path, method, body, requestId }) {
  const entry = {
    id: requestId ?? newRequestId(),
    path,
    method,
    body: body ?? {},
    requestId: requestId ?? newRequestId(),
    createdAt: Date.now(),
    attempts: 0,
  };
  await outboxPut(entry);
  await refreshQueueDepth();
  return entry;
}

/**
 * Issue a request with retry, timeout and offline queueing.
 *
 * @param {string} path API path below the base, e.g. `/state`
 * @param {{
 *   method?: string, body?: object, timeoutMs?: number, retries?: number,
 *   requestId?: string, queue?: boolean, signal?: AbortSignal
 * }} [options]
 * @returns {Promise<object>} decoded JSON; for a queued mutation, `{ queued: true }`
 */
export async function request(path, options = {}) {
  const method = (options.method ?? "GET").toUpperCase();
  const mutating = method !== "GET";
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const maxRetries = options.retries ?? RETRY_DELAYS_MS.length;
  // One id for the whole logical operation, reused by every retry and by any
  // outbox replay, which is what makes retrying a mutation safe.
  const requestId = options.requestId ?? (mutating ? newRequestId() : undefined);
  const shouldQueue = options.queue ?? mutating;

  if (!connection.online && shouldQueue) {
    const entry = await enqueue({ path, method, body: options.body, requestId });
    return { ok: true, queued: true, offline: true, requestId: entry.requestId };
  }

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    patch({ inFlight: connection.inFlight + 1 });
    try {
      const result = await attemptOnce({
        path,
        method,
        body: options.body,
        timeoutMs,
        requestId,
        externalSignal: options.signal,
      });
      patch({
        inFlight: Math.max(0, connection.inFlight - 1),
        lastSuccessAt: Date.now(),
        lastError: null,
      });
      return result;
    } catch (error) {
      patch({ inFlight: Math.max(0, connection.inFlight - 1) });
      lastError = error instanceof ApiError ? error : new ApiError(String(error?.message ?? error));
      lastError.attempts = attempt + 1;
      const canRetry = lastError.retryable && attempt < maxRetries && !options.signal?.aborted;
      if (!canRetry) break;
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      console.warn(`[english-study] ${method} ${path} 第 ${attempt + 1} 次失败，${delay}ms 后重试：${lastError.message}`);
      await sleep(delay);
    }
  }

  patch({
    lastError: { message: lastError?.message ?? "未知错误", code: lastError?.code ?? "unknown", at: Date.now() },
  });

  // A mutation that failed for connectivity reasons is parked, never dropped.
  if (shouldQueue && isConnectivityError(lastError)) {
    const entry = await enqueue({ path, method, body: options.body, requestId });
    return {
      ok: true,
      queued: true,
      offline: !connection.online,
      requestId: entry.requestId,
      warning: lastError.message,
    };
  }
  throw lastError;
}

/**
 * Replay every queued mutation, oldest first.
 * Stops at the first failure so operations keep their original order — replaying
 * a later edit before an earlier one could resurrect stale data.
 * @returns {Promise<{ delivered: number, failed: number, remaining: number }>}
 */
export async function flushOutbox() {
  if (connection.syncing) return { delivered: 0, failed: 0, remaining: connection.queued };
  const rows = await outboxAll();
  if (rows.length === 0) {
    patch({ queued: 0, lastSyncAt: Date.now() });
    return { delivered: 0, failed: 0, remaining: 0 };
  }
  patch({ syncing: true });
  let delivered = 0;
  let failed = 0;
  try {
    for (const row of rows) {
      if (!connection.online) break;
      try {
        await attemptOnce({
          path: row.path,
          method: row.method,
          body: row.body,
          timeoutMs: TIMEOUT_MS,
          requestId: row.requestId,
        });
        await outboxDelete(row.id);
        delivered += 1;
      } catch (error) {
        failed += 1;
        if (isConnectivityError(error)) break; // still offline: keep the rest queued
        // A permanently rejected mutation (e.g. 400) would block the queue forever,
        // so it is dropped after being reported.
        console.error(`[english-study] 丢弃无法投递的请求 ${row.method} ${row.path}:`, error?.message);
        await outboxDelete(row.id);
      }
    }
  } finally {
    patch({ syncing: false, lastSyncAt: Date.now() });
    await refreshQueueDepth();
  }
  return { delivered, failed, remaining: connection.queued };
}

/**
 * Start watching connectivity. Returns a disposer.
 * @param {{ onRecovered?: (result: object) => void }} [hooks]
 */
export function startConnectivityWatch(hooks = {}) {
  const goOnline = () => {
    patch({ online: true });
    void flushOutbox().then((result) => {
      if (result.delivered > 0 && typeof hooks.onRecovered === "function") hooks.onRecovered(result);
    });
  };
  const goOffline = () => patch({ online: false });

  if (typeof window !== "undefined") {
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
  }
  patch({ online: typeof navigator === "undefined" ? true : navigator.onLine !== false });
  void refreshQueueDepth();

  return () => {
    if (typeof window !== "undefined") {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    }
  };
}

/* ---------------------------------------------------------------- endpoints */

export const api = {
  health: () => request("/health"),

  fetchState: () => request("/state"),

  saveSettings: (settings, options = {}) =>
    request("/settings", { method: "POST", body: { settings }, ...options }),

  uploadImage: (base64, mimeType = "image/jpeg") =>
    request("/images", { method: "POST", body: { base64, mimeType } }),

  /**
   * Diary step: read an ALREADY-TRANSLATED handwritten page, extract its English
   * and the words the learner circled, then file everything into the vocabulary
   * bank in one call. No correction happens here on purpose — the page was
   * translated before it was copied out.
   *
   * `seq` is the page number inside that date (page 1 is the day's first sheet).
   * The host refuses page N>1 unless page N-1 already exists, so a stray click on
   * 下一篇 can never create a page on its own.
   */
  importDiary: ({ images, date, seq, id, title, timeoutMs = LLM_TIMEOUT_MS, requestId }) =>
    request("/diary/import", {
      method: "POST",
      body: { images, date, seq, id, title },
      timeoutMs,
      requestId,
      // The mutation is idempotent on the host, but the provider call behind it is
      // metered, so a failure is surfaced for a deliberate retry.
      queue: false,
      retries: 2,
    }),

  /**
   * Read a page image and return the extracted text, the circled words and their
   * fixed phrases, saving nothing. Image-only by design: a pasted text belongs to
   * 其它文本处理区, and /llm/study answers 400 without an image.
   */
  study: ({ images, timeoutMs = LLM_TIMEOUT_MS, requestId }) =>
    request("/llm/study", {
      method: "POST",
      body: { images },
      timeoutMs,
      requestId,
      queue: false,
      retries: 2,
    }),

  /**
   * Text-area step. Whatever goes in — Chinese, English or mixed — pronounceable
   * ENGLISH comes out, together with the corrections and sentence pairs.
   */
  normalize: ({ text, images, timeoutMs = LLM_TIMEOUT_MS, requestId }) =>
    request("/llm/normalize", {
      method: "POST",
      body: { text, images },
      timeoutMs,
      requestId,
      queue: false,
      retries: 2,
    }),

  /** Per-word enrichment: lemma, IPA, gloss, inflections, examples. */
  lexeme: ({ word, sentence, timeoutMs = LLM_TIMEOUT_MS }) =>
    request("/llm/lexeme", {
      method: "POST",
      body: { word, sentence },
      timeoutMs,
      queue: false,
      retries: 2,
    }),

  annotate: (payload, options = {}) =>
    request("/vocab/annotate", { method: "POST", body: payload, ...options }),

  updateWord: (id, patch, options = {}) =>
    request("/vocab/update", { method: "POST", body: { id, patch }, ...options }),

  deleteWord: (id, options = {}) =>
    request("/vocab/delete", { method: "POST", body: { id }, ...options }),

  saveDiary: (entry, options = {}) =>
    request("/diary", { method: "POST", body: entry, ...options }),

  deleteDiary: (id, options = {}) =>
    request("/diary/delete", { method: "POST", body: { id }, ...options }),
};

/** Direct download URL for an export (the browser handles the save dialog). */
export function exportUrl(format) {
  return `${API_BASE}/vocab/export?format=${encodeURIComponent(format)}`;
}

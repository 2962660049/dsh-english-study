/**
 * Durable JSON store for the 英语学习小助手 plugin.
 *
 * Design notes
 * ------------
 * - We deliberately do NOT depend on the `dsh-storage` composition (hub + backend +
 *   domain form). That group is only mounted when the profile declares all three
 *   rows, and a plugin that assumes it would fail `form-not-mounted` on profiles
 *   that omit it. Instead the host half owns plain JSON files under a configurable
 *   data root, which is fully under our control and survives DSH restarts.
 * - Writes are atomic (temp file + rename) so a crash mid-write can never leave a
 *   truncated store. Writes are serialized through a promise chain so concurrent
 *   requests cannot interleave.
 * - Reads are served from an in-memory snapshot; the file is loaded once lazily.
 * - The store keeps an idempotency ledger: every mutating request carries a
 *   client-generated `requestId`, and replaying the same id returns the recorded
 *   result instead of applying the mutation twice. This is the server half of the
 *   double-submit guard required by the reliability spec.
 */

import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = 1;
const LEDGER_LIMIT = 500;

/** @returns {object} a fresh, empty store document. */
function emptyDocument() {
  return {
    version: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    /** Diary entries, newest first is NOT assumed — callers sort. */
    diary: [],
    /** Vocabulary: append-only annotation events (duplicates preserved). */
    vocabEvents: [],
    /** Derived per-lemma records (merged view). */
    vocabWords: [],
    /** Non-secret plugin settings the user edits in the UI. */
    settings: {},
    /** requestId -> { at, result } replay ledger for idempotent mutations. */
    ledger: {},
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shallow-merge persisted data onto a fresh document so new fields appear on upgrade. */
function migrate(raw) {
  const base = emptyDocument();
  if (!isPlainObject(raw)) return base;
  const merged = { ...base, ...raw };
  for (const key of ["diary", "vocabEvents", "vocabWords"]) {
    if (!Array.isArray(merged[key])) merged[key] = [];
  }
  if (!isPlainObject(merged.settings)) merged.settings = {};
  if (!isPlainObject(merged.ledger)) merged.ledger = {};
  merged.version = SCHEMA_VERSION;
  return merged;
}

export class JsonStore {
  /**
   * @param {string} filePath absolute path of the JSON document.
   * @param {{ onError?: (error: unknown) => void }} [options]
   */
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.onError = options.onError ?? (() => {});
    /** @type {object | null} */
    this.data = null;
    this.loadPromise = null;
    this.writeChain = Promise.resolve();
    this.dirty = false;
  }

  /** Read the document from disk once; concurrent callers share one promise. */
  async load() {
    if (this.data !== null) return this.data;
    if (this.loadPromise !== null) return this.loadPromise;
    this.loadPromise = (async () => {
      try {
        const text = await readFile(this.filePath, "utf8");
        this.data = migrate(JSON.parse(text));
      } catch (error) {
        if (error && error.code === "ENOENT") {
          await mkdir(dirname(this.filePath), { recursive: true });
          this.data = emptyDocument();
          await this.#flushNow();
        } else if (error instanceof SyntaxError) {
          // A corrupt store must not be silently discarded: keep a .corrupt copy
          // so the user's data is recoverable, then start clean.
          const backup = `${this.filePath}.corrupt-${Date.now()}`;
          try {
            await rename(this.filePath, backup);
            this.onError(new Error(`english-study: store was corrupt, moved to ${backup}`));
          } catch (renameError) {
            this.onError(renameError);
          }
          this.data = emptyDocument();
          await this.#flushNow();
        } else {
          this.onError(error);
          throw error;
        }
      }
      return this.data;
    })();
    try {
      return await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  /** Snapshot of the whole document (a deep copy — callers may not mutate internals). */
  async snapshot() {
    const data = await this.load();
    return clone(data);
  }

  /**
   * Apply a mutation under the write lock.
   * @template T
   * @param {(data: object) => T | Promise<T>} mutator
   * @returns {Promise<T>}
   */
  async mutate(mutator) {
    const data = await this.load();
    const result = await mutator(data);
    data.updatedAt = new Date().toISOString();
    await this.#scheduleFlush();
    return result;
  }

  /**
   * Idempotent mutation: if `requestId` was already applied, return the recorded
   * result and skip the mutation entirely.
   * @template T
   * @param {string | undefined} requestId
   * @param {(data: object) => T | Promise<T>} mutator
   * @returns {Promise<{ replayed: boolean, result: T }>}
   */
  async mutateIdempotent(requestId, mutator) {
    return this.mutate(async (data) => {
      if (typeof requestId === "string" && requestId.length > 0 && requestId.length <= 128) {
        const prior = data.ledger[requestId];
        if (prior !== undefined) {
          return { replayed: true, result: clone(prior.result) };
        }
      }
      const result = await mutator(data);
      if (typeof requestId === "string" && requestId.length > 0 && requestId.length <= 128) {
        data.ledger[requestId] = { at: new Date().toISOString(), result: clone(result) };
        const keys = Object.keys(data.ledger);
        if (keys.length > LEDGER_LIMIT) {
          keys
            .sort((a, b) => String(data.ledger[a].at).localeCompare(String(data.ledger[b].at)))
            .slice(0, keys.length - LEDGER_LIMIT)
            .forEach((key) => {
              delete data.ledger[key];
            });
        }
      }
      return { replayed: false, result };
    });
  }

  /** Serialize a flush behind every earlier flush. */
  #scheduleFlush() {
    this.dirty = true;
    this.writeChain = this.writeChain.then(
      () => this.#flushNow(),
      () => this.#flushNow(),
    );
    return this.writeChain;
  }

  /** Atomic write: temp file in the same directory, then rename over the target. */
  async #flushNow() {
    if (this.data === null) return;
    const payload = `${JSON.stringify(this.data, null, 2)}\n`;
    const temp = join(dirname(this.filePath), `.store-${process.pid}-${Date.now()}.tmp`);
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temp, payload, "utf8");
      await rename(temp, this.filePath);
      this.dirty = false;
    } catch (error) {
      try {
        await unlink(temp);
      } catch {
        /* the temp file may not exist; nothing to clean */
      }
      this.onError(error);
      throw error;
    }
  }

  /** Await any queued writes (used by tests and graceful shutdown). */
  async flush() {
    await this.writeChain;
    if (this.dirty) await this.#flushNow();
  }
}

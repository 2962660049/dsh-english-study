/**
 * IndexedDB cache and outbox.
 *
 * Two jobs, per the reliability spec:
 *   - `kv`     — the last known good application state, so the page renders
 *                instantly and still shows content when the network is down.
 *   - `outbox` — mutations that could not be delivered (offline, or retries
 *                exhausted). They are replayed automatically on recovery.
 *
 * IndexedDB can be unavailable (private browsing, storage denied). Every function
 * therefore degrades to an in-memory map instead of throwing, so the app keeps
 * working for the session.
 */

const DB_NAME = "english-study";
const DB_VERSION = 1;
const STORE_KV = "kv";
const STORE_OUTBOX = "outbox";

/** @type {IDBDatabase | null} */
let dbPromise = null;
const memoryKv = new Map();
const memoryOutbox = new Map();
let useMemory = false;

function openDatabase() {
  if (dbPromise !== null) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let request;
    try {
      if (typeof indexedDB === "undefined" || indexedDB === null) {
        resolve(null);
        return;
      }
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) db.createObjectStore(STORE_OUTBOX, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

async function withStore(name, mode, run) {
  if (useMemory) return null;
  const db = await openDatabase();
  if (db === null) {
    useMemory = true;
    return null;
  }
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(name, mode);
    } catch (error) {
      reject(error);
      return;
    }
    const store = transaction.objectStore(name);
    let result;
    try {
      result = run(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result?.result ?? result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/* ------------------------------------------------------------------- key/value */

export async function kvGet(key) {
  try {
    const value = await withStore(STORE_KV, "readonly", (store) => store.get(key));
    if (value !== null && value !== undefined) return value;
  } catch {
    /* fall through to memory */
  }
  return memoryKv.get(key) ?? null;
}

export async function kvPut(key, value) {
  memoryKv.set(key, value);
  try {
    await withStore(STORE_KV, "readwrite", (store) => store.put(value, key));
  } catch {
    /* memory copy still holds the value for this session */
  }
}

export async function kvDelete(key) {
  memoryKv.delete(key);
  try {
    await withStore(STORE_KV, "readwrite", (store) => store.delete(key));
  } catch {
    /* nothing else to do */
  }
}

/* --------------------------------------------------------------------- outbox */

/** @returns {Promise<object[]>} queued mutations, oldest first. */
export async function outboxAll() {
  try {
    const rows = await withStore(STORE_OUTBOX, "readonly", (store) => store.getAll());
    if (Array.isArray(rows)) {
      for (const row of rows) memoryOutbox.set(row.id, row);
      return [...memoryOutbox.values()].sort((a, b) => a.createdAt - b.createdAt);
    }
  } catch {
    /* fall through */
  }
  return [...memoryOutbox.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export async function outboxPut(entry) {
  memoryOutbox.set(entry.id, entry);
  try {
    await withStore(STORE_OUTBOX, "readwrite", (store) => store.put(entry));
  } catch {
    /* memory copy is enough for the session */
  }
}

export async function outboxDelete(id) {
  memoryOutbox.delete(id);
  try {
    await withStore(STORE_OUTBOX, "readwrite", (store) => store.delete(id));
  } catch {
    /* nothing else to do */
  }
}

export async function outboxCount() {
  return (await outboxAll()).length;
}

export async function outboxClear() {
  memoryOutbox.clear();
  try {
    await withStore(STORE_OUTBOX, "readwrite", (store) => store.clear());
  } catch {
    /* nothing else to do */
  }
}

/** True when IndexedDB is genuinely in use (shown in the diagnostics panel). */
export async function storageMode() {
  const db = await openDatabase();
  if (db === null) return "memory";
  return useMemory ? "memory" : "indexeddb";
}

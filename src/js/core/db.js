/**
 * Thin promise wrapper around IndexedDB.
 *
 * Database layout (v2, backwards compatible with the v1 store of the same name):
 *   sessions: { keyPath: "id" }
 *   logs:     { keyPath: "id" }, indexes: sessionId, ts, protocol, fingerprint
 */

import { DB_NAME, DB_VERSION, STORE_LOGS, STORE_SESSIONS } from "./constants.js";

/** @type {Promise<IDBDatabase>|null} */
let databasePromise = null;

/**
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase() {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
      }
      let logs;
      if (!db.objectStoreNames.contains(STORE_LOGS)) {
        logs = db.createObjectStore(STORE_LOGS, { keyPath: "id" });
      } else {
        logs = request.transaction.objectStore(STORE_LOGS);
      }
      for (const [name, keyPath] of [
        ["sessionId", "sessionId"],
        ["ts", "ts"],
        ["protocol", "protocol"],
        ["fingerprint", "fingerprint"]
      ]) {
        if (!logs.indexNames.contains(name)) {
          logs.createIndex(name, keyPath, { unique: false });
        }
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
  });

  return databasePromise;
}

/** Drop the cached connection (used by tests and by the "reset" action). */
export function closeDatabase() {
  if (!databasePromise) return Promise.resolve();
  const pending = databasePromise;
  databasePromise = null;
  return pending.then((db) => db.close()).catch(() => {});
}

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
export function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * @param {IDBTransaction} transaction
 * @returns {Promise<void>}
 */
export function promisifyTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Transaction aborted"));
  });
}

/**
 * Run `work` inside a transaction and wait for it to commit.
 * @template T
 * @param {string[]} storeNames
 * @param {IDBTransactionMode} mode
 * @param {(stores: Record<string, IDBObjectStore>, tx: IDBTransaction) => Promise<T>|T} work
 * @returns {Promise<T>}
 */
export async function runTransaction(storeNames, mode, work) {
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  const db = await openDatabase();
  const transaction = db.transaction(names, mode);
  const stores = Object.fromEntries(names.map((name) => [name, transaction.objectStore(name)]));
  let result;
  try {
    result = await work(stores, transaction);
    await promisifyTransaction(transaction);
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      /* already finished */
    }
    throw error;
  }
  return result;
}

/**
 * Convenience wrapper for a single store.
 * @template T
 * @param {string} storeName
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore, tx: IDBTransaction) => Promise<T>|T} work
 * @returns {Promise<T>}
 */
export function withStore(storeName, mode, work) {
  return runTransaction([storeName], mode, (stores, tx) => work(stores[storeName], tx));
}

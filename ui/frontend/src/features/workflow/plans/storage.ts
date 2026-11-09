import type { DraftStorage } from "./types";
import { PLAN_LIMITS } from "./model";

const DATABASE = "workgraph-ui-plans-1",
  STORE = "drafts";
/** Recoverable editing only. These records do not replace native request journals. */
export function createDraftStorage(factory: IDBFactory = indexedDB): DraftStorage {
  let disposed = false,
    pending: Promise<IDBDatabase> | null = null,
    opened: IDBDatabase | null = null;
  function database(): Promise<IDBDatabase> {
    if (disposed)
      return Promise.reject(new DOMException("Draft storage is closed.", "InvalidStateError"));
    if (pending !== null) return pending;
    pending = new Promise((resolve, reject) => {
      let abandoned = false;
      const request = factory.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE);
      };
      request.onerror = () => {
        pending = null;
        reject(request.error ?? new DOMException("Could not open draft storage.", "UnknownError"));
      };
      request.onblocked = () => {
        abandoned = true;
        pending = null;
        reject(
          new DOMException(
            "Another open Workgraph window blocks draft storage.",
            "InvalidStateError",
          ),
        );
      };
      request.onsuccess = () => {
        const db = request.result;
        if (disposed || abandoned) {
          db.close();
          reject(new DOMException("Draft storage is closed.", "InvalidStateError"));
          return;
        }
        opened = db;
        db.onversionchange = () => {
          db.close();
          opened = null;
          pending = null;
        };
        resolve(db);
      };
    });
    return pending;
  }
  async function transact<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode),
        request = action(transaction.objectStore(STORE));
      let result: T;
      request.onsuccess = () => {
        result = request.result;
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () =>
        reject(
          transaction.error ??
            request.error ??
            new DOMException("Draft storage failed.", "UnknownError"),
        );
      transaction.onabort = () =>
        reject(
          transaction.error ?? new DOMException("Draft storage transaction aborted.", "AbortError"),
        );
    });
  }
  return {
    async load() {
      const values: unknown[] = await transact("readonly", (store) =>
        store.getAll(undefined, PLAN_LIMITS.drafts + 1),
      );
      if (values.length > PLAN_LIMITS.drafts || values.some((v) => typeof v !== "string"))
        throw new DOMException(
          "Stored draft inventory exceeds its schema or count bound. Export or clear the affected browser data explicitly.",
          "DataError",
        );
      return values.filter((v): v is string => typeof v === "string");
    },
    async put(id, value) {
      // Controller enforces aggregate source limits before allocation/editing.
      if (new TextEncoder().encode(value).byteLength > 64 * 1024 * 1024)
        throw new DOMException(
          "The recoverable draft record exceeds its bound.",
          "QuotaExceededError",
        );
      await transact("readwrite", (store) => store.put(value, id));
    },
    async remove(id) {
      await transact("readwrite", (store) => store.delete(id));
    },
    dispose() {
      disposed = true;
      opened?.close();
      opened = null;
    },
  };
}

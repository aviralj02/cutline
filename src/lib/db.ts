import type { Repo } from "./vcs/repo";
import type { Analysis, MediaInfo } from "./agent/tools";

/**
 * Project metadata in IndexedDB; the media bytes themselves live in OPFS.
 * Together they make the app fully local — reload and your edit, your
 * history and your footage are all still there.
 */
export interface Persisted {
  media: MediaInfo[];
  analysis: Analysis;
  waveforms: Record<string, number[]>;
  repo: Repo;
  savedAt: number;
}

const DB = "cutline";
const STORE = "project";
const KEY = "current";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

export const saveProject = (p: Persisted) => tx<void>("readwrite", (s) => s.put(p, KEY));
export const loadProject = () => tx<Persisted | undefined>("readonly", (s) => s.get(KEY));
export const clearProject = () => tx<void>("readwrite", (s) => s.delete(KEY));

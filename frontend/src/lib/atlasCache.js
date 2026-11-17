// Lightweight, zero-dependency L1 memory + IndexedDB + BroadcastChannel caching layer
const DB_NAME = "atlas_intelligence_cache";
const DB_VERSION = 1;
const STORE_NAME = "catalogues";

const memoryCatalogueCache = new Map();
const viewUiStateCache = new Map();

export function getMemoryCatalogue(key) {
  return memoryCatalogueCache.get(key) || null;
}

export function markCatalogueValidated(key) {
  const existing = memoryCatalogueCache.get(key);
  if (existing) {
    existing.lastValidatedAt = Date.now();
  }
}

export function getViewUiState(key, defaults = {}) {
  const saved = viewUiStateCache.get(key);
  return saved ? { ...defaults, ...saved } : { ...defaults };
}

export function setViewUiState(key, partial) {
  const prev = viewUiStateCache.get(key) || {};
  viewUiStateCache.set(key, { ...prev, ...partial });
}

let dbPromise = null;

function getDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      return resolve(null);
    }
    try {
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        console.warn("[AtlasCache] IndexedDB open error:", req.error);
        resolve(null);
      };
    } catch (err) {
      console.warn("[AtlasCache] IndexedDB initialization error:", err);
      resolve(null);
    }
  });
  return dbPromise;
}

export async function getCachedCatalogue(key) {
  const mem = memoryCatalogueCache.get(key);
  if (mem) return mem;
  try {
    const db = await getDB();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        const res = req.result || null;
        if (res && !memoryCatalogueCache.has(key)) {
          memoryCatalogueCache.set(key, { ...res, lastValidatedAt: 0 });
        }
        resolve(res);
      };
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    console.warn(`[AtlasCache] Failed to read ${key} from IndexedDB:`, err);
    return null;
  }
}

export async function setCachedCatalogue(key, data, etag) {
  const entry = {
    key,
    data,
    etag: etag ?? memoryCatalogueCache.get(key)?.etag ?? null,
    updatedAt: Date.now(),
    lastValidatedAt: Date.now()
  };
  memoryCatalogueCache.set(key, entry);
  try {
    const db = await getDB();
    if (!db) return false;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put({ key, data, etag: entry.etag, updatedAt: entry.updatedAt });
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  } catch (err) {
    console.warn(`[AtlasCache] Failed to write ${key} to IndexedDB:`, err);
    return false;
  }
}

// Multi-tab synchronization
let channel = null;
function getChannel() {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) return null;
  if (!channel) {
    try {
      channel = new BroadcastChannel("atlas_catalogue_sync");
    } catch (_) {
      return null;
    }
  }
  return channel;
}

export function broadcastCatalogueUpdate(platform, etag) {
  try {
    const ch = getChannel();
    if (ch) {
      ch.postMessage({ type: "CATALOGUE_UPDATED", platform, etag, timestamp: Date.now() });
    }
  } catch (_) {}
}

export function onCatalogueUpdate(callback) {
  const ch = getChannel();
  if (!ch) return () => {};
  const handler = (event) => {
    if (event.data && event.data.type === "CATALOGUE_UPDATED") {
      callback(event.data);
    }
  };
  ch.addEventListener("message", handler);
  return () => ch.removeEventListener("message", handler);
}

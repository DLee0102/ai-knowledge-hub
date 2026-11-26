/**
 * Local storage & IndexedDB persistence layer.
 * - localStorage: theme, GitHub settings, favorites, view preferences.
 * - IndexedDB: full HTML content for local-only articles and instant post-upload preview cache.
 */

const LS_KEYS = {
  THEME: "akh_theme",
  GITHUB: "akh_github_config",
  FAVORITES: "akh_favorites",
  VIEW_MODE: "akh_view_mode",
  TAG_MODE: "akh_tag_mode",
  SORT_BY: "akh_sort_by",
  SIDEBAR_COLLAPSED: "akh_sidebar_collapsed",
};

const IDB_NAME = "ai_knowledge_hub_db";
const IDB_VERSION = 1;
const STORE_ARTICLES = "articles";

const memoryFallback = new Map();
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(null);
  }
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_ARTICLES)) {
          db.createObjectStore(STORE_ARTICLES, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeLS(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota or privacy mode errors
  }
}

export const storage = {
  getTheme() {
    return readLS(LS_KEYS.THEME, "system");
  },
  setTheme(theme) {
    writeLS(LS_KEYS.THEME, theme);
  },

  getGitHubConfig() {
    return readLS(LS_KEYS.GITHUB, {
      owner: "",
      repo: "",
      branch: "main",
      articlesDir: "articles",
      token: "",
    });
  },
  setGitHubConfig(cfg) {
    writeLS(LS_KEYS.GITHUB, {
      owner: (cfg.owner || "").trim(),
      repo: (cfg.repo || "").trim(),
      branch: (cfg.branch || "main").trim() || "main",
      articlesDir: (cfg.articlesDir || "articles").trim().replace(/^\/+|\/+$/g, "") || "articles",
      token: (cfg.token || "").trim(),
    });
  },
  clearGitHubToken() {
    const cur = this.getGitHubConfig();
    cur.token = "";
    this.setGitHubConfig(cur);
  },

  getFavorites() {
    const arr = readLS(LS_KEYS.FAVORITES, []);
    return new Set(Array.isArray(arr) ? arr : []);
  },
  setFavorites(favSet) {
    writeLS(LS_KEYS.FAVORITES, Array.from(favSet));
  },

  getViewMode() {
    return readLS(LS_KEYS.VIEW_MODE, "grid");
  },
  setViewMode(mode) {
    writeLS(LS_KEYS.VIEW_MODE, mode);
  },

  getTagMode() {
    return readLS(LS_KEYS.TAG_MODE, "or");
  },
  setTagMode(mode) {
    writeLS(LS_KEYS.TAG_MODE, mode);
  },

  getSortBy() {
    return readLS(LS_KEYS.SORT_BY, "updated");
  },
  setSortBy(sortBy) {
    writeLS(LS_KEYS.SORT_BY, sortBy);
  },

  getSidebarCollapsed() {
    return Boolean(readLS(LS_KEYS.SIDEBAR_COLLAPSED, false));
  },
  setSidebarCollapsed(collapsed) {
    writeLS(LS_KEYS.SIDEBAR_COLLAPSED, Boolean(collapsed));
  },

  /**
   * Save a full HTML article record in IndexedDB.
   * record = { id, path, html, metadata, status: 'local' | 'synced-cache', savedAt, deleted?: boolean }
   */
  async putArticleRecord(record) {
    const item = {
      ...record,
      savedAt: record.savedAt || Date.now(),
    };
    const db = await openDB();
    if (!db) {
      memoryFallback.set(item.id, item);
      return;
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_ARTICLES, "readwrite");
      tx.objectStore(STORE_ARTICLES).put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async getArticleRecord(id) {
    const db = await openDB();
    if (!db) {
      return memoryFallback.get(id) || null;
    }
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_ARTICLES, "readonly");
      const req = tx.objectStore(STORE_ARTICLES).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  },

  async getAllArticleRecords() {
    const db = await openDB();
    if (!db) {
      return Array.from(memoryFallback.values());
    }
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_ARTICLES, "readonly");
      const req = tx.objectStore(STORE_ARTICLES).getAll();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    });
  },

  async deleteArticleRecord(id) {
    const db = await openDB();
    if (!db) {
      memoryFallback.delete(id);
      return;
    }
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_ARTICLES, "readwrite");
      tx.objectStore(STORE_ARTICLES).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  },
};

/**
 * AI Knowledge Hub — Main Application Controller
 */

import { storage } from "./storage.js?v=20261126-3";
import {
  parseHtmlArticle,
  injectMetadataIntoHtml,
  buildIndexPayload,
  sanitizeFilename,
  parseTagsString,
} from "./parser.js?v=20261126-3";
import { searchAndFilterArticles, escapeHtml } from "./search.js?v=20261126-3";
import {
  detectRepoFromContext,
  isConfigured,
  hasRepoInfo,
  testConnection,
  fetchRemoteIndex,
  fetchRemoteRawFile,
  commitAtomicChanges,
  rebuildRemoteIndex,
  encodeRepoPath,
  getGitHubFileUrl,
} from "./github-api.js?v=20261126-3";
import {
  getCategoryColor,
  formatDate,
  formatBytes,
  formatWordCount,
  showToast,
  renderCategorySidebar,
  renderTagCloud,
  renderActiveFilters,
  renderArticlesGrid,
  renderBatchDeleteList,
  renderUploadQueue,
  highlightInIframe,
  scrollIframeToHeading,
} from "./ui.js?v=20261126-3";

// ============================================================================
// Application State
// ============================================================================

const state = {
  siteConfig: {
    siteTitle: "AI Knowledge Hub",
    articlesDir: "articles",
    defaultBranch: "main",
    defaultCategory: "AI 综合",
    categories: [],
    tagDictionary: [],
  },
  githubConfig: storage.getGitHubConfig(),
  remoteIndexMeta: { generatedAt: "" },
  remoteArticles: [],
  localRecords: [], // IndexedDB records ('local' | 'synced-cache')
  articles: [], // Merged view of remote + local/synced-cache

  favorites: storage.getFavorites(),
  viewFilter: "all", // 'all' | 'favorites' | 'local'
  category: "all",
  selectedTags: [],
  tagMode: storage.getTagMode(), // 'or' | 'and'
  tagFilterText: "",
  query: "",
  sortBy: storage.getSortBy(),
  viewMode: storage.getViewMode(),
  sidebarCollapsed: storage.getSidebarCollapsed(),

  activeArticleId: null,
  activeBlobUrl: null,
  previewBlobUrl: null,
  readerMarks: [],
  readerMarkIdx: -1,
  readerInfoOpen: typeof window !== "undefined" ? window.innerWidth > 960 : true,

  uploadQueue: [],
  editingArticleId: null,

  selectionMode: false,
  selectedIds: new Set(),
  lastVisibleIds: [],
};

// ============================================================================
// Initialization
// ============================================================================

async function init() {
  applyTheme(storage.getTheme());
  syncSidebarUI();
  bindEvents();

  await loadSiteConfig();
  ensureGitHubDefaults();
  updateGitHubStatusUI();
  populateCategoryDatalist();

  await loadAllData();
  syncControlsFromState();
  renderAll();
  handleHashRoute();
}

async function loadSiteConfig() {
  try {
    const res = await fetch(`data/config.json?t=${Date.now()}`, { cache: "no-store" });
    if (res.ok) {
      const cfg = await res.json();
      state.siteConfig = { ...state.siteConfig, ...cfg };
      if (state.siteConfig.siteTitle) {
        document.getElementById("siteTitle").textContent = state.siteConfig.siteTitle;
      }
    }
  } catch {
    // Fallback to built-in defaults
  }
}

function ensureGitHubDefaults() {
  const detected = detectRepoFromContext(state.siteConfig);
  const saved = storage.getGitHubConfig();
  const merged = {
    owner: saved.owner || detected.owner || "",
    repo: saved.repo || detected.repo || "",
    branch: saved.branch || detected.branch || "main",
    articlesDir: saved.articlesDir || detected.articlesDir || "articles",
    token: saved.token || "",
  };
  state.githubConfig = merged;
  if (!saved.owner && merged.owner) {
    storage.setGitHubConfig(merged);
  }
}

async function loadAllData({ preferGitHubApi = false } = {}) {
  let indexData = null;

  if (preferGitHubApi && hasRepoInfo(state.githubConfig)) {
    try {
      indexData = await fetchRemoteIndex(state.githubConfig);
    } catch (err) {
      showToast(`GitHub API 拉取失败，已回退静态索引：${err.message}`, "error", 4500);
    }
  }

  if (!indexData) {
    try {
      const res = await fetch(`data/index.json?t=${Date.now()}`, { cache: "no-store" });
      if (res.ok) {
        indexData = await res.json();
      }
    } catch {
      indexData = null;
    }
  }

  state.remoteArticles = Array.isArray(indexData?.articles) ? indexData.articles : [];
  state.remoteIndexMeta = {
    generatedAt: indexData?.generatedAt || "",
  };

  state.localRecords = await storage.getAllArticleRecords();
  await reconcileAndMergeArticles();
}

/**
 * Merges remote index articles with local drafts and post-upload synced-cache records.
 * Automatically cleans up synced-cache entries once the hosted index catches up!
 */
async function reconcileAndMergeArticles() {
  const byPath = new Map();
  for (const art of state.remoteArticles) {
    byPath.set(art.path, { ...art, _source: "remote" });
  }

  const now = Date.now();
  const MAX_SYNC_CACHE_AGE_MS = 24 * 60 * 60 * 1000;
  const keptRecords = [];

  for (const rec of state.localRecords) {
    if (rec.status === "local") {
      keptRecords.push(rec);
      const art = { ...rec.metadata, _source: "local" };
      byPath.set(art.path || `local/${art.id}`, art);
      continue;
    }

    if (rec.status === "synced-cache") {
      const remoteMatch = byPath.get(rec.path);
      const expired = now - (rec.savedAt || 0) > MAX_SYNC_CACHE_AGE_MS;

      if (rec.deleted) {
        if (!remoteMatch || expired) {
          await storage.deleteArticleRecord(rec.id);
        } else {
          // Hide stale entry until GitHub Pages deployment finishes
          byPath.delete(rec.path);
          keptRecords.push(rec);
        }
        continue;
      }

      if (expired || (remoteMatch && remoteMatch.contentHash === rec.metadata?.contentHash)) {
        await storage.deleteArticleRecord(rec.id);
      } else {
        keptRecords.push(rec);
        if (rec.metadata) {
          byPath.set(rec.path, { ...rec.metadata, _source: "synced-cache" });
        }
      }
    }
  }

  state.localRecords = keptRecords;
  state.articles = Array.from(byPath.values());
}

// ============================================================================
// Theme & UI Helpers
// ============================================================================

function applyTheme(pref) {
  let effective = pref;
  if (pref === "system") {
    effective = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", effective);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  storage.setTheme(next);
  applyTheme(next);
}

function updateGitHubStatusUI() {
  const dot = document.getElementById("ghStatusDot");
  const text = document.getElementById("ghStatusText");
  if (isConfigured(state.githubConfig)) {
    dot.classList.add("connected");
    text.textContent = `${state.githubConfig.owner}/${state.githubConfig.repo}`;
  } else if (hasRepoInfo(state.githubConfig)) {
    dot.classList.remove("connected");
    text.textContent = "待配置 Token";
  } else {
    dot.classList.remove("connected");
    text.textContent = "GitHub 配置";
  }
}

function populateCategoryDatalist() {
  const dl = document.getElementById("categoryDatalist");
  if (!dl) return;
  const set = new Set((state.siteConfig.categories || []).map((c) => c.name));
  for (const art of state.articles) {
    if (art.category) set.add(art.category);
  }
  dl.innerHTML = Array.from(set)
    .map((name) => `<option value="${name.replace(/"/g, "&quot;")}"></option>`)
    .join("");
}

function syncControlsFromState() {
  document.getElementById("sortSelect").value = state.sortBy;
  document.getElementById("viewGridBtn").classList.toggle("active", state.viewMode === "grid");
  document.getElementById("viewListBtn").classList.toggle("active", state.viewMode === "list");

  const tagModeBtn = document.getElementById("tagModeBtn");
  tagModeBtn.textContent = state.tagMode.toUpperCase();
  tagModeBtn.classList.toggle("active-and", state.tagMode === "and");
  tagModeBtn.title =
    state.tagMode === "and"
      ? "当前：同时满足所有已选标签 (AND)，点击切换为 OR"
      : "当前：满足任意已选标签 (OR)，点击切换为 AND";
}

// ============================================================================
// Rendering Library View
// ============================================================================

function computeAggregations() {
  const catMap = new Map();
  const tagMap = new Map();
  let totalWords = 0;
  let favCount = 0;
  let localCount = 0;

  for (const a of state.articles) {
    totalWords += Number(a.wordCount) || 0;
    if (state.favorites.has(a.id)) favCount++;
    if (a._source === "local") localCount++;
    catMap.set(a.category, (catMap.get(a.category) || 0) + 1);
    for (const tag of a.tags || []) {
      tagMap.set(tag, (tagMap.get(tag) || 0) + 1);
    }
  }

  const categories = Array.from(catMap.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .map(([name, count]) => ({ name, count }));

  const tags = Array.from(tagMap.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .map(([name, count]) => ({ name, count }));

  return { categories, tags, totalWords, favCount, localCount };
}

function renderAll() {
  const { categories, tags, totalWords, favCount, localCount } = computeAggregations();

  // Sidebar quick view counts
  document.getElementById("countAll").textContent = state.articles.length;
  document.getElementById("countFavorites").textContent = favCount;
  document.getElementById("countLocal").textContent = localCount;
  document.getElementById("navLocalItem").classList.toggle("hidden", localCount === 0);

  document.querySelectorAll("#quickNavList .nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.viewFilter === state.viewFilter);
  });

  // Local draft sync banner
  const banner = document.getElementById("localSyncBanner");
  banner.classList.toggle("hidden", localCount === 0);
  document.getElementById("localDraftCountText").textContent = localCount;

  // Categories & Tags
  renderCategorySidebar(
    document.getElementById("categoryList"),
    categories,
    state.category,
    state.siteConfig
  );
  renderTagCloud(
    document.getElementById("tagCloud"),
    tags,
    state.selectedTags,
    state.tagFilterText
  );
  document.getElementById("clearTagsBtn").classList.toggle("hidden", state.selectedTags.length === 0);

  // Sidebar footer stats
  document.getElementById("statArticles").textContent = `${state.articles.length} 篇知识点`;
  document.getElementById("statWords").textContent = formatWordCount(totalWords);
  document.getElementById("statUpdated").textContent = state.remoteIndexMeta.generatedAt
    ? `索引更新：${formatDate(state.remoteIndexMeta.generatedAt)}`
    : "自动索引已就绪";

  populateCategoryDatalist();

  // Search & filter articles
  const { results } = searchAndFilterArticles(state.articles, {
    query: state.query,
    category: state.category,
    selectedTags: state.selectedTags,
    tagMode: state.tagMode,
    onlyFavorites: state.viewFilter === "favorites",
    onlyLocal: state.viewFilter === "local",
    favorites: state.favorites,
    sortBy: state.sortBy,
  });

  // Prune any selected IDs that no longer exist
  const existingIdSet = new Set(state.articles.map((a) => a.id));
  for (const sid of Array.from(state.selectedIds)) {
    if (!existingIdSet.has(sid)) state.selectedIds.delete(sid);
  }
  state.lastVisibleIds = results.map((r) => r.article.id);
  updateBatchBarUI();

  const summaryEl = document.getElementById("resultSummary");
  if (state.query.trim()) {
    summaryEl.textContent = `全文搜索命中 ${results.length} 篇（共 ${state.articles.length} 篇）`;
  } else {
    summaryEl.textContent = `共显示 ${results.length} 篇知识点`;
  }

  renderActiveFilters(document.getElementById("activeFilters"), state);

  const gridEl = document.getElementById("articlesContainer");
  const emptyEl = document.getElementById("emptyState");

  if (results.length === 0) {
    gridEl.innerHTML = "";
    emptyEl.classList.remove("hidden");
  } else {
    emptyEl.classList.add("hidden");
    renderArticlesGrid(gridEl, results, state);
  }
}

// ============================================================================
// Routing & Reader View
// ============================================================================

function handleHashRoute() {
  const hash = window.location.hash || "#/";
  const match = hash.match(/^#\/article\/(.+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    openArticleReader(id);
  } else {
    closeArticleReader(false);
  }
}

function navigateToArticle(id) {
  window.location.hash = `#/article/${encodeURIComponent(id)}`;
}

function navigateHome() {
  if (window.location.hash && window.location.hash !== "#/") {
    window.location.hash = "#/";
  } else {
    closeArticleReader(false);
  }
}

function revokeActiveBlobUrl() {
  if (state.activeBlobUrl) {
    URL.revokeObjectURL(state.activeBlobUrl);
    state.activeBlobUrl = null;
  }
}

async function resolveArticleHtmlSource(article) {
  const cached = await storage.getArticleRecord(article.id);
  if (cached && cached.html) {
    return { type: "html", html: cached.html };
  }

  const relUrl = encodeRepoPath(article.path);
  try {
    const headRes = await fetch(relUrl, { method: "HEAD", cache: "no-cache" });
    if (headRes.ok) {
      return { type: "url", url: relUrl };
    }
  } catch {
    // Fallback below
  }

  // Fallback: fetch directly from GitHub API while GitHub Pages is still deploying
  if (hasRepoInfo(state.githubConfig)) {
    try {
      const rawHtml = await fetchRemoteRawFile(state.githubConfig, article.path);
      return { type: "html", html: rawHtml };
    } catch {
      // Ignore and try direct URL
    }
  }

  return { type: "url", url: relUrl };
}

async function openArticleReader(id) {
  const article = state.articles.find((a) => a.id === id);
  if (!article) {
    showToast("未找到该知识点，可能已被删除。", "error");
    navigateHome();
    return;
  }

  state.activeArticleId = id;
  state.readerMarks = [];
  state.readerMarkIdx = -1;

  openMobileSidebar(false);
  document.getElementById("libraryView").classList.add("hidden");
  const readerView = document.getElementById("readerView");
  readerView.classList.remove("hidden");
  readerView.classList.remove("fullscreen");
  syncSidebarUI();

  // Header metadata
  const color = getCategoryColor(article.category, state.siteConfig);
  const catEl = document.getElementById("readerCategory");
  catEl.textContent = article.category;
  catEl.style.setProperty("--badge-color", color);
  document.getElementById("readerTitle").textContent = article.title;

  const statusBadge = document.getElementById("readerStatusBadge");
  if (article._source === "local") {
    statusBadge.textContent = "本地暂存";
    statusBadge.className = "source-pill";
  } else if (article._source === "synced-cache") {
    statusBadge.textContent = "已同步 · 实时预览";
    statusBadge.className = "source-pill synced";
  } else {
    statusBadge.className = "source-pill hidden";
  }

  updateReaderFavBtn();

  // Side panel content
  document.getElementById("readerSidePanel").classList.toggle("hidden", !state.readerInfoOpen);
  document.getElementById("readerSummary").textContent = article.summary || "暂无摘要";
  const tagsEl = document.getElementById("readerTags");
  tagsEl.innerHTML = (article.tags || [])
    .map(
      (t) =>
        `<button class="card-tag" data-reader-tag="${escapeHtml(t)}" type="button">#${escapeHtml(t)}</button>`
    )
    .join("") || `<span class="muted-small">无标签</span>`;

  const outlineEl = document.getElementById("readerOutline");
  const headings = article.headings || [];
  outlineEl.innerHTML = headings.length
    ? headings
        .map(
          (h, idx) =>
            `<button class="outline-btn" data-outline-idx="${idx}" type="button">${escapeHtml(h)}</button>`
        )
        .join("")
    : `<span class="muted-small">未检测到章节标题</span>`;

  const ghFileUrl =
    article._source !== "local" && hasRepoInfo(state.githubConfig)
      ? getGitHubFileUrl(state.githubConfig, article.path)
      : "";

  document.getElementById("readerMetaDl").innerHTML = `
    <dt>字数</dt><dd>${formatWordCount(article.wordCount)}</dd>
    <dt>阅读</dt><dd>约 ${article.readingTime || 1} 分钟</dd>
    <dt>体积</dt><dd>${formatBytes(article.sizeBytes)}</dd>
    <dt>更新</dt><dd>${formatDate(article.updatedAt || article.createdAt)}</dd>
    <dt>路径</dt><dd><code>${escapeHtml(article.path)}</code></dd>
    ${ghFileUrl ? `<dt>源码</dt><dd><a href="${escapeHtml(ghFileUrl)}" target="_blank" rel="noopener">在 GitHub 查看</a></dd>` : ""}
  `;

  // Load iframe content
  const loadingEl = document.getElementById("readerLoading");
  const iframe = document.getElementById("readerFrame");
  const externalBtn = document.getElementById("readerExternalBtn");

  loadingEl.classList.remove("hidden");
  revokeActiveBlobUrl();

  const resolved = await resolveArticleHtmlSource(article);
  if (state.activeArticleId !== id) return; // User navigated away

  let srcUrl = "";
  if (resolved.type === "html") {
    const blob = new Blob([resolved.html], { type: "text/html;charset=utf-8" });
    state.activeBlobUrl = URL.createObjectURL(blob);
    srcUrl = state.activeBlobUrl;
  } else {
    srcUrl = resolved.url;
  }

  externalBtn.href = srcUrl;

  const findInput = document.getElementById("readerFindInput");
  const cleanedSearch = state.query
    .replace(/(?:tag|tags|cat|category):(?:"[^"]+"|\S+)/gi, "")
    .trim();
  findInput.value = cleanedSearch;
  document.getElementById("readerFindCount").textContent = "";

  iframe.onload = () => {
    loadingEl.classList.add("hidden");
    if (findInput.value.trim()) {
      runReaderFind(findInput.value.trim(), true);
    }
  };
  iframe.src = srcUrl;
}

function closeArticleReader(updateHash = true) {
  state.activeArticleId = null;
  revokeActiveBlobUrl();
  const iframe = document.getElementById("readerFrame");
  if (iframe) {
    iframe.onload = null;
    iframe.src = "about:blank";
  }
  const readerView = document.getElementById("readerView");
  readerView.classList.add("hidden");
  readerView.classList.remove("fullscreen");
  document.getElementById("libraryView").classList.remove("hidden");
  syncSidebarUI();
  if (updateHash) navigateHome();
}

function updateReaderFavBtn() {
  const btn = document.getElementById("readerFavBtn");
  const isFav = state.activeArticleId && state.favorites.has(state.activeArticleId);
  btn.classList.toggle("active", Boolean(isFav));
}

function runReaderFind(keyword, jumpToFirst = false) {
  const iframe = document.getElementById("readerFrame");
  const countEl = document.getElementById("readerFindCount");
  state.readerMarks = highlightInIframe(iframe, keyword);
  state.readerMarkIdx = -1;

  if (!keyword.trim()) {
    countEl.textContent = "";
    return;
  }
  if (!state.readerMarks.length) {
    countEl.textContent = "0/0";
    return;
  }
  if (jumpToFirst) {
    stepReaderFind(1);
  } else {
    countEl.textContent = `0/${state.readerMarks.length}`;
  }
}

function stepReaderFind(delta) {
  const marks = state.readerMarks;
  const countEl = document.getElementById("readerFindCount");
  if (!marks.length) {
    countEl.textContent = "";
    return;
  }
  if (state.readerMarkIdx >= 0 && marks[state.readerMarkIdx]) {
    marks[state.readerMarkIdx].classList.remove("akh-hl-current");
  }
  state.readerMarkIdx = (state.readerMarkIdx + delta + marks.length) % marks.length;
  const current = marks[state.readerMarkIdx];
  current.classList.add("akh-hl-current");
  current.scrollIntoView({ behavior: "smooth", block: "center" });
  countEl.textContent = `${state.readerMarkIdx + 1}/${marks.length}`;
}

async function getRawHtmlForArticle(article) {
  const cached = await storage.getArticleRecord(article.id);
  if (cached?.html) return cached.html;

  try {
    const res = await fetch(encodeRepoPath(article.path), { cache: "no-store" });
    if (res.ok) return await res.text();
  } catch {
    // Fallback to GitHub API
  }

  if (hasRepoInfo(state.githubConfig)) {
    return await fetchRemoteRawFile(state.githubConfig, article.path);
  }

  throw new Error("无法读取该文章的原始 HTML 内容。");
}

async function downloadCurrentArticle() {
  const article = state.articles.find((a) => a.id === state.activeArticleId);
  if (!article) return;
  try {
    const html = await getRawHtmlForArticle(article);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = article.filename || `${article.id}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    showToast(`下载失败：${err.message}`, "error");
  }
}

// ============================================================================
// Upload, Paste & Batch Publish Flow
// ============================================================================

function openUploadModal() {
  updateUploadFooterStatus();
  openModal("uploadModal");
}

function updateUploadFooterStatus() {
  const note = document.getElementById("uploadTargetNote");
  const ghBtn = document.getElementById("saveGitHubBtn");
  const localBtn = document.getElementById("saveLocalBtn");
  const hasItems = state.uploadQueue.length > 0;

  localBtn.disabled = !hasItems;
  ghBtn.disabled = !hasItems;

  if (isConfigured(state.githubConfig)) {
    note.innerHTML = `目标仓库：<code>${escapeHtml(state.githubConfig.owner)}/${escapeHtml(state.githubConfig.repo)}@${escapeHtml(state.githubConfig.branch)}</code>`;
  } else {
    note.innerHTML = `未配置 GitHub Token（点击右上角 <strong>GitHub 配置</strong> 即可开启云端直传，或先保存到本地浏览器）`;
  }
}

function renderUploadQueueUI() {
  const section = document.getElementById("uploadQueueSection");
  const listEl = document.getElementById("uploadQueueList");
  const countEl = document.getElementById("queueCount");

  countEl.textContent = state.uploadQueue.length;
  section.classList.toggle("hidden", state.uploadQueue.length === 0);

  if (state.uploadQueue.length > 0) {
    renderUploadQueue(listEl, state.uploadQueue, state.siteConfig);
  } else {
    listEl.innerHTML = "";
  }
  updateUploadFooterStatus();
}

async function enqueueHtmlInput(rawHtml, suggestedName) {
  const trimmed = String(rawHtml || "").trim();
  if (!trimmed) {
    showToast("HTML 内容为空，请检查文件或粘贴内容。", "error");
    return;
  }

  const tempName = sanitizeFilename(suggestedName || "", "ai-knowledge");
  const articlesDir = state.githubConfig.articlesDir || state.siteConfig.articlesDir || "articles";
  const parsed = await parseHtmlArticle(trimmed, `${articlesDir}/${tempName}`, state.siteConfig);

  // If no explicit filename was provided (e.g., pasted code), derive a readable filename from extracted title
  let finalFilename = suggestedName
    ? sanitizeFilename(suggestedName, parsed.title)
    : sanitizeFilename(parsed.title, "ai-knowledge");

  // Avoid duplicate filenames inside current queue
  const usedInQueue = new Set(state.uploadQueue.map((q) => q.filename.toLowerCase()));
  if (usedInQueue.has(finalFilename.toLowerCase())) {
    const stem = finalFilename.replace(/\.html?$/i, "");
    let n = 2;
    while (usedInQueue.has(`${stem}-${n}.html`.toLowerCase())) n++;
    finalFilename = `${stem}-${n}.html`;
  }

  state.uploadQueue.push({
    rawHtml: trimmed,
    parsed,
    title: parsed.title,
    filename: finalFilename,
    category: parsed.category,
    tagsText: (parsed.tags || []).join(", "),
    summary: parsed.summary,
  });

  renderUploadQueueUI();
}

async function handleDroppedFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => /\.html?$/i.test(f.name) || f.type === "text/html");
  if (!files.length) {
    showToast("请选择 .html 或 .htm 文件。", "error");
    return;
  }

  for (const file of files) {
    const text = await file.text();
    await enqueueHtmlInput(text, file.name);
  }
  showToast(`已解析 ${files.length} 个 HTML 文件，可核对分类与标签后保存。`, "success");
}

async function prepareQueuePayloads() {
  const injectMeta = document.getElementById("injectMetaCheckbox").checked;
  const articlesDir = (state.githubConfig.articlesDir || state.siteConfig.articlesDir || "articles").replace(/^\/+|\/+$/g, "");
  const prepared = [];

  for (const item of state.uploadQueue) {
    const filename = sanitizeFilename(item.filename, item.title);
    const relPath = `${articlesDir}/${filename}`;
    const tags = parseTagsString(item.tagsText);

    const finalHtml = injectMeta
      ? injectMetadataIntoHtml(item.rawHtml, {
          title: item.title,
          category: item.category,
          tags,
          summary: item.summary,
          createdAt: item.parsed.createdAt,
        })
      : item.rawHtml;

    const finalArticle = await parseHtmlArticle(finalHtml, relPath, state.siteConfig, {
      title: item.title,
      category: item.category,
      tags,
      summary: item.summary,
      createdAt: item.parsed.createdAt,
    });

    prepared.push({
      path: relPath,
      html: finalHtml,
      article: finalArticle,
    });
  }

  return prepared;
}

async function saveQueueToLocal() {
  if (!state.uploadQueue.length) return;
  const btn = document.getElementById("saveLocalBtn");
  btn.disabled = true;
  try {
    const items = await prepareQueuePayloads();
    for (const item of items) {
      await storage.putArticleRecord({
        id: item.article.id,
        path: item.path,
        html: item.html,
        metadata: item.article,
        status: "local",
      });
    }
    state.uploadQueue = [];
    renderUploadQueueUI();
    closeModal("uploadModal");
    state.localRecords = await storage.getAllArticleRecords();
    await reconcileAndMergeArticles();
    renderAll();
    showToast(`已保存 ${items.length} 篇知识点到本地浏览器，可随时搜索预览或一键同步至 GitHub！`, "success", 4200);
  } catch (err) {
    showToast(`本地保存失败：${err.message}`, "error");
  } finally {
    btn.disabled = false;
  }
}

async function saveQueueToGitHub() {
  if (!state.uploadQueue.length) return;
  if (!isConfigured(state.githubConfig)) {
    showToast("请先配置 GitHub 仓库和 Token，即可一键发布到仓库！", "info", 4000);
    closeModal("uploadModal");
    openSettingsModal();
    return;
  }

  const ghBtn = document.getElementById("saveGitHubBtn");
  const localBtn = document.getElementById("saveLocalBtn");
  const origText = ghBtn.textContent;
  ghBtn.disabled = true;
  localBtn.disabled = true;
  ghBtn.textContent = "正在提交至 GitHub…";

  try {
    const items = await prepareQueuePayloads();
    await publishArticlesToGitHub(items, `feat(knowledge): add ${items.length} AI knowledge HTML file(s)`);

    state.uploadQueue = [];
    renderUploadQueueUI();
    closeModal("uploadModal");
    showToast(
      `成功上传 ${items.length} 篇知识点至 GitHub！已开启实时预览，GitHub Pages 将在 30~60 秒内完成自动部署。`,
      "success",
      5200
    );
  } catch (err) {
    showToast(`上传到 GitHub 失败：${err.message}`, "error", 5500);
  } finally {
    ghBtn.textContent = origText;
    ghBtn.disabled = state.uploadQueue.length === 0;
    localBtn.disabled = state.uploadQueue.length === 0;
  }
}

/**
 * Atomic GitHub upload of one or more { path, html, article } entries + updated data/index.json.
 */
async function publishArticlesToGitHub(items, commitMessage) {
  // Fetch latest remote index directly from GitHub API to avoid overwriting other commits
  let remoteIndex = await fetchRemoteIndex(state.githubConfig);
  const mergedMap = new Map();
  for (const art of remoteIndex?.articles || state.remoteArticles) {
    mergedMap.set(art.path, art);
  }

  const upserts = [];
  for (const item of items) {
    mergedMap.set(item.path, item.article);
    upserts.push({ path: item.path, content: item.html });
  }

  const newIndexPayload = buildIndexPayload(Array.from(mergedMap.values()));
  upserts.push({
    path: "data/index.json",
    content: JSON.stringify(newIndexPayload, null, 2) + "\n",
  });

  const commitRes = await commitAtomicChanges(state.githubConfig, {
    upserts,
    message: commitMessage,
  });

  // Update in-memory remote articles and store local instant-preview cache
  state.remoteArticles = newIndexPayload.articles;
  state.remoteIndexMeta.generatedAt = newIndexPayload.generatedAt;

  for (const item of items) {
    await storage.putArticleRecord({
      id: item.article.id,
      path: item.path,
      html: item.html,
      metadata: item.article,
      status: "synced-cache",
      commitSha: commitRes.commitSha,
    });
  }

  state.localRecords = await storage.getAllArticleRecords();
  await reconcileAndMergeArticles();
  renderAll();
  return commitRes;
}

async function syncAllLocalToGitHub() {
  const localDrafts = state.localRecords.filter((r) => r.status === "local");
  if (!localDrafts.length) return;

  if (!isConfigured(state.githubConfig)) {
    showToast("请先配置 GitHub 仓库与 Token 后再同步。", "info", 3800);
    openSettingsModal();
    return;
  }

  const btn = document.getElementById("syncAllLocalBtn");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "正在同步至 GitHub…";

  try {
    const items = localDrafts.map((rec) => ({
      path: rec.path,
      html: rec.html,
      article: rec.metadata,
    }));
    await publishArticlesToGitHub(
      items,
      `feat(knowledge): sync ${items.length} local AI knowledge file(s)`
    );
    if (state.viewFilter === "local") state.viewFilter = "all";
    renderAll();
    showToast(`已将 ${items.length} 篇本地知识点全部同步至 GitHub！`, "success", 4500);
  } catch (err) {
    showToast(`同步失败：${err.message}`, "error", 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// ============================================================================
// Edit & Delete Existing Articles
// ============================================================================

function openEditModal(id) {
  const article = state.articles.find((a) => a.id === id);
  if (!article) return;

  state.editingArticleId = id;
  document.getElementById("editFilePath").textContent = article.path;
  document.getElementById("editTitle").value = article.title || "";
  document.getElementById("editCategory").value = article.category || "";
  document.getElementById("editTags").value = (article.tags || []).join(", ");
  document.getElementById("editSummary").value = article.summary || "";
  document.getElementById("editReplaceFile").value = "";

  const note = document.getElementById("editTargetNote");
  if (article._source === "local") {
    note.textContent = "此文章为本地暂存，修改将保存至浏览器。";
  } else if (isConfigured(state.githubConfig)) {
    note.textContent = `修改将直接提交至 GitHub（${state.githubConfig.owner}/${state.githubConfig.repo}）`;
  } else {
    note.textContent = "未配置 GitHub Token，请先在设置中配置以保存云端修改。";
  }

  openModal("editModal");
}

async function submitEditArticle() {
  const article = state.articles.find((a) => a.id === state.editingArticleId);
  if (!article) return;

  const isLocal = article._source === "local";
  if (!isLocal && !isConfigured(state.githubConfig)) {
    showToast("修改云端文章需要先配置 GitHub Token。", "info", 3800);
    closeModal("editModal");
    openSettingsModal();
    return;
  }

  const title = document.getElementById("editTitle").value.trim();
  const category = document.getElementById("editCategory").value.trim() || state.siteConfig.defaultCategory;
  const tags = parseTagsString(document.getElementById("editTags").value);
  const summary = document.getElementById("editSummary").value.trim();
  const replaceInput = document.getElementById("editReplaceFile");

  if (!title) {
    showToast("标题不能为空。", "error");
    return;
  }

  const btn = document.getElementById("submitEditBtn");
  btn.disabled = true;
  btn.textContent = "保存中…";

  try {
    let baseHtml = "";
    if (replaceInput.files && replaceInput.files[0]) {
      baseHtml = await replaceInput.files[0].text();
    } else {
      baseHtml = await getRawHtmlForArticle(article);
    }

    const updatedHtml = injectMetadataIntoHtml(baseHtml, {
      title,
      category,
      tags,
      summary,
      createdAt: article.createdAt,
    });

    const updatedMeta = await parseHtmlArticle(updatedHtml, article.path, state.siteConfig, {
      id: article.id,
      title,
      category,
      tags,
      summary,
      createdAt: article.createdAt,
    });

    if (isLocal) {
      await storage.putArticleRecord({
        id: updatedMeta.id,
        path: updatedMeta.path,
        html: updatedHtml,
        metadata: updatedMeta,
        status: "local",
      });
      state.localRecords = await storage.getAllArticleRecords();
      await reconcileAndMergeArticles();
      renderAll();
    } else {
      await publishArticlesToGitHub(
        [{ path: updatedMeta.path, html: updatedHtml, article: updatedMeta }],
        `docs(knowledge): update ${updatedMeta.title}`
      );
    }

    closeModal("editModal");
    if (state.activeArticleId === article.id) {
      await openArticleReader(article.id);
    }
    showToast("知识点修改已保存！", "success");
  } catch (err) {
    showToast(`保存修改失败：${err.message}`, "error", 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = "保存修改";
  }
}

async function deleteArticleById(id) {
  const article = state.articles.find((a) => a.id === id);
  if (!article) return;

  const isLocal = article._source === "local";
  if (!isLocal && !isConfigured(state.githubConfig)) {
    showToast("删除云端知识点需要先配置 GitHub Token。", "info", 3800);
    openSettingsModal();
    return;
  }

  const ok = window.confirm(
    `确定要删除《${article.title}》吗？\n文件路径：${article.path}${
      isLocal ? "\n（仅删除本地暂存）" : "\n（将从 GitHub 仓库中删除并更新索引）"
    }`
  );
  if (!ok) return;

  try {
    if (isLocal) {
      await storage.deleteArticleRecord(article.id);
    } else {
      const remoteIndex = await fetchRemoteIndex(state.githubConfig);
      const remaining = (remoteIndex?.articles || state.remoteArticles).filter(
        (a) => a.path !== article.path
      );
      const newIndexPayload = buildIndexPayload(remaining);

      await commitAtomicChanges(state.githubConfig, {
        upserts: [
          {
            path: "data/index.json",
            content: JSON.stringify(newIndexPayload, null, 2) + "\n",
          },
        ],
        deletes: [article.path],
        message: `chore(knowledge): remove ${article.filename}`,
      });

      state.remoteArticles = newIndexPayload.articles;
      state.remoteIndexMeta.generatedAt = newIndexPayload.generatedAt;

      // Write deletion tombstone so stale CDN index doesn't resurrect it during deploy
      await storage.putArticleRecord({
        id: article.id,
        path: article.path,
        html: "",
        metadata: null,
        status: "synced-cache",
        deleted: true,
      });
    }

    state.favorites.delete(article.id);
    storage.setFavorites(state.favorites);
    state.localRecords = await storage.getAllArticleRecords();
    await reconcileAndMergeArticles();
    renderAll();

    if (state.activeArticleId === id) {
      navigateHome();
    }
    showToast(`已删除《${article.title}》。`, "success");
  } catch (err) {
    showToast(`删除失败：${err.message}`, "error", 5000);
  }
}

// ============================================================================
// Batch Selection & Batch Delete
// ============================================================================

function setSelectionMode(active) {
  state.selectionMode = Boolean(active);
  if (!state.selectionMode) {
    state.selectedIds.clear();
  }
  renderAll();
}

function toggleCardSelection(id) {
  if (!id) return;
  if (state.selectedIds.has(id)) {
    state.selectedIds.delete(id);
  } else {
    state.selectedIds.add(id);
  }
  renderAll();
}

function selectAllVisible() {
  if (!state.lastVisibleIds.length) return;
  const allVisibleSelected = state.lastVisibleIds.every((id) => state.selectedIds.has(id));
  if (allVisibleSelected) {
    for (const id of state.lastVisibleIds) state.selectedIds.delete(id);
  } else {
    for (const id of state.lastVisibleIds) state.selectedIds.add(id);
  }
  renderAll();
}

function invertVisibleSelection() {
  for (const id of state.lastVisibleIds) {
    if (state.selectedIds.has(id)) {
      state.selectedIds.delete(id);
    } else {
      state.selectedIds.add(id);
    }
  }
  renderAll();
}

function clearSelection() {
  state.selectedIds.clear();
  renderAll();
}

function getSelectedArticles() {
  return state.articles.filter((a) => state.selectedIds.has(a.id));
}

function updateBatchBarUI() {
  const toggleBtn = document.getElementById("toggleSelectModeBtn");
  const toggleLabel = document.getElementById("toggleSelectModeLabel");
  const bar = document.getElementById("batchActionBar");

  toggleBtn.classList.toggle("active", state.selectionMode);
  toggleLabel.textContent = state.selectionMode ? "退出批量" : "批量管理";
  bar.classList.toggle("hidden", !state.selectionMode);

  if (!state.selectionMode) return;

  const selected = getSelectedArticles();
  const count = selected.length;
  const localCount = selected.filter((a) => a._source === "local").length;
  const remoteCount = count - localCount;

  document.getElementById("batchSelectedCount").textContent = `已选 ${count} 篇`;
  const breakdownParts = [];
  if (remoteCount > 0) breakdownParts.push(`GitHub 云端 ${remoteCount} 篇`);
  if (localCount > 0) breakdownParts.push(`本地暂存 ${localCount} 篇`);
  document.getElementById("batchBreakdown").textContent = breakdownParts.length
    ? `（${breakdownParts.join("，")}）`
    : "点击下方知识点卡片勾选";

  const selectAllBtn = document.getElementById("batchSelectAllBtn");
  const allVisibleSelected =
    state.lastVisibleIds.length > 0 &&
    state.lastVisibleIds.every((id) => state.selectedIds.has(id));
  selectAllBtn.textContent = allVisibleSelected
    ? `取消全选 (${state.lastVisibleIds.length})`
    : `全选当前结果 (${state.lastVisibleIds.length})`;
  selectAllBtn.disabled = state.lastVisibleIds.length === 0;

  document.getElementById("batchInvertBtn").disabled = state.lastVisibleIds.length === 0;
  document.getElementById("batchClearBtn").disabled = count === 0;

  const delBtn = document.getElementById("batchDeleteBtn");
  delBtn.disabled = count === 0;
  document.getElementById("batchDeleteBtnLabel").textContent =
    count > 0 ? `删除所选 (${count})` : "删除所选";
}

function openBatchDeleteModal() {
  const selected = getSelectedArticles();
  if (!selected.length) return;

  const localItems = selected.filter((a) => a._source === "local");
  const remoteItems = selected.filter((a) => a._source !== "local");

  if (remoteItems.length > 0 && !isConfigured(state.githubConfig)) {
    showToast("所选包含 GitHub 云端知识点，请先配置具有写入权限的 GitHub Token。", "info", 4200);
    openSettingsModal();
    return;
  }

  document.getElementById("batchDeleteSubtitle").textContent = `即将删除 ${selected.length} 篇 HTML 知识点`;

  const alertParts = [];
  if (remoteItems.length > 0) {
    alertParts.push(`${remoteItems.length} 篇将从 GitHub 仓库永久删除`);
  }
  if (localItems.length > 0) {
    alertParts.push(`${localItems.length} 篇将从浏览器本地暂存移除`);
  }
  document.getElementById("batchDeleteSummaryAlert").textContent =
    `确认操作：${alertParts.join("；")}。`;

  renderBatchDeleteList(document.getElementById("batchDeleteList"), selected);

  const footerNote = document.getElementById("batchDeleteFooterNote");
  footerNote.textContent =
    remoteItems.length > 0
      ? `目标仓库：${state.githubConfig.owner}/${state.githubConfig.repo}@${state.githubConfig.branch}`
      : "仅影响当前浏览器本地暂存数据";

  const confirmBtn = document.getElementById("confirmBatchDeleteBtn");
  confirmBtn.disabled = false;
  confirmBtn.textContent = `确认批量删除 (${selected.length})`;

  openModal("batchDeleteModal");
}

async function confirmBatchDelete() {
  const selected = getSelectedArticles();
  if (!selected.length) {
    closeModal("batchDeleteModal");
    return;
  }

  const localItems = selected.filter((a) => a._source === "local");
  const remoteItems = selected.filter((a) => a._source !== "local");

  if (remoteItems.length > 0 && !isConfigured(state.githubConfig)) {
    showToast("删除云端知识点需要先配置 GitHub Token。", "info", 3800);
    closeModal("batchDeleteModal");
    openSettingsModal();
    return;
  }

  const confirmBtn = document.getElementById("confirmBatchDeleteBtn");
  const cancelBtn = document.getElementById("cancelBatchDeleteBtn");
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  confirmBtn.textContent = `正在删除 (${selected.length})…`;

  try {
    // 1. Delete remote articles in ONE atomic GitHub commit
    if (remoteItems.length > 0) {
      const remotePathSet = new Set(remoteItems.map((a) => a.path));
      const remoteIndex = await fetchRemoteIndex(state.githubConfig);
      const remaining = (remoteIndex?.articles || state.remoteArticles).filter(
        (a) => !remotePathSet.has(a.path)
      );
      const newIndexPayload = buildIndexPayload(remaining);

      await commitAtomicChanges(state.githubConfig, {
        upserts: [
          {
            path: "data/index.json",
            content: JSON.stringify(newIndexPayload, null, 2) + "\n",
          },
        ],
        deletes: Array.from(remotePathSet),
        message: `chore(knowledge): batch remove ${remoteItems.length} AI knowledge HTML file(s)`,
      });

      state.remoteArticles = newIndexPayload.articles;
      state.remoteIndexMeta.generatedAt = newIndexPayload.generatedAt;

      // Write deletion tombstones so stale Pages CDN index doesn't resurrect deleted files
      for (const art of remoteItems) {
        await storage.putArticleRecord({
          id: art.id,
          path: art.path,
          html: "",
          metadata: null,
          status: "synced-cache",
          deleted: true,
        });
      }
    }

    // 2. Delete local staged articles from IndexedDB
    for (const art of localItems) {
      await storage.deleteArticleRecord(art.id);
    }

    // 3. Clean up favorites & selection state
    for (const art of selected) {
      state.favorites.delete(art.id);
      state.selectedIds.delete(art.id);
    }
    storage.setFavorites(state.favorites);

    state.localRecords = await storage.getAllArticleRecords();
    await reconcileAndMergeArticles();
    state.selectionMode = false;
    closeModal("batchDeleteModal");
    renderAll();

    showToast(
      `已成功批量删除 ${selected.length} 篇 HTML 知识点${
        remoteItems.length > 0 ? "（已单次原子提交至 GitHub，Pages 将自动更新）" : ""
      }！`,
      "success",
      4800
    );
  } catch (err) {
    showToast(`批量删除失败：${err.message}`, "error", 5500);
  } finally {
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
    confirmBtn.textContent = `确认批量删除 (${state.selectedIds.size})`;
  }
}

// ============================================================================
// GitHub Settings Modal & Remote Maintenance
// ============================================================================

function openSettingsModal() {
  const cfg = state.githubConfig;
  document.getElementById("ghOwner").value = cfg.owner || "";
  document.getElementById("ghRepo").value = cfg.repo || "";
  document.getElementById("ghBranch").value = cfg.branch || "main";
  document.getElementById("ghArticlesDir").value = cfg.articlesDir || "articles";
  document.getElementById("ghToken").value = cfg.token || "";
  document.getElementById("ghToken").type = "password";
  document.getElementById("toggleTokenVisBtn").textContent = "显示";
  document.getElementById("connStatus").classList.add("hidden");
  document.getElementById("rebuildProgress").classList.add("hidden");
  openModal("settingsModal");
}

function readSettingsForm() {
  return {
    owner: document.getElementById("ghOwner").value.trim(),
    repo: document.getElementById("ghRepo").value.trim(),
    branch: document.getElementById("ghBranch").value.trim() || "main",
    articlesDir: document.getElementById("ghArticlesDir").value.trim().replace(/^\/+|\/+$/g, "") || "articles",
    token: document.getElementById("ghToken").value.trim(),
  };
}

function setConnAlert(message, type) {
  const el = document.getElementById("connStatus");
  el.textContent = message;
  el.className = `alert ${type}`;
}

async function handleTestConnection() {
  const cfg = readSettingsForm();
  const btn = document.getElementById("testConnBtn");
  btn.disabled = true;
  btn.textContent = "测试中…";
  try {
    const info = await testConnection(cfg);
    if (info.canPush) {
      setConnAlert(
        `连接成功！仓库 ${info.fullName}（分支 ${info.branch}）已具备写入权限，可以直接前端上传并保存 HTML。`,
        "success"
      );
    } else {
      setConnAlert(
        `已连接 ${info.fullName}，但当前 Token 缺少写入权限（push=false）。请为 Fine-Grained Token 授予 Contents: Read and write。`,
        "error"
      );
    }
  } catch (err) {
    setConnAlert(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "测试连接与写入权限";
  }
}

async function handlePullRemoteIndex() {
  const cfg = readSettingsForm();
  if (!hasRepoInfo(cfg)) {
    setConnAlert("请先填写 Owner 与 Repo。", "error");
    return;
  }
  storage.setGitHubConfig(cfg);
  state.githubConfig = storage.getGitHubConfig();
  updateGitHubStatusUI();

  const btn = document.getElementById("pullRemoteIndexBtn");
  btn.disabled = true;
  btn.textContent = "拉取中…";
  try {
    await loadAllData({ preferGitHubApi: true });
    renderAll();
    setConnAlert(`已从 GitHub 实时同步最新索引（共 ${state.remoteArticles.length} 篇云端知识点）。`, "success");
    showToast("已同步 GitHub 最新索引！", "success");
  } catch (err) {
    setConnAlert(`拉取失败：${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "从 GitHub API 实时拉取索引";
  }
}

async function handleRebuildRemoteIndex() {
  const cfg = readSettingsForm();
  if (!isConfigured(cfg)) {
    setConnAlert("重建远程索引需要填写 Owner、Repo 以及具有写权限的 Token。", "error");
    return;
  }
  storage.setGitHubConfig(cfg);
  state.githubConfig = storage.getGitHubConfig();
  updateGitHubStatusUI();

  const btn = document.getElementById("rebuildRemoteIndexBtn");
  const progressEl = document.getElementById("rebuildProgress");
  btn.disabled = true;
  progressEl.classList.remove("hidden");
  progressEl.textContent = "准备扫描仓库…";

  try {
    const { indexPayload } = await rebuildRemoteIndex(
      cfg,
      state.siteConfig,
      { parseHtmlArticle, buildIndexPayload },
      (msg) => {
        progressEl.textContent = msg;
      }
    );
    state.remoteArticles = indexPayload.articles;
    state.remoteIndexMeta.generatedAt = indexPayload.generatedAt;
    await reconcileAndMergeArticles();
    renderAll();
    progressEl.textContent = `完成！已扫描并索引 ${indexPayload.totalCount} 篇 HTML 知识点。`;
    setConnAlert(`远程索引已全量重建并提交（共 ${indexPayload.totalCount} 篇）。`, "success");
    showToast("远程索引重建完成！", "success");
  } catch (err) {
    progressEl.textContent = "";
    setConnAlert(`重建失败：${err.message}`, "error");
  } finally {
    btn.disabled = false;
  }
}

// ============================================================================
// Modal Helpers
// ============================================================================

function openModal(id) {
  document.getElementById(id)?.classList.remove("hidden");
}

function closeModal(id) {
  document.getElementById(id)?.classList.add("hidden");
  if (id === "previewModal" && state.previewBlobUrl) {
    URL.revokeObjectURL(state.previewBlobUrl);
    state.previewBlobUrl = null;
    document.getElementById("previewFrame").src = "about:blank";
  }
}

const MOBILE_SIDEBAR_MQ =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(max-width: 960px)")
    : null;

function isMobileViewport() {
  return MOBILE_SIDEBAR_MQ ? MOBILE_SIDEBAR_MQ.matches : false;
}

function syncSidebarUI() {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebarBackdrop");
  const menuBtn = document.getElementById("mobileMenuBtn");
  if (!sidebar || !backdrop || !menuBtn) return;

  if (isMobileViewport()) {
    sidebar.classList.remove("collapsed");
    const isOpen = sidebar.classList.contains("open") && !state.activeArticleId;
    sidebar.classList.toggle("open", isOpen);
    backdrop.classList.toggle("open", isOpen);
    menuBtn.setAttribute("aria-expanded", String(isOpen));
    menuBtn.title = state.activeArticleId
      ? "返回列表并打开导航菜单"
      : isOpen
        ? "收起导航菜单"
        : "打开导航菜单";
  } else {
    sidebar.classList.remove("open");
    backdrop.classList.remove("open");
    sidebar.classList.toggle("collapsed", state.sidebarCollapsed);
    const isExpanded = !state.sidebarCollapsed && !state.activeArticleId;
    menuBtn.setAttribute("aria-expanded", String(isExpanded));
    menuBtn.title = state.activeArticleId
      ? "返回列表并展开导航侧边栏"
      : state.sidebarCollapsed
        ? "展开导航侧边栏"
        : "收起导航侧边栏";
  }
}

function setDesktopSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = Boolean(collapsed);
  storage.setSidebarCollapsed(state.sidebarCollapsed);
  syncSidebarUI();
}

function openMobileSidebar(open) {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebarBackdrop");
  if (!sidebar || !backdrop) return;
  sidebar.classList.toggle("open", Boolean(open));
  backdrop.classList.toggle("open", Boolean(open));
  syncSidebarUI();
}

function toggleNavigationSidebar() {
  if (state.activeArticleId) {
    closeArticleReader(false);
    if (window.location.hash && window.location.hash !== "#/") {
      window.location.hash = "#/";
    }
    if (isMobileViewport()) {
      openMobileSidebar(true);
    } else {
      setDesktopSidebarCollapsed(false);
    }
    return;
  }

  if (isMobileViewport()) {
    const isOpen = document.getElementById("sidebar").classList.contains("open");
    openMobileSidebar(!isOpen);
  } else {
    setDesktopSidebarCollapsed(!state.sidebarCollapsed);
  }
}

// ============================================================================
// Event Binding
// ============================================================================

function bindEvents() {
  window.addEventListener("hashchange", handleHashRoute);

  // Navigation sidebar toggle (desktop collapse + mobile drawer)
  document.getElementById("mobileMenuBtn").addEventListener("click", toggleNavigationSidebar);
  document.getElementById("sidebarBackdrop").addEventListener("click", () => openMobileSidebar(false));
  if (MOBILE_SIDEBAR_MQ) {
    const onViewportChange = () => syncSidebarUI();
    if (typeof MOBILE_SIDEBAR_MQ.addEventListener === "function") {
      MOBILE_SIDEBAR_MQ.addEventListener("change", onViewportChange);
    } else if (typeof MOBILE_SIDEBAR_MQ.addListener === "function") {
      MOBILE_SIDEBAR_MQ.addListener(onViewportChange);
    }
  }

  // Brand home
  document.getElementById("brandHome").addEventListener("click", (e) => {
    e.preventDefault();
    navigateHome();
  });

  // Theme toggle
  document.getElementById("themeToggleBtn").addEventListener("click", toggleTheme);

  // Global search
  const searchInput = document.getElementById("searchInput");
  const searchClearBtn = document.getElementById("searchClearBtn");
  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    const val = searchInput.value;
    searchClearBtn.classList.toggle("hidden", !val);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = val;
      if (state.activeArticleId) navigateHome();
      renderAll();
    }, 110);
  });
  searchClearBtn.addEventListener("click", () => {
    searchInput.value = "";
    searchClearBtn.classList.add("hidden");
    state.query = "";
    renderAll();
    searchInput.focus();
  });

  // Quick nav views
  document.getElementById("quickNavList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view-filter]");
    if (!btn) return;
    state.viewFilter = btn.dataset.viewFilter;
    openMobileSidebar(false);
    renderAll();
  });

  // Category filter
  document.getElementById("categoryList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-category]");
    if (!btn) return;
    state.category = btn.dataset.category;
    openMobileSidebar(false);
    renderAll();
  });

  // Tag cloud & controls
  document.getElementById("tagCloud").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tag]");
    if (!btn) return;
    toggleSelectedTag(btn.dataset.tag);
  });
  document.getElementById("tagSearchInput").addEventListener("input", (e) => {
    state.tagFilterText = e.target.value;
    renderAll();
  });
  document.getElementById("tagModeBtn").addEventListener("click", () => {
    state.tagMode = state.tagMode === "or" ? "and" : "or";
    storage.setTagMode(state.tagMode);
    syncControlsFromState();
    renderAll();
  });
  document.getElementById("clearTagsBtn").addEventListener("click", () => {
    state.selectedTags = [];
    renderAll();
  });

  // Active filter chips removal
  document.getElementById("activeFilters").addEventListener("click", (e) => {
    const tagBtn = e.target.closest("[data-remove-tag]");
    if (tagBtn) {
      toggleSelectedTag(tagBtn.dataset.removeTag);
      return;
    }
    const filterBtn = e.target.closest("[data-remove-filter]");
    if (!filterBtn) return;
    const type = filterBtn.dataset.removeFilter;
    if (type === "all") {
      resetAllFilters();
    } else if (type === "view") {
      state.viewFilter = "all";
      renderAll();
    } else if (type === "category") {
      state.category = "all";
      renderAll();
    } else if (type === "query") {
      state.query = "";
      searchInput.value = "";
      searchClearBtn.classList.add("hidden");
      renderAll();
    }
  });

  // Toolbar controls
  document.getElementById("sortSelect").addEventListener("change", (e) => {
    state.sortBy = e.target.value;
    storage.setSortBy(state.sortBy);
    renderAll();
  });
  document.getElementById("viewGridBtn").addEventListener("click", () => {
    state.viewMode = "grid";
    storage.setViewMode("grid");
    syncControlsFromState();
    renderAll();
  });
  document.getElementById("viewListBtn").addEventListener("click", () => {
    state.viewMode = "list";
    storage.setViewMode("list");
    syncControlsFromState();
    renderAll();
  });
  document.getElementById("refreshIndexBtn").addEventListener("click", async () => {
    const btn = document.getElementById("refreshIndexBtn");
    btn.disabled = true;
    try {
      await loadAllData({ preferGitHubApi: hasRepoInfo(state.githubConfig) });
      renderAll();
      showToast(
        hasRepoInfo(state.githubConfig) ? "已从 GitHub 同步最新知识点索引。" : "已刷新本地索引。",
        "success"
      );
    } finally {
      btn.disabled = false;
    }
  });

  // Batch management actions
  document.getElementById("toggleSelectModeBtn").addEventListener("click", () => {
    setSelectionMode(!state.selectionMode);
  });
  document.getElementById("batchSelectAllBtn").addEventListener("click", selectAllVisible);
  document.getElementById("batchInvertBtn").addEventListener("click", invertVisibleSelection);
  document.getElementById("batchClearBtn").addEventListener("click", clearSelection);
  document.getElementById("batchDeleteBtn").addEventListener("click", openBatchDeleteModal);
  document.getElementById("batchExitBtn").addEventListener("click", () => setSelectionMode(false));
  document.getElementById("confirmBatchDeleteBtn").addEventListener("click", confirmBatchDelete);

  // Sync local drafts banner
  document.getElementById("syncAllLocalBtn").addEventListener("click", syncAllLocalToGitHub);

  // Cards click delegation
  document.getElementById("articlesContainer").addEventListener("click", (e) => {
    const card = e.target.closest("[data-article-id]");

    if (state.selectionMode) {
      if (card) {
        e.preventDefault();
        toggleCardSelection(card.dataset.articleId);
      }
      return;
    }

    const favBtn = e.target.closest("[data-card-fav]");
    if (favBtn) {
      e.stopPropagation();
      toggleFavorite(favBtn.dataset.cardFav);
      return;
    }
    const editBtn = e.target.closest("[data-card-edit]");
    if (editBtn) {
      e.stopPropagation();
      openEditModal(editBtn.dataset.cardEdit);
      return;
    }
    const deleteBtn = e.target.closest("[data-card-delete]");
    if (deleteBtn) {
      e.stopPropagation();
      deleteArticleById(deleteBtn.dataset.cardDelete);
      return;
    }
    const tagBtn = e.target.closest("[data-card-tag]");
    if (tagBtn) {
      e.stopPropagation();
      toggleSelectedTag(tagBtn.dataset.cardTag);
      return;
    }
    if (card) {
      navigateToArticle(card.dataset.articleId);
    }
  });

  // Empty state actions
  document.getElementById("resetFiltersBtn").addEventListener("click", resetAllFilters);
  document.getElementById("emptyUploadBtn").addEventListener("click", openUploadModal);

  // Reader actions
  document.getElementById("readerBackBtn").addEventListener("click", navigateHome);
  document.getElementById("readerFavBtn").addEventListener("click", () => {
    if (state.activeArticleId) toggleFavorite(state.activeArticleId);
  });
  document.getElementById("readerEditBtn").addEventListener("click", () => {
    if (state.activeArticleId) openEditModal(state.activeArticleId);
  });
  document.getElementById("readerDownloadBtn").addEventListener("click", downloadCurrentArticle);
  document.getElementById("readerInfoBtn").addEventListener("click", () => {
    state.readerInfoOpen = !state.readerInfoOpen;
    document.getElementById("readerSidePanel").classList.toggle("hidden", !state.readerInfoOpen);
  });
  document.getElementById("readerFullscreenBtn").addEventListener("click", () => {
    document.getElementById("readerView").classList.toggle("fullscreen");
  });
  document.getElementById("readerDeleteBtn").addEventListener("click", () => {
    if (state.activeArticleId) deleteArticleById(state.activeArticleId);
  });

  // Reader in-page search
  let findTimer = null;
  document.getElementById("readerFindInput").addEventListener("input", (e) => {
    clearTimeout(findTimer);
    findTimer = setTimeout(() => runReaderFind(e.target.value, true), 160);
  });
  document.getElementById("readerFindInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      stepReaderFind(e.shiftKey ? -1 : 1);
    }
  });
  document.getElementById("readerFindPrev").addEventListener("click", () => stepReaderFind(-1));
  document.getElementById("readerFindNext").addEventListener("click", () => stepReaderFind(1));

  // Reader side panel outline & tags
  document.getElementById("readerOutline").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-outline-idx]");
    if (!btn) return;
    const article = state.articles.find((a) => a.id === state.activeArticleId);
    const heading = article?.headings?.[Number(btn.dataset.outlineIdx)];
    if (heading) {
      scrollIframeToHeading(document.getElementById("readerFrame"), heading);
    }
  });
  document.getElementById("readerTags").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-reader-tag]");
    if (!btn) return;
    state.selectedTags = [btn.dataset.readerTag];
    state.category = "all";
    state.viewFilter = "all";
    navigateHome();
    renderAll();
  });

  // Upload modal triggers & interactions
  document.getElementById("openUploadBtn").addEventListener("click", openUploadModal);

  document.querySelectorAll("[data-upload-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.uploadTab;
      document.querySelectorAll("[data-upload-tab]").forEach((t) => t.classList.toggle("active", t === tab));
      document.getElementById("uploadTabFile").classList.toggle("hidden", target !== "file");
      document.getElementById("uploadTabPaste").classList.toggle("hidden", target !== "paste");
    });
  });

  const dropZone = document.getElementById("dropZone");
  const fileInput = document.getElementById("fileInput");
  dropZone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    if (fileInput.files?.length) {
      await handleDroppedFiles(fileInput.files);
      fileInput.value = "";
    }
  });
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    await handleDroppedFiles(e.dataTransfer?.files);
  });

  document.getElementById("parsePasteBtn").addEventListener("click", async () => {
    const ta = document.getElementById("pasteHtmlInput");
    const raw = ta.value.trim();
    if (!raw) {
      showToast("请先粘贴 HTML 源码。", "error");
      return;
    }
    await enqueueHtmlInput(raw, "");
    ta.value = "";
    showToast("已解析粘贴的 HTML 内容！", "success");
  });

  document.getElementById("clearQueueBtn").addEventListener("click", () => {
    state.uploadQueue = [];
    renderUploadQueueUI();
  });

  const queueList = document.getElementById("uploadQueueList");
  queueList.addEventListener("input", (e) => {
    const el = e.target.closest("[data-q-field]");
    if (!el) return;
    const idx = Number(el.dataset.qIdx);
    const field = el.dataset.qField;
    if (state.uploadQueue[idx]) {
      state.uploadQueue[idx][field] = el.value;
    }
  });
  queueList.addEventListener("click", (e) => {
    const rmBtn = e.target.closest("[data-q-remove]");
    if (rmBtn) {
      state.uploadQueue.splice(Number(rmBtn.dataset.qRemove), 1);
      renderUploadQueueUI();
      return;
    }
    const catBtn = e.target.closest("[data-q-set-cat]");
    if (catBtn) {
      const idx = Number(catBtn.dataset.qSetCat);
      const val = catBtn.dataset.catVal;
      if (state.uploadQueue[idx]) {
        state.uploadQueue[idx].category = val;
        const input = queueList.querySelector(`input[data-q-field="category"][data-q-idx="${idx}"]`);
        if (input) input.value = val;
      }
      return;
    }
    const prevBtn = e.target.closest("[data-q-preview]");
    if (prevBtn) {
      const item = state.uploadQueue[Number(prevBtn.dataset.qPreview)];
      if (!item) return;
      if (state.previewBlobUrl) URL.revokeObjectURL(state.previewBlobUrl);
      const blob = new Blob([item.rawHtml], { type: "text/html;charset=utf-8" });
      state.previewBlobUrl = URL.createObjectURL(blob);
      document.getElementById("previewModalTitle").textContent = `预览：${item.title || item.filename}`;
      document.getElementById("previewFrame").src = state.previewBlobUrl;
      openModal("previewModal");
    }
  });

  document.getElementById("saveLocalBtn").addEventListener("click", saveQueueToLocal);
  document.getElementById("saveGitHubBtn").addEventListener("click", saveQueueToGitHub);

  // Edit modal submit (handle both button click and Enter key form submission)
  document.getElementById("submitEditBtn").addEventListener("click", submitEditArticle);
  document.getElementById("editArticleForm").addEventListener("submit", (e) => {
    e.preventDefault();
    submitEditArticle();
  });

  // Settings modal
  document.getElementById("openSettingsBtn").addEventListener("click", openSettingsModal);
  document.getElementById("toggleTokenVisBtn").addEventListener("click", () => {
    const input = document.getElementById("ghToken");
    const btn = document.getElementById("toggleTokenVisBtn");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.textContent = show ? "隐藏" : "显示";
  });
  document.getElementById("autoDetectRepoBtn").addEventListener("click", () => {
    const detected = detectRepoFromContext(state.siteConfig);
    if (detected.owner && detected.repo) {
      document.getElementById("ghOwner").value = detected.owner;
      document.getElementById("ghRepo").value = detected.repo;
      document.getElementById("ghBranch").value = detected.branch || "main";
      setConnAlert(`已自动识别仓库：${detected.owner}/${detected.repo}`, "success");
    } else {
      setConnAlert("当前非 github.io 域名且 config.json 未预填，请手动输入 Owner 和 Repo。", "error");
    }
  });
  document.getElementById("testConnBtn").addEventListener("click", handleTestConnection);
  document.getElementById("clearTokenBtn").addEventListener("click", () => {
    document.getElementById("ghToken").value = "";
    storage.clearGitHubToken();
    state.githubConfig = storage.getGitHubConfig();
    updateGitHubStatusUI();
    setConnAlert("已从当前浏览器清除 GitHub Token。", "success");
  });
  document.getElementById("saveSettingsBtn").addEventListener("click", () => {
    const cfg = readSettingsForm();
    storage.setGitHubConfig(cfg);
    state.githubConfig = storage.getGitHubConfig();
    updateGitHubStatusUI();
    updateUploadFooterStatus();
    closeModal("settingsModal");
    showToast("GitHub 配置已保存到当前浏览器。", "success");
  });
  document.getElementById("pullRemoteIndexBtn").addEventListener("click", handlePullRemoteIndex);
  document.getElementById("rebuildRemoteIndexBtn").addEventListener("click", handleRebuildRemoteIndex);

  document.getElementById("copyPromptBtn").addEventListener("click", async () => {
    const text = document.getElementById("geminiPromptTip").textContent;
    try {
      await navigator.clipboard.writeText(text);
      showToast("已复制 Gemini 提示词模板！", "success");
    } catch {
      showToast("复制失败，请手动选中复制。", "error");
    }
  });

  // Generic modal close buttons & backdrop click
  document.querySelectorAll("[data-close-modal]").forEach((btn) => {
    btn.addEventListener("click", () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal(overlay.id);
    });
  });

  // Global keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    const isTyping = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (state.activeArticleId) navigateHome();
      searchInput.focus();
      searchInput.select();
      return;
    }

    if (e.key === "/" && !isTyping) {
      e.preventDefault();
      if (state.activeArticleId) navigateHome();
      searchInput.focus();
      return;
    }

    if (e.key.toLowerCase() === "u" && !isTyping && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const anyModalOpen = Boolean(document.querySelector(".modal-overlay:not(.hidden)"));
      if (!anyModalOpen) {
        e.preventDefault();
        openUploadModal();
      }
      return;
    }

    if (e.key === "Escape") {
      const openModals = Array.from(document.querySelectorAll(".modal-overlay:not(.hidden)"));
      if (openModals.length) {
        closeModal(openModals[openModals.length - 1].id);
        return;
      }
      if (document.getElementById("sidebar")?.classList.contains("open")) {
        openMobileSidebar(false);
        return;
      }
      if (state.activeArticleId) {
        if (document.getElementById("readerView").classList.contains("fullscreen")) {
          document.getElementById("readerView").classList.remove("fullscreen");
        } else {
          navigateHome();
        }
        return;
      }
      if (state.selectionMode) {
        setSelectionMode(false);
        return;
      }
      if (document.activeElement === searchInput && searchInput.value) {
        searchInput.value = "";
        searchClearBtn.classList.add("hidden");
        state.query = "";
        renderAll();
      }
    }
  });
}

function toggleSelectedTag(tag) {
  const idx = state.selectedTags.indexOf(tag);
  if (idx >= 0) {
    state.selectedTags.splice(idx, 1);
  } else {
    state.selectedTags.push(tag);
  }
  renderAll();
}

function toggleFavorite(id) {
  if (state.favorites.has(id)) {
    state.favorites.delete(id);
  } else {
    state.favorites.add(id);
  }
  storage.setFavorites(state.favorites);
  updateReaderFavBtn();
  renderAll();
}

function resetAllFilters() {
  state.viewFilter = "all";
  state.category = "all";
  state.selectedTags = [];
  state.tagFilterText = "";
  state.query = "";
  document.getElementById("searchInput").value = "";
  document.getElementById("searchClearBtn").classList.add("hidden");
  document.getElementById("tagSearchInput").value = "";
  renderAll();
}

// Start app
init();

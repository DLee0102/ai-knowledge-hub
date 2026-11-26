/**
 * UI rendering utilities, category color hashing, toast notifications,
 * and same-origin iframe outline navigation & search highlighting.
 */

import { escapeHtml, highlightText, parseQuery } from "./search.js?v=20261126-3";

const FALLBACK_COLORS = [
  "#6366f1", "#0ea5e9", "#ec4899", "#f59e0b",
  "#10b981", "#8b5cf6", "#14b8a6", "#f43f5e", "#3b82f6",
];

export function getCategoryColor(categoryName, siteConfig) {
  const configured = (siteConfig?.categories || []).find((c) => c.name === categoryName);
  if (configured?.color) return configured.color;
  let hash = 0;
  const str = String(categoryName || "");
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

export function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatWordCount(words) {
  const n = Number(words) || 0;
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万字`;
  return `${n.toLocaleString("zh-CN")} 字`;
}

export function showToast(message, type = "info", durationMs = 3400) {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(8px)";
    el.style.transition = "all 0.2s ease";
    setTimeout(() => el.remove(), 220);
  }, durationMs);
}

/**
 * Render category sidebar items.
 */
export function renderCategorySidebar(container, categories, activeCategory, siteConfig) {
  const allCount = categories.reduce((sum, c) => sum + c.count, 0);
  const metaEl = document.getElementById("categoryCountMeta");
  if (metaEl) metaEl.textContent = `${categories.length} 分类`;

  const items = [
    `<button class="nav-item ${activeCategory === "all" ? "active" : ""}" data-category="all">
      <span class="nav-item-label">
        <span class="cat-dot" style="background: var(--accent)"></span>
        全部分类
      </span>
      <span class="count-badge">${allCount}</span>
    </button>`,
    ...categories.map((cat) => {
      const color = getCategoryColor(cat.name, siteConfig);
      const active = activeCategory === cat.name ? "active" : "";
      return `<button class="nav-item ${active}" data-category="${escapeHtml(cat.name)}">
        <span class="nav-item-label">
          <span class="cat-dot" style="background:${color}"></span>
          ${escapeHtml(cat.name)}
        </span>
        <span class="count-badge">${cat.count}</span>
      </button>`;
    }),
  ];
  container.innerHTML = items.join("");
}

/**
 * Render tag cloud in sidebar.
 */
export function renderTagCloud(container, tags, selectedTags, filterKeyword) {
  const kw = String(filterKeyword || "").trim().toLowerCase();
  const filtered = kw
    ? tags.filter((t) => t.name.toLowerCase().includes(kw))
    : tags;

  if (!filtered.length) {
    container.innerHTML = `<span class="muted-small">${kw ? "无匹配标签" : "暂无标签"}</span>`;
    return;
  }

  const selectedSet = new Set(selectedTags);
  container.innerHTML = filtered
    .map((t) => {
      const active = selectedSet.has(t.name) ? "active" : "";
      return `<button class="tag-pill ${active}" data-tag="${escapeHtml(t.name)}">
        <span>#${escapeHtml(t.name)}</span>
        <span class="tag-cnt">${t.count}</span>
      </button>`;
    })
    .join("");
}

/**
 * Render active filter chips above the cards grid.
 */
export function renderActiveFilters(container, state) {
  const chips = [];
  if (state.viewFilter === "favorites") {
    chips.push(`<span class="filter-chip">收藏夹 <button data-remove-filter="view" title="移除">×</button></span>`);
  } else if (state.viewFilter === "local") {
    chips.push(`<span class="filter-chip">本地暂存 <button data-remove-filter="view" title="移除">×</button></span>`);
  }
  if (state.category !== "all") {
    chips.push(
      `<span class="filter-chip">分类：${escapeHtml(state.category)} <button data-remove-filter="category" title="移除">×</button></span>`
    );
  }
  for (const tag of state.selectedTags) {
    chips.push(
      `<span class="filter-chip">#${escapeHtml(tag)} <button data-remove-tag="${escapeHtml(tag)}" title="移除">×</button></span>`
    );
  }
  if (state.query.trim()) {
    chips.push(
      `<span class="filter-chip">搜索：${escapeHtml(state.query.trim())} <button data-remove-filter="query" title="清空">×</button></span>`
    );
  }
  if (chips.length > 1) {
    chips.push(`<button class="mini-link" data-remove-filter="all">清除全部</button>`);
  }
  container.innerHTML = chips.join("");
}

/**
 * Render article cards (Grid or List mode).
 */
export function renderArticlesGrid(container, searchResults, state) {
  container.className = state.viewMode === "list" ? "cards-list" : "cards-grid";

  const selectedTagSet = new Set(state.selectedTags);
  const selectionMode = Boolean(state.selectionMode);
  const selectedIds = state.selectedIds || new Set();

  container.innerHTML = searchResults
    .map((item) => {
      const a = item.article;
      const color = getCategoryColor(a.category, state.siteConfig);
      const isFav = state.favorites.has(a.id);
      const isSelected = selectionMode && selectedIds.has(a.id);
      const titleHtml = item.terms.length ? highlightText(a.title, item.terms) : escapeHtml(a.title);
      const bodyHtml = item.snippetHtml || escapeHtml(a.summary || "点击查看完整 HTML 知识点内容");

      let statusBadge = "";
      if (a._source === "local") {
        statusBadge = `<span class="source-pill" title="仅保存在当前浏览器，点击上方同步按钮可推送至 GitHub">本地暂存</span>`;
      } else if (a._source === "synced-cache") {
        statusBadge = `<span class="source-pill synced" title="已提交至 GitHub，GitHub Pages 部署期间提供本地实时预览">刚同步</span>`;
      }

      const matchBadges = item.matchedFields.length
        ? `<div class="match-fields">${item.matchedFields
            .map((f) => `<span class="match-badge">命中${escapeHtml(f)}</span>`)
            .join("")}</div>`
        : "";

      const tagsHtml = (a.tags || [])
        .slice(0, 8)
        .map((tag) => {
          const isActive = selectedTagSet.has(tag) ? "active" : "";
          const label = item.terms.length ? highlightText(tag, item.terms) : escapeHtml(tag);
          return `<button class="card-tag ${isActive}" data-card-tag="${escapeHtml(tag)}" type="button">#${label}</button>`;
        })
        .join("");

      const headingCount = (a.headings || []).length;
      const cardClasses = [
        "article-card",
        selectionMode ? "selectable" : "",
        isSelected ? "selected" : "",
      ]
        .filter(Boolean)
        .join(" ");

      const checkboxHtml = selectionMode
        ? `<span class="card-checkbox" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </span>`
        : "";

      const actionsHtml = selectionMode
        ? ""
        : `<div class="card-top-actions">
            <button class="card-action-btn ${isFav ? "fav-active" : ""}" data-card-fav="${escapeHtml(a.id)}" title="${isFav ? "取消收藏" : "收藏"}" type="button">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            </button>
            <button class="card-action-btn" data-card-edit="${escapeHtml(a.id)}" title="编辑元信息" type="button">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="card-action-btn danger" data-card-delete="${escapeHtml(a.id)}" title="删除此 HTML 知识点" type="button">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
            </button>
          </div>`;

      return `
        <article class="${cardClasses}" data-article-id="${escapeHtml(a.id)}" style="--card-accent:${color}" ${selectionMode ? `role="checkbox" aria-checked="${isSelected ? "true" : "false"}"` : ""}>
          <div class="card-top">
            <div class="card-badges">
              ${checkboxHtml}
              <span class="cat-badge" style="--badge-color:${color}">${escapeHtml(a.category)}</span>
              ${statusBadge}
            </div>
            ${actionsHtml}
          </div>

          <h3 class="card-title">${titleHtml}</h3>
          ${matchBadges}
          <p class="card-summary">${bodyHtml}</p>

          ${tagsHtml ? `<div class="card-tags">${tagsHtml}</div>` : ""}

          <div class="card-footer">
            <div class="card-meta-left">
              <span>${formatWordCount(a.wordCount)}</span>
              <span>约 ${a.readingTime || 1} 分钟</span>
              ${headingCount ? `<span>${headingCount} 节</span>` : ""}
            </div>
            <span title="更新时间">${formatDate(a.updatedAt || a.createdAt)}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

/**
 * Render list of articles queued for batch deletion inside confirmation modal.
 */
export function renderBatchDeleteList(container, articles) {
  container.innerHTML = articles
    .map((a) => {
      const sourcePill =
        a._source === "local"
          ? `<span class="source-pill">本地暂存</span>`
          : `<span class="source-pill synced">GitHub</span>`;
      return `
        <div class="delete-preview-item">
          <div class="delete-preview-info">
            <strong title="${escapeHtml(a.title)}">${escapeHtml(a.title)}</strong>
            <code>${escapeHtml(a.path)}</code>
          </div>
          ${sourcePill}
        </div>
      `;
    })
    .join("");
}

/**
 * Render upload queue items (single or batch).
 */
export function renderUploadQueue(container, queue, siteConfig) {
  const presetCats = (siteConfig?.categories || []).map((c) => c.name);
  container.innerHTML = queue
    .map((item, idx) => {
      const sizeStr = formatBytes(item.parsed.sizeBytes);
      const wordsStr = formatWordCount(item.parsed.wordCount);
      const suggestedCats = presetCats
        .map(
          (c) =>
            `<button type="button" class="mini-pill" data-q-set-cat="${idx}" data-cat-val="${escapeHtml(c)}">${escapeHtml(c)}</button>`
        )
        .join(" ");

      return `
        <div class="queue-item" data-q-idx="${idx}">
          <div class="queue-item-head">
            <div>
              <strong>#${idx + 1} · ${escapeHtml(item.filename)}</strong>
              <span class="queue-item-meta">（${wordsStr} · ${sizeStr} · 自动识别分类与标签）</span>
            </div>
            <div class="queue-item-actions">
              <button type="button" class="btn btn-ghost btn-sm" data-q-preview="${idx}">实时预览</button>
              <button type="button" class="btn btn-ghost btn-sm danger-text" data-q-remove="${idx}">移除</button>
            </div>
          </div>

          <div class="form-stack">
            <div class="field-row">
              <label class="field">
                <span>知识点标题</span>
                <input type="text" data-q-field="title" data-q-idx="${idx}" value="${escapeHtml(item.title)}" />
              </label>
              <label class="field">
                <span>保存文件名（存放于 articles/）</span>
                <input type="text" data-q-field="filename" data-q-idx="${idx}" value="${escapeHtml(item.filename)}" />
              </label>
            </div>

            <div class="field-row">
              <label class="field">
                <span>分类</span>
                <input type="text" list="categoryDatalist" data-q-field="category" data-q-idx="${idx}" value="${escapeHtml(item.category)}" />
              </label>
              <label class="field">
                <span>标签（英文或中文逗号分隔）</span>
                <input type="text" data-q-field="tagsText" data-q-idx="${idx}" value="${escapeHtml(item.tagsText)}" placeholder="Transformer, Attention, LLM" />
              </label>
            </div>

            <div class="settings-btn-row" style="gap:5px">${suggestedCats}</div>

            <label class="field">
              <span>摘要</span>
              <textarea rows="2" data-q-field="summary" data-q-idx="${idx}">${escapeHtml(item.summary)}</textarea>
            </label>
          </div>
        </div>
      `;
    })
    .join("");
}

/**
 * In-iframe text highlight helper (same-origin safe).
 * Returns array of <mark> elements created.
 */
export function highlightInIframe(iframe, keyword) {
  try {
    const doc = iframe?.contentDocument;
    if (!doc || !doc.body) return [];

    // Remove previous highlights cleanly
    doc.querySelectorAll("mark[data-akh-hl='1']").forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(doc.createTextNode(mark.textContent || ""), mark);
      parent.normalize();
    });

    const query = String(keyword || "").trim();
    if (!query) return [];

    // Preserve quoted exact phrases while splitting bare terms
    const terms = parseQuery(query).terms;
    if (!terms.length) return [];

    // Inject highlight style once
    if (!doc.getElementById("akh-hl-style")) {
      const style = doc.createElement("style");
      style.id = "akh-hl-style";
      style.textContent = `
        mark[data-akh-hl="1"] {
          background: #fde047 !important;
          color: #111827 !important;
          padding: 0 2px;
          border-radius: 3px;
        }
        mark[data-akh-hl="1"].akh-hl-current {
          background: #f97316 !important;
          color: #ffffff !important;
          outline: 2px solid #ea580c;
        }
      `;
      (doc.head || doc.body).appendChild(style);
    }

    const escaped = terms
      .sort((a, b) => b.length - a.length)
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const regex = new RegExp(`(${escaped.join("|")})`, "gi");

    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const tag = node.parentElement?.tagName;
        if (!tag || ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT"].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        return node.nodeValue && node.nodeValue.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    const textNodes = [];
    let current;
    while ((current = walker.nextNode())) {
      textNodes.push(current);
    }

    const createdMarks = [];
    for (const node of textNodes) {
      const val = node.nodeValue;
      regex.lastIndex = 0;
      if (!regex.test(val)) continue;

      regex.lastIndex = 0;
      const frag = doc.createDocumentFragment();
      let lastIdx = 0;
      let m;
      while ((m = regex.exec(val)) !== null) {
        if (m.index > lastIdx) {
          frag.appendChild(doc.createTextNode(val.slice(lastIdx, m.index)));
        }
        const mark = doc.createElement("mark");
        mark.setAttribute("data-akh-hl", "1");
        mark.textContent = m[0];
        frag.appendChild(mark);
        createdMarks.push(mark);
        lastIdx = m.index + m[0].length;
        if (createdMarks.length >= 300) break;
      }
      if (lastIdx < val.length) {
        frag.appendChild(doc.createTextNode(val.slice(lastIdx)));
      }
      node.parentNode.replaceChild(frag, node);
      if (createdMarks.length >= 300) break;
    }

    return createdMarks;
  } catch {
    return [];
  }
}

/**
 * Scroll same-origin iframe to a heading matching the given text.
 */
export function scrollIframeToHeading(iframe, headingText) {
  try {
    const doc = iframe?.contentDocument;
    if (!doc) return false;
    const target = headingText.trim().toLowerCase();
    const els = doc.querySelectorAll("h1, h2, h3, h4");
    for (const el of els) {
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (txt === target || txt.includes(target)) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        return true;
      }
    }
  } catch {
    // Ignore cross-origin error if any
  }
  return false;
}

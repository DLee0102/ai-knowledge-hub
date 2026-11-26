/**
 * Client-side HTML metadata & full-text parser.
 * Mirrors scripts/build_index.py so frontend uploads and GitHub Actions produce identical index entries.
 */

const MAX_CONTENT_CHARS = 50000;
const IGNORED_SELECTOR = "script, style, noscript, template, svg, iframe, canvas";
const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV",
  "H1", "H2", "H3", "H4", "H5", "H6", "LI", "UL", "OL", "DL", "DT", "DD",
  "TR", "TD", "TH", "BLOCKQUOTE", "PRE", "BR", "HR", "FIGURE", "FIGCAPTION",
]);

export function normalizeSpace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

export function truncateText(text, limit) {
  if (!text || text.length <= limit) return text || "";
  return text.slice(0, limit).replace(/[\s,，、;；:：]+$/, "") + "…";
}

export function countWords(text) {
  const cjkMatches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  const cjk = cjkMatches ? cjkMatches.length : 0;
  const nonCjk = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, " ");
  const latinMatches = nonCjk.match(/[A-Za-z0-9_+#.-]+/g);
  const latin = latinMatches ? latinMatches.length : 0;
  return cjk + latin;
}

export function parseTagsString(raw) {
  if (!raw) return [];
  const parts = String(raw).split(/[,，;；|]+/);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const tag = normalizeSpace(part);
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

export function sanitizeFilename(rawName, fallbackTitle = "ai-note") {
  let base = String(rawName || "").trim();
  if (!base) base = String(fallbackTitle || "ai-note").trim();
  // Remove directory traversal & illegal characters
  base = base.replace(/^.*[\\/]/, "");
  base = base.replace(/\.html?$/i, "");
  base = base
    .replace(/[<>:"/\\|?*#%`~^[\]{}]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) {
    base = `ai-note-${Date.now().toString(36)}`;
  }
  if (base.length > 80) {
    base = base.slice(0, 80).replace(/-+$/, "");
  }
  return `${base}.html`;
}

export function slugifyRelativePath(relNoExt) {
  let slug = String(relNoExt || "").replace(/\//g, "--");
  slug = slug.replace(/\s+/g, "-");
  slug = slug.replace(/[^\w\u4e00-\u9fff-]/g, "-");
  slug = slug.replace(/-{3,}/g, "--").replace(/^-+|-+$/g, "");
  return slug || "article";
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchKeywordCount(textLower, keyword) {
  const kw = String(keyword || "").trim().toLowerCase();
  if (!kw) return 0;
  if (/^[a-z0-9 .+#/-]+$/.test(kw)) {
    const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(kw)}(?![a-z0-9])`, "g");
    const matches = textLower.match(re);
    return matches ? matches.length : 0;
  }
  let count = 0;
  let pos = 0;
  while ((pos = textLower.indexOf(kw, pos)) !== -1) {
    count++;
    pos += kw.length;
  }
  return count;
}

export function inferCategory(title, headings, body, folderCategory, config) {
  if (folderCategory) return folderCategory;
  const categories = (config && config.categories) || [];
  const titleLower = (title || "").toLowerCase();
  const headingLower = (headings || []).join(" ").toLowerCase();
  const bodyLower = (body || "").slice(0, 12000).toLowerCase();

  let bestName = (config && config.defaultCategory) || "AI 综合";
  let bestScore = 0;

  for (const cat of categories) {
    const name = (cat.name || "").trim();
    const keywords = cat.keywords || [];
    if (!name || !keywords.length) continue;
    let score = 0;
    for (const kw of keywords) {
      score += matchKeywordCount(titleLower, kw) * 6;
      score += matchKeywordCount(headingLower, kw) * 3;
      score += Math.min(matchKeywordCount(bodyLower, kw), 6);
    }
    if (score > bestScore) {
      bestScore = score;
      bestName = name;
    }
  }
  return bestName;
}

export function inferTags(title, headings, body, config, maxTags = 6) {
  const dictionary = (config && config.tagDictionary) || [];
  const titleLower = (title || "").toLowerCase();
  const headingLower = (headings || []).join(" ").toLowerCase();
  const bodyLower = (body || "").slice(0, 16000).toLowerCase();

  const scored = [];
  dictionary.forEach((term, idx) => {
    const tHits = matchKeywordCount(titleLower, term);
    const hHits = matchKeywordCount(headingLower, term);
    const bHits = Math.min(matchKeywordCount(bodyLower, term), 8);
    const score = tHits * 8 + hHits * 4 + bHits;
    if (score > 0) {
      scored.push({ score, idx, term });
    }
  });

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.slice(0, maxTags).map((s) => s.term);
}

/**
 * Compute 12-char hex SHA-256 hash of UTF-8 text (with sync FNV fallback if subtle crypto is unavailable).
 */
export async function computeContentHash(text) {
  const bytes = new TextEncoder().encode(text);
  try {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return hex.slice(0, 12);
    }
  } catch {
    // Fallback below
  }
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i];
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(4, "0").slice(0, 4);
}

function extractBodyTextWithSpacing(rootEl) {
  if (!rootEl) return "";
  const clone = rootEl.cloneNode(true);
  clone.querySelectorAll(IGNORED_SELECTOR).forEach((el) => el.remove());

  const parts = [];
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const isBlock = BLOCK_TAGS.has(node.tagName);
    if (isBlock) parts.push(" ");
    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child);
    }
    if (isBlock) parts.push(" ");
  }
  walk(clone);
  return normalizeSpace(parts.join(""));
}

/**
 * Parse raw HTML string into an index article object.
 */
export async function parseHtmlArticle(rawHtml, relPath, config, overrides = {}) {
  const htmlStr = String(rawHtml || "");
  const doc = new DOMParser().parseFromString(htmlStr, "text/html");

  const meta = {};
  doc.querySelectorAll("meta").forEach((m) => {
    const key = (m.getAttribute("name") || m.getAttribute("property") || "").trim().toLowerCase();
    const content = (m.getAttribute("content") || "").trim();
    if (key && content && !meta[key]) {
      meta[key] = content;
    }
  });

  const headings = [];
  const seenH = new Set();
  let firstH1 = "";
  doc.querySelectorAll("h1, h2, h3, h4").forEach((el) => {
    const txt = normalizeSpace(el.textContent);
    if (!txt) return;
    if (el.tagName === "H1" && !firstH1) firstH1 = txt;
    if (!seenH.has(txt)) {
      seenH.add(txt);
      headings.push(txt);
    }
  });

  const paragraphs = [];
  doc.querySelectorAll("p").forEach((p) => {
    const txt = normalizeSpace(p.textContent);
    if (txt) paragraphs.push(txt);
  });

  const bodyText = extractBodyTextWithSpacing(doc.body || doc.documentElement);
  const articlesDir = ((config && config.articlesDir) || "articles").replace(/^\/+|\/+$/g, "");

  const cleanRel = String(relPath || "untitled.html").replace(/^\/+/, "");
  const fullPath = cleanRel.startsWith(articlesDir + "/") ? cleanRel : `${articlesDir}/${cleanRel}`;
  const relFromArticles = fullPath.slice(articlesDir.length + 1);
  const relNoExt = relFromArticles.replace(/\.html?$/i, "");
  const filename = relFromArticles.split("/").pop() || "untitled.html";
  const pathParts = relFromArticles.split("/");
  const folderCategory = pathParts.length > 1 ? pathParts[0] : "";

  const docTitle = normalizeSpace(doc.title || "");
  const stemTitle = filename.replace(/\.html?$/i, "").replace(/[-_]+/g, " ").trim();

  const title =
    normalizeSpace(overrides.title) ||
    normalizeSpace(meta["ai-title"]) ||
    normalizeSpace(meta["og:title"]) ||
    docTitle ||
    firstH1 ||
    stemTitle ||
    "未命名知识点";

  const explicitCategory =
    normalizeSpace(overrides.category) ||
    normalizeSpace(meta["ai-category"]) ||
    normalizeSpace(meta["category"]);

  const category =
    explicitCategory || inferCategory(title, headings, bodyText, folderCategory, config);

  let tags = [];
  if (Array.isArray(overrides.tags) && overrides.tags.length > 0) {
    tags = parseTagsString(overrides.tags.join(","));
  } else if (typeof overrides.tags === "string" && overrides.tags.trim()) {
    tags = parseTagsString(overrides.tags);
  } else {
    const explicitTags = parseTagsString(meta["ai-tags"] || meta["keywords"] || "");
    tags = explicitTags.length ? explicitTags : inferTags(title, headings, bodyText, config);
  }

  let summary = normalizeSpace(overrides.summary);
  if (!summary) {
    for (const k of ["ai-summary", "description", "og:description"]) {
      if (meta[k]) {
        summary = truncateText(normalizeSpace(meta[k]), 180);
        break;
      }
    }
  }
  if (!summary) {
    const candidates = paragraphs.filter((p) => p.length >= 24 && p !== title);
    if (candidates.length) {
      let joined = candidates[0];
      if (joined.length < 70 && candidates.length > 1) {
        joined += " " + candidates[1];
      }
      summary = truncateText(joined, 160);
    } else {
      let fallback = bodyText;
      if (title && fallback.startsWith(title)) {
        fallback = fallback.slice(title.length).trim();
      }
      summary = truncateText(fallback, 160);
    }
  }

  const wordCount = countWords(bodyText);
  const readingTime = Math.max(1, Math.round(wordCount / 350));
  const sizeBytes = new TextEncoder().encode(htmlStr).length;
  const contentHash = await computeContentHash(htmlStr);
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  return {
    id: overrides.id || slugifyRelativePath(relNoExt),
    slug: relNoExt,
    filename,
    path: fullPath,
    title,
    category,
    tags,
    summary,
    headings: headings.slice(0, 30),
    content: bodyText.slice(0, MAX_CONTENT_CHARS),
    wordCount,
    readingTime,
    sizeBytes,
    createdAt: overrides.createdAt || meta["ai-created"] || nowIso,
    updatedAt: overrides.updatedAt || meta["ai-updated"] || nowIso,
    contentHash,
  };
}

function escapeAttr(val) {
  return String(val || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Ensures full valid HTML5 document & injects/updates ai-* <meta> tags inside <head>
 * without modifying article styles, scripts, or visual structure.
 */
export function injectMetadataIntoHtml(rawHtml, meta) {
  let html = String(rawHtml || "").trim();
  const title = normalizeSpace(meta.title) || "AI 知识点";
  const category = normalizeSpace(meta.category);
  const tagsStr = Array.isArray(meta.tags) ? meta.tags.join(", ") : normalizeSpace(meta.tags);
  const summary = normalizeSpace(meta.summary);
  const createdAt = normalizeSpace(meta.createdAt) || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // Wrap raw HTML fragment into a full HTML5 page if needed
  if (!/<html[\s>]/i.test(html)) {
    html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeAttr(title)}</title>
</head>
<body>
${html}
</body>
</html>`;
  } else if (!/<head[\s>]/i.test(html)) {
    html = html.replace(/<html([^>]*)>/i, `<html$1>\n<head>\n  <meta charset="UTF-8" />\n  <title>${escapeAttr(title)}</title>\n</head>`);
  }

  // Strip previous managed meta tags to avoid duplicates
  const managedNames = ["ai-title", "ai-category", "ai-tags", "ai-summary", "description", "ai-created", "ai-updated"];
  for (const name of managedNames) {
    const re = new RegExp(`[ \\t]*<meta\\s+[^>]*name\\s*=\\s*["']${name}["'][^>]*>\\r?\\n?`, "gi");
    html = html.replace(re, "");
  }

  const metaLines = [
    `  <meta name="ai-title" content="${escapeAttr(title)}" />`,
    category ? `  <meta name="ai-category" content="${escapeAttr(category)}" />` : "",
    tagsStr ? `  <meta name="ai-tags" content="${escapeAttr(tagsStr)}" />` : "",
    summary ? `  <meta name="description" content="${escapeAttr(summary)}" />` : "",
    `  <meta name="ai-created" content="${escapeAttr(createdAt)}" />`,
    `  <meta name="ai-updated" content="${escapeAttr(updatedAt)}" />`,
  ]
    .filter(Boolean)
    .join("\n");

  // Also update <title> if present
  if (/<title[^>]*>[\s\S]*?<\/title>/i.test(html)) {
    html = html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${escapeAttr(title)}</title>`);
  } else {
    html = html.replace(/<\/head>/i, `  <title>${escapeAttr(title)}</title>\n</head>`);
  }

  html = html.replace(/<\/head>/i, `${metaLines}\n</head>`);
  return html;
}

/**
 * Builds a complete `data/index.json` payload from an array of articles.
 */
export function buildIndexPayload(articles) {
  const cleanArticles = articles
    .map((a) => ({
      id: a.id,
      slug: a.slug,
      filename: a.filename,
      path: a.path,
      title: a.title,
      category: a.category,
      tags: Array.isArray(a.tags) ? a.tags : [],
      summary: a.summary || "",
      headings: Array.isArray(a.headings) ? a.headings : [],
      content: a.content || "",
      wordCount: Number(a.wordCount) || 0,
      readingTime: Number(a.readingTime) || 1,
      sizeBytes: Number(a.sizeBytes) || 0,
      createdAt: a.createdAt || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      updatedAt: a.updatedAt || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      contentHash: a.contentHash || "",
    }))
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "") || (a.title || "").localeCompare(b.title || ""));

  const catCounts = new Map();
  const tagCounts = new Map();
  for (const art of cleanArticles) {
    catCounts.set(art.category, (catCounts.get(art.category) || 0) + 1);
    for (const tag of art.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }

  const categories = Array.from(catCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));

  const tags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));

  return {
    version: 1,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    totalCount: cleanArticles.length,
    categories,
    tags,
    articles: cleanArticles,
  };
}

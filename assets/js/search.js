/**
 * Full-text & faceted search engine (Chinese + English).
 * Supports multi-term AND queries, quoted exact phrases, inline filters (`tag:LoRA`, `cat:核心架构`),
 * BM25-inspired weighted field scoring, and contextual <mark> snippet highlighting.
 */

export function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse raw search string into structured filters and search terms.
 * Example: `cat:核心架构 tag:Transformer "multi head" 注意力`
 */
export function parseQuery(rawQuery) {
  const input = String(rawQuery || "").trim();
  const terms = [];
  const inlineTags = [];
  const inlineCategories = [];

  if (!input) {
    return { raw: "", terms, inlineTags, inlineCategories };
  }

  // Match key:"quoted value", key:value, "quoted phrase", or bare token
  const regex = /(?:(tag|tags|cat|category):(?:"([^"]+)"|(\S+)))|"([^"]+)"|(\S+)/gi;
  let match;
  while ((match = regex.exec(input)) !== null) {
    if (match[1]) {
      const key = match[1].toLowerCase();
      const val = (match[2] || match[3] || "").trim();
      if (!val) continue;
      if (key === "tag" || key === "tags") {
        inlineTags.push(val.toLowerCase());
      } else {
        inlineCategories.push(val.toLowerCase());
      }
    } else if (match[4]) {
      const phrase = match[4].trim();
      if (phrase) terms.push(phrase);
    } else if (match[5]) {
      const token = match[5].trim();
      if (token) terms.push(token);
    }
  }

  return { raw: input, terms, inlineTags, inlineCategories };
}

function countOccurrences(haystackLower, needleLower) {
  if (!haystackLower || !needleLower) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystackLower.indexOf(needleLower, idx)) !== -1) {
    count++;
    idx += needleLower.length;
  }
  return count;
}

/**
 * Safely highlight all occurrences of search terms in plain text using <mark>.
 */
export function highlightText(text, terms) {
  const safe = escapeHtml(text);
  if (!terms || !terms.length) return safe;
  const unique = Array.from(new Set(terms.map((t) => t.trim()).filter(Boolean)))
    .sort((a, b) => b.length - a.length);
  if (!unique.length) return safe;

  const escapedTerms = unique.map((t) => escapeRegExp(escapeHtml(t)));
  const re = new RegExp(`(${escapedTerms.join("|")})`, "gi");
  return safe.replace(re, "<mark>$1</mark>");
}

/**
 * Extract the most relevant excerpt window around matched terms in full text.
 */
export function buildSnippet(content, terms, windowChars = 170) {
  const text = String(content || "");
  if (!text) return "";
  if (!terms || !terms.length) {
    return escapeHtml(text.slice(0, windowChars)) + (text.length > windowChars ? "…" : "");
  }

  const lower = text.toLowerCase();
  const termsLower = terms.map((t) => t.toLowerCase()).filter(Boolean);

  // Find candidate match positions for all terms
  const positions = [];
  for (const term of termsLower) {
    let idx = lower.indexOf(term);
    let found = 0;
    while (idx !== -1 && found < 6) {
      positions.push({ pos: idx, len: term.length, term });
      idx = lower.indexOf(term, idx + term.length);
      found++;
    }
  }

  if (!positions.length) {
    return highlightText(text.slice(0, windowChars) + (text.length > windowChars ? "…" : ""), terms);
  }

  // Choose the position whose surrounding window covers the most distinct search terms
  let bestPos = positions[0].pos;
  let bestDistinct = 0;
  for (const cand of positions) {
    const winStart = Math.max(0, cand.pos - 50);
    const winEnd = winStart + windowChars;
    const slice = lower.slice(winStart, winEnd);
    let distinct = 0;
    for (const term of termsLower) {
      if (slice.includes(term)) distinct++;
    }
    if (distinct > bestDistinct) {
      bestDistinct = distinct;
      bestPos = cand.pos;
    }
  }

  const start = Math.max(0, bestPos - 55);
  const end = Math.min(text.length, start + windowChars);
  let excerpt = text.slice(start, end);
  if (start > 0) excerpt = "…" + excerpt.replace(/^\S{0,8}\s/, "");
  if (end < text.length) excerpt = excerpt.replace(/\s\S{0,8}$/, "") + "…";

  return highlightText(excerpt, terms);
}

/**
 * Filter and rank articles by query, category, tags, favorites, source, and sort order.
 */
export function searchAndFilterArticles(articles, options) {
  const {
    query = "",
    category = "all",
    selectedTags = [],
    tagMode = "or",
    onlyFavorites = false,
    onlyLocal = false,
    favorites = new Set(),
    sortBy = "updated",
  } = options || {};

  const parsed = parseQuery(query);
  const termsLower = parsed.terms.map((t) => t.toLowerCase());
  const selectedTagSet = selectedTags.map((t) => t.toLowerCase());

  const results = [];

  for (const article of articles) {
    if (onlyFavorites && !favorites.has(article.id)) continue;
    if (onlyLocal && article._source !== "local") continue;

    if (category && category !== "all" && article.category !== category) {
      continue;
    }

    const articleTagsLower = (article.tags || []).map((t) => t.toLowerCase());

    // Inline category syntax (cat:xxx)
    if (parsed.inlineCategories.length > 0) {
      const catLower = (article.category || "").toLowerCase();
      const ok = parsed.inlineCategories.some((c) => catLower.includes(c));
      if (!ok) continue;
    }

    // Inline tag syntax (tag:xxx)
    if (parsed.inlineTags.length > 0) {
      const ok = parsed.inlineTags.every((t) => articleTagsLower.some((at) => at.includes(t)));
      if (!ok) continue;
    }

    // Facet sidebar tags
    if (selectedTagSet.length > 0) {
      if (tagMode === "and") {
        const allMatch = selectedTagSet.every((t) => articleTagsLower.includes(t));
        if (!allMatch) continue;
      } else {
        const anyMatch = selectedTagSet.some((t) => articleTagsLower.includes(t));
        if (!anyMatch) continue;
      }
    }

    // Full-text scoring
    if (termsLower.length === 0) {
      results.push({
        article,
        score: 0,
        matchedFields: [],
        snippetHtml: "",
        terms: [],
      });
      continue;
    }

    const titleLower = (article.title || "").toLowerCase();
    const catLower = (article.category || "").toLowerCase();
    const tagsJoined = articleTagsLower.join(" ");
    const headingsJoined = (article.headings || []).join(" ").toLowerCase();
    const summaryLower = (article.summary || "").toLowerCase();
    const contentLower = (article.content || "").toLowerCase();

    let totalScore = 0;
    let allTermsMatched = true;
    const matchedFields = new Set();

    for (const term of termsLower) {
      const tCount = countOccurrences(titleLower, term);
      const tagCount = countOccurrences(tagsJoined, term);
      const catCount = countOccurrences(catLower, term);
      const hCount = countOccurrences(headingsJoined, term);
      const sCount = countOccurrences(summaryLower, term);
      const cCount = countOccurrences(contentLower, term);

      if (tCount + tagCount + catCount + hCount + sCount + cCount === 0) {
        allTermsMatched = false;
        break;
      }

      if (tCount > 0) {
        matchedFields.add("标题");
        totalScore += 14 + Math.min(tCount, 3) * 3;
        if (titleLower.includes(parsed.raw.toLowerCase())) totalScore += 10;
      }
      if (tagCount > 0) {
        matchedFields.add("标签");
        totalScore += 10 + Math.min(tagCount, 3) * 2;
      }
      if (catCount > 0) {
        matchedFields.add("分类");
        totalScore += 6;
      }
      if (hCount > 0) {
        matchedFields.add("章节");
        totalScore += 5 + Math.log1p(hCount) * 2;
      }
      if (sCount > 0) {
        matchedFields.add("摘要");
        totalScore += 3 + Math.log1p(sCount);
      }
      if (cCount > 0) {
        matchedFields.add("正文");
        totalScore += 1.5 + Math.log1p(cCount) * 1.8;
      }
    }

    if (!allTermsMatched) continue;

    // Bonus for exact full phrase hit in body
    if (termsLower.length > 1 && contentLower.includes(parsed.raw.toLowerCase())) {
      totalScore += 8;
    }

    const snippetHtml = matchedFields.has("正文")
      ? buildSnippet(article.content, parsed.terms)
      : highlightText(article.summary || "", parsed.terms);

    results.push({
      article,
      score: totalScore,
      matchedFields: Array.from(matchedFields),
      snippetHtml,
      terms: parsed.terms,
    });
  }

  // Sort results
  if (termsLower.length > 0 && sortBy === "updated") {
    // Relevance first when actively searching
    results.sort(
      (a, b) =>
        b.score - a.score ||
        (b.article.updatedAt || "").localeCompare(a.article.updatedAt || "")
    );
  } else if (sortBy === "title") {
    results.sort((a, b) => (a.article.title || "").localeCompare(b.article.title || "", "zh-CN"));
  } else if (sortBy === "words") {
    results.sort((a, b) => (b.article.wordCount || 0) - (a.article.wordCount || 0));
  } else if (sortBy === "oldest") {
    results.sort((a, b) => (a.article.createdAt || "").localeCompare(b.article.createdAt || ""));
  } else {
    results.sort((a, b) => (b.article.updatedAt || "").localeCompare(a.article.updatedAt || ""));
  }

  return {
    parsed,
    results,
  };
}

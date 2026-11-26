#!/usr/bin/env python3
"""
AI Knowledge Hub — Zero-dependency HTML Auto-Indexer.

Scans all `.html` / `.htm` files under `articles/` (including subdirectories),
extracts title, category, tags, summary, headings, and cleaned full-text content,
and generates `data/index.json` for instant tag filtering and full-text search.

Usage:
    python scripts/build_index.py
    python scripts/build_index.py --force
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT_DIR / "data" / "config.json"
INDEX_PATH = ROOT_DIR / "data" / "index.json"

MAX_CONTENT_CHARS = 50000
IGNORED_TAGS = {"script", "style", "noscript", "template", "svg", "iframe", "canvas"}
BLOCK_TAGS = {
    "p", "div", "section", "article", "header", "footer", "main", "aside", "nav",
    "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "dl", "dt", "dd",
    "tr", "td", "th", "blockquote", "pre", "br", "hr", "figure", "figcaption",
}
HEADING_TAGS = {"h1", "h2", "h3", "h4"}


class ArticleHTMLParser(HTMLParser):
    """Lightweight stdlib HTML parser that extracts structured metadata & full text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title_parts: list[str] = []
        self.headings: list[tuple[str, str]] = []
        self.paragraphs: list[str] = []
        self.body_parts: list[str] = []

        self._in_title = False
        self._in_body = False
        self._has_body_tag = False
        self._ignore_depth = 0
        self._current_heading: tuple[str, list[str]] | None = None
        self._in_p = False
        self._current_p: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        attr_map = {k.lower(): (v or "") for k, v in attrs}

        if tag in IGNORED_TAGS:
            self._ignore_depth += 1
            return

        if self._ignore_depth > 0:
            return

        if tag == "body":
            self._in_body = True
            self._has_body_tag = True
        elif tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = (attr_map.get("name") or attr_map.get("property") or "").strip().lower()
            content = attr_map.get("content", "").strip()
            if key and content and key not in self.meta:
                self.meta[key] = content

        if tag in HEADING_TAGS:
            self._current_heading = (tag, [])
        elif tag == "p":
            self._in_p = True
            self._current_p = []

        if tag in BLOCK_TAGS:
            self.body_parts.append(" ")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in IGNORED_TAGS:
            if self._ignore_depth > 0:
                self._ignore_depth -= 1
            return

        if self._ignore_depth > 0:
            return

        if tag == "body":
            self._in_body = False
        elif tag == "title":
            self._in_title = False
        elif tag in HEADING_TAGS and self._current_heading and self._current_heading[0] == tag:
            text = normalize_space("".join(self._current_heading[1]))
            if text:
                self.headings.append((tag, text))
            self._current_heading = None
        elif tag == "p" and self._in_p:
            text = normalize_space("".join(self._current_p))
            if text:
                self.paragraphs.append(text)
            self._in_p = False
            self._current_p = []

        if tag in BLOCK_TAGS:
            self.body_parts.append(" ")

    def handle_data(self, data: str) -> None:
        if self._ignore_depth > 0:
            return

        if self._in_title:
            self.title_parts.append(data)
            return

        if self._current_heading is not None:
            self._current_heading[1].append(data)
        if self._in_p:
            self._current_p.append(data)

        if self._in_body or not self._has_body_tag:
            self.body_parts.append(data)


def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(text or "")).strip()


def count_words(text: str) -> int:
    """Count CJK characters individually and Latin/numeric tokens as words."""
    cjk = len(re.findall(r"[\u4e00-\u9fff\u3400-\u4dbf]", text))
    non_cjk = re.sub(r"[\u4e00-\u9fff\u3400-\u4dbf]", " ", text)
    latin = len(re.findall(r"[A-Za-z0-9_+#.-]+", non_cjk))
    return cjk + latin


def humanize_filename(stem: str) -> str:
    cleaned = re.sub(r"[-_]+", " ", stem).strip()
    return cleaned or stem


def slugify_relative_path(rel_posix_no_ext: str) -> str:
    slug = rel_posix_no_ext.replace("/", "--")
    slug = re.sub(r"\s+", "-", slug)
    slug = re.sub(r"[^\w\u4e00-\u9fff-]", "-", slug)
    slug = re.sub(r"-{3,}", "--", slug).strip("-")
    return slug or "article"


def parse_tags_string(raw: str) -> list[str]:
    if not raw:
        return []
    parts = re.split(r"[,，;；|]+", raw)
    seen: set[str] = set()
    result: list[str] = []
    for part in parts:
        tag = normalize_space(part)
        key = tag.lower()
        if tag and key not in seen:
            seen.add(key)
            result.append(tag)
    return result


def match_keyword_count(text_lower: str, keyword: str) -> int:
    kw = keyword.strip().lower()
    if not kw:
        return 0
    # Use word boundaries for pure ASCII tokens to avoid false positives (e.g. 'rag' in 'storage')
    if re.fullmatch(r"[a-z0-9 .+#/-]+", kw):
        pattern = r"(?<![a-z0-9])" + re.escape(kw) + r"(?![a-z0-9])"
        return len(re.findall(pattern, text_lower))
    return text_lower.count(kw)


def infer_category(
    title: str,
    headings: list[str],
    body: str,
    folder_category: str,
    config: dict[str, Any],
) -> str:
    if folder_category:
        return folder_category

    categories = config.get("categories") or []
    title_lower = title.lower()
    heading_lower = " ".join(headings).lower()
    body_lower = body[:12000].lower()

    best_name = config.get("defaultCategory", "AI 综合")
    best_score = 0

    for cat in categories:
        name = cat.get("name", "").strip()
        keywords = cat.get("keywords") or []
        if not name or not keywords:
            continue
        score = 0
        for kw in keywords:
            score += match_keyword_count(title_lower, kw) * 6
            score += match_keyword_count(heading_lower, kw) * 3
            score += min(match_keyword_count(body_lower, kw), 6)
        if score > best_score:
            best_score = score
            best_name = name

    return best_name


def infer_tags(
    title: str,
    headings: list[str],
    body: str,
    config: dict[str, Any],
    max_tags: int = 6,
) -> list[str]:
    dictionary = config.get("tagDictionary") or []
    title_lower = title.lower()
    heading_lower = " ".join(headings).lower()
    body_lower = body[:16000].lower()

    scored: list[tuple[int, int, str]] = []
    for idx, term in enumerate(dictionary):
        t_hits = match_keyword_count(title_lower, term)
        h_hits = match_keyword_count(heading_lower, term)
        b_hits = min(match_keyword_count(body_lower, term), 8)
        score = t_hits * 8 + h_hits * 4 + b_hits
        if score > 0:
            scored.append((score, -idx, term))

    scored.sort(reverse=True)
    return [item[2] for item in scored[:max_tags]]


def extract_summary(meta: dict[str, str], paragraphs: list[str], body: str, title: str) -> str:
    for key in ("ai-summary", "description", "og:description"):
        if meta.get(key):
            return truncate_text(normalize_space(meta[key]), 180)

    candidates = [p for p in paragraphs if len(p) >= 24 and p != title]
    if candidates:
        joined = candidates[0]
        if len(joined) < 70 and len(candidates) > 1:
            joined = f"{joined} {candidates[1]}"
        return truncate_text(joined, 160)

    clean_body = body
    if title and clean_body.startswith(title):
        clean_body = clean_body[len(title):].strip()
    return truncate_text(clean_body, 160)


def truncate_text(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rstrip(" ,，、;；:：") + "…"


def git_file_timestamp(file_path: Path, first_commit: bool = False) -> str | None:
    try:
        rel = file_path.relative_to(ROOT_DIR).as_posix()
        cmd = ["git", "log", "--format=%cI", "--follow"]
        if first_commit:
            cmd.extend(["--diff-filter=A", "--", rel])
        else:
            cmd.extend(["-1", "--", rel])
        proc = subprocess.run(
            cmd,
            cwd=str(ROOT_DIR),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        lines = [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]
        if lines:
            return lines[-1] if first_commit else lines[0]
    except Exception:
        return None
    return None


def file_mtime_iso(file_path: Path) -> str:
    ts = datetime.fromtimestamp(file_path.stat().st_mtime, tz=timezone.utc)
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_article_file(
    file_path: Path,
    articles_root: Path,
    config: dict[str, Any],
    existing_map: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    raw_bytes = file_path.read_bytes()
    content_hash = hashlib.sha256(raw_bytes).hexdigest()[:12]
    raw_html = raw_bytes.decode("utf-8", errors="replace")

    parser = ArticleHTMLParser()
    parser.feed(raw_html)
    parser.close()

    rel_from_articles = file_path.relative_to(articles_root)
    rel_from_root = file_path.relative_to(ROOT_DIR).as_posix()
    rel_no_ext = rel_from_articles.with_suffix("").as_posix()
    article_id = slugify_relative_path(rel_no_ext)

    folder_category = ""
    if len(rel_from_articles.parts) > 1:
        folder_category = rel_from_articles.parts[0]

    h1_list = [text for tag, text in parser.headings if tag == "h1"]
    all_headings: list[str] = []
    seen_headings: set[str] = set()
    for _, h_text in parser.headings:
        if h_text not in seen_headings:
            seen_headings.add(h_text)
            all_headings.append(h_text)

    title = (
        normalize_space(parser.meta.get("ai-title", ""))
        or normalize_space(parser.meta.get("og:title", ""))
        or normalize_space("".join(parser.title_parts))
        or (h1_list[0] if h1_list else "")
        or humanize_filename(file_path.stem)
    )

    body_text = normalize_space("".join(parser.body_parts))
    indexed_content = body_text[:MAX_CONTENT_CHARS]

    explicit_cat = normalize_space(
        parser.meta.get("ai-category", "") or parser.meta.get("category", "")
    )
    category = explicit_cat or infer_category(
        title=title,
        headings=all_headings,
        body=body_text,
        folder_category=folder_category,
        config=config,
    )

    explicit_tags = parse_tags_string(
        parser.meta.get("ai-tags", "") or parser.meta.get("keywords", "")
    )
    tags = explicit_tags or infer_tags(
        title=title,
        headings=all_headings,
        body=body_text,
        config=config,
    )

    summary = extract_summary(parser.meta, parser.paragraphs, body_text, title)
    word_count = count_words(body_text)
    reading_time = max(1, round(word_count / 350)) if word_count > 0 else 1

    prev = existing_map.get(rel_from_root) or existing_map.get(article_id) or {}
    meta_created = normalize_space(parser.meta.get("ai-created", ""))
    meta_updated = normalize_space(parser.meta.get("ai-updated", ""))

    created_at = (
        meta_created
        or prev.get("createdAt")
        or git_file_timestamp(file_path, first_commit=True)
        or file_mtime_iso(file_path)
    )

    if meta_updated:
        updated_at = meta_updated
    elif prev.get("contentHash") == content_hash and prev.get("updatedAt"):
        updated_at = prev["updatedAt"]
    else:
        updated_at = (
            git_file_timestamp(file_path, first_commit=False)
            or file_mtime_iso(file_path)
        )

    return {
        "id": article_id,
        "slug": rel_no_ext,
        "filename": file_path.name,
        "path": rel_from_root,
        "title": title,
        "category": category,
        "tags": tags,
        "summary": summary,
        "headings": all_headings[:30],
        "content": indexed_content,
        "wordCount": word_count,
        "readingTime": reading_time,
        "sizeBytes": len(raw_bytes),
        "createdAt": created_at,
        "updatedAt": updated_at,
        "contentHash": content_hash,
    }


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def build_index(force: bool = False) -> dict[str, Any]:
    config = load_json(CONFIG_PATH, {})
    articles_dir_name = config.get("articlesDir", "articles")
    articles_root = ROOT_DIR / articles_dir_name
    articles_root.mkdir(parents=True, exist_ok=True)

    existing_index = load_json(INDEX_PATH, {})
    existing_map: dict[str, dict[str, Any]] = {}
    for item in existing_index.get("articles") or []:
        if item.get("path"):
            existing_map[item["path"]] = item
        if item.get("id"):
            existing_map[item["id"]] = item

    html_files = sorted(
        [
            p for p in articles_root.rglob("*")
            if p.is_file() and p.suffix.lower() in {".html", ".htm"}
        ],
        key=lambda p: p.relative_to(articles_root).as_posix().lower(),
    )

    articles: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for fp in html_files:
        record = parse_article_file(fp, articles_root, config, existing_map)
        base_id = record["id"]
        counter = 2
        while record["id"] in used_ids:
            record["id"] = f"{base_id}-{counter}"
            counter += 1
        used_ids.add(record["id"])
        articles.append(record)

    # Sort newest updated first, then title A-Z (mirrors assets/js/parser.js)
    articles.sort(key=lambda a: a.get("title", ""))
    articles.sort(key=lambda a: a.get("updatedAt", ""), reverse=True)

    cat_counts: dict[str, int] = {}
    tag_counts: dict[str, int] = {}
    for art in articles:
        cat = art["category"]
        cat_counts[cat] = cat_counts.get(cat, 0) + 1
        for tag in art["tags"]:
            tag_counts[tag] = tag_counts.get(tag, 0) + 1

    categories_summary = [
        {"name": name, "count": count}
        for name, count in sorted(cat_counts.items(), key=lambda x: (-x[1], x[0]))
    ]
    tags_summary = [
        {"name": name, "count": count}
        for name, count in sorted(tag_counts.items(), key=lambda x: (-x[1], x[0]))
    ]

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    new_payload = {
        "version": 1,
        "generatedAt": now_iso,
        "totalCount": len(articles),
        "categories": categories_summary,
        "tags": tags_summary,
        "articles": articles,
    }

    # Preserve generatedAt if articles/categories/tags are identical to avoid noisy git commits
    if not force and existing_index:
        old_comparable = {k: v for k, v in existing_index.items() if k != "generatedAt"}
        new_comparable = {k: v for k, v in new_payload.items() if k != "generatedAt"}
        if old_comparable == new_comparable:
            print(f"[build_index] Index unchanged ({len(articles)} articles).")
            return existing_index

    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(
        json.dumps(new_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"[build_index] Indexed {len(articles)} articles -> {INDEX_PATH.relative_to(ROOT_DIR)}")
    return new_payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Build AI Knowledge Hub search index.")
    parser.add_argument("--force", action="store_true", help="Rewrite index.json even if unchanged.")
    args = parser.parse_args()
    build_index(force=args.force)


if __name__ == "__main__":
    main()

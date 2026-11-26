/**
 * GitHub REST & Git Data API client for frontend upload, edit, delete, and atomic index updates.
 * Uses Fine-Grained Personal Access Token (Contents: Read & Write) stored strictly in user's browser.
 */

const API_BASE = "https://api.github.com";

export function encodeRepoPath(path) {
  return String(path || "")
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(String(str || ""));
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToUtf8(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Auto-detect GitHub owner & repo when hosted on *.github.io or configured in data/config.json.
 */
export function detectRepoFromContext(siteConfig) {
  const result = {
    owner: (siteConfig?.github?.owner || "").trim(),
    repo: (siteConfig?.github?.repo || "").trim(),
    branch: (siteConfig?.github?.branch || siteConfig?.defaultBranch || "main").trim(),
    articlesDir: (siteConfig?.articlesDir || "articles").trim(),
    detectedFromUrl: false,
  };

  try {
    const host = window.location.hostname.toLowerCase();
    if (host.endsWith(".github.io")) {
      const owner = host.slice(0, -".github.io".length);
      const pathParts = window.location.pathname.split("/").filter(Boolean);
      const repo = pathParts.length > 0 && !pathParts[0].includes(".")
        ? pathParts[0]
        : `${owner}.github.io`;
      result.owner = owner;
      result.repo = repo;
      result.detectedFromUrl = true;
    }
  } catch {
    // Ignore non-browser context
  }
  return result;
}

export function isConfigured(cfg) {
  return Boolean(cfg && cfg.owner && cfg.repo && cfg.token);
}

export function hasRepoInfo(cfg) {
  return Boolean(cfg && cfg.owner && cfg.repo);
}

async function githubFetch(cfg, endpoint, options = {}) {
  const headers = {
    Accept: options.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(options.headers || {}),
  };

  if (cfg?.token) {
    headers.Authorization = `Bearer ${cfg.token}`;
  }
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });

  if (!res.ok) {
    let apiMessage = "";
    try {
      const errJson = await res.json();
      apiMessage = errJson.message || "";
    } catch {
      apiMessage = res.statusText || "";
    }

    if (res.status === 401) {
      throw new Error("GitHub 认证失败（401）：Token 无效或已过期，请检查配置。");
    }
    if (res.status === 403) {
      throw new Error(
        `GitHub 权限不足（403）：${apiMessage || "请确认 Token 已授予该仓库 Contents 的 Read and write 权限"}`
      );
    }
    if (res.status === 404) {
      const err = new Error(`GitHub 资源未找到（404）：请检查 Owner、Repo、分支或路径是否正确。${apiMessage ? `(${apiMessage})` : ""}`);
      err.status = 404;
      throw err;
    }
    const err = new Error(`GitHub API 请求失败 (${res.status})：${apiMessage}`);
    err.status = res.status;
    throw err;
  }

  if (options.raw) {
    return res.text();
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Verify repo accessibility, branch existence, and write permission.
 */
export async function testConnection(cfg) {
  if (!cfg.owner || !cfg.repo) {
    throw new Error("请填写 GitHub 用户名（Owner）与仓库名（Repo）。");
  }
  if (!cfg.token) {
    throw new Error("请填写 GitHub Personal Access Token（PAT）。");
  }

  const repoInfo = await githubFetch(cfg, `/repos/${cfg.owner}/${cfg.repo}`);
  const branch = cfg.branch || repoInfo.default_branch || "main";
  let branchInfo;
  try {
    branchInfo = await githubFetch(
      cfg,
      `/repos/${cfg.owner}/${cfg.repo}/branches/${encodeURIComponent(branch)}`
    );
  } catch (err) {
    if (err.status === 404 && repoInfo.default_branch && repoInfo.default_branch !== branch) {
      throw new Error(
        `未找到分支 "${branch}"，该仓库的默认分支为 "${repoInfo.default_branch}"，请修改分支名称后重试。`
      );
    }
    throw err;
  }

  const canPush = Boolean(repoInfo.permissions?.push || repoInfo.permissions?.admin);
  return {
    fullName: repoInfo.full_name,
    private: Boolean(repoInfo.private),
    defaultBranch: repoInfo.default_branch,
    branch,
    latestSha: branchInfo.commit?.sha || "",
    canPush,
    htmlUrl: repoInfo.html_url,
  };
}

/**
 * Fetch raw UTF-8 text of any file directly from GitHub API (bypasses Pages CDN cache).
 */
export async function fetchRemoteRawFile(cfg, path) {
  const branch = cfg.branch || "main";
  const encoded = encodeRepoPath(path);
  return githubFetch(
    cfg,
    `/repos/${cfg.owner}/${cfg.repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`,
    { raw: true }
  );
}

/**
 * Fetch latest data/index.json from GitHub API. Returns null if not yet created.
 */
export async function fetchRemoteIndex(cfg) {
  try {
    const raw = await fetchRemoteRawFile(cfg, "data/index.json");
    return JSON.parse(raw);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Commit multiple file upserts & deletes in ONE atomic commit using the Git Data API.
 * upserts: Array<{ path: string, content: string }>
 * deletes: Array<string>
 */
export async function commitAtomicChanges(cfg, { upserts = [], deletes = [], message = "chore: update AI knowledge hub" }) {
  if (!isConfigured(cfg)) {
    throw new Error("请先在设置中配置 GitHub 仓库与 Token。");
  }
  const branch = cfg.branch || "main";
  const repoBase = `/repos/${cfg.owner}/${cfg.repo}`;

  async function attemptCommit() {
    // 1. Get HEAD ref commit SHA
    const refData = await githubFetch(cfg, `${repoBase}/git/ref/heads/${encodeURIComponent(branch)}`);
    const headCommitSha = refData.object.sha;

    // 2. Get base tree SHA from HEAD commit
    const commitData = await githubFetch(cfg, `${repoBase}/git/commits/${headCommitSha}`);
    const baseTreeSha = commitData.tree.sha;

    // 3. Create blobs for all upserted files (in parallel, bounded cleanly)
    const treeEntries = [];
    for (const file of upserts) {
      const blob = await githubFetch(cfg, `${repoBase}/git/blobs`, {
        method: "POST",
        body: {
          content: utf8ToBase64(file.content),
          encoding: "base64",
        },
      });
      treeEntries.push({
        path: file.path.replace(/^\/+/, ""),
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }

    // 4. Mark deleted files with sha: null
    for (const delPath of deletes) {
      treeEntries.push({
        path: delPath.replace(/^\/+/, ""),
        mode: "100644",
        type: "blob",
        sha: null,
      });
    }

    // 5. Create new tree
    const newTree = await githubFetch(cfg, `${repoBase}/git/trees`, {
      method: "POST",
      body: {
        base_tree: baseTreeSha,
        tree: treeEntries,
      },
    });

    // 6. Create new commit
    const newCommit = await githubFetch(cfg, `${repoBase}/git/commits`, {
      method: "POST",
      body: {
        message,
        tree: newTree.sha,
        parents: [headCommitSha],
      },
    });

    // 7. Fast-forward branch ref
    await githubFetch(cfg, `${repoBase}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH",
      body: {
        sha: newCommit.sha,
        force: false,
      },
    });

    return {
      commitSha: newCommit.sha,
      htmlUrl: `https://github.com/${cfg.owner}/${cfg.repo}/commit/${newCommit.sha}`,
    };
  }

  try {
    return await attemptCommit();
  } catch (err) {
    // Retry once if branch advanced concurrently
    if (err.status === 409 || err.status === 422) {
      return await attemptCommit();
    }
    throw err;
  }
}

/**
 * Full remote re-index: scans every HTML file under articlesDir via Git Trees API,
 * parses them with the shared parser, and commits fresh data/index.json.
 */
export async function rebuildRemoteIndex(cfg, siteConfig, parserFns, onProgress) {
  const branch = cfg.branch || "main";
  const repoBase = `/repos/${cfg.owner}/${cfg.repo}`;
  const articlesDir = (cfg.articlesDir || siteConfig?.articlesDir || "articles").replace(/^\/+|\/+$/g, "");
  const prefix = `${articlesDir}/`;

  onProgress?.("正在读取仓库文件树…");
  const treeRes = await githubFetch(
    cfg,
    `${repoBase}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  );

  const htmlBlobs = (treeRes.tree || []).filter(
    (item) =>
      item.type === "blob" &&
      item.path.startsWith(prefix) &&
      /\.html?$/i.test(item.path)
  );

  let existingIndex = null;
  try {
    existingIndex = await fetchRemoteIndex(cfg);
  } catch {
    existingIndex = null;
  }
  const prevByPath = new Map();
  for (const a of existingIndex?.articles || []) {
    if (a.path) prevByPath.set(a.path, a);
  }

  const parsedArticles = [];
  for (let i = 0; i < htmlBlobs.length; i++) {
    const item = htmlBlobs[i];
    onProgress?.(`正在解析 (${i + 1}/${htmlBlobs.length})：${item.path}`);
    const blob = await githubFetch(cfg, `${repoBase}/git/blobs/${item.sha}`);
    const htmlContent = base64ToUtf8(blob.content || "");
    const prev = prevByPath.get(item.path);
    const parsed = await parserFns.parseHtmlArticle(htmlContent, item.path, siteConfig, {
      createdAt: prev?.createdAt,
    });
    if (prev && prev.contentHash === parsed.contentHash && prev.updatedAt) {
      parsed.updatedAt = prev.updatedAt;
    }
    parsedArticles.push(parsed);
  }

  // Deduplicate IDs deterministically
  const usedIds = new Set();
  for (const art of parsedArticles) {
    const base = art.id;
    let n = 2;
    while (usedIds.has(art.id)) {
      art.id = `${base}-${n++}`;
    }
    usedIds.add(art.id);
  }

  const indexPayload = parserFns.buildIndexPayload(parsedArticles);
  const indexJson = JSON.stringify(indexPayload, null, 2) + "\n";

  onProgress?.("正在提交最新索引到 GitHub…");
  const commitResult = await commitAtomicChanges(cfg, {
    upserts: [{ path: "data/index.json", content: indexJson }],
    message: `chore(index): rebuild knowledge index (${parsedArticles.length} articles)`,
  });

  return { indexPayload, commitResult };
}

export function getGitHubFileUrl(cfg, path) {
  if (!cfg?.owner || !cfg?.repo || !path) return "";
  const branch = cfg.branch || "main";
  return `https://github.com/${cfg.owner}/${cfg.repo}/blob/${encodeURIComponent(branch)}/${encodeRepoPath(path)}`;
}

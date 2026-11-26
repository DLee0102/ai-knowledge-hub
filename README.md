# AI Knowledge Hub · Gemini AI 知识点 HTML 管理与全文检索平台

一个**零后端、零构建工具、原生支持 GitHub Pages 托管**的 AI 知识点管理网站，专为整理、展示和检索 Gemini 生成的独立 HTML 知识卡片而设计。

---

## 核心特性

1. **原汁原味展示独立 HTML**：每个 Gemini 生成的 HTML 文件在隔离的阅读器中完整呈现（保留自定义样式、交互式图表、JS 动画、数学公式与代码高亮），支持文档大纲跳转、页内关键词高亮定位、全屏阅读、下载与新窗口独立打开。
2. **双引擎自动索引（无需手写目录）**：
   - **前端自动解析**：通过网页上传或粘贴 HTML 源码时，自动提取标题、正文、章节目录、字数/阅读时长，并根据 `data/config.json` 规则自动归类与提取 AI 领域标签（即使原始 HTML 没有任何 `<meta>` 标签也能智能识别）。
   - **GitHub Actions 自动索引**：每次 `git push` 新增或修改 `articles/` 下的 HTML，工作流 `.github/workflows/deploy.yml` 会自动运行零依赖脚本 `scripts/build_index.py` 重建 `data/index.json` 并部署至 GitHub Pages。
3. **分类目录 + 多标签组合检索 + 中文/英文全文搜索**：
   - 支持侧边栏分类筛选、多标签 **OR（任意满足）/ AND（同时满足）** 组合筛选与标签速搜。
   - 支持标题、标签、章节、摘要与**全文正文/代码**加权检索、搜索片段 `<mark>` 上下文高亮，以及高级语法：`tag:LoRA`、`cat:核心架构`、`"KV Cache"`。
   - 点击搜索结果进入文章后，自动在阅读器内高亮命中位置并支持 `↑/↓` 快速跳转。
4. **网页前端直传保存、编辑与批量删除（单次原子提交）**：
   - 支持**拖拽上传（单文件/批量）**与**直接粘贴 Gemini 生成的 HTML 源码**，支持上传前实时预览、修改分类/标签并自动向 HTML `<head>` 注入 `<meta>` 信息。
   - 支持**单篇快捷删除**与**批量管理多选删除**（支持全选当前筛选结果、反选与删除清单二次核对），并兼容云端与本地暂存混合批量清理。
   - 使用 GitHub Git Data API 将新增/编辑/批量删除的 HTML 文件与更新后的 `data/index.json` 合并为**单次原子 Commit**，同时在本地 `IndexedDB` 建立实时预览/删除缓存——**无需等待 GitHub Pages 30~60 秒构建即可立即看到最新列表**。
   - 未配置 Token 时也可使用**本地暂存模式**离线体验，配置后支持一键批量同步至 GitHub。
5. **现代交互体验**：浅色/深色主题切换、卡片网格/紧凑列表视图、收藏夹、快捷键（`/` 或 `Ctrl+K` 搜索、`U` 上传、`Esc` 返回）。

---

## 目录结构

```text
ai-knowledge-hub/
├── index.html                        # 网站主入口（SPA）
├── 404.html                          # GitHub Pages 友好 404 页面
├── .nojekyll                         # 禁用 Jekyll，按原样托管静态资源
├── articles/                         # 存放所有 Gemini 生成的独立 HTML（支持子目录自动归类）
│   ├── transformer-self-attention.html
│   ├── rag-architecture-deep-dive.html
│   └── lora-fine-tuning-guide.html
├── data/
│   ├── config.json                   # 站点配置、分类关键词规则与 AI 标签词典（可自由定制）
│   └── index.json                    # 自动生成的元信息与全文搜索索引
├── assets/
│   ├── css/style.css                 # 响应式双主题样式表
│   └── js/                           # 零依赖原生 ES 模块
│       ├── app.js                    # 主控制器与路由
│       ├── parser.js                 # 前端 HTML 解析与 <meta> 注入
│       ├── search.js                 # 中英文全文检索与摘要高亮引擎
│       ├── github-api.js             # GitHub REST / Git Data API 原子提交客户端
│       ├── storage.js                # localStorage 与 IndexedDB 持久化
│       └── ui.js                     # UI 渲染与页内高亮/大纲导航
├── scripts/
│   └── build_index.py                # 零依赖 Python 3 自动索引脚本
└── .github/workflows/
    └── deploy.yml                    # GitHub Actions 自动索引 + Pages 部署流水线
```

---

## 快速部署到 GitHub Pages（3 分钟）

### 第 1 步：推送代码到 GitHub 仓库

在当前目录初始化 Git 并推送到你在 GitHub 新建的仓库（例如 `ai-knowledge-hub`）：

```bash
git init
git branch -M main
git add .
git commit -m "feat: initialize AI Knowledge Hub"
git remote add origin https://github.com/<你的用户名>/<你的仓库名>.git
git push -u origin main
```

### 第 2 步：开启 GitHub Pages（GitHub Actions 模式）

1. 打开仓库页面 → **Settings** → 左侧栏 **Pages**。
2. 在 **Build and deployment → Source** 下拉框中选择 **GitHub Actions**。
3. 前往仓库顶部 **Actions** 标签页，等待 `Auto-Index & Deploy GitHub Pages` 运行完成（约 30 秒），即可通过 `https://<你的用户名>.github.io/<你的仓库名>/` 访问你的 AI 知识库！

### 第 3 步：配置前端直接上传保存（Fine-Grained PAT）

1. 访问 GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**。
2. 配置最小权限（安全可控）：
   - **Repository access**：选择 **Only select repositories**，仅勾选你的知识库仓库。
   - **Repository permissions → Contents**：设置为 **Read and write**。
3. 生成 Token 后，打开已部署的网站，点击右上角 **GitHub 配置**：
   - 网站会自动识别 `*.github.io` 对应的 Owner 与 Repo。
   - 粘贴 Token，点击 **测试连接与写入权限**，通过后点击 **保存配置**。
4. 之后只需点击右上角 **上传 HTML**（或按快捷键 `U`），拖入 `.html` 文件或直接粘贴 Gemini 输出的源码，即可一键保存至 GitHub 仓库并自动发布！

> **安全说明**：你的 Personal Access Token 仅保存在你本人浏览器的 `localStorage` 中，只用于浏览器直连 `api.github.com`，不会写入代码仓库，也不会发送到任何第三方服务器。

---

## 本地开发与预览

本站点完全无需 Node.js 编译，使用任意静态 HTTP 服务器即可在本地运行（注意：由于使用了 ES Modules，请通过 HTTP 访问而非直接双击 `file://` 打开）：

```bash
# 1. 如果手动向 articles/ 添加了新的 HTML，可先更新索引
python scripts/build_index.py

# 2. 启动本地预览服务
python -m http.server 8000
```

然后浏览器打开 `http://localhost:8000` 即可体验完整功能（含全文检索、标签筛选、本地暂存上传等）。

---

## 小技巧：自定义分类与 Gemini 提示词

- **按子目录自动归类**：你也可以把 HTML 放进 `articles/强化学习/ppo.html`，未显式声明分类时会自动使用子目录名 `强化学习` 作为分类。
- **自定义分类规则与标签词典**：编辑 `data/config.json` 中的 `categories`（支持自定义分类名、主题色与匹配关键词）和 `tagDictionary`，前端解析器与 `scripts/build_index.py` 会共同读取这份配置。
- **让 Gemini 直接输出规范 `<meta>`（可选）**：生成知识页时可附带以下一句提示词（不加也能由本平台自动识别）：

```text
请生成一个单文件、美观且带交互演示的 HTML 页面讲解【知识点名称】，并在 <head> 中加入：
<meta name="ai-category" content="核心架构">
<meta name="ai-tags" content="Transformer, Self-Attention, LLM">
<meta name="description" content="100字以内核心摘要">
```

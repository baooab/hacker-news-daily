# hacker-news-daily

使用 [Hacker News 官方 API](https://github.com/HackerNews/API) 获取首页热门条目（与 [news.ycombinator.com](https://news.ycombinator.com/) 热门榜同源），并调用 [DeepSeek](https://www.deepseek.com/) 为每条内容生成中文：**标题**、**摘要**、**评论要点**。

## 环境要求

- **Node.js 18+**（需内置 `fetch` 与 `AbortSignal.timeout`）

## 安装

```bash
git clone <本仓库地址>
cd hacker-news-daily
npm install
```

## 配置

1. 在 [DeepSeek 开放平台](https://platform.deepseek.com/) 创建 API Key。
2. 复制环境变量示例并填入密钥：

```bash
cp .env.example .env
```

编辑 `.env`：

```env
DEEPSEEK_API_KEY=sk-你的密钥
```

可选：通过环境变量指定模型（默认 `deepseek-chat`）：

```env
DEEPSEEK_MODEL=deepseek-chat
```

## 使用

```bash
npm start
```

或直接：

```bash
node hn_deepseek.js
```

### 网页浏览 `hn-snapshot.json`

仓库根目录提供静态页 **`index.html`**（`viewer.css` / `viewer.js`），在视觉与布局上对齐 [Hacker News](https://news.ycombinator.com/)：橙色顶栏、`#f6f6ef` 背景、Verdana、表格列表与灰色 meta 行。请先运行抓取生成 **`hn-snapshot.json`**，再启动本地静态服务（浏览器不允许 `file://` 直接请求本地 JSON）：

```bash
npm run serve
```

在浏览器打开终端提示的地址（一般为 `http://localhost:8080`），进入 **`/index.html`** 即可查看条目与 **DeepSeek 中文摘要**（若 JSON 中含 `deepseek` 字段）。顶栏 **存档** 下拉仅含**最近 30 天**；更早日期请打开 **`/archives.html`**（或首页「全部存档」）。也可使用 `/index.html#YYYY-MM-DD` / `/archives.html#YYYY-MM-DD`（超出 30 天时首页会跳到全部存档页）。

每次运行脚本除写入 `hn-snapshot.json` 外，还会按**北京时间**写入 `archives/YYYY-MM-DD.json`，并更新 `archives/index.json`。同日重复运行会覆盖当天存档。

## GitHub Actions 与 GitHub Pages

仓库含工作流 [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)，会：

- **定时**：每日 **北京时间 06:00**（UTC 22:00，cron `0 22 * * *`；若需按 UTC 午夜跑，可改为 `0 0 * * *`）执行 `node hn_deepseek.js -o site/hn-snapshot.json`，并把静态页、最新快照与 **`archives/` 历史存档** 一并部署到 **GitHub Pages**（部署前会尝试从已上线站点拉回旧存档，避免被覆盖）。
- **手动**：在仓库 **Actions** 中选择 **Deploy to GitHub Pages**，点击 **Run workflow**。
- **推送**：向默认分支 **`main`** 推送并修改工作流所列路径（脚本、静态页、`package.json` 等）时也会触发构建（便于联调）。

**一次性设置：**

1. 在仓库 **Settings → Secrets and variables → Actions** 中新建 **`DEEPSEEK_API_KEY`**（与本地 `.env` 中密钥相同）。
2. 在 **Settings → Pages → Build and deployment** 中，将 **Source** 设为 **GitHub Actions**（不要用 branch / `docs` 分支作为来源）。
3. 首次部署成功后，站点地址一般为 **`https://<你的用户名>.github.io/<仓库名>/`**（以 Settings → Pages 中显示为准）。

若默认分支不是 `main`，请在工作流文件的 `push.branches` 中改成你的分支名。

- **标准输出（stdout）**：无总结正文（避免与 JSON 重复）；如需只看进度，可忽略 stdout。
- **标准错误（stderr）**：执行过程日志（阶段划分、每条帖子的 id/标题、评论抓取统计、DeepSeek 耗时与 token 用量等）。

### 命令行参数

| 参数 | 说明 | 默认 |
|------|------|------|
| **位置参数 `N`** | 抓取热门榜前 **N** 条（正整数）；与 `-n` 同时出现时 **以位置参数为准** | — |
| `-n`, `--top` | 同上 | `12`；可用环境变量 **`HN_TOP_N`** 覆盖「未写 `-n`、也未写位置参数」时的默认 |
| `-c`, `--comments` | 每条帖子最多抓取 **顶层** 评论条数 | `12` |
| `--model` | DeepSeek 模型名；未指定时可用环境变量 `DEEPSEEK_MODEL` | `deepseek-chat` |
| `-v`, `--verbose` | 打印每条顶层评论的请求细节（更冗长） | 关闭 |
| `-o`, `--output` | Hacker News 快照写入的 **JSON 文件路径**（UTF-8） | `hn-snapshot.json` |
| `-h`, `--help` | 打印用法说明 | — |

环境变量 `HN_JSON_OUT` 可覆盖默认 JSON 路径（与 `-o` 等价，命令行优先）。

**外链正文（文章摘要）**：默认在总结每条帖子前会 **HTTP 请求 `story.url`**，用 [Readability](https://github.com/mozilla/readability) 解析 HTML 正文并写入提示（约 1.2 万字上限）。失败站点将回退为标题+评论。设置 **`HN_SKIP_ARTICLE_FETCH=1`** 可关闭该步骤以加快速度或避免对外站请求。

示例：

```bash
node hn_deepseek.js 20
node hn_deepseek.js -n 20 -c 8
HN_TOP_N=15 node hn_deepseek.js
node hn_deepseek.js --help
```

需要更细的评论拉取日志时：

```bash
node hn_deepseek.js -v
```

### 本地 JSON 快照（HN + DeepSeek）

脚本顺序为：先拉取 Hacker News，再逐条调用 DeepSeek；**全部完成后**一次性写入 JSON（默认 `./hn-snapshot.json`）。总结**不会**打印到控制台，只写入文件。缩进 2 空格，便于阅读与二次处理。

- **`meta`**
  - `hnFetchedAt`：HN 拉取阶段结束时间（ISO 8601）
  - `deepseekCompletedAt`：DeepSeek 全部完成并写文件时间
  - `deepseekModel`：使用的模型名
  - `hnApiBase`、`topN`、`topCommentsLimit`、`topStoryIds`
  - `fetchedAt`：与 `deepseekCompletedAt` 相同，兼容旧字段命名

- **`stories`**：按热门顺序；每项含：
  - `rank`、`item`（HN API 完整帖子对象）、`comments`（顶层评论 `id` / `by` / `text`）
  - **`deepseek`**：每条的中文总结（**纯 JSON**，不向本地写入 Markdown）
    - `titleZh`：中文标题
    - `articleSummary`：**文章摘要**，与外链/正文主题相关，**单段**文字、不分条，脚本侧再截断至约 **250 字**
    - `commentSummary`：**评论摘要**，概括讨论区，**单段**文字、不分条，约 **250 字**
    - `articleBodyChars`：本次送入模型的「外链正文」字符数（抓取成功则大于 0；失败或未启用抓取时为 0）
    - 旧版字段 `abstract`、`commentPoints` 仍可在网页中兼容显示；新生成快照以 `articleSummary` / `commentSummary` 为准
    - `model`、`generatedAt`；失败时 `error` 为字符串，摘要字段为空字符串

指定输出路径：

```bash
node hn_deepseek.js -o data/hn-top.json
```

## 工作原理与说明

- **数据来源**：`https://hacker-news.firebaseio.com/v0/topstories.json` 与 `item/{id}.json`，不解析首页 HTML。
- **输入给模型的内容**：标题、外链 URL；若有外链则**尝试请求 URL** 并用 Readability 提取正文（约 1.2 万字上限）；另有 HN 站内 `text`（Ask/Show 等）与顶层评论（经简单去 HTML）。部分站点会反爬、超时或非 UTF-8，正文可能为空，此时文章摘要仍依赖标题与评论。
- **请求节奏**：对 HN 与 DeepSeek 的调用带有短暂间隔，以降低突发请求压力。
- **HN API 连接超时**：Node 内置 `fetch` 使用 Undici，**默认连接超时约 10 秒**，弱网或 IPv6 路由不佳时易出现 `ConnectTimeoutError`。脚本已改用 **`undici` 的 Agent** 将连接/读体超时拉长（默认约 60s / 120s），并对 `topstories`/`item` 请求做有限次重试；可通过 `HN_CONNECT_TIMEOUT_MS`、`HN_BODY_TIMEOUT_MS`、`HN_FETCH_RETRIES` 调整（见 `.env.example`）。

## 许可证

若需开源许可证，请在仓库中自行添加 `LICENSE` 文件。

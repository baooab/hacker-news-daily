/**
 * 抓取 Hacker News 首页 Top N 条目，并用 DeepSeek 总结标题、摘要与评论要点。
 * 数据来自官方 API: https://github.com/HackerNews/API
 *
 * 进度与诊断信息输出到 stderr；DeepSeek 总结写入 JSON（默认 hn-snapshot.json），不输出到 stdout。
 */

import "dotenv/config";
import { Readability } from "@mozilla/readability";
import { writeFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Agent, fetch as undiciFetch } from "undici";
import OpenAI from "openai";

const HN_BASE = "https://hacker-news.firebaseio.com/v0";
const DEEPSEEK_BASE = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_JSON_OUT = "hn-snapshot.json";
/** 热门榜取前几条：可用环境变量 HN_TOP_N 覆盖默认 12 */
const DEFAULT_TOP_STORIES = "12";
const MAX_COMMENT_CHARS = 1200;
/** 文章摘要、评论摘要各自建议上限（汉字/字符） */
const SUMMARY_MAX_CHARS = 250;
/** 外链 HTML 最大体积（字节） */
const MAX_ARTICLE_HTML_BYTES = 2_000_000;
/** 送入模型的正文最大字符数（UTF-16 计） */
const MAX_ARTICLE_TEXT_CHARS = 12_000;
/** 请求 story.url 的超时（毫秒）；可用环境变量覆盖 */
const ARTICLE_FETCH_TIMEOUT_MS = (() => {
  const v = Number(process.env.ARTICLE_FETCH_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 25_000;
})();
/** Node fetch 底层 Undici 默认连接超时仅 10s，易在弱网下超时；用 Agent 拉长并支持重试 */
const HN_CONNECT_TIMEOUT_MS = (() => {
  const v = Number(process.env.HN_CONNECT_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 60_000;
})();
const HN_BODY_TIMEOUT_MS = (() => {
  const v = Number(process.env.HN_BODY_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 120_000;
})();
const HN_FETCH_RETRIES = (() => {
  const v = Number(process.env.HN_FETCH_RETRIES);
  const n = Number.isFinite(v) && v > 0 ? Math.floor(v) : 3;
  return Math.min(8, Math.max(1, n));
})();

const remoteAgent = new Agent({
  connectTimeout: HN_CONNECT_TIMEOUT_MS,
  headersTimeout: HN_BODY_TIMEOUT_MS,
  bodyTimeout: HN_BODY_TIMEOUT_MS,
});

const ARTICLE_UA =
  "Mozilla/5.0 (compatible; hacker-news-daily/1.0; +https://news.ycombinator.com/)";

function defaultTopFromEnv() {
  const v = (process.env.HN_TOP_N || "").trim();
  return v && /^\d+$/.test(v) ? v : DEFAULT_TOP_STORIES;
}

function printHelp() {
  console.error(`
用法: node hn_deepseek.js [选项] [N]

  N                     抓取热门榜前几条（正整数）；若同时写了 -n/--top，以命令行为准

选项:
  -n, --top <数>        同上；未指定时默认 ${DEFAULT_TOP_STORIES}，也可用环境变量 HN_TOP_N 作为默认值
  -c, --comments <数>   每条帖子最多抓取顶层评论条数，默认 12
  -o, --output <路径>   输出 JSON 路径，默认 hn-snapshot.json（或环境变量 HN_JSON_OUT）
      --model <名>      DeepSeek 模型，默认 deepseek-chat（或 DEEPSEEK_MODEL）
  -v, --verbose         打印每条顶层评论请求细节
  -h, --help            显示本说明

示例:
  node hn_deepseek.js 20
  node hn_deepseek.js -n 30 -c 8 -o out/snapshot.json
  HN_TOP_N=15 node hn_deepseek.js

环境变量:
  HN_SKIP_ARTICLE_FETCH=1   不请求 story.url，仅用 HN 数据做摘要（更快，无外链正文）
  HN_CONNECT_TIMEOUT_MS     连接 HN API 的超时（默认 60000）
  HN_BODY_TIMEOUT_MS        读响应体超时（默认 120000）
  HN_FETCH_RETRIES          拉取 HN 失败时的重试次数（默认 3，最大 8）
`.trim());
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {boolean} verbose */
function createLogger(verbose) {
  const ts = () => new Date().toISOString().slice(11, 23);
  return {
    /** @param {...unknown} args */
    info(...args) {
      console.error(`[${ts()}]`, ...args);
    },
    /** @param {...unknown} args */
    verbose(...args) {
      if (verbose) console.error(`[${ts()}]`, ...args);
    },
  };
}

async function fetchJson(path) {
  const url = `${HN_BASE}/${path}`;
  const ts = () => new Date().toISOString().slice(11, 23);
  /** @type {unknown} */
  let lastErr;
  for (let attempt = 0; attempt < HN_FETCH_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        await sleep(600 * attempt);
        console.error(
          `[${ts()}] HN API 重试 ${attempt}/${HN_FETCH_RETRIES - 1} ${path} …`
        );
      }
      const res = await undiciFetch(url, {
        dispatcher: remoteAgent,
        signal: AbortSignal.timeout(HN_BODY_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HN ${res.status} ${path}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function fetchItem(itemId) {
  return fetchJson(`item/${itemId}.json`);
}

/**
 * 请求 story.url，用 Readability 解析正文（供文章摘要）。
 * 失败或非 HTML 时返回空字符串。
 * @param {string} url
 * @param {{ verbose: Function }} log
 */
async function fetchArticlePlainText(url, log) {
  if (!url || typeof url !== "string") return "";
  let href;
  try {
    href = new URL(url);
  } catch {
    return "";
  }
  if (href.protocol !== "http:" && href.protocol !== "https:") return "";

  try {
    const res = await undiciFetch(href.toString(), {
      dispatcher: remoteAgent,
      headers: {
        "User-Agent": ARTICLE_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(ARTICLE_FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) {
      log.verbose(`  │  外链 HTTP ${res.status}`);
      return "";
    }
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) {
      log.verbose(`  │  外链非 HTML（${ct.slice(0, 60)}）`);
      return "";
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_ARTICLE_HTML_BYTES) {
      log.verbose(`  │  外链 HTML 超过 ${MAX_ARTICLE_HTML_BYTES} 字节，跳过`);
      return "";
    }
    const html = new TextDecoder("utf-8").decode(ab);
    const dom = new JSDOM(html, { url: href.toString() });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    let raw = "";
    if (article?.textContent) {
      raw = article.textContent;
    } else if (article?.content) {
      const inner = new JSDOM(article.content);
      raw = inner.window.document.body.textContent || "";
    }
    if (!raw) {
      log.verbose(`  │  Readability 未得到正文`);
      return "";
    }
    let text = raw.replace(/\s+/g, " ").trim();
    if (text.length > MAX_ARTICLE_TEXT_CHARS) {
      text = text.slice(0, MAX_ARTICLE_TEXT_CHARS) + "…";
    }
    return text;
  } catch (e) {
    log.verbose(`  │  外链抓取失败:`, e);
    return "";
  }
}

function stripCommentHtml(html) {
  let t = String(html || "")
    .replaceAll("<p>", "\n")
    .replaceAll("</p>", "");
  for (const tag of ["<i>", "</i>", "<pre>", "</pre>", "<code>", "</code>"]) {
    t = t.replaceAll(tag, "");
  }
  return t.trim();
}

/**
 * @typedef {{ id: number, by?: string, text: string }} PreparedComment
 */

/**
 * @param {Record<string, unknown>} story
 * @param {number} maxTopLevel
 * @param {number} maxCharsPerComment
 * @param {{ info: Function, verbose: Function }} log
 * @returns {Promise<PreparedComment[]>}
 */
async function collectTopCommentBodies(
  story,
  maxTopLevel,
  maxCharsPerComment,
  log
) {
  const kids = story.kids || [];
  const slice = kids.slice(0, maxTopLevel);
  /** @type {PreparedComment[]} */
  const out = [];
  let skipped = 0;
  for (let j = 0; j < slice.length; j++) {
    const cid = slice[j];
    log.verbose(`  ├─ 顶层评论 ${j + 1}/${slice.length} · id=${cid}`);
    try {
      const c = await fetchItem(Number(cid));
      if (c.deleted || c.dead) {
        skipped++;
        log.verbose(`  │  (已跳过: deleted/dead)`);
        continue;
      }
      let t = stripCommentHtml(c.text || "");
      if (!t) {
        skipped++;
        log.verbose(`  │  (已跳过: 无正文)`);
        continue;
      }
      if (t.length > maxCharsPerComment) t = t.slice(0, maxCharsPerComment) + "…";
      const id = Number(c.id);
      const by = typeof c.by === "string" ? c.by : undefined;
      out.push({ id, by, text: t });
    } catch (e) {
      skipped++;
      log.verbose(`  │  (请求失败: ${e})`);
    }
    await sleep(50);
  }
  log.info(
    `  └─ 顶层评论: 有效 ${out.length} 条 · 跳过/失败 ${skipped} · 计划抓取 ${slice.length} 条`
  );
  return out;
}

/**
 * @param {Record<string, unknown>} story
 * @param {PreparedComment[]} comments
 * @param {string} [articleFromUrl] 由 story.url 抓取并 Readability 解析后的纯文本
 * @param {boolean} [articleFetchSkipped] 为 true 时表示未请求外链（如 HN_SKIP_ARTICLE_FETCH）
 */
function buildStoryBlock(story, comments, articleFromUrl = "", articleFetchSkipped = false) {
  const title = story.title || "";
  const url = story.url || "";
  const selfText = String(story.text || "").trim();
  const meta = {
    score: story.score,
    by: story.by,
    descendants: story.descendants,
  };
  const parts = [
    `标题: ${title}`,
    url ? `链接: ${url}` : "链接: (无，可能为 Ask HN / 讨论帖)",
    `元信息: ${JSON.stringify(meta)}`,
  ];
  if (articleFromUrl && articleFromUrl.trim()) {
    parts.push(
      `外链正文（已由脚本请求 URL 并解析，供「文章摘要」优先使用；过长已截断至约 ${MAX_ARTICLE_TEXT_CHARS} 字）:\n${articleFromUrl.trim()}`
    );
  } else if (url) {
    if (articleFetchSkipped) {
      parts.push(
        "外链正文: (未请求 URL；已设置 HN_SKIP_ARTICLE_FETCH 时关闭自动抓取，文章摘要仅依据标题与下方材料)"
      );
    } else {
      parts.push(
        "外链正文: (未能抓取或解析为非 HTML/超时/体积过大等，文章摘要将结合标题与下方材料)"
      );
    }
  }
  if (selfText) {
    let st = selfText.replaceAll("<p>", "\n").replaceAll("</p>", "");
    if (st.length > 4000) st = st.slice(0, 4000) + "…";
    parts.push(`HN 站内正文/说明（Ask/Show 等）:\n${st}`);
  }
  if (comments.length) {
    const joined = comments.map((c) => c.text).join("\n---\n");
    parts.push("高赞/靠前评论摘录:\n" + joined);
  } else {
    parts.push("评论: (暂无或未抓取到)");
  }
  return parts.join("\n");
}

/**
 * 单段文字：去换行、去分条符号，合并为一段。
 * @param {string} s
 */
function paragraphizeOne(s) {
  return String(s || "")
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map((line) =>
      line
        .replace(/^\s*[-*•]\s+/, "")
        .replace(/^\s*\d+[.)]\s+/, "")
        .trim()
    )
    .filter(Boolean)
    .join("");
}

/**
 * 截断到最多 max 个字符（对中文按字计）。
 * @param {string} s
 * @param {number} max
 */
function clampSummary(s, max) {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

/**
 * 将模型解析结果统一为 titleZh + articleSummary + commentSummary，并做字数限制。
 * @param {Record<string, unknown>} o
 */
function normalizeDeepseekFields(o) {
  const titleZh = String(o.titleZh ?? "").trim();
  let article = String(
    o.articleSummary ?? o.abstract ?? ""
  ).trim();
  let comment = String(o.commentSummary ?? "").trim();
  if (!comment && Array.isArray(o.commentPoints)) {
    comment = o.commentPoints
      .map((x) => String(x).trim())
      .filter(Boolean)
      .join("；");
  }
  if (!comment && typeof o.commentPoints === "string") {
    comment = o.commentPoints.trim();
  }
  article = paragraphizeOne(article);
  comment = paragraphizeOne(comment);
  return {
    titleZh,
    articleSummary: clampSummary(article, SUMMARY_MAX_CHARS),
    commentSummary: clampSummary(comment, SUMMARY_MAX_CHARS),
  };
}

/**
 * 解析模型返回的 JSON 文本（可带 ```json 围栏）。
 * @param {string} text
 */
function parseDeepseekJsonResponse(text) {
  let t = String(text || "").trim();
  const fence = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/im;
  const m = t.match(fence);
  if (m) t = m[1].trim();
  const obj = JSON.parse(t);
  if (obj === null || typeof obj !== "object") {
    throw new Error("模型输出不是 JSON 对象");
  }
  /** @type {Record<string, unknown>} */
  const o = obj;
  return normalizeDeepseekFields(o);
}

/**
 * 兼容旧版 Markdown 分段输出（仅作解析回退）。
 * @param {string} md
 */
function parseDeepseekMarkdownFallback(md) {
  const text = String(md || "").trim();
  /** @param {string} label */
  const take = (label) => {
    const re = new RegExp(
      `^##\\s*${label}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
      "m"
    );
    const x = text.match(re);
    return x ? x[1].trim() : "";
  };
  const titleZh = take("标题");
  const article =
    take("文章摘要") || take("摘要");
  const comment =
    take("评论摘要") || take("评论要点");
  return normalizeDeepseekFields({
    titleZh,
    articleSummary: article,
    commentSummary: comment,
  });
}

/**
 * 优先解析 JSON；失败则尝试 Markdown 分段。
 * @param {string} text
 */
function parseDeepseekOutput(text) {
  try {
    return parseDeepseekJsonResponse(text);
  } catch {
    return parseDeepseekMarkdownFallback(text);
  }
}

/**
 * @param {string} outputPath
 * @param {{
 *   topN: number,
 *   topComments: number,
 *   topStoryIds: number[],
 *   hnFetchedAt: string,
 *   deepseekCompletedAt: string,
 *   deepseekModel: string,
 *   stories: Array<{
 *     rank: number,
 *     item: Record<string, unknown>,
 *     comments: PreparedComment[],
 *     deepseek: Record<string, unknown>,
 *   }>
 * }} data
 * @param {{ info: Function }} log
 */
async function saveHnJson(outputPath, data, log) {
  const abs = resolve(outputPath);
  const doc = {
    meta: {
      hnFetchedAt: data.hnFetchedAt,
      deepseekCompletedAt: data.deepseekCompletedAt,
      deepseekModel: data.deepseekModel,
      hnApiBase: HN_BASE,
      topN: data.topN,
      topCommentsLimit: data.topComments,
      topStoryIds: data.topStoryIds,
      fetchedAt: data.deepseekCompletedAt,
    },
    stories: data.stories,
  };
  await writeFile(abs, JSON.stringify(doc, null, 2), "utf8");
  log.info(`已保存完整快照（HN + DeepSeek）至 JSON: ${abs}`);
}

/**
 * @param {import('openai').OpenAI} client
 * @param {string} model
 * @param {string} storyBlock
 * @param {number} index
 * @param {{ info: Function }} log
 */
async function summarizeWithDeepseek(client, model, storyBlock, index, log) {
  const system =
    "你是资深科技编辑，读者为中文技术从业者。" +
    "请根据用户提供的 Hacker News 材料，只输出一个 JSON 对象，键为 titleZh、articleSummary、commentSummary。" +
    "不要输出 Markdown、不要代码围栏、不要多余说明文字。" +
    "articleSummary 只写与文章/外链主题相关的概括；commentSummary 只写讨论区观点的概括；两者必须区分，不可混成一段。" +
    "若材料中出现「外链正文（已由脚本请求 URL 并解析）」段落，articleSummary 必须优先依据该正文归纳；无该段时再依据 HN 站内正文或标题与评论。" +
    "两段摘要均须为一段连续文字，不要使用列表、不要分条、不要使用换行分段。" +
    `每段摘要长度控制在 ${SUMMARY_MAX_CHARS} 个汉字以内（含标点）。` +
    "若仅有标题与评论、没有正文或无法访问原文，文章摘要中须说明依据有限；评论摘要可依据评论归纳。";

  const user = `
这是第 ${index} 条新闻的材料：

${storyBlock}

请只输出一个 JSON 对象（字符串使用双引号），结构如下：
{
  "titleZh": "中文标题，可微调以更清晰",
  "articleSummary": "一段连续文字：概括文章/外链要点（材料中有外链正文时优先用该正文）；不分条、不换行分段；${SUMMARY_MAX_CHARS} 字以内",
  "commentSummary": "一段连续文字：概括评论区讨论焦点与态度；不分条、不换行分段；${SUMMARY_MAX_CHARS} 字以内"
}
若无有效评论可写，commentSummary 可为「暂无有效评论」等简短一句（仍是一段话，不要列表）。
`.trim();

  const t0 = Date.now();
  const baseReq = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.3,
  };
  let resp;
  try {
    resp = await client.chat.completions.create({
      ...baseReq,
      response_format: { type: "json_object" },
    });
  } catch (e) {
    log.verbose("  └─ JSON mode 不可用或请求失败，改用普通补全并重试 …", e);
    resp = await client.chat.completions.create(baseReq);
  }
  const ms = Date.now() - t0;
  const choice = resp.choices[0];
  const text = (choice.message.content || "").trim();
  const u = resp.usage;
  if (u) {
    log.info(
      `  └─ DeepSeek 完成 · ${ms}ms · tokens: prompt=${u.prompt_tokens ?? "?"} completion=${u.completion_tokens ?? "?"} total=${u.total_tokens ?? "?"}`
    );
  } else {
    log.info(`  └─ DeepSeek 完成 · ${ms}ms`);
  }
  return text;
}

/**
 * @param {{ topN: number, topComments: number, model: string, verbose: boolean, outputJson: string }} opts
 */
async function run({ topN, topComments, model, verbose, outputJson }) {
  const log = createLogger(verbose);
  const skipArticleFetch = ["1", "true", "yes"].includes(
    (process.env.HN_SKIP_ARTICLE_FETCH || "").trim().toLowerCase()
  );

  const apiKey = (process.env.DEEPSEEK_API_KEY || "").trim();
  if (!apiKey) {
    console.error(
      "请设置环境变量 DEEPSEEK_API_KEY（可复制 .env.example 为 .env 并填写）。"
    );
    process.exitCode = 1;
    return;
  }

  log.info("════════ 配置 ════════");
  log.info(`  抓取条数: ${topN} · 顶层评论上限/条: ${topComments} · 模型: ${model}`);
  log.info(`  HN API: ${HN_BASE}`);
  log.info(`  DeepSeek: ${DEEPSEEK_BASE}（密钥已通过环境变量注入，不在此打印）`);
  log.info(`  详细日志: ${verbose ? "开启 (-v)" : "关闭（可加 -v 查看每条评论请求）"}`);
  log.info(`  JSON 输出: ${outputJson}`);
  log.info(
    `  HN 网络: connectTimeout=${HN_CONNECT_TIMEOUT_MS}ms · bodyTimeout=${HN_BODY_TIMEOUT_MS}ms · 失败重试 ${HN_FETCH_RETRIES} 次`
  );
  log.info(
    `  外链正文抓取: ${skipArticleFetch ? "关闭（HN_SKIP_ARTICLE_FETCH）" : "开启（请求 story.url + Readability）"}`
  );

  const ds = new OpenAI({
    apiKey,
    baseURL: DEEPSEEK_BASE,
  });

  log.info("════════ 阶段 1/2：拉取 Hacker News ════════");

  const tFetch0 = Date.now();
  log.info("请求 topstories.json …");
  const idsRaw = await fetchJson("topstories.json");
  if (!Array.isArray(idsRaw)) {
    console.error("无法解析 topstories");
    process.exitCode = 1;
    return;
  }
  const pick = idsRaw.slice(0, topN).map((x) => Number(x));
  log.info(
    `热门榜共 ${idsRaw.length} 条 id，取前 ${topN} 条 → [${pick.join(", ")}]`
  );

  /** @type {Array<{ story: Record<string, unknown>, comments: PreparedComment[] }>} */
  const storiesPayload = [];
  for (let i = 0; i < pick.length; i++) {
    const sid = pick[i];
    const num = i + 1;
    log.info(`[${num}/${pick.length}] 帖子 item id=${sid} …`);
    const st = await fetchItem(sid);
    const title = String(st.title || "(无标题)").slice(0, 100);
    log.info(`  ├─ ${title}${String(st.title || "").length > 100 ? "…" : ""}`);
    log.info(
      `  ├─ score=${st.score ?? "?"} by=${st.by ?? "?"} descendants=${st.descendants ?? "?"}`
    );
    const comments = await collectTopCommentBodies(
      st,
      topComments,
      MAX_COMMENT_CHARS,
      log
    );
    storiesPayload.push({ story: st, comments });
    await sleep(50);
  }
  log.info(
    `阶段 1 结束 · 已拉取 ${storiesPayload.length} 条帖子 · 耗时 ${Date.now() - tFetch0}ms`
  );

  const hnFetchedAt = new Date().toISOString();

  log.info("════════ 阶段 2/2：调用 DeepSeek 生成中文总结（结果写入 JSON）════════");

  /** @type {Array<{ rank: number, item: Record<string, unknown>, comments: PreparedComment[], deepseek: Record<string, unknown> }>} */
  const storiesForJson = [];

  for (let i = 0; i < storiesPayload.length; i++) {
    const { story, comments } = storiesPayload[i];
    const idx = i + 1;
    const titleShort = String(story.title || "").slice(0, 80);

    let articleFromUrl = "";
    if (!skipArticleFetch && story.url) {
      log.info(`[总结 ${idx}/${storiesPayload.length}] 外链正文 …`);
      log.info(`  ├─ ${titleShort}${String(story.title || "").length > 80 ? "…" : ""}`);
      log.info(`  ├─ GET ${String(story.url).slice(0, 120)}${String(story.url).length > 120 ? "…" : ""}`);
      articleFromUrl = await fetchArticlePlainText(String(story.url), log);
      if (articleFromUrl) {
        log.info(
          `  └─ 已解析正文 ${articleFromUrl.length} 字（送模型上限约 ${MAX_ARTICLE_TEXT_CHARS}）`
        );
      } else {
        log.info(`  └─ 未获得正文（非 HTML、超时、反爬或解析失败等）`);
      }
      await sleep(150);
    }

    const block = buildStoryBlock(story, comments, articleFromUrl, skipArticleFetch);

    log.info(`[总结 ${idx}/${storiesPayload.length}] DeepSeek 请求中 …`);
    log.info(`  ├─ ${titleShort}${String(story.title || "").length > 80 ? "…" : ""}`);
    /** @type {Record<string, unknown>} */
    let deepseek;
    try {
      const raw = await summarizeWithDeepseek(ds, model, block, idx, log);
      const parsed = parseDeepseekOutput(raw);
      deepseek = {
        model,
        generatedAt: new Date().toISOString(),
        titleZh: parsed.titleZh,
        articleSummary: parsed.articleSummary,
        commentSummary: parsed.commentSummary,
        articleBodyChars: articleFromUrl.length,
        error: null,
      };
    } catch (e) {
      log.info(`  └─ 调用失败:`, e);
      deepseek = {
        model,
        generatedAt: new Date().toISOString(),
        titleZh: "",
        articleSummary: "",
        commentSummary: "",
        articleBodyChars: articleFromUrl.length,
        error: String(e),
      };
    }
    storiesForJson.push({
      rank: idx,
      item: story,
      comments,
      deepseek,
    });
  }

  const deepseekCompletedAt = new Date().toISOString();

  try {
    await saveHnJson(
      outputJson,
      {
        topN,
        topComments,
        topStoryIds: pick,
        hnFetchedAt,
        deepseekCompletedAt,
        deepseekModel: model,
        stories: storiesForJson,
      },
      log
    );
  } catch (e) {
    log.info("写入 JSON 失败:", e);
    process.exitCode = 1;
    return;
  }

  log.info("════════ 全部完成（总结已写入 JSON，未输出到 stdout）════════");
}

function main() {
  const { values, positionals } = parseArgs({
    options: {
      top: { type: "string", short: "n", default: defaultTopFromEnv() },
      comments: { type: "string", short: "c", default: "12" },
      model: {
        type: "string",
        default: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
      },
      verbose: { type: "boolean", short: "v", default: false },
      output: {
        type: "string",
        short: "o",
        default: process.env.HN_JSON_OUT || DEFAULT_JSON_OUT,
      },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
    return;
  }

  const defTop = defaultTopFromEnv();
  let topN = Math.max(1, parseInt(values.top || defTop, 10) || 12);
  const pos0 = positionals[0];
  if (pos0 !== undefined && String(pos0).trim() !== "") {
    const p = parseInt(String(pos0), 10);
    if (!Number.isFinite(p) || p < 1) {
      console.error(`无效的位置参数 N：${JSON.stringify(pos0)}，请传入正整数。`);
      console.error("使用 --help 查看用法。");
      process.exitCode = 1;
      return;
    }
    topN = p;
  }

  const topComments = Math.max(0, parseInt(values.comments || "12", 10) || 12);
  const model = values.model || DEFAULT_MODEL;
  const verbose = Boolean(values.verbose);
  const outputJson = (values.output || DEFAULT_JSON_OUT).trim() || DEFAULT_JSON_OUT;

  run({ topN, topComments, model, verbose, outputJson }).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

main();

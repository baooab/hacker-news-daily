/**
 * 从 hn-snapshot.json 渲染列表（由 hn_deepseek.js 生成）
 */

const JSON_PATH = "./hn-snapshot.json";

function $(sel, root = document) {
  return root.querySelector(sel);
}

function hostFromUrl(url) {
  if (!url || typeof url !== "string") return "";
  try {
    const h = new URL(url).hostname;
    return h.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function timeAgo(unixSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const s = Math.max(0, now - unixSeconds);
  if (s < 60) return `${s} seconds ago`;
  if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400)} days ago`;
  return `${Math.floor(s / (86400 * 365))} years ago`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * HN 评论片段含实体与有限 HTML；本地快照视为可信内容。
 * @param {string} htmlish
 */
function setCommentHtml(el, htmlish) {
  const t = String(htmlish || "");
  el.innerHTML = t;
}

function storyHref(item) {
  if (item.url) return String(item.url);
  const id = item.id;
  return `https://news.ycombinator.com/item?id=${id}`;
}

function itemPageHref(id) {
  return `https://news.ycombinator.com/item?id=${id}`;
}

function renderMeta(meta) {
  const el = $("#hn-meta-line");
  if (!meta || !el) return;
  const hnRaw = meta.hnFetchedAt || meta.fetchedAt;
  const hnT = hnRaw
    ? new Date(hnRaw).toLocaleString()
    : "—";
  const dsT = meta.deepseekCompletedAt
    ? new Date(meta.deepseekCompletedAt).toLocaleString()
    : "—";
  const dsModel = meta.deepseekModel ? escapeHtml(String(meta.deepseekModel)) : "—";
  el.innerHTML = `快照：<strong>hn-snapshot.json</strong> · HN 抓取 ${escapeHtml(hnT)} · 摘要生成 ${escapeHtml(dsT)} · 模型 ${dsModel} · topN=${escapeHtml(String(meta.topN ?? "?"))}`;
}

function renderStories(data) {
  const tbody = $("#hn-items");
  if (!tbody || !data.stories) return;

  for (const row of data.stories) {
    const item = row.item || {};
    const rank = row.rank;
    const id = item.id;
    const title = item.title || "(无标题)";
    const url = item.url;
    const domain = url ? hostFromUrl(url) : "news.ycombinator.com";
    const score = item.score ?? "—";
    const by = item.by || "—";
    const time = typeof item.time === "number" ? item.time : 0;
    const descendants = item.descendants ?? 0;

    const dsEarly = row.deepseek || {};
    const titleZh =
      dsEarly.titleZh != null && String(dsEarly.titleZh).trim()
        ? String(dsEarly.titleZh).trim()
        : "";
    const titleLinkInner = titleZh
      ? `<span class="story-title-cn">${escapeHtml(titleZh)}</span><span class="story-title-sep"> · </span><span class="story-title-en">${escapeHtml(title)}</span>`
      : escapeHtml(title);

    const trRank = document.createElement("tr");
    trRank.className = "athing";
    const fromSite = encodeURIComponent(domain);
    const storyUrl = storyHref(item);
    trRank.innerHTML = `
      <td class="rank">${rank}.</td>
      <td class="titleline">
        <a class="story-title" href="${escapeHtml(storyUrl)}" target="_blank" rel="noopener noreferrer">${titleLinkInner}</a>
        ${url ? `<span class="comhead"> (<a href="https://news.ycombinator.com/from?site=${fromSite}" target="_blank" rel="noopener noreferrer">${escapeHtml(domain)}</a>)</span>` : `<span class="comhead"> (${escapeHtml(domain)})</span>`}
      </td>`;
    tbody.appendChild(trRank);

    const trSub = document.createElement("tr");
    const byEnc = encodeURIComponent(String(by));
    trSub.innerHTML = `
      <td class="rank-spacer"></td>
      <td class="subtext">
        ${escapeHtml(String(score))} points by <a href="https://news.ycombinator.com/user?id=${byEnc}" target="_blank" rel="noopener noreferrer">${escapeHtml(String(by))}</a>
        ${time ? `<span> ${escapeHtml(timeAgo(time))}</span>` : ""}
        &nbsp;|&nbsp; <a href="${escapeHtml(itemPageHref(id))}" target="_blank" rel="noopener noreferrer">${escapeHtml(String(descendants))} comments</a>
      </td>`;
    tbody.appendChild(trSub);

    const selfText = item.text && String(item.text).trim();
    if (selfText) {
      const trText = document.createElement("tr");
      trText.innerHTML = `<td class="rank-spacer"></td><td class="story-selftext"></td>`;
      const cell = trText.querySelector(".story-selftext");
      setCommentHtml(cell, selfText);
      tbody.appendChild(trText);
    }

    const ds = row.deepseek;
    const articleSum =
      (ds.articleSummary != null && String(ds.articleSummary).trim()) ||
      (ds.abstract != null && String(ds.abstract).trim()) ||
      "";
    const commentSum =
      (ds.commentSummary != null && String(ds.commentSummary).trim()) ||
      (Array.isArray(ds.commentPoints)
        ? ds.commentPoints.map((x) => String(x).trim()).filter(Boolean).join("；")
        : ds.commentPoints && typeof ds.commentPoints === "string"
          ? String(ds.commentPoints).trim()
          : "") ||
      "";
    if (ds && (ds.error || articleSum || commentSum)) {
      const trDs = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 2;
      td.className = "deepseek-cell";
      const wrap = document.createElement("div");
      wrap.className = "deepseek-wrap";
      const inner = document.createElement("div");
      inner.className = "deepseek-body";
      if (ds.error) {
        const err = document.createElement("div");
        err.className = "deepseek-error";
        err.textContent = String(ds.error);
        inner.appendChild(err);
      } else {
        if (articleSum) {
          const p = document.createElement("div");
          p.className = "deepseek-block";
          p.innerHTML = `<span class="deepseek-label">文章摘要</span><div class="deepseek-text">${escapeHtml(articleSum).replaceAll("\n", "")}</div>`;
          inner.appendChild(p);
        }
        if (commentSum) {
          const p = document.createElement("div");
          p.className = "deepseek-block";
          p.innerHTML = `<span class="deepseek-label">评论摘要</span><div class="deepseek-text">${escapeHtml(commentSum).replaceAll("\n", "")}</div>`;
          inner.appendChild(p);
        }
      }
      wrap.appendChild(inner);
      td.appendChild(wrap);
      trDs.appendChild(td);
      tbody.appendChild(trDs);
    }

    const trSp = document.createElement("tr");
    trSp.innerHTML = '<td colspan="2" class="spacer"></td>';
    tbody.appendChild(trSp);
  }
}

async function main() {
  const errEl = $("#hn-error");
  try {
    const res = await fetch(JSON_PATH, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    renderMeta(data.meta);
    renderStories(data);
    if (errEl) errEl.hidden = true;
  } catch (e) {
    const msg = `无法加载 ${JSON_PATH}：${e && e.message ? e.message : e}

常见原因：用 file:// 打开页面时，浏览器会拦截本地 JSON 请求。请在项目目录执行：

  npx --yes serve . -p 8080

然后在浏览器打开显示的本地地址（例如 http://localhost:8080/index.html）。`;
    if (errEl) {
      errEl.hidden = false;
      errEl.textContent = msg;
    }
    console.error(e);
  }
}

main();

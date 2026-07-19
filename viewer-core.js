/**
 * 首页 / 存档页共用的快照加载与列表渲染
 */

export const LATEST_JSON = "./hn-snapshot.json";
export const ARCHIVE_INDEX = "./archives/index.json";
/** 首页下拉仅展示最近 N 天 */
export const HOME_RECENT_LIMIT = 30;

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function hostFromUrl(url) {
  if (!url || typeof url !== "string") return "";
  try {
    const h = new URL(url).hostname;
    return h.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function timeAgo(unixSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const s = Math.max(0, now - unixSeconds);
  if (s < 60) return `${s} seconds ago`;
  if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
  if (s < 86400 * 365) return `${Math.floor(s / 86400)} days ago`;
  return `${Math.floor(s / (86400 * 365))} years ago`;
}

export function escapeHtml(s) {
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
export function setCommentHtml(el, htmlish) {
  el.innerHTML = String(htmlish || "");
}

export function storyHref(item) {
  if (item.url) return String(item.url);
  return `https://news.ycombinator.com/item?id=${item.id}`;
}

export function itemPageHref(id) {
  return `https://news.ycombinator.com/item?id=${id}`;
}

export function archiveJsonPath(date) {
  return `./archives/${date}.json`;
}

export function dateFromHash() {
  const raw = (location.hash || "").replace(/^#/, "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

/**
 * @param {{ dates?: string[], latest?: string } | null} index
 */
export function recentDates(index, limit = HOME_RECENT_LIMIT) {
  const dates = Array.isArray(index?.dates) ? index.dates : [];
  return dates.slice(0, Math.max(0, limit));
}

/**
 * @returns {Promise<{ dates: string[], latest: string } | null>}
 */
export async function loadArchiveIndex() {
  try {
    const res = await fetch(ARCHIVE_INDEX, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    const dates = Array.isArray(data.dates)
      ? data.dates.filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))
      : [];
    dates.sort((a, b) => b.localeCompare(a));
    const latest =
      typeof data.latest === "string" && dates.includes(data.latest)
        ? data.latest
        : dates[0] || "";
    return { dates, latest };
  } catch {
    return null;
  }
}

/**
 * @param {{ dates?: string[], latest?: string } | null} index
 * @param {string[]} allowedDates 下拉可选日期（首页为最近 30 天）
 */
export function resolveSelectedDate(index, allowedDates) {
  const fromHash = dateFromHash();
  const allowed = Array.isArray(allowedDates) ? allowedDates : [];
  const all = Array.isArray(index?.dates) ? index.dates : [];
  if (fromHash && allowed.includes(fromHash)) return fromHash;
  if (fromHash && all.includes(fromHash) && !allowed.includes(fromHash)) {
    return { redirect: fromHash };
  }
  if (index?.latest && allowed.includes(index.latest)) return index.latest;
  return allowed[0] || "";
}

/**
 * @param {HTMLSelectElement | null} sel
 * @param {string[]} dates
 * @param {string} selected
 * @param {string} latest
 */
export function fillArchiveSelect(sel, dates, selected, latest) {
  if (!sel) return;
  sel.innerHTML = "";
  if (!dates.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "暂无存档";
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const d of dates) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d === latest ? `${d}（最新）` : d;
    if (d === selected) opt.selected = true;
    sel.appendChild(opt);
  }
}

export function renderMeta(meta, archiveDate) {
  const el = $("#hn-meta-line");
  if (!meta || !el) return;
  const hnRaw = meta.hnFetchedAt || meta.fetchedAt;
  const hnT = hnRaw ? new Date(hnRaw).toLocaleString() : "—";
  const dsT = meta.deepseekCompletedAt
    ? new Date(meta.deepseekCompletedAt).toLocaleString()
    : "—";
  const dsModel = meta.deepseekModel ? escapeHtml(String(meta.deepseekModel)) : "—";
  const day =
    archiveDate ||
    (typeof meta.archiveDate === "string" ? meta.archiveDate : "") ||
    "—";
  el.innerHTML = `存档 <strong>${escapeHtml(day)}</strong> · HN 抓取 ${escapeHtml(hnT)} · 摘要生成 ${escapeHtml(dsT)} · 模型 ${dsModel} · topN=${escapeHtml(String(meta.topN ?? "?"))}`;
}

export function clearStories() {
  const tbody = $("#hn-items");
  if (tbody) tbody.innerHTML = "";
}

export function renderStories(data) {
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
      (ds?.articleSummary != null && String(ds.articleSummary).trim()) ||
      (ds?.abstract != null && String(ds.abstract).trim()) ||
      "";
    const commentSum =
      (ds?.commentSummary != null && String(ds.commentSummary).trim()) ||
      (Array.isArray(ds?.commentPoints)
        ? ds.commentPoints.map((x) => String(x).trim()).filter(Boolean).join("；")
        : ds?.commentPoints && typeof ds.commentPoints === "string"
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

/**
 * @param {string} date
 * @param {{ dates: string[], latest: string } | null} index
 */
export async function loadSnapshot(date, index) {
  const errEl = $("#hn-error");
  const paths = [];
  if (date) paths.push(archiveJsonPath(date));
  if (!date || (index && date === index.latest)) paths.push(LATEST_JSON);

  let lastErr = null;
  for (const path of paths) {
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = await res.json();
      clearStories();
      const day =
        date ||
        (typeof data.meta?.archiveDate === "string" ? data.meta.archiveDate : "") ||
        index?.latest ||
        "";
      renderMeta(data.meta, day);
      renderStories(data);
      if (errEl) errEl.hidden = true;
      return true;
    } catch (e) {
      lastErr = e;
    }
  }

  const msg = `无法加载快照${date ? `（${date}）` : ""}：${lastErr && lastErr.message ? lastErr.message : lastErr}

常见原因：用 file:// 打开页面时，浏览器会拦截本地 JSON 请求。请在项目目录执行：

  npx --yes serve . -p 8080

然后在浏览器打开显示的本地地址（例如 http://localhost:8080/index.html）。`;
  clearStories();
  if (errEl) {
    errEl.hidden = false;
    errEl.textContent = msg;
  }
  console.error(lastErr);
  return false;
}

/**
 * 按 YYYY-MM 分组，组内日期新→旧。
 * @param {string[]} dates
 * @returns {Array<{ month: string, dates: string[] }>}
 */
export function groupDatesByMonth(dates) {
  /** @type {Map<string, string[]>} */
  const map = new Map();
  for (const d of dates) {
    const month = d.slice(0, 7);
    if (!map.has(month)) map.set(month, []);
    map.get(month).push(d);
  }
  return [...map.entries()].map(([month, ds]) => ({ month, dates: ds }));
}

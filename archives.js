/**
 * 全部存档页：按月列出全部日期；带 hash 时展示当日快照
 */

import {
  $,
  dateFromHash,
  escapeHtml,
  groupDatesByMonth,
  loadArchiveIndex,
  loadSnapshot,
} from "./viewer-core.js";

/**
 * @param {{ dates: string[], latest: string } | null} index
 * @param {string} selected
 */
function renderArchiveList(index, selected) {
  const root = $("#hn-archive-list");
  if (!root) return;
  root.innerHTML = "";

  const dates = index?.dates || [];
  if (!dates.length) {
    root.innerHTML = `<p class="hn-intro">暂无存档。请先运行 <code>npm start</code> 生成快照。</p>`;
    return;
  }

  const groups = groupDatesByMonth(dates);
  for (const { month, dates: monthDates } of groups) {
    const section = document.createElement("section");
    section.className = "archive-month";
    const heading = document.createElement("h2");
    heading.className = "archive-month-title";
    heading.textContent = month;
    section.appendChild(heading);

    const ul = document.createElement("ul");
    ul.className = "archive-date-list";
    for (const d of monthDates) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `#${d}`;
      a.textContent = d === index?.latest ? `${d}（最新）` : d;
      if (d === selected) a.classList.add("is-active");
      li.appendChild(a);
      ul.appendChild(li);
    }
    section.appendChild(ul);
    root.appendChild(section);
  }
}

/**
 * @param {string} date
 * @param {boolean} showDetail
 */
function setViewMode(date, showDetail) {
  const listWrap = $("#hn-archive-list-wrap");
  const detailWrap = $("#hn-archive-detail");
  const back = $("#hn-archive-back");
  const title = $("#hn-archive-day-title");

  if (listWrap) listWrap.hidden = showDetail;
  if (detailWrap) detailWrap.hidden = !showDetail;
  if (back) back.hidden = !showDetail;
  if (title) {
    title.hidden = !showDetail;
    title.textContent = showDetail && date ? `存档 ${date}` : "";
  }
}

async function showDay(date, index) {
  setViewMode(date, true);
  renderArchiveList(index, date);
  await loadSnapshot(date, index);
}

function showList(index) {
  setViewMode("", false);
  clearDetail();
  renderArchiveList(index, "");
  const errEl = $("#hn-error");
  if (errEl) errEl.hidden = true;
  const meta = $("#hn-meta-line");
  if (meta) {
    const n = index?.dates?.length ?? 0;
    meta.innerHTML = n
      ? `共 <strong>${escapeHtml(String(n))}</strong> 天存档 · 点击日期查看当日热门与摘要`
      : "暂无存档";
  }
}

function clearDetail() {
  const tbody = $("#hn-items");
  if (tbody) tbody.innerHTML = "";
}

async function main() {
  const index = await loadArchiveIndex();
  const all = index?.dates || [];

  const applyHash = async () => {
    const d = dateFromHash();
    if (d && all.includes(d)) {
      await showDay(d, index);
      return;
    }
    if (d && !all.includes(d)) {
      const errEl = $("#hn-error");
      showList(index);
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = `未找到存档日期：${d}`;
      }
      return;
    }
    showList(index);
  };

  window.addEventListener("hashchange", () => {
    applyHash();
  });

  const back = $("#hn-archive-back");
  if (back) {
    back.addEventListener("click", (e) => {
      e.preventDefault();
      history.pushState(null, "", location.pathname + location.search);
      showList(index);
    });
  }

  await applyHash();
}

main();

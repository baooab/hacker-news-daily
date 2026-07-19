/**
 * 首页：最近 30 天存档下拉 + 快照列表
 */

import {
  $,
  HOME_RECENT_LIMIT,
  dateFromHash,
  fillArchiveSelect,
  loadArchiveIndex,
  loadSnapshot,
  recentDates,
  resolveSelectedDate,
} from "./viewer-core.js";

async function main() {
  const index = await loadArchiveIndex();
  const recent = recentDates(index, HOME_RECENT_LIMIT);
  const resolved = resolveSelectedDate(index, recent);

  if (resolved && typeof resolved === "object" && resolved.redirect) {
    location.replace(`archives.html#${resolved.redirect}`);
    return;
  }

  const selected = typeof resolved === "string" ? resolved : "";
  fillArchiveSelect($("#hn-archive-select"), recent, selected, index?.latest || "");

  const moreLink = $("#hn-archive-more");
  if (moreLink && index?.dates?.length) {
    const n = index.dates.length;
    moreLink.textContent =
      n > HOME_RECENT_LIMIT ? `全部存档（${n}）` : "全部存档";
  }

  if (selected && dateFromHash() !== selected) {
    history.replaceState(null, "", `#${selected}`);
  }

  const sel = $("#hn-archive-select");
  if (sel) {
    sel.addEventListener("change", () => {
      const d = sel.value;
      if (!d) return;
      if (dateFromHash() !== d) location.hash = d;
      else loadSnapshot(d, index);
    });
  }

  window.addEventListener("hashchange", () => {
    const next = resolveSelectedDate(index, recent);
    if (next && typeof next === "object" && next.redirect) {
      location.replace(`archives.html#${next.redirect}`);
      return;
    }
    const d = typeof next === "string" ? next : "";
    if (sel && d && sel.value !== d) sel.value = d;
    loadSnapshot(d, index);
  });

  await loadSnapshot(selected, index);
}

main();

"use strict";

/**
 * KEIBA NAVIGATOR — 全レース予想ビュー (クライアント用)
 *
 * 役割:
 *   /api/races の summaries 配列を受け取り、
 *   発走時刻/EV/信頼度でソート + フィルタ (全/狙える/S級/G1) して
 *   見やすい一覧 HTML を生成する。
 *
 * 公開 API:
 *   AllRacesView.filterAndSort(items, filter, sort) -> filtered & sorted array
 *   AllRacesView.renderRow(item) -> HTML string
 *   AllRacesView.formatStartTime(iso) -> "12:35"
 */

(function (global) {
  function safeNum(v) {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function formatStartTime(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      const h = d.getHours().toString().padStart(2, "0");
      const m = d.getMinutes().toString().padStart(2, "0");
      return `${h}:${m}`;
    } catch { return ""; }
  }

  function filterAndSort(items, filter, sort) {
    if (!Array.isArray(items)) return [];
    let arr = items.slice();

    // フィルタ
    if (filter === "go") {
      arr = arr.filter(r => r.verdict === "go" || (r.topGrade === "S" || r.topGrade === "A"));
    } else if (filter === "s-grade") {
      arr = arr.filter(r => r.topGrade === "S");
    } else if (filter === "g1") {
      arr = arr.filter(r => r.isG1);
    }

    // ソート
    if (sort === "ev") {
      arr.sort((a, b) => (safeNum(b.topPick?.ev) ?? -1) - (safeNum(a.topPick?.ev) ?? -1));
    } else if (sort === "confidence") {
      arr.sort((a, b) => (safeNum(b.confidence) ?? -1) - (safeNum(a.confidence) ?? -1));
    } else {
      // 発走時刻順 (デフォルト)
      arr.sort((a, b) => {
        const ta = a.startTime || "";
        const tb = b.startTime || "";
        if (ta && tb) return ta.localeCompare(tb);
        return String(a.raceId || "").localeCompare(String(b.raceId || ""));
      });
    }
    return arr;
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, ch =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function gradeLabel(g) {
    if (!g) return "";
    return `<span class="ar-grade-badge b-${String(g).toLowerCase()}">${g}</span>`;
  }

  function verdictClass(v) {
    if (v === "go") return "is-go";
    if (v === "pass") return "is-pass";
    return "is-neutral";
  }

  function renderRow(item) {
    const time = formatStartTime(item.startTime);
    const timeBlock = time
      ? `<div class="ar-time">${escapeHtml(time)}<span class="ar-time-sub">${escapeHtml(parseRaceNum(item))}</span></div>`
      : `<div class="ar-time">${escapeHtml(parseRaceNum(item) || "-")}</div>`;
    const top = item.topPick;
    const pickRow = top
      ? `<div class="ar-pick-row"><span class="ar-pick-num">${escapeHtml(String(top.number))}</span> ${escapeHtml(top.name || "")} <span class="ar-pick-extras">EV ${(top.ev ?? 0).toFixed(2)} / ${top.odds ? top.odds + "倍" : "—"}</span></div>`
      : `<div class="ar-pick-row ar-pick-extras">出走馬データ未取得</div>`;
    const extras = [];
    if (item.second) extras.push(`対抗: ${item.second.number}`);
    if (item.third)  extras.push(`3着: ${item.third.number}`);
    if (item.hasOverpop) extras.push("⚠ 過剰人気あり");
    if (item.hasUnderval) extras.push("★ 過小評価あり");
    const extraLine = extras.length
      ? `<div class="ar-pick-extras">${escapeHtml(extras.join(" · "))}</div>`
      : "";
    const biasNote = item.trackBiasNote
      ? `<div class="ar-bias-note">${escapeHtml(item.trackBiasNote)}</div>`
      : "";
    const courseLine = `<div class="ar-course">${escapeHtml(item.course || "")} ${item.distance ? item.distance + "m" : ""}${item.horseCount ? " · " + item.horseCount + "頭" : ""}</div>`;

    const ev = top ? top.ev : null;
    const confPct = item.confidence ? Math.round(item.confidence * 100) : 0;
    const evClass = (ev && ev >= 1.0) ? "" : "ev-down";

    const rowClass = [
      "ar-row",
      verdictClass(item.verdict),
      item.isG1 ? "is-g1" : "",
    ].filter(Boolean).join(" ");

    return `<li class="${rowClass}" data-race-id="${escapeHtml(item.raceId || "")}">
      ${timeBlock}
      <div class="ar-main">
        <div class="ar-name-row">
          <span class="ar-name">${escapeHtml(item.raceName || "レース")}</span>
          ${gradeLabel(item.topGrade)}
          ${item.isG1 ? '<span class="ar-grade-badge" style="background:#7c3aed;color:#fff;">G1</span>' : ""}
        </div>
        ${courseLine}
        ${pickRow}
        ${extraLine}
        ${biasNote}
      </div>
      <div class="ar-meta">
        <div class="ar-ev ${evClass}">${ev != null ? ev.toFixed(2) : "—"}</div>
        <div class="ar-confidence-bar"><div class="ar-confidence-fill" style="width: ${confPct}%"></div></div>
        <div class="ar-verdict-label">${confPct}%</div>
      </div>
    </li>`;
  }

  function parseRaceNum(item) {
    if (!item || !item.raceId) return "";
    // 16-18 桁の race_id から R 番号を抽出 (末尾 2 桁)
    const m = String(item.raceId).match(/(\d{2})$/);
    if (m) return `${parseInt(m[1], 10)}R`;
    return "";
  }

  function renderAll(items, filter, sort) {
    const arr = filterAndSort(items, filter, sort);
    if (arr.length === 0) return "";
    return arr.map(renderRow).join("");
  }

  global.AllRacesView = {
    filterAndSort,
    renderRow,
    renderAll,
    formatStartTime,
  };
})(typeof window !== "undefined" ? window : globalThis);

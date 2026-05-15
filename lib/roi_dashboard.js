"use strict";

/**
 * KEIBA NAVIGATOR — ROI ダッシュボード (クライアント用)
 *
 * 役割:
 *   過去の馬券記録 (bets) から、「グレード × 券種」のヒートマップを作る。
 *   各セル: 回収率 (returned / spent) + サンプル数。
 *
 * 表示色:
 *   profit-strong: ROI >= 130% (緑濃)
 *   profit-mild:   ROI 100-130% (緑薄)
 *   no-data:       n < 3 (灰)
 *   loss-mild:     ROI 70-100% (赤薄)
 *   loss-strong:   ROI < 70% (赤濃)
 *
 * 公開 API:
 *   RoiDashboard.compute(bets) -> { matrix, narrative, totalSamples, totalROI }
 *   RoiDashboard.render(roi)   -> HTML string
 */

(function (global) {
  const GRADES = ["S", "A", "B", "C", "D"];
  const TICKETS = ["tan", "fuku", "uren", "wide", "fuku3"];
  const TICKET_LABELS = { tan: "単勝", fuku: "複勝", uren: "馬連", wide: "ワイド", fuku3: "3連複" };

  function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  function inferGrade(b) {
    if (b?.grade && GRADES.includes(b.grade)) return b.grade;
    const ev = safeNum(b?.ev);
    if (ev >= 1.30) return "S";
    if (ev >= 1.10) return "A";
    if (ev >= 1.00) return "B";
    if (ev >= 0.85) return "C";
    return "D";
  }

  function inferTicket(b) {
    if (b?.type === "tan" || b?.type === "win") return "tan";
    if (b?.type === "fuku" || b?.type === "place") return "fuku";
    if (b?.type === "uren" || b?.type === "exacta_box") return "uren";
    if (b?.type === "wide") return "wide";
    if (b?.type === "fuku3" || b?.type === "trifecta_box") return "fuku3";
    return "tan";
  }

  function isFinalized(b) {
    return b && (b.result?.won === true || b.result?.won === false || b.won === true || b.won === false);
  }

  function isReal(b) {
    return b && !b.dummy && !b.is_dummy && b.dataSource !== "dummy" && b.type !== "air";
  }

  function compute(bets) {
    const arr = (Array.isArray(bets) ? bets : []).filter(isReal).filter(isFinalized);
    const matrix = {};
    for (const g of GRADES) {
      matrix[g] = {};
      for (const t of TICKETS) matrix[g][t] = { samples: 0, hits: 0, spent: 0, returned: 0 };
    }
    let totalSpent = 0, totalReturned = 0, totalHits = 0;
    for (const b of arr) {
      const g = inferGrade(b);
      const t = inferTicket(b);
      const slot = matrix[g][t];
      const spent = safeNum(b.amount || b.stake);
      const ret = (b.result?.won || b.won) ? safeNum(b.result?.payout || b.payout) : 0;
      slot.samples++;
      slot.hits += (b.result?.won || b.won) ? 1 : 0;
      slot.spent += spent;
      slot.returned += ret;
      totalSpent += spent;
      totalReturned += ret;
      totalHits += (b.result?.won || b.won) ? 1 : 0;
    }
    // 各セルの ROI 計算
    for (const g of GRADES) {
      for (const t of TICKETS) {
        const c = matrix[g][t];
        c.roi = c.spent > 0 ? c.returned / c.spent : null;
        c.hitRate = c.samples > 0 ? c.hits / c.samples : null;
      }
    }
    const totalROI = totalSpent > 0 ? totalReturned / totalSpent : null;
    const narrative = buildNarrative(matrix, totalROI, arr.length);
    return { matrix, totalSamples: arr.length, totalROI, totalSpent, totalReturned, totalHits, narrative };
  }

  function buildNarrative(matrix, totalROI, totalSamples) {
    if (totalSamples < 3) return "まだサンプルが少なく、傾向が見えていません (合計 3 件以上で評価可能)。";

    // 黒字領域・赤字領域を抽出
    const wins = [], losses = [];
    for (const g of GRADES) {
      for (const t of TICKETS) {
        const c = matrix[g][t];
        if (c.samples < 3) continue;
        if (c.roi >= 1.10) wins.push({ g, t, roi: c.roi, n: c.samples });
        if (c.roi < 0.85) losses.push({ g, t, roi: c.roi, n: c.samples });
      }
    }
    wins.sort((a, b) => b.roi - a.roi);
    losses.sort((a, b) => a.roi - b.roi);

    const parts = [];
    if (totalROI != null) {
      const pct = (totalROI * 100).toFixed(1);
      if (totalROI >= 1.0) parts.push(`全体回収率 ${pct}% — プラス収支。AI 判定がうまく回っています。`);
      else parts.push(`全体回収率 ${pct}% — マイナス収支。買う基準を厳しくする (S 級以上だけ) と改善できる可能性があります。`);
    }
    if (wins.length) {
      const top = wins[0];
      parts.push(`得意領域: ${top.g} 級 × ${TICKET_LABELS[top.t]} で回収率 ${(top.roi*100).toFixed(0)}% (n=${top.n})。ここは積極的に。`);
    }
    if (losses.length) {
      const worst = losses[0];
      parts.push(`苦手領域: ${worst.g} 級 × ${TICKET_LABELS[worst.t]} は回収率 ${(worst.roi*100).toFixed(0)}% (n=${worst.n}) — 控える方が長期的に有利。`);
    }
    if (!wins.length && !losses.length) {
      parts.push("各セルのサンプル数がまだ少なく、領域別の得意/苦手は判定できません (各セル n≥3 で評価)。");
    }
    return parts.join(" / ");
  }

  function cellClass(c) {
    if (!c || c.samples < 3) return "no-data";
    if (c.roi >= 1.30) return "profit-strong";
    if (c.roi >= 1.00) return "profit-mild";
    if (c.roi >= 0.70) return "loss-mild";
    return "loss-strong";
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, ch =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function render(roi) {
    if (!roi) return "";
    const cells = [];
    // ヘッダ行
    cells.push(`<div class="roi-cell is-header">grade</div>`);
    for (const t of TICKETS) cells.push(`<div class="roi-cell is-header">${escapeHtml(TICKET_LABELS[t])}</div>`);
    // 各グレード行
    for (const g of GRADES) {
      cells.push(`<div class="roi-cell is-side">${g}級</div>`);
      for (const t of TICKETS) {
        const c = roi.matrix[g][t];
        const cls = cellClass(c);
        const val = c.roi != null ? `${Math.round(c.roi * 100)}%` : "—";
        const n = c.samples > 0 ? `n=${c.samples}` : "";
        cells.push(`<div class="roi-cell ${cls}"><span class="roi-val">${val}</span><span class="roi-n">${n}</span></div>`);
      }
    }
    return cells.join("");
  }

  global.RoiDashboard = { compute, render, GRADES, TICKETS, TICKET_LABELS };
})(typeof window !== "undefined" ? window : globalThis);

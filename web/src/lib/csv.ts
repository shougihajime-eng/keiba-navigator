"use client";

// 馬券記録の書き出し / 取り込み (CSV)
// 端末を変えても記録を持ち運べるように。表計算ソフトでも開ける。
// Excel の日本語文字化けを防ぐため UTF-8 BOM 付きで書き出す。

import type { Bet } from "@/lib/store";

const HEADERS = [
  "id", "createdAt", "raceName", "course", "type", "horses",
  "amount", "payout", "result", "ev",
] as const;

const RESULT_JP: Record<string, string> = { hit: "当たり", miss: "外れ", pending: "結果待ち" };
const JP_RESULT: Record<string, "hit" | "miss" | "pending"> = {
  "当たり": "hit", "的中": "hit", "当": "hit", hit: "hit",
  "外れ": "miss", "はずれ": "miss", "不的中": "miss", miss: "miss",
  "結果待ち": "pending", "待ち": "pending", pending: "pending",
};

/** 1セルを CSV 用にエスケープ */
function esc(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Bet[] → CSV テキスト (UTF-8 BOM 付き) */
export function betsToCsv(bets: Bet[]): string {
  const lines = [HEADERS.join(",")];
  for (const b of bets) {
    lines.push([
      esc(b.id),
      esc(b.createdAt),
      esc(b.raceName ?? ""),
      esc(b.course ?? ""),
      esc(b.type ?? ""),
      esc(b.horses ?? ""),
      esc(b.amount ?? 0),
      esc(b.payout ?? ""),
      esc(RESULT_JP[b.result ?? "pending"] ?? b.result ?? ""),
      esc(b.ev ?? ""),
    ].join(","));
  }
  return "﻿" + lines.join("\r\n");
}

/** ブラウザでCSVファイルをダウンロード */
export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV 1行をフィールド配列に (ダブルクォート対応) */
function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

const toNum = (s: string): number =>
  Math.round(Number(
    (s || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[^\d.-]/g, ""),
  ) || 0);

/**
 * CSV テキスト → Bet[] (ゆるく取り込む)
 * - 列名は HEADERS を基準に、無い列は空で補完
 * - id が無ければ自動採番 (取り込み時の重複防止のため安定値)
 * - 結果は日本語/英語どちらも受ける
 */
export function csvToBets(text: string): { bets: Bet[]; errors: string[] } {
  const errors: string[] = [];
  const clean = text.replace(/^﻿/, "");
  const rows = clean.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
  if (rows.length === 0) return { bets: [], errors: ["ファイルが空です"] };

  const header = parseLine(rows[0]).map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  // ヘッダが無いCSVも一応許容 (位置で読む)
  const hasHeader = HEADERS.some((h) => header.includes(h));
  const startRow = hasHeader ? 1 : 0;

  const col = (cells: string[], name: string, pos: number) => {
    const i = hasHeader ? idx(name) : pos;
    return i >= 0 && i < cells.length ? cells[i].trim() : "";
  };

  const bets: Bet[] = [];
  for (let r = startRow; r < rows.length; r += 1) {
    const cells = parseLine(rows[r]);
    const amount = toNum(col(cells, "amount", 6));
    if (amount <= 0) { errors.push(`${r + 1}行目: 金額が読めないので飛ばしました`); continue; }

    const createdAtRaw = col(cells, "createdAt", 1);
    const createdAt = createdAtRaw && !Number.isNaN(Date.parse(createdAtRaw))
      ? new Date(createdAtRaw).toISOString()
      : new Date().toISOString();

    const resultRaw = col(cells, "result", 8);
    const result = JP_RESULT[resultRaw] ?? "pending";
    const payoutStr = col(cells, "payout", 7);
    const evStr = col(cells, "ev", 9);

    const rawId = col(cells, "id", 0);
    // id が無い行は「内容から安定IDを作る」(同じCSVを2回入れても重複しない)
    const id = rawId || `import_${createdAt}_${col(cells, "type", 4)}_${col(cells, "horses", 5)}_${amount}`;

    bets.push({
      id,
      createdAt,
      raceName: col(cells, "raceName", 2) || undefined,
      course: col(cells, "course", 3) || undefined,
      type: col(cells, "type", 4) || "複勝",
      horses: col(cells, "horses", 5) || "",
      amount,
      payout: result === "hit" ? toNum(payoutStr) : result === "miss" ? 0 : (payoutStr ? toNum(payoutStr) : undefined),
      result,
      ev: evStr ? Number(evStr) || undefined : undefined,
      factors: { source: "csv_import" },
    });
  }

  return { bets, errors };
}

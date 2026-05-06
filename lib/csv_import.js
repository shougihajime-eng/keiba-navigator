"use strict";
/**
 * KEIBA NAVIGATOR — CSV インポーター (ブラウザ実行)
 *
 * 機能:
 *   1. CSV → 馬券記録 (bet) 配列への変換
 *   2. 文字コード自動判別 (UTF-8 BOM / Shift_JIS / UTF-8)
 *   3. 列名のゆらぎ吸収 (date/Date/DATE/日付/購入日 など)
 *   4. プレビュー用の正規化済データを返す
 *   5. 検証エラー (致命的な行) を別配列で返す
 *
 * 公開 API:
 *   CsvImport.parseFile(file) -> Promise<{ rows, errors, sourceText }>
 *   CsvImport.toBets(rows)    -> { bets, errors }
 *   CsvImport.sampleCsv()     -> string  (ダウンロード用サンプル)
 */
(function (global) {
  // ─── 文字コード判別 ──────────────────────────────────────────
  async function decodeFile(file) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    // UTF-8 BOM
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder("utf-8").decode(bytes.subarray(3));
    }
    // UTF-16 LE BOM
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    }
    // Shift_JIS 簡易判定 — UTF-8 として decode して U+FFFD が多すぎる場合
    const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const replacementCount = (utf8.match(/�/g) || []).length;
    if (replacementCount > 3) {
      try {
        return new TextDecoder("shift_jis").decode(bytes);
      } catch (e) {
        // fallback to utf-8
      }
    }
    return utf8;
  }

  // ─── CSV パーサ (RFC 4180 準拠の簡易版) ─────────────────────
  function parseCsv(text) {
    const rows = [];
    let row = [], cell = "", inQuote = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuote) {
        if (ch === '"') {
          if (text[i+1] === '"') { cell += '"'; i++; }
          else inQuote = false;
        } else cell += ch;
      } else {
        if (ch === '"') inQuote = true;
        else if (ch === ',') { row.push(cell); cell = ""; }
        else if (ch === '\r') { /* skip */ }
        else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ""; }
        else cell += ch;
      }
    }
    if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => c !== ""));
  }

  // ─── 列名の正規化 (ゆらぎ吸収) ──────────────────────────────
  const COL_MAP = {
    date:      ["date", "日付", "購入日", "馬券日", "ts", "datetime"],
    race_name: ["race_name", "race", "レース名", "race name", "レース"],
    type:      ["type", "種類", "種別", "kind"],
    amount:    ["amount", "金額", "賭け金", "purchase", "購入金額", "購入額"],
    target:    ["target", "馬番", "対象", "horse", "buy"],
    bet_type:  ["bet_type", "bettype", "馬券種別", "馬券種", "式別"],
    odds:      ["odds", "オッズ"],
    won:       ["won", "result", "結果", "当落", "hit"],
    payout:    ["payout", "払戻", "払戻金", "return"],
    prob:      ["prob", "推定勝率", "確率", "probability"],
    ev:        ["ev", "期待値"],
    grade:     ["grade", "グレード", "ランク"],
  };
  function normalizeKey(raw) {
    const k = String(raw || "").trim().toLowerCase();
    for (const canon in COL_MAP) {
      if (COL_MAP[canon].some(alias => alias.toLowerCase() === k)) return canon;
    }
    return null;  // unknown → 無視
  }

  // ─── 値の正規化 ────────────────────────────────────────────
  function parseDate(v) {
    if (!v) return null;
    const s = String(v).trim();
    // YYYY-MM-DD / YYYY/MM/DD / 2026年4月20日
    let m = s.match(/^(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
    if (m) {
      const d = new Date(`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}T12:00:00`);
      if (!isNaN(d)) return d.toISOString();
    }
    const d2 = new Date(s);
    if (!isNaN(d2)) return d2.toISOString();
    return null;
  }
  function parseBool(v) {
    if (v == null) return null;
    const s = String(v).trim().toLowerCase();
    if (["true","1","○","◯","yes","当","当たり","的中","勝","win","won"].includes(s)) return true;
    if (["false","0","×","x","no","外","外れ","不的中","負","lose","lost"].includes(s)) return false;
    return null;
  }
  function parseNum(v) {
    if (v == null || v === "") return null;
    const s = String(v).replace(/[,円￥]/g, "").trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  function parseType(v) {
    if (v == null) return "air";
    const s = String(v).trim().toLowerCase();
    if (["real","r","現","リアル","本番","実"].some(k => s.startsWith(k))) return "real";
    return "air";
  }
  function parseGrade(v) {
    if (!v) return null;
    const s = String(v).trim().toUpperCase();
    return ["S","A","B","C","D"].includes(s) ? s : null;
  }

  // ─── CSV 行 → bet オブジェクト ──────────────────────────────
  function rowToBet(row, idx) {
    const errors = [];
    const date = parseDate(row.date);
    if (!date) errors.push(`日付が不正: "${row.date || ''}"`);
    const amount = parseNum(row.amount);
    if (amount == null || amount < 0) errors.push(`金額が不正: "${row.amount || ''}"`);

    const won = parseBool(row.won);
    const payout = parseNum(row.payout);
    const odds   = parseNum(row.odds);
    const prob   = parseNum(row.prob);
    const ev     = parseNum(row.ev);
    const grade  = parseGrade(row.grade);

    let result = null;
    if (won != null) {
      result = {
        won,
        payout: won ? (payout ?? (odds != null && amount != null ? Math.round(odds * amount) : 0)) : 0,
        finishedAt: date,
      };
    }

    return {
      bet: errors.length ? null : {
        id: `csv_${Date.now().toString(36)}_${idx}`,
        ts: date,
        type: parseType(row.type),
        amount: Math.round(amount),
        raceName: (row.race_name || "").trim() || null,
        raceId: null,
        target: row.target ? String(row.target).trim() : null,
        betType: (row.bet_type || "tan").trim().toLowerCase(),
        odds, prob, ev, grade,
        dataSource: "csv_import",
        result,
        factors: ["csv_imported"],
        profit: result ? (result.payout || 0) - amount : null,
        auto: false,
      },
      errors,
    };
  }

  // ─── 公開 API ─────────────────────────────────────────────
  async function parseFile(file) {
    const text = await decodeFile(file);
    const matrix = parseCsv(text);
    if (matrix.length < 2) {
      return { rows: [], errors: [{ row: 0, msg: "ヘッダー行 + データ行が必要です(2行以上)" }], sourceText: text };
    }
    const headerRow = matrix[0];
    const cols = headerRow.map(normalizeKey);
    const knownCount = cols.filter(c => c).length;
    if (knownCount === 0) {
      return { rows: [], errors: [{ row: 1, msg: "認識できる列名がありません(date/amount などが必要)" }], sourceText: text };
    }
    const rows = [];
    for (let i = 1; i < matrix.length; i++) {
      const obj = {};
      matrix[i].forEach((v, idx) => {
        const k = cols[idx]; if (k) obj[k] = v;
      });
      rows.push(obj);
    }
    return { rows, errors: [], sourceText: text };
  }

  function toBets(rows) {
    const bets = [];
    const errors = [];
    rows.forEach((row, i) => {
      const { bet, errors: errs } = rowToBet(row, i);
      if (bet) bets.push(bet);
      if (errs.length) errors.push({ row: i + 2, msgs: errs });
    });
    return { bets, errors };
  }

  function sampleCsv() {
    return [
      "date,race_name,type,amount,target,bet_type,odds,won,payout,grade",
      "2026-04-20,皐月賞,air,1000,3,tan,5.2,true,5200,A",
      "2026-04-20,皐月賞,real,500,7,fuku,2.1,false,0,B",
      "2026-04-13,桜花賞,air,1000,1,tan,3.5,true,3500,S",
      "2026-04-06,中山GJ,air,500,5,wide,12.0,false,0,C",
    ].join("\r\n") + "\r\n";
  }

  global.CsvImport = { parseFile, toBets, sampleCsv };
})(typeof window !== "undefined" ? window : globalThis);

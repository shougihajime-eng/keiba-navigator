#!/usr/bin/env node
/* ============================================================================
   競馬アプリ「嘘の数字」見張り  (検品/uso-check.mjs)
   2026-08-12 新設

   なぜ在るか:
     このアプリには「良く見える数字を作る癖」が何か所にも埋まっていた。
       1. app.js に BEST 126.8% / SAFE 106.3% が手書きで直書き（実際は79.9%/77.7%）
       2. 検証の数字を「お金ベースの本当の回収率」と呼ぶラベル
       3. 「正直な記録」と書きながら、レース後の確定オッズで本命を選び直していた
       4. うまみ買いのオッズ 433レース中114 が発走後のもの
       5. 「較正済なので嘘のない期待値」と書きながら較正を一度も読んでいなかった
       6. 2026年5月の268レースが文字化け（馬名 ? ・人気99番・着順47着）で学習にも混入
     人間が毎回これに気づくのは無理。だから機械に見張らせる。

   このファイルの決まり (自分に課す掟):
     - 🚫 読めていないのに「合格」を出さない。読めなければ「不明」＝はっきり失敗にする。
     - 🚫 見つかった物を勝手に許可リストへ入れて黙らせない。見つけたら必ず本人に出す。
     - 🚫 このファイル以外は書き換えない (読むだけ)。app.js 等は別の担当が触っている。
     - ✅ わざと壊して検査が本当に落ちるか (--self-test) を必ず確かめられるようにする。

   使い方:
     node 検品/uso-check.mjs                 … 全部の検査 (画面も見る)
     node 検品/uso-check.mjs --no-browser    … 画面を見ない (データとコードだけ)
     node 検品/uso-check.mjs --self-test     … わざと壊して検査が落ちるか確かめる
     node 検品/uso-check.mjs --url http://127.0.0.1:8765/
     node 検品/uso-check.mjs --json          … 機械向けの出力も出す

   終わりかた (終了コード):
     0 = 全部合格 / 1 = 嘘や壊れを見つけた / 2 = 検査そのものが走れなかった(＝不明)
   ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import net from "node:net";

const require_ = createRequire(import.meta.url);
const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname_, "..");                   // 競馬アプリの本体
const CACHE = path.join(ROOT, "data", "jv_cache");
const PLAYWRIGHT = "C:/Users/shoug/棋譜検索/node_modules/playwright";
const REPORT_TXT = "C:/Users/shoug/はじめアプリ/競馬の嘘チェック.txt";
const DESKTOPS = [
  "C:/Users/shoug/OneDrive/デスクトップ/📋 自動チェックの結果（毎日のお知らせ）",
  "C:/Users/shoug/Desktop/📋 自動チェックの結果（毎日のお知らせ）",
];
const NOTICE_NAME = "⚠競馬アプリに嘘の数字が出ています.txt";

// ── 引数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
// ⚠「--break=roi」と「--break roi」の両方を読む。
//   最初 --break=roi を読み落とし、わざと壊したのに検査が素通りした (＝いちばん危ない事故)。
const getOpt = (f, dflt) => {
  const eq = argv.find((a) => a.startsWith(f + "="));
  if (eq) return eq.slice(f.length + 1);
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
// 知らない指定を黙って無視しない (打ち間違いで検査が骨抜きになるのを防ぐ)
{
  const KNOWN = ["--no-browser", "--self-test", "--json", "--quiet", "--url", "--break"];
  const bad = argv.filter((a) => a.startsWith("--") && !KNOWN.some((k) => a === k || a.startsWith(k + "=")));
  if (bad.length) { console.error("知らない指定です:", bad.join(" "), "\n使えるのは:", KNOWN.join(" ")); process.exit(2); }
}
const OPT = {
  noBrowser: hasFlag("--no-browser"),
  selfTest: hasFlag("--self-test"),
  json: hasFlag("--json"),
  url: getOpt("--url", null),
  quiet: hasFlag("--quiet"),
  // --break=roi|cards|hide … わざと画面を壊して、②の検査が本当に落ちるか確かめる用。
  //   ⚠ 画面をいじるのはブラウザの中だけ。アプリのファイルには一切さわらない。
  break: getOpt("--break", null),
};

// ── 検査の結果を貯める ──────────────────────────────────────────────────
/** @type {{id:string,title:string,state:"ok"|"ng"|"unknown",msg:string,detail:string[]}[]} */
const RESULTS = [];
function add(id, title, state, msg, detail = []) {
  RESULTS.push({ id, title, state, msg, detail: detail.filter(Boolean) });
  if (!OPT.quiet) {
    const mark = state === "ok" ? "✅" : state === "ng" ? "❌" : "❓";
    console.log(`${mark} [${id}] ${title} … ${msg}`);
    for (const d of detail.slice(0, 12)) console.log(`      ${d}`);
    if (detail.length > 12) console.log(`      …ほか ${detail.length - 12} 件`);
  }
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

/* ==========================================================================
   A. コードの中の「手書きの成績」
   ==========================================================================
   考え方:
     - コメントは画面に出ないので見ない (過去のバグの説明が書いてあるだけ)。
       → だから本物の JS の目でコメントと文字列を切り分ける (下の splitJs)。
     - しきい値の定数 (100% を超えたら…など) と、成績の数字を分ける工夫を入れる。
       誤検知が多いと誰も見なくなるので、当たったら必ず「その行そのもの」を出す。
*/

/**
 * JS/HTML を「コード部分」と「文字列の中身」に切り分ける。
 * コメントは空白に潰す (行番号は保つ)。文字列も空白に潰し、中身は別に集める。
 * ＝ しきい値の比較 (code) と 画面に出る言葉 (string) を別々に見られる。
 */
function splitJs(src) {
  const code = Buffer.alloc(src.length, 0x20); // 空白で埋めた同じ長さの器
  const strings = [];
  let i = 0;
  const n = src.length;
  let line = 1;
  const lineOf = new Int32Array(n + 1);
  { let l = 1; for (let k = 0; k < n; k++) { lineOf[k] = l; if (src[k] === "\n") l++; } lineOf[n] = l; }
  const keep = (k) => { code[k] = src.charCodeAt(k) > 255 ? 0x20 : src.charCodeAt(k); };
  const tplStack = []; // テンプレート文字列の ${ } の入れ子

  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    // 行コメント
    if (c === "/" && c2 === "/") { while (i < n && src[i] !== "\n") { if (src[i] === "\n") break; i++; } continue; }
    // ブロックコメント
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") code[i] = 0x0a; i++; }
      i += 2; continue;
    }
    // ふつうの文字列
    if (c === '"' || c === "'") {
      const q = c, start = i; i++;
      let val = "";
      while (i < n) {
        if (src[i] === "\\") { val += src[i + 1] || ""; i += 2; continue; }
        if (src[i] === q) { i++; break; }
        if (src[i] === "\n") break; // 壊れた文字列 → そこで打ち切り
        val += src[i]; i++;
      }
      strings.push({ value: val, line: lineOf[start] });
      continue;
    }
    // テンプレート文字列
    if (c === "`") {
      const start = i; i++;
      let val = "";
      while (i < n) {
        if (src[i] === "\\") { val += src[i + 1] || ""; i += 2; continue; }
        if (src[i] === "`") { i++; break; }
        if (src[i] === "$" && src[i + 1] === "{") {
          // ${ } の中はコード → そのまま code に残す
          strings.push({ value: val, line: lineOf[start] });
          val = "";
          keep(i); keep(i + 1); i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
              const q2 = src[i]; const s2 = i; i++; let v2 = "";
              while (i < n) { if (src[i] === "\\") { v2 += src[i + 1] || ""; i += 2; continue; } if (src[i] === q2) { i++; break; } v2 += src[i]; i++; }
              strings.push({ value: v2, line: lineOf[s2] });
              continue;
            }
            if (depth > 0) keep(i);
            if (src[i] === "\n") code[i] = 0x0a;
            i++;
          }
          continue;
        }
        if (src[i] === "\n") { /* 改行は保つ */ }
        val += src[i]; i++;
      }
      if (val) strings.push({ value: val, line: lineOf[start] });
      continue;
    }
    if (c === "\n") { code[i] = 0x0a; i++; continue; }
    keep(i); i++;
  }
  return { code: code.toString("latin1"), strings, lineOf };
}

/** HTML から <script> の中身と、画面に出る文字 (タグの外) を取り出す */
function splitHtml(src) {
  const scripts = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src))) {
    const before = src.slice(0, m.index);
    scripts.push({ code: m[1], line: before.split("\n").length });
  }
  // タグを消して、画面に出る文だけにする
  const text = src.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
                  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
                  .replace(/<!--[\s\S]*?-->/g, " ");
  const textStrings = [];
  {
    const lines = text.split("\n");
    for (let k = 0; k < lines.length; k++) {
      const t = lines[k].replace(/<[^>]*>/g, " ").trim();
      if (t) textStrings.push({ value: t, line: k + 1 });
    }
  }
  return { scripts, textStrings };
}

// しきい値としてよく出る、まるい数字 (これ単体では成績とみなさない)
const ROUND_THRESHOLDS = new Set([0, 1, 2, 3, 5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 100, 110, 120, 150, 180, 200, 250, 300, 360, 400, 500, 1000]);

/** その数字が「成績っぽい」か。小数付きは即アウト、整数はまるい数字を除く */
function looksLikePerformanceNumber(numStr) {
  const v = Number(numStr);
  if (!Number.isFinite(v)) return false;
  if (numStr.includes(".")) return v >= 1 && v <= 1000;      // 126.8 / 79.9 など
  return v >= 20 && v <= 1000 && !ROUND_THRESHOLDS.has(v);   // 126 / 106 など
}

/**
 * 手書きの成績を探す本体。
 * @returns {{pattern:string,file:string,line:number,text:string}[]}
 */
export function findHardcodedStats(src, file, kind = "js") {
  const hits = [];
  const srcLines = src.split("\n");
  const lineText = (l) => (srcLines[l - 1] || "").trim().slice(0, 240);
  // 同じ 1 個の数字に複数の見つけ方が当たることがある (例「期待 +129%」は P4/P5/P6 全部に当たる)。
  // 本人には「1 個の嘘は 1 行」で見せたいので、行と数字でまとめる。先に当たった＝説明が丁寧な方を残す。
  const push = (pattern, line, why, matched) => {
    const num = (String(matched).match(/\d+(?:\.\d+)?/) || [""])[0];
    hits.push({ pattern, file, line, text: lineText(line), why, num });
  };

  const scanCode = (code, lineOffset = 0) => {
    // P1: roi / 回収率 / 的中率 … に「数字そのもの」を入れている
    const P1 = /\b(roi|ROI|roiPct|roi_pct|roiPercent|recovery|recoveryRate|recovery_pct|hitRate|hit_rate|hit_rate_pct|winRate|win_rate|payoutRate|回収率|的中率|勝率)\s*(?::|=(?!=))\s*(-?\d+(?:\.\d+)?)/g;
    let m;
    while ((m = P1.exec(code))) {
      if (!looksLikePerformanceNumber(m[2])) continue;
      const line = lineOffset + code.slice(0, m.index).split("\n").length;
      push("P1 成績の直書き", line, `${m[1]} に ${m[2]} を手で入れている`, m[2]);
    }
  };

  // 説明が丁寧な順に見る (先に当たった方を本人に見せる)
  const STRING_PATTERNS = [
    ["P3 成績の言い切り", /(?:回収率|的中率|勝率|払戻率|回収)[^%％\n]{0,10}?(\d{2,4}(?:\.\d+)?)\s*[%％]/g, true],
    ["P5 期待値の言い切り", /(?:期待|見込み|見こみ|平均で|平均)[^%％\n]{0,8}?[+＋\-]?(\d{1,4}(?:\.\d+)?)\s*[%％]/g, false],
    ["P6 符号つきパーセントの直書き", /(?<![\d.])[+＋]\s?(\d{1,4}(?:\.\d+)?)\s*[%％]/g, false],
    ["P2 小数パーセントの直書き", /(?<![\d.])(\d{1,3}\.\d+)\s*[%％]/g, false],
    ["P4 3桁パーセントの直書き", /(?<![\d.])(\d{3,4})\s*[%％]/g, true],
  ];

  const scanStrings = (strings, lineOffset = 0) => {
    for (const s of strings) {
      const v = s.value;
      const line = lineOffset + s.line;
      for (const [name, re, needPerf] of STRING_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(v))) {
          if (needPerf && !looksLikePerformanceNumber(m[1])) continue;
          push(name, line, `文字の中に「${m[0]}」`, m[1]);
        }
      }
    }
  };

  if (kind === "js") {
    const { code, strings } = splitJs(src);
    scanCode(code);
    scanStrings(strings);
  } else {
    const { scripts, textStrings } = splitHtml(src);
    for (const sc of scripts) {
      const { code, strings } = splitJs(sc.code);
      scanCode(code, sc.line - 1);
      scanStrings(strings, sc.line - 1);
    }
    scanStrings(textStrings, 0);
  }
  // 同じ行の同じ数字は1件にまとめる (見つけ方が何通り当たっても「嘘 1 個」として数える)
  const seen = new Set();
  return hits.filter((h) => { const k = `${h.file}:${h.line}:${h.num}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

const SCAN_FILES = [
  ["app.js", "js"],
  ["index.html", "html"],
  ["config.js", "js"],
  ["storage.js", "js"],
  ["lib/glossary.js", "js"],
  ["lib/effects.js", "js"],
];

function checkA() {
  const all = [];
  const missing = [];
  for (const [rel, kind] of SCAN_FILES) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { missing.push(rel); continue; }
    let src;
    try { src = fs.readFileSync(p, "utf8"); }
    catch (e) { missing.push(`${rel} (読めない: ${e.message})`); continue; }
    all.push(...findHardcodedStats(src, rel, kind));
  }
  if (missing.length && all.length === 0 && missing.length === SCAN_FILES.length) {
    return add("A", "コードの中の手書きの成績", "unknown",
      "見るファイルが1つも読めませんでした＝検査できていません", missing);
  }
  if (all.length) {
    return add("A", "コードの中の手書きの成績", "ng",
      `手で書いた成績らしき数字が ${all.length} 件あります`,
      all.map((h) => `${h.file}:${h.line}  ${h.why}\n         → ${h.text}`));
  }
  add("A", "コードの中の手書きの成績", "ok",
    `${SCAN_FILES.length - missing.length} 個のファイルを見て 0 件（数字はデータから取っています）`,
    missing.map((m) => `※ ${m} は在りませんでした`));
}

/* ==========================================================================
   B. 画面に出ている数字が、データと一致するか (本物のブラウザで見る)
   ========================================================================== */

function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once("error", () => res(false));
    s.once("listening", () => s.close(() => res(true)));
    s.listen(port, "127.0.0.1");
  });
}
function waitUrl(url, ms = 20000) {
  const t0 = Date.now();
  return new Promise(async (res) => {
    while (Date.now() - t0 < ms) {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok) return res(true); } catch { }
      await new Promise((r) => setTimeout(r, 400));
    }
    res(false);
  });
}

/** 画面を見るためのサーバーを用意する。動いていなければ自分で立てて、終わったら閉じる。 */
async function ensureServer() {
  const candidates = OPT.url ? [OPT.url] : ["http://127.0.0.1:8791/", "http://127.0.0.1:8765/"];
  for (const u of candidates) {
    try { const r = await fetch(new URL("/api/live-stats", u), { signal: AbortSignal.timeout(1500) }); if (r.ok) return { url: u, child: null }; } catch { }
  }
  // 自分で立てる (別のポート＝動いている物とぶつからない)
  let port = 8799;
  for (; port < 8830; port++) if (await portFree(port)) break;
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT, env: { ...process.env, PORT: String(port) },
    stdio: "ignore", windowsHide: true, detached: false,
  });
  const url = `http://127.0.0.1:${port}/`;
  const ok = await waitUrl(url + "api/live-stats", 25000);
  if (!ok) { try { child.kill(); } catch { } return { url: null, child: null }; }
  return { url, child };
}

async function checkB() {
  if (OPT.noBrowser) {
    return add("B", "画面の数字とデータの一致", "unknown", "--no-browser なので画面を見ていません（＝合格ではありません）");
  }
  let pw;
  try { pw = require_(PLAYWRIGHT); }
  catch (e) {
    return add("B", "画面の数字とデータの一致", "unknown", `本物のブラウザ(playwright)が読めません: ${e.message}`);
  }
  const { url, child } = await ensureServer();
  if (!url) {
    return add("B", "画面の数字とデータの一致", "unknown", "アプリのサーバーに繋がらず、自分で立てることもできませんでした");
  }
  let browser = null;
  try {
    // 1) データの正 (計算のもと) を先に取る
    const api = await (await fetch(new URL("/api/live-stats", url))).json();
    if (!api || !api.ok || !api.live || !api.live.by_strategy) {
      return add("B", "画面の数字とデータの一致", "unknown", "/api/live-stats が本物の成績を返しませんでした");
    }
    const rows = Object.entries(api.live.by_strategy).map(([k, v]) => ({ key: k, ...v }));
    const cost = rows.reduce((s, v) => s + (v.invest_jpy || 0), 0);
    const ret = rows.reduce((s, v) => s + (v.payout_jpy || 0), 0);
    if (cost <= 0) return add("B", "画面の数字とデータの一致", "unknown", "投資額が 0 で計算できません");
    const trueRoi = ret / cost * 100;
    const trueProfit = ret - cost;
    const winners = rows.filter((v) => (v.roi_pct || 0) >= 100).length;
    const liveKeys = new Set(rows.map((r) => r.key));

    browser = await pw.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
    const jsErrors = [];
    page.on("pageerror", (e) => jsErrors.push(String(e.message || e)));
    // わざと壊すモード: hide = 本物の成績を画面に出させない (隠したのと同じ状態)
    if (OPT.break === "hide") await page.route("**/api/live-stats", (r) => r.abort());
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    let shown;
    try {
      await page.waitForSelector(".honest-record .hr-roi", { timeout: OPT.break === "hide" ? 12000 : 40000 });
      // わざと壊すモード: roi = 画面の回収率だけ良い数字に差し替える / cards = 実成績の併記を消す
      if (OPT.break === "roi") await page.evaluate(() => { document.querySelector(".honest-record .hr-roi").textContent = "126.8%"; });
      if (OPT.break === "cards") await page.evaluate(() => {
        for (const m of document.querySelectorAll(".strat-trust-card .meta")) m.textContent = m.textContent.replace(/実際に買ったら/g, "");
      });
      shown = await page.evaluate(() => {
        const q = (s) => document.querySelector(s);
        const cards = [...document.querySelectorAll(".strat-trust-card")].map((c) => ({
          name: (c.querySelector(".name") || {}).textContent || "",
          label: (c.querySelector(".big-roi-label") || {}).textContent || "",
          meta: (c.querySelector(".meta") || {}).textContent || "",
        }));
        return {
          roiText: (q(".honest-record .hr-roi") || {}).textContent || "",
          profitText: (q(".honest-record .hr-profit") || {}).textContent || "",
          subText: (q(".honest-record .hr-sub") || {}).textContent || "",
          cards,
          liveLines: document.querySelectorAll(".live-ok, .live-ng").length,
        };
      });
    } catch (e) {
      return add("B", "画面の数字とデータの一致", "ng",
        "画面に「本当の成績」が出てきませんでした（本物の成績を隠している疑い）", [String(e.message || e).slice(0, 200)]);
    }

    const bad = [];
    // B-1 回収率
    const shownRoi = parseFloat(String(shown.roiText).replace(/[^\d.\-]/g, ""));
    if (!Number.isFinite(shownRoi)) bad.push(`画面の回収率が数字として読めない: 「${shown.roiText}」`);
    else if (Math.abs(shownRoi - trueRoi) > 0.06)
      bad.push(`回収率が食い違う: 画面 ${shownRoi}% ／ データから計算すると ${trueRoi.toFixed(1)}%`);
    // B-2 損益
    const shownProfit = parseFloat(String(shown.profitText).replace(/[^\d.\-]/g, ""));
    if (Number.isFinite(shownProfit) && Math.abs(shownProfit - trueProfit) > 1)
      bad.push(`もうけ／損が食い違う: 画面 ${shownProfit}円 ／ データ ${trueProfit}円`);
    // B-3 「100%を超えたのは○個」
    const mWin = /100% を超えたのは\s*(\d+)\s*個/.exec(shown.subText.replace(/\s+/g, " "));
    if (mWin && Number(mWin[1]) !== winners)
      bad.push(`100%超えの数が食い違う: 画面 ${mWin[1]} 個 ／ データ ${winners} 個`);
    // B-4 戦略カードの「検証」の横に実運用の成績が併記されているか
    const kenshoCards = shown.cards.filter((c) => c.label.includes("検証"));
    if (kenshoCards.length > 0) {
      const withLive = kenshoCards.filter((c) => c.meta.includes("実際に買ったら")).length;
      if (withLive === 0)
        bad.push(`「検証（過去に当てはめた計算）」のカードが ${kenshoCards.length} 枚あるのに、実際に買ったときの成績が1枚も併記されていない`);
      else if (withLive < kenshoCards.length) {
        // 実運用のデータが無い戦略は併記できない＝それが理由なら正常
        const naked = kenshoCards.filter((c) => !c.meta.includes("実際に買ったら")).map((c) => c.name.trim());
        const nakedButHasData = naked.filter((n) => liveKeys.has(n.toLowerCase()));
        if (nakedButHasData.length)
          bad.push(`実運用の成績があるのに併記していないカード: ${nakedButHasData.join("・")}`);
      }
    }
    if (jsErrors.length) bad.push(`画面でエラーが出ています: ${jsErrors[0].slice(0, 120)}`);

    // 🚨 検査が意味を持っているかを自分で確かめる (わざと画面の数字を書き換えて落ちるか)
    const selfOk = await page.evaluate(() => {
      const e = document.querySelector(".honest-record .hr-roi");
      if (!e) return null;
      const keep = e.textContent; e.textContent = "999.9%";
      const read = document.querySelector(".honest-record .hr-roi").textContent;
      e.textContent = keep;
      return read;
    });
    const selfWorks = selfOk === "999.9%";

    if (bad.length) {
      add("B", "画面の数字とデータの一致", "ng", `画面とデータが合っていません（${bad.length} 件）`, bad);
    } else if (!selfWorks) {
      add("B", "画面の数字とデータの一致", "unknown", "画面の数字を読めているか自信が持てません（自己確認に失敗）");
    } else {
      add("B", "画面の数字とデータの一致", "ok",
        `画面の ${shownRoi}% はデータから計算した ${trueRoi.toFixed(1)}% と一致（戦略カード ${kenshoCards.length} 枚／実成績の併記 ${shown.liveLines} 行）`);
    }
  } catch (e) {
    add("B", "画面の数字とデータの一致", "unknown", `画面を見るところで止まりました: ${String(e.message || e).slice(0, 200)}`);
  } finally {
    try { if (browser) await browser.close(); } catch { }
    try { if (child) child.kill(); } catch { }
  }
}

/* ==========================================================================
   C. 後出し (レースが終わってから分かる事で選び直していないか)
   ========================================================================== */

/** honmei_log の中で「確定オッズ(後出し)」で選んだ物が混ざっていないか */
export function auditHonmeiOddsSource(log) {
  const entries = (log && Array.isArray(log.entries)) ? log.entries : null;
  if (!entries) return { readable: false };
  const counts = {};
  const badSamples = [];
  for (const e of entries) {
    const s = e.oddsSource || "(書いていない)";
    counts[s] = (counts[s] || 0) + 1;
    if (s !== "prerace" && badSamples.length < 10) badSamples.push(`${e.date || "?"} ${e.race_id || "?"} → ${s}`);
  }
  const bad = entries.length - (counts["prerace"] || 0);
  return { readable: true, total: entries.length, counts, bad, badSamples };
}

function checkC1() {
  const p = path.join(CACHE, "honmei_log.json");
  if (!fs.existsSync(p)) return add("C1", "本命の答え合わせが後出しでないか", "unknown", "honmei_log.json が在りません");
  let log; try { log = readJson(p); } catch (e) { return add("C1", "本命の答え合わせが後出しでないか", "unknown", `読めません: ${e.message}`); }
  const r = auditHonmeiOddsSource(log);
  if (!r.readable) return add("C1", "本命の答え合わせが後出しでないか", "unknown", "entries が読めません（形が変わった疑い）");
  if (r.total === 0) return add("C1", "本命の答え合わせが後出しでないか", "unknown", "記録が 0 件です（検査できていません）");
  if (r.bad > 0) {
    return add("C1", "本命の答え合わせが後出しでないか", "ng",
      `${r.total} 件のうち ${r.bad} 件がレース後の確定オッズで選んでいます（＝成績が甘くなります）`, r.badSamples);
  }
  add("C1", "本命の答え合わせが後出しでないか", "ok", `${r.total} 件すべて発走前のオッズ（prerace）で選んでいます`);
}

/** exotic_odds のスナップが発走時刻より後に取られていないか */
export function auditExoticTiming(cacheDir, fsx = fs) {
  const dir = path.join(cacheDir, "exotic_odds");
  if (!fsx.existsSync(dir)) return { readable: false, reason: "exotic_odds が在りません" };
  const races = fsx.readdirSync(dir).filter((d) => /^\d{16}$/.test(d));
  if (!races.length) return { readable: false, reason: "レースのフォルダが 0 件です" };
  let snapshots = 0, post = 0, noStart = 0;
  const badSamples = [], noStartSamples = [];
  for (const rid of races) {
    // 発走時刻は races/<rid+"00">.json の hassou_time ("HHMM"・日本時間)。決め打ちしない。
    const rp = path.join(cacheDir, "races", rid + "00.json");
    let ht = null;
    if (fsx.existsSync(rp)) {
      try { ht = JSON.parse(fsx.readFileSync(rp, "utf8")).hassou_time; } catch { }
    }
    if (!ht || !/^\d{4}$/.test(String(ht))) {
      noStart++; if (noStartSamples.length < 6) noStartSamples.push(rid);
      continue;
    }
    const s = String(ht);
    const startEpoch = Date.UTC(+rid.slice(0, 4), +rid.slice(4, 6) - 1, +rid.slice(6, 8), +s.slice(0, 2) - 9, +s.slice(2, 4)) / 1000;
    for (const f of fsx.readdirSync(path.join(dir, rid))) {
      if (!f.endsWith(".json")) continue;
      snapshots++;
      const ts = Number(f.replace(".json", ""));
      if (!Number.isFinite(ts)) continue;
      if (ts > startEpoch) {
        post++;
        if (badSamples.length < 10) {
          badSamples.push(`${rid} 発走${s} → ${f}（発走の ${((ts - startEpoch) / 60).toFixed(0)} 分あと）`);
        }
      }
    }
  }
  return { readable: true, races: races.length, snapshots, post, noStart, badSamples, noStartSamples };
}

function checkC2() {
  const r = auditExoticTiming(CACHE);
  if (!r.readable) return add("C2", "うまみ買いのオッズが発走前か", "unknown", r.reason);
  if (r.snapshots === 0) return add("C2", "うまみ買いのオッズが発走前か", "unknown", "オッズのスナップが 0 件です（検査できていません）");
  const detail = [...r.badSamples];
  if (r.noStart) detail.push(`※ 発走時刻が分からず見られなかったレース ${r.noStart} 件: ${r.noStartSamples.join(" ")}`);
  if (r.post > 0 || r.noStart > 0) {
    const st = r.post > 0 ? "ng" : "unknown";
    const msg = r.post > 0
      ? `${r.races} レース ${r.snapshots} 件のうち ${r.post} 件が発走より後に取ったオッズです（後出し＝成績が甘くなります）`
      : `発走時刻の分からないレースが ${r.noStart} 件あり、そこは検査できていません`;
    return add("C2", "うまみ買いのオッズが発走前か", st, msg, detail);
  }
  add("C2", "うまみ買いのオッズが発走前か", "ok", `${r.races} レース ${r.snapshots} 件すべて発走前に取ったオッズです`);
}

/* ==========================================================================
   D. データが壊れていないか
   ========================================================================== */

/** 1レース分の中身を見る。壊れていたら理由を返す */
export function auditRaceRecord(race, file = "") {
  const bad = [];
  const horses = Array.isArray(race && race.horses) ? race.horses : null;
  if (!horses) return [`${file}: horses が読めません`];
  const n = horses.length;
  if (n === 0) return bad; // 出走表が未取得のレースは在りうる
  for (const h of horses) {
    if (typeof h.name === "string" && h.name.includes("?")) bad.push(`${file}: 馬名が文字化け「${h.name}」`);
    if (Number.isFinite(h.popularity) && h.popularity > n) bad.push(`${file}: ${h.number || "?"}番の人気が ${h.popularity}（出走 ${n} 頭）`);
    if (Number.isFinite(h.kakutei_jyuni) && h.kakutei_jyuni > n) bad.push(`${file}: ${h.number || "?"}番の着順が ${h.kakutei_jyuni}着（出走 ${n} 頭）`);
  }
  return bad;
}

function checkD1() {
  const dir = path.join(CACHE, "races");
  if (!fs.existsSync(dir)) return add("D1", "レースのデータが壊れていないか", "unknown", "races フォルダが在りません");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (!files.length) return add("D1", "レースのデータが壊れていないか", "unknown", "レースのファイルが 0 件です（検査できていません）");
  const bad = [];
  let unreadable = 0;
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); }
    catch { unreadable++; bad.push(`${f}: JSON として読めません`); continue; }
    bad.push(...auditRaceRecord(j, f));
  }
  if (bad.length) {
    return add("D1", "レースのデータが壊れていないか", "ng",
      `${files.length} レースのうち ${bad.length} 件おかしい所があります（文字化け・人気/着順が頭数を超えている）`, bad);
  }
  add("D1", "レースのデータが壊れていないか", "ok", `${files.length} レース 全部きれい（馬名の文字化け 0・人気/着順の異常 0）`);
}

const CORRUPT_PATTERN = Buffer.from([0x3f, 0x40, 0x3f, 0x40]); // 「?@?@」＝文字化けの目印

/** 大きいファイルでも切れ目をまたいで見つけられるように、少しずつ読む */
export function fileHasPattern(p, pat = CORRUPT_PATTERN, fsx = fs) {
  const CH = 1 << 20;
  const fd = fsx.openSync(p, "r");
  try {
    const buf = Buffer.alloc(CH + pat.length - 1);
    let carry = 0, pos = 0;
    for (;;) {
      const r = fsx.readSync(fd, buf, carry, CH, pos);
      if (r <= 0) return false;
      pos += r;
      const view = buf.subarray(0, carry + r);
      if (view.includes(pat)) return true;
      const keep = Math.min(pat.length - 1, carry + r);
      view.copy(buf, 0, carry + r - keep, carry + r);
      carry = keep;
    }
  } finally { fsx.closeSync(fd); }
}

function checkD2() {
  const roots = [path.join(ROOT, "data")];
  const files = [];
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      // _quarantine = すでに「壊れているので脇へ置いた」箱。ここは数えない。
      if (e.isDirectory()) { if (e.name === "_quarantine" || e.name === "node_modules") continue; walk(p); }
      else if (/^raw_.*\.bin$/.test(e.name)) files.push(p);
    }
  };
  for (const r of roots) walk(r);
  if (!files.length) return add("D2", "生データが文字化けしていないか", "unknown", "raw_*.bin が 1 件も見つかりません（検査できていません）");
  const bad = [];
  let bytes = 0;
  for (const p of files) {          // ⚠ 全ファイル見る。前に 200 件だけ見て誤診した。
    try { bytes += fs.statSync(p).size; if (fileHasPattern(p)) bad.push(path.relative(ROOT, p)); }
    catch (e) { bad.push(`${path.relative(ROOT, p)}: 読めません (${e.message})`); }
  }
  const gb = (bytes / 1073741824).toFixed(2);
  if (bad.length) {
    return add("D2", "生データが文字化けしていないか", "ng",
      `${files.length} 個 (${gb}GB) のうち ${bad.length} 個が文字化けしています（学習データに混ざります）`, bad);
  }
  add("D2", "生データが文字化けしていないか", "ok", `${files.length} 個 (${gb}GB) 全部を最後まで見て 文字化け 0 件`);
}

/* ==========================================================================
   E. 「出してよい」と出している買い方が、本当に基準を満たしているか
   ========================================================================== */

/** 基準 = 150点以上・回収率100%以上・大当たり1回抜きでも100%以上・95%の幅の下も100%超 */
export function recomputeAllowed(umamiStatus) {
  const st = umamiStatus || {};
  const need = Number.isFinite(st.min_bets_required) ? st.min_bets_required : 150;
  const byType = (st.umami && st.umami.byType) ? st.umami.byType : null;
  if (!byType) return { readable: false };
  const should = [], reasons = {};
  for (const [k, v] of Object.entries(byType)) {
    const why = [];
    if (!(Number(v.bets) >= need)) why.push(`点数 ${v.bets} < ${need}`);
    if (!(Number(v.roi_pct) >= 100)) why.push(`回収率 ${v.roi_pct}% < 100%`);
    if (!(Number(v.roi_without_top_hit_pct) >= 100)) why.push(`大当たり1回抜きで ${v.roi_without_top_hit_pct}% < 100%`);
    if (!(Number(v.ci95_low_pct) > 100)) why.push(`運の幅の下が ${v.ci95_low_pct}% ≦ 100%`);
    reasons[k] = why;
    if (!why.length) should.push(k);
  }
  const declared = Array.isArray(st.allowed_bet_types) ? st.allowed_bet_types.slice() : [];
  const wrongly = declared.filter((k) => !should.includes(k));   // 基準を満たさないのに出している
  const missing = should.filter((k) => !declared.includes(k));   // 満たすのに出していない (安全側なので警告どまり)
  return { readable: true, need, should, declared, wrongly, missing, reasons, byType };
}

function checkE() {
  const p = path.join(CACHE, "umami_status.json");
  if (!fs.existsSync(p)) return add("E", "「出してよい」の判定が正しいか", "unknown", "umami_status.json が在りません");
  let st; try { st = readJson(p); } catch (e) { return add("E", "「出してよい」の判定が正しいか", "unknown", `読めません: ${e.message}`); }
  const r = recomputeAllowed(st);
  if (!r.readable) return add("E", "「出してよい」の判定が正しいか", "unknown", "byType が読めません（形が変わった疑い）");
  const detail = Object.entries(r.reasons).map(([k, why]) =>
    `${k}: ${why.length ? "満たさない（" + why.join("／") + "）" : "基準を満たす"}`);
  if (r.wrongly.length) {
    return add("E", "「出してよい」の判定が正しいか", "ng",
      `基準を満たしていないのに「出してよい」に入っている買い方が ${r.wrongly.length} 件: ${r.wrongly.join("・")}`, detail);
  }
  if (r.missing.length) {
    return add("E", "「出してよい」の判定が正しいか", "unknown",
      `基準を満たすのに「出してよい」に入っていない買い方があります（安全側ですが計算が食い違っています）: ${r.missing.join("・")}`, detail);
  }
  add("E", "「出してよい」の判定が正しいか", "ok",
    r.declared.length ? `出してよいのは ${r.declared.join("・")} だけ。基準と一致` : "「出してよい」は 0 件。基準どおり（どれも合格していません）", detail);
}

/* ==========================================================================
   わざと壊して、検査が本当に落ちるか確かめる (--self-test)
   ========================================================================== */
function selfTest() {
  const t = [];
  const ok = (name, pass, note = "") => { t.push({ name, pass, note }); };

  // A: にせの app.js を作って、5つの嘘を全部つかまえられるか
  const fake = `
    const s = { best: { roi_pct: 126.8 }, safe: { roi_pct: 106.3 } };
    card.appendChild(el("div", null, "BEST 126.8%"));
    card.appendChild(el("div", null, "回収率 106%"));
    const label = "お金ベースの本当の回収率 118%";
    // ここはコメント。126.8% と書いても画面に出ないので見つけなくてよい
    const threshold = 100;  const pct = "100%を超えた買い方";
    if (roi >= 100 && bets >= 150) go();
    const t2 = \`いまの回収率は \${roi.toFixed(1)}% です\`;
    const win5 = "本気の戦略は 金の3連単 (期待 +129%) を見てください";
    const p4only = "きのうの成せきは 143% になりました";
    const p6only = "きのうは +45% でした";
  `;
  const hits = findHardcodedStats(fake, "にせ.js", "js");
  const kinds = new Set(hits.map((h) => h.pattern.slice(0, 2)));
  ok("A 手書きの成績を見つける", hits.length >= 4, `${hits.length} 件つかまえた: ` + hits.map((h) => h.why).join(" / "));
  ok("A 6 通りの見つけ方が全部きいている", ["P1", "P2", "P3", "P4", "P5", "P6"].every((k) => kinds.has(k)), [...kinds].join(","));
  const clean = `
    const roi = 0; let hit_rate = 0;
    if (v.roi_pct >= 100) allow = true;
    const msg = "100%を超えたのは " + n + " 個";
    out = \`\${x.toFixed(1)}%\`;
    const cap = 150; const minBets = 150;
    const note = "20% (3連系は25%) が引かれます";
    const t3 = \`期待 \${ev.toFixed(0)}%\`;
  `;
  const cleanHits = findHardcodedStats(clean, "きれい.js", "js");
  ok("A まともなコードで誤検知しない", cleanHits.length === 0, cleanHits.map((h) => h.why).join(" / ") || "0 件");

  // C1: oddsSource が final の記録を混ぜたら落ちるか
  const c1bad = auditHonmeiOddsSource({ entries: [{ oddsSource: "prerace" }, { oddsSource: "final", date: "20260809", race_id: "X" }] });
  ok("C1 後出しオッズをつかまえる", c1bad.bad === 1, `bad=${c1bad.bad}`);
  const c1good = auditHonmeiOddsSource({ entries: [{ oddsSource: "prerace" }, { oddsSource: "prerace" }] });
  ok("C1 正しい記録は通す", c1good.bad === 0, `bad=${c1good.bad}`);

  // C2: にせのフォルダを作って、発走後のスナップをつかまえるか
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usocheck-"));
  try {
    const rid = "2026080101010101";
    fs.mkdirSync(path.join(tmp, "exotic_odds", rid), { recursive: true });
    fs.mkdirSync(path.join(tmp, "races"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "races", rid + "00.json"), JSON.stringify({ hassou_time: "1000", horses: [] }));
    const start = Date.UTC(2026, 7, 1, 1, 0) / 1000; // 10:00 JST = 01:00 UTC
    fs.writeFileSync(path.join(tmp, "exotic_odds", rid, String(start - 600) + ".json"), "{}");
    const before = auditExoticTiming(tmp);
    ok("C2 発走前だけなら通す", before.post === 0 && before.snapshots === 1, `post=${before.post} snapshots=${before.snapshots}`);
    fs.writeFileSync(path.join(tmp, "exotic_odds", rid, String(start + 600) + ".json"), "{}");
    const after = auditExoticTiming(tmp);
    ok("C2 発走後のオッズをつかまえる", after.post === 1, `post=${after.post}`);

    // D1: 壊れたレースをつかまえるか
    const badRace = { horses: [{ number: 1, name: "?????", popularity: 99, kakutei_jyuni: 47 }, { number: 2, name: "ウマ", popularity: 1, kakutei_jyuni: 1 }] };
    const d1 = auditRaceRecord(badRace, "にせ.json");
    ok("D1 文字化け・人気99・47着をつかまえる", d1.length === 3, d1.join(" / "));
    const goodRace = { horses: [{ number: 1, name: "ウマ", popularity: 2, kakutei_jyuni: 1 }, { number: 2, name: "シカ", popularity: 1, kakutei_jyuni: 2 }] };
    ok("D1 まともなレースは通す", auditRaceRecord(goodRace, "よい.json").length === 0);

    // D2: 文字化けの目印を、切れ目をまたいでも見つけられるか
    const big = path.join(tmp, "raw_test.bin");
    const size = (1 << 20) + 10;
    const b = Buffer.alloc(size, 0x41);
    CORRUPT_PATTERN.copy(b, (1 << 20) - 2);   // わざと 1MB の切れ目にまたがせる
    fs.writeFileSync(big, b);
    ok("D2 切れ目をまたいだ文字化けを見つける", fileHasPattern(big) === true);
    fs.writeFileSync(big, Buffer.alloc(size, 0x41));
    ok("D2 きれいな生データは通す", fileHasPattern(big) === false);
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { } }

  // E: 基準を満たさないのに「出してよい」にしたら落ちるか
  const eBad = recomputeAllowed({
    min_bets_required: 150, allowed_bet_types: ["umaren"],
    umami: { byType: { umaren: { bets: 219, roi_pct: 131.8, roi_without_top_hit_pct: 110, ci95_low_pct: 55, ci95_high_pct: 221 } } },
  });
  ok("E 基準を満たさない「出してよい」をつかまえる", eBad.wrongly.length === 1, `wrongly=${eBad.wrongly.join(",")}`);
  const eGood = recomputeAllowed({
    min_bets_required: 150, allowed_bet_types: ["umaren"],
    umami: { byType: { umaren: { bets: 219, roi_pct: 131.8, roi_without_top_hit_pct: 110, ci95_low_pct: 105 } } },
  });
  ok("E 本当に基準を満たす物は通す", eGood.wrongly.length === 0 && eGood.missing.length === 0);
  const eNone = recomputeAllowed({ min_bets_required: 150, allowed_bet_types: [], umami: { byType: { wide: { bets: 951, roi_pct: 74.4, roi_without_top_hit_pct: 68.5, ci95_low_pct: 65 } } } });
  ok("E 何も出さない今の状態は通す", eNone.wrongly.length === 0 && eNone.missing.length === 0);

  // お知らせ: 問題がある時だけ置き、元気になったら本当に消えるか
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "usonotice-"));
  try {
    const p2 = path.join(tmp2, NOTICE_NAME);
    syncNotice(tmp2, "こまっています");
    const placed = fs.existsSync(p2);
    syncNotice(tmp2, null);
    const cleared = !fs.existsSync(p2);
    ok("お知らせ 問題がある時だけ置く", placed);
    ok("お知らせ 元気になったら消える", cleared);
  } finally { try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch { } }

  console.log("\n──────── わざと壊してみた結果 ────────");
  for (const x of t) console.log(`${x.pass ? "✅" : "❌"} ${x.name}${x.note ? "  … " + x.note : ""}`);
  const failed = t.filter((x) => !x.pass).length;
  console.log(`──────── ${t.length - failed}/${t.length} 合格 ────────\n`);
  return failed === 0;
}

/* ==========================================================================
   結果を書き出す
   ========================================================================== */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * デスクトップのお知らせ箱に お知らせを置く / 消す。
 * @param {string} dir お知らせ箱
 * @param {string|null} body 中身。null なら「元気になったので消す」
 */
export function syncNotice(dir, body) {
  const p = path.join(dir, NOTICE_NAME);
  try {
    if (!fs.existsSync(dir)) return false;
    if (body === null) { if (fs.existsSync(p)) fs.unlinkSync(p); return true; }
    fs.writeFileSync(p, body, "utf8");
    return true;
  } catch { return false; }
}

function writeReport() {
  const ng = RESULTS.filter((r) => r.state === "ng");
  const unk = RESULTS.filter((r) => r.state === "unknown");
  const ok = RESULTS.filter((r) => r.state === "ok");
  const trouble = ng.length + unk.length;

  const L = [];
  L.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  L.push("  競馬アプリ「嘘の数字」チェック");
  L.push(`  ${stamp()} じどうで しらべました`);
  L.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  L.push("");
  if (trouble === 0) {
    L.push("🟢 ぜんぶ だいじょうぶです。");
    L.push("   画面に出ている数字は、ぜんぶ本物のデータから計算されています。");
  } else {
    L.push(`🔴 気になる所が ${trouble} 件あります。`);
    if (ng.length) L.push(`   ・はっきりおかしい … ${ng.length} 件`);
    if (unk.length) L.push(`   ・見られなかった（＝大丈夫とは言えない） … ${unk.length} 件`);
  }
  L.push("");
  L.push("──────────────────────────────");
  L.push(" しらべた 7 つのこと");
  L.push("──────────────────────────────");
  const NAMES = {
    A: "① コードの中に、手で書いた成績がまぎれていないか",
    B: "② 画面に出ている数字が、データと合っているか",
    C1: "③ 本命の答え合わせが、レース後の答えを見ていないか",
    C2: "④ うまみ買いのオッズが、発走より前のものか",
    D1: "⑤ レースのデータが壊れていないか（文字化け・へんな人気/着順）",
    D2: "⑥ 生データが文字化けしていないか（学習に混ざる）",
    E: "⑦「出してよい」と出している買い方が、本当に基準を満たしているか",
  };
  for (const r of RESULTS) {
    const mark = r.state === "ok" ? "🟢" : r.state === "ng" ? "🔴" : "🟡";
    L.push("");
    L.push(`${mark} ${NAMES[r.id] || r.title}`);
    L.push(`   → ${r.msg}`);
    if (r.state !== "ok" && r.detail.length) {
      for (const d of r.detail.slice(0, 25)) L.push(`      ・${String(d).replace(/\n/g, "\n        ")}`);
      if (r.detail.length > 25) L.push(`      ・…ほか ${r.detail.length - 25} 件`);
    }
  }
  L.push("");
  L.push("──────────────────────────────");
  if (trouble === 0) {
    L.push(" つぎに やること: ありません。このままで だいじょうぶです。");
  } else {
    L.push(" つぎに やること:");
    L.push("   このファイルを クロードに 見せてください。");
    L.push("   「競馬の嘘チェックで ○○ が出てる。直して」と言えば通じます。");
  }
  L.push("");
  L.push("※ この検査は毎日 自動で走ります（タスク名 KeibaUsoCheck）。");
  L.push("※ 自分で今すぐ しらべたいとき:");
  L.push('     node "C:\\Users\\shoug\\はじめアプリ\\７📦そのほか\\競馬\\検品\\uso-check.mjs"');
  L.push("");
  const text = L.join("\r\n");
  try {
    fs.mkdirSync(path.dirname(REPORT_TXT), { recursive: true });
    fs.writeFileSync(REPORT_TXT, text, "utf8");
  } catch (e) { console.error("結果ファイルが書けませんでした:", e.message); }

  // デスクトップのお知らせ（問題がある時だけ置く。元気なら消す＝既存の流儀）
  const body = trouble === 0 ? null : [
    "競馬アプリに 気になる数字が出ています。",
    "",
    ...RESULTS.filter((r) => r.state !== "ok").map((r) => `${r.state === "ng" ? "🔴" : "🟡"} ${NAMES[r.id] || r.title}\n   → ${r.msg}`),
    "",
    "くわしくは:",
    "  C:\\Users\\shoug\\はじめアプリ\\競馬の嘘チェック.txt",
    "",
    `(${stamp()})`,
  ].join("\r\n");
  for (const d of DESKTOPS) syncNotice(d, body);
  return { trouble, ng: ng.length, unknown: unk.length, ok: ok.length };
}

/* ========================================================================== */
async function main() {
  if (OPT.selfTest) {
    const pass = selfTest();
    process.exit(pass ? 0 : 1);
  }
  console.log("🐎 競馬アプリ「嘘の数字」チェックを はじめます\n");
  checkA();
  await checkB();
  checkC1();
  checkC2();
  checkD1();
  checkD2();
  checkE();
  const s = writeReport();
  console.log("");
  console.log(`結果: 合格 ${s.ok} ／ おかしい ${s.ng} ／ 見られなかった ${s.unknown}`);
  console.log(`書き出し: ${REPORT_TXT}`);
  if (OPT.json) console.log("\nJSON:" + JSON.stringify({ results: RESULTS }, null, 1));
  if (s.ng > 0) process.exit(1);
  if (s.unknown > 0) process.exit(2);
  process.exit(0);
}

// このファイルを直に走らせた時だけ検査する (別のテストから中の関数だけ借りられるように)
const IS_MAIN = !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (IS_MAIN) main().catch((e) => {
  console.error("検査そのものが落ちました:", e);
  try {
    fs.writeFileSync(REPORT_TXT,
      `競馬アプリの嘘チェックが 動きませんでした。\r\n${stamp()}\r\n\r\n理由: ${String(e && e.stack || e)}\r\n\r\n` +
      "＝「だいじょうぶ」ではありません。クロードに このファイルを見せてください。\r\n", "utf8");
    for (const d of DESKTOPS) {
      if (!fs.existsSync(d)) continue;
      fs.writeFileSync(path.join(d, NOTICE_NAME),
        `競馬アプリの嘘チェックが 動きませんでした（＝大丈夫か分かりません）。\r\n${stamp()}\r\n\r\nくわしくは C:\\Users\\shoug\\はじめアプリ\\競馬の嘘チェック.txt\r\n`, "utf8");
    }
  } catch { }
  process.exit(2);
});

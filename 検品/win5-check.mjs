// 2026-08-12: 日曜の WIN5 画面が本当に出るかを実ブラウザで見る。
//   ⚠ WIN5 は日曜だけの画面＝ふだん誰も見られない＝壊れていても気づけない。
//     本物の5レースから組み立てた WIN5 を差し込んで確かめる。
//   使い方: node 検品/win5-check.mjs [URL]
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { webkit, chromium } = require("C:/Users/shoug/棋譜検索/node_modules/playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.argv.find((a) => /^https?:/.test(a)) || "http://127.0.0.1:8791";
const FIX = path.join(process.env.TEMP || ".", "..", "win5_fixture.json");
// 差し込むデータ: 無ければ本物の5レースから その場で作る
let w5 = null;
const CAND = [
  FIX,
  "C:/Users/shoug/AppData/Local/Temp/claude/C--Users-shoug-------/8b23bfcb-64a3-4524-aeb9-9ce92efc56d9/scratchpad/win5.json",
];
for (const c of CAND) { try { w5 = JSON.parse(fs.readFileSync(c, "utf8")); break; } catch {} }
if (!w5) {
  const W = require("../lib/win5_engine.js");
  const dir = path.join(process.cwd(), "data", "jv_cache", "races");
  const ids = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().slice(-40);
  const pick = [ids[5], ids[6], ids[17], ids[18], ids[29]].filter(Boolean);
  w5 = W.buildWin5(pick.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))), { budget: 10000 });
}

const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number)
  .map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

let ok = 0, ng = 0;
const say = (g, m) => { if (g) ok++; else { ng++; console.log("  ✕ " + m); } };

for (const [name, engine, vp] of [
  ["iPhone", webkit, { width: 390, height: 844 }],
  ["iPad", webkit, { width: 1024, height: 1366 }],
  ["パソコン", chromium, { width: 1280, height: 900 }],
]) {
  const b = await engine.launch();
  const p = await b.newPage({ viewport: vp, deviceScaleFactor: 2 });
  const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.route("**/api/win5**", (r) => r.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(w5) }));
  await p.goto(BASE + "/", { waitUntil: "networkidle", timeout: 60000 });
  await p.waitForTimeout(4000);
  console.log(`\n━━━ 【${name} ${vp.width}x${vp.height}】 ━━━`);

  await p.evaluate(() => {
    const m = document.querySelector("#win5-mount");
    const d = m && m.closest("details"); if (d) d.open = true;
  });
  await p.waitForTimeout(1500);

  const v = await p.evaluate(() => {
    const m = document.querySelector("#win5-mount");
    if (!m) return { shown: false };
    const alphaOf = (c) => { const x = String(c || "").match(/rgba?\(([^)]+)\)/); if (!x) return 0;
      const a = x[1].split(",").map((s) => s.trim()); return a.length > 3 ? parseFloat(a[3]) : 1; };
    const g1 = (i) => { const x = String(i || "").match(/rgba?\([^)]+\)/); return x ? x[0] : null; };
    const txts = []; const w = document.createTreeWalker(m, NodeFilter.SHOW_TEXT); const ns = [];
    while (w.nextNode()) ns.push(w.currentNode);
    ns.forEach((tn) => {
      const t = (tn.nodeValue || "").trim(); if (!t) return;
      const n = tn.parentElement; if (!n) return;
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden") return;
      let bg = null, q = n;
      while (q) { const c = getComputedStyle(q);
        if (alphaOf(c.backgroundColor) > 0.98) { bg = c.backgroundColor; break; }
        const gg = g1(c.backgroundImage); if (gg && alphaOf(gg) > 0.98) { bg = gg; break; }
        q = q.parentElement; }
      if (!bg) bg = "rgb(255,255,255)";
      // SVG の中の文字は背景が図形なので DOM ではたどれない → 印だけ付けて測らない
      txts.push({ t: t.slice(0, 40), size: parseFloat(cs.fontSize), color: cs.color, bg,
        inSvg: !!(n.closest && n.closest("svg")) });
    });
    const mr = m.getBoundingClientRect();
    const btns = [...m.querySelectorAll("button,a,[role=button],.win5-strategy")].map((e) => {
      const r = e.getBoundingClientRect();
      return { t: (e.textContent || "").trim().slice(0, 20), w: Math.round(r.width), h: Math.round(r.height) };
    }).filter((x) => x.w > 0);
    return { shown: true, text: m.innerText,
      strategies: m.querySelectorAll(".win5-strategy").length,
      raceCards: m.querySelectorAll(".wsc-race,.win5-race,[class*='wsc-']").length,
      wide: [...m.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > mr.right + 2).length,
      docOver: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      txts, btns };
  });

  say(v.shown, "WIN5 が出ない");
  if (v.shown) {
    say(v.strategies >= 3, `戦略カードが足りない（${v.strategies}枚）`);
    say(v.raceCards >= 5, `5レースぶんが出ていない（${v.raceCards}個）`);
    say(v.wide === 0 && !v.docOver, `はみ出している（中${v.wide}個 / 画面${v.docOver}）`);
    const small = v.txts.filter((x) => x.size < 12);
    say(small.length === 0, `12px未満 ${small.length}個: ` + small.slice(0, 4).map((x) => x.size + "px " + x.t).join(" / "));
    const bad = []; let skippedSvg = 0;
    for (const x of v.txts) {
      if (!/^rgb/.test(x.color) || !/^rgb/.test(x.bg)) continue;
      if (!/[0-9A-Za-z\u3040-\u30FF\u4E00-\u9FFF]/.test(x.t)) continue;
      if (x.inSvg) { skippedSvg++; continue; }
      const c = ratio(x.color, x.bg);
      if (c < 4.5) bad.push(`${c.toFixed(2)}:1「${x.t}」`);
    }
    say(bad.length === 0, `読みにくい ${bad.length}個: ` + bad.slice(0, 5).join(" / "));
    if (skippedSvg) console.log(`  ❓ 図(SVG)の中の文字 ${skippedSvg}個は DOM では背景を測れず 見ていません（＝合格ではありません）`);
    const smallBtn = v.btns.filter((x) => x.h < 44);
    say(smallBtn.length === 0, `44px未満の押しどころ ${smallBtn.length}個: ` + smallBtn.slice(0, 3).map((x) => `${x.t}(${x.h}px)`).join(" / "));
    // 「EV ×63.4」のような成り立たない数字が復活していないか
    say(!/EV\s*×/.test(v.text), "「EV ×」という成り立たない数字が出ている");
    say(/当たりません|的中 0 回/.test(v.text), "WIN5 の正直な但し書きが出ていない");
    if (name === "iPhone") console.log("  ── 中身 ──\n" + v.text.split("\n").slice(0, 12).map((l) => "  | " + l).join("\n"));
    console.log(`  ・戦略 ${v.strategies}枚 / レース ${v.raceCards}個 / 文字 ${v.txts.length}個 / 押しどころ ${v.btns.length}個`);
  }
  say(errs.length === 0, "JSエラー: " + errs.slice(0, 2).join(" / "));
  await b.close();
}
console.log(`\n=== 合計: ${ok} 通過 / ${ng} 失敗 ===`);
process.exit(ng ? 1 : 0);

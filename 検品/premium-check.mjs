// 2026-08-12: 「払戻率を上げる日」のカードが 本当に出て・本当に読めるか を実ブラウザで見る。
//   使い方: node 検品/premium-check.mjs [URL]
// 🚨 この検査でいちばん大事なこと＝「読めていないのに合格」を出さないこと。
//    背景色は文字列くらべ（"rgba(0, 0, 0, 0)" の空白ちがい）で判定すると
//    全部を黒背景と誤判定して 落ちるはずのない所で落ちる／逆に見逃す。必ず alpha で見る。
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium, webkit } = require("C:/Users/shoug/棋譜検索/node_modules/playwright");
const URL_ = process.argv.slice(2).find((a) => /^https?:/.test(a)) || "http://127.0.0.1:8791/";
// --break=color|size|wide … わざと壊して「検査が本当に働くか」を見る（ブラウザ内だけ）
const BREAK = (process.argv.find((a) => a.startsWith("--break=")) || "").split("=")[1] || "";

const lum = (c) => { const [r,g,b] = c.match(/[\d.]+/g).slice(0,3).map(Number)
  .map(v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
  return 0.2126*r + 0.7152*g + 0.0722*b; };
const ratio = (a,b) => { const l1=lum(a), l2=lum(b);
  return (Math.max(l1,l2)+0.05) / (Math.min(l1,l2)+0.05); };

const PROBE = () => {
  const el = document.querySelector("#premium-mount");
  if (!el || el.hidden) return { shown:false };
  const card = el.querySelector(".premium-card");
  if (!card) return { shown:false, mounted:true };

  const alphaOf = (c) => { const m = String(c||"").match(/rgba?\(([^)]+)\)/); if (!m) return 0;
    const a = m[1].split(",").map(x=>x.trim()); return a.length>3 ? parseFloat(a[3]) : 1; };
  const firstColorOf = (img) => { const m = String(img||"").match(/rgba?\([^)]+\)/); return m ? m[0] : null; };

  // 🚨 「子要素があるから」で飛ばすと、<div>文字<b>数字</b></div> の "文字" が
  //    まるごと検査されない（実際にこれで、わざと壊した色を見のがした）。
  //    文字そのもの（テキストノード）を1つずつ辿り、その親の色で判定する。
  const txts = [];
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach((tn) => {
    const t = (tn.nodeValue||"").trim(); if (!t) return;
    const n = tn.parentElement; if (!n) return;
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.1) return;
    let bg = null, q = n;
    while (q) {                                   // 透明でない親までさかのぼる
      const c2 = getComputedStyle(q);
      if (alphaOf(c2.backgroundColor) > 0.98) { bg = c2.backgroundColor; break; }
      const g = firstColorOf(c2.backgroundImage); // グラデーションしか持たない親
      if (g && alphaOf(g) > 0.98) { bg = g; break; }
      q = q.parentElement;
    }
    if (!bg) bg = "rgb(255,255,255)";
    txts.push({ t: t.slice(0,60), size: parseFloat(cs.fontSize), color: cs.color, bg });
  });
  const cr = card.getBoundingClientRect();
  return { shown:true, mounted:true, text: card.innerText,
    width: cr.width, right: cr.right, top: cr.top + window.scrollY,
    docW: document.documentElement.clientWidth,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    txts };
};

let ng = 0, ok = 0;
const say = (good, msg) => { if (good) ok++; else { ng++; console.log("  ✕ " + msg); } };

const ONLY = process.env.PD_ONLY || "";
const DEVICES = [
  ["iPhone",  webkit,   { width: 390,  height: 844  }],
  ["iPad",    webkit,   { width: 1024, height: 1366 }],
  ["パソコン", chromium, { width: 1280, height: 900  }],
].filter(([n]) => !ONLY || n === ONLY);
for (const [name, engine, vp] of DEVICES) {
  const b = await engine.launch();
  const p = await b.newPage({ viewport: vp, deviceScaleFactor: 2 });
  const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(URL_, { waitUntil: "networkidle", timeout: 60000 });
  await p.waitForTimeout(3500);
  // --break で「検査が本当に働くか」を確かめる。
  //   ⚠ 本物の styles.polish.css は絶対に書き換えない（途中で殺されると壊れたまま残る）。
  //     ブラウザの中だけに一時的な style を差し込む＝ページを閉じれば必ず消える。
  if (BREAK) {
    await p.addStyleTag({ content:
      BREAK === "color" ? ".pd-math-key{color:#F2EDE3 !important}"
      : BREAK === "size" ? ".pd-honest{font-size:10px !important}"
      : ".premium-card{width:200vw !important}" });
    await p.waitForTimeout(300);
  }
  const r = await p.evaluate(PROBE);

  console.log(`\n【${name} ${vp.width}x${vp.height}】`);
  say(r.shown, "カードが出ていない");
  if (r.shown) {
    say(!r.overflow, "画面から横にはみ出している");
    say(r.right <= r.docW + 1, `カードが右にはみ出し (${Math.round(r.right)} > ${r.docW})`);
    const small = r.txts.filter((x) => x.size < 12);
    say(small.length === 0, `12px未満の文字 ${small.length}件: ` + small.slice(0,3).map(x=>x.size+"px "+x.t).join(" / "));
    const bad = [];
    for (const x of r.txts) {
      if (!/^rgb/.test(x.color) || !/^rgb/.test(x.bg)) continue;
      if (!/[0-9A-Za-z\u3040-\u30FF\u4E00-\u9FFF]/.test(x.t)) continue;   // 絵文字だけは対象外
      const c = ratio(x.color, x.bg);
      if (c < 4.5) bad.push(`${c.toFixed(2)}:1 「${x.t}」`);
    }
    say(bad.length === 0, `読みにくい文字 ${bad.length}件: ` + bad.slice(0,4).join(" / "));
    // 中身が本物か（＝APIの計算値がそのまま出ているか。手書きなら必ずズレる）
    say(/94\.1%/.test(r.text), "分岐点94.1%が出ていない（APIの値が届いていない）");
    say(/もどり 85%/.test(r.text), "85%が出ていない");
    say(/まだ公表されていません/.test(r.text), "未公表の説明が出ていない（「該当なし」と言い切ると嘘になる）");
    say(/負けが小さくなる日/.test(r.text), "正直な但し書きが出ていない");
    say(!/129%|\+37%/.test(r.text), "手書きの嘘の数字が混ざっている");
    if (name === "iPhone") console.log("  ── 画面の中身 ──\n" + r.text.split("\n").map(l=>"  | "+l).join("\n"));
    console.log(`  （上から ${Math.round(r.top)}px・はば ${Math.round(r.width)}px）`);
  }
  say(errs.length === 0, "JSエラー: " + errs.slice(0,2).join(" / "));
  await b.close();
}
console.log(`\n=== 合計: ${ok} 通過 / ${ng} 失敗 ===`);
if (BREAK) {
  // わざと壊したのに合格したら、それは「読めていないのに合格」＝検査の方が壊れている
  console.log(ng
    ? `✅ わざと壊した(${BREAK})のを ちゃんと見つけた＝この検査は働いている`
    : `🚨 わざと壊した(${BREAK})のに合格した＝この検査は役に立っていない`);
  process.exit(ng ? 0 : 1);
}
process.exit(ng ? 1 : 0);

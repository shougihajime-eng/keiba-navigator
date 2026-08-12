// 2026-08-12: 競馬ナビゲーター 本番の「見にくい・壊れてる・押せない」総点検。
//   使い方: node 検品/mitame-check.mjs [URL]
//     ・最初に「わざと壊す自己検証」(PC/Chromium) を走らせ、検査自体が働くことを確かめてから本番を見る
//     ・--break=contrast|size|wide|tap|dead で単独の自己検証だけ実行
//     ・--only=iPhone-WebKit などで機種を絞れる
// 🚨 この検査でいちばん大事なこと＝「読めていないのに合格」を出さないこと。
//    - 背景色は文字列くらべ禁止 → alpha で見る。gradient しか持たない親は最初の色。
//    - 子要素持ちの節を丸ごと飛ばさない → テキストノードを1つずつ辿る。
//    - わざと壊して検出できるか先に確かめる (--break)。
// 🚫 本物の CSS/JS/HTML は一切書き換えない。壊すのは page.addStyleTag / evaluate のみ（閉じれば消える）。
import { createRequire } from "module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium, webkit } = require("C:/Users/shoug/棋譜検索/node_modules/playwright");

const URL_ = process.argv.slice(2).find((a) => /^https?:/.test(a)) || "https://keiba-navigator.vercel.app/";
const BREAK = (process.argv.find((a) => a.startsWith("--break=")) || "").split("=")[1] || "";
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1] || "";
const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "_shots");
fs.mkdirSync(SHOTS, { recursive: true });

const DEVICES = [
  ["iPhone-WebKit",   webkit,   { width: 390,  height: 844  }, { isMobile: true, hasTouch: true }],
  ["iPhone-Chromium", chromium, { width: 390,  height: 844  }, { isMobile: true, hasTouch: true }],
  ["iPad-WebKit",     webkit,   { width: 1024, height: 1366 }, { hasTouch: true }],
  ["PC-Chromium",     chromium, { width: 1280, height: 900  }, {}],
];

// ─────────────────────────────────────────────────────────────
// ページの中で動かす測定器（文字・押しどころ・はみ出し）
// ─────────────────────────────────────────────────────────────
const AUDIT_FN = () => {
  const alphaOf = (c) => { const m = String(c || "").match(/rgba?\(([^)]+)\)/); if (!m) return 0;
    const a = m[1].split(",").map((x) => x.trim()); return a.length > 3 ? parseFloat(a[3]) : 1; };
  const rgbOf = (c) => { const m = String(c || "").match(/[\d.]+/g); return m ? m.slice(0, 3).map(Number) : null; };
  const firstColorOf = (img) => { const m = String(img || "").match(/rgba?\([^)]+\)/); return m ? m[0] : null; };
  const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const blend = (top, alpha, under) => top.map((v, i) => v * alpha + under[i] * (1 - alpha));

  // 要素の「実効背景」＝透明を上へさかのぼり、半透明は下と混ぜる。画像背景は null（判定不能＝飛ばす）
  const effBg = (el) => {
    const layers = []; let q = el; let hasImage = false;
    while (q && q !== document.documentElement.parentNode) {
      const cs = getComputedStyle(q);
      const bi = cs.backgroundImage || "none";
      if (/url\(/.test(bi)) { hasImage = true; break; }
      const g = firstColorOf(bi);
      if (g && alphaOf(g) > 0.02) layers.push([rgbOf(g), Math.min(1, alphaOf(g))]);
      else {
        const bc = cs.backgroundColor;
        const a = alphaOf(bc);
        if (a > 0.02) layers.push([rgbOf(bc), a]);
      }
      const last = layers[layers.length - 1];
      if (last && last[1] > 0.98) break;      // 不透明に到達
      q = q.parentElement;
    }
    if (hasImage) return null;
    let bg = [255, 255, 255];                 // 何も無ければ白（このアプリの地は明るい和紙）
    for (let i = layers.length - 1; i >= 0; i--) bg = blend(layers[i][0], layers[i][1], bg);
    return bg;
  };

  const visible = (n) => {
    let q = n;
    while (q && q.nodeType === 1) {
      const cs = getComputedStyle(q);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.1) return false;
      if (q.hidden) return false;
      q = q.parentElement;
    }
    return true;
  };

  const out = { texts: [], taps: [], overflow: null, offenders: [] };

  // ① 横はみ出し。
  // 🚨 このアプリは body{overflow-x:clip} なので scrollWidth は絶対に増えない
  //   （はみ出した中身は横スクロールではなく「切れて見えなくなる」）。
  //   → scrollWidth 比較に加えて「画面の右端より外に出ている部品」を直接さがす。
  const de = document.documentElement;
  const scrollable = (el) => {
    let q = el.parentElement;
    while (q && q !== document.body) {
      const cs = getComputedStyle(q);
      if (/(auto|scroll)/.test(cs.overflowX) && q.scrollWidth > q.clientWidth + 2) return true;
      q = q.parentElement;
    }
    return false;
  };
  const offs = []; const seenOff = new Set();
  for (const el of document.querySelectorAll("body *")) {
    if (offs.length >= 12) break;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || !(r.right > de.clientWidth + 8)) continue;   // 8px は誤差ゆるし
    if (r.left >= de.clientWidth) continue;                          // 完全に画面外（演出用）は別物
    if (!visible(el)) continue;
    if (scrollable(el)) continue;                                    // 横スクロール箱の中は正常
    const sel = el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/).slice(0, 2).join(".") : "");
    if (seenOff.has(sel)) continue;
    seenOff.add(sel);
    offs.push({ sel, right: Math.round(r.right), text: (el.textContent || "").trim().slice(0, 24) });
  }
  offs.sort((a, b) => b.right - a.right);
  out.offenders = offs.slice(0, 6);
  out.overflow = { scrollW: de.scrollWidth, clientW: de.clientWidth,
    bad: de.scrollWidth > de.clientWidth + 1 || offs.length > 0 };

  // ②③ 文字（コントラスト・小ささ）— テキストノードを1つずつ
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (tn) => {
      const p = tn.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") return NodeFilter.FILTER_REJECT;
      if (!(tn.nodeValue || "").trim()) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let count = 0;
  while (walker.nextNode() && count < 5000) {
    const tn = walker.currentNode;
    const p = tn.parentElement;
    if (!visible(p)) continue;
    const rects = tn.parentElement.getClientRects();
    if (!rects.length) continue;
    const t = tn.nodeValue.trim();
    if (!/[0-9A-Za-z\u3040-\u30FF\u4E00-\u9FFF]/.test(t)) continue;   // 絵文字・記号だけは対象外
    const cs = getComputedStyle(p);
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const fg0 = rgbOf(cs.color);
    if (!fg0) continue;
    const bg = effBg(p);
    let cr = null;
    if (bg) {
      const fa = alphaOf(cs.color);
      const fg = fa < 0.98 ? blend(fg0, fa, bg) : fg0;
      cr = ratio(fg, bg);
    }
    const sel = p.tagName.toLowerCase() + (p.className && typeof p.className === "string" ? "." + p.className.split(/\s+/).slice(0, 2).join(".") : "");
    out.texts.push({ t: t.slice(0, 40), sel, size: Math.round(size * 10) / 10, weight, cr: cr == null ? null : Math.round(cr * 100) / 100, big: size >= 24 || (size >= 18.5 && weight >= 700) });
    count++;
  }

  // ④ 押しどころの大きさ
  const taps = document.querySelectorAll("button, a[href], [role='button'], summary, select, input:not([type=hidden]), textarea");
  for (const el of taps) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.width < 44 || r.height < 44) {
      const sel = el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/).slice(0, 2).join(".") : "") + (el.id ? "#" + el.id : "");
      out.taps.push({ sel, w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || "").trim().slice(0, 20) });
    }
  }
  return out;
};

// 画面下のナビに隠される物がないか（いちばん下までスクロールした状態で測る）。
// 🚨 main の箱の下端で測ると「余白(padding)」まで中身あつかいして誤検出する。
//    → 本物の中身＝main の直接の子の下端で測り、さらに縦・横の両方が重なる時だけ問題にする。
//    （PC ではナビが右端の縦フローティングになる＝横が重ならなければ無罪）
const OVERLAP_FN = () => {
  window.scrollTo(0, document.body.scrollHeight);
  const nav = document.querySelector(".bottom-nav");
  if (!nav) return { hasNav: false };
  const nr = nav.getBoundingClientRect();
  const xOverlap = (r) => r.right > nr.left + 2 && r.left < nr.right - 2;
  const covered = [];
  const els = document.querySelectorAll("button, a[href], summary, select, input:not([type=hidden])");
  for (const el of els) {
    if (nav.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cy >= nr.top && cy <= nr.bottom && xOverlap(r)) {
      const top = document.elementFromPoint(Math.min(cx, innerWidth - 2), cy);
      if (top && nav.contains(top)) covered.push({ sel: el.tagName.toLowerCase() + "#" + (el.id || "") + "." + String(el.className || "").split(/\s+/)[0], text: (el.textContent || "").trim().slice(0, 20) });
    }
  }
  const main = document.querySelector("main");
  let lastContentBottom = null;
  if (main) {
    for (const ch of main.children) {
      const r = ch.getBoundingClientRect();
      if (r.height > 0) lastContentBottom = Math.max(lastContentBottom ?? -1e9, Math.round(r.bottom));
    }
  }
  const navFullWidth = nr.width > innerWidth * 0.8;   // スマホ型（横いっぱいのナビ）だけ下端判定が意味を持つ
  const coveredForever = navFullWidth && lastContentBottom != null && lastContentBottom > nr.top + 4;
  return { hasNav: true, navTop: Math.round(nr.top), navFullWidth, lastContentBottom, coveredForever, covered: covered.slice(0, 6) };
};

// ─────────────────────────────────────────────────────────────
// 集計ヘルパ
// ─────────────────────────────────────────────────────────────
function summarizeTexts(texts) {
  const lowC = [], small = [];
  const seenC = new Map(), seenS = new Map();
  for (const x of texts) {
    if (x.size < 12) {
      const k = `${x.sel}|${x.size}`;
      if (!seenS.has(k)) { seenS.set(k, 0); small.push(x); }
      seenS.set(k, seenS.get(k) + 1);
    }
    if (x.cr != null) {
      const th = x.big ? 3.0 : 4.5;
      if (x.cr < th) {
        const k = `${x.sel}|${Math.round(x.cr * 10)}`;
        if (!seenC.has(k)) { seenC.set(k, 0); lowC.push(x); }
        seenC.set(k, seenC.get(k) + 1);
      }
    }
  }
  return { lowC, small, cCounts: seenC, sCounts: seenS };
}
function dedupTaps(taps) {
  const seen = new Map();
  for (const t of taps) {
    const k = t.sel.replace(/#.*$/, "") || t.sel;
    if (!seen.has(k)) seen.set(k, { ...t, count: 0 });
    seen.get(k).count++;
  }
  return [...seen.values()];
}

let NG = 0, OK = 0;
const say = (good, msg) => { if (good) { OK++; } else { NG++; console.log("  ✕ " + msg); } };
const info = (msg) => console.log("  ・" + msg);

async function newPage(engine, vp, opts) {
  const b = await engine.launch();
  const p = await b.newPage({ viewport: vp, deviceScaleFactor: 2, ...opts });
  p.on("dialog", (d) => d.dismiss().catch(() => {}));
  return [b, p];
}

// ─────────────────────────────────────────────────────────────
// 自己検証: わざと壊して、検査が見つけられるか（見つけられない検査は捨てる）
// ─────────────────────────────────────────────────────────────
async function runBreakTest(mode) {
  const vp = mode === "cover" ? { width: 390, height: 844 } : { width: 1280, height: 900 };
  const [b, p] = await newPage(chromium, vp, {});
  try {
    await p.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
    await p.waitForTimeout(3000);
    if (mode === "contrast") await p.addStyleTag({ content: ".nm-tag{color:#F6E8D6 !important}" });
    if (mode === "size")     await p.addStyleTag({ content: ".nm-tag{font-size:9px !important}" });
    if (mode === "wide")     await p.addStyleTag({ content: "main.app-root{min-width:150vw !important}" });
    if (mode === "tap")      await p.addStyleTag({ content: ".refresh-btn{width:20px !important;height:20px !important;min-width:0 !important;min-height:0 !important;padding:0 !important}" });
    if (mode === "cover")    await p.addStyleTag({ content: "main.app-root{padding-bottom:0 !important}" });   // 下ナビの逃げ余白を消す＝中身が隠れるはず
    if (mode === "dead") {
      // summary のクリックを横取りして「開かない折りたたみ」を作る（ページ内だけ・本物は無傷）
      await p.evaluate(() => {
        const s = document.querySelector("details.hideable-news summary");
        if (s) s.addEventListener("click", (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
      });
    }
    await p.waitForTimeout(300);

    let found = false;
    if (mode === "cover") {
      const ov = await p.evaluate(OVERLAP_FN);
      found = !!(ov.coveredForever || (ov.covered && ov.covered.length));
    } else if (mode === "dead") {
      await p.evaluate(() => document.querySelector("details.hideable-news summary")?.click());
      await p.waitForTimeout(400);
      const open = await p.evaluate(() => !!document.querySelector("details.hideable-news")?.open);
      found = !open;   // 開かなかった＝死にボタンを検出できた
    } else {
      const a = await p.evaluate(AUDIT_FN);
      if (mode === "wide") found = a.overflow.bad;
      if (mode === "contrast") {
        const s = summarizeTexts(a.texts);
        found = s.lowC.some((x) => x.sel.includes("nm-tag"));
      }
      if (mode === "size") {
        const s = summarizeTexts(a.texts);
        found = s.small.some((x) => x.sel.includes("nm-tag"));
      }
      if (mode === "tap") found = a.taps.some((x) => x.sel.includes("refresh-btn"));
    }
    console.log(found
      ? `  ✅ わざと壊した(${mode})のを ちゃんと見つけた`
      : `  🚨 わざと壊した(${mode})のに見つけられなかった＝この検査は役に立たない`);
    return found;
  } finally { await b.close(); }
}

// ─────────────────────────────────────────────────────────────
// 本番の総点検（1機種ぶん）
// ─────────────────────────────────────────────────────────────
async function auditDevice(name, engine, vp, opts, resultBag) {
  const [b, p] = await newPage(engine, vp, opts);
  const jsErrors = [], consoleErrors = [];
  p.on("pageerror", (e) => jsErrors.push(String(e).slice(0, 160)));
  p.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160)); });
  const dev = { name, vp, problems: [], notes: [] };
  resultBag.push(dev);
  console.log(`\n━━━ 【${name} ${vp.width}x${vp.height}】 ━━━`);
  try {
    // ⑨ 読み込みの速さ
    const t0 = Date.now();
    await p.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
    const tDom = Date.now() - t0;
    await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    const tIdle = Date.now() - t0;
    await p.waitForTimeout(3500);
    const paint = await p.evaluate(() => {
      const e = performance.getEntriesByType("paint").find((x) => x.name === "first-contentful-paint");
      return e ? Math.round(e.startTime) : null;
    });
    dev.speed = { domMs: tDom, idleMs: tIdle, fcpMs: paint };
    info(`読み込み: 骨組み ${tDom}ms / 最初の描画 ${paint != null ? paint + "ms" : "?"} / 落ち着くまで ${tIdle}ms`);
    say(tDom < 5000, `読み込みが遅い (骨組みまで ${tDom}ms)`);

    await p.screenshot({ path: path.join(SHOTS, `01_初期_${name}.png`), fullPage: true });

    // ⑧ 中身が空の日の見え方（開催なし想定）
    dev.empty = await p.evaluate(() => {
      const g = (s) => (document.querySelector(s)?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300);
      return {
        decision: g("#decision-mount"),
        premiumShown: !document.querySelector("#premium-mount")?.hidden,
        premium: g("#premium-mount").slice(0, 120),
        honest: g("#honest-record-mount").slice(0, 200),
        raceRows: document.querySelectorAll(".race-row").length,
        raceCountHint: g("#all-races-count-hint"),
      };
    });
    info(`開催なしの画面: レース行 ${dev.empty.raceRows} 件 / 払戻率カード ${dev.empty.premiumShown ? "表示" : "非表示"}`);

    // ⑥ 死にボタン: 折りたたみを全部あけ、あかない物を数える（あとの文字検査のためにも全部あける）
    const detailsRes = await p.evaluate(async () => {
      const bad = [];
      const list = document.querySelectorAll("details.hideable");
      for (const d of list) {
        const s = d.querySelector("summary");
        if (!s) continue;
        s.click();
        await new Promise((r) => setTimeout(r, 120));
        const secs = [...d.querySelectorAll("section")];
        const h = Math.max(0, ...secs.map((x) => x.getBoundingClientRect().height));
        const title = (s.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24);
        if (!d.open) bad.push({ title, why: "開かない" });
        else if (h < 8) {
          const hiddenAll = secs.length > 0 && secs.every((x) => x.hidden);
          bad.push({ title, why: hiddenAll ? "開いても中身が hidden のまま＝真っ白" : "開いても中身の高さ0" });
        }
      }
      return { total: list.length, bad };
    });
    say(detailsRes.bad.length === 0, `開かない/空の折りたたみ ${detailsRes.bad.length}件: ` + detailsRes.bad.map((x) => `${x.title}(${x.why})`).join(" / "));
    dev.details = detailsRes;
    await p.waitForTimeout(800);

    // ①②③④ 全部ひらいた状態で文字・押しどころ・はみ出しを実測
    const a = await p.evaluate(AUDIT_FN);
    const s = summarizeTexts(a.texts);
    dev.audit = { overflow: a.overflow, offenders: a.offenders, textCount: a.texts.length,
      lowContrast: s.lowC.map((x) => ({ ...x, count: s.cCounts.get(`${x.sel}|${Math.round(x.cr * 10)}`) })),
      smallFonts: s.small.map((x) => ({ ...x, count: s.sCounts.get(`${x.sel}|${x.size}`) })),
      smallTaps: dedupTaps(a.taps) };
    say(!a.overflow.bad, `横にはみ出し (${a.overflow.scrollW} > ${a.overflow.clientW}) 犯人候補: ` + a.offenders.map((o) => `${o.sel}→右端${o.right}px`).join(" / "));
    say(dev.audit.lowContrast.length === 0, `読みにくい文字 ${dev.audit.lowContrast.length}種: ` + dev.audit.lowContrast.slice(0, 6).map((x) => `${x.cr}:1「${x.t}」(${x.sel})`).join(" / "));
    say(dev.audit.smallFonts.length === 0, `12px未満の文字 ${dev.audit.smallFonts.length}種: ` + dev.audit.smallFonts.slice(0, 6).map((x) => `${x.size}px「${x.t}」(${x.sel})`).join(" / "));
    say(dev.audit.smallTaps.length === 0, `44px未満の押しどころ ${dev.audit.smallTaps.length}種: ` + dev.audit.smallTaps.slice(0, 8).map((x) => `${x.sel} ${x.w}x${x.h}「${x.text}」`).join(" / "));
    info(`文字ノード ${a.texts.length} 個を検査`);
    await p.screenshot({ path: path.join(SHOTS, `02_全部ひらいた_${name}.png`), fullPage: true });

    // ⑥ 下ナビの4ボタン
    const navRes = { list: [] };
    // 「本日」: 下までスクロール後、上（＝本日の予想カード）へ戻るか
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await p.waitForTimeout(400);
    const yBottom = await p.evaluate(() => window.scrollY);
    await p.evaluate(() => document.querySelector('.bottom-nav__item[data-tab="home"]')?.click());
    await p.waitForTimeout(2500);   // smooth スクロールの完走を待つ
    const homeRes = await p.evaluate(() => {
      const r = document.querySelector("#decision-mount")?.getBoundingClientRect();
      return { y: window.scrollY, inView: !!(r && r.top > -80 && r.top < innerHeight * 0.8) };
    });
    const backTop = homeRes.inView || homeRes.y < Math.max(0, yBottom - 300);
    navRes.list.push({ tab: "本日", ok: backTop, why: backTop ? "" : `押しても上に戻らない (scrollY ${yBottom}→${homeRes.y}・予想カード見えてる=${homeRes.inView})` });
    // 「WIN5」: セクションへ移動 or トースト
    await p.evaluate(() => document.querySelector('.bottom-nav__item[data-tab="win5"]')?.click());
    await p.waitForTimeout(900);
    const w5 = await p.evaluate(() => ({ toast: !document.querySelector("#toast")?.hidden, y: window.scrollY }));
    navRes.list.push({ tab: "WIN5", ok: w5.toast || w5.y > 0, why: w5.toast || w5.y > 0 ? "" : "押しても何も起きない" });
    await p.waitForTimeout(2600);
    // 「履歴」
    const yBefore = await p.evaluate(() => { window.scrollTo(0, 0); return 0; });
    await p.waitForTimeout(300);
    await p.evaluate(() => document.querySelector('.bottom-nav__item[data-tab="history"]')?.click());
    await p.waitForTimeout(1200);
    const hist = await p.evaluate(() => {
      const card = document.getElementById("profit-grid")?.closest(".section-card");
      const r = card ? card.getBoundingClientRect() : null;
      return { y: window.scrollY, visible: !!(r && r.height > 0 && r.top < innerHeight && r.bottom > 0) };
    });
    navRes.list.push({ tab: "履歴", ok: hist.y > 100 && hist.visible, why: hist.y > 100 && hist.visible ? "" : `押しても履歴が見えない (scrollY=${hist.y}, 見えてる=${hist.visible})` });
    // 「手動入力」: モーダルが開く
    await p.evaluate(() => document.querySelector('.bottom-nav__item[data-tab="add"]')?.click());
    await p.waitForTimeout(600);
    const addOpen = await p.evaluate(() => !document.querySelector("#modal-add-bet")?.hidden);
    navRes.list.push({ tab: "手動入力", ok: addOpen, why: addOpen ? "" : "モーダルが開かない" });
    dev.nav = navRes;
    for (const n of navRes.list) say(n.ok, `下ナビ「${n.tab}」が死にボタン: ${n.why}`);

    // モーダルの中の文字・押しどころも検査 + スクショ + 閉じる
    if (addOpen) {
      const am = await p.evaluate(AUDIT_FN);
      const asum = summarizeTexts(am.texts);   // モーダル表示中の全文字（モーダル分は sel で絞る）
      await p.screenshot({ path: path.join(SHOTS, `03_手動入力モーダル_${name}.png`) });
      const modalLow = asum.lowC.filter((x) => /modal|form-|label|hint/.test(x.sel));
      say(modalLow.length === 0, `手動入力モーダルに読みにくい文字 ${modalLow.length}種: ` + modalLow.slice(0, 4).map((x) => `${x.cr}:1「${x.t}」`).join(" / "));
      await p.evaluate(() => document.querySelector("#add-close")?.click());
      await p.waitForTimeout(300);
      const closed = await p.evaluate(() => document.querySelector("#modal-add-bet")?.hidden);
      say(closed, "手動入力モーダルの×で閉じられない");
    }

    // ⑥ 全レースの絞り込みチップ
    const chipRes = await p.evaluate(async () => {
      const d = document.querySelector("details.hideable-all-races");
      if (d && !d.open) { d.querySelector("summary")?.click(); await new Promise((r) => setTimeout(r, 200)); }
      const out = [];
      for (const c of document.querySelectorAll(".chip-filter[data-filter]")) {
        c.click();
        await new Promise((r) => setTimeout(r, 150));
        out.push({ label: (c.textContent || "").trim(), active: c.classList.contains("is-active") });
      }
      return out;
    });
    const chipBad = chipRes.filter((c) => !c.active);
    say(chipBad.length === 0, `絞り込みチップが反応しない: ` + chipBad.map((c) => c.label).join(" / "));

    // ⑥ 更新ボタン → /api への通信が走るか
    const reqPromise = p.waitForRequest((r) => r.url().includes("/api/"), { timeout: 5000 }).catch(() => null);
    await p.evaluate(() => document.querySelector("#refresh-btn")?.click());
    const gotReq = await reqPromise;
    say(!!gotReq, "「↻ 今すぐ更新」ボタンを押しても通信が走らない（死にボタンの疑い）");

    // ⑥ レース詳細モーダル（レース行があるときだけ＝火曜は0件想定）
    const rowCount = await p.evaluate(() => document.querySelectorAll(".race-row").length);
    if (rowCount > 0) {
      await p.evaluate(() => document.querySelector(".race-row")?.click());
      await p.waitForTimeout(2500);
      const md = await p.evaluate(() => ({
        open: !document.querySelector("#modal-race-detail")?.hidden,
        tabs: [...document.querySelectorAll(".rh-tab")].map((t) => (t.textContent || "").trim()),
      }));
      say(md.open, "レース行を押しても詳細モーダルが開かない");
      dev.raceModal = { opened: md.open, tabs: md.tabs, tabResults: [] };
      if (md.open) {
        await p.screenshot({ path: path.join(SHOTS, `04_レース詳細_${name}.png`) });
        // タブを順に押して、切り替わるか + 中身が空でないか
        const tabIds = await p.evaluate(() => [...document.querySelectorAll(".rh-tab")].map((t) => t.dataset.tab));
        for (const tid of tabIds) {
          await p.evaluate((id) => document.querySelector(`#rh-tab-${id}`)?.click(), tid);
          await p.waitForTimeout(1800);
          const r = await p.evaluate((id) => {
            const panel = document.querySelector(`#rh-panel-${id}`);
            const on = document.querySelector(`#rh-tab-${id}`)?.classList.contains("rh-tab-on");
            return { on: !!on, shown: !!(panel && !panel.hidden), text: (panel?.innerText || "").replace(/\s+/g, " ").slice(0, 60), h: panel ? panel.getBoundingClientRect().height : 0 };
          }, tid);
          dev.raceModal.tabResults.push({ tid, ...r });
          say(r.on && r.shown && r.h > 20, `詳細モーダルのタブ「${tid}」が切り替わらない/中身が空 (高さ${Math.round(r.h)}px)`);
          await p.screenshot({ path: path.join(SHOTS, `04_詳細タブ_${tid}_${name}.png`) });
        }
        // モーダルの中の横はみ出し（表が広い）
        const mOv = await p.evaluate(() => {
          const card = document.querySelector("#modal-race-detail .modal-card");
          if (!card) return null;
          const bad = [];
          for (const el of card.querySelectorAll("*")) {
            const r = el.getBoundingClientRect();
            if (r.right > card.getBoundingClientRect().right + 4 && r.width > 30) {
              const inScroll = el.closest(".rh-scroll, .umb-scroll, [style*='overflow']");
              if (!inScroll) bad.push(el.tagName.toLowerCase() + "." + String(el.className || "").split(/\s+/)[0]);
            }
            if (bad.length > 4) break;
          }
          return bad;
        });
        say(!mOv || mOv.length === 0, `詳細モーダルからはみ出す部品: ` + (mOv || []).join(" / "));
        await p.evaluate(() => document.querySelector("#md-close")?.click());
        await p.waitForTimeout(300);
        const mdClosed = await p.evaluate(() => document.querySelector("#modal-race-detail")?.hidden);
        say(mdClosed, "詳細モーダルの×で閉じられない");
      }
    } else {
      info("レース行 0 件（開催なし日）→ 詳細モーダルの検査は次の開催日に");
      dev.raceModal = { opened: false, reason: "no-races" };
    }

    // ⑦ 下ナビに隠される物
    const ov = await p.evaluate(OVERLAP_FN);
    dev.overlap = ov;
    if (ov.hasNav) {
      say(!ov.coveredForever, `いちばん下までスクロールしても中身の下端(${ov.lastContentBottom}px)がナビ(上端${ov.navTop}px)に隠れたまま`);
      say(ov.covered.length === 0, `下ナビに隠れて押せない物: ` + ov.covered.map((c) => `${c.sel}「${c.text}」`).join(" / "));
    }

    // ⑤ JSエラー
    dev.jsErrors = [...new Set(jsErrors)];
    dev.consoleErrors = [...new Set(consoleErrors)].slice(0, 8);
    say(dev.jsErrors.length === 0, `JSエラー ${dev.jsErrors.length}件: ` + dev.jsErrors.slice(0, 3).join(" / "));
    if (dev.consoleErrors.length) info(`コンソールのエラー出力 ${dev.consoleErrors.length}種 (参考): ` + dev.consoleErrors.slice(0, 3).join(" / "));

    // 外部リンク（PC でだけ・押される前に生死を見る）
    if (name === "PC-Chromium") {
      const hrefs = await p.evaluate(() => [...new Set([...document.querySelectorAll("a[href^='http']")].map((a) => a.href))].slice(0, 10));
      dev.externalLinks = [];
      for (const u of hrefs) {
        try {
          const r = await fetch(u, { method: "GET", headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow", signal: AbortSignal.timeout(10000) });
          dev.externalLinks.push({ u, status: r.status });
          say(r.status < 400, `外部リンクが死んでいる: ${u} → ${r.status}`);
        } catch (e) { dev.externalLinks.push({ u, status: "ERR" }); info(`外部リンク確認できず: ${u}`); }
      }
      if (!hrefs.length) info("外部リンクは画面に 0 件");
    }
  } catch (e) {
    NG++;
    console.log("  ✕ この機種の検査が途中で止まった: " + String(e && e.message).slice(0, 200));
    dev.fatal = String(e && e.message).slice(0, 200);
  } finally {
    await b.close();
  }
}

// ─────────────────────────────────────────────────────────────
// 実行
// ─────────────────────────────────────────────────────────────
if (BREAK) {
  const ok = await runBreakTest(BREAK);
  process.exit(ok ? 0 : 1);
}

console.log("═══ ステップ1: 検査そのものの自己検証（わざと壊して見つかるか）═══");
let selfOk = true;
for (const m of ["contrast", "size", "wide", "tap", "dead", "cover"]) {
  const r = await runBreakTest(m);
  selfOk = selfOk && r;
}
if (!selfOk) {
  console.log("\n🚨 自己検証に失敗した検査がある＝結果を信用できないので、ここで止める");
  process.exit(1);
}

console.log("\n═══ ステップ2: 本番の総点検 ═══");
const results = [];
for (const [name, engine, vp, opts] of DEVICES) {
  if (ONLY && name !== ONLY) continue;
  await auditDevice(name, engine, vp, opts, results);
}

fs.writeFileSync(path.join(SHOTS, "mitame-結果.json"), JSON.stringify({ url: URL_, when: new Date().toISOString(), results }, null, 2), "utf8");
console.log(`\n=== 合計: ${OK} 通過 / ${NG} 検出 ===`);
console.log(`くわしい生データ: 検品/_shots/mitame-結果.json / 画面写真: 検品/_shots/`);
process.exit(0);   // 検出があっても報告書づくりが仕事なので 0 で終える

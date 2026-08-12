// 2026-08-12: レース詳細（馬柱・オッズ推移・調教）が画面に本当に出るかを実ブラウザで見る。
//   ⚠ 開催なしの日は画面にレース行が0件なので、**誰も一度も見ていない**。
//     そこで /api/races に本物のレースを1件だけ差し込んで、モーダルを開いて確かめる。
//   使い方: node 検品/modal-check.mjs [raceId]
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { webkit, chromium } = require("C:/Users/shoug/棋譜検索/node_modules/playwright");
const RID = process.argv.find(a => /^\d{18}$/.test(a)) || "202608090702061200";
const BASE = process.argv.find(a => /^https?:/.test(a)) || "http://127.0.0.1:8791";

const lum=(c)=>{const[r,g,b]=c.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*r+.7152*g+.0722*b};
const ratio=(a,b)=>{const l1=lum(a),l2=lum(b);return (Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05)};

let ng=0, ok=0;
const say=(g,m)=>{ if(g){ok++} else {ng++; console.log("  ✕ "+m)} };

for (const [name, engine, vp] of [
  ["iPhone", webkit,  {width:390,height:844}],
  ["iPad",   webkit,  {width:1024,height:1366}],
  ["パソコン", chromium,{width:1280,height:900}],
]) {
  const b = await engine.launch();
  const p = await b.newPage({viewport:vp, deviceScaleFactor:2});
  const errs=[]; p.on("pageerror",e=>errs.push(String(e)));

  // 本物のレースを1件だけ /api/races に差し込む（開催なしの日でもモーダルまで行けるように）
  const raceRes = await (await fetch(`${BASE}/api/race?id=${RID}`)).json();
  await p.route("**/api/races", async (route) => {
    const r = await route.fetch(); let j={};
    try { j = await r.json(); } catch {}
    const one = raceRes.race || {};
    j.ok = true;
    j.races = [{ ...one, raceId: RID, race_id: RID,
      conclusion: raceRes.conclusion || null }];
    route.fulfill({status:200, contentType:"application/json", body: JSON.stringify(j)});
  });

  await p.goto(BASE+"/", {waitUntil:"networkidle", timeout:60000});
  await p.waitForTimeout(4000);

  console.log(`\n━━━ 【${name} ${vp.width}x${vp.height}】 ━━━`);
  const rows = await p.evaluate(()=>document.querySelectorAll(".race-row").length);
  say(rows>0, `レース行が出ない（差し込みが効いていない）`);
  if (rows === 0) { await b.close(); continue; }

  await p.evaluate(()=>{ const r=document.querySelector(".race-row"); r && r.click(); });
  await p.waitForTimeout(3500);

  const m = await p.evaluate(()=>{
    // 🚨 `.modal-body` で拾うと **WIN5の編集画面**（DOMには居るが隠れている）を掴む。
    //    レース詳細は #modal-race-detail の中の #md-body（実コードで確認）。
    const md = document.querySelector("#modal-race-detail");
    const body = document.querySelector("#md-body");
    if (!body || !md || md.hidden) return {open:false, hidden: md ? md.hidden : null};
    const tabs = [...body.querySelectorAll(".rh-tab,[data-rh-tab],.rh-nav button,.rh-tabs button")].map(t=>t.textContent.trim());
    const alphaOf=(c)=>{const x=String(c||"").match(/rgba?\(([^)]+)\)/);if(!x)return 0;const a=x[1].split(",").map(s=>s.trim());return a.length>3?parseFloat(a[3]):1};
    const g1=(i)=>{const x=String(i||"").match(/rgba?\([^)]+\)/);return x?x[0]:null};
    const txts=[]; const w=document.createTreeWalker(body, NodeFilter.SHOW_TEXT); const ns=[];
    while(w.nextNode()) ns.push(w.currentNode);
    ns.forEach(tn=>{ const t=(tn.nodeValue||"").trim(); if(!t) return;
      const n=tn.parentElement; if(!n) return;
      const cs=getComputedStyle(n);
      if(cs.display==="none"||cs.visibility==="hidden") return;
      let bg=null,q=n;
      while(q){const c=getComputedStyle(q);
        if(alphaOf(c.backgroundColor)>.98){bg=c.backgroundColor;break}
        const gg=g1(c.backgroundImage); if(gg&&alphaOf(gg)>.98){bg=gg;break}
        q=q.parentElement}
      if(!bg) bg="rgb(255,255,255)";
      txts.push({t:t.slice(0,40), size:parseFloat(cs.fontSize), color:cs.color, bg});
    });
    const br=body.getBoundingClientRect();
    return { open:true, text: body.innerText.slice(0,2000), tabs,
      svgs: body.querySelectorAll("svg").length,
      tables: body.querySelectorAll("table").length,
      wide: [...body.querySelectorAll("*")].filter(e=>e.getBoundingClientRect().right > br.right+2).length,
      txts };
  });

  say(m.open, "モーダルが開かない");
  if (m.open) {
    say(m.wide===0, `モーダルからはみ出している部品 ${m.wide}個`);
    const small=m.txts.filter(x=>x.size<12);
    say(small.length===0, `12px未満の文字 ${small.length}個: `+small.slice(0,3).map(x=>x.size+"px "+x.t).join(" / "));
    const bad=[];
    for(const x of m.txts){ if(!/^rgb/.test(x.color)||!/^rgb/.test(x.bg)) continue;
      if(!/[0-9A-Za-z\u3040-\u30FF\u4E00-\u9FFF]/.test(x.t)) continue;
      const c=ratio(x.color,x.bg); if(c<4.5) bad.push(`${c.toFixed(2)}:1「${x.t}」`); }
    say(bad.length===0, `読みにくい文字 ${bad.length}個: `+bad.slice(0,4).join(" / "));
    say(/プリュスエクラ|馬柱|過去|オッズ/.test(m.text), "馬柱やオッズの中身が出ていない");
    console.log(`  ・タブ ${m.tabs.length}個: ${m.tabs.join(" / ") || "(なし)"}`);
    console.log(`  ・表 ${m.tables}個・図(SVG) ${m.svgs}個・文字ノード ${m.txts.length}個`);
    if (name==="iPhone") console.log("  ── 中身のはじめ ──\n"+m.text.split("\n").slice(0,14).map(l=>"  | "+l).join("\n"));

    // タブを1つずつ押して、**その中身が本当に描かれているか**を確かめる。
    // 🚨 「文字数が50より多い」だけでは弱い。馬柱は表・オッズは折れ線が要る。
    //    中身が無いのに合格を出すと、この検査は役に立たない。
    if (m.tabs.length > 1) {
      for (let i=0;i<m.tabs.length;i++){
        await p.evaluate((idx)=>{ const t=[...document.querySelectorAll("#md-body .rh-tab,#md-body [data-rh-tab],#md-body .rh-nav button,#md-body .rh-tabs button")][idx]; t&&t.click(); }, i);
        await p.waitForTimeout(1200);
        const a = await p.evaluate(()=>{
          const b=document.querySelector("#md-body");
          const svgs=[...b.querySelectorAll("svg")];
          return { len:b.innerText.length,
            rows: b.querySelectorAll("table tr, .uma-row, .rh-uma-row, [class*='row']").length,
            tables: b.querySelectorAll("table").length,
            svgs: svgs.length,
            paths: svgs.reduce((n,s)=>n+s.querySelectorAll("path,polyline,line,circle,rect").length,0),
            txt: b.innerText.replace(/\s+/g," ").slice(0,110) };
        });
        const label = m.tabs[i];
        say(a.len>50, `タブ「${label}」の中身が空（${a.len}文字）`);
        if (/馬柱/.test(label)) {
          say(a.tables>0 || a.rows>=8, `タブ「馬柱」に表が無い（表${a.tables}個・行${a.rows}個）`);
        }
        if (/オッズ/.test(label)) {
          say(a.svgs>0, `タブ「オッズ」に図が無い（SVG ${a.svgs}個）`);
          say(a.paths>=3, `タブ「オッズ」の図に線が無い（${a.paths}本）`);
        }
        if (/出馬表/.test(label)) {
          say(a.rows>=8, `タブ「出馬表」に馬が並んでいない（行${a.rows}個）`);
        }
        if (name==="iPhone") console.log(`    ${label}: ${a.len}文字 表${a.tables} 行${a.rows} 図${a.svgs}(線${a.paths})`);
      }
    }
  }
  say(errs.length===0, "JSエラー: "+errs.slice(0,2).join(" / "));
  await b.close();
}
console.log(`\n=== 合計: ${ok} 通過 / ${ng} 失敗 ===`);
process.exit(ng?1:0);

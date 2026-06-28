const fs=require("fs");
const ROOT="C:/Users/shoug/競馬";
const cal=require(ROOT+"/data/jv_cache/place_calibration.json").bins;
function calWin(p){if(p<=cal[0].pMax)return cal[0].win;for(const b of cal){if(p<=b.pMax)return b.win;}return cal[cal.length-1].win;}
const dir=ROOT+"/data/jv_cache/results/";
const files=fs.readdirSync(dir).filter(f=>f.endsWith(".json"));
// 「市場de-vig→較正勝率」だけで EV=勝率×オッズ を作り、EV>=閾値&オッズ<=50 を買う単勝バックテスト
function run(TH){
  let bets=0,ret=0,hit=0,races=0;
  for(const f of files){
    let res;try{res=JSON.parse(fs.readFileSync(dir+f,"utf8"));}catch{continue;}
    const rs=(res.results||[]).filter(r=>Number(r.win_odds)>1&&Number(r.rank)>=1);
    if(rs.length<2)continue;
    const sum=rs.reduce((a,r)=>a+1/r.win_odds,0);if(!(sum>0))continue;
    races++;
    // 較正勝率をレース内で正規化
    const cw=rs.map(r=>({...r,p:calWin((1/r.win_odds)/sum)}));
    const cs=cw.reduce((a,r)=>a+r.p,0);
    for(const r of cw){
      const prob=cs>0?r.p/cs:0;const ev=prob*r.win_odds;
      if(r.win_odds<=50&&ev>=TH){bets++;if(Number(r.rank)===1){hit++;ret+=r.win_odds;}}
    }
  }
  const roi=bets>0?((ret*1.0-bets)/bets*100):0; // 100円ずつ
  return{TH,races,bets,hit,hitPct:bets?(hit/bets*100).toFixed(1):0,roi:roi.toFixed(1)};
}
console.log("単勝バックテスト(過去全レース・市場較正のみ・モデル無し)");
for(const th of [1.0,1.05,1.1,1.2,1.3,1.5]){const x=run(th);console.log(`EV>=${x.TH}: 買い${x.bets}点 的中${x.hit}(${x.hitPct}%) 回収率${x.roi}%`);}

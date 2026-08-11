// ============================================================
// 「本命の答え合わせ」ログを作る。
//   直近の決着済みレースについて、今のモデルの本命(いちばん勝ちそうな馬)が
//   実際に 1着 / 3着以内 に入ったかを集計し、data/jv_cache/honmei_log.json に書く。
//   フロントはこれを読んで「最近の本命の成績(正直な答え合わせ)」を表示する。
//
// ★正直さ: バックテスト(backtest-honmei.cjs)と同じ方法で本命を出す。
//   過去レースは事前オッズが無いことが多いので、結果ファイルの確定オッズを差し込んで
//   「締切直前に本命を出していたら」を再現する。嘘をつかないための統一手順。
//
// 使い方: node scripts/build-honmei-log.cjs [件数(既定150)]
//   precompute_predictions.js から stale 時のみ呼ばれる(1日1回程度)。
// ============================================================
"use strict";
const fs = require("fs");
const path = require("path");
const { buildConclusion } = require(path.join(__dirname, "..", "lib", "conclusion.js"));

const ROOT = path.resolve(__dirname, "..");
const RACES = path.join(ROOT, "data", "jv_cache", "races");
const RESULTS = path.join(ROOT, "data", "jv_cache", "results");
const OUT = path.join(ROOT, "data", "jv_cache", "honmei_log.json");

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

// 「本命を全レース買ったら」の本当の回収率(単勝/複勝)を、結果確定の全レースで計算する。
// 本命=オッズ最小(50倍超は除外＝アプリのODDS_CAPと同じ。βは0なのでアプリ本命とほぼ一致)。
// 払戻(tan/fuku は100円あたり)で正直に集計。嘘なし＝「機械的に買うと負ける」を見せるため。
function computeRecovery() {
  if (!fs.existsSync(RESULTS)) return null;
  const files = fs.readdirSync(RESULTS).filter(f => f.endsWith(".json"));
  let races = 0, tanSpent = 0, tanRet = 0, tanHit = 0, fukuRet = 0, fukuHit = 0;
  for (const f of files) {
    const res = readJson(path.join(RESULTS, f));
    if (!res || !Array.isArray(res.results) || !res.payouts) continue;
    let fav = null;
    for (const r of res.results) {
      const o = Number(r.win_odds), n = Number(r.number);
      if (Number.isFinite(o) && o > 1 && o <= 50) { if (!fav || o < fav.o) fav = { n, o }; }
    }
    if (!fav) continue;
    const P = res.payouts;
    races++; tanSpent += 100;
    if (P.tan && Number(P.tan.winner) === fav.n) { tanRet += Number(P.tan.amount) || 0; tanHit++; }
    const fk = (P.fuku || []).find(z => Number(z.number) === fav.n);
    if (fk) { fukuRet += Number(fk.amount) || 0; fukuHit++; }
  }
  if (races < 20) return null;
  const spent = races * 100;
  return {
    races,
    tanRoi: Number((tanRet / spent).toFixed(4)),     // 単勝 回収率
    tanHit: Number((tanHit / races).toFixed(4)),     // 本命が1着の率
    fukuRoi: Number((fukuRet / spent).toFixed(4)),   // 複勝 回収率
    fukuHit: Number((fukuHit / races).toFixed(4)),   // 本命が3着内の率
    tanPnl: Math.round(tanRet - spent),              // 単勝 収支(100円ずつ)
    fukuPnl: Math.round(fukuRet - spent),            // 複勝 収支(100円ずつ)
  };
}

// ─── 2026-08-12 新設: 発走前オッズ（本物）を取る ───────────────
//   signals/<raceId>.json = 発走前オッズの時系列。[{ts, go, we, horses:[{n,o,p,...}]}, ...]
//   発走時刻は races/*.json の hassou_time（"HHMM"・JST）が本物。
//   ⚠「09:50から25分おき」のような決め打ちは絶対にしない（過去にそれで失敗している）。
const SIGNALS = path.join(ROOT, "data", "jv_cache", "signals");
const PRE_MARGIN_MIN = 2;   // 発走2分前より前のスナップだけ使う（既存のリーク対策と同じ）
function preRaceOddsFor(raceId, race) {
  try {
    const hhmm = String(race && race.hassou_time || "").trim();
    if (!/^\d{4}$/.test(hhmm)) return null;
    const d = String(raceId).slice(0, 8);
    if (!/^\d{8}$/.test(d)) return null;
    const post = Date.parse(
      `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${hhmm.slice(0,2)}:${hhmm.slice(2,4)}:00+09:00`);
    if (!Number.isFinite(post)) return null;
    const p = path.join(SIGNALS, raceId + ".json");
    if (!fs.existsSync(p)) return null;
    const snaps = readJson(p);
    if (!Array.isArray(snaps) || !snaps.length) return null;
    const cutoff = post - PRE_MARGIN_MIN * 60000;
    let best = null, bestT = -Infinity;
    for (const s of snaps) {
      const t = Date.parse(s && s.ts);
      if (!Number.isFinite(t) || t > cutoff) continue;
      if (t > bestT) { bestT = t; best = s; }
    }
    if (!best || !Array.isArray(best.horses)) return null;
    const odds = {};
    let cnt = 0;
    for (const h of best.horses) {
      const n = Number(h.n), o = Number(h.o);
      if (Number.isFinite(n) && Number.isFinite(o) && o > 1) { odds[n] = o; cnt++; }
    }
    if (cnt < 2) return null;
    return { odds, ts: best.ts, minsBefore: Math.round((post - bestT) / 60000) };
  } catch { return null; }
}

function buildHonmeiLog(limit = 150) {
  if (!fs.existsSync(RESULTS)) return null;
  // 新しい順(race_id 先頭8桁=日付の降順)
  const resFiles = fs.readdirSync(RESULTS).filter(f => f.endsWith(".json")).sort().reverse();

  const entries = [];
  let win = 0, place = 0, n = 0;
  // 2026-08-12: 発走前オッズで選べたレースだけの集計（＝当日その場で出せた本物の成績）
  let pWin = 0, pPlace = 0, pN = 0;
  for (const f of resFiles) {
    if (entries.length >= limit) break;
    const res = readJson(path.join(RESULTS, f));
    const race = readJson(path.join(RACES, f));
    if (!res || !Array.isArray(res.results) || !race || !Array.isArray(race.horses)) continue;

    const id0 = String(race.race_id || f.replace(/\.json$/, ""));
    const rankByNum = {}, oddsByNum = {};
    for (const r of res.results) {
      const num = Number(r.number), rank = Number(r.rank), o = Number(r.win_odds);
      if (Number.isFinite(num) && Number.isFinite(rank) && rank >= 1) rankByNum[num] = rank;
      if (Number.isFinite(num) && Number.isFinite(o) && o > 1) oddsByNum[num] = o;
    }
    if (Object.keys(oddsByNum).length < 2 || Object.keys(rankByNum).length < 2) continue;

    // 🚨 2026-08-12 正直化: ここは results の win_odds＝**レースが終わってから決まった確定オッズ**
    //   だけを使って本命を選び直していた。当日その場では選べない本命なので数字が甘く出る。
    //   実測（645レースで比べた結果）:
    //     後出し(確定オッズ) : 1着率 36.0% / 3着内率 66.2% / 単勝回収 84.9%
    //     発走前オッズ(本物) : 1着率 32.7% / 3着内率 62.1% / 単勝回収 77.7%
    //     ＝ 1着率で +3.3pt、単勝回収で +7.2pt 甘くなっていた。本命の馬そのものも 23.5% で違った。
    //   → signals/（発走前オッズの時系列）があるレースは、**発走2分前より前の最後のオッズ**を使う。
    //     無いレース（2026-06-13より前）は確定オッズにフォールバックし、印を付けて区別する。
    const pre = preRaceOddsFor(id0, race);
    const oddsSource = pre ? "prerace" : "final";
    const useOdds = pre ? pre.odds : oddsByNum;
    const horses = race.horses.map(h => ({
      ...h,
      win_odds: Number.isFinite(useOdds[h.number]) ? useOdds[h.number]
        : (Number.isFinite(Number(h.win_odds)) ? Number(h.win_odds) : null),
    }));
    let c;
    try { c = buildConclusion({ ...race, horses, is_dummy: false }); } catch { continue; }
    const hm = c && Array.isArray(c.picks) && c.picks[0] ? c.picks[0] : null;
    if (!hm || hm.number == null) continue;
    const rank = rankByNum[hm.number];
    if (rank == null) continue;

    const id = id0;
    const won = rank === 1, placed = rank <= 3;
    n++; if (won) win++; if (placed) place++;
    if (oddsSource === "prerace") { pN++; if (won) pWin++; if (placed) pPlace++; }
    entries.push({
      race_id: id,
      date: id.slice(0, 8),                 // YYYYMMDD
      race_name: race.race_name || null,
      course: race.course || null,
      honmei: { number: hm.number, name: hm.name || null, odds: Number.isFinite(hm.odds) ? hm.odds : null,
                prob: Number.isFinite(hm.prob) ? hm.prob : null, place: Number.isFinite(hm.place) ? hm.place : null,
                popularity: Number.isFinite(hm.popularity) ? hm.popularity : null },
      rank,
      won, placed,
      oddsSource,                                   // "prerace"(本物) か "final"(後出し)
      oddsAgeMin: pre ? pre.minsBefore : null,      // 発走の何分前のオッズか
      finishedAt: res.finishedAt || null,
    });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    method: "本命=今のモデルの推定勝率1位。オッズは signals があれば発走2分前より前の実オッズ、"
      + "無ければ確定オッズ(後出し)。結果は確定着順。",
    count: n,
    winRate: n ? Number((win / n).toFixed(4)) : null,
    placeRate: n ? Number((place / n).toFixed(4)) : null,
    wins: win, places: place,
    // ★2026-08-12 追加: 「当日その場で本当に出せた本命」だけの成績。画面はこちらを主役にする。
    //   645レースで比べた実測 = 後出しは 1着率 +3.3pt / 単勝回収 +7.2pt 甘くなる。
    //   本命の馬そのものも 23.5% のレースで違った。
    preRace: pN ? {
      count: pN,
      winRate: Number((pWin / pN).toFixed(4)),
      placeRate: Number((pPlace / pN).toFixed(4)),
      wins: pWin, places: pPlace,
      note: "発走2分前より前の実オッズで選んだ本命だけ＝当日その場で出せた本物の成績",
    } : null,
    recovery: computeRecovery(),   // ★全レース買ったらの本当の回収率(単勝/複勝・正直)
    entries,  // 新しい順
  };
  fs.writeFileSync(OUT, JSON.stringify(out), "utf8");
  return out;
}

// stale(古い/無い)なら作り直す。precompute から安全に呼ぶ用。
function buildIfStale(maxAgeHours = 20, limit = 150) {
  try {
    if (fs.existsSync(OUT)) {
      const ageH = (Date.now() - fs.statSync(OUT).mtimeMs) / 3600000;
      if (ageH < maxAgeHours) return null; // まだ新しい
    }
    return buildHonmeiLog(limit);
  } catch { return null; }
}

module.exports = { buildHonmeiLog, buildIfStale };

if (require.main === module) {
  const limit = Number(process.argv[2]) || 150;
  const out = buildHonmeiLog(limit);
  if (out) {
    console.log(`[OK] honmei_log.json: ${out.count}レース / 単勝的中 ${(out.winRate*100).toFixed(1)}% / 複勝 ${(out.placeRate*100).toFixed(1)}%`);
  } else {
    console.log("[NG] 作成できませんでした(results が無い等)");
  }
}

// 過去のレース結果から「市場de-vig勝率(オッズ逆算)の帯ごとに、実際に何%が
// 1着/2着内/3着内に入ったか」を集計し、実測キャリブレーション表を作る。
//
// ★2026-06-28 改定: 勝率計算を「市場アンカー方式」に作り直したのに合わせ、
//   較正の“入力”を「旧モデルの予想勝率(win_prob)」から
//   「市場de-vig勝率(=単勝オッズ 1/odds をレース内で正規化)」に変更した。
//   理由: 新モデルの確率は市場de-vigが土台。較正は入力と同じ尺度で作らないと無意味
//   (旧表は別モデルlgbmの分布で作られており新モデルに流用するとミスマッチだった)。
//   市場de-vigは過去の結果ファイルの win_odds から完全に再現できる(=本物の実績で作れる)。
//
// 入力: data/jv_cache/results/<race_id>.json (各馬 number/rank/win_odds)
// 出力: place_calibration.js  (window.PLACE_CALIBRATION = {...} ・フロントが読む)
//       data/jv_cache/place_calibration.json (conclusion.js が読む本体)
//
// 使い方: node scripts/build-place-calibration.mjs
// ※ Harville等の理論推定ではなく、本物の過去実績。嘘をつかないための土台。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RES_DIR = path.join(ROOT, 'data', 'jv_cache', 'results');

const NUM_BINS = 30; // 等頭数ビン。本命(高de-vig)帯の解像度を上げるため細かめに。

async function readJsonSafe(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}

async function main() {
  const resFiles = (await fs.readdir(RES_DIR)).filter((f) => f.endsWith('.json'));
  console.log(`results: ${resFiles.length} ファイル`);

  /** @type {{p:number, rank:number}[]} */
  const rows = [];
  let racesUsed = 0;

  for (const f of resFiles) {
    const res = await readJsonSafe(path.join(RES_DIR, f));
    if (!res || !Array.isArray(res.results)) continue;

    // そのレースの全出走馬の (馬番, 着順, オッズ) を集める
    const runners = [];
    for (const r of res.results) {
      const n = Number(r.number);
      const rank = Number(r.rank);
      const odds = Number(r.win_odds);
      if (!Number.isFinite(n) || !Number.isFinite(rank) || rank < 1) continue;
      if (!Number.isFinite(odds) || odds <= 1.0) continue; // オッズ欠損/異常は除外
      runners.push({ n, rank, odds });
    }
    if (runners.length < 2) continue; // de-vig 正規化に最低2頭必要

    // 市場de-vig: 1/odds をレース内で正規化(overround を取り除く)
    const sumInv = runners.reduce((a, r) => a + 1 / r.odds, 0);
    if (!(sumInv > 0)) continue;
    for (const r of runners) {
      rows.push({ p: (1 / r.odds) / sumInv, rank: r.rank });
    }
    racesUsed++;
  }

  console.log(`つなげた: ${racesUsed} レース / ${rows.length} 頭`);
  if (rows.length < 1000) {
    console.error('データが少なすぎます。中止。');
    process.exit(1);
  }

  // 市場de-vig勝率の昇順に並べ、等頭数で NUM_BINS に分割
  rows.sort((a, b) => a.p - b.p);
  const per = Math.ceil(rows.length / NUM_BINS);
  const bins = [];
  for (let i = 0; i < rows.length; i += per) {
    const slice = rows.slice(i, i + per);
    if (slice.length === 0) continue;
    const n = slice.length;
    const win = slice.filter((x) => x.rank === 1).length / n;
    const in2 = slice.filter((x) => x.rank <= 2).length / n;
    const in3 = slice.filter((x) => x.rank <= 3).length / n;
    bins.push({
      pMin: Number(slice[0].p.toFixed(5)),
      pMax: Number(slice[slice.length - 1].p.toFixed(5)),
      n,
      win: Number(win.toFixed(4)),
      in2: Number(in2.toFixed(4)),
      in3: Number(in3.toFixed(4)),
    });
  }

  // 単調性の担保(予想が強い帯ほど勝率/連対率は下がらないはず)。
  for (let i = 1; i < bins.length; i++) {
    bins[i].in2 = Math.max(bins[i].in2, bins[i - 1].in2);
    bins[i].in3 = Math.max(bins[i].in3, bins[i - 1].in3);
    bins[i].win = Math.max(bins[i].win, bins[i - 1].win);
  }

  // 絶対値の実力スコア str(0-100) と帯の中央値 pMid。
  const anchor = Math.max(...bins.map((b) => 0.6 * b.win + 0.4 * b.in2)) || 1;
  for (const b of bins) {
    b.pMid = Number(((b.pMin + b.pMax) / 2).toFixed(5));
    b.str = Math.max(1, Math.round((100 * (0.6 * b.win + 0.4 * b.in2)) / anchor));
  }

  const out = {
    generatedAt: new Date().toISOString(),
    model: 'market_devig_v1', // ★入力が市場de-vig勝率であることを明示
    inputBasis: 'market_devig (1/odds normalized per race)',
    races: racesUsed,
    horses: rows.length,
    numBins: bins.length,
    abilityAnchor: Number(anchor.toFixed(4)),
    bins,
  };

  await fs.writeFile(
    path.join(ROOT, 'data', 'jv_cache', 'place_calibration.json'),
    JSON.stringify(out, null, 2),
    'utf8',
  );
  await fs.writeFile(
    path.join(ROOT, 'place_calibration.js'),
    `// 自動生成（node scripts/build-place-calibration.mjs）。手で編集しない。\n` +
      `// 過去 ${racesUsed} レース / ${rows.length} 頭の実績から作った「市場de-vig勝率→実測の勝率/2着内/3着内率」表。\n` +
      `window.PLACE_CALIBRATION = ${JSON.stringify(out)};\n`,
    'utf8',
  );

  // 較正の品質(対角性)を見やすく: 予想(pMid) ≒ 実測(win) なら良い較正
  console.log('\n市場de-vig帯      頭数   予想中央  実測勝率   差    2着内   3着内');
  for (const b of bins) {
    const diff = (b.win - b.pMid) * 100;
    console.log(
      `${(b.pMin * 100).toFixed(1)}%-${(b.pMax * 100).toFixed(1)}%`.padEnd(15) +
        `${String(b.n).padStart(5)}  ` +
        `${(b.pMid * 100).toFixed(1)}%`.padStart(7) + '  ' +
        `${(b.win * 100).toFixed(1)}%`.padStart(7) + '  ' +
        `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}`.padStart(5) + '  ' +
        `${(b.in2 * 100).toFixed(1)}%  ${(b.in3 * 100).toFixed(1)}%`,
    );
  }
  console.log('\n書き出し完了: place_calibration.js / data/jv_cache/place_calibration.json');
}

main().catch((e) => { console.error(e); process.exit(1); });

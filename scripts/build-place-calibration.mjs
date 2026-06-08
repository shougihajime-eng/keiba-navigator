// 過去のレース結果から「AIの予想勝率(win_prob)の帯ごとに、実際に何%が
// 2着以内・3着以内に入ったか」を集計し、実測キャリブレーション表を作る。
//
// 入力: data/jv_cache/predictions/<race_id>.json (各馬 win_prob)
//       data/jv_cache/results/<race_id>.json     (各馬 rank=確定着順)
// 出力: place_calibration.js  (window.PLACE_CALIBRATION = {...} ・フロントが読む)
//       data/jv_cache/place_calibration.json (記録用)
//
// 使い方: node scripts/build-place-calibration.mjs
// ※ 嘘をつかないための土台。Harville の理論推定ではなく、本物の過去実績。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PRED_DIR = path.join(ROOT, 'data', 'jv_cache', 'predictions');
const RES_DIR = path.join(ROOT, 'data', 'jv_cache', 'results');

const NUM_BINS = 20; // 等頭数ビン（約48000頭 ÷ 20 ≒ 1頭あたり ~2400頭）

async function readJsonSafe(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const predFiles = (await fs.readdir(PRED_DIR)).filter((f) => f.endsWith('.json'));
  console.log(`predictions: ${predFiles.length} ファイル`);

  /** @type {{p:number, rank:number}[]} */
  const rows = [];
  let racesUsed = 0;
  let modelVersion = '';

  for (const f of predFiles) {
    const pred = await readJsonSafe(path.join(PRED_DIR, f));
    if (!pred || !Array.isArray(pred.horses)) continue;
    const res = await readJsonSafe(path.join(RES_DIR, f));
    if (!res || !Array.isArray(res.results)) continue;

    // 着順を 馬番→rank の地図に
    const rankByNum = new Map();
    for (const r of res.results) {
      const n = Number(r.number);
      const rank = Number(r.rank);
      if (Number.isFinite(n) && Number.isFinite(rank) && rank >= 1) rankByNum.set(n, rank);
    }
    if (rankByNum.size === 0) continue;

    let usedThisRace = 0;
    for (const h of pred.horses) {
      const n = Number(h.number);
      const p = Number(h.win_prob);
      if (!Number.isFinite(n) || !Number.isFinite(p) || p < 0) continue;
      const rank = rankByNum.get(n);
      if (rank == null) continue; // 出走取消などは数えない
      rows.push({ p, rank });
      usedThisRace++;
    }
    if (usedThisRace > 0) {
      racesUsed++;
      if (!modelVersion && pred.model_version) modelVersion = pred.model_version;
    }
  }

  console.log(`つなげた: ${racesUsed} レース / ${rows.length} 頭`);
  if (rows.length < 1000) {
    console.error('データが少なすぎます。中止。');
    process.exit(1);
  }

  // 予想勝率の昇順に並べ、等頭数で NUM_BINS に分割
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

  // 単調性の担保（予想が強い帯ほど連対率は下がらないはず）。
  // 軽い isotonic（後ろから cummax の逆＝前から非減少に丸め）でノイズの逆転だけ均す。
  for (let i = 1; i < bins.length; i++) {
    bins[i].in2 = Math.max(bins[i].in2, bins[i - 1].in2);
    bins[i].in3 = Math.max(bins[i].in3, bins[i - 1].in3);
    bins[i].win = Math.max(bins[i].win, bins[i - 1].win);
  }

  // 絶対値の「実力スコア」str（0-100）。
  // 強さ = 勝率×0.6 + 2着内×0.4 を、過去の最強帯=100 に正規化。
  // → どのレースでも同じ意味（相対値ではない）。pMid は prob 補間用の帯の中央値。
  const anchor = Math.max(...bins.map((b) => 0.6 * b.win + 0.4 * b.in2)) || 1;
  for (const b of bins) {
    b.pMid = Number(((b.pMin + b.pMax) / 2).toFixed(5));
    b.str = Math.max(1, Math.round((100 * (0.6 * b.win + 0.4 * b.in2)) / anchor));
  }

  const out = {
    generatedAt: new Date().toISOString(),
    model: modelVersion || 'unknown',
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
      `// 過去 ${racesUsed} レース / ${rows.length} 頭の実績から作った「予想勝率→実測の2着内/3着内率」表。\n` +
      `window.PLACE_CALIBRATION = ${JSON.stringify(out)};\n`,
    'utf8',
  );

  // コンソールに見やすく
  console.log('\n予想勝率帯       頭数    勝率   2着内   3着内');
  for (const b of bins) {
    console.log(
      `${(b.pMin * 100).toFixed(1)}%-${(b.pMax * 100).toFixed(1)}%`.padEnd(16) +
        `${String(b.n).padStart(5)}  ` +
        `${(b.win * 100).toFixed(1)}%  ${(b.in2 * 100).toFixed(1)}%  ${(b.in3 * 100).toFixed(1)}%`,
    );
  }
  console.log('\n書き出し完了: place_calibration.js / data/jv_cache/place_calibration.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

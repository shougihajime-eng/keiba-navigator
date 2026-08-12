#!/usr/bin/env node
"use strict";
//
// build_umabashira.cjs — 馬柱（各馬の過去5走）の索引を作る
//
// ■ 何をするか
//   data/jv_cache/races/*.json（出走表＋確定結果）を全部見て、
//   「どの馬が・いつ・どこで・何着だったか」を馬ごとにまとめ直し、
//   data/jv_cache/umabashira.json に書き出す。
//   画面はこのファイルを読むだけで、各馬の過去5走をすぐ出せる。
//
// ■ つかいかた
//   node scripts/build_umabashira.cjs                  … 直近7日ぶんの軽い索引（本番用）
//   node scripts/build_umabashira.cjs --days 21        … 直近21日ぶん
//   node scripts/build_umabashira.cjs --full           … 全馬ぶんの索引も書く（パソコンの中だけ）
//   node scripts/build_umabashira.cjs --verify         … できあがりを結果ファイルと突き合わせて自己検査
//   node scripts/build_umabashira.cjs --race <レースID> … そのレースの馬柱を画面に出して確かめる
//
// ■ 速さの工夫（実測して決めた）
//   ・レースファイルは「新しい順」に読む。1頭あたり keep 本たまったら、それ以上は入れない
//     ＝並べ替えゼロ・使うメモリも一定。
//   ・軽い版では「今回の対象レースに出る馬」だけを追いかけ、全馬の枠がうまったら
//     途中で読むのをやめる（--full の時だけ全部読む）。
//   ・索引のキャッシュ（前回の結果を貯めておく仕組み）は作っていない。
//     4,380レースの読み込みが実測 0.6 秒で、キャッシュを作るほうが遅く・古くなる危険もあるため。
//
// ■ データを作らない
//   ・過去走が1本も無い馬は runs:[] のまま（新馬として画面に出す）。それらしい数字で埋めない。
//   ・取り込み事故で文字化けしているレースは、まるごと使わない（半分こわれた馬柱を出さない）。
//

const fs = require("fs");
const path = require("path");
const U = require("../lib/umabashira.js");

const ROOT       = path.resolve(__dirname, "..");
const RACES_DIR  = path.join(ROOT, "data", "jv_cache", "races");
const RESULTS_DIR= path.join(ROOT, "data", "jv_cache", "results");
const OUT_LIGHT  = path.join(ROOT, "data", "jv_cache", "umabashira.json");
const OUT_FULL   = path.join(ROOT, "data", "jv_cache", "umabashira_full.json");
const CARD_LATEST= path.join(ROOT, "data", "jv_cache", "race_card_latest.json");
const TODAY_RACES= path.join(ROOT, "data", "jv_cache", "today_races.json");

// ── 引数 ────────────────────────────────────────
function parseArgs(argv) {
  const o = { days: 7, keep: 8, limit: 5, full: false, verify: false, quiet: false, race: null, out: null, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days")        o.days = Number(argv[++i]);
    else if (a === "--keep")   o.keep = Number(argv[++i]);
    else if (a === "--limit")  o.limit = Number(argv[++i]);
    else if (a === "--out")    o.out = argv[++i];
    else if (a === "--race")   o.race = argv[++i];
    else if (a === "--full")   o.full = true;
    else if (a === "--verify") o.verify = true;
    else if (a === "--force")  o.force = true;
    else if (a === "--quiet")  o.quiet = true;
    else if (a === "--help" || a === "-h") { o.help = true; }
  }
  if (!isFinite(o.days) || o.days < 0) o.days = 7;
  if (!isFinite(o.keep) || o.keep < 1) o.keep = 8;
  return o;
}

function log(opt, ...args) { if (!opt.quiet) console.log(...args); }

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function shiftYmd(ymd, deltaDays) {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(4, 6)), d = Number(ymd.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, "0")}${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}

// ── 対象レース（＝馬柱を出したいレース）を決める ────────────
// 既定 = 「いちばん新しい開催日」から --days 日ぶん。
// さらに race_card_latest.json / today_races.json に載っているレースも必ず入れる。
function pickTargetRaceIds(fileIdsDesc, opt) {
  const newest = fileIdsDesc.length ? fileIdsDesc[0].slice(0, 8) : todayYmd();
  const anchor = newest > todayYmd() ? newest : todayYmd();
  const from = shiftYmd(anchor, -Math.abs(opt.days));
  const set = new Set();
  for (const id of fileIdsDesc) if (id.slice(0, 8) >= from) set.add(id);

  for (const p of [CARD_LATEST, TODAY_RACES]) {
    const j = readJsonSafe(p);
    const list = j && Array.isArray(j.races) ? j.races : [];
    for (const r of list) if (r && typeof r.race_id === "string") set.add(r.race_id);
  }
  return { ids: set, from, anchor, newest };
}

// ── 本体 ────────────────────────────────────────
function build(opt) {
  const t0 = Date.now();
  if (!fs.existsSync(RACES_DIR)) {
    console.error(`レースのフォルダがありません: ${RACES_DIR}`);
    process.exit(1);
  }

  // 新しい順（ファイル名の先頭8桁が日付なので、名前の降順＝日付の降順）
  const files = fs.readdirSync(RACES_DIR).filter((f) => f.endsWith(".json")).sort().reverse();
  const ids = files.map((f) => f.slice(0, -5));
  const tList = Date.now();

  const target = pickTargetRaceIds(ids, opt);
  const wantAll = !!opt.full;

  // 段階①: 対象レースを先に読み、「追いかける馬」を決める
  const raceMetaById = Object.create(null);   // 索引に入れるレース
  const wanted = new Set();                   // 追いかける馬（軽い版のとき）
  const horses = Object.create(null);
  const names  = Object.create(null);
  const stats  = { races: 0, filesRead: 0, readFailed: 0, usable: 0, corrupt: 0, corruptIds: [], starts: 0, stored: 0, skipped: 0 };

  function addRun(ketto, name, run) {
    let arr = horses[ketto];
    if (!arr) arr = horses[ketto] = [];
    if (arr.length >= opt.keep) return false;   // 新しい順に読んでいるので、あふれた分は古い分＝捨ててよい
    arr.push(run);
    stats.stored++;
    const key = U.normalizeName(name);
    const list = names[key] || (names[key] = []);
    if (list.indexOf(ketto) === -1) list.push(ketto);
    return true;
  }

  function processFile(fname, isTarget) {
    const race = readJsonSafe(path.join(RACES_DIR, fname));
    stats.filesRead++;
    if (!race) { stats.readFailed++; return; }   // 読めなかった＝黙って無視しない（下で止める）
    stats.races++;
    const res = U.runsOfRace(race);
    stats.skipped += res.skipped || 0;
    if (!res.meta) return;
    if (res.corrupt) {
      stats.corrupt++;
      if (stats.corruptIds.length < 400) stats.corruptIds.push(res.meta.race_id);
      return;
    }
    stats.usable++;

    const keepRace = isTarget || wantAll;
    const entries = [];
    for (const r of res.runs) {
      stats.starts++;
      const ketto = r._ketto, nm = r._name;
      if (keepRace) entries.push({ number: r.number, frame: r.frame, name: nm, ketto, sexAge: r._sexAge });
      if (isTarget) wanted.add(ketto);
      if (wantAll || wanted.has(ketto)) {
        const clean = Object.assign({}, r);
        delete clean._ketto; delete clean._name; delete clean._sexAge;
        addRun(ketto, nm, clean);
      }
    }
    if (keepRace) {
      entries.sort((a, b) => a.number - b.number);
      raceMetaById[res.meta.race_id] = Object.assign({}, res.meta, { entries });
    }
  }

  // 対象レース（新しい方）→ それより古いレース、の順に読む
  const targetFiles = [], restFiles = [];
  for (const f of files) (target.ids.has(f.slice(0, -5)) ? targetFiles : restFiles).push(f);
  for (const f of targetFiles) processFile(f, true);

  // 段階②: 過去走をさかのぼる。全馬の枠がうまったら途中で終わる（--full の時は全部読む）
  let stoppedEarly = false;
  for (let i = 0; i < restFiles.length; i++) {
    if (!wantAll) {
      let unfilled = 0;
      // 100ファイルごとに「まだ枠が空いている馬」を数える（毎回数えると遅いので間引く）
      if (i % 100 === 0) {
        for (const k of wanted) { const a = horses[k]; if (!a || a.length < opt.keep) { unfilled++; break; } }
        if (unfilled === 0 && i > 0) { stoppedEarly = true; break; }
      }
    }
    processFile(restFiles[i], false);
  }

  const tScan = Date.now();

  // 出力を組み立てる
  const allDates = ids.map((s) => s.slice(0, 8));
  const meta = {
    schema_version: 1,
    built_at: new Date().toISOString(),
    built_by: "scripts/build_umabashira.cjs",
    source: "data/jv_cache/races",
    kind: wantAll ? "full" : "light",
    keep: opt.keep,
    display_limit: opt.limit,
    target_window: { from: target.from, anchor: target.anchor, days: opt.days, races: Object.keys(raceMetaById).length },
    history_window: { from: allDates.length ? allDates[allDates.length - 1] : null, to: allDates.length ? allDates[0] : null },
    stats: {
      race_files: files.length,
      files_read: stats.filesRead,
      files_unreadable: stats.readFailed,
      races_usable: stats.usable,
      races_corrupt: stats.corrupt,
      starts_scanned: stats.starts,
      runs_stored: stats.stored,
      starts_skipped: stats.skipped,
      horses_indexed: Object.keys(horses).length,
      stopped_early: stoppedEarly,
    },
    corrupt_race_ids: stats.corruptIds,
    columns: U.COLUMNS,
  };
  const out = Object.assign({}, meta, { races: raceMetaById, horses, names });
  const outPath = opt.out ? path.resolve(opt.out) : (wantAll ? OUT_FULL : OUT_LIGHT);

  // ── 安全装置 ──────────────────────────────────
  // 「読めていないのに、できました」を絶対に出さない。
  // 中身が空・激減しているときは、前の良い索引を上書きせずにここで止める。
  // （2026-08-12 実際に一度だけ、全ファイルの読み取りに失敗して空の索引を
  //   書き出してしまった。エラーは1つも出ていなかった＝この安全装置が要る）
  const nHorses = Object.keys(horses).length;
  const nRaces  = Object.keys(raceMetaById).length;
  const halt = [];
  if (stats.readFailed > 0) {
    const ratio = stats.readFailed / Math.max(1, stats.filesRead);
    const msg = `レースファイルを ${stats.readFailed} 件 読めませんでした（読んだ ${stats.filesRead} 件中）`;
    if (ratio > 0.02) halt.push(msg); else log(opt, `  ⚠ ${msg}（少数なので続けます）`);
  }
  if (target.ids.size > 0 && nRaces === 0) halt.push(`対象レースが ${target.ids.size} 本あるのに、1本も索引できませんでした`);
  if (nHorses === 0) halt.push("1頭も索引できませんでした");
  // 前回より大きく減っていたら止める（取りこぼしに気づかず本番へ配らないため）
  if (!halt.length && fs.existsSync(outPath)) {
    const prev = readJsonSafe(outPath);
    const prevN = prev && prev.horses ? Object.keys(prev.horses).length : 0;
    if (prevN > 20 && nHorses < prevN * 0.5) {
      halt.push(`索引した馬が前回の半分以下です（前回 ${prevN} 頭 → 今回 ${nHorses} 頭）`);
    }
  }
  if (halt.length && !opt.force) {
    console.error("");
    console.error("❌ 索引を書き出しませんでした（前のファイルはそのままです）");
    for (const h of halt) console.error("   ・" + h);
    console.error("   もう一度実行してみてください。それでもダメなら data/jv_cache/races を確認してください。");
    console.error("   どうしてもこの内容で上書きしたいときだけ --force を付けてください。");
    process.exit(2);
  }

  // 書き出しは「いったん別名 → 名前を付け替え」でやる（途中で止まっても壊れたファイルが残らない）
  const tmpPath = outPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(out), "utf8");
  fs.renameSync(tmpPath, outPath);
  const bytes = fs.statSync(outPath).size;
  const tWrite = Date.now();

  log(opt, "");
  log(opt, "── 馬柱の索引ができました ──────────────────");
  log(opt, `  出力       : ${path.relative(ROOT, outPath)}  (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
  log(opt, `  種類       : ${wantAll ? "全馬ぶん(パソコンの中だけ)" : "軽い版(本番に配る)"}`);
  log(opt, `  対象レース : ${meta.target_window.races} 本  (${target.from} 以降)`);
  log(opt, `  過去走の元 : ${meta.history_window.from} 〜 ${meta.history_window.to}`);
  log(opt, `  読んだ数   : ${stats.filesRead} / ${files.length} ファイル${stoppedEarly ? "（途中で足りたので打ち切り）" : ""}`);
  log(opt, `  使えた     : ${stats.usable} レース / 壊れていた: ${stats.corrupt} レース`);
  log(opt, `  索引した   : ${Object.keys(horses).length} 頭 ・ ${stats.stored} 走ぶん (見た出走のべ ${stats.starts} 件)`);
  log(opt, `  かかった時間: 一覧 ${tList - t0}ms / 読み込み ${tScan - tList}ms / 書き出し ${tWrite - tScan}ms  ＝ 合計 ${tWrite - t0}ms`);
  if (stats.corrupt) {
    const days = [...new Set(stats.corruptIds.map((x) => x.slice(0, 8)))].sort();
    log(opt, `  ⚠ 壊れていた開催日: ${days.join(", ")}`);
  }
  log(opt, "");

  return { out, outPath, ms: tWrite - t0 };
}

// ── 自己検査（できあがりを、別ファイル results/*.json と突き合わせる） ──
function verify(uma, opt) {
  console.log("── 自己検査（結果ファイルと突き合わせ）────────────");
  let checked = 0, ng = 0;
  const problems = [];

  // ① 日付が新しい順に並んでいるか・同じレースが二重に入っていないか
  let orderNg = 0, dupNg = 0;
  for (const k of Object.keys(uma.horses)) {
    const runs = uma.horses[k];
    const seen = new Set();
    for (let i = 0; i < runs.length; i++) {
      if (seen.has(runs[i].race_id)) dupNg++;
      seen.add(runs[i].race_id);
      if (i > 0 && runs[i - 1].date < runs[i].date) orderNg++;
    }
  }
  console.log(`  並び順(新しい順)     : ${orderNg === 0 ? "OK" : "NG " + orderNg + "件"}`);
  console.log(`  同じレースの二重登録 : ${dupNg === 0 ? "OK" : "NG " + dupNg + "件"}`);

  // ② 全走を results/<レースID>.json と突き合わせる（馬番→馬名・着順）
  //    さらに 1着の走りは「払戻データの単勝当たり馬番」とも突き合わせる（別レコード由来＝独立チェック）
  const resultCache = new Map();
  function getResult(raceId) {
    if (resultCache.has(raceId)) return resultCache.get(raceId);
    const j = readJsonSafe(path.join(RESULTS_DIR, raceId + ".json"));
    resultCache.set(raceId, j);
    return j;
  }
  // 馬（血統登録番号）→ 馬名。索引に入っているレースの出走表から作る。
  const kettoName = new Map();
  for (const rid of Object.keys(uma.races)) {
    for (const e of (uma.races[rid].entries || [])) if (e.ketto && e.name) kettoName.set(e.ketto, e.name);
  }

  let nameNg = 0, nameChecked = 0, rankNg = 0, payoutNg = 0, noResult = 0, payoutChecked = 0;
  for (const k of Object.keys(uma.horses)) {
    const myName = kettoName.get(k) || null;
    for (const r of uma.horses[k]) {
      checked++;
      const res = getResult(r.race_id);
      if (!res || !Array.isArray(res.results)) { noResult++; continue; }
      const hit = res.results.find((x) => x && x.number === r.number);
      if (hit) {
        // ★いちばん大事な確認★ 「その過去走は本当にこの馬のものか」
        //   索引が付けた馬番の場所に、同じ馬名が居るはず。
        if (myName && hit.name && !U.isBrokenText(hit.name)) {
          nameChecked++;
          if (U.normalizeName(hit.name) !== U.normalizeName(myName)) {
            nameNg++;
            if (problems.length < 10) problems.push(`別の馬かも ${r.race_id} 馬番${r.number} 索引「${myName}」 vs 結果「${hit.name}」`);
          }
        }
        if (r.rank != null && hit.rank != null && hit.rank !== r.rank) {
          rankNg++; if (problems.length < 10) problems.push(`着順ちがい ${r.race_id} 馬番${r.number} 索引${r.rank} vs 結果${hit.rank}`);
        }
      }
      if (r.rank === 1) {
        // 同着(1着が2頭)のときは払戻データが片方しか持たないので、この照合はしない
        const firsts = res.results.filter((x) => x && x.rank === 1).length;
        const w = firsts === 1 && res.payouts && res.payouts.tan && res.payouts.tan.winner;
        if (typeof w === "number") {
          payoutChecked++;
          if (w !== r.number) { payoutNg++; if (problems.length < 10) problems.push(`単勝払戻と不一致 ${r.race_id} 索引1着=${r.number} 払戻=${w}`); }
        }
      }
    }
  }
  console.log(`  過去走が本人のものか     : ${nameNg === 0 ? "OK" : "NG " + nameNg + "件"}  (馬名で照合 ${nameChecked} 走)`);
  console.log(`  着順が結果ファイルと一致 : ${rankNg === 0 ? "OK" : "NG " + rankNg + "件"}  (照合 ${checked} 走・結果ファイル無し ${noResult} 走)`);
  console.log(`  1着が単勝払戻と一致      : ${payoutNg === 0 ? "OK" : "NG " + payoutNg + "件"}  (照合 ${payoutChecked} 走)`);
  ng = orderNg + dupNg + nameNg + rankNg + payoutNg;

  // ③ おかしな値が残っていないか
  let saneNg = 0;
  for (const k of Object.keys(uma.horses)) {
    for (const r of uma.horses[k]) {
      if (r.popularity != null && (r.popularity < 1 || (r.fieldSize && r.popularity > r.fieldSize))) saneNg++;
      if (r.rank != null && r.fieldSize && r.rank > r.fieldSize) saneNg++;
      if (r.weight != null && (r.weight < 40 || r.weight > 70)) saneNg++;
      if (r.last3f != null && (r.last3f < 25 || r.last3f > 60)) saneNg++;
      if (r.name != null && U.isBrokenText(r.name)) saneNg++;
    }
  }
  console.log(`  ありえない値が無いか     : ${saneNg === 0 ? "OK" : "NG " + saneNg + "件"}`);
  ng += saneNg;

  if (problems.length) { console.log("  ── 見つかった問題(先頭10件) ──"); for (const p of problems) console.log("   ", p); }
  console.log(`  結果: ${ng === 0 ? "✅ 全部あっています" : "❌ " + ng + " 件おかしい"}`);
  console.log("");
  return ng;
}

// ── 1レースぶんの馬柱を画面に出す（目で見て確かめる用） ────────
function show(uma, raceId, opt) {
  const rows = U.rowsForRaceId(uma, raceId, { limit: opt.limit });
  if (!rows) { console.log(`索引に ${raceId} がありません（--days を大きくして作り直してください）`); return; }
  const r = uma.races[raceId];
  console.log(`── ${U.formatDate(r.date)} ${r.venue} ${r.raceNum}R ${r.raceLabel || ""} ${r.courseLabel || ""} ${r.going || ""} (${r.fieldSize}頭) ──`);
  for (const row of rows) {
    const rec = row.record;
    console.log(`\n[${row.number}] ${row.name} ${row.sexAge || ""}  過去${rec.starts}走 ${rec.win}勝 3着内${rec.in3}${row.historyNote ? "  ★" + row.historyNote : ""}`);
    for (const p of row.runs) {
      const chaku = p.rank != null ? `${String(p.rank).padStart(2)}着` : String(p.rankLabel || "-").padStart(4);
      console.log(`   ${U.formatDate(p.date, ".").slice(2)} ${p.venue} ${String(p.raceLabel || "").slice(0, 8).padEnd(8)} ${String(p.courseLabel || "").padEnd(7)} ${String(p.going || "").padEnd(2)} ${String(p.fieldSize || "").padStart(2)}頭 ${String(p.frame || "")}枠${String(p.number || "").padStart(2)}番 ${String(p.popularity || "-").padStart(2)}人気 ${chaku.padStart(4)} ${String(p.time || "-").padStart(7)} 上${String(p.last3f || "-").padStart(4)} ${String(p.passing || "-").padEnd(11)} ${String(p.weight || "-")}kg ${String(p.jockey || "-").padEnd(6)} ${p.bodyLabel || "-"}`);
    }
  }
  console.log("");
}

// ── 実行 ────────────────────────────────────────
function main() {
  const opt = parseArgs(process.argv);
  if (opt.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(2, 30).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  const { out } = build(opt);
  if (opt.verify) {
    const ng = verify(out, opt);
    if (ng > 0) process.exitCode = 1;
  }
  if (opt.race) show(out, opt.race, opt);
}

if (require.main === module) main();

module.exports = { build, verify, show };

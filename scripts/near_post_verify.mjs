// ============================================================
// near_post_verify.mjs — 「発走直前のオッズを、本当に取れているか」を機械が確かめる
//
// ★なぜ作るか（正直な背景）
//   2026-08-11 に「オッズを直前に見ていない」ことが分かった。
//   1時間おきの取得だと、たまたま発走の直後に当たることが多く、
//   **直前5分の変化を測れたレースは 744 レース中 0 件**だった。
//   そこで 2分おきの `KeibaNearPostOdds`（土日月 09:20〜18:50）を新設したが、
//   **それが本当に効いているかは、実際の開催日を1回まわすまで分からない**。
//
//   ⚠ ここを人（私）の記憶に頼ると、また「やったつもり」で終わる。
//     だから機械が毎回かならず数えて、ダメなら知らせる。
//
//   🚨 この道具がさっそく穴を見つけた（2026-08-12）：
//      取得は 09:20 から 7時間40分＝**17:00 で終わっていた**。
//      ところが夏の新潟・中京は「2部制開催（暑さ対策）」で、
//      1〜5R が 09:40〜11:50、3時間20分あいて 6〜12R が 15:00〜18:30。
//      ＝**1日6レースが丸ごと取れていなかった**。
//      → 9時間30分（18:50まで）に延ばした。登録し直す時もこの長さを保つこと。
//
// ★このファイルがすること
//   1) 直近の開催日について、各レースの「本物の発走時刻」を races/*.json から読む
//   2) signals/*.json のスナップの時刻を突き合わせ、
//      ・発走 20分前〜2分後 に1つでも取れたレース（＝2分おきが効いた証拠）
//      ・直前5分の変化を測れるレース（＝T-5〜T-0 に2つ以上）
//      を数える
//   3) やさしい日本語で結果を書き出す
//   4) **取れていない開催日があった時だけ**デスクトップの箱に⚠を置く（元気なら消す）
//
// ★このファイルがしないこと
//   ・「買え／買うな」を決めない。取れているかどうかを数えるだけ。
//   ・数字を作らない。0件なら 0件と書く。
//
// 使い方: node scripts/near_post_verify.mjs [--days 14]
// ============================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const RACES = path.join(ROOT, "data", "jv_cache", "races");
const SIGNALS = path.join(ROOT, "data", "jv_cache", "signals");
const REPORT = "C:\\Users\\shoug\\はじめアプリ\\★ 競馬の直前オッズ（結果）.txt";
const BOXES = [
  "C:\\Users\\shoug\\OneDrive\\デスクトップ\\📋 自動チェックの結果（毎日のお知らせ）",
  "C:\\Users\\shoug\\Desktop\\📋 自動チェックの結果（毎日のお知らせ）",
];
const ALERT_NAME = "⚠競馬の直前オッズが取れていません.txt";

const argDays = Number((process.argv.find((a) => a.startsWith("--days=")) || "").split("=")[1]);
const DAYS = Number.isFinite(argDays) && argDays > 0 ? argDays : 14;

// 発走の何分前〜何分後を「直前に取れた」とみなすか（near_post_odds.ps1 の窓と同じ）
const WIN_BEFORE = 20;
const WIN_AFTER = 2;
// 「直前5分の変化」を測るのに要る窓
const LAST5 = 5;

const MS = 60000;

/** raceId(18桁) + hassou_time("HHMM") → 発走の時刻(ms・日本時間) */
function postTimeMs(raceId, hhmm) {
  const s = String(raceId || "");
  const t = String(hhmm || "");
  if (!/^\d{8}/.test(s) || !/^\d{4}$/.test(t)) return null;
  const y = +s.slice(0, 4), mo = +s.slice(4, 6), d = +s.slice(6, 8);
  const hh = +t.slice(0, 2), mi = +t.slice(2, 4);
  // 日本時間 → UTC の ms（JST = UTC+9）
  return Date.UTC(y, mo - 1, d, hh - 9, mi, 0, 0);
}

/** シグナルの1スナップから「単勝オッズが1つでも入っているか」 */
function hasOdds(snap) {
  const hs = (snap && snap.horses) || [];
  for (const h of hs) if (h && h.o != null && Number(h.o) > 0) return true;
  return false;
}

function ymdOf(raceId) { return String(raceId).slice(0, 8); }

function jstToday() {
  const d = new Date();
  const j = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * MS);
  return `${j.getFullYear()}${String(j.getMonth() + 1).padStart(2, "0")}${String(j.getDate()).padStart(2, "0")}`;
}

function main() {
  if (!fs.existsSync(RACES) || !fs.existsSync(SIGNALS)) {
    console.log("データのフォルダが見つかりません");
    return { ok: false };
  }
  const today = jstToday();
  const from = (() => {
    const y = +today.slice(0, 4), m = +today.slice(4, 6), d = +today.slice(6, 8);
    const t = new Date(Date.UTC(y, m - 1, d)); t.setUTCDate(t.getUTCDate() - DAYS);
    return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
  })();

  const byDay = new Map();   // ymd -> {races, withPost, nearHit, last5, snapsInWindow}
  let noPostTime = 0;

  for (const f of fs.readdirSync(SIGNALS)) {
    if (!f.endsWith(".json")) continue;
    const raceId = f.slice(0, -5);
    const ymd = ymdOf(raceId);
    if (ymd < from || ymd > today) continue;

    const rp = path.join(RACES, raceId + ".json");
    if (!fs.existsSync(rp)) continue;
    let race; try { race = JSON.parse(fs.readFileSync(rp, "utf8")); } catch { continue; }
    const post = postTimeMs(raceId, race.hassou_time);

    if (!byDay.has(ymd)) byDay.set(ymd, { races: 0, withPost: 0, nearHit: 0, last5: 0, snapsInWindow: 0 });
    const st = byDay.get(ymd);
    st.races++;
    if (post == null) { noPostTime++; continue; }
    st.withPost++;

    let sn; try { sn = JSON.parse(fs.readFileSync(path.join(SIGNALS, f), "utf8")); } catch { continue; }
    // signals は {"0":{ts,horses},"1":{...}} の形（配列ではない）
    const snaps = Object.values(sn || {}).filter((s) => s && s.ts);
    const inWin = [], inLast5 = [];
    for (const s of snaps) {
      if (!hasOdds(s)) continue;                 // オッズが入っていないスナップは数えない
      const t = Date.parse(s.ts);
      if (!Number.isFinite(t)) continue;
      const minToPost = (post - t) / MS;         // 正 = 発走前
      if (minToPost <= WIN_BEFORE && minToPost >= -WIN_AFTER) inWin.push(minToPost);
      if (minToPost <= LAST5 && minToPost >= 0) inLast5.push(minToPost);
    }
    if (inWin.length) { st.nearHit++; st.snapsInWindow += inWin.length; }
    if (inLast5.length >= 2) st.last5++;
  }

  const days = [...byDay.keys()].sort();
  const totals = { races: 0, withPost: 0, nearHit: 0, last5: 0 };
  for (const d of days) {
    const s = byDay.get(d);
    totals.races += s.races; totals.withPost += s.withPost;
    totals.nearHit += s.nearHit; totals.last5 += s.last5;
  }

  // 「開催日なのに直前が1件も取れていない日」＝これが失敗の合図
  const badDays = days.filter((d) => {
    const s = byDay.get(d);
    return s.withPost >= 6 && s.nearHit === 0;   // 6レース以上あるのに1件も取れていない
  });

  const L = [];
  L.push("競馬 ── 発走直前のオッズが本当に取れているか");
  L.push(`しらべた日: 直近 ${DAYS} 日（${from} 〜 ${today}）`);
  L.push("");
  L.push("【なぜ見ているか】");
  L.push("  1時間おきの取得では、発走の直前をほとんど通り過ぎてしまい、");
  L.push("  直前5分の動きを測れたレースは 744 レース中 0 件でした。");
  L.push("  2分おきの取得（土日月 9:20〜18:50）を足したので、その効き目を数えます。");
  L.push("");
  L.push("【合計】");
  L.push(`  レース数 …………………………… ${totals.races}`);
  L.push(`  発走時刻が分かる ………………… ${totals.withPost}`);
  L.push(`  発走20分前〜2分後に取れた …… ${totals.nearHit}`
    + (totals.withPost ? `（${(totals.nearHit / totals.withPost * 100).toFixed(1)}%）` : ""));
  L.push(`  直前5分の動きを測れる … ${totals.last5}`
    + (totals.withPost ? `（${(totals.last5 / totals.withPost * 100).toFixed(1)}%）` : ""));
  L.push("");
  L.push("【日ごと】");
  if (!days.length) L.push("  （この期間にレースがありません）");
  for (const d of days) {
    const s = byDay.get(d);
    const mark = s.withPost >= 6 ? (s.nearHit ? (s.last5 ? "◎" : "○") : "✕") : "・";
    L.push(`  ${mark} ${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}  `
      + `レース ${String(s.races).padStart(2)} ／ 直前に取れた ${String(s.nearHit).padStart(2)} ／ 直前5分 ${String(s.last5).padStart(2)}`);
  }
  L.push("");
  L.push("  ◎ = 直前5分まで取れている（ねらいどおり）");
  L.push("  ○ = 直前20分には取れているが、5分の動きはまだ 測れない");
  L.push("  ✕ = 開催日なのに直前が1件も取れていない（ここが問題）");
  L.push("  ・ = レースが少ない日（判定しない）");
  L.push("");
  if (badDays.length) {
    L.push("【⚠ 問題あり】");
    L.push(`  ${badDays.join(" / ")} は開催日なのに 直前のオッズが1件も取れていません。`);
    L.push("  KeibaNearPostOdds という自動処理が動いているか確かめてください。");
  } else if (totals.last5 > 0) {
    L.push("【結果】ねらいどおり、直前5分の動きが 測れています。");
  } else if (totals.nearHit > 0) {
    L.push("【結果】直前20分までは取れています。5分の動きはもう少しレースが必要です。");
  } else {
    L.push("【結果】この期間に開催日がないか、まだ2分おきの取得が回っていません。");
    L.push("  （次の土曜・日曜を待ってからもう一度見てください）");
  }
  L.push("");
  L.push(`しらべた時刻: ${new Date().toLocaleString("ja-JP")}`);

  const text = L.join("\r\n");
  try { fs.writeFileSync(REPORT, text, "utf8"); } catch (e) { /* 書けなくても止めない */ }
  console.log(text);

  // 問題があった時だけ、デスクトップの箱に⚠を置く（元気なら消す＝静かに待つ）
  for (const box of BOXES) {
    try {
      if (!fs.existsSync(box)) continue;
      const p = path.join(box, ALERT_NAME);
      if (badDays.length) {
        fs.writeFileSync(p, text, "utf8");
      } else if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    } catch (e) { /* 箱が無くても止めない */ }
  }

  return { ok: true, totals, badDays, days: days.length };
}

const r = main();
process.exit(r && r.ok && (!r.badDays || !r.badDays.length) ? 0 : (r && r.badDays && r.badDays.length ? 1 : 0));

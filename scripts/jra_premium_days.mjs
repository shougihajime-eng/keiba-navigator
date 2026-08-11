// JRA の「払戻率が上がる日」を JRA 公式サイトから取ってきて JSON にする。
//
// ■ なぜ大事か
//   ふだんの払戻率は 単勝80% / 馬連77.5% / 3連単72.5% / WIN5 70%。
//   ところが JRA には払戻率が上がる制度が4つあり、その日は控除率(テラ銭)が下がる。
//     ・JRAウルトラプレミアム = スーパープレミアム(80%)＋プレミアム(売上の5%上乗せ) = 実質85%
//     ・JRAスーパープレミアム = 全券種の払戻率を上限の80%に設定
//     ・JRAプレミアム         = 通常の払戻金に売上の5%相当額を上乗せ
//     ・JRAプラス10           = 100円元返しのとき10円上乗せして110円(毎日・全レース・全券種)
//   3連単で収支トントンに必要な「平均よりうまく選ぶ度合い」は +37.9% だが、
//   払戻率85%の日なら +17.6% で足りる(半分以下)。＝この日を知っているかどうかは大きい。
//
// ■ この台本がやること
//   公式4ページと、そこから辿れる子ページ(過去の結果・年度別の対象レース一覧)を読み、
//   「日付つきで実施された/実施される日」を集めて data/jv_cache/jra_premium.json に書く。
//
// ■ 絶対に守ること（嘘をつかない設計）
//   1. ページに書いていない数字は作らない。読めなければ null。
//   2. 払戻率(85/80)もハードコードせず、ページ本文の文言から読み取る。
//      読み取れなければ null にして、根拠の文(payoutBasis)も一緒に残す。
//   3. HTMLコメント <!-- --> を最初に必ず消す。
//      → JRAプレミアムのページには「2025年のJRAプレミアムは5月4日…」という
//        “去年の文がコメントで残ったまま”の罠がある。消さないと古い日付を拾う。
//   4. 曜日の検算をする。ページが「日曜」と書いているのに計算した日付が火曜なら、
//      年の推測を間違えている＝その行は採用せず errors に記録する。
//   5. 取得に全部失敗したときは、既にある JSON を上書きしない(壊さない)。
//
// ■ 使い方
//   node scripts/jra_premium_days.mjs            … ふつう(自動実行もこれ)
//   node scripts/jra_premium_days.mjs --verbose  … 何をしているか画面に出す
//   node scripts/jra_premium_days.mjs --years 6  … 年度別ページを何年ぶん読むか(既定3)
//
// ■ 出力先
//   data/jv_cache/jra_premium.json
//   （.gitignore と .vercelignore の両方に !data/jv_cache/jra_premium.json が必要。
//     片方だけだと本番に届かない、という既知の事故があるため。）

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'jv_cache', 'jra_premium.json');

const BASE = 'https://www.jra.go.jp';
const ARGV = process.argv.slice(2);
const VERBOSE = ARGV.includes('--verbose') || ARGV.includes('-v');
const YEARS_BACK = (() => {
  const i = ARGV.indexOf('--years');
  const n = i >= 0 ? Number(ARGV[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
})();

// 公式の入口4ページ。ここから子ページを辿る。
const HUBS = {
  premium: `${BASE}/kouza/premium/`,
  super: `${BASE}/kouza/superpremium/`,
  ultra: `${BASE}/kouza/ultrapremium/`,
  plus10: `${BASE}/kouza/plus10/`,
};

const KIND_LABEL = {
  ultra: 'JRAウルトラプレミアム',
  super: 'JRAスーパープレミアム',
  premium: 'JRAプレミアム',
  plus10: 'JRAプラス10',
};

const WEEKDAY_JA = ['日曜', '月曜', '火曜', '水曜', '木曜', '金曜', '土曜'];

const log = (...a) => { if (VERBOSE) console.log(...a); };
const errors = [];
const notes = [];
const addError = (where, msg) => {
  errors.push({ where, message: String(msg) });
  console.warn(`⚠ ${where}: ${msg}`);
};

/* ───────────────────────── 取得と文字コード ───────────────────────── */

// JRA のページは Shift_JIS。将来 UTF-8 に変わっても壊れないよう meta charset を見て決める。
function decodeHtml(buf) {
  const head = Buffer.from(buf).subarray(0, 4096).toString('latin1');
  const m = head.match(/charset\s*=\s*["']?\s*([\w-]+)/i);
  let enc = (m && m[1] ? m[1] : 'shift_jis').toLowerCase();
  if (enc === 'sjis' || enc === 'x-sjis' || enc === 'ms932' || enc === 'windows-31j') enc = 'shift_jis';
  try {
    return new TextDecoder(enc).decode(buf);
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1ページ取る。取れなければ null を返して呼び手に判断させる(勝手に空データを作らない)。
async function fetchPage(url, { optional = false } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          // 素性を隠さない。相手のサーバーに迷惑をかけない間隔で叩く。
          'User-Agent': 'keiba-navigator/1.0 (personal use; premium-day checker)',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });
      clearTimeout(timer);
      if (!res.ok) {
        // JRA は「存在しないページ」に 403 を返す(お決まりのエラーページが出る)。
        // optional のページ(まだ公表されていない年度など)は失敗ではなく「未公表」。
        if (!optional) addError(url, `HTTP ${res.status}`);
        log(`  - ${url} → HTTP ${res.status}${optional ? '（未公表とみなす）' : ''}`);
        return null;
      }
      const html = decodeHtml(await res.arrayBuffer());
      // 200 でも中身がエラーページのことがあるので、それらしい語が無ければ採用しない。
      if (!/プレミアム|プラス10/.test(html)) {
        if (!optional) addError(url, '200 だが中身が想定のページではない');
        return null;
      }
      log(`  ✓ ${url} (${html.length.toLocaleString()}字)`);
      return html;
    } catch (e) {
      if (attempt === 3) {
        if (!optional) addError(url, e && e.message ? e.message : String(e));
        return null;
      }
      await sleep(800 * attempt);
    }
  }
  return null;
}

/* ───────────────────────── HTML のほぐし方 ───────────────────────── */

// ★最重要★ コメントを先に消す。古い日付がコメントで残っている罠があるため。
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}
function stripNoise(html) {
  return stripComments(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
}
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}
function toText(htmlFragment) {
  return decodeEntities(String(htmlFragment).replace(/<[^>]+>/g, ' '))
    .replace(/[\s　]+/g, ' ')
    .trim();
}
// 全角数字→半角。JRA は全角と半角が混ざる。
function toHankakuNum(s) {
  return String(s).replace(/[０-９．]/g, (c) => '0123456789.'['０１２３４５６７８９．'.indexOf(c)]);
}
function numOrNull(s) {
  if (s == null) return null;
  const n = Number(toHankakuNum(s));
  return Number.isFinite(n) ? n : null;
}

/* ───────────────────────── 払戻率をページ本文から読む ───────────────────────── */

// 数字を作らない。ページに書いてある文からだけ取る。取れなければ null。
function readPayout(kind, html) {
  if (!html) return { payoutPct: null, plusPct: null, payoutBasis: null };
  const body = toText(stripNoise(html));

  if (kind === 'ultra') {
    // 例: 「払戻率80％ ＋ 上乗せ5％」
    const m = body.match(/払戻率\s*([0-9０-９.．]+)\s*[%％]\s*[＋+]\s*上乗せ\s*([0-9０-９.．]+)\s*[%％]/);
    if (m) {
      const base = numOrNull(m[1]);
      const plus = numOrNull(m[2]);
      return {
        payoutPct: base != null && plus != null ? Math.round((base + plus) * 10) / 10 : null,
        plusPct: plus,
        payoutBasis: m[0],
      };
    }
  }
  if (kind === 'super') {
    // 例: 「全ての投票法の払戻率を上限である80.0％に設定いたします。」
    const m = body.match(/払戻率を上限である\s*([0-9０-９.．]+)\s*[%％]/);
    if (m) return { payoutPct: numOrNull(m[1]), plusPct: null, payoutBasis: m[0] };
  }
  if (kind === 'premium') {
    // 例: 「売上げの5％相当額を上乗せ」＝払戻率そのものは変わらないので payoutPct は null。
    const m = body.match(/売上げの\s*([0-9０-９.．]+)\s*[%％]相当額を上乗せ/);
    if (m) return { payoutPct: null, plusPct: numOrNull(m[1]), payoutBasis: m[0] };
  }
  if (kind === 'plus10') {
    // 例: 「10円を上乗せして110円」
    const m = body.match(/([0-9０-９]+)\s*円を上乗せして\s*([0-9０-９]+)\s*円/);
    if (m) return { payoutPct: null, plusPct: null, bonusYen: numOrNull(m[1]), payoutBasis: m[0] };
  }
  return { payoutPct: null, plusPct: null, payoutBasis: null };
}

/* ───────────────────────── 日付の組み立てと検算 ───────────────────────── */

function pad2(n) { return String(n).padStart(2, '0'); }

// ページが書いている曜日と、組み立てた日付の曜日が合うか確かめる。
// 合わなければ「年の推測を間違えた」ので採用しない。
function buildDate(year, month, day, weekdayText) {
  if (!year || !month || !day) return { date: null, weekdayOk: null, reason: '年月日が読めない' };
  if (month < 1 || month > 12 || day < 1 || day > 31) return { date: null, weekdayOk: null, reason: '月日が範囲外' };
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return { date: null, weekdayOk: null, reason: '存在しない日付' };
  }
  const date = `${year}${pad2(month)}${pad2(day)}`;
  let weekdayOk = null;
  if (weekdayText) {
    const want = WEEKDAY_JA.find((w) => weekdayText.includes(w));
    if (want) weekdayOk = WEEKDAY_JA[d.getUTCDay()] === want;
  }
  return { date, weekdayOk, weekday: WEEKDAY_JA[d.getUTCDay()], reason: null };
}

// 券種は「単勝5%UP」のような文言からだけ拾う。無ければ null（勝手に決めない）。
const BET_TYPES = ['単勝', '複勝', '枠連', '馬連', 'ワイド', '馬単', '3連複', '3連単', '三連複', '三連単', 'WIN5'];
function readBetTypes(...texts) {
  const src = texts.filter(Boolean).join(' ');
  const hit = BET_TYPES.filter((b) => src.includes(b));
  return hit.length ? [...new Set(hit)] : null;
}

// 「その日ぜんぶが対象か」は、証拠がある時だけ true。無ければ null（false とは言い切らない）。
function readWholeDay(...texts) {
  const src = texts.filter(Boolean).join(' ');
  if (/当日|全レース|全\s*[0-9０-９]+\s*レース/.test(src)) return true;
  return null;
}

function makeDay({
  kind, year, month, day, weekdayText, label, raceName, raceCount, source, resultPdf,
  section, note, endYear, endMonth, endDay, endWeekdayText, betTypes, coverage, detailUrl,
}) {
  const built = buildDate(year, month, day, weekdayText);
  if (!built.date) {
    addError(source, `日付を作れない (${year}/${month}/${day}) ${built.reason || ''}`);
    return null;
  }
  if (built.weekdayOk === false) {
    // ここが安全網。黙って間違った日を出さない。
    addError(source, `曜日が合わない: ページは「${weekdayText}」だが ${built.date} は ${built.weekday}。この行は採用しない`);
    return null;
  }

  // 期間もの（「1月5日から5月27日」など）の終わりの日
  let dateEnd = null;
  if (endMonth && endDay) {
    // 終わりに年が書いていないときは始まりと同じ年。月が戻るなら年をまたいでいる。
    let ey = endYear || year;
    if (!endYear && endMonth < month) ey = year + 1;
    const be = buildDate(ey, endMonth, endDay, endWeekdayText);
    if (be.date && be.weekdayOk !== false) dateEnd = be.date;
    else if (be.weekdayOk === false) {
      addError(source, `終わりの日の曜日が合わない（${label || ''}）。期間の終わりは入れない`);
    }
  }

  const evidence = [label, raceName, section, note].filter(Boolean).join(' ');
  return {
    date: built.date,
    dateEnd,                       // 期間ものだけ入る。1日だけなら null
    isRange: !!dateEnd,
    weekday: built.weekday,
    kind,
    // day     = その日まるごと対象（ウルトラ/スーパー）
    // campaign= 決まったレース・決まった券種だけ対象（プレミアムの企画もの）
    coverage: coverage || (kind === 'premium' ? 'campaign' : 'day'),
    label: label || KIND_LABEL[kind] || null,
    payoutPct: null,   // 後で種類ごとの値を入れる
    plusPct: null,
    payoutBasis: null,
    betTypes: betTypes ?? readBetTypes(evidence),
    wholeDay: readWholeDay(evidence),
    raceName: raceName || null,
    raceCount: raceCount ?? null,
    // ページは「東京11R」のような個別レース名の一覧までは載せていない。
    // 分からないものは推測せず null のままにする（detailUrl に本家のページを置く）。
    races: null,
    detailUrl: detailUrl || null,
    resultPdf: resultPdf || null,
    section: section || null,
    note: note || null,
    source,
  };
}

/* ───────────────────────── 各ページの読み取り ───────────────────────── */

// 「過去の結果」ページから、年度別ページ(2025ultrapremium.html など)の一覧を取る。
function findYearPages(html, baseUrl, fileSuffix) {
  if (!html) return [];
  const found = new Map();
  const re = new RegExp(`href="([^"]*?(\\d{4})${fileSuffix}\\.html)"`, 'gi');
  let m;
  while ((m = re.exec(html))) {
    const year = Number(m[2]);
    if (!Number.isFinite(year)) continue;
    found.set(year, new URL(m[1], baseUrl).href);
  }
  return [...found.entries()]
    .map(([year, url]) => ({ year, url }))
    .sort((a, b) => b.year - a.year);
}

// 年度別ページの表から「日付・レース名・結果PDF」を取る。
// 表の作りは2通りある:
//   2024年式: <td>2月18日（日曜）</td><td>コパノリッキーカップ</td><td>PDF</td>
//   2025年式: <td>5月4日（祝日・日曜）天皇賞（春）（GⅠ）当日</td><td>全36レース</td><td>PDF</td>
function parseYearPage(html, url, kind, year) {
  const out = [];
  if (!html) return out;
  const clean = stripNoise(html);

  // 見出しの年と、URLから読んだ年が食い違っていないか確かめる。
  const headYear = clean.match(/(\d{4})\s*年/);
  const pageYear = headYear ? Number(headYear[1]) : null;
  if (pageYear && pageYear !== year) {
    addError(url, `年が食い違う: URLは${year}年だがページ見出しは${pageYear}年。ページ側を採用する`);
  }
  const useYear = pageYear || year;

  for (const tableM of clean.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const table = tableM[1];
    // 表の直前にある小見出し（例「（1）GⅠレース当日」）を拾えたら添える。
    let section = null;
    const before = clean.slice(Math.max(0, tableM.index - 400), tableM.index);
    const secM = [...before.matchAll(/<(?:strong|h[2-5])[^>]*>([\s\S]{2,60}?)<\/(?:strong|h[2-5])>/gi)].pop();
    if (secM) section = toText(secM[1]) || null;

    // 表の直後の「注記：…」を拾う。WIN5が対象か対象外かがここに書いてあり、
    // 中身がまるで変わるので必ず持っておく（2024年は(1)は対象外・(2)は対象だった）。
    let note = null;
    const after = clean.slice(tableM.index + tableM[0].length, tableM.index + tableM[0].length + 600);
    const noteM = toText(after).match(/注記[：:]\s*([^注]{5,160})/);
    if (noteM) note = noteM[1].trim() || null;

    for (const rowM of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const row = rowM[1];
      const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1]);
      if (cells.length < 2) continue;
      const c0 = toText(cells[0]);
      const dm = c0.match(/^(\d{1,2})月(\d{1,2})日(?:（([^）]*)）)?\s*(.*)$/);
      if (!dm) continue; // 見出し行など

      const month = Number(dm[1]);
      const day = Number(dm[2]);
      const weekdayText = dm[3] || '';
      const restOfFirstCell = (dm[4] || '').trim();
      const c1 = toText(cells[1] || '');

      // 「全36レース」のような書き方なら頭数、そうでなければレース名として扱う。
      const both = [restOfFirstCell, c1].filter(Boolean).join(' ');
      const countM = both.match(/全\s*([0-9０-９]+)\s*レース/);
      const raceCount = countM ? numOrNull(countM[1]) : null;
      let raceName = null;
      if (!restOfFirstCell && c1 && !countM) raceName = c1;
      else if (restOfFirstCell) raceName = restOfFirstCell.replace(/\s+/g, ' ').trim() || null;

      // 結果PDFへのリンク
      let resultPdf = null;
      const pdfM = row.match(/href="([^"]+\.pdf)"/i);
      if (pdfM) { try { resultPdf = new URL(pdfM[1], url).href; } catch { /* 無視 */ } }

      const d = makeDay({
        kind, year: useYear, month, day, weekdayText,
        label: both || null, raceName, raceCount,
        source: url, resultPdf, section, note,
      });
      if (d) out.push(d);
    }
  }
  return out;
}

// JRAプレミアムの年度別ページは表ではなくカードの並び（3つめの書き方）。
//   <li><div class="block_unit"><h3>金杯ワイド</h3>
//       <p class="img"><img alt="…ワイド払戻金に売上げの5%相当額を上乗せ！"></p>
//       <p class="txt">2023年1月5日（木曜）</p>            ← 1日だけ
//       <p class="txt">2023年6月3日（土曜）から9月3日（日曜）</p> ← 期間もの
//       <div class="btn"><a href="…">詳細・結果</a></div>
// プレミアムは「決まったレース・決まった券種だけ」が対象なので、
// ウルトラ/スーパー（その日まるごと）とは別物として coverage='campaign' で入れる。
function parsePremiumCards(html, url, kind, year) {
  const out = [];
  if (!html) return out;
  const clean = stripNoise(html);

  const headYear = clean.match(/(\d{4})\s*年/);
  const useYear = headYear ? Number(headYear[1]) : year;

  for (const liM of clean.matchAll(/<div class="block_unit">([\s\S]*?)<\/li>/gi)) {
    const unit = liM[1];
    const nameM = unit.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const name = nameM ? toText(nameM[1]) : null;
    const txtM = unit.match(/<p class="txt"[^>]*>([\s\S]*?)<\/p>/i);
    const dateText = txtM ? toText(txtM[1]) : null;
    if (!name || !dateText) continue;

    // 「2023年1月5日（木曜）」／「2023年6月3日（土曜）から9月3日（日曜）」
    const sm = dateText.match(/(?:(\d{4})年)?\s*(\d{1,2})月\s*(\d{1,2})日\s*(?:（([^）]*)）)?/);
    if (!sm) continue;
    const em = dateText.match(/から\s*(?:(\d{4})年)?\s*(\d{1,2})月\s*(\d{1,2})日\s*(?:（([^）]*)）)?/);

    // 券種は企画名と、画像の説明文（alt）から拾う。ここに必ず書いてある。
    const altM = unit.match(/<img[^>]*\salt="([^"]*)"/i);
    const alt = altM ? decodeEntities(altM[1]) : null;

    let detailUrl = null;
    const aM = unit.match(/<a\b[^>]*href="([^"]+)"[^>]*>[\s\S]*?詳細/i);
    if (aM) { try { detailUrl = new URL(aM[1], url).href; } catch { /* 無視 */ } }

    const d = makeDay({
      kind,
      year: sm[1] ? Number(sm[1]) : useYear,
      month: Number(sm[2]), day: Number(sm[3]), weekdayText: sm[4] || '',
      endYear: em && em[1] ? Number(em[1]) : null,
      endMonth: em ? Number(em[2]) : null,
      endDay: em ? Number(em[3]) : null,
      endWeekdayText: em ? (em[4] || '') : null,
      label: name,
      raceName: name,
      betTypes: readBetTypes(name, alt),
      coverage: 'campaign',
      detailUrl,
      note: alt || null,
      source: url,
    });
    if (d) out.push(d);
  }
  return out;
}

// スーパープレミアムは表ではなく「2025年10月26日（日曜）の結果」というリンクの並び。
function parseSuperList(html, url, kind) {
  const out = [];
  if (!html) return out;
  const clean = stripNoise(html);
  const seen = new Set();
  for (const m of clean.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1];
    const text = toText(m[2]);
    const dm = text.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*（([^）]*)）\s*の結果/);
    if (!dm) continue;
    let resultPdf = null;
    try { resultPdf = new URL(href, url).href; } catch { /* 無視 */ }
    const d = makeDay({
      kind,
      year: Number(dm[1]), month: Number(dm[2]), day: Number(dm[3]),
      weekdayText: dm[4], label: text, source: url, resultPdf,
    });
    if (d && !seen.has(d.date)) { seen.add(d.date); out.push(d); }
  }
  return out;
}

/* ───────────────────────── 今日・次の日 ───────────────────────── */

function todayJst() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).replace(/-/g, '');
}

/* ───────────────────────── 本体 ───────────────────────── */

async function main() {
  const startedAt = new Date();
  console.log('JRA の払戻率アップ日を調べます…');

  const days = [];
  const alwaysOn = [];
  const probes = [];        // 「その年のページがあるか見に行った」記録
  const knownYears = {};    // 公式が結果を載せている年の一覧(取りに行かなかった年も含む)
  const payoutByKind = {};
  let fetchedAnything = false;

  // ── 1) 入口4ページ ─────────────────────────────
  const hubHtml = {};
  for (const [kind, url] of Object.entries(HUBS)) {
    log(`[${KIND_LABEL[kind]}]`);
    const html = await fetchPage(url);
    hubHtml[kind] = html;
    if (html) fetchedAnything = true;
    payoutByKind[kind] = readPayout(kind, html);
    await sleep(400); // 相手のサーバーに優しく
  }

  // ── 2) JRAプラス10 は「日付」ではなく「毎日ずっと」の制度 ──
  if (hubHtml.plus10) {
    const body = toText(stripNoise(hubHtml.plus10));
    const asOf = body.match(/(\d{4})\s*年実績\s*（\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
    const p = payoutByKind.plus10 || {};
    alwaysOn.push({
      kind: 'plus10',
      label: KIND_LABEL.plus10,
      scope: 'すべてのレース・すべての投票法（日付の指定なし・いつでも）',
      rule: '通常の払戻金が「100円元返し」になる場合に10円を上乗せして110円で払い戻す',
      bonusYen: p.bonusYen ?? null,
      payoutPct: null,
      payoutBasis: p.payoutBasis || null,
      statsYear: asOf ? Number(asOf[1]) : null,
      statsAsOf: asOf ? `${asOf[2]}${pad2(Number(asOf[3]))}${pad2(Number(asOf[4]))}` : null,
      source: HUBS.plus10,
    });
  }

  // ── 3) スーパープレミアム（入口ページに過去の実施日が並んでいる）──
  if (hubHtml.super) {
    const list = parseSuperList(hubHtml.super, HUBS.super, 'super');
    log(`  → スーパープレミアム ${list.length}日`);
    days.push(...list);
    knownYears.super = [...new Set(list.map((d) => Number(d.date.slice(0, 4))))].sort((a, b) => b - a);
  }

  // ── 4) ウルトラプレミアム／プレミアム（「過去の結果」→ 年度別ページ）──
  const yearly = [
    { kind: 'ultra', hub: HUBS.ultra, resultUrl: `${BASE}/kouza/ultrapremium/result.html`, suffix: 'ultrapremium' },
    { kind: 'premium', hub: HUBS.premium, resultUrl: `${BASE}/kouza/premium/result.html`, suffix: 'premium' },
  ];
  const thisYear = Number(todayJst().slice(0, 4));

  for (const y of yearly) {
    log(`[${KIND_LABEL[y.kind]} の過去の結果]`);
    const resultHtml = await fetchPage(y.resultUrl);
    if (resultHtml) fetchedAnything = true;
    await sleep(400);

    const listed = findYearPages(resultHtml, y.resultUrl, y.suffix);
    knownYears[y.kind] = listed.map((x) => x.year);
    log(`  公式が結果を載せている年: ${listed.map((x) => x.year).join(', ') || '（なし）'}`);

    // 読みに行く年 = 新しい方から YEARS_BACK 年ぶん ＋ 今年・来年（まだリンクが無くても直に見に行く）
    const targets = new Map();
    for (const x of listed.slice(0, YEARS_BACK)) targets.set(x.year, { url: x.url, optional: false });
    for (const yr of [thisYear, thisYear + 1]) {
      if (!targets.has(yr)) {
        targets.set(yr, { url: `${BASE}/kouza/${y.kind === 'ultra' ? 'ultrapremium' : 'premium'}/${yr}${y.suffix}.html`, optional: true });
      }
    }

    for (const [year, t] of [...targets.entries()].sort((a, b) => b[0] - a[0])) {
      const html = await fetchPage(t.url, { optional: t.optional });
      await sleep(400);
      if (t.optional) {
        probes.push({ kind: y.kind, year, url: t.url, found: !!html });
        if (!html) { log(`  ・${year}年の対象レース一覧はまだ公表されていない`); continue; }
      }
      if (!html) continue;
      fetchedAnything = true;
      // 年度別ページの書き方は2通りある。表があれば表、無ければカードの並び。
      let rows = parseYearPage(html, t.url, y.kind, year);
      if (!rows.length) rows = parsePremiumCards(html, t.url, y.kind, year);
      log(`  → ${year}年: ${rows.length}件`);
      days.push(...rows);
    }
  }

  // ── 5) 払戻率を種類ごとに入れる（ページ本文から読んだ値だけ）──
  for (const d of days) {
    const p = payoutByKind[d.kind] || {};
    d.payoutPct = p.payoutPct ?? null;
    d.plusPct = p.plusPct ?? null;
    d.payoutBasis = p.payoutBasis ?? null;
  }

  // ── 6) 並べ替えと重複除去 ──
  // ⚠ 鍵に label を必ず入れること。同じ日に始まる別の企画がある（2023年1月5日は
  //   「金杯ワイド」と「3歳重賞＋リステッドワイド」の2つが同時に始まっていた）。
  //   日付と種類だけを鍵にすると、片方が黙って消える。
  const uniq = new Map();
  for (const d of days) {
    const key = `${d.date}_${d.kind}_${d.label || ''}_${d.dateEnd || ''}`;
    if (!uniq.has(key)) uniq.set(key, d);
  }
  const allDays = [...uniq.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // ── 7) 今日／次の日 ──
  // 期間もの（プレミアムの企画）は「始まり〜終わり」の間なら今日に当たる。
  const today = todayJst();
  const coversToday = (d) => (d.dateEnd ? d.date <= today && today <= d.dateEnd : d.date === today);
  const todayAll = allDays.filter(coversToday);
  // その日まるごと払戻率が上がる方（ウルトラ/スーパー）を優先して today に出す。
  const todayEntry = todayAll.find((d) => d.coverage === 'day') || todayAll[0] || null;

  const future = allDays.filter((d) => d.date > today).sort((a, b) => (a.date > b.date ? 1 : -1));
  const nextEntry = future[0] || null;
  const nextWholeDay = future.find((d) => d.coverage === 'day') || null;

  if (!future.length) {
    notes.push(
      '公式ページには「これから実施する日」が1つも載っていません。' +
      'JRAウルトラプレミアム／スーパープレミアムは、年度ごとに対象日が決まったあとに公表されます。' +
      '＝「今日は該当なし」ではなく「予定がまだ公表されていない」状態です。'
    );
  }
  notes.push(
    'coverage が "day" のものは その日のぜんぶのレース・ぜんぶの券種が対象（ウルトラ／スーパー）。' +
    '"campaign" のものは 決まったレースの決まった券種だけが対象（プレミアムの企画もの）で、' +
    '期間（date〜dateEnd）の毎日ずっと払戻率が上がるという意味ではない。'
  );

  // ── 8) 全部失敗したときは、今ある良いファイルを壊さない ──
  if (!fetchedAnything) {
    addError('全体', 'JRAのページを1つも取得できませんでした。既存のJSONは上書きしません。');
    console.error('✗ 取得に失敗しました。ファイルは変更していません。');
    process.exitCode = 1;
    return;
  }

  const payload = {
    _readme: {
      なにこれ: 'JRA公式の「払戻率が上がる日(プレミアム系)」の一覧。JRA公式ページから機械が読み取ったもの。',
      作った台本: 'scripts/jra_premium_days.mjs',
      種類: {
        ultra: 'JRAウルトラプレミアム＝払戻率80%＋売上5%上乗せ（実質85%）',
        super: 'JRAスーパープレミアム＝全券種の払戻率を上限の80%に設定',
        premium: 'JRAプレミアム＝通常の払戻金に売上の5%相当額を上乗せ（払戻率そのものは変わらないので payoutPct は null）',
        plus10: 'JRAプラス10＝100円元返しのとき10円上乗せ。日付の指定なし＝いつでも。days ではなく alwaysOn に入れている',
      },
      約束: 'ページに書いていないことは書かない。読めなかった項目はすべて null。payoutPct もページの文言から読み取った値で、根拠は payoutBasis に入れてある。',
      注意: 'days は「過去に実施した日」が中心。これから実施する日は、JRAが公表するまで載らない（載っていなければ next は null）。',
    },
    fetchedAt: startedAt.toISOString(),
    today: todayEntry,
    todayAll,                 // 今日に当たるものが複数あるとき用
    todayDate: today,
    next: nextEntry,
    nextWholeDay,             // 「その日まるごと払戻率が上がる」次の日
    upcomingCount: future.length,
    days: allDays,
    alwaysOn,
    payoutByKind,
    knownYears,
    probes,
    sources: HUBS,
    notes,
    errors,
  };

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  // 書きかけを読まれないよう、いったん別名で書いてから置き換える。
  const tmp = `${OUT_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tmp, OUT_PATH);

  console.log(`✓ ${path.relative(ROOT, OUT_PATH)} を更新しました`);
  console.log(`  実施日: ${allDays.length}件 / これから: ${future.length}件 / 今日: ${todayEntry ? todayEntry.label : 'なし'}`);
  console.log(`  いつでも適用: ${alwaysOn.map((a) => a.label).join('、') || 'なし'}`);
  if (errors.length) console.log(`  読めなかったもの: ${errors.length}件（JSONの errors を見てください）`);
}

/* ───────────────────────── 自己点検（--selftest） ─────────────────────────
   「安全装置が本当に働くか」を、わざと壊した材料を食わせて確かめる。
   読めていないのに合格を出す検査が一番あぶないので、
   ここが1つでも落ちたら赤字で止める。
*/
function selftest() {
  let ok = 0, ng = 0;
  const check = (name, cond, detail) => {
    if (cond) { ok++; console.log(`  ✓ ${name}`); }
    else { ng++; console.log(`  ✗ ${name}${detail ? ` … ${detail}` : ''}`); }
  };
  const before = errors.length;

  console.log('自己点検をします（わざと壊した材料で安全装置を試します）');

  // 1) HTMLコメントの中の古い日付を拾わないこと（JRAプレミアムの実際の罠）
  const trap = '<p>いまの本文</p><!-- <p class="txt">2025年5月4日（祝日・日曜）</p> -->';
  check('コメントの中の古い日付を拾わない', !/2025年5月4日/.test(stripComments(trap)));

  // 2) 曜日が合わない行は採用しない（年の推測ミスを黙って通さない）
  //    2024年2月18日は日曜。わざと「火曜」と書いて弾かれるか見る。
  const good = makeDay({ kind: 'ultra', year: 2024, month: 2, day: 18, weekdayText: '日曜', label: 'テスト', source: 'selftest' });
  const bad = makeDay({ kind: 'ultra', year: 2024, month: 2, day: 18, weekdayText: '火曜', label: 'テスト', source: 'selftest' });
  check('正しい曜日の行は通る', good && good.date === '20240218', good ? good.date : 'null');
  check('曜日が食い違う行は捨てる', bad === null, bad ? '通してしまった' : '');

  // 3) 存在しない日付を作らない
  check('2月30日は作らない', makeDay({ kind: 'ultra', year: 2024, month: 2, day: 30, source: 'selftest' }) === null);

  // 4) 期間もの・年またぎ（12月→1月は翌年になる）
  const span = makeDay({
    kind: 'premium', year: 2023, month: 12, day: 30, weekdayText: '土曜',
    endMonth: 1, endDay: 8, endWeekdayText: '月曜', label: '年またぎテスト', source: 'selftest',
  });
  check('年をまたぐ期間の終わりを翌年にする', span && span.dateEnd === '20240108', span ? String(span.dateEnd) : 'null');

  // 5) 券種はページの文言からだけ拾う。無ければ null。
  check('券種を文言から拾う', JSON.stringify(readBetTypes('夏の2歳単勝', '単勝払戻金に売上げの5%相当額を上乗せ！')) === '["単勝"]');
  check('券種が書いていなければ null', readBetTypes('なにも書いていない') === null);

  // 6) 払戻率はページ本文から。書いていなければ null（勝手に85と書かない）。
  const u = readPayout('ultra', '<p>払戻率80％ ＋ 上乗せ5％</p>プレミアム');
  check('ウルトラの85%を本文から出す', u.payoutPct === 85, JSON.stringify(u));
  const s = readPayout('super', '<p>払戻率を上限である80.0％に設定いたします。</p>プレミアム');
  check('スーパーの80%を本文から出す', s.payoutPct === 80, JSON.stringify(s));
  const none = readPayout('ultra', '<p>なにも書いていない</p>プレミアム');
  check('書いていなければ払戻率は null', none.payoutPct === null);

  // 7) Shift_JIS を読めること
  const sjis = Buffer.from([0x95, 0xa5, 0x96, 0xdf, 0x97, 0xa6]); // 「払戻率」
  check('Shift_JIS を読める', decodeHtml(sjis).includes('払戻率'), decodeHtml(sjis));

  // 8) 同じ日に始まる別の企画を両方とも残す（黙って消さない）
  const two = [
    makeDay({ kind: 'premium', year: 2023, month: 1, day: 5, weekdayText: '木曜', label: '金杯ワイド', source: 'selftest' }),
    makeDay({ kind: 'premium', year: 2023, month: 1, day: 5, weekdayText: '木曜', label: '3歳重賞＋リステッドワイド', endMonth: 5, endDay: 27, endWeekdayText: '土曜', source: 'selftest' }),
  ].filter(Boolean);
  const keys = new Set(two.map((d) => `${d.date}_${d.kind}_${d.label || ''}_${d.dateEnd || ''}`));
  check('同じ日の別の企画が両方残る', keys.size === 2, `${keys.size}件`);

  // 9) 表の行の読み取り（2024年式／2025年式の両方）
  const t2024 = parseYearPage(
    '<h2>JRAウルトラプレミアム　2024年</h2><table><tr><td>2月18日（日曜）</td><td>コパノリッキーカップ</td>' +
    '<td><a href="pdf/feb.pdf">結果</a></td></tr></table>注記：GⅠ当日のWIN5は対象外となります。プレミアム',
    'https://www.jra.go.jp/kouza/ultrapremium/2024ultrapremium.html', 'ultra', 2024);
  check('2024年式の表を読める', t2024.length === 1 && t2024[0].date === '20240218' && t2024[0].raceName === 'コパノリッキーカップ', JSON.stringify(t2024[0] || null));
  check('注記（WIN5の扱い）も持ち帰る', !!(t2024[0] && t2024[0].note && t2024[0].note.includes('WIN5')), t2024[0] ? String(t2024[0].note) : '');

  const t2025 = parseYearPage(
    '<h2>JRAウルトラプレミアム　2025年</h2><table><tr><td>5月4日（祝日・日曜）天皇賞（春）当日</td><td>全36レース</td><td>x</td></tr></table>プレミアム',
    'https://www.jra.go.jp/kouza/ultrapremium/2025ultrapremium.html', 'ultra', 2025);
  check('2025年式（全36レース）を読める', t2025.length === 1 && t2025[0].date === '20250504' && t2025[0].raceCount === 36, JSON.stringify(t2025[0] || null));

  // 10) カード式（JRAプレミアムの年度別ページ）
  const cards = parsePremiumCards(
    '<h2>JRAプレミアム　2023年</h2><ul><li><div class="block_unit"><h3>夏の2歳単勝</h3>' +
    '<img alt="2歳単勝（夏季） 単勝払戻金に売上げの5%相当額を上乗せ！">' +
    '<p class="txt">2023年6月3日（土曜）から9月3日（日曜）</p>' +
    '<div class="btn"><a href="/kouza/premium/2sai/2023.html">詳細・結果</a></div></div></li></ul>プレミアム',
    'https://www.jra.go.jp/kouza/premium/2023premium.html', 'premium', 2023);
  check('カード式の期間ものを読める',
    cards.length === 1 && cards[0].date === '20230603' && cards[0].dateEnd === '20230903' &&
    cards[0].coverage === 'campaign' && JSON.stringify(cards[0].betTypes) === '["単勝"]',
    JSON.stringify(cards[0] || null));

  // 11) 存在しないページ（403のエラーページ）を中身として採用しない
  check('想定外のページは採用しない', !/プレミアム|プラス10/.test('<html><body>お探しのページは見つかりません</body></html>'));

  // 自己点検で足した errors は本番のものではないので戻しておく
  errors.length = before;

  console.log(`自己点検: 合格 ${ok} / 不合格 ${ng}`);
  if (ng > 0) {
    console.error('✗ 安全装置が働いていません。直してから使ってください。');
    process.exitCode = 1;
  } else {
    console.log('✓ 安全装置はぜんぶ働いています。');
  }
}

if (ARGV.includes('--selftest')) {
  selftest();
} else {
  main().catch((e) => {
    console.error('✗ 予期しないエラー:', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  });
}

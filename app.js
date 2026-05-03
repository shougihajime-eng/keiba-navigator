"use strict";

// KEIBA NAVIGATOR - 買わないAI / シンプル表示モード
// - ホーム / 記録 / 設定 の3タブ
// - エア馬券 / リアル馬券 を localStorage に保存
// - 仮データ時は記録ボタン無効

const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ─── localStorage キー ───────────────────────────────────────
const LS_KEY = "keiba_nav_v1";
const LS_TMP = LS_KEY + ":tmp";
const LS_BAK = LS_KEY + ":bak";
const STORE_VERSION = 1;
const MAX_BETS = 5000;          // bet数の上限(QuotaExceeded予防)
const QUOTA_TRIM_KEEP = 4000;   // QuotaExceeded時に残す件数

function defaultStore() {
  return {
    version: STORE_VERSION,
    funds: { daily: null, perRace: null, minEv: 1.10 },
    strategy: "balance",
    risk: "tight",
    bets: [],
  };
}

function migrateStore(parsed) {
  if (!parsed || typeof parsed !== "object") return defaultStore();
  // version 1: 現状の形式
  // 将来 version > 1 のとき、ここで段階的にマイグレートする
  if (!parsed.version) parsed.version = STORE_VERSION;
  // 必須プロパティの欠損補完
  if (!parsed.funds || typeof parsed.funds !== "object") parsed.funds = defaultStore().funds;
  if (!Array.isArray(parsed.bets)) parsed.bets = [];
  if (typeof parsed.strategy !== "string") parsed.strategy = "balance";
  if (typeof parsed.risk !== "string") parsed.risk = "tight";
  return parsed;
}

let _loadCorruptionDetected = false;
function loadStore() {
  let raw = null;
  try {
    raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultStore();
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("invalid_format");
    return Object.assign(defaultStore(), migrateStore(parsed));
  } catch (e) {
    // 壊れていた → バックアップに退避(復旧用)
    try {
      if (raw) localStorage.setItem(LS_BAK + "_" + Date.now(), raw);
    } catch {}
    _loadCorruptionDetected = true;
    return defaultStore();
  }
}

// アトミック保存: tmp に書いて読み戻し検証 → 成功時のみ本番キーに反映
// 失敗パターン:
//   - QuotaExceededError: 古いbetを自動トリムしてリトライ
//   - その他: トーストで通知しつつ false を返す
let _saveBusy = false;
function saveStore(s) {
  if (_saveBusy) {
    // 同時保存の取り合いを防ぐ(局所的・短時間の保護)
  }
  _saveBusy = true;
  try {
    return _saveStoreInner(s);
  } finally { _saveBusy = false; }
}

function _saveStoreInner(s, retry = 0) {
  try {
    const json = JSON.stringify(s);
    localStorage.setItem(LS_TMP, json);
    const back = localStorage.getItem(LS_TMP);
    if (back !== json) throw new Error("verify_failed");
    localStorage.setItem(LS_KEY, json);
    try { localStorage.removeItem(LS_TMP); } catch {}
    return { ok: true };
  } catch (e) {
    const isQuota = e && (e.name === "QuotaExceededError" || /quota/i.test(String(e.message || e)));
    if (isQuota && retry < 1 && Array.isArray(s.bets) && s.bets.length > QUOTA_TRIM_KEEP) {
      // 古いbetをトリム(新しい順を残す)
      const trimmed = [...s.bets].sort((a, b) => (b.ts || "").localeCompare(a.ts || "")).slice(0, QUOTA_TRIM_KEEP);
      const droppedCount = s.bets.length - trimmed.length;
      s.bets = trimmed;
      try { showToast("⚠ 容量上限に達したため古い記録 " + droppedCount + "件を削除しました", "warn"); } catch {}
      return _saveStoreInner(s, retry + 1);
    }
    if (typeof showToast === "function") showToast("✕ 保存に失敗しました: " + (e.message || e), "err");
    console.warn("[saveStore] failed", e);
    return { ok: false, error: String(e.message || e) };
  }
}

// localStorage 利用率(目安)
function storageUsagePct() {
  try {
    const raw = localStorage.getItem(LS_KEY) || "";
    // 多くのブラウザで5MB(=5*1024*1024 bytes)が目安
    return Math.min(100, Math.round((raw.length / (5 * 1024 * 1024)) * 100));
  } catch { return null; }
}

// ─── 共通ユーティリティ ─────────────────────────────────────
async function getJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    let body = null;
    try { body = await r.json(); }
    catch { body = { error: "JSON parse failed (HTTP " + r.status + ")" }; }
    // レート制限/サーバーエラーをUIに通知
    if (r.status === 429) {
      try { showToast("⏳ レート制限中です。少し時間を置いて再度更新してください", "warn"); } catch {}
    } else if (r.status >= 500 && r.status < 600) {
      try { showToast("⚠ サーバーエラー (" + r.status + ")。時間を置いて再試行してください", "warn"); } catch {}
    }
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: { error: String(e.message || e) } };
  }
}

function fmtDateTime(iso) {
  if (!iso) return "未取得";
  try {
    const d = new Date(iso); if (isNaN(d)) return iso;
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return iso; }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

// ─── トースト (kyotei-style 状態可視化) ─────────────────────
let _toastTimer = null;
function showToast(text, kind = "ok") {
  const el = $("#toast");
  if (!el) return;
  el.textContent = text;
  el.className = "toast toast-" + kind;
  el.hidden = false;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

function fmtOdds(v) { if (v == null || v === "") return "--"; const n = Number(v); return Number.isFinite(n) ? n.toFixed(1) : String(v); }
function fmtPct(v)  { if (v == null) return "--"; const n = Number(v); return Number.isFinite(n) ? (n * 100).toFixed(1) + "%" : "--"; }
function fmtYen(v)  { if (v == null || isNaN(v)) return "--"; return Math.round(Number(v)).toLocaleString("ja-JP") + "円"; }

// EVを「儲け率」として表示。EV 1.30 → +30%、EV 0.70 → -30%、EV 1.00 → ±0%
function fmtEvPct(ev) {
  if (ev == null || !Number.isFinite(Number(ev))) return "--";
  const n = (Number(ev) - 1) * 100;
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(0)}%`;
}

// ─── やさしい日本語への変換 ────────────────────────────────
function verdictToHuman(v) {
  return ({
    go: "狙える",
    neutral: "少額ならあり",
    pass: "見送り",
    judgement_unavailable: "データなし",
    fetch_failed: "通信エラー",
  })[v] || "判定中";
}

function verdictToIcon(v) {
  return ({ go: "🟢", neutral: "🟡", pass: "🔴", judgement_unavailable: "⚪", fetch_failed: "⚠️" })[v] || "⚪";
}

function confLabelHuman(score) {
  if (score == null) return "--";
  if (score < 0.20) return "仮データなので参考程度";
  if (score < 0.35) return "中くらい";
  return "高め";
}

function buildSimpleReason(c) {
  if (!c) return "出走馬データがまだありません。「更新」を押してください。";
  if (c.verdict === "fetch_failed") return "サーバーまたはネットワークに接続できませんでした。少し時間を置いて「更新」を押してください。";
  if (!c.ok) {
    if (c.verdict === "judgement_unavailable") return "出走馬のデータがまだありません。JRA-VAN接続後に判定できます。";
    return c.reason || "判定できません。";
  }
  const lines = [];
  if (c.verdict === "pass")          lines.push("人気馬が売れすぎていて、買う価値が薄いです。");
  else if (c.verdict === "neutral")  lines.push(c.picks?.length ? "ちょっとおいしい馬はいますが、信頼度は中くらいです。" : "おいしい馬は見つけにくいレースです。");
  else if (c.verdict === "go")       lines.push("オッズと予想のバランスが良く、狙えるレースです。");
  if (c.overpopular?.length) lines.push("人気しすぎの馬がいるので注意。");
  if (c.confidence != null && c.confidence < 0.20) lines.push("仮データなので強くは推奨しません。");
  return lines.join(" ");
}

function buildAdvice(c) {
  if (c?.verdict === "fetch_failed") return "通信が回復したら、もう一度「更新」を押してください。";
  if (!c || !c.ok) return "「更新」を押すと、その時点のデータで判定します。";
  if (c.verdict === "pass")    return "このレースは無理に買わず、次のレースを探すのがおすすめです。";
  if (c.verdict === "neutral") return "気になるなら少額だけ。当たれば嬉しい程度に考えましょう。";
  if (c.verdict === "go")      return "オッズの歪みが大きめ。少しだけ強気にいけそうです。";
  return "";
}

// 現在の結論データキャッシュ(記録時に参照)
let _currentConclusion = null;
let _currentRaceMeta = null;

// ─── 結論カード ────────────────────────────────────────────
function renderBigVerdict(c) {
  const el = $("#big-verdict");
  el.className = "big-verdict v-" + (c?.verdict || "loading");
  $("#bv-icon").textContent  = verdictToIcon(c?.verdict);
  $("#bv-title").textContent = verdictToHuman(c?.verdict);
  $("#bv-reason").textContent = buildSimpleReason(c);

  // EVグレード(S/A/B/C/D)を右上に表示
  const grade = c?.topGrade || (c?.picks?.[0]?.grade) || null;
  const gEl = $("#bv-grade");
  if (grade && (c?.verdict === "go" || c?.verdict === "neutral")) {
    gEl.hidden = false;
    gEl.textContent = grade;
    gEl.className = "bv-grade grade-" + grade;
  } else {
    gEl.hidden = true;
  }

  // 仮データバナー
  const isDummy = !!(c?.raceMeta?.isDummy)
    || (typeof c?.raceMeta?.source === "string" && /DUMMY|TEST|テスト|ダミー|SYNTHETIC/i.test(c.raceMeta.source));
  $("#demo-banner").hidden = !isDummy;
}

// ─── 買うならこれ ───────────────────────────────────────────
function renderPickCard(c) {
  const card = $("#card-pick");
  if (!c?.ok || !c.picks?.length) {
    card.hidden = true; return;
  }
  const top = c.picks[0];
  card.hidden = false;
  $("#pick-num").textContent  = top.number;
  $("#pick-name").textContent = top.name || "(馬名未取得)";

  // 理由は最大3行(短く)
  const reasonLines = [];
  const popularity = top.popularity ?? 99;
  if (popularity >= 6 && top.ev >= 1.10)   reasonLines.push("人気のわりに妙味あり");
  else if (top.grade === "S")              reasonLines.push("オッズと予想のバランスが良い");
  else if (top.grade === "A")              reasonLines.push("オッズ的にちょっとおいしい");
  else if (c.verdict === "neutral")        reasonLines.push("信頼度は低めなので少額で");
  else                                     reasonLines.push("候補までは届くが推奨度は低め");
  reasonLines.push(`期待値 ${fmtEvPct(top.ev)}・${fmtOdds(top.odds)}倍・${popularity !== 99 ? popularity + "番人気" : "人気未取得"}`);
  $("#pick-reason").textContent = reasonLines.join(" / ");

  const sg = c.bets || {};
  const parts = [];
  if (sg.tan)  parts.push(`単勝 ${(sg.tan + "").trim() || "--"}`);
  if (sg.fuku) parts.push(`複勝 ${(sg.fuku + "").trim() || "--"}`);
  $("#pick-suggest-text").textContent = parts.join(" / ") || "--";

  card.querySelector(".sc-title").textContent =
      c.verdict === "go"      ? "🟢 買うならこれ"
    : c.verdict === "neutral" ? "🟡 少額ならこれ"
    :                            "⚪ 候補だけ表示";

  // 仮データ時は記録ボタン無効化(「仮データで買い推奨しない」「未取得を取得済みのように扱わない」原則)
  const isDummy = !!(c?.raceMeta?.isDummy)
    || (typeof c?.raceMeta?.source === "string" && /DUMMY|TEST|テスト|ダミー|SYNTHETIC/i.test(c.raceMeta.source));
  $("#btn-record-air").disabled  = isDummy;
  $("#btn-record-real").disabled = isDummy;
  $("#pick-record-note").hidden  = !isDummy;
}

function renderDangerCard(c) {
  const card = $("#card-danger");
  if (!c?.ok || !c.overpopular?.length) { card.hidden = true; return; }
  card.hidden = false;
  const top = c.overpopular[0];
  $("#danger-num").textContent  = top.number;
  $("#danger-name").textContent = top.name || "(馬名未取得)";
  $("#danger-reason").textContent = "人気しすぎ・オッズが安すぎる";
}

function renderUnderCard(c) {
  const card = $("#card-underval");
  if (!c?.ok || !c.undervalued?.length) { card.hidden = true; return; }
  card.hidden = false;
  const top = c.undervalued[0];
  $("#under-num").textContent  = top.number;
  $("#under-name").textContent = top.name || "(馬名未取得)";
  $("#under-reason").textContent = `穴で面白い・期待値 ${fmtEvPct(top.ev)}・${fmtOdds(top.odds)}倍・${top.popularity ?? "?"}番人気`;
}

function renderAdvice(c) {
  $("#advice-text").textContent = buildAdvice(c);
}

// ─── AI実績スナップショット（ホーム画面・1週間・dummy除外） ────────────
function renderAiTrack() {
  const store = loadStore();
  const week = filterByPeriod(filterDummy(store.bets || []), "week");  // ★dummy除外
  const air  = week.filter(b => b.type === "air");
  const real = week.filter(b => b.type === "real");
  const sa = calcStats(air), sr = calcStats(real);
  $("#ai-period-label").textContent = "直近1週間";
  $("#ai-air-rec").textContent   = sa.confirmedCount ? `${(sa.recovery*100).toFixed(0)}%` : "結果待ち";
  $("#ai-air-hit").textContent   = sa.confirmedCount ? `${(sa.hitRate*100).toFixed(0)}%` : "--";
  $("#ai-air-cnt").textContent   = `${sa.count}件`;
  $("#ai-real-rec").textContent  = sr.confirmedCount ? `${(sr.recovery*100).toFixed(0)}%` : "結果待ち";
  $("#ai-real-hit").textContent  = sr.confirmedCount ? `${(sr.hitRate*100).toFixed(0)}%` : "--";
  $("#ai-real-cnt").textContent  = `${sr.count}件`;
  // 信頼度判定
  let trust;
  if (!sa.confirmedCount && !sr.confirmedCount) trust = { label: "まだ判断できません", cls: "trust-pending", note: "記録が少なすぎます" };
  else if ((sa.recovery ?? 0) >= 1.0 || (sr.recovery ?? 0) >= 1.0) trust = { label: "プラス収支(検証中)", cls: "trust-good", note: "ただし期間が短いので過信は禁物" };
  else trust = { label: "回収率<100%(検証中)", cls: "trust-warn", note: "実投資には十分慎重に" };
  const tEl = $("#ai-trust-label");
  tEl.textContent = trust.label;
  tEl.className = "ai-trust-label " + trust.cls;
  $("#ai-trust-note").textContent = trust.note;
  // ミニ収支グラフ(エア)
  drawMiniChart($("#ai-mini-chart"), air);
}

function drawMiniChart(canvas, bets) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const confirmed = bets.filter(b => b.result?.won === true || b.result?.won === false)
    .sort((a, b) => (a.result.finishedAt || a.ts).localeCompare(b.result.finishedAt || b.ts));
  if (confirmed.length === 0) {
    ctx.fillStyle = "#64748b";
    ctx.font = "11px Inter, sans-serif";
    ctx.fillText("結果待ち(まだ確定なし)", 8, H / 2 + 4);
    return;
  }
  let cum = 0;
  const series = confirmed.map(b => {
    cum += (b.result.won ? (b.result.payout || 0) : 0) - (b.amount || 0);
    return cum;
  });
  const minV = Math.min(0, ...series);
  const maxV = Math.max(0, ...series);
  const padX = 4, padY = 4;
  const plotW = W - padX * 2, plotH = H - padY * 2;
  const xAt = i => padX + (series.length === 1 ? plotW / 2 : (plotW * i) / (series.length - 1));
  const yAt = v => padY + plotH - ((v - minV) / Math.max(1, maxV - minV)) * plotH;
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padX, yAt(0)); ctx.lineTo(W - padX, yAt(0)); ctx.stroke();
  ctx.strokeStyle = series[series.length - 1] >= 0 ? "#34d399" : "#fca5a5";
  ctx.lineWidth = 2;
  ctx.beginPath();
  series.forEach((v, i) => { const x = xAt(i), y = yAt(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
}

// ─── 折りたたみ詳細 ────────────────────────────────────────
function renderProDetails(c) {
  $("#pro-model").textContent = c?.predictor ? `${c.predictor.name} v${c.predictor.version}` : "--";
  const conf = c?.confidence ?? null;
  $("#pro-confidence").textContent = conf != null ? `${(conf*100).toFixed(0)}% (${confLabelHuman(conf)})` : "--";
  $("#pro-verdict").textContent = c ? verdictToHuman(c.verdict) : "--";

  renderHorseList($("#buy-list"),         c?.picks       || [], "buy",     "未取得");
  renderHorseList($("#avoid-list"),       c?.avoid       || [], "avoid",   "該当なし");
  renderHorseList($("#overpopular-list"), c?.overpopular || [], "overpop", "該当なし");
  renderHorseList($("#undervalued-list"), c?.undervalued || [], "underval","該当なし");
  renderReason(c);
}

function renderHorseList(listEl, horses, kind, emptyMsg) {
  listEl.innerHTML = "";
  if (!horses?.length) {
    const li = document.createElement("li"); li.className = "pro-empty"; li.textContent = emptyMsg;
    listEl.appendChild(li); return;
  }
  for (const h of horses) {
    const li = document.createElement("li");
    li.className = "pro-item";
    const numCls = (kind === "buy")        ? ["honmei","taikou","tanaana"][horses.indexOf(h)] || "honmei"
                 : (kind === "avoid")      ? "avoid"
                 : (kind === "overpop")    ? "overpop"
                 : (kind === "underval")   ? "underval" : "";
    const grade = h.grade ? `<span class="grade-mini grade-${h.grade}">${h.grade}</span> ` : "";
    li.innerHTML = `
      <div class="horse-num ${numCls}">${escapeHtml(h.number)}</div>
      <div class="pro-item-info">
        <div class="pro-item-name">${grade}${escapeHtml(h.name || "(馬名未取得)")}</div>
        <div class="pro-item-meta">${fmtOdds(h.odds)}倍${h.popularity != null ? ` · ${escapeHtml(h.popularity)}人気` : ""}</div>
      </div>
    `;
    listEl.appendChild(li);
  }
}

function renderReason(c) {
  const ul = $("#reason-list"); ul.innerHTML = "";
  const list = c?.reasonList || [];
  if (!list.length) {
    const li = document.createElement("li"); li.className = "pro-empty"; li.textContent = "未取得";
    ul.appendChild(li); return;
  }
  for (const r of list) { const li = document.createElement("li"); li.textContent = r; ul.appendChild(li); }
}

// ─── 接続状態バナー ─────────────────────────────────────────
async function refreshConnection() {
  const r = await getJson("/api/connection");
  const c = r.body || {};
  const banner = $("#conn-banner");
  const title  = $("#conn-title");
  const sub    = $("#conn-sub");
  if (!banner) return;

  if (c.connected && c.canTrustPredictions) {
    banner.className = "conn-banner conn-connected";
    title.textContent = "✅ JV-Link 接続済 (実データ反映中)";
    const ageMin = c.ageSec != null ? Math.floor(c.ageSec / 60) : null;
    sub.textContent = ageMin != null ? `最終同期: ${ageMin}分前 / 実レース ${c.realRaceCount}件` : "最終同期: --";
  } else if (c.onlyDummyData) {
    banner.className = "conn-banner conn-dummy";
    title.textContent = "⚠️ 仮データのみ (実データ未接続)";
    sub.textContent = "JV-Link接続後にAIが本格稼働します。今は動作確認用の仮データのみ";
  } else if (c.noData) {
    banner.className = "conn-banner conn-disconnected";
    title.textContent = "🔴 JV-Link 未接続 / レースデータなし";
    sub.textContent = "AIは仮の分析のみ・本格データはJRA-VAN契約とJV-Link設定後に表示";
  } else {
    banner.className = "conn-banner conn-disconnected";
    title.textContent = "🔴 JV-Link 未接続";
    sub.textContent = "AIは仮の分析のみ・実データ未接続です";
  }
}

// ─── DATA STATUS ───────────────────────────────────────────
async function refreshStatus() {
  const r = await getJson("/api/status");
  const s = r.body || {};
  const list = $("#status-list");
  list.innerHTML = "";
  let okCount = 0, totalCount = 0, needSetup = false;
  for (const src of (s.sources || [])) {
    totalCount++;
    if (src.status === "available") okCount++;
    const li = document.createElement("li");
    li.className = "status-row " + src.status;
    const dotCls = src.status === "available" ? "dot-em" : "dot-am";
    let html = `<span class="dot ${dotCls}"></span><div class="flex-1 min-w-0">`;
    html += `<div class="status-label">${escapeHtml(src.label)}</div>`;
    if (src.reason) html += `<div class="status-reason">${escapeHtml(src.reason)}</div>`;
    html += `</div>`;
    li.innerHTML = html;
    list.appendChild(li);
    if (src.id === "race" && src.status !== "available") needSetup = true;
  }
  $("#status-counts").textContent = `(${okCount}/${totalCount})`;
  $("#setup-banner").hidden = !needSetup;
  $("#last-updated").textContent = fmtDateTime(s.fetchedAt);
}

// ─── CONCLUSION ────────────────────────────────────────────
async function refreshConclusion() {
  const r = await getJson("/api/conclusion");
  let c;
  if (r.status === 0) {
    c = { ok: false, verdict: "fetch_failed", reason: "通信エラー", picks: [], avoid: [], overpopular: [], undervalued: [], reasonList: [], bets: {}, raceMeta: null };
  } else {
    c = r.body || {};
  }
  _currentConclusion = c;
  _currentRaceMeta = c?.raceMeta || null;
  renderBigVerdict(c);
  renderPickCard(c);
  renderDangerCard(c);
  renderUnderCard(c);
  renderAdvice(c);
  renderProDetails(c);
}

// ─── WEATHER ───────────────────────────────────────────────
async function refreshWeather() {
  const r = await getJson("/api/weather");
  const grid = $("#weather-grid");
  grid.innerHTML = "";
  if (!r.ok || !r.body?.venues) {
    grid.innerHTML = `<div class="pro-empty">取得失敗</div>`; return;
  }
  for (const v of r.body.venues) {
    const card = document.createElement("div");
    card.className = "weather-mini" + (v.ok ? "" : " err");
    if (v.ok) {
      card.innerHTML = `
        <div class="name">${escapeHtml(v.venue.name)}</div>
        <div class="pref">${escapeHtml(v.venue.prefecture)}</div>
        <div class="w">${escapeHtml(v.today?.weather || "--")}</div>
      `;
    } else {
      card.innerHTML = `
        <div class="name">${escapeHtml(v.venue.name)}</div>
        <div class="w text-rose-300">取得失敗</div>
      `;
    }
    grid.appendChild(card);
  }
}

// ─── NEWS ──────────────────────────────────────────────────
async function refreshNews() {
  const r = await getJson("/api/news");
  const ul = $("#news-list"); ul.innerHTML = "";
  if (!r.ok || !r.body?.items?.length) {
    ul.innerHTML = `<li class="pro-empty">取得失敗</li>`;
    $("#news-count").textContent = ""; return;
  }
  $("#news-count").textContent = `(${r.body.items.length}件)`;
  for (const item of r.body.items) {
    const li = document.createElement("li");
    li.className = "news-row";
    const date = item.pubDate ? new Date(item.pubDate) : null;
    const dateText = date && !isNaN(date)
      ? `${date.getMonth()+1}/${date.getDate()} ${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`
      : "";
    li.innerHTML = `
      <a href="${escapeHtml(item.link || "#")}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title || "(タイトル未取得)")}</a>
      <div class="news-meta">
        ${item.sourceName ? `<span>${escapeHtml(item.sourceName)}</span>` : ""}
        ${dateText ? `<span>${escapeHtml(dateText)}</span>` : ""}
      </div>`;
    ul.appendChild(li);
  }
}

// ─── DETAIL TABLE ──────────────────────────────────────────
async function refreshDetail() {
  const r = await getJson("/api/race");
  const msg = $("#detail-message");
  const tbl = $("#horse-table");
  if (!r.ok) {
    msg.textContent = r.body?.reason || "出走馬データはまだ取得していません。";
    tbl.hidden = true; return;
  }
  const race = r.body.race;
  if (!race?.horses?.length) {
    msg.textContent = "出走馬データがまだありません。";
    tbl.hidden = true; return;
  }
  msg.textContent = `${race.race_name || "(レース名未取得)"} / 出典: ${race.source || "未取得"}`;
  const tbody = tbl.querySelector("tbody");
  tbody.innerHTML = "";
  for (const h of race.horses) {
    const tr = document.createElement("tr");
    tr.innerHTML = ["frame","number","name","sex_age","weight","jockey","trainer","win_odds","popularity","prev_finish"]
      .map((k, i) => {
        const v = h[k] ?? "—";
        const align = i >= 7 ? " text-right" : "";
        return `<td class="${align}">${escapeHtml(v)}</td>`;
      }).join("");
    tbody.appendChild(tr);
  }
  tbl.hidden = false;
}

// ─── 全レース一覧 ──────────────────────────────────────────
const GRADE_PRI = { S: 4, A: 3, B: 2, C: 1, D: 0 };
function gradePriority(g) { return GRADE_PRI[g] ?? -1; }

async function refreshRaces() {
  const r = await getJson("/api/races");
  const card = $("#card-races");
  const list = $("#races-list");
  const cnt  = $("#races-count");
  list.innerHTML = "";
  if (!r.ok || !r.body?.races?.length) {
    // 1レースしかない場合は一覧カードは非表示(ヒーローと結論カードで足りる)
    card.hidden = true;
    return;
  }
  const races = r.body.races;
  // 1レースだけでも、複数あるかのように見せると初心者が混乱する → 1件は隠す
  if (races.length <= 1) { card.hidden = true; return; }
  card.hidden = false;
  cnt.textContent = `(${races.length}件)`;
  const sorted = [...races].sort((a, b) => gradePriority(b.topGrade) - gradePriority(a.topGrade));
  for (const rc of sorted) {
    const li = document.createElement("li");
    li.className = "race-row v-" + (rc.verdict || "loading");
    const grade = rc.topGrade ? `<span class="grade-mini grade-${rc.topGrade}">${rc.topGrade}</span>` : "";
    const verdictText = verdictToHuman(rc.verdict);
    const verdictIcon = verdictToIcon(rc.verdict);
    const pickText = rc.topPick ? `${rc.topPick.number} ${escapeHtml(rc.topPick.name || "")}` : "—";
    const oddsText = rc.topPick ? `${fmtOdds(rc.topPick.odds)}倍` : "";
    li.innerHTML = `
      <div class="race-row-l">
        <span class="race-icon">${verdictIcon}</span>
        ${grade}
      </div>
      <div class="race-row-m">
        <div class="race-name">${escapeHtml(rc.raceName || "(レース名未取得)")}</div>
        <div class="race-meta">${verdictText} ・ ${pickText}</div>
      </div>
      <div class="race-row-r">
        <div class="race-odds">${oddsText}</div>
        ${rc.hasUnderval ? '<div class="race-flag race-flag-under">穴</div>' : ''}
      </div>
    `;
    list.appendChild(li);
  }
}

// ─── 自動保存(エア馬券) ───────────────────────────────────
// 仮データなら保存しない・同レース重複保存しない
function autoSaveAirBet(c) {
  if (!c?.ok || !c.picks?.length) return;
  if (c.verdict !== "go" && c.verdict !== "neutral") return;
  const isDummy = !!(c.raceMeta?.isDummy)
    || (typeof c.raceMeta?.source === "string" && /DUMMY|TEST|テスト|ダミー|SYNTHETIC/i.test(c.raceMeta.source));
  if (isDummy) return;

  const top = c.picks[0];
  const raceKey = c.raceMeta?.raceName || "unknown_race";
  const targetKey = `${top.number}`;
  const store = loadStore();
  // 重複排除: 同レース・同馬番・エア・24時間以内
  const exists = (store.bets || []).some(b =>
    b.type === "air"
    && b.raceName === raceKey
    && String(b.target).startsWith(targetKey)
    && (Date.now() - new Date(b.ts).getTime()) < 86400000
  );
  if (exists) return;

  const amount = store.funds.perRace || 100;
  store.bets.push({
    id: "auto_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
    ts: new Date().toISOString(),
    type: "air",
    auto: true,
    amount,
    raceName: raceKey,
    raceId: c.raceMeta?.raceId || null,
    target: `${top.number} ${top.name || ""}`.trim(),
    betType: "tan",
    odds: top.odds, prob: top.prob, ev: top.ev, grade: top.grade,
    dataSource: c.dataSource || c.raceMeta?.dataSource || "jv_link",
    result: { won: null, payout: null, finishedAt: null },
  });
  saveStore(store);
}

// ─── REFRESH ALL ───────────────────────────────────────────
let isRefreshing = false;
let _lastRefreshAt = 0;
const REFRESH_COOLDOWN_MS = 5000; // 連打防止
async function refreshAll() {
  if (isRefreshing) return;
  const sinceLast = Date.now() - _lastRefreshAt;
  if (sinceLast < REFRESH_COOLDOWN_MS) {
    const remain = Math.ceil((REFRESH_COOLDOWN_MS - sinceLast) / 1000);
    try { showToast("⏳ あと " + remain + " 秒お待ちください (連打防止)", "warn"); } catch {}
    return;
  }
  isRefreshing = true;
  _lastRefreshAt = Date.now();
  const btn = $("#btn-refresh");
  btn.classList.add("loading"); btn.disabled = true;
  const labelEl = btn.querySelector(".label");
  const original = labelEl.textContent;
  labelEl.textContent = "更新中…";
  try {
    await Promise.all([refreshConnection(), refreshStatus(), refreshConclusion(), refreshRaces(), refreshWeather(), refreshNews(), refreshDetail()]);
    // 結論データから自動保存(仮データはスキップ)
    autoSaveAirBet(_currentConclusion);
    // ホームのAI実績スナップショットを更新
    renderAiTrack();
  } finally {
    labelEl.textContent = original;
    btn.classList.remove("loading"); btn.disabled = false;
    isRefreshing = false;
    showToast("✓ 最新データを取得しました");
  }
}

// ─── タブ切替 ──────────────────────────────────────────────
function switchTab(name) {
  for (const pane of $$(".tab-pane")) pane.hidden = (pane.id !== `tab-${name}`);
  for (const b of $$(".bt-btn")) b.classList.toggle("active", b.dataset.tab === name);
  if (name === "record")   { renderRecords(); autoFinalizePending().catch(() => {}); }
  if (name === "settings") renderSettings();
  window.scrollTo(0, 0);
}

// 保留中bets を /api/finalize に POST して結果データがあれば確定する
async function autoFinalizePending() {
  const store = loadStore();
  const pending = (store.bets || []).filter(b =>
    !(b.result?.won === true || b.result?.won === false)
    && b.dataSource !== "dummy"
    && (b.raceId || b.race_id)
  );
  if (pending.length === 0) return;
  try {
    const r = await fetch("/api/finalize", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bets: pending }),
    });
    if (!r.ok) return;
    const j = await r.json();
    if (!j.ok || !j.updates?.length) return;
    // 更新を localStorage に反映
    const updateMap = new Map(j.updates.map(u => [u.id, u.finalize]));
    let changed = false;
    for (const b of store.bets) {
      const fin = updateMap.get(b.id);
      if (!fin) continue;
      b.result = { won: fin.won, payout: fin.payout, finishedAt: fin.finishedAt };
      b.factors = fin.factors;
      b.profit  = fin.profit;
      changed = true;
    }
    if (changed) {
      saveStore(store);
      renderRecords();
      renderAiTrack();
    }
  } catch {}
}

// ─── 馬券記録 ──────────────────────────────────────────────
function recordBet(kind /* 'air' | 'real' */) {
  if (!_currentConclusion?.ok || !_currentConclusion.picks?.length) {
    showToast("買い候補がないため記録できません", "warn");
    return;
  }
  const isDummy = !!(_currentRaceMeta?.isDummy)
    || (typeof _currentRaceMeta?.source === "string" && /DUMMY|TEST|テスト|ダミー|SYNTHETIC/i.test(_currentRaceMeta.source));
  if (isDummy) {
    showToast("仮データのため記録できません(実データ取得後に有効化)", "warn");
    return;
  }
  const pick = _currentConclusion.picks[0];
  const store = loadStore();
  const amount = Number(prompt("購入金額(円)を入力してください", String(store.funds.perRace || 100))) || 0;
  if (amount <= 0) return;
  if (store.funds.perRace && amount > store.funds.perRace) {
    if (!confirm(`1レース上限 ${store.funds.perRace}円 を超えています。続行しますか?`)) return;
  }
  store.bets.push({
    id: "b_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
    ts: new Date().toISOString(),
    type: kind,
    amount,
    raceName: _currentRaceMeta?.raceName || "(レース名なし)",
    raceId:   _currentRaceMeta?.raceId || null,
    target: `${pick.number} ${pick.name || ""}`.trim(),
    betType: "tan",
    odds: pick.odds,
    prob: pick.prob,
    ev: pick.ev,
    grade: pick.grade,
    dataSource: _currentConclusion?.dataSource || _currentRaceMeta?.dataSource || "unknown",
    result: { won: null, payout: null, finishedAt: null },
  });
  const r = saveStore(store);
  if (r.ok) {
    showToast(`${kind === "air" ? "🧪 エア" : "💰 リアル"} 馬券として記録しました`);
    // 記録タブ・ホームを即時リフレッシュ
    try { renderAiTrack(); } catch {}
    try { renderRecords(); } catch {}
  }
}

let _recPeriod = "week"; // 期間フィルター: today | week | month | all

function renderRecords() {
  const store = loadStore();
  const allBets = filterDummy(store.bets || []);  // ★dummy除外
  const periodBets = filterByPeriod(allBets, _recPeriod);
  // タブ切替: air / real / compare
  const activeRec = $$(".rec-tab").length ? [...$$(".rec-tab")].find(b => b.classList.contains("active"))?.dataset.rec : "air";
  if (activeRec === "compare") {
    $("#rec-list-pane").hidden = true;
    $("#rec-compare-pane").hidden = false;
    renderCompare(periodBets);
  } else {
    $("#rec-list-pane").hidden = false;
    $("#rec-compare-pane").hidden = true;
    const filtered = periodBets.filter(b => b.type === activeRec);
    renderBetStats(filtered);
    renderCharts(filtered);
    renderBetList(filtered);
  }
}

function filterByPeriod(bets, period) {
  if (period === "all" || !period) return [...bets];
  const now = Date.now();
  const day = 86400000;
  const cutoff = period === "today" ? now - day
              : period === "week"   ? now - 7  * day
              : period === "month"  ? now - 30 * day
              : 0;
  return bets.filter(b => new Date(b.ts).getTime() >= cutoff);
}

// 仮データ起源のbetは集計に含めない(混入禁止ルール)
let _includeDummy = false;
function filterDummy(bets) {
  if (_includeDummy) return [...bets];
  return bets.filter(b => b.dataSource !== "dummy");
}

function calcStats(bets) {
  // 結果待ちは収支に含めない (確定済のみ集計)
  const confirmed = bets.filter(b => b.result?.won === true || b.result?.won === false);
  const wins = confirmed.filter(b => b.result.won);
  const totalSpent  = confirmed.reduce((a, b) => a + (b.amount || 0), 0);
  const totalReturn = wins.reduce((a, b) => a + (b.result.payout || 0), 0);
  return {
    count: bets.length,
    pendingCount: bets.length - confirmed.length,
    confirmedCount: confirmed.length,
    winCount: wins.length,
    hitRate:  confirmed.length ? wins.length / confirmed.length : null,
    recovery: totalSpent ? totalReturn / totalSpent : null,
    pnl: totalReturn - totalSpent,
    totalSpent, totalReturn,
  };
}

function renderBetStats(bets) {
  const s = calcStats(bets);
  $("#rec-count").textContent    = s.count;
  $("#rec-hit").textContent      = s.hitRate != null ? `${(s.hitRate*100).toFixed(0)}%` : "結果待ち";
  $("#rec-recovery").textContent = s.recovery != null ? `${(s.recovery*100).toFixed(0)}%` : "結果待ち";
  $("#rec-pnl").textContent      = s.confirmedCount ? fmtYen(s.pnl) : "結果待ち";
}

function renderCharts(bets) {
  const wrap = $("#rec-charts");
  if (!bets || !bets.length) { wrap.hidden = true; return; }
  wrap.hidden = false;

  // ─── 累計収支ライン ────────────────────────────────
  const confirmed = bets
    .filter(b => b.result?.won === true || b.result?.won === false)
    .sort((a, b) => (a.result?.finishedAt || a.ts).localeCompare(b.result?.finishedAt || b.ts));
  const canvas = $("#chart-pnl");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (confirmed.length === 0) {
    ctx.fillStyle = "#64748b";
    ctx.font = "14px Inter, sans-serif";
    ctx.fillText("確定済みの記録がありません", 16, H / 2);
    return;
  }

  let cum = 0;
  const series = confirmed.map(b => {
    const profit = (b.result.won ? (b.result.payout || 0) : 0) - (b.amount || 0);
    cum += profit;
    return cum;
  });
  const minV = Math.min(0, ...series);
  const maxV = Math.max(0, ...series);
  const padX = 30, padT = 10, padB = 22;
  const plotW = W - padX * 2, plotH = H - padT - padB;
  const xAt = i => padX + (series.length === 1 ? plotW / 2 : (plotW * i) / (series.length - 1));
  const yAt = v => padT + plotH - ((v - minV) / Math.max(1, maxV - minV)) * plotH;

  // 0ラインのグリッド
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padX, yAt(0));
  ctx.lineTo(W - padX, yAt(0));
  ctx.stroke();

  // 折れ線
  ctx.strokeStyle = "#34d399";
  ctx.lineWidth = 2;
  ctx.beginPath();
  series.forEach((v, i) => {
    const x = xAt(i), y = yAt(v);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // 領域(プラスは緑、マイナスは赤)
  ctx.fillStyle = "rgba(52,211,153,0.18)";
  ctx.beginPath();
  ctx.moveTo(xAt(0), yAt(0));
  series.forEach((v, i) => ctx.lineTo(xAt(i), yAt(v)));
  ctx.lineTo(xAt(series.length - 1), yAt(0));
  ctx.closePath();
  ctx.fill();

  // 端点ラベル
  const last = series[series.length - 1];
  ctx.fillStyle = last >= 0 ? "#6ee7b7" : "#fca5a5";
  ctx.font = "bold 14px Inter, sans-serif";
  const label = (last >= 0 ? "+" : "") + Math.round(last).toLocaleString("ja-JP") + "円";
  ctx.fillText(label, W - padX - ctx.measureText(label).width, yAt(last) - 6);

  // 件数ラベル
  ctx.fillStyle = "#64748b";
  ctx.font = "11px Inter, sans-serif";
  ctx.fillText(`${confirmed.length}件 確定済`, padX, H - 6);

  // ─── グレード分布バー ────────────────────────────────
  const dist = $("#grade-dist");
  dist.innerHTML = "";
  const counts = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  for (const b of bets) {
    if (b.grade && counts[b.grade] != null) counts[b.grade]++;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) {
    dist.innerHTML = '<div class="pro-empty">グレード情報なし</div>';
    return;
  }
  for (const g of ["S", "A", "B", "C", "D"]) {
    const cnt = counts[g];
    const pct = (cnt / total) * 100;
    const bar = document.createElement("div");
    bar.className = "grade-bar";
    bar.innerHTML = `
      <div class="grade-bar-label"><span class="grade-mini grade-${g}">${g}</span></div>
      <div class="grade-bar-track"><div class="grade-bar-fill grade-fill-${g}" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="grade-bar-cnt">${cnt}件</div>
    `;
    dist.appendChild(bar);
  }
}

function renderBetList(bets) {
  const ul = $("#rec-list");
  ul.innerHTML = "";
  if (!bets.length) {
    ul.innerHTML = `<li class="pro-empty">記録がありません</li>`;
    return;
  }
  // 新しい順
  const sorted = [...bets].sort((a, b) => b.ts.localeCompare(a.ts));
  for (const b of sorted) {
    const li = document.createElement("li");
    li.className = "rec-item";
    const status = b.result?.won === true  ? `<span class="rec-st rec-win">的中 +${fmtYen(b.result.payout - b.amount)}</span>`
                 : b.result?.won === false ? `<span class="rec-st rec-lose">外れ -${fmtYen(b.amount)}</span>`
                 :                            `<span class="rec-st rec-pend">結果待ち</span>`;
    const gradeBadge = b.grade ? `<span class="grade-mini grade-${b.grade}">${b.grade}</span>` : "";
    li.innerHTML = `
      <div class="rec-row1">
        ${gradeBadge}
        <div class="rec-target">${escapeHtml(b.target)}</div>
        ${status}
      </div>
      <div class="rec-row2">
        <span>${escapeHtml(b.raceName)}</span>
        <span>${fmtYen(b.amount)} / ${fmtOdds(b.odds)}倍</span>
        <span>${fmtDateTime(b.ts).slice(5)}</span>
      </div>
    `;
    ul.appendChild(li);
  }
}

function renderCompare(allBets) {
  const air  = allBets.filter(b => b.type === "air");
  const real = allBets.filter(b => b.type === "real");
  const sa = calcStats(air), sr = calcStats(real);
  $("#cmp-air-rec").textContent   = sa.recovery != null ? `${(sa.recovery*100).toFixed(0)}%` : "結果待ち";
  $("#cmp-real-rec").textContent  = sr.recovery != null ? `${(sr.recovery*100).toFixed(0)}%` : "結果待ち";
  $("#cmp-air-count").textContent  = sa.count;
  $("#cmp-real-count").textContent = sr.count;
  $("#cmp-air-pnl").textContent  = sa.confirmedCount ? fmtYen(sa.pnl) : "結果待ち";
  $("#cmp-real-pnl").textContent = sr.confirmedCount ? fmtYen(sr.pnl) : "結果待ち";
  if (sa.confirmedCount && sr.confirmedCount) {
    const diff = sa.pnl - sr.pnl;
    const el = $("#cmp-diff");
    el.textContent = (diff >= 0 ? "+" : "") + fmtYen(diff);
    el.className = "rec-cmp-val " + (diff >= 0 ? "diff-pos" : "diff-neg");
  } else {
    $("#cmp-diff").textContent = "結果待ち";
    $("#cmp-diff").className = "rec-cmp-val";
  }
  // dual-line chart
  drawDualChart($("#chart-compare"), air, real);
}

function cumulativeSeries(bets) {
  const confirmed = bets.filter(b => b.result?.won === true || b.result?.won === false)
    .sort((a, b) => (a.result.finishedAt || a.ts).localeCompare(b.result.finishedAt || b.ts));
  let cum = 0;
  return confirmed.map(b => { cum += (b.result.won ? (b.result.payout || 0) : 0) - (b.amount || 0); return cum; });
}

function drawDualChart(canvas, airBets, realBets) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const sA = cumulativeSeries(airBets);
  const sR = cumulativeSeries(realBets);
  const all = [0, ...sA, ...sR];
  const minV = Math.min(...all);
  const maxV = Math.max(...all);
  if (sA.length === 0 && sR.length === 0) {
    ctx.fillStyle = "#64748b";
    ctx.font = "14px Inter, sans-serif";
    ctx.fillText("確定済みの記録がありません", 16, H / 2);
    return;
  }
  const padX = 30, padT = 20, padB = 26;
  const plotW = W - padX * 2, plotH = H - padT - padB;
  const maxLen = Math.max(sA.length, sR.length, 2);
  const xAt = i => padX + (plotW * i) / Math.max(1, maxLen - 1);
  const yAt = v => padT + plotH - ((v - minV) / Math.max(1, maxV - minV)) * plotH;

  // 0グリッド
  ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padX, yAt(0)); ctx.lineTo(W - padX, yAt(0)); ctx.stroke();

  // エア(緑)
  if (sA.length > 0) {
    ctx.strokeStyle = "#34d399"; ctx.lineWidth = 2;
    ctx.beginPath();
    sA.forEach((v, i) => { const x = xAt(i), y = yAt(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();
  }
  // リアル(オレンジ)
  if (sR.length > 0) {
    ctx.strokeStyle = "#fb923c"; ctx.lineWidth = 2;
    ctx.beginPath();
    sR.forEach((v, i) => { const x = xAt(i), y = yAt(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();
  }

  // 凡例
  ctx.font = "11px Inter, sans-serif";
  ctx.fillStyle = "#34d399"; ctx.fillRect(padX,      6, 12, 4);
  ctx.fillStyle = "#cbd5e1"; ctx.fillText(`エア (${sA.length}件確定)`,  padX + 16, 12);
  ctx.fillStyle = "#fb923c"; ctx.fillRect(padX + 130, 6, 12, 4);
  ctx.fillStyle = "#cbd5e1"; ctx.fillText(`リアル (${sR.length}件確定)`, padX + 146, 12);
}

// ─── 設定タブ ──────────────────────────────────────────────
function renderSettings() {
  const store = loadStore();
  $("#set-daily").value   = store.funds.daily   ?? "";
  $("#set-perrace").value = store.funds.perRace ?? "";
  $("#set-minev").value   = store.funds.minEv   ?? "";
  for (const b of $$('[data-strategy]')) b.classList.toggle("active", b.dataset.strategy === store.strategy);
  for (const b of $$('[data-risk]'))     b.classList.toggle("active", b.dataset.risk     === store.risk);
  refreshStorageUsage();
}

function persistSettings() {
  const store = loadStore();
  const d  = Number($("#set-daily").value);
  const pr = Number($("#set-perrace").value);
  const ev = Number($("#set-minev").value);
  store.funds = {
    daily:   Number.isFinite(d)  && d  > 0 ? d  : null,
    perRace: Number.isFinite(pr) && pr > 0 ? pr : null,
    minEv:   Number.isFinite(ev) && ev > 0 ? ev : 1.10,
  };
  const r = saveStore(store);
  if (r.ok) showToast("✓ 保存しました");
}

// ─── イベント設定 ──────────────────────────────────────────
function setupEvents() {
  // 更新ボタン
  $("#btn-refresh").addEventListener("click", () => refreshAll());

  // 記録ボタン
  $("#btn-record-air") .addEventListener("click", () => recordBet("air"));
  $("#btn-record-real").addEventListener("click", () => recordBet("real"));

  // ボトムタブ
  for (const b of $$(".bt-btn")) {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  }

  // 記録内サブタブ
  for (const b of $$(".rec-tab")) {
    b.addEventListener("click", () => {
      for (const o of $$(".rec-tab")) o.classList.toggle("active", o === b);
      renderRecords();
    });
  }

  // 期間フィルター
  for (const b of $$(".period-pill")) {
    b.addEventListener("click", () => {
      _recPeriod = b.dataset.period;
      for (const o of $$(".period-pill")) o.classList.toggle("active", o === b);
      renderRecords();
    });
  }

  // 設定: 戦略
  for (const b of $$('[data-strategy]')) {
    b.addEventListener("click", () => {
      const store = loadStore();
      store.strategy = b.dataset.strategy;
      saveStore(store);
      for (const o of $$('[data-strategy]')) o.classList.toggle("active", o === b);
      showToast("✓ 戦略: " + b.querySelector(".strategy-name")?.textContent);
    });
  }
  // 設定: リスク
  for (const b of $$('[data-risk]')) {
    b.addEventListener("click", () => {
      const store = loadStore();
      store.risk = b.dataset.risk;
      saveStore(store);
      for (const o of $$('[data-risk]')) o.classList.toggle("active", o === b);
      showToast("✓ リスク: " + b.querySelector(".strategy-name")?.textContent);
    });
  }
  // 設定: 入力欄 (change のみ — blur は change と二重発火するので削除)
  for (const sel of ["#set-daily", "#set-perrace", "#set-minev"]) {
    $(sel).addEventListener("change", persistSettings);
  }

  // 全記録消去
  $("#btn-clear-records").addEventListener("click", () => {
    if (!confirm("全ての記録を削除します。よろしいですか?")) return;
    const store = loadStore();
    store.bets = [];
    saveStore(store);
    renderRecords();
  });

  // 全データ消去 + 再読み込み
  $("#btn-clear-all").addEventListener("click", () => {
    if (!confirm("記録と設定を全て消去します。よろしいですか?")) return;
    try { localStorage.removeItem(LS_KEY); } catch {}
    location.reload();
  });
  $("#btn-reload").addEventListener("click", () => location.reload());

  // エクスポート
  $("#btn-export")?.addEventListener("click", () => {
    try {
      const raw = localStorage.getItem(LS_KEY) || JSON.stringify(defaultStore());
      const blob = new Blob([raw], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.href = url; a.download = `keiba_navigator_backup_${ts}.json`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
      showToast("✓ エクスポートしました");
    } catch (e) {
      showToast("✕ エクスポート失敗: " + (e.message || e), "err");
    }
  });

  // インポート
  $("#file-import")?.addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) throw new Error("invalid format");
      // 既存データの安全のため、現在の保存をバックアップ
      try {
        const cur = localStorage.getItem(LS_KEY);
        if (cur) localStorage.setItem(LS_BAK + "_imported_" + Date.now(), cur);
      } catch {}
      const r = saveStore(Object.assign(defaultStore(), migrateStore(parsed)));
      if (r.ok) {
        showToast("✓ インポートしました");
        renderSettings();
        renderRecords();
        renderAiTrack();
      }
    } catch (e) {
      showToast("✕ インポート失敗: " + (e.message || e), "err");
    } finally {
      ev.target.value = "";  // 同じファイルを連続で選べるようにリセット
    }
  });
}

// 保存容量を設定タブに表示
function refreshStorageUsage() {
  const el = $("#storage-usage");
  if (!el) return;
  const pct = storageUsagePct();
  const store = loadStore();
  const betCount = store.bets?.length || 0;
  if (pct == null) { el.textContent = "保存容量: --"; return; }
  el.textContent = `保存容量: 約 ${pct}% / 記録 ${betCount}件 (上限 ${MAX_BETS}件目安)`;
  if (pct >= 80) el.style.color = "#fca5a5";
  else if (pct >= 50) el.style.color = "#fcd34d";
  else el.style.color = "";
}

document.addEventListener("DOMContentLoaded", () => {
  setupEvents();
  // 接続バナーは初期表示時にも更新(更新ボタン押す前から状態を見せる)
  refreshConnection().catch(() => {});
  // 初期化: 記録/設定タブの初期描画(裏側でも整合性確保)
  try { renderSettings(); } catch (e) { console.warn(e); }
  try { renderRecords();  } catch (e) { console.warn(e); }
  // ホームのAI実績は記録があれば最初から見せる
  try { renderAiTrack(); } catch (e) { console.warn(e); }
  // 起動時に corruption が検出されていれば通知
  if (_loadCorruptionDetected) {
    setTimeout(() => showToast("⚠ 保存データの一部が壊れていたため初期化しました(バックアップは保持)", "warn"), 800);
  }
});

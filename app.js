"use strict";

// KEIBA NAVIGATOR - シンプル表示モード (やさしい日本語)
// 内部はEV計算をそのまま使い、表示だけ平易な言葉に変換する。

const $ = (s) => document.querySelector(s);

async function getJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    return { ok: r.ok, status: r.status, body: await r.json() };
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

function fmtOdds(v) {
  if (v == null || v === "") return "--";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(1) : String(v);
}

function fmtPct(v) {
  if (v == null) return "--";
  const n = Number(v);
  return Number.isFinite(n) ? (n * 100).toFixed(1) + "%" : "--";
}

// ─── やさしい日本語への変換 ────────────────────────────────────
function evToHumanLabel(ev) {
  if (ev == null) return "判定なし";
  if (ev >= 1.30) return "オッズ的にかなりおいしい";
  if (ev >= 1.10) return "オッズ的に少しおいしい";
  if (ev >= 1.00) return "ややおいしい";
  if (ev >= 0.85) return "ふつう";
  if (ev >= 0.70) return "やや人気しすぎ";
  return "人気しすぎで危険";
}

function verdictToHuman(v) {
  // 結論は3種類だけ + データなし + 通信エラー
  return ({
    go: "狙える",
    neutral: "少額ならあり",
    pass: "見送り",
    judgement_unavailable: "データなし",
    fetch_failed: "通信エラー",
  })[v] || "判定中";
}

function verdictToIcon(v) {
  return ({
    go: "🟢",
    neutral: "🟡",
    pass: "🔴",
    judgement_unavailable: "⚪",
    fetch_failed: "⚠️",
  })[v] || "⚪";
}

function confLabelHuman(score) {
  if (score == null) return "--";
  if (score < 0.20) return "仮データなので参考程度";
  if (score < 0.35) return "中くらい";
  return "高め";
}

// 結論カードに出す「短い理由」(2-3行を目標)
function buildSimpleReason(c) {
  if (!c) return "出走馬データがまだありません。「更新」を押してください。";
  if (c.verdict === "fetch_failed") {
    return "サーバーまたはネットワークに接続できませんでした。少し時間を置いて「更新」を押してください。";
  }
  if (!c.ok) {
    if (c.verdict === "judgement_unavailable") {
      return "出走馬のデータがまだありません。JRA-VAN接続後に判定できます。";
    }
    return c.reason || "判定できません。";
  }
  const lines = [];
  if (c.verdict === "pass") {
    lines.push("人気馬が売れすぎていて、買う価値が薄いです。");
  } else if (c.verdict === "neutral") {
    if (c.picks?.length) lines.push("ちょっとおいしい馬はいますが、信頼度は中くらいです。");
    else                 lines.push("おいしい馬は見つけにくいレースです。");
  } else if (c.verdict === "go") {
    lines.push("オッズと予想のバランスが良く、狙えるレースです。");
  }
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

// ─── 結論カード ────────────────────────────────────────────────
function renderBigVerdict(c) {
  const el = $("#big-verdict");
  el.className = "big-verdict v-" + (c?.verdict || "loading");
  $("#bv-icon").textContent  = verdictToIcon(c?.verdict);
  $("#bv-title").textContent = verdictToHuman(c?.verdict);
  $("#bv-reason").textContent = buildSimpleReason(c);

  // 仮データバナーの表示制御
  const isDummy = !!(c?.raceMeta?.isDummy)
    || (typeof c?.raceMeta?.source === "string" && /DUMMY|TEST|テスト|ダミー|SYNTHETIC/i.test(c.raceMeta.source));
  $("#demo-banner").hidden = !isDummy;
}

// ─── 買うならこれ (1頭・短い理由) ─────────────────────────────
function renderPickCard(c) {
  const card = $("#card-pick");
  if (!c?.ok || !c.picks?.length) {
    card.hidden = true;
    return;
  }
  const top = c.picks[0];
  card.hidden = false;
  $("#pick-num").textContent  = top.number;
  $("#pick-name").textContent = top.name || "(馬名未取得)";

  // 短い理由(一語〜一文)
  let reason;
  const popularity = top.popularity ?? 99;
  if (popularity >= 6 && top.ev >= 1.10)        reason = "人気のわりに妙味あり";
  else if (top.ev >= 1.30)                       reason = "オッズと予想のバランスが良い";
  else if (top.ev >= 1.10)                       reason = "オッズ的にちょっとおいしい";
  else if (c.verdict === "neutral")              reason = "信頼度は低めなので少額で";
  else                                           reason = "候補までは届くが推奨度は低め";
  $("#pick-reason").textContent = reason;

  // 買い目(クワイエットに表示)
  const sg = c.bets || {};
  const parts = [];
  if (sg.tan)  parts.push(`単勝 ${escapeText(sg.tan)}`);
  if (sg.fuku) parts.push(`複勝 ${escapeText(sg.fuku)}`);
  $("#pick-suggest-text").textContent = parts.join(" / ") || "--";

  // タイトルを結論に合わせる
  card.querySelector(".sc-title").textContent =
      c.verdict === "go"      ? "🟢 買うならこれ"
    : c.verdict === "neutral" ? "🟡 少額ならこれ"
    :                            "⚪ 候補だけ表示";
}

function escapeText(s) { return String(s ?? "").trim() || "--"; }

// ─── 危険な人気馬 ──────────────────────────────────────────────
function renderDangerCard(c) {
  const card = $("#card-danger");
  if (!c?.ok || !c.overpopular?.length) { card.hidden = true; return; }
  card.hidden = false;
  const top = c.overpopular[0];
  $("#danger-num").textContent  = top.number;
  $("#danger-name").textContent = top.name || "(馬名未取得)";
  $("#danger-reason").textContent = "人気しすぎ・オッズが安すぎる";
}

// ─── 穴で面白い ────────────────────────────────────────────────
function renderUnderCard(c) {
  const card = $("#card-underval");
  if (!c?.ok || !c.undervalued?.length) { card.hidden = true; return; }
  card.hidden = false;
  const top = c.undervalued[0];
  $("#under-num").textContent  = top.number;
  $("#under-name").textContent = top.name || "(馬名未取得)";
  $("#under-reason").textContent = "オッズがつきすぎ・穴で面白い";
}

// ─── 今日のひとこと ────────────────────────────────────────────
function renderAdvice(c) {
  $("#advice-text").textContent = buildAdvice(c);
}

// ─── プロビュー(折りたたみ): 詳しい数字 ──────────────────────
function renderProDetails(c) {
  $("#pro-model").textContent = c?.predictor ? `${c.predictor.name} v${c.predictor.version}` : "--";
  const conf = c?.confidence ?? null;
  $("#pro-confidence").textContent = conf != null
    ? `${(conf*100).toFixed(0)}% (${confLabelHuman(conf)})`
    : "--";
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
    const li = document.createElement("li");
    li.className = "pro-empty";
    li.textContent = emptyMsg;
    listEl.appendChild(li);
    return;
  }
  for (const h of horses) {
    const li = document.createElement("li");
    li.className = "pro-item";
    const numCls = (kind === "buy")        ? ["honmei","taikou","tanaana"][horses.indexOf(h)] || "honmei"
                 : (kind === "avoid")      ? "avoid"
                 : (kind === "overpop")    ? "overpop"
                 : (kind === "underval")   ? "underval" : "";
    li.innerHTML = `
      <div class="horse-num ${numCls}">${escapeHtml(h.number)}</div>
      <div class="pro-item-info">
        <div class="pro-item-name">${escapeHtml(h.name || "(馬名未取得)")}</div>
        <div class="pro-item-meta">
          ${fmtOdds(h.odds)}倍${h.popularity != null ? ` · ${escapeHtml(h.popularity)}人気` : ""} · ${escapeHtml(evToHumanLabel(h.ev))}
        </div>
      </div>
    `;
    listEl.appendChild(li);
  }
}

function renderReason(c) {
  const ul = $("#reason-list");
  ul.innerHTML = "";
  const list = c?.reasonList || [];
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "pro-empty";
    li.textContent = "未取得";
    ul.appendChild(li);
    return;
  }
  for (const r of list) {
    const li = document.createElement("li");
    li.textContent = r;
    ul.appendChild(li);
  }
}

// ─── DATA STATUS (折りたたみ) ─────────────────────────────────
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

// ─── CONCLUSION ────────────────────────────────────────────────
async function refreshConclusion() {
  const r = await getJson("/api/conclusion");
  let c;
  if (r.status === 0) {
    // ネットワーク到達不能
    c = { ok: false, verdict: "fetch_failed", reason: "通信エラー", picks: [], avoid: [], overpopular: [], undervalued: [], reasonList: [], bets: {}, raceMeta: null };
  } else {
    c = r.body || {};
  }
  renderBigVerdict(c);
  renderPickCard(c);
  renderDangerCard(c);
  renderUnderCard(c);
  renderAdvice(c);
  renderProDetails(c);
}

// ─── WEATHER ───────────────────────────────────────────────────
async function refreshWeather() {
  const r = await getJson("/api/weather");
  const grid = $("#weather-grid");
  grid.innerHTML = "";
  if (!r.ok || !r.body?.venues) {
    grid.innerHTML = `<div class="pro-empty">取得失敗</div>`;
    return;
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

// ─── NEWS ──────────────────────────────────────────────────────
async function refreshNews() {
  const r = await getJson("/api/news");
  const ul = $("#news-list"); ul.innerHTML = "";
  if (!r.ok || !r.body?.items?.length) {
    ul.innerHTML = `<li class="pro-empty">取得失敗</li>`;
    $("#news-count").textContent = "";
    return;
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
      </div>
    `;
    ul.appendChild(li);
  }
}

// ─── DETAIL TABLE (折りたたみ) ────────────────────────────────
async function refreshDetail() {
  const r = await getJson("/api/race");
  const msg = $("#detail-message");
  const tbl = $("#horse-table");
  if (!r.ok) {
    msg.textContent = r.body?.reason || "出走馬データはまだ取得していません。";
    tbl.hidden = true;
    return;
  }
  const race = r.body.race;
  if (!race?.horses?.length) {
    msg.textContent = "出走馬データがまだありません。";
    tbl.hidden = true;
    return;
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

// ─── REFRESH ALL ───────────────────────────────────────────────
let isRefreshing = false;
async function refreshAll() {
  if (isRefreshing) return;
  isRefreshing = true;
  const btn = $("#btn-refresh");
  btn.classList.add("loading");
  btn.disabled = true;
  const labelEl = btn.querySelector(".label");
  const original = labelEl.textContent;
  labelEl.textContent = "更新中…";
  try {
    await Promise.all([refreshStatus(), refreshConclusion(), refreshWeather(), refreshNews(), refreshDetail()]);
  } finally {
    labelEl.textContent = original;
    btn.classList.remove("loading");
    btn.disabled = false;
    isRefreshing = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("#btn-refresh").addEventListener("click", () => refreshAll());
});

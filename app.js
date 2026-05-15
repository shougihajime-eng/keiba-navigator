"use strict";

// KEIBA NAVIGATOR - 買わないAI / シンプル表示モード
// - ホーム / 記録 / 設定 の3タブ
// - エア馬券 / リアル馬券 を localStorage に保存
// - 仮データ時は記録ボタン無効

const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ─── localStorage キー ───────────────────────────────────────
const LS_KEY = "keiba_nav_v1";
const LS_BAK = LS_KEY + ":bak";
const STORE_VERSION = 1;
const MAX_BETS = 5000;

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
  if (!parsed.version) parsed.version = STORE_VERSION;
  if (!parsed.funds || typeof parsed.funds !== "object") parsed.funds = defaultStore().funds;
  if (!Array.isArray(parsed.bets)) parsed.bets = [];
  if (typeof parsed.strategy !== "string") parsed.strategy = "balance";
  if (typeof parsed.risk !== "string") parsed.risk = "tight";
  return parsed;
}

// ─── Storage 経由の同期キャッシュ ────────────────────────────
// アプリ全体は loadStore() を sync で呼ぶ前提なので、
// 起動時に Storage.load() を await してキャッシュに入れる。
// 以降は _storeCache が真。saveStore はキャッシュを更新しつつ
// Storage に async で永続化する (localStorage + cloud)。
let _storeCache = null;
let _loadCorruptionDetected = false;

function loadStore() {
  if (_storeCache) return _storeCache;
  // 同期ブートストラップ: localStorage から直接読む (init 前のフォールバック)
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) { _storeCache = defaultStore(); return _storeCache; }
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("invalid");
    _storeCache = Object.assign(defaultStore(), migrateStore(parsed));
    return _storeCache;
  } catch (e) {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) localStorage.setItem(LS_BAK + "_" + Date.now(), raw);
    } catch {}
    _loadCorruptionDetected = true;
    _storeCache = defaultStore();
    return _storeCache;
  }
}

function saveStore(s) {
  _storeCache = s;
  if (window.Storage) {
    // cloud + localStorage の両方を Storage が面倒見る
    window.Storage.save(s).then(r => {
      if (!r.ok && typeof showToast === "function") {
        showToast("✕ 保存失敗: " + (r.error || "unknown"), "err");
      }
    }).catch(e => {
      if (typeof showToast === "function") showToast("✕ 保存失敗: " + (e.message || e), "err");
    });
    return { ok: true };  // 楽観的UI返却
  }
  // Storage 未読込時のフォールバック
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
    return { ok: true };
  } catch (e) {
    // QuotaExceededError 等: 古いバックアップキーを掃除して再試行
    const isQuota = e?.name === "QuotaExceededError"
                 || /quota/i.test(String(e?.message || ""));
    if (isQuota) {
      try {
        // LS_BAK_<timestamp> キーを古い順に削除
        const bakKeys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(LS_BAK)) bakKeys.push(k);
        }
        bakKeys.sort();
        for (const k of bakKeys) localStorage.removeItem(k);
        // 再試行
        localStorage.setItem(LS_KEY, JSON.stringify(s));
        if (typeof showToast === "function") showToast("⚠ 容量超過のため古いバックアップを削除しました", "warn");
        return { ok: true };
      } catch (retryErr) {
        if (typeof showToast === "function") showToast("✕ 保存失敗 (容量超過・救出不能)。設定タブからエクスポートしてバックアップを取ってください", "err");
        return { ok: false, error: "quota_exceeded" };
      }
    }
    if (typeof showToast === "function") showToast("✕ 保存失敗: " + (e.message || e), "err");
    return { ok: false, error: String(e.message || e) };
  }
}

// 起動時にクラウドからロード (Supabase 設定済 + ログイン済の場合)
async function hydrateFromCloud() {
  if (!window.Storage) return;
  try {
    await window.Storage.init();
    if (window.Storage.mode === "cloud") {
      const cloud = await window.Storage.load();
      if (cloud) {
        _storeCache = cloud;
        try { localStorage.setItem(LS_KEY, JSON.stringify(cloud)); } catch {}
        if (typeof showToast === "function") showToast("☁️ クラウドから同期しました", "ok");
        try { renderSettings(); renderRecords(); renderAiTrack(); } catch {}
      }
    }
  } catch (e) { console.warn("[hydrateFromCloud] failed", e); }
}

function storageUsagePct() {
  try {
    const raw = localStorage.getItem(LS_KEY) || "";
    return Math.min(100, Math.round((raw.length / (5 * 1024 * 1024)) * 100));
  } catch { return null; }
}

// ─── 共通ユーティリティ ─────────────────────────────────────
// SWR 風のメモリキャッシュ。同 URL を短時間で再要求した場合に即返す。
// refresh ボタン押下時は bustApiCache() で全消去 → 必ず最新を取りに行く。
const _apiCache = new Map();              // url -> { ts, result }
const API_FRESH_TTL = 15_000;             // 15秒以内は即返答 (タブ切替で再要求しても瞬時)
function bustApiCache() { _apiCache.clear(); }

async function getJson(url, opts = {}) {
  const now = Date.now();
  const useCache = opts.cache !== false;
  const cached = _apiCache.get(url);
  if (useCache && cached && (now - cached.ts) < API_FRESH_TTL) {
    return cached.result;
  }
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
    const result = { ok: r.ok, status: r.status, body };
    if (r.ok && useCache) _apiCache.set(url, { ts: now, result });
    return result;
  } catch (e) {
    // ネット断時は古いキャッシュにフォールバック (体感の継続性)
    if (cached) return cached.result;
    return { ok: false, status: 0, body: { error: String(e.message || e) } };
  }
}

// ─── 重い描画の遅延化 (画面に入ったら描く・タブ切替を超軽量に保つ) ──
const _whenVisibleObs = (typeof IntersectionObserver !== "undefined")
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const fn = e.target.__renderWhenVisible;
        if (typeof fn === "function") {
          _whenVisibleObs.unobserve(e.target);
          try { fn(); } catch {}
          delete e.target.__renderWhenVisible;
        }
      }
    }, { rootMargin: "120px" })
  : null;
function renderWhenVisible(el, fn) {
  if (!el) { try { fn(); } catch {} return; }
  if (!_whenVisibleObs) { try { fn(); } catch {} return; }
  el.__renderWhenVisible = fn;
  _whenVisibleObs.observe(el);
}

// ─── アイドル時にぶら下げる (タップ即反応 → 重い処理は後回し) ───
const _idle = (window.requestIdleCallback)
  ? (cb, opts) => window.requestIdleCallback(cb, opts || { timeout: 800 })
  : (cb) => setTimeout(cb, 1);

// ─── HiDPI 対応のキャンバス準備 (Retina でクッキリ描画) ──────
// 全 chart 関数の冒頭で呼ぶ。初回に論理サイズを退避し、devicePixelRatio で
// スケールアップした内部バッファを用意。論理座標で描けばボケない。
function prepHiDPI(canvas) {
  if (!canvas) return null;
  const dpr = window.devicePixelRatio || 1;
  if (!canvas._logW) {
    canvas._logW = canvas.width  || canvas.clientWidth  || 600;
    canvas._logH = canvas.height || canvas.clientHeight || 180;
  }
  if (canvas._dpr !== dpr) {
    canvas._dpr = dpr;
    canvas.width  = Math.round(canvas._logW * dpr);
    canvas.height = Math.round(canvas._logH * dpr);
    canvas.style.width  = canvas._logW + "px";
    canvas.style.height = canvas._logH + "px";
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas._logW, canvas._logH);
  return { ctx, W: canvas._logW, H: canvas._logH, dpr };
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
let _manualMode = false;  // 手動入力モード (true の間は ↻ 更新で上書きされない)

// ─── 学習補正 (calibration) を 1 馬の EV に適用 ────────────────
function getCalibrationRatio(grade) {
  if (!window.Learner || !grade) return null;
  try {
    const calib = window.Learner.computeCalibration(loadStore().bets || []);
    const slot = calib[grade];
    if (!slot || slot.samples < 10) return null;
    return slot.ratio;
  } catch { return null; }
}

// ─── 信頼度スターレベル (1-5) を結論から導出 ──────────────────
// 「超自信あり (5)」「強め (4)」「普通 (3)」「危険ゾーン (2)」「見送り (1)」「データなし (0)」
// 補正後 EV / verdict / 信頼度 / グレード を総合判定
function computeStarLevel(c) {
  if (!c?.ok) return { level: 0, label: "データ待ち", icon: "⚪" };
  const top = c.picks?.[0];
  const calRatio = top ? getCalibrationRatio(top.grade) : null;
  const calEv = top ? (calRatio ? top.ev * calRatio : top.ev) : null;
  const conf  = c.confidence ?? 0.20;
  const grade = top?.grade;

  // 見送り系
  if (c.verdict === "pass") {
    if (c.overpopular?.length) return { level: 2, label: "危険ゾーン", icon: "⚠️" };
    return { level: 1, label: "見送り推奨", icon: "❌" };
  }
  // neutral
  if (c.verdict === "neutral") {
    return { level: 3, label: "少額ならあり", icon: "💡" };
  }
  // go
  if (c.verdict === "go") {
    if ((calEv ?? 0) >= 1.30 && grade === "S" && conf >= 0.30) {
      return { level: 5, label: "超自信あり", icon: "🔥" };
    }
    if ((calEv ?? 0) >= 1.15 && conf >= 0.25) {
      return { level: 4, label: "強めの買い", icon: "🎯" };
    }
    return { level: 3, label: "狙える", icon: "🟢" };
  }
  return { level: 0, label: "判定中", icon: "⚪" };
}

// ─── 数字のカウントアップ (Apple っぽい ease-out 3 次) ─────────
function animateNumber(el, from, to, opts = {}) {
  if (!el) return;
  if (!Number.isFinite(from)) from = 0;
  if (!Number.isFinite(to))   { el.textContent = "--"; return; }
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fmt = opts.format || (v => v.toFixed(0));
  if (reduce) { el.textContent = fmt(to); return; }
  const dur = opts.duration || 600;
  const start = performance.now();
  const ease = t => 1 - Math.pow(1 - t, 3);
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const v = from + (to - from) * ease(p);
    el.textContent = fmt(v);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ─── 結論カード ────────────────────────────────────────────
let _lastBvEv = 0;     // count-up の起点 (前回のEV%)
function renderBigVerdict(c) {
  const el = $("#big-verdict");
  el.className = "big-verdict v-" + (c?.verdict || "loading");

  const stars = computeStarLevel(c);
  $("#bv-icon").textContent  = stars.icon;
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

  // ★ 星評価メーター (世界一の「一瞬で理解」UI)
  const sw = $("#bv-stars-wrap");
  const sLabel = $("#bv-stars-label");
  const sEv    = $("#bv-stars-ev");
  if (sw && stars.level >= 1) {
    sw.hidden = false;
    sw.className = "bv-stars-wrap lv-" + stars.level;
    sLabel.textContent = stars.label;
    // 各星に lit クラスを付与 → CSS が stagger で順番に発火
    const all = sw.querySelectorAll(".bv-star");
    all.forEach((s, i) => {
      // 再描画でアニメをリスタート
      s.classList.remove("lit");
      // reflow を強制してアニメ再生
      void s.offsetWidth;
      if (i < stars.level) s.classList.add("lit");
    });
    // 補正後 EV をカウントアップで表示
    const top = c?.picks?.[0];
    const calRatio = top ? getCalibrationRatio(top.grade) : null;
    const calEv = top ? (calRatio ? top.ev * calRatio : top.ev) : null;
    if (Number.isFinite(calEv)) {
      const toPct = (calEv - 1) * 100;
      animateNumber(sEv, _lastBvEv, toPct, {
        duration: 720,
        format: v => (v >= 0 ? "+" : "") + v.toFixed(0) + "%",
      });
      _lastBvEv = toPct;
    } else {
      sEv.textContent = stars.label === "見送り推奨" || stars.label === "危険ゾーン" ? "推奨なし" : "--";
      _lastBvEv = 0;
    }
  } else if (sw) {
    sw.hidden = true;
    _lastBvEv = 0;
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

  // 理由は最大3行(短く) + 学習補正の適用
  const reasonLines = [];
  const popularity = top.popularity ?? 99;
  const calRatio = getCalibrationRatio(top.grade);
  const calibratedEv = calRatio ? top.ev * calRatio : top.ev;
  if (popularity >= 6 && calibratedEv >= 1.10) reasonLines.push("人気のわりに妙味あり");
  else if (top.grade === "S")                  reasonLines.push("オッズと予想のバランスが良い");
  else if (top.grade === "A")                  reasonLines.push("オッズ的にちょっとおいしい");
  else if (c.verdict === "neutral")            reasonLines.push("信頼度は低めなので少額で");
  else                                         reasonLines.push("候補までは届くが推奨度は低め");
  if (calRatio) {
    reasonLines.push(`実績補正後 ${fmtEvPct(calibratedEv)}・予想 ${fmtEvPct(top.ev)} × ×${calRatio.toFixed(2)}・${fmtOdds(top.odds)}倍`);
  } else {
    reasonLines.push(`期待値 ${fmtEvPct(top.ev)}・${fmtOdds(top.odds)}倍・${popularity !== 99 ? popularity + "番人気" : "人気未取得"}`);
  }
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

  // Kelly基準の推奨金額 (補正後 prob を使う)
  renderStakeSuggestion(c, top, calRatio);

  // 仮データ時は記録ボタン無効化(「仮データで買い推奨しない」「未取得を取得済みのように扱わない」原則)
  const isDummy = !!(c?.raceMeta?.isDummy)
    || (typeof c?.raceMeta?.source === "string" && /DUMMY|TEST|テスト|ダミー|SYNTHETIC/i.test(c.raceMeta.source));
  $("#btn-record-air").disabled  = isDummy;
  $("#btn-record-real").disabled = isDummy;
  $("#pick-record-note").hidden  = !isDummy;
}

// Kelly基準の推奨金額を pick_card 内に描画
function renderStakeSuggestion(c, top, calRatio) {
  const wrap = $("#pick-stake");
  const amtEl = $("#pick-stake-amount");
  const reasonEl = $("#pick-stake-reason");
  if (!wrap || !amtEl || !reasonEl) return;
  if (!window.Kelly || !top || !c?.ok) { wrap.hidden = true; return; }
  const store = loadStore();
  const bankroll  = store.funds?.daily   || null;
  const perRace   = store.funds?.perRace || null;
  // 補正後 prob を使う (calRatio がある場合は EV と同じ調整を prob にも適用すると過剰補正)
  // ここでは prob はそのまま、odds × prob × ratio = 補正後EV と整合する形で勝率を縮める
  const prob = (calRatio && top.prob) ? top.prob * Math.min(1, calRatio) : top.prob;
  const out = window.Kelly.suggestStake({
    prob, odds: top.odds, bankroll, perRaceCap: perRace, confidence: c.confidence,
  });
  wrap.hidden = false;
  if (out.stake > 0) {
    amtEl.textContent = `¥${out.stake.toLocaleString("ja-JP")}`;
    amtEl.className = "ps-amount ps-amount-positive";
    reasonEl.textContent = `${out.reason} (期待値 ${fmtEvPct(out.ev)})`;
  } else {
    amtEl.textContent = "¥0";
    amtEl.className = "ps-amount ps-amount-zero";
    reasonEl.textContent = out.reason || "推奨できません";
  }
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

// ─── AI 育成レベル (★1-5) ────────────────────────────────────
// dummy 起源を除外した「全期間」の馬券から計算 (累積育成)
function renderAiLevel() {
  if (!window.Learner) return;
  const store = loadStore();
  const stats = window.Learner.computeStats(store.bets || []);
  const stars = "★".repeat(stats.level) + "☆".repeat(5 - stats.level);
  const elStars = $("#ai-level-stars"); if (elStars) elStars.textContent = stars;
  const elName  = $("#ai-level-name");  if (elName)  elName.textContent  = stats.levelName;
  const elSub   = $("#ai-level-sub");   if (elSub)   elSub.textContent   = stats.levelSub;
  const elBar   = $("#ai-level-bar");   if (elBar)   elBar.style.width   = (stats.progress?.pct || 0) + "%";
  const elHint  = $("#ai-level-hint");  if (elHint)  elHint.textContent  = stats.progress?.hint || "";

  // ログイン中なら learner_state にも同期 (失敗してもUIには出さない)
  try {
    const sb = window.Storage?.getSupabase?.();
    if (sb && window.Storage.user && window.Learner.cloudSync) {
      window.Learner.cloudSync(sb, window.Storage.user.id, store.bets || []);
    }
  } catch (e) { /* silent */ }

  // グレード別の自己校正 (calibration) を可視化
  renderAiCalibration();
  // 自然言語インサイト
  renderAiInsight();
}

function renderAiCalibration() {
  if (!window.Learner) return;
  const wrap = document.getElementById("ai-calib");
  const grid = document.getElementById("ai-calib-grid");
  if (!wrap || !grid) return;
  const store = loadStore();
  const calib = window.Learner.computeCalibration(store.bets || []);
  const hasAny = Object.values(calib).some(c => c.samples > 0);
  wrap.hidden = !hasAny;
  if (!hasAny) return;
  grid.innerHTML = "";
  for (const g of ["S", "A", "B", "C", "D"]) {
    const c = calib[g];
    const ratio = Number.isFinite(c.ratio) ? c.ratio : 1.0;
    const pct = Math.round(ratio * 100);
    let cls = "cal-pending";
    if (c.samples >= 10) {
      if (ratio >= 1.10) cls = "cal-up";
      else if (ratio >= 0.90) cls = "";
      else if (ratio >= 0.70) cls = "cal-down";
      else cls = "cal-bad";
    }
    const cell = document.createElement("div");
    cell.className = "ai-calib-cell " + cls;
    cell.innerHTML = `
      <div class="ai-calib-grade">${g}</div>
      <div class="ai-calib-ratio">×${(ratio).toFixed(2)}</div>
      <div class="ai-calib-n">n=${c.samples}</div>
    `;
    grid.appendChild(cell);
  }
}

// ─── AI実績スナップショット（ホーム画面・1週間・dummy除外） ────────────
function renderAiTrack() {
  renderAiLevel();
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
  const prep = prepHiDPI(canvas); if (!prep) return;
  const { ctx, W, H } = prep;
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
  } else if (_manualMode) {
    banner.className = "conn-banner conn-manual";
    title.textContent = "📝 手動入力モード (無料)";
    sub.textContent = "あなたが入力したオッズで判定中。記録するとAIが学習します。";
  } else if (c.onlyDummyData) {
    banner.className = "conn-banner conn-dummy";
    title.textContent = "⚠️ 仮データのみ";
    sub.textContent = "上の「📝 手動でEVチェック」を使うと無料で本格判定できます";
  } else {
    // noData も含む既定: 「無料で使える」フレーミング
    banner.className = "conn-banner conn-free";
    title.textContent = "🟢 無料モード";
    sub.textContent = "上の「📝 手動でEVチェック」で今すぐ判定できます (JV-Link 不要)";
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
  // 手動入力モード中は JV-Link 取得で上書きしない
  if (_manualMode) return;
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

// ─── 保存済みレースの管理 (今日の横断ランキング) ──────────────
const SR_KEY = "keiba_saved_races_v1";

function loadSavedRaces() {
  try {
    const raw = localStorage.getItem(SR_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    // 今日(0時以降) のものだけに限定
    const start = new Date(); start.setHours(0,0,0,0);
    return Array.isArray(arr) ? arr.filter(r => new Date(r.savedAt).getTime() >= start.getTime()) : [];
  } catch { return []; }
}

function saveSavedRaces(arr) {
  try { localStorage.setItem(SR_KEY, JSON.stringify(arr)); } catch {}
}

function pushSavedRace(entry) {
  const arr = loadSavedRaces();
  // 同じ raceName + 同じ入力テキスト ならID差し替えで上書き
  const dup = arr.findIndex(r => r.raceName === entry.raceName && r.inputText === entry.inputText);
  if (dup >= 0) arr[dup] = entry;
  else arr.unshift(entry);
  // 上限 30 件
  if (arr.length > 30) arr.length = 30;
  saveSavedRaces(arr);
}

// 補正後 EV を計算 (calibration を適用したトップ pick の EV)
function calibratedTopEv(c) {
  const top = c?.picks?.[0];
  if (!top) return null;
  const r = getCalibrationRatio(top.grade);
  return r ? Number(top.ev) * r : Number(top.ev);
}

// ─── ミニ星バー (保存レースの行に表示) ─────────────────────
function miniStarsHtml(level) {
  const lit = Math.max(0, Math.min(5, level | 0));
  let html = `<span class="sr-mini-stars lv-${lit}" aria-label="信頼度${lit}/5">`;
  for (let i = 0; i < 5; i++) {
    html += i < lit
      ? `<span class="sr-mini-star-lit">★</span>`
      : `<span class="sr-mini-star-off">☆</span>`;
  }
  html += `</span>`;
  return html;
}

// 推奨金額を計算 (Kelly + 補正済 prob)
function suggestedStakeForRow(c) {
  if (!window.Kelly || !c?.ok || !c.picks?.length) return null;
  const top = c.picks[0];
  const store = loadStore();
  const calRatio = getCalibrationRatio(top.grade);
  const prob = (calRatio && top.prob) ? top.prob * Math.min(1, calRatio) : top.prob;
  try {
    const k = window.Kelly.suggestStake({
      prob, odds: top.odds,
      bankroll: store.funds?.daily || null,
      perRaceCap: store.funds?.perRace || null,
      confidence: c.confidence,
    });
    return k.stake;
  } catch { return null; }
}

function renderSavedRacesList() {
  const card = $("#card-saved-races");
  const list = $("#saved-races-list");
  const cnt  = $("#saved-races-count");
  if (!card || !list) return;
  const arr = loadSavedRaces();
  if (!arr.length) { card.hidden = true; return; }
  card.hidden = false;
  // 補正後 top EV の高い順にソート
  const ranked = arr.map(r => ({ ...r, calEv: calibratedTopEv(r.conclusion) }))
                    .sort((a, b) => (b.calEv ?? -Infinity) - (a.calEv ?? -Infinity));
  if (cnt) cnt.textContent = `${ranked.length}件`;
  list.innerHTML = "";
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const top = r.conclusion?.picks?.[0];
    const calEv = r.calEv;
    const stars = computeStarLevel(r.conclusion);
    const grade = top?.grade || "--";
    const verdict = r.conclusion?.verdict || "loading";
    const verdictText = r.conclusion?.verdictTitle || verdictToHuman(verdict);
    const evPctText = (calEv != null && Number.isFinite(calEv))
      ? `${(calEv-1)*100 >= 0 ? "+" : ""}${((calEv-1)*100).toFixed(0)}%` : "--";

    const li = document.createElement("li");
    li.className = "sr-row fade-up d-" + Math.min(5, i + 1) + (i === 0 ? " sr-best" : "");
    li.dataset.id = r.id;

    if (i === 0 && top) {
      // 🏆 ベスト1: ヒーローカード (馬番+馬名+推奨金額を一目で)
      const stake = suggestedStakeForRow(r.conclusion);
      const stakeText = (stake != null && stake > 0)
        ? `¥${stake.toLocaleString("ja-JP")}`
        : "見送り";
      const stakeClass = (stake != null && stake > 0) ? "sr-best-stake" : "sr-best-stake zero";
      li.innerHTML = `
        <span class="sr-badge">🏆 今日のベスト1</span>
        <div class="sr-best-head">
          ${miniStarsHtml(stars.level)}
          <div class="sr-name" style="flex:1; min-width:0;">${escapeHtml(r.raceName || "(レース名なし)")}</div>
          <span class="sr-pill v-${verdict}">${escapeHtml(stars.label)}</span>
        </div>
        <div class="sr-best-pick">
          <div class="sr-best-num">${escapeHtml(String(top.number ?? "--"))}</div>
          <div class="sr-best-info">
            <div class="sr-best-horse">${escapeHtml(top.name || "(馬名未取得)")}</div>
            <div class="sr-best-meta">補正後EV <b>${evPctText}</b> · ${fmtOdds(top.odds)}倍 · ${top.popularity != null ? top.popularity + "番人気" : "人気--"} · <span class="sr-grade sr-grade-${grade}">${grade}</span></div>
          </div>
          <div class="${stakeClass}">${stakeText}</div>
        </div>
        <div class="sr-best-actions">
          <button class="sr-load" data-id="${r.id}" type="button">▶ このレースを表示</button>
          <button class="sr-del"  data-id="${r.id}" type="button" aria-label="削除">🗑</button>
        </div>
      `;
    } else {
      // 通常行: コンパクトに 星 + レース名 + EV + verdict pill
      li.innerHTML = `
        ${miniStarsHtml(stars.level)}
        <div class="sr-main">
          <div class="sr-name">${escapeHtml(r.raceName || "(レース名なし)")}</div>
          <div class="sr-meta">
            <span class="sr-grade sr-grade-${grade}">${grade}</span>
            <span class="sr-ev">EV ${evPctText}</span>
            ${top ? `<span class="sr-verdict">${escapeHtml(top.number)}番 ${escapeHtml((top.name||"").slice(0,8))}</span>` : ""}
          </div>
        </div>
        <span class="sr-pill v-${verdict}">${escapeHtml(stars.label)}</span>
        <div class="sr-actions">
          <button class="sr-del" data-id="${r.id}" type="button" aria-label="削除">×</button>
        </div>
      `;
    }
    list.appendChild(li);
  }

  // クリックハンドラ (× は削除・行全体は読み込み)
  list.querySelectorAll(".sr-load").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      loadSavedRace(btn.dataset.id);
    });
  });
  list.querySelectorAll(".sr-del").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(8);
      const arr = loadSavedRaces().filter(r => r.id !== id);
      saveSavedRaces(arr);
      renderSavedRacesList();
      showToast("削除しました", "ok");
    });
  });
  list.querySelectorAll(".sr-row").forEach(row => {
    row.addEventListener("click", () => loadSavedRace(row.dataset.id));
  });
}

function loadSavedRace(id) {
  const arr = loadSavedRaces();
  const r = arr.find(x => x.id === id);
  if (!r) return;
  _manualMode = true;
  _currentConclusion = r.conclusion;
  _currentRaceMeta = r.conclusion?.raceMeta || null;
  // 入力欄も復元
  const ta = $("#mi-textarea"); if (ta && r.inputText) ta.value = r.inputText;
  const nameEl = $("#mi-race-name"); if (nameEl) nameEl.value = r.raceName || "";
  renderBigVerdict(r.conclusion);
  renderPickCard(r.conclusion);
  renderDangerCard(r.conclusion);
  renderUnderCard(r.conclusion);
  renderAdvice(r.conclusion);
  renderProDetails(r.conclusion);
  refreshConnection();
  showToast(`📥 「${r.raceName || "保存済"}」を表示`, "ok");
  // 結論カードまでスクロール
  const bv = $("#big-verdict");
  if (bv && bv.scrollIntoView) bv.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ─── 手動入力モード ────────────────────────────────────────
async function submitManual() {
  const ta = $("#mi-textarea");
  const text = (ta?.value || "").trim();
  const raceName = ($("#mi-race-name")?.value || "").trim();
  if (!text) {
    showToast("⚠ 入力欄が空です。馬の情報を1行ずつ入れてください", "warn");
    return;
  }
  const btn = $("#mi-submit");
  if (btn) { btn.disabled = true; btn.classList.add("loading"); }
  // 楽観 UI: 即座に「判定中」状態へ → API待ちのストレスを消す
  try {
    const bv = $("#big-verdict");
    if (bv) bv.className = "big-verdict v-loading";
    const t = $("#bv-title");    if (t) t.textContent = "判定中…";
    const r = $("#bv-reason");   if (r) r.textContent = "あなたの入力で AI が期待値を計算しています。";
    const icon = $("#bv-icon");  if (icon) icon.textContent = "⏳";
    const gEl = $("#bv-grade");  if (gEl) gEl.hidden = true;
    const sw  = $("#bv-stars-wrap"); if (sw) sw.hidden = true;
    if (bv && bv.scrollIntoView) bv.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch {}
  if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(10);
  try {
    const res = await fetch("/api/conclusion-manual", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, raceName: raceName || null }),
    });
    let c;
    try {
      c = await res.json();
    } catch (parseErr) {
      throw new Error(`サーバーから不正な応答 (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new Error(c?.error || c?.message || `サーバーエラー (HTTP ${res.status})`);
    }
    _manualMode = true;
    _currentConclusion = c;
    _currentRaceMeta = c?.raceMeta || null;
    renderBigVerdict(c);
    renderPickCard(c);
    renderDangerCard(c);
    renderUnderCard(c);
    renderAdvice(c);
    renderProDetails(c);
    refreshConnection();
    // 保存して横断ランキングへ反映 (期待値が出ているレースのみ)
    if (c?.ok && c.picks?.length) {
      pushSavedRace({
        id: "sr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
        raceName: raceName || `手動入力 ${new Date().toLocaleString("ja-JP")}`,
        savedAt: new Date().toISOString(),
        inputText: text,
        conclusion: c,
      });
      renderSavedRacesList();
      showToast(`📈 判定完了: ${c.verdictTitle || ''} — レースを保存しました`, "ok");
    } else {
      showToast(`⚠ ${c?.verdictReason || c?.reason || '判定できませんでした'}`, "warn");
    }
  } catch (e) {
    showToast("通信エラー: " + (e?.message || e), "err");
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove("loading"); }
  }
}

function clearManualMode() {
  _manualMode = false;
  refreshConnection();
}

// ─── AI が学んだこと (insight) ──────────────────────────────
function renderAiInsight() {
  if (!window.Learner) return;
  const wrap = $("#ai-insight");
  const ul   = $("#ai-insight-list");
  if (!wrap || !ul) return;
  const calib = window.Learner.computeCalibration(loadStore().bets || []);
  const insights = [];
  for (const g of ["S", "A", "B", "C", "D"]) {
    const c = calib[g];
    if (!c || c.samples < 10) continue;
    const dev = (1 - c.ratio) * 100;
    const label = ({ S: "S級(強い買い)", A: "A級(買い)", B: "B級(微プラス)", C: "C級(微マイナス)", D: "D級(マイナス)" })[g] || g;
    if (Math.abs(dev) < 5) {
      insights.push(`${label}: 予想と実績がほぼ一致 ✓ (n=${c.samples})`);
    } else if (dev > 0) {
      insights.push(`${label}: 予想より ${dev.toFixed(0)}% 甘め — 自動で ${(c.ratio).toFixed(2)} 倍に補正中 (n=${c.samples})`);
    } else {
      insights.push(`${label}: 予想より ${(-dev).toFixed(0)}% 辛め — 自動で ${(c.ratio).toFixed(2)} 倍に補正中 (n=${c.samples})`);
    }
  }
  if (!insights.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  ul.innerHTML = "";
  for (const t of insights) {
    const li = document.createElement("li");
    li.className = "ai-insight-item";
    li.textContent = t;
    ul.appendChild(li);
  }
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
  bustApiCache();   // ↻ ボタンは常に最新を取りに行く (SWR キャッシュ無効化)
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

// ─── タブ切替 (即時 + 重い処理はアイドル時に) ───────────────────
function switchTab(name) {
  // 1) 即時に表示切替 (重い描画は後回しにして体感 0ms)
  for (const pane of $$(".tab-pane")) pane.hidden = (pane.id !== `tab-${name}`);
  for (const b of $$(".bt-btn")) b.classList.toggle("active", b.dataset.tab === name);
  // 触覚フィードバック (対応端末のみ)
  if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(6);
  window.scrollTo(0, 0);
  // 2) 重い再描画はアイドルで (ボタン押下 → 切替が即反応するように)
  if (name === "record") {
    _idle(() => { try { renderRecords(); } catch {} });
    _idle(() => { autoFinalizePending().catch(() => {}); });
  }
  if (name === "settings") {
    _idle(() => { try { renderSettings(); } catch {} });
  }
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
  // 推奨初期値: Kelly 基準 → perRace 上限 → 100円
  let suggested = store.funds.perRace || 100;
  if (window.Kelly && pick) {
    try {
      const calRatio = getCalibrationRatio(pick.grade);
      const prob = (calRatio && pick.prob) ? pick.prob * Math.min(1, calRatio) : pick.prob;
      const k = window.Kelly.suggestStake({
        prob, odds: pick.odds, bankroll: store.funds.daily, perRaceCap: store.funds.perRace, confidence: _currentConclusion.confidence,
      });
      if (k.stake > 0) suggested = k.stake;
    } catch {}
  }
  // prompt: null=キャンセル / "" =空入力。どちらも処理を中断する。
  const promptRes = prompt("購入金額(円)を入力してください\n(Kelly基準の推奨額をプリセット)", String(suggested));
  if (promptRes === null) return;                          // キャンセル
  const trimmed = String(promptRes).trim();
  if (!trimmed) return;                                    // 空入力
  // 全角数字・カンマ・円記号を正規化
  const normalized = trimmed
    .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[,，円￥¥]/g, "")
    .trim();
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) {
    showToast("⚠ 金額は1円以上の数値で入力してください", "warn");
    return;
  }
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
    jockey:  pick.jockey  || null,
    trainer: pick.trainer || null,
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
  const prep = prepHiDPI(canvas);
  if (!prep) return;
  const { ctx, W, H } = prep;

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
    li.dataset.betId = b.id;

    let status;
    let actions = "";
    if (b.result?.won === true) {
      status = `<span class="rec-st rec-win">的中 +${fmtYen(b.result.payout - b.amount)}</span>`;
      actions = `<button class="rec-act rec-act-undo" data-act="undo" data-id="${escapeHtml(b.id)}">取り消す</button>`;
    } else if (b.result?.won === false) {
      status = `<span class="rec-st rec-lose">外れ -${fmtYen(b.amount)}</span>`;
      actions = `<button class="rec-act rec-act-undo" data-act="undo" data-id="${escapeHtml(b.id)}">取り消す</button>`;
    } else {
      status = `<span class="rec-st rec-pend">結果待ち</span>`;
      const expected = (b.odds && b.amount) ? Math.round(b.odds * b.amount) : 0;
      actions = `
        <button class="rec-act rec-act-win"  data-act="win"  data-id="${escapeHtml(b.id)}" data-default="${expected}">○ 当たり</button>
        <button class="rec-act rec-act-lose" data-act="lose" data-id="${escapeHtml(b.id)}">× 外れ</button>
      `;
    }

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
      <div class="rec-actions-row">${actions}</div>
    `;
    ul.appendChild(li);
  }

  // 1度だけ delegated handler を仕込む
  if (!ul.dataset.actsBound) {
    ul.addEventListener("click", onBetActionClick);
    ul.dataset.actsBound = "1";
  }
}

function onBetActionClick(ev) {
  const btn = ev.target.closest("button.rec-act");
  if (!btn) return;
  const act = btn.dataset.act;
  const id  = btn.dataset.id;
  if (!id) return;
  const store = loadStore();
  const bet = (store.bets || []).find(x => x.id === id);
  if (!bet) { showToast("記録が見つかりません", "warn"); return; }

  if (act === "win") {
    const def = btn.dataset.default || "0";
    const v = prompt(`払戻金を入れてください (円・予想 ${def}円)`, def);
    if (v === null) return;
    const payout = Number(String(v).replace(/[,円￥\s]/g, ""));
    if (!Number.isFinite(payout) || payout < 0) { showToast("払戻金が不正です", "warn"); return; }
    bet.result = { won: true,  payout: Math.round(payout), finishedAt: new Date().toISOString() };
    bet.profit = (bet.result.payout || 0) - (bet.amount || 0);
    showToast("✓ 当たりとして確定しました");
  } else if (act === "lose") {
    if (!confirm("この馬券を「外れ」として確定します。よろしいですか?")) return;
    bet.result = { won: false, payout: 0, finishedAt: new Date().toISOString() };
    bet.profit = -(bet.amount || 0);
    showToast("外れとして確定しました");
  } else if (act === "undo") {
    if (!confirm("確定を取り消して「結果待ち」に戻します。よろしいですか?")) return;
    bet.result = null;
    bet.profit = null;
    showToast("結果を取り消しました");
  }
  saveStore(store);
  try { renderRecords(); renderAiTrack(); } catch {}
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
  drawMonthlyChart($("#chart-monthly"), air, real);
  drawRollingHitChart($("#chart-rolling"), air, real);
  renderGradeCompare(air, real);
  renderBacktest(allBets);
  renderKellySim(allBets);
  renderAffinity(allBets);
}

// ─── Kelly基準シミュレーション (実際 vs Kelly vs 等額) ──────────
function renderKellySim(allBets) {
  const canvas = $("#chart-kelly-sim");
  const summary = $("#kelly-sim-summary");
  if (!canvas || !summary) return;
  const store = loadStore();
  const bankroll = store.funds?.daily   || null;
  const perRace  = store.funds?.perRace || null;
  if (!window.Kelly || !bankroll) {
    const prep = prepHiDPI(canvas);
    if (prep) {
      const { ctx, W, H } = prep;
      ctx.fillStyle = "#64748b"; ctx.font = "13px Inter, sans-serif";
      ctx.fillText("1日予算が未設定です。設定タブで予算を入れると比較できます。", 16, H / 2);
    }
    summary.textContent = "1日予算が未設定";
    summary.className = "kelly-sim-summary";
    return;
  }
  const sim = simulateKelly(allBets, bankroll, perRace);
  drawKellySimChart(canvas, sim);
  if (sim.samples < 1) {
    summary.textContent = "確定済の記録がありません";
    summary.className = "kelly-sim-summary";
    return;
  }
  const fmtY = (v) => (v >= 0 ? "+" : "") + Math.round(v).toLocaleString("ja-JP") + "円";
  let verdict = "";
  if (sim.kellyFinal > sim.actualFinal && sim.kellyFinal > sim.flatFinal) {
    const diff = sim.kellyFinal - sim.actualFinal;
    verdict = `🟢 Kelly基準だと ${fmtY(diff)} 多く勝てた可能性 (賭け金配分の最適化余地あり)`;
  } else if (sim.actualFinal > sim.kellyFinal && sim.actualFinal > sim.flatFinal) {
    verdict = `✓ あなたの実際の賭け方が Kelly より良い結果。良い感覚を持っています`;
  } else if (sim.flatFinal > sim.kellyFinal && sim.flatFinal > sim.actualFinal) {
    verdict = `🟡 等額が最強 — まだサンプル不足、推定勝率の精度が足りていない可能性`;
  } else {
    verdict = "差が小さい — もう少し記録を増やしましょう";
  }
  summary.innerHTML = `
    <div class="ks-row"><span class="ks-key">実際:</span><span class="ks-val">${fmtY(sim.actualFinal)}</span></div>
    <div class="ks-row"><span class="ks-key">Kelly:</span><span class="ks-val">${fmtY(sim.kellyFinal)} <span class="ks-meta">(${sim.kellyIncluded}件採用 / ${sim.kellySkipped}件見送り)</span></span></div>
    <div class="ks-row"><span class="ks-key">等額:</span><span class="ks-val">${fmtY(sim.flatFinal)}</span></div>
    <div class="ks-verdict">${verdict}</div>
  `;
  summary.className = "kelly-sim-summary";
}

function simulateKelly(allBets, bankroll, perRaceCap) {
  const confirmed = (allBets || [])
    .filter(b => b && b.dataSource !== "dummy")
    .filter(b => b.result?.won === true || b.result?.won === false)
    .sort((a, b) => (a.result?.finishedAt || a.ts).localeCompare(b.result?.finishedAt || b.ts));

  const flatStake = perRaceCap || Math.max(100, Math.floor(bankroll / 10));
  const actual = [], kelly = [], flat = [];
  let aCum = 0, kCum = 0, fCum = 0;
  let kIncluded = 0, kSkipped = 0;

  for (const b of confirmed) {
    const won = !!b.result.won;
    const payout = won ? (b.result.payout || 0) : 0;
    const aProfit = payout - (b.amount || 0);
    aCum += aProfit;
    actual.push(aCum);

    // Kelly stake
    let kProfit = 0;
    if (window.Kelly && b.prob != null && b.odds != null) {
      const out = window.Kelly.suggestStake({
        prob: Number(b.prob), odds: Number(b.odds),
        bankroll, perRaceCap, confidence: 0.30,
      });
      const stake = out.stake;
      if (stake > 0) {
        kProfit = won ? (Math.round(stake * Number(b.odds)) - stake) : -stake;
        kIncluded++;
      } else {
        kSkipped++;
      }
    }
    kCum += kProfit;
    kelly.push(kCum);

    // 等額 stake
    const fProfit = won ? (Math.round(flatStake * Number(b.odds || 0)) - flatStake) : -flatStake;
    fCum += fProfit;
    flat.push(fCum);
  }

  return {
    actual, kelly, flat,
    actualFinal: aCum, kellyFinal: kCum, flatFinal: fCum,
    samples: confirmed.length,
    kellyIncluded: kIncluded, kellySkipped: kSkipped,
    flatStake,
  };
}

function drawKellySimChart(canvas, sim) {
  const prep = prepHiDPI(canvas); if (!prep) return;
  const { ctx, W, H } = prep;
  if (!sim.samples) {
    ctx.fillStyle = "#64748b"; ctx.font = "14px Inter, sans-serif";
    ctx.fillText("確定済みの記録がありません", 16, H / 2);
    return;
  }
  const all = [0, ...sim.actual, ...sim.kelly, ...sim.flat];
  const minV = Math.min(...all);
  const maxV = Math.max(...all);
  const padX = 30, padT = 20, padB = 26;
  const plotW = W - padX * 2, plotH = H - padT - padB;
  const N = sim.samples;
  const xAt = i => padX + (N === 1 ? plotW / 2 : (plotW * i) / (N - 1));
  const yAt = v => padT + plotH - ((v - minV) / Math.max(1, maxV - minV)) * plotH;

  // 0グリッド
  ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padX, yAt(0)); ctx.lineTo(W - padX, yAt(0)); ctx.stroke();

  const drawLine = (series, color, lw) => {
    ctx.strokeStyle = color; ctx.lineWidth = lw;
    ctx.beginPath();
    series.forEach((v, i) => { const x = xAt(i), y = yAt(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();
  };
  drawLine(sim.flat,   "#94a3b8", 1.5);  // 等額: 灰
  drawLine(sim.actual, "#fb923c", 2);    // 実際: オレンジ
  drawLine(sim.kelly,  "#34d399", 2.5);  // Kelly: 緑

  // 凡例
  ctx.font = "11px Inter, sans-serif";
  ctx.fillStyle = "#34d399"; ctx.fillRect(padX, 6, 12, 4);
  ctx.fillStyle = "#cbd5e1"; ctx.fillText("Kelly", padX + 16, 12);
  ctx.fillStyle = "#fb923c"; ctx.fillRect(padX + 70, 6, 12, 4);
  ctx.fillStyle = "#cbd5e1"; ctx.fillText("実際", padX + 86, 12);
  ctx.fillStyle = "#94a3b8"; ctx.fillRect(padX + 130, 6, 12, 4);
  ctx.fillStyle = "#cbd5e1"; ctx.fillText("等額", padX + 146, 12);
}

// ─── 騎手・調教師の相性 ───────────────────────────────────
let _affinityKey = "jockey";  // "jockey" | "trainer"
function renderAffinity(allBets) {
  const wrap = $("#affinity-list");
  if (!wrap) return;
  // タブ切替
  for (const t of $$(".aff-tab")) {
    if (!t.dataset.bound) {
      t.addEventListener("click", () => {
        _affinityKey = t.dataset.aff;
        for (const o of $$(".aff-tab")) o.classList.toggle("active", o === t);
        const store = loadStore();
        renderAffinity(filterDummy(store.bets || []));
      });
      t.dataset.bound = "1";
    }
    t.classList.toggle("active", t.dataset.aff === _affinityKey);
  }
  const stats = computeAffinityStats(allBets, _affinityKey);
  wrap.innerHTML = "";
  if (!stats.length) {
    wrap.innerHTML = `<div class="pro-empty">まだデータがありません。手動入力で末尾に騎手名・調教師名を入れて記録してください</div>`;
    return;
  }
  for (const s of stats) {
    const recoveryPct = s.recovery != null ? Math.round(s.recovery * 100) : null;
    const hitPct = s.hitRate != null ? Math.round(s.hitRate * 100) : null;
    const cls = recoveryPct == null ? "" : (recoveryPct >= 100 ? "aff-good" : recoveryPct >= 80 ? "aff-mid" : "aff-bad");
    const el = document.createElement("div");
    el.className = "aff-row " + cls;
    el.innerHTML = `
      <div class="aff-name">${escapeHtml(s.key)}</div>
      <div class="aff-meta">
        <span class="aff-cnt">${s.samples}件</span>
        <span class="aff-hit">的中 ${hitPct != null ? hitPct + "%" : "--"}</span>
        <span class="aff-rec">回収 ${recoveryPct != null ? recoveryPct + "%" : "--"}</span>
      </div>
      <div class="aff-pnl">${s.pnl >= 0 ? "+" : ""}${Math.round(s.pnl).toLocaleString("ja-JP")}円</div>
    `;
    wrap.appendChild(el);
  }
}

function computeAffinityStats(allBets, key) {
  const groups = new Map();
  const keyName = key === "trainer" ? "trainer" : "jockey";
  for (const b of (allBets || [])) {
    if (!b || b.dataSource === "dummy") continue;
    const k = b[keyName];
    if (!k || typeof k !== "string") continue;
    if (b.result?.won === undefined || b.result?.won === null) continue;
    let g = groups.get(k);
    if (!g) { g = { key: k, samples: 0, hits: 0, spent: 0, ret: 0 }; groups.set(k, g); }
    g.samples += 1;
    g.hits    += b.result.won ? 1 : 0;
    g.spent   += b.amount || 0;
    g.ret     += b.result.won ? (b.result.payout || 0) : 0;
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.samples < 3) continue;
    out.push({
      key: g.key,
      samples: g.samples, hits: g.hits,
      hitRate: g.samples ? g.hits / g.samples : null,
      recovery: g.spent ? g.ret / g.spent : null,
      pnl: g.ret - g.spent,
    });
  }
  return out.sort((a, b) => (b.recovery ?? -Infinity) - (a.recovery ?? -Infinity));
}

// 🧠 バックテスト: 補正前 vs 補正後
//   - 時系列カーブ: Learner.backtest (look-ahead 排除な rolling 校正)
//   - 静的サマリ: Backtest.run (今のAIで全件再評価)
function renderBacktest(allBets) {
  drawBacktestChart($("#chart-backtest"), allBets);
  renderBacktestSummary($("#backtest-summary"), allBets);
}

function drawBacktestChart(canvas, allBets) {
  if (!canvas || !window.Learner?.backtest) return;
  const result = window.Learner.backtest(allBets || []);
  const prep = prepHiDPI(canvas); if (!prep) return;
  const { ctx, W, H } = prep;
  if (!result.raw.length) {
    ctx.fillStyle = "#64748b";
    ctx.font = "12px Inter, sans-serif";
    ctx.fillText("確定済記録なし(記録を入れて結果を確定すると進化曲線が出ます)", 12, H / 2);
    return;
  }
  const allCum = [...result.raw.map(p => p.cum), ...result.calibrated.map(p => p.cum)];
  const minV = Math.min(0, ...allCum);
  const maxV = Math.max(0, ...allCum);
  const padX = 40, padY = 20;
  const plotW = W - padX * 2, plotH = H - padY * 2;
  const n = result.raw.length;
  const xAt = i => padX + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const yAt = v => padY + plotH - ((v - minV) / Math.max(1, maxV - minV)) * plotH;
  // ゼロ線
  ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padX, yAt(0)); ctx.lineTo(W - padX, yAt(0)); ctx.stroke();
  // 補正前 (灰)
  ctx.strokeStyle = "#94a3b8"; ctx.lineWidth = 2;
  ctx.beginPath();
  result.raw.forEach((p, i) => { const x = xAt(i), y = yAt(p.cum); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
  // 補正後 (緑)
  ctx.strokeStyle = "#34d399"; ctx.lineWidth = 2.5;
  ctx.beginPath();
  result.calibrated.forEach((p, i) => { const x = xAt(i), y = yAt(p.cum); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
  // 見送り点
  ctx.fillStyle = "rgba(168,85,247,0.55)";
  result.calibrated.forEach((p, i) => {
    if (!p.included) { ctx.beginPath(); ctx.arc(xAt(i), yAt(p.cum), 2.5, 0, Math.PI * 2); ctx.fill(); }
  });
  // Y軸ラベル
  ctx.fillStyle = "#64748b"; ctx.font = "10px Inter, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("¥" + Math.round(maxV).toLocaleString("ja-JP"), padX - 4, padY + 8);
  ctx.fillText("¥0", padX - 4, yAt(0) + 3);
  ctx.fillText("¥" + Math.round(minV).toLocaleString("ja-JP"), padX - 4, H - padY + 4);
  ctx.textAlign = "left";
  // 凡例
  ctx.fillStyle = "#94a3b8"; ctx.fillRect(padX,        6, 12, 4);
  ctx.fillStyle = "#cbd5e1"; ctx.fillText("補正前 AI",  padX + 16, 12);
  ctx.fillStyle = "#34d399"; ctx.fillRect(padX + 100,  6, 12, 4);
  ctx.fillStyle = "#cbd5e1"; ctx.fillText("補正後 AI",  padX + 116, 12);
  ctx.fillStyle = "rgba(168,85,247,0.7)";
  ctx.beginPath(); ctx.arc(padX + 200, 8, 2.5, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = "#cbd5e1"; ctx.fillText("見送り", padX + 208, 12);
}

function renderBacktestSummary(el, allBets) {
  if (!el || !window.Backtest?.run) return;
  const r = window.Backtest.run(allBets || []);
  if (!r || r.evaluable === 0) {
    el.className = "backtest-summary bs-neutral";
    el.innerHTML = `<div class="bs-row"><span class="bs-key">評価可能な記録</span><span class="bs-val">${r?.evaluable ?? 0} 件</span></div>
      <div class="bs-verdict">確定済(EV/オッズ付き)の記録を増やすと、AI の進化が見えます</div>`;
    return;
  }
  const imp = r.improvement;
  let cls = "backtest-summary ";
  if (imp != null && imp > 0.03) cls += "bs-good";
  else if (imp != null && imp < -0.03) cls += "bs-bad";
  else cls += "bs-neutral";
  el.className = cls;
  const orig = r.original, hypo = r.hypothetical, d = r.verdictDelta;
  const fmtPctOrDash = (v) => v != null ? `${(v*100).toFixed(0)}%` : "--";
  const fmtYen = (v) => `¥${Math.round(v || 0).toLocaleString("ja-JP")}`;
  const insightsHtml = (r.insight || []).map(s => `<li>${s}</li>`).join("");
  el.innerHTML = `
    <div class="bs-row"><span class="bs-key">評価可能な記録</span><span class="bs-val">${r.evaluable} / ${r.total} 件</span></div>
    <div class="bs-row"><span class="bs-key">補正前 回収率</span><span class="bs-val">${fmtPctOrDash(orig.recovery)} (${orig.hits}/${orig.samples}的中)</span></div>
    <div class="bs-row"><span class="bs-key">補正後 回収率</span><span class="bs-val">${fmtPctOrDash(hypo.recovery)} (${hypo.hits}/${hypo.samples}的中)</span></div>
    <div class="bs-row bs-diff"><span class="bs-key">改善幅</span><span class="bs-val">${imp != null ? ((imp>=0?'+':'')+(imp*100).toFixed(0)+'%') : '--'}</span></div>
    <div class="bs-row"><span class="bs-key">判定変化</span><span class="bs-val">買→見送 ${d.becamePass} / 見送→買 ${d.becameBuy}</span></div>
    ${insightsHtml ? `<ul class="bs-insight">${insightsHtml}</ul>` : ""}
  `;
}

// ─── 月次収支 (エア vs リアル) 棒グラフ ──────────────────────
function monthlyPnL(bets) {
  const map = new Map();
  for (const b of bets) {
    if (!(b.result?.won === true || b.result?.won === false)) continue;
    const ts = b.result.finishedAt || b.ts;
    const ym = (ts || "").slice(0, 7);  // "YYYY-MM"
    if (!ym) continue;
    const pnl = (b.result.won ? (b.result.payout || 0) : 0) - (b.amount || 0);
    map.set(ym, (map.get(ym) || 0) + pnl);
  }
  return map;
}

function drawMonthlyChart(canvas, airBets, realBets) {
  if (!canvas) return;
  const prep = prepHiDPI(canvas); if (!prep) return;
  const { ctx, W, H } = prep;
  const mA = monthlyPnL(airBets);
  const mR = monthlyPnL(realBets);
  const months = [...new Set([...mA.keys(), ...mR.keys()])].sort();
  if (months.length === 0) {
    ctx.fillStyle = "#64748b"; ctx.font = "13px Inter, sans-serif";
    ctx.fillText("月次データがまだありません", 16, H / 2);
    return;
  }
  const recent = months.slice(-12);  // 直近12ヶ月
  const allVals = recent.flatMap(m => [mA.get(m) || 0, mR.get(m) || 0, 0]);
  const minV = Math.min(...allVals);
  const maxV = Math.max(...allVals);

  const padL = 44, padR = 12, padT = 30, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const groupW = plotW / recent.length;
  const barW = Math.max(4, Math.min(18, (groupW - 4) / 2));
  const yAt = v => padT + plotH - ((v - minV) / Math.max(1, maxV - minV)) * plotH;

  // 0 line
  ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, yAt(0)); ctx.lineTo(W - padR, yAt(0)); ctx.stroke();

  // y-axis labels
  ctx.fillStyle = "#64748b"; ctx.font = "10px Inter, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(fmtYen(maxV), padL - 4, padT + 4);
  ctx.fillText(fmtYen(0),    padL - 4, yAt(0) + 3);
  if (minV < 0) ctx.fillText(fmtYen(minV), padL - 4, padT + plotH + 3);
  ctx.textAlign = "left";

  // bars
  recent.forEach((m, i) => {
    const cx = padL + groupW * i + groupW / 2;
    const a = mA.get(m) || 0;
    const r = mR.get(m) || 0;
    const aTop = Math.min(yAt(0), yAt(a));
    const aH = Math.abs(yAt(a) - yAt(0));
    const rTop = Math.min(yAt(0), yAt(r));
    const rH = Math.abs(yAt(r) - yAt(0));
    ctx.fillStyle = a >= 0 ? "rgba(52,211,153,0.85)" : "rgba(239,68,68,0.78)";
    ctx.fillRect(cx - barW - 1, aTop, barW, Math.max(1, aH));
    ctx.fillStyle = r >= 0 ? "rgba(251,146,60,0.85)" : "rgba(239,68,68,0.55)";
    ctx.fillRect(cx + 1,        rTop, barW, Math.max(1, rH));
    // x label (MM)
    ctx.fillStyle = "#64748b"; ctx.font = "10px Inter, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(m.slice(2), cx, H - 8);
  });

  // 凡例
  ctx.font = "11px Inter, sans-serif";
  ctx.fillStyle = "#34d399"; ctx.fillRect(padL,        8, 12, 10);
  ctx.fillStyle = "#cbd5e1"; ctx.textAlign = "left"; ctx.fillText("エア",    padL + 18, 17);
  ctx.fillStyle = "#fb923c"; ctx.fillRect(padL + 70,   8, 12, 10);
  ctx.fillStyle = "#cbd5e1"; ctx.fillText("リアル",   padL + 88, 17);
}

// ─── 直近20件のローリング的中率 ──────────────────────────────
function rollingHitSeries(bets, window = 20) {
  const confirmed = bets.filter(b => b.result?.won === true || b.result?.won === false)
    .sort((a, b) => (a.result.finishedAt || a.ts).localeCompare(b.result.finishedAt || b.ts));
  const out = [];
  for (let i = 0; i < confirmed.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = confirmed.slice(start, i + 1);
    const hits = slice.filter(b => b.result.won).length;
    out.push(hits / slice.length);
  }
  return out;
}

function drawRollingHitChart(canvas, airBets, realBets) {
  if (!canvas) return;
  const prep = prepHiDPI(canvas); if (!prep) return;
  const { ctx, W, H } = prep;
  const sA = rollingHitSeries(airBets);
  const sR = rollingHitSeries(realBets);
  if (sA.length === 0 && sR.length === 0) {
    ctx.fillStyle = "#64748b"; ctx.font = "13px Inter, sans-serif";
    ctx.fillText("ローリング表示には結果確定の記録が必要です", 16, H / 2);
    return;
  }
  const padL = 44, padR = 12, padT = 26, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxLen = Math.max(sA.length, sR.length, 2);
  const xAt = i => padL + (plotW * i) / Math.max(1, maxLen - 1);
  const yAt = v => padT + plotH - v * plotH;  // 0..1

  // grid (0%, 25%, 50%, 75%, 100%)
  ctx.strokeStyle = "rgba(255,255,255,0.07)"; ctx.lineWidth = 1;
  ctx.fillStyle = "#64748b"; ctx.font = "10px Inter, sans-serif"; ctx.textAlign = "right";
  for (const v of [0, 0.25, 0.5, 0.75, 1.0]) {
    const y = yAt(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(`${(v*100).toFixed(0)}%`, padL - 4, y + 3);
  }
  ctx.textAlign = "left";

  // air green
  if (sA.length > 0) {
    ctx.strokeStyle = "#34d399"; ctx.lineWidth = 2;
    ctx.beginPath();
    sA.forEach((v, i) => { const x = xAt(i), y = yAt(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();
  }
  // real orange
  if (sR.length > 0) {
    ctx.strokeStyle = "#fb923c"; ctx.lineWidth = 2;
    ctx.beginPath();
    sR.forEach((v, i) => { const x = xAt(i), y = yAt(v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();
  }

  // 凡例
  ctx.font = "11px Inter, sans-serif";
  ctx.fillStyle = "#34d399"; ctx.fillRect(padL,        8, 12, 4);
  ctx.fillStyle = "#cbd5e1"; ctx.fillText("エア",    padL + 18, 13);
  ctx.fillStyle = "#fb923c"; ctx.fillRect(padL + 70,   8, 12, 4);
  ctx.fillStyle = "#cbd5e1"; ctx.fillText("リアル",   padL + 88, 13);
}

// ─── グレード別の比較テーブル ────────────────────────────────
function renderGradeCompare(airBets, realBets) {
  const wrap = $("#grade-compare");
  if (!wrap) return;
  const grades = ["S", "A", "B", "C", "D"];
  const groupBy = (bets) => {
    const m = {};
    for (const g of grades) m[g] = [];
    for (const b of bets) {
      const g = b.grade && grades.includes(b.grade) ? b.grade
              : (window.Learner?.gradeOf?.(b)) || null;
      if (g && grades.includes(g)) m[g].push(b);
    }
    return m;
  };
  const ga = groupBy(airBets);
  const gr = groupBy(realBets);
  wrap.innerHTML = `
    <table class="grade-compare-table">
      <thead>
        <tr><th>グレード</th><th>エア 件数</th><th>エア 回収率</th><th>リアル 件数</th><th>リアル 回収率</th><th>差</th></tr>
      </thead>
      <tbody></tbody>
    </table>
  `;
  const tbody = wrap.querySelector("tbody");
  let any = false;
  for (const g of grades) {
    const sa = calcStats(ga[g]);
    const sr = calcStats(gr[g]);
    const eligible = (sa.confirmedCount >= 10) || (sr.confirmedCount >= 10);
    if (!eligible) continue;
    any = true;
    const diff = (sa.recovery != null && sr.recovery != null) ? sa.recovery - sr.recovery : null;
    const diffPct = diff != null ? `${diff >= 0 ? "+" : ""}${(diff * 100).toFixed(0)}%` : "--";
    const diffCls = diff == null ? "" : (diff >= 0 ? "diff-pos" : "diff-neg");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="grade-mini grade-${g}">${g}</span></td>
      <td>${sa.confirmedCount}</td>
      <td>${sa.recovery != null ? `${(sa.recovery*100).toFixed(0)}%` : "--"}</td>
      <td>${sr.confirmedCount}</td>
      <td>${sr.recovery != null ? `${(sr.recovery*100).toFixed(0)}%` : "--"}</td>
      <td class="${diffCls}">${diffPct}</td>
    `;
    tbody.appendChild(tr);
  }
  if (!any) {
    wrap.innerHTML = `<p class="pro-empty">10件以上確定したグレードがまだありません</p>`;
  }
}

function cumulativeSeries(bets) {
  const confirmed = bets.filter(b => b.result?.won === true || b.result?.won === false)
    .sort((a, b) => (a.result.finishedAt || a.ts).localeCompare(b.result.finishedAt || b.ts));
  let cum = 0;
  return confirmed.map(b => { cum += (b.result.won ? (b.result.payout || 0) : 0) - (b.amount || 0); return cum; });
}

function drawDualChart(canvas, airBets, realBets) {
  if (!canvas) return;
  const prep = prepHiDPI(canvas); if (!prep) return;
  const { ctx, W, H } = prep;
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
  $("#btn-refresh").addEventListener("click", () => {
    // 手動入力モードはユーザー意図的な ↻ で解除
    if (_manualMode) clearManualMode();
    refreshAll();
  });

  // 手動入力 (無料路線)
  const miBtn = $("#mi-submit");
  if (miBtn) miBtn.addEventListener("click", () => submitManual());
  const miTa  = $("#mi-textarea");
  if (miTa) miTa.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitManual();
  });

  // 保存レースの全消去
  const clrBtn = $("#btn-clear-saved");
  if (clrBtn) clrBtn.addEventListener("click", () => {
    if (confirm("保存した全レースを消去します。よろしいですか?")) {
      saveSavedRaces([]);
      renderSavedRacesList();
      showToast("保存レースを消去しました", "ok");
    }
  });

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

  // ─── 通知 ────────────────────────────────────────────
  $("#btn-notify-toggle")?.addEventListener("click", async () => {
    const cur = localStorage.getItem(NOTIFY_ENABLED_KEY) === "1"
      && (typeof Notification !== "undefined" && Notification.permission === "granted");
    if (cur) {
      localStorage.removeItem(NOTIFY_ENABLED_KEY);
      showToast("通知をOFFにしました");
      refreshNotifyUi();
      return;
    }
    const ok = await requestNotifyPermission();
    if (ok) {
      localStorage.setItem(NOTIFY_ENABLED_KEY, "1");
      showToast("✓ 通知をONにしました", "ok");
    }
    refreshNotifyUi();
  });

  $("#btn-notify-test")?.addEventListener("click", async () => {
    if (!isNotifySupported()) { showToast("この端末は通知に対応していません", "warn"); return; }
    if (Notification.permission !== "granted") {
      const ok = await requestNotifyPermission();
      if (!ok) return;
    }
    await showLocalNotification(
      "🔔 KEIBA NAVIGATOR (テスト)",
      "通知のテストです。朝に「今日のベスト1」がここに表示されます。",
      "keiba-test"
    );
    showToast("✓ テスト通知を送信しました", "ok");
  });

  // ─── A2HS バナー閉じる ────────────────────────────
  $("#a2hs-close")?.addEventListener("click", () => {
    const banner = $("#a2hs-banner");
    if (banner) banner.hidden = true;
    try { localStorage.setItem(A2HS_DISMISS_KEY, "1"); } catch {}
  });

  // ─── クラウド同期 (Supabase) ─────────────────────────
  $("#btn-signin")?.addEventListener("click", async () => {
    const email = ($("#cloud-email")?.value || "").trim();
    if (!email || !email.includes("@")) { showToast("メールアドレスを入力してください", "warn"); return; }
    try {
      await window.Storage.signIn(email);
      showToast("📧 ログインリンクをメールで送信しました。リンクをタップしてください", "ok");
    } catch (e) {
      showToast("✕ ログイン失敗: " + (e.message || e), "err");
    }
  });
  $("#btn-signout")?.addEventListener("click", async () => {
    if (!confirm("ログアウトします。クラウド同期は停止し、以後の保存はこの端末の localStorage にのみ行われます。")) return;
    try {
      await window.Storage.signOut();
      showToast("ログアウトしました");
    } catch (e) { showToast("✕ ログアウト失敗: " + (e.message || e), "err"); }
  });
  $("#btn-migrate")?.addEventListener("click", async () => {
    if (!confirm("この端末の localStorage 内の記録を Supabase へアップロードします。サーバ側の同名IDは上書きされます。続行しますか?")) return;
    try {
      const r = await window.Storage.migrateToCloud();
      if (r.ok) showToast("✓ クラウドへアップロードしました");
      else showToast("✕ アップロード失敗: " + (r.error || "unknown"), "err");
    } catch (e) {
      showToast("✕ アップロード失敗: " + (e.message || e), "err");
    }
  });

  // Supabase 認証状態が変わったらUI更新
  if (window.Storage) {
    window.Storage.onChange(() => {
      try { refreshCloudUi(); } catch {}
      // ログイン直後はクラウドからリロード
      if (window.Storage.mode === "cloud") hydrateFromCloud();
    });
  }

  // ─── CSV インポート ─────────────────────────────────
  let _pendingCsvBets = null;
  $("#btn-csv-sample")?.addEventListener("click", (ev) => {
    if (!window.CsvImport) return;
    ev.preventDefault();
    const blob = new Blob(["﻿" + window.CsvImport.sampleCsv()], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "keiba_bets_sample.csv";
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
  });

  $("#file-csv-import")?.addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file || !window.CsvImport) return;
    try {
      const parsed = await window.CsvImport.parseFile(file);
      if (parsed.errors.length) {
        showToast("✕ CSV読込み失敗: " + parsed.errors[0].msg, "err");
        return;
      }
      const { bets, errors } = window.CsvImport.toBets(parsed.rows);
      _pendingCsvBets = bets;
      const wrap = $("#csv-preview");
      const summary = $("#csv-preview-summary");
      const body = $("#csv-preview-body");
      if (!wrap || !summary || !body) return;
      wrap.hidden = false;
      summary.textContent =
        `成功 ${bets.length} 行 / エラー ${errors.length} 行` +
        (errors.length ? ` (例: 行${errors[0].row} ${errors[0].msgs[0]})` : "");
      body.innerHTML = "";
      const showRows = bets.slice(0, 10);
      const tbl = document.createElement("table");
      tbl.className = "csv-preview-table";
      tbl.innerHTML = `<thead><tr><th>日付</th><th>レース</th><th>種類</th><th>金額</th><th>馬</th><th>オッズ</th><th>結果</th></tr></thead>`;
      const tbody = document.createElement("tbody");
      for (const b of showRows) {
        const tr = document.createElement("tr");
        const ds = b.ts ? new Date(b.ts).toISOString().slice(0, 10) : "--";
        const wonText = b.result == null ? "結果待ち" : (b.result.won ? "○" : "×");
        tr.innerHTML = `<td>${escapeHtml(ds)}</td><td>${escapeHtml(b.raceName||"--")}</td><td>${b.type}</td><td>${b.amount}円</td><td>${escapeHtml(b.target||"--")}</td><td>${b.odds??"--"}</td><td>${wonText}</td>`;
        tbody.appendChild(tr);
      }
      tbl.appendChild(tbody);
      body.appendChild(tbl);
      if (bets.length > showRows.length) {
        const more = document.createElement("p");
        more.className = "csv-preview-more";
        more.textContent = `…他 ${bets.length - showRows.length} 件`;
        body.appendChild(more);
      }
    } catch (e) {
      showToast("✕ CSV解析失敗: " + (e.message || e), "err");
    } finally {
      ev.target.value = "";
    }
  });

  $("#btn-csv-cancel")?.addEventListener("click", () => {
    _pendingCsvBets = null;
    const wrap = $("#csv-preview"); if (wrap) wrap.hidden = true;
  });

  $("#btn-csv-confirm")?.addEventListener("click", () => {
    if (!_pendingCsvBets || !_pendingCsvBets.length) {
      showToast("取り込むデータがありません", "warn");
      return;
    }
    if (!confirm(`${_pendingCsvBets.length} 件の馬券記録を取り込みます。続行しますか?`)) return;
    const store = loadStore();
    // 既存の id と衝突しないように unique id を再採番
    const existingIds = new Set((store.bets || []).map(b => b.id));
    let added = 0, skipped = 0;
    for (const b of _pendingCsvBets) {
      let id = b.id;
      while (existingIds.has(id)) id = id + "_" + Math.random().toString(36).slice(2, 6);
      if (existingIds.has(b.id)) { skipped++; }
      existingIds.add(id);
      store.bets.push({ ...b, id });
      added++;
    }
    saveStore(store);
    _pendingCsvBets = null;
    const wrap = $("#csv-preview"); if (wrap) wrap.hidden = true;
    showToast(`✓ ${added} 件取り込みました${skipped ? ` (重複 ${skipped} 件は別IDで保存)` : ""}`);
    try { renderRecords(); renderAiTrack(); } catch {}
  });

  // インポート (JSON)
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

// ─── 通知 (Notification API) ──────────────────────────────
const NOTIFY_ENABLED_KEY = "keiba_notify_enabled_v1";
const NOTIFY_LAST_KEY    = "keiba_notify_last_v1";

function isNotifySupported() {
  return typeof window !== "undefined"
    && "Notification" in window
    && "serviceWorker" in navigator;
}

async function requestNotifyPermission() {
  if (!isNotifySupported()) {
    showToast("この端末は通知に対応していません", "warn");
    return false;
  }
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") {
    showToast("⚠ 通知が拒否されています。ブラウザ設定で許可してください", "warn");
    return false;
  }
  try {
    const r = await Notification.requestPermission();
    return r === "granted";
  } catch { return false; }
}

async function showLocalNotification(title, body, tag) {
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg && reg.showNotification) {
      reg.showNotification(title, {
        body, icon: "/icon.svg", badge: "/icon.svg",
        tag: tag || "keiba-nav",
      });
    } else {
      new Notification(title, { body, icon: "/icon.svg" });
    }
  } catch (e) { console.warn("[notify] failed", e); }
}

async function maybeShowMorningNotification() {
  if (!isNotifySupported()) return;
  if (localStorage.getItem(NOTIFY_ENABLED_KEY) !== "1") return;
  if (Notification.permission !== "granted") return;
  const now = new Date();
  const hour = now.getHours();
  if (hour < 6 || hour >= 12) return;
  const today = now.toISOString().slice(0, 10);
  if (localStorage.getItem(NOTIFY_LAST_KEY) === today) return;
  const races = loadSavedRaces();
  if (!races.length) return;
  const ranked = races.map(r => ({ ...r, calEv: calibratedTopEv(r.conclusion) }))
                     .sort((a, b) => (b.calEv ?? -Infinity) - (a.calEv ?? -Infinity));
  const best = ranked[0];
  const ev = best?.calEv;
  if (ev == null || !Number.isFinite(ev)) return;
  const top = best.conclusion?.picks?.[0];
  if (!top) return;
  const sign = ev >= 1 ? "+" : "";
  const evPct = ((ev - 1) * 100).toFixed(0);
  const title = `🏆 今日のベスト1: ${best.raceName || "保存レース"}`;
  const body  = `${top.number || "?"}番 ${top.name || ""} / 補正後EV ${sign}${evPct}% / ${(top.odds ?? "?")}倍`;
  await showLocalNotification(title, body, "keiba-best1-" + today);
  localStorage.setItem(NOTIFY_LAST_KEY, today);
}

function refreshNotifyUi() {
  const btn = $("#btn-notify-toggle");
  const status = $("#notify-status");
  const test = $("#btn-notify-test");
  if (!btn || !status) return;
  if (!isNotifySupported()) {
    btn.disabled = true;
    btn.textContent = "🔔 通知 (この端末は非対応)";
    status.textContent = "✕ この端末は通知に対応していません (iOSの場合はホーム画面に追加してから開く必要があります)";
    status.style.color = "#fcd34d";
    if (test) test.disabled = true;
    return;
  }
  const enabled = localStorage.getItem(NOTIFY_ENABLED_KEY) === "1"
    && Notification.permission === "granted";
  if (enabled) {
    btn.textContent = "🔕 通知をOFFにする";
    status.textContent = "✓ ON: 朝6〜12時にアプリを開くと「今日のベスト1」を通知します";
    status.style.color = "#34d399";
  } else if (Notification.permission === "denied") {
    btn.disabled = true;
    btn.textContent = "🔔 通知をONにする";
    status.textContent = "⚠ 通知が拒否されています (ブラウザ設定で許可してください)";
    status.style.color = "#fcd34d";
  } else {
    btn.textContent = "🔔 通知をONにする";
    status.textContent = "OFF: ボタンを押すと許可をリクエストします";
    status.style.color = "";
  }
}

// ─── iOS ホーム画面追加バナー ──────────────────────────────
const A2HS_DISMISS_KEY = "keiba_a2hs_dismissed_v1";
function maybeShowA2HSBanner() {
  const banner = $("#a2hs-banner");
  if (!banner) return;
  if (localStorage.getItem(A2HS_DISMISS_KEY) === "1") return;
  // standalone モードなら既にホーム追加済み
  const isStandalone = window.matchMedia?.("(display-mode: standalone)")?.matches
    || window.navigator?.standalone === true;
  if (isStandalone) return;
  // iOS Safari のみ表示
  const ua = navigator.userAgent || "";
  const isIos = /iPhone|iPad|iPod/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  if (!isIos) return;
  banner.hidden = false;
}

// ─── URL パラメータ (manifest shortcuts 用) ───────────────
function applyUrlParams() {
  try {
    const sp = new URLSearchParams(location.search);
    const tab = sp.get("tab");
    const view = sp.get("view");
    if (tab && ["home", "record", "settings"].includes(tab)) {
      switchTab(tab);
    }
    if (view === "best1") {
      // 保存レースまでスクロール
      setTimeout(() => {
        const card = $("#card-saved-races");
        if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth" });
      }, 300);
    }
  } catch {}
}

// クラウド同期状態の表示・ボタン制御
function refreshCloudUi() {
  const txt = $("#cloud-status-text");
  const emailIn = $("#cloud-email");
  const inBtn   = $("#btn-signin");
  const outBtn  = $("#btn-signout");
  const migBtn  = $("#btn-migrate");
  if (!txt) return;
  const s = window.Storage;
  if (!s) {
    txt.textContent = "Storage 未読込 (ページを再読み込みしてください)";
    return;
  }
  if (!s.cloudConfigured) {
    txt.textContent = "🔵 ローカルモード (config.js が未設定 — localStorage のみで動作)";
    [emailIn, inBtn, outBtn, migBtn].forEach(el => el && (el.hidden = true));
    return;
  }
  if (s.mode === "cloud") {
    txt.textContent = `☁️ クラウド同期中 (${s.user?.email || "ログイン済"})`;
    if (emailIn) emailIn.hidden = true;
    if (inBtn)   inBtn.hidden = true;
    if (outBtn)  outBtn.hidden = false;
    if (migBtn)  migBtn.hidden = false;
  } else {
    txt.textContent = "⚪ Supabase 設定済 — メールアドレスでログインすると同期開始";
    if (emailIn) emailIn.hidden = false;
    if (inBtn)   inBtn.hidden = false;
    if (outBtn)  outBtn.hidden = true;
    if (migBtn)  migBtn.hidden = true;
  }
}

// ─── サービスワーカー登録 (PWA・通知) ──────────────────
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // ローカル開発(http) でも動く。Vercel(https) でも動く。
  navigator.serviceWorker.register("/sw.js")
    .then(() => { /* registered */ })
    .catch(e => console.warn("[sw] register failed", e));
}

document.addEventListener("DOMContentLoaded", async () => {
  setupEvents();
  refreshConnection().catch(() => {});
  // クラウド初期化 → 既存のlocalStorage読込より先に
  try { await hydrateFromCloud(); } catch {}
  try { renderSettings(); refreshCloudUi(); } catch (e) { console.warn(e); }
  try { renderRecords();  } catch (e) { console.warn(e); }
  try { renderAiTrack();  } catch (e) { console.warn(e); }
  try { renderSavedRacesList(); } catch (e) { console.warn(e); }
  try { refreshNotifyUi(); } catch (e) { console.warn(e); }
  try { maybeShowA2HSBanner(); } catch (e) { console.warn(e); }
  try { applyUrlParams(); } catch (e) { console.warn(e); }
  registerServiceWorker();
  // SW が ready になってから朝の通知判定
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready
      .then(() => maybeShowMorningNotification())
      .catch(() => {});
  } else {
    setTimeout(() => maybeShowMorningNotification().catch(() => {}), 500);
  }
  if (_loadCorruptionDetected) {
    setTimeout(() => showToast("⚠ 保存データの一部が壊れていたため初期化しました(バックアップは保持)", "warn"), 800);
  }
});

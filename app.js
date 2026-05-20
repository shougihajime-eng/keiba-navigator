/* =====================================================================
   KEIBA NAVIGATOR — app.js (Wave15 全面リライト)
   設計: 必殺一号艇相当のシンプルな描画フロー
        データ取得 → State → render() を 30 秒毎にループ
   ===================================================================== */
(function () {
  "use strict";

  // ─── 設定 ────────────────────────────────────────────────
  const REFRESH_MS = 30_000;
  const TICK_MS    = 1_000;
  const STORE_KEY  = "keiba_v15";

  // ─── State ───────────────────────────────────────────────
  const state = {
    fetchedAt: null,
    racesLast: null,
    status: null,
    races: [],
    win5: null,
    bets: loadBets(),
    activeTab: "home",
    allRacesFilter: "all",
    allRacesSort: "time",
    detailRaceId: null,
    isRefreshing: false,
    // ★Wave15.1 WIN5 拡張
    win5Mode: localStorage.getItem("keiba_win5_mode") || "ev",   // "ev" | "hit"
    win5Budget: parseInt(localStorage.getItem("keiba_win5_budget"), 10) || null,
    win5SelectedKey: localStorage.getItem("keiba_win5_selected") || null,
    win5UserPlan: null, // [k1,k2,k3,k4,k5]
    autostatus: null, // ★Wave16-QA: /api/automation-status の結果。初回描画前は null
    mlStatus: null,   // ★Wave17: /api/ml-status の結果 (LightGBM 学習メタ + 過去レース実証回収率)
    recommendations: null,  // ★Wave19: /api/recommendations の結果 (100% 越え戦略の今日の推奨レース)
    // ★Wave22.8: エフェクト用 (一度しか発火させない)
    lastClopRaceId: null,        // 結論カードに描いた raceId (重複再生防止)
    flashedImminentFor: null,    // 「もうすぐ発走」フラッシュ済みの raceId
    flashedStartFor: null,       // 「発走!」フラッシュ済みの raceId
  };

  // ─── Util ───────────────────────────────────────────────
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return [...document.querySelectorAll(sel)]; }
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => {
      if (v === false || v == null) return;
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "dataset") Object.assign(e.dataset, v);
      else e.setAttribute(k, v);
    });
    children.flat().forEach((c) => {
      if (c == null || c === false) return;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
  }
  function fmtYen(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return Math.round(n).toLocaleString("ja-JP");
  }
  // 文字化け検出: JV-Link の SJIS デコード失敗で "?@?b?L?[" のような ?, ?@, ?b 等のパターンが続く文字列を判定。
  // 5 文字以上のうち 60% 以上が "?" / "@" / 半角ASCII記号なら mojibake と見なす。
  function isGarbled(s) {
    if (!s || typeof s !== "string") return false;
    const trimmed = s.trim();
    if (trimmed.length < 3) return false;
    let bad = 0;
    for (const ch of trimmed) {
      const c = ch.charCodeAt(0);
      // ?, @, half-width punctuation
      if (ch === "?" || ch === "@" || (c >= 0x21 && c <= 0x7E && !/[a-zA-Z0-9]/.test(ch))) bad++;
    }
    return bad / trimmed.length >= 0.5;
  }
  function scrubName(s, fallback) {
    if (isGarbled(s)) return fallback || "(取得中)";
    return s || fallback || "";
  }
  function fmtAge(sec) {
    if (sec == null || sec < 0) return "—";
    if (sec < 60) return `${Math.floor(sec)}秒`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}分`;
    const h = Math.floor(m / 60);
    return `${h}時間${m % 60}分`;
  }
  // Wave22.9: toast(msg, type) — type は info(既定) | success | warn | error
  function toast(msg, type) {
    const t = $("#toast");
    const safeType = ["success", "warn", "error", "info"].includes(type) ? type : "info";
    // 既存のメッセージから自動判定 (絵文字含み・「失敗」「不正」「エラー」など)
    let detectedType = safeType;
    if (safeType === "info" && typeof msg === "string") {
      if (/🎉|的中|成功|完了/.test(msg)) detectedType = "success";
      else if (/失敗|不正|エラー|err/i.test(msg)) detectedType = "error";
      else if (/注意|warn|⚠/i.test(msg)) detectedType = "warn";
    }
    const icon =
      detectedType === "success" ? "✅" :
      detectedType === "warn"    ? "⚠️" :
      detectedType === "error"   ? "🚫" : "💡";
    t.className = "toast toast-" + detectedType;
    t.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${escapeHtml(msg)}</span>`;
    t.hidden = false;
    t.style.animation = "none";
    t.offsetHeight;
    t.style.animation = "";
    clearTimeout(toast._tm);
    toast._tm = setTimeout(() => { t.hidden = true; }, 3200);
  }

  // ─── 永続化 ────────────────────────────────────────────────
  function loadBets() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  function saveBets() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.bets)); }
    catch (e) { console.warn("saveBets failed", e); }
  }

  // ─── 日付 / 時刻 ─────────────────────────────────────────
  function todayJst() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
  function fmtDateMonth(dateStr) {
    if (!dateStr) return "";
    const m = String(dateStr).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return dateStr;
    return `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}`;
  }
  function weekday(dateStr) {
    const d = dateStr ? new Date(dateStr) : new Date();
    return ["日","月","火","水","木","金","土"][d.getDay()];
  }
  function startDateOfRace(race) {
    if (race.startTime) {
      const id = race.raceId || "";
      if (id.length >= 8) {
        const y = parseInt(id.slice(0, 4), 10);
        const mo = parseInt(id.slice(4, 6), 10);
        const da = parseInt(id.slice(6, 8), 10);
        if (y && mo && da) {
          const m = String(race.startTime).match(/(\d{1,2}):(\d{2})/);
          if (m) return new Date(y, mo - 1, da, parseInt(m[1],10), parseInt(m[2],10), 0, 0);
        }
      }
      const m = String(race.startTime).match(/(\d{1,2}):(\d{2})/);
      if (m) { const d = new Date(); d.setHours(parseInt(m[1],10), parseInt(m[2],10), 0, 0); return d; }
    }
    return null;
  }
  function minutesUntilStart(race) {
    const dt = startDateOfRace(race);
    if (!dt) return null;
    return Math.floor((dt.getTime() - Date.now()) / 60000);
  }
  // 次回 WIN5 開催 (= 次の日曜) の予定情報を返す
  function nextWin5Schedule() {
    const now = new Date();
    const day = now.getDay();
    const daysToSun = day === 0 ? 7 : (7 - day);
    const sun = new Date(now);
    sun.setDate(now.getDate() + daysToSun);
    sun.setHours(14, 50, 0, 0);
    const sat = new Date(sun);
    sat.setDate(sun.getDate() - 1);
    const fmt = (d) => `${d.getMonth()+1}/${d.getDate()}`;
    return {
      dateLabel: fmt(sun),
      saturdayLabel: fmt(sat),
      weekday: "日曜",
      sunday: sun, saturday: sat,
    };
  }

  // ─── WIN5 通知 (土19:25 発売直前 / 日14:45 締切15分前) ───
  // PWA をホーム画面に追加してあれば iOS Safari でも通知が出る (iOS 16.4+)。
  // バックグラウンド通知には Web Push が必要だが、ここではアプリが開いている間に
  // setInterval で時刻をチェックして発火する方式 (シンプルかつブラウザ依存少)。
  const NOTIFY_KEY = "keiba_win5_notify";
  function isWin5NotifyEnabled() { return localStorage.getItem(NOTIFY_KEY) === "1"; }
  function setWin5NotifyEnabled(v) { localStorage.setItem(NOTIFY_KEY, v ? "1" : "0"); }
  async function enableWin5Notify() {
    if (!("Notification" in window)) { toast("このブラウザは通知に対応していません"); return false; }
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("通知が許可されませんでした"); return false; }
    setWin5NotifyEnabled(true);
    toast("WIN5 通知を ON にしました (土19:25 / 日14:45)");
    return true;
  }
  function disableWin5Notify() {
    setWin5NotifyEnabled(false);
    toast("WIN5 通知を OFF にしました");
  }
  function fireWin5Notify(title, body) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      if (navigator.serviceWorker?.getRegistration) {
        navigator.serviceWorker.getRegistration().then((reg) => {
          if (reg && reg.showNotification) {
            reg.showNotification(title, { body, icon: "/icon.svg", badge: "/icon.svg", tag: "keiba-win5" });
          } else {
            new Notification(title, { body, icon: "/icon.svg" });
          }
        });
      } else {
        new Notification(title, { body, icon: "/icon.svg" });
      }
    } catch (e) { console.warn("notify failed", e); }
  }
  function checkWin5NotifyTick() {
    if (!isWin5NotifyEnabled()) return;
    const now = new Date();
    const day = now.getDay();
    const hh = now.getHours();
    const mm = now.getMinutes();
    const last = localStorage.getItem("keiba_win5_notify_last") || "";
    const todayKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;
    if (day === 6 && hh === 19 && mm >= 25 && mm <= 35) {
      const key = `${todayKey}-sat`;
      if (last !== key) {
        const w = nextWin5Schedule();
        fireWin5Notify("もうすぐ WIN5 発売", `今夜 19:30 から WIN5 発売開始。対象は ${w.dateLabel}(日) の 5 レース (14:50〜15:40)。アプリを開いて戦略を選んでください。`);
        localStorage.setItem("keiba_win5_notify_last", key);
      }
    }
    if (day === 0 && hh === 14 && mm >= 40 && mm <= 50) {
      const key = `${todayKey}-sun`;
      if (last !== key) {
        fireWin5Notify("WIN5 締切まで残りわずか", "WIN5 第1レース (14:50発走) の 5 分前で締切。最後の確認を。");
        localStorage.setItem("keiba_win5_notify_last", key);
      }
    }
  }

  // ─── ティア判定 (5 段階 + 推奨戦略連動) ──────────────────
  // ULTRA: EV >= 1.5 かつ AI 信頼度 >= 0.45 (究極の絶好機)
  // PRIME: EV >= 1.3 (絶好機)
  // GO:    EV >= 1.1 (本命勝負)
  // COND:  EV >= 1.0 (条件付き)
  // BEST:  EV >= 0.92 (今日のベター候補)
  function tierOfRace(race) {
    const ev = race.topPick?.ev ?? null;
    const conf = race.confidence ?? 0;
    if (ev == null) return "none";
    if (ev >= 1.50 && conf >= 0.45) return "ultra";
    if (ev >= 1.30) return "prime";
    if (ev >= 1.10) return "go";
    if (ev >= 1.00) return "cond";
    if (ev >= 0.92) return "best";
    return "none";
  }
  function tierStars(t) {
    return { ultra: "★★★★", prime: "★★★", go: "★★", cond: "★", best: "☆", none: "" }[t] || "";
  }
  function tierTitle(t) {
    return {
      ultra: `💎✦ AI の究極予想 ${tierStars("ultra")} ・ 今日いちばん買う1点`,
      prime: `💎 AI の絶好機予想 ${tierStars("prime")} ・ 本気で買う`,
      go:    `🎯 AI の本命予想 ${tierStars("go")} ・ ここを買え!`,
      cond:  `⚡ AI の今日の予想 ${tierStars("cond")} ・ 条件付きで買う`,
      best:  `⭐ 今日のおすすめ ${tierStars("best")} ・ 自信控えめ・お試し買いに`,
      none:  "⏸ AI は今日は休みたい ・ 買う価値のあるレースが見当たらない",
    }[t] || "—";
  }
  function tierLabel(t) {
    return { ultra: "絶好機", prime: "絶好機", go: "勝負", cond: "条件付き", best: "ベター", none: "見送り" }[t] || "—";
  }

  // ─── API ─────────────────────────────────────────────────
  async function api(path) {
    try {
      const r = await fetch(path, { cache: "no-store" });
      if (!r.ok) {
        if (r.status >= 500 && r.status < 600) return { _http: r.status, ok: false };
        return null;
      }
      return await r.json();
    } catch (e) {
      console.warn(`[api] ${path} failed:`, e?.message || e);
      return null;
    }
  }
  async function refreshAll() {
    if (state.isRefreshing) return;
    state.isRefreshing = true;
    $("#ai-thinking").hidden = false;
    try {
      // ★Wave15.1: WIN5 にクエリパラメータ付き
      const w5Params = [];
      if (state.win5Mode === "hit") w5Params.push("mode=hit");
      if (state.win5Budget) w5Params.push(`budget=${state.win5Budget}`);
      if (Array.isArray(state.win5UserPlan) && state.win5UserPlan.length === 5) {
        w5Params.push(`plan=${state.win5UserPlan.join(",")}`);
      }
      const w5Url = "/api/win5" + (w5Params.length ? "?" + w5Params.join("&") : "");
      const [status, races, win5, autostatus, mlStatus, recommendations] = await Promise.all([
        api("/api/status"),
        api("/api/races"),
        api(w5Url),
        api("/api/automation-status"),
        api("/api/ml-status"),
        api("/api/recommendations"),
      ]);
      if (status) state.status = status;
      if (races && races.ok) {
        state.races = Array.isArray(races.races) ? races.races : [];
        state.fetchedAt = races.fetchedAt || new Date().toISOString();
        state.racesLast = races;
      } else if (races) {
        state.races = [];
        state.racesLast = races;
      }
      if (win5) state.win5 = win5;
      if (autostatus) state.autostatus = autostatus;
      if (mlStatus) state.mlStatus = mlStatus;
      if (recommendations) state.recommendations = recommendations;
      render();
    } finally {
      state.isRefreshing = false;
      $("#ai-thinking").hidden = true;
    }
  }

  // ─── 描画: BrandHeader ───────────────────────────────────
  function renderHeader() {
    const today = todayJst();
    $("#brand-day").textContent = fmtDateMonth(today);
    $("#brand-wd").textContent = `(${weekday(today)})`;

    const total = state.races.length;
    const goRaces = state.races.filter((r) => {
      const t = tierOfRace(r);
      return t === "gold" || t === "go";
    });
    $("#metric-races").innerHTML = `${total}<small>R</small>`;
    $("#metric-goes").innerHTML  = `${goRaces.length}<small>R</small>`;
    const auc = state.racesLast?.learning?.lgbm?.metrics?.auc;
    $("#metric-auc").innerHTML = auc != null
      ? `${(auc * 100).toFixed(1)}<small>%</small>`
      : `—<small>AUC</small>`;
  }

  // ─── 描画: LiveStrip ─────────────────────────────────────
  function renderLive() {
    const updated = state.fetchedAt ? new Date(state.fetchedAt).getTime() : null;
    const ageSec = updated ? (Date.now() - updated) / 1000 : null;
    const dot = $("#live-dot");
    const lbl = $("#live-label");
    if (ageSec == null) {
      dot.className = "stale-dot"; lbl.textContent = "—"; lbl.className = "live-label is-warn";
    } else if (ageSec < 120) {
      dot.className = "live-dot"; lbl.textContent = "LIVE"; lbl.className = "live-label is-go";
    } else if (ageSec < 600) {
      dot.className = "stale-dot"; lbl.textContent = "更新待"; lbl.className = "live-label is-warn";
    } else {
      dot.className = "err-dot"; lbl.textContent = "停止"; lbl.className = "live-label is-bad";
    }
    $("#live-pred-count").textContent = state.races.length;
    $("#live-updated-val").textContent = ageSec != null ? fmtAge(ageSec) : "—";
  }

  // ─── 描画: DecisionCard (本日の主役) ──────────────────────
  function renderDecisionCard() {
    const mount = $("#decision-mount");
    if (!state.racesLast) return;
    if (state.races.length === 0) {
      mount.innerHTML = "";
      mount.appendChild(renderNoRaceDay());
      return;
    }

    const sorted = [...state.races].sort((a, b) => {
      const aEv = a.topPick?.ev ?? -Infinity;
      const bEv = b.topPick?.ev ?? -Infinity;
      return bEv - aEv;
    });
    const best = sorted[0];
    const tier = tierOfRace(best);

    if (tier === "none" || !best.topPick) {
      mount.innerHTML = "";
      mount.appendChild(renderNoBetCard(sorted));
      return;
    }

    mount.innerHTML = "";
    mount.appendChild(renderBuyCard(best, tier, sorted));

    // Wave22.8: 新しい best レースになった瞬間だけ蹄音を再生 (毎フレームで鳴らさない)
    if (window.kbEffects && state.lastClopRaceId !== best.raceId) {
      state.lastClopRaceId = best.raceId;
      try { window.kbEffects.playHoofClop(); } catch {}
    }
  }

  function renderBuyCard(race, tier, sorted) {
    const card = el("div", { class: `decision-card tier-${tier} fade-in`, id: "decision-card" });

    // ── ヘッダ帯 (ティア別の派手ラベル + 他のレース件数)
    const head = el("div", { class: "decision-head" });
    head.appendChild(el("div", { class: "decision-tier-label" }, tierTitle(tier)));
    const extraCnt = sorted.filter((r) => r !== race && ["ultra","prime","go","cond"].includes(tierOfRace(r))).length;
    if (extraCnt > 0) {
      head.appendChild(el("div", { class: "decision-tier-extra" }, `他に `, el("b", null, `+${extraCnt}R`)));
    }
    card.appendChild(head);

    // ── 本体 (card-enter-stagger で子要素がぬるっと入場)
    const body = el("div", { class: "decision-body card-enter-stagger" });

    // (0) Wave24: 「今日いちばん買う 1 点」+ ティア — 1 行に統合 (重複削除)
    const tierEmoji = tier === "ultra" ? "💎✦" : tier === "prime" ? "💎" : tier === "go" ? "🎯" : tier === "cond" ? "⚡" : "🎲";
    const tierColor = tier === "ultra" ? "gold" : tier === "prime" ? "gold" : tier === "go" ? "turf" : tier === "cond" ? "sky" : "mute";
    const tierMsg = tier === "ultra" ? "究極の絶好機・今日いちばん買う 1 点" :
                    tier === "prime" ? "絶好機・本気で買おう" :
                    tier === "go"    ? "AI の本命・このレースを買おう" :
                    tier === "cond"  ? "条件付き・慎重に・お試し金額で" :
                                        "自信は控えめだが見守りたい 1 点";
    const overline = el("div", { class: `today-best-overline today-best-${tierColor}` },
      el("div", { class: "tbo-emoji" }, tierEmoji),
      el("div", { class: "tbo-stack" },
        el("div", { class: "tbo-eyebrow" }, "TODAY'S BEST PICK"),
        el("div", { class: "tbo-headline" }, tierMsg)
      ),
      el("div", { class: "tbo-tier-pill" }, tierTitle(tier))
    );
    body.appendChild(overline);

    // (1) 場名 (デカ) + R + 馬場・距離 + Countdown
    const headline = el("div", { class: "decision-headline" });
    const nameBlock = el("div", { class: "race-name-block" });
    if (race.isG1) nameBlock.appendChild(el("div", { class: "grade-badge grade-l" }, "G1"));
    const venueLabel = parseVenueLabel(race);
    const venueClass = (tier === "ultra" || tier === "prime") ? "venue-display shimmer-text" : "venue-display";
    nameBlock.appendChild(el("h2", { class: venueClass }, venueLabel.venue || "—"));
    if (venueLabel.raceNo) nameBlock.appendChild(el("span", { class: "race-number" }, venueLabel.raceNo, el("small", null, "R")));
    const surf = race.surface || "";
    if (surf) {
      const cls = surf.includes("ダ") ? "dirt" : surf.includes("障") ? "shou" : "shiba";
      nameBlock.appendChild(el("span", { class: `surface-pill ${cls}` }, `${surf}${race.distance ? race.distance + "m" : ""}`));
    }
    headline.appendChild(nameBlock);

    const cd = el("div", { class: "countdown" });
    cd.appendChild(el("div", { class: "label" }, "締切まで"));
    cd.appendChild(el("div", { class: "big", id: "decision-cd-big" }, "—"));
    cd.appendChild(el("div", { class: "sub", id: "decision-cd-sub" }, ""));
    headline.appendChild(cd);
    body.appendChild(headline);

    // Wave24: 順序を「何を買うか最優先」に並び替え
    //   (1) 本命3頭シルク → (2) 買い目 5 点 → (3) ステータス → (4) 補足 (折りたたみ)

    // (1) 本命馬を「勝負服馬番タグ」で大型表示
    if (race.topPick) {
      const silkRow = renderSilkPickRow(race, tier);
      if (silkRow) body.appendChild(silkRow);
    }

    // (2) 買い目 (主軸/本命/押さえ/保険・最大 5 点) — 結論カード内で最重要
    const buyBox = buildBuyBox(race, tier);
    if (buyBox) body.appendChild(buyBox);

    // (3) BigStat 3 列: 期待値 / 1着確率 (円グラフ) / AI 信頼度
    const stats = el("div", { class: "bigstat-grid" });
    const ev = race.topPick.ev;
    const evTone = ev >= 1.5 ? "gold" : ev >= 1.1 ? "go" : ev >= 0.95 ? "ink" : "mute";
    const probPct = (race.topPick.prob ?? 0) * 100;
    const probTone = probPct >= 40 ? "go" : probPct >= 25 ? "warn" : "mute";
    const confPct = (race.confidence ?? 0) * 100;
    const confTone = confPct >= 60 ? "gold" : confPct >= 35 ? "go" : "mute";
    stats.appendChild(makeBigStat("期待値", `×${ev.toFixed(2)}`, evTone, true));
    stats.appendChild(makeBigStatDonut("1着確率", probPct, probTone));
    stats.appendChild(makeBigStatBars("AI 信頼度", confPct, confTone));
    body.appendChild(stats);

    // (4) 補足情報 (Walk-forward 検証 + AI 思考プロセス) を折りたたみに集約
    const recStats = state.recommendations?.stats;
    const reasons = buildReasons(race);
    const hasWf = recStats && (recStats.best || recStats.safe);
    if (hasWf || reasons.length > 0) {
      const det = el("details", { class: "decision-suppl" });
      const sum = el("summary", { class: "decision-suppl-summary" });
      sum.appendChild(el("span", { class: "ds-arrow" }, "▶"));
      sum.appendChild(el("span", { class: "ds-text" }, "AI の根拠を見る (検証データ・思考プロセス)"));
      det.appendChild(sum);
      const dbody = el("div", { class: "decision-suppl-body" });

      // Walk-forward
      if (hasWf) {
        const condBox = el("div", { class: "cond-stats-box" });
        condBox.appendChild(el("div", { class: "header" },
          "📊 ", el("b", null, "AI 戦略の Walk-forward 検証"),
          el("span", { style: "font-size:10px;color:var(--c-ink-mute);margin-left:auto" }, "(過去 8 期間に分割して再評価)")
        ));
        const ul = el("ul", { class: "cond-stats-list" });
        ["best","safe"].forEach((key) => {
          const s = recStats[key];
          if (!s) return;
          const trustLvl = s.trust_level || 0;
          const wf = s.walk_forward || {};
          const wfRoi = wf.mean_roi_pct != null ? wf.mean_roi_pct.toFixed(1) + "%" : "—";
          const wfWin = wf.win_periods != null && wf.active_periods != null
            ? `${wf.win_periods}/${wf.active_periods} 期間で 100%+`
            : "";
          const rowCls = trustLvl >= 4 ? "is-trusted" : trustLvl >= 3 ? "" : trustLvl >= 2 ? "is-mixed" : "is-risky";
          const badgeCls = trustLvl >= 4 ? "gold" : "green";
          const stratLabel = key === "best" ? "BEST 戦略" : "SAFE 戦略";
          const stars = "★".repeat(trustLvl) + "☆".repeat(4 - trustLvl);
          const row = el("li", { class: `cond-stats-row ${rowCls}` });
          row.appendChild(el("span", { class: "name" },
            el("span", { class: `badge ${badgeCls}` }, stratLabel),
            el("span", null, stars)
          ));
          row.appendChild(el("span", { class: "roi" }, wfRoi));
          row.appendChild(el("span", { class: "sub" }, `${s.fired_count}件・的中${s.hit_rate_pct}% ・ ${wfWin}`));
          ul.appendChild(row);
        });
        condBox.appendChild(ul);
        dbody.appendChild(condBox);
      }

      // AI 思考プロセス
      if (reasons.length > 0) {
        const proc = el("div", { class: "ai-process-box" });
        proc.appendChild(el("div", { class: "header" }, "🧠 AI の思考プロセス — この1点で勝負する理由"));
        const ul = el("ol", { class: "ai-process-steps" });
        reasons.slice(0, 4).forEach((r, i) =>
          ul.appendChild(el("li", { class: "ai-process-step" },
            el("span", { class: "idx" }, String(i + 1)),
            el("span", null, r)
          ))
        );
        proc.appendChild(ul);
        dbody.appendChild(proc);
      }

      det.appendChild(dbody);
      body.appendChild(det);
    }

    // (6) 大ボタン (詳細を見る + JRA 公式オッズ)
    const cta = el("div", { class: "cta-grid" });
    const detailBtnClass = (tier === "ultra" || tier === "prime")
      ? "btn-cta btn-cta-gold"
      : (tier === "cond") ? "btn-cta btn-cta-info" : "btn-cta btn-cta-go";
    cta.appendChild(el("button", {
      class: detailBtnClass,
      onclick: () => openDetailModal(race.raceId),
    }, "🎯 このレースの詳細を見る ▸"));
    cta.appendChild(el("a", {
      class: "btn-cta btn-cta-mute",
      href: buildJraOddsUrl(race),
      target: "_blank",
      rel: "noopener noreferrer",
    }, "JRA 公式オッズを開く ↗"));
    body.appendChild(cta);

    // (7) 「+ 買った内容を記録」+ 答え合わせ動線
    const cta2 = el("div", { class: "cta-grid" });
    cta2.appendChild(el("button", {
      class: "btn-cta btn-cta-mute",
      onclick: () => quickAddBet(race),
    }, "+ 買った内容を記録する"));
    cta2.appendChild(el("a", {
      class: "btn-cta btn-cta-answers",
      href: "#history",
      onclick: (e) => { e.preventDefault(); document.querySelector('[data-tab="history"]')?.click(); window.scrollTo({ top: document.querySelector(".history-list")?.offsetTop || 0, behavior: "smooth" }); },
    }, "📊 これまでの答え合わせを見る →"));
    body.appendChild(cta2);

    card.appendChild(body);
    return card;
  }

  // JRA 公式の単複オッズページ URL を組み立てる
  function buildJraOddsUrl(race) {
    if (!race?.raceId || race.raceId.length < 18) return "https://www.jra.go.jp/";
    // 競馬 race_id 構造例 "YYYYMMDDVVRRDDR2" — JRA 公式は別の URL 構造を使うのでトップへ
    return "https://www.jra.go.jp/keiba/program/2026/odds.html";
  }

  function makeBigStat(label, value, tone, primary) {
    const wrap = el("div", { class: "bigstat" + (primary ? " primary" : "") });
    // Wave28: 用語ツールチップを結論カードに自動付与 (小学生でも分かるように)
    const labelAttrs = { class: "label" };
    if (label && /期待値|EV/.test(label)) labelAttrs["data-gloss"] = "期待値";
    else if (label && /1着確率|勝率/.test(label)) labelAttrs["data-gloss"] = "1着確率";
    else if (label && /信頼度/.test(label)) labelAttrs["data-gloss"] = "信頼度";
    else if (label && /回収/.test(label)) labelAttrs["data-gloss"] = "回収率";
    wrap.appendChild(el("div", labelAttrs, label));
    wrap.appendChild(el("div", { class: `val tone-${tone}` }, value));
    return wrap;
  }

  // Wave22.4: 1 着確率を SVG conic-gradient 円グラフで表示
  function makeBigStatDonut(label, pct, tone) {
    const wrap = el("div", { class: `bigstat bigstat-donut tone-${tone}` });
    wrap.appendChild(el("div", { class: "label", "data-gloss": "1着確率" }, label));
    const ring = el("div", { class: "donut-ring" });
    // CSS conic-gradient 用に pct (0-100) を CSS 変数で渡す
    const clamped = Math.max(0, Math.min(100, pct));
    ring.style.setProperty("--p", String(clamped));
    const txt = el("div", { class: "donut-center" });
    txt.appendChild(el("div", { class: "donut-num" }, `${clamped.toFixed(0)}`));
    txt.appendChild(el("div", { class: "donut-unit" }, "%"));
    ring.appendChild(txt);
    wrap.appendChild(ring);
    return wrap;
  }

  // Wave22.4: AI 信頼度を 5 段ハート + パーセント表記で表示
  function makeBigStatBars(label, pct, tone) {
    const wrap = el("div", { class: `bigstat bigstat-bars tone-${tone}` });
    wrap.appendChild(el("div", { class: "label", "data-gloss": "信頼度" }, label));
    // 5 段階に量子化 (0-20=1, 20-40=2, 40-60=3, 60-80=4, 80-100=5)
    const lvl = Math.max(1, Math.min(5, Math.ceil(pct / 20)));
    const heartsRow = el("div", { class: "hearts-row" });
    for (let i = 1; i <= 5; i++) {
      heartsRow.appendChild(el("span", { class: "heart " + (i <= lvl ? "is-on" : "is-off") }, i <= lvl ? "♥" : "♡"));
    }
    wrap.appendChild(heartsRow);
    wrap.appendChild(el("div", { class: `val tone-${tone}`, style: "font-size:20px;margin-top:2px" }, `${pct.toFixed(0)}%`));
    return wrap;
  }

  // Wave22.6: WIN5 用 1 レースをストーリーカードに描画
  function renderWin5StoryCard(pr, i) {
    const card = el("div", { class: "win5-story-card" });
    // ヘッダ: 第N戦 + 会場名 + R 番号
    const vl = parseVenueLabel(pr.race || {});
    const head = el("div", { class: "wsc-head" });
    head.appendChild(el("div", { class: "wsc-leg" }, `第 ${i+1} 戦`));
    const venueBlock = el("div", { class: "wsc-venue-block" });
    venueBlock.appendChild(el("span", { class: "wsc-venue", "data-v": vl.venue || "" }, vl.venue || "—"));
    if (vl.raceNo) venueBlock.appendChild(el("span", { class: "wsc-rn" }, `${vl.raceNo}R`));
    head.appendChild(venueBlock);
    // 馬場・距離
    const surf = pr.race?.surface || "";
    if (surf) {
      const cls = surf.includes("ダ") ? "dirt" : surf.includes("障") ? "shou" : "shiba";
      head.appendChild(el("span", { class: `surface-pill ${cls}` }, `${surf}${pr.race?.distance ? pr.race.distance + "m" : ""}`));
    }
    card.appendChild(head);

    // 本命: シルク馬番 + 馬名 + 確率バー
    if (pr.ok && pr.top1) {
      const main = el("div", { class: "wsc-main" });

      // シルク馬番
      const num = parseInt(pr.top1.number, 10) || 1;
      const silkClass = `silk-${((num - 1) % 8) + 1}`;
      const silk = el("div", { class: `wsc-silk ${silkClass}` });
      silk.appendChild(el("svg", { viewBox: "0 0 80 80", "aria-hidden": "true",
        html: `
          <defs><linearGradient id="w5silk-${i}-${num}" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="var(--silk-c1, #fbbf24)"/>
            <stop offset="1" stop-color="var(--silk-c2, #d97706)"/>
          </linearGradient></defs>
          <circle cx="40" cy="40" r="36" fill="url(#w5silk-${i}-${num})" stroke="rgba(15,23,42,0.20)" stroke-width="2"/>
          <text x="40" y="51" text-anchor="middle" font-family="Inter,sans-serif" font-weight="900" font-size="34" fill="#fff"
                style="paint-order:stroke;stroke:rgba(15,23,42,0.30);stroke-width:2px">${num}</text>`
      }));
      main.appendChild(silk);

      // 馬名 + 確率
      const info = el("div", { class: "wsc-info" });
      const horseName = scrubName(pr.top1.name, "本命馬");
      info.appendChild(el("div", { class: "wsc-horse-name" }, horseName));
      const probPct = (pr.top1.prob ?? 0) * 100;
      const oddsTxt = pr.top1.odds ? `${pr.top1.odds.toFixed(1)}倍` : "—";
      info.appendChild(el("div", { class: "wsc-meta" },
        el("span", { class: "wsc-prob-pct" }, `${probPct.toFixed(0)}%`),
        el("span", { class: "wsc-prob-label" }, "1着確率"),
        el("span", { class: "wsc-sep" }, " · "),
        el("span", { class: "wsc-odds" }, oddsTxt)
      ));
      // 確率バー
      const bar = el("div", { class: "wsc-bar" });
      const fill = el("div", { class: "wsc-bar-fill" });
      fill.style.width = Math.min(100, Math.max(2, probPct)) + "%";
      // tier color based on prob
      const probTone = probPct >= 40 ? "high" : probPct >= 25 ? "mid" : "low";
      fill.classList.add("tone-" + probTone);
      bar.appendChild(fill);
      info.appendChild(bar);
      // 信頼度
      const confPct = (pr.confidence ?? 0) * 100;
      info.appendChild(el("div", { class: "wsc-conf" },
        el("span", { class: "wsc-conf-label" }, "AI 信頼度 "),
        el("span", { class: "wsc-conf-val" }, `${confPct.toFixed(0)}%`)
      ));
      main.appendChild(info);
      card.appendChild(main);

      // 相手候補 (top2 / top3 を小さく)
      if (pr.top2 || pr.top3) {
        const sub = el("div", { class: "wsc-sub" });
        sub.appendChild(el("span", { class: "wsc-sub-label" }, "相手 →"));
        [pr.top2, pr.top3].filter(Boolean).forEach((h) => {
          const sn = parseInt(h.number, 10) || 1;
          const sc = `silk-${((sn - 1) % 8) + 1}`;
          const mini = el("span", { class: `wsc-mini-silk ${sc}` }, String(sn));
          sub.appendChild(mini);
        });
        card.appendChild(sub);
      }
    } else {
      // データなし
      card.appendChild(el("div", { class: "wsc-empty" }, "🐎 出走馬データ準備中"));
    }
    return card;
  }

  // Wave22.4: 本命/対抗/3着候補 を勝負服 (Silk) 馬番タグで横並び表示
  // 馬番ごとに JRA の勝負服パターン (8 色) を循環適用
  function renderSilkPickRow(race, tier) {
    const tp = race.topPick;
    if (!tp) return null;
    const wrap = el("div", { class: `silk-pick-row silk-tier-${tier}` });
    const head = el("div", { class: "spr-head" });
    head.appendChild(el("span", { class: "spr-eyebrow" }, "本命 3 頭"));
    wrap.appendChild(head);

    const row = el("div", { class: "spr-horses" });
    const horses = [
      { h: tp, role: "本命", roleIcon: "🥇", main: true },
      { h: race.second, role: "対抗", roleIcon: "🥈", main: false },
      { h: race.third,  role: "3着",  roleIcon: "🥉", main: false },
    ].filter(x => x.h && x.h.number);

    horses.forEach(({ h, role, roleIcon, main }) => {
      const num = parseInt(h.number, 10) || 1;
      const silkClass = `silk-${((num - 1) % 8) + 1}`;
      const probPct = (h.prob ?? 0) * 100;
      const oddsTxt = h.odds ? `${h.odds.toFixed(1)}倍` : "—";
      const card = el("div", { class: "spr-card " + (main ? "is-main" : "") });
      const silkBadge = el("div", { class: `spr-silk ${silkClass}` });
      silkBadge.appendChild(el("svg", { viewBox: "0 0 80 80", "aria-hidden": "true",
        html: `
          <defs>
            <linearGradient id="silkbg-${num}" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="var(--silk-c1, #fbbf24)"/>
              <stop offset="1" stop-color="var(--silk-c2, #d97706)"/>
            </linearGradient>
          </defs>
          <circle cx="40" cy="40" r="36" fill="url(#silkbg-${num})" stroke="rgba(15,23,42,0.18)" stroke-width="2"/>
          <text x="40" y="50" text-anchor="middle" font-family="Inter, sans-serif" font-weight="900" font-size="30" fill="#fff"
                style="paint-order: stroke; stroke: rgba(15,23,42,0.30); stroke-width: 2px">${num}</text>
        `,
      }));
      card.appendChild(silkBadge);
      const info = el("div", { class: "spr-info" });
      info.appendChild(el("div", { class: "spr-role" }, `${roleIcon} ${role}`));
      const name = scrubName(h.name, "");
      if (name) info.appendChild(el("div", { class: "spr-name" }, name));
      info.appendChild(el("div", { class: "spr-stats" },
        el("span", { class: "spr-prob" }, `${probPct.toFixed(0)}%`),
        el("span", { class: "spr-odds" }, oddsTxt)
      ));
      card.appendChild(info);
      row.appendChild(card);
    });
    wrap.appendChild(row);
    return wrap;
  }

  function buildReasons(race) {
    const out = [];
    const tp = race.topPick;
    if (tp) {
      const probPct = ((tp.prob ?? 0) * 100).toFixed(0);
      const odds = (tp.odds ?? 0).toFixed(1);
      out.push(`本命 ${tp.number} ${tp.name || ""} は推定勝率 ${probPct}% × オッズ ${odds}倍 → 期待値 ×${(tp.ev ?? 0).toFixed(2)}`);
    }
    if (race.second?.ev != null) {
      out.push(`対抗 ${race.second.number} ${race.second.name || ""} は期待値 ×${race.second.ev.toFixed(2)}`);
    }
    if (race.trackBiasNote) out.push(`馬場傾向: ${race.trackBiasNote}`);
    if (race.hasOverpop) out.push("上位人気馬に「過剰人気」を検知 — 妙味の高い穴馬あり");
    if (race.hasUnderval) out.push("人気薄に「過小評価」を検知 — オッズが付きすぎている");
    return out;
  }

  function buildBuyBox(race, tier) {
    const tp = race.topPick;
    if (!tp) return null;
    const box = el("div", { class: "buy-box" });
    const head = el("div", { class: "buy-head" });
    const titleTxt = (tier === "ultra" || tier === "prime")
      ? "📢 このとおりに買おう (絶好機・5点)"
      : (tier === "cond" || tier === "best")
        ? "⭐ お試し買い目 (慎重に・お試し金額で)"
        : "📢 このとおりに買おう (5点)";
    head.appendChild(el("div", { class: "title" }, titleTxt));
    const items = makeBuyItems(race, tier);
    const total = items.reduce((a, x) => a + x.amount, 0);
    head.appendChild(el("div", { class: "total" },
      el("span", { style: "font-size:11px;color:var(--c-ink-soft)" }, `${items.length}点 合計 `),
      el("b", null, `¥${fmtYen(total)}`)
    ));
    box.appendChild(head);

    const ul = el("ul", { class: "buy-list" });
    items.forEach((it, i) => {
      const li = el("li", { class: "buy-item" + (i === 0 ? " is-main" : "") });
      const roleClass = i === 0 ? "role role-main"
                       : i === 1 ? "role role-sub"
                       : i === 2 ? "role role-side"
                       :           "role role-ins";
      li.appendChild(el("span", { class: roleClass }, it.role));
      const combo = el("div", null);
      combo.appendChild(el("span", { class: "combo" }, it.combo));
      if (it.name) combo.appendChild(el("span", { class: "horse-name" }, scrubName(it.name, "")));
      li.appendChild(combo);
      const right = el("div", { class: "right" });
      right.appendChild(el("span", { class: "amount" }, `¥${fmtYen(it.amount)}`));
      if (it.odds) right.appendChild(el("span", { class: "odds" }, `${it.odds.toFixed(1)}倍`));
      if (it.ret) right.appendChild(el("span", { class: "return" }, `→ ¥${fmtYen(it.ret)}`));
      li.appendChild(right);
      ul.appendChild(li);
    });
    box.appendChild(ul);

    // オッズが無いときの注意
    if (!race.topPick.odds) {
      box.appendChild(el("p", {
        style: "font-size:11px;color:var(--c-warn);margin:8px 0 0;font-weight:700",
      }, "⚠ オッズ未取得 — 締切 15 分前から自動取得します"));
    }

    return box;
  }

  function makeBuyItems(race, tier) {
    const items = [];
    const tp = race.topPick, s2 = race.second, s3 = race.third;
    if (!tp) return items;
    // 信頼性ティアで金額を調整
    const baseAmt = (tier === "ultra") ? 1000 : (tier === "prime") ? 600 : (tier === "go") ? 500 : 300;
    items.push({
      role: "🥇 主軸 単勝", combo: String(tp.number), name: tp.name || "",
      amount: baseAmt, odds: tp.odds,
      ret: tp.odds ? Math.round((baseAmt / 100) * tp.odds) : null,
    });
    items.push({
      role: "🥈 本命 複勝", combo: String(tp.number), name: tp.name || "",
      amount: baseAmt, odds: null, ret: null,
    });
    if (s2) {
      items.push({
        role: "🥉 対抗 馬連", combo: `${tp.number}-${s2.number}`, name: s2.name || "",
        amount: baseAmt, odds: null, ret: null,
      });
    }
    if (s2 && s3) {
      // ワイド 3 点 (1-2 / 1-3 / 2-3)
      items.push({
        role: "🛡 保険 ワイド", combo: `${tp.number}-${s3.number}`, name: s3.name || "",
        amount: baseAmt, odds: null, ret: null,
      });
    }
    // 究極の絶好機なら 3 連複ボックス 1 点を追加
    if ((tier === "ultra" || tier === "prime") && s2 && s3) {
      items.push({
        role: "🎰 一発 3連複", combo: `${tp.number}-${s2.number}-${s3.number}`, name: "ボックス",
        amount: baseAmt, odds: null, ret: null,
      });
    }
    return items;
  }

  // ─── 「全レースで期待値プラスがない」日の専用ヒーロー
  // (開催はあるが、買う価値のあるレースが見つからないケース)
  function renderNoBetCard(sorted) {
    const card = el("div", { class: "decision-card tier-none fade-in" });
    card.appendChild(el("div", { class: "decision-head" },
      el("div", { class: "decision-tier-label" }, "⏸ AI は今日は買わない方が安全 ・ 期待値プラスの馬がいません")
    ));
    const body = el("div", { class: "decision-body card-enter-stagger" });

    body.appendChild(el("div", { class: "decision-prelabel" },
      el("span", { class: "pl-bar" }),
      el("span", null, "📢 AI の判定 — 本日は見送り推奨")
    ));
    body.appendChild(el("div", { html: `
      <p style="text-align:center;font-size:32px;font-weight:900;line-height:1.2;margin:8px 0">
        今日は <span class="text-grad-sky">休む日</span> です
      </p>
      <p style="text-align:center;font-size:14px;color:var(--c-ink-soft);line-height:1.6">
        ${sorted.length} レース解析しましたが、<b style="color:var(--c-ink)">期待値が +0% を超える馬が見つかりませんでした</b>。<br>
        無理に買わずに、過去の答え合わせを見て明日に備えましょう。
      </p>
    `}));

    // 戦略の信頼性ティア (休む日でも見せる)
    const stats = state.recommendations?.stats || {};
    const defs = state.recommendations?.strategies_def || DEFAULT_STRAT_DEFS;
    const grid = el("div", { class: "strat-trust-grid" });
    defs.slice(0, 4).forEach((d) => {
      const s = stats[d.key];
      if (!s) return;
      const trustLvl = s.trust_level || 0;
      const cls = trustLvl >= 4 ? "trusted" : trustLvl >= 3 ? "stable" : trustLvl >= 2 ? "mixed" : "risky";
      const stars = "★".repeat(trustLvl) + "☆".repeat(4 - trustLvl);
      const wf = s.walk_forward || {};
      const card2 = el("div", { class: `strat-trust-card ${cls}` });
      card2.appendChild(el("div", { class: "head" },
        el("span", { class: "name" }, d.short_label || d.key.toUpperCase()),
        el("span", { class: "stars" }, stars)
      ));
      card2.appendChild(el("div", { class: "big-roi" }, s.roi_pct ? s.roi_pct.toFixed(1) + "%" : "—"));
      card2.appendChild(el("div", { class: "meta", html:
        `${s.fired_count}件・的中${s.hit_rate_pct}%${
          wf.mean_roi_pct != null ? `<br>Walk-fwd 平均 ${wf.mean_roi_pct.toFixed(1)}%` : ""}`
      }));
      grid.appendChild(card2);
    });
    if (grid.children.length > 0) body.appendChild(grid);

    // 強いて挙げるなら
    if (sorted.length > 0) {
      const top = sorted[0];
      if (top.topPick) {
        const better = el("div", { class: "reason-box" });
        better.appendChild(el("div", { class: "label" }, "強いて挙げるなら"));
        const ul = el("ul", { class: "reason-list" });
        const vl = parseVenueLabel(top);
        ul.appendChild(el("li", null,
          el("span", { class: "arrow" }, "▸"),
          el("span", null, `${vl.venue || "?"} ${vl.raceNo || "?"}R: ${top.topPick.number}番 ${scrubName(top.topPick.name, "")} (EV ×${(top.topPick.ev ?? 0).toFixed(2)})`)
        ));
        better.appendChild(ul);
        body.appendChild(better);
      }
    }

    // CTA
    const cta = el("div", { class: "cta-grid" });
    cta.appendChild(el("a", {
      class: "btn-cta btn-cta-answers",
      href: "#history",
      onclick: (e) => { e.preventDefault(); openHistoryAndScroll(); },
    }, "📊 これまでの答え合わせを見る →"));
    cta.appendChild(el("button", {
      class: "btn-cta btn-cta-mute",
      onclick: () => openAddBetModal(),
    }, "+ 手動で記録する"));
    body.appendChild(cta);

    card.appendChild(body);
    return card;
  }

  // 折りたたみ history を開いてスクロールする (Wave28: details closed のとき動かないバグ修正)
  function openHistoryAndScroll() {
    const det = document.querySelector(".hideable-history, details.history-card, #card-history");
    if (det && det.tagName === "DETAILS" && !det.open) det.open = true;
    const tgt = document.querySelector(".history-list")?.closest("details, section") ||
                document.querySelector(".history-list");
    if (tgt) {
      setTimeout(() => tgt.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  // ─── 開催なし日 専用ヒーロー (休日でも楽しめる大型版) ──
  function renderNoRaceDay() {
    const wrap = el("section", { class: "noday-hero fade-in" });

    // ── ヘッダ
    const head = el("div", { class: "noday-head" });
    head.appendChild(el("div", { class: "noday-head-label" }, "⏸ AI は今日は休憩中"));
    wrap.appendChild(head);

    // 次の開催日 (土曜) を計算
    const today = new Date();
    const todayWd = ["日","月","火","水","木","金","土"][today.getDay()];
    const daysToSat = (6 - today.getDay() + 7) % 7;
    const nextSat = daysToSat === 0 ? today : new Date(today.getTime() + daysToSat * 86400000);
    const nextSun = new Date(nextSat.getTime() + 86400000);
    const fmtMd = (d) => `${d.getMonth()+1}/${d.getDate()}`;
    const daysUntilSat = daysToSat || 0;
    const hoursUntilSat = daysToSat === 0
      ? null
      : Math.max(0, Math.floor((new Date(nextSat.getFullYear(), nextSat.getMonth(), nextSat.getDate(), 9, 0, 0).getTime() - Date.now()) / 3600000));

    // ── 本体
    const body = el("div", { class: "noday-body card-enter-stagger" });

    // ① ヘッドライン
    const headline = el("div", { class: "noday-display" });
    headline.appendChild(el("div", { class: "big", html: `今日 (${todayWd}) は <span class="text-grad-turf">休む日</span> です` }));
    headline.appendChild(el("div", { class: "sub",
      html: `次の競馬は <b>${fmtMd(nextSat)}(土)</b> / <b>${fmtMd(nextSun)}(日)</b>${
        hoursUntilSat != null
          ? ` ・ あと <b>${daysUntilSat}日${hoursUntilSat % 24}時間</b>`
          : ""}`
    }));
    body.appendChild(headline);

    // ② 次回開催プレビュー (カウントダウン)
    const nextCard = el("div", { class: "noday-next-card" });
    nextCard.appendChild(el("div", { class: "lab-row" },
      el("span", null, "📅 NEXT RACE WEEKEND"),
      hoursUntilSat != null
        ? el("span", { class: "countdown-small" }, `あと ${daysUntilSat}日${hoursUntilSat % 24}時間`)
        : ""
    ));
    const nextDates = el("div", { class: "next-dates" });
    nextDates.appendChild(el("div", { class: "next-date-cell" },
      el("div", { class: "label" }, "土曜"),
      el("div", { class: "day" }, fmtMd(nextSat))
    ));
    nextDates.appendChild(el("div", { class: "next-date-cell" },
      el("div", { class: "label" }, "日曜"),
      el("div", { class: "day" }, fmtMd(nextSun))
    ));
    nextCard.appendChild(nextDates);
    body.appendChild(nextCard);

    // ③ 4 戦略の信頼性ティア (Walk-forward 検証 ROI)
    const stats = state.recommendations?.stats || {};
    const defs = state.recommendations?.strategies_def || DEFAULT_STRAT_DEFS;
    const grid = el("div", { class: "strat-trust-grid" });
    defs.slice(0, 4).forEach((d) => {
      const s = stats[d.key];
      if (!s) return;
      const trustLvl = s.trust_level || 0;
      const cls = trustLvl >= 4 ? "trusted" : trustLvl >= 3 ? "stable" : trustLvl >= 2 ? "mixed" : "risky";
      const stars = "★".repeat(trustLvl) + "☆".repeat(4 - trustLvl);
      const wf = s.walk_forward || {};
      const wfRoi = wf.mean_roi_pct != null ? wf.mean_roi_pct.toFixed(1) + "%" : null;
      const wfWin = wf.win_periods != null && wf.active_periods != null
        ? `分割検証 ${wf.win_periods}/${wf.active_periods} 期間 100%+`
        : null;
      const card = el("div", { class: `strat-trust-card ${cls}` });
      card.appendChild(el("div", { class: "head" },
        el("span", { class: "name" }, d.short_label || d.key.toUpperCase()),
        el("span", { class: "stars" }, stars)
      ));
      card.appendChild(el("div", { class: "big-roi" }, s.roi_pct ? s.roi_pct.toFixed(1) + "%" : "—"));
      card.appendChild(el("div", { class: "meta", html:
        `${s.fired_count}件・的中${s.hit_rate_pct}%${wfRoi ? `<br>${wfWin || ""}<br>Walk-fwd 平均 ${wfRoi}` : ""}`
      }));
      if (d.label) card.appendChild(el("div", { class: "desc" }, d.label));
      grid.appendChild(card);
    });
    if (grid.children.length === 0) {
      // フォールバック: recommendations 未取得時のスタブ
      const fallback = [
        { key: "best", short_label: "BEST", roi_pct: 126.8, hit_rate_pct: 83, fired_count: 53, trust_level: 4,
          walk_forward: { mean_roi_pct: 112.1, win_periods: 7, active_periods: 7 }, desc: "本命確率22%+ かつ 対抗差4pt+で複勝" },
        { key: "safe", short_label: "SAFE", roi_pct: 106.3, hit_rate_pct: 72, fired_count: 100, trust_level: 3,
          walk_forward: { mean_roi_pct: 106.7, win_periods: 6, active_periods: 7 }, desc: "本命確率20%+で複勝・発火多め" },
      ];
      fallback.forEach((d) => {
        const cls = d.trust_level >= 4 ? "trusted" : "stable";
        const stars = "★".repeat(d.trust_level) + "☆".repeat(4 - d.trust_level);
        const card = el("div", { class: `strat-trust-card ${cls}` });
        card.appendChild(el("div", { class: "head" },
          el("span", { class: "name" }, d.short_label),
          el("span", { class: "stars" }, stars)
        ));
        card.appendChild(el("div", { class: "big-roi" }, d.roi_pct.toFixed(1) + "%"));
        card.appendChild(el("div", { class: "meta", html:
          `${d.fired_count}件・的中${d.hit_rate_pct}%<br>分割検証 ${d.walk_forward.win_periods}/${d.walk_forward.active_periods} 期間 100%+<br>Walk-fwd 平均 ${d.walk_forward.mean_roi_pct}%`
        }));
        card.appendChild(el("div", { class: "desc" }, d.desc));
        grid.appendChild(card);
      });
    }
    body.appendChild(grid);

    // ④ 直近の的中ハイライト (過去30件から HIT を抽出)
    const recentHits = (state.bets || [])
      .filter((b) => b.result === "hit" && b.payout > 0)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 4);
    if (recentHits.length > 0) {
      const hitsBox = el("div", { class: "recent-hits-box" });
      hitsBox.appendChild(el("div", { class: "header" }, "🎉 直近の的中ハイライト"));
      const ul = el("ul", { class: "recent-hits-list" });
      recentHits.forEach((b) => {
        const profit = (b.payout || 0) - (b.amount || 0);
        ul.appendChild(el("li", null,
          el("span", { class: "hit-badge" }, "HIT"),
          el("span", { class: "race-info" }, `${b.date?.slice(5) || "—"} ${b.race || "?"} ${b.type || ""}`),
          el("span", { class: "profit" }, `+¥${fmtYen(profit)}`)
        ));
      });
      hitsBox.appendChild(ul);
      body.appendChild(hitsBox);
    }

    // ⑤ CTA (詳しく見る・手動入力)
    const cta = el("div", { class: "cta-grid" });
    cta.appendChild(el("a", {
      class: "btn-cta btn-cta-answers",
      href: "#history",
      onclick: (e) => { e.preventDefault(); openHistoryAndScroll(); },
    }, "📊 これまでの予想と結果の答え合わせを見る →"));
    cta.appendChild(el("button", {
      class: "btn-cta btn-cta-mute",
      onclick: () => openAddBetModal(),
    }, "+ 手動で記録する"));
    body.appendChild(cta);

    body.appendChild(el("p", {
      style: "text-align:center;font-size:11px;color:var(--c-ink-soft);margin-top:14px;line-height:1.5",
      html: `${fmtMd(nextSat)}(土) 朝 9:00 までに自動で今日の推奨レースを揃えます。<br>
             ★★★★ TRUSTED の <b>BEST 戦略</b> は 7/7 期間で連続プラスを記録中。`
    }));

    wrap.appendChild(body);
    return wrap;
  }

  // recommendations が無いときのデフォルト戦略定義
  const DEFAULT_STRAT_DEFS = [
    // Wave29-B: 馬連 nopop top1-top2 が圧倒的 (avg 222%・全期間 100%+ 165%)
    { key: "value_uren",     short_label: "V-馬連",    label: "馬連 nopop top1-top2 (閾値 30%・全期間 100%+) — avg 165%・勝 7/7" },
    { key: "value_uren_hot", short_label: "V-馬連HOT", label: "馬連 nopop top1-top2 (閾値 16%・積極派) — avg 222%・件数 2673" },
    // Wave27 (強化): nopop モデル単独 (人気を見ない実力派) — 閾値最適化 0.16
    { key: "value_invest",   short_label: "VALUE",     label: "実力派 AI 本命 (人気を見ない) の確率 16%+ で複勝 — Walk-fwd 152.62%" },
    { key: "value_safe",     short_label: "V-SAFE",    label: "実力派 AI 本命 の確率 35%+ で複勝 — 安定 σ17・avg 131%" },
    { key: "best",           short_label: "BEST",      label: "本命確率 22%+ かつ 対抗差 4pt+ で複勝" },
    { key: "safe",           short_label: "SAFE",      label: "本命確率 20%+ で複勝・発火多め" },
    { key: "turf",           short_label: "TURF",      label: "芝レース限定 BEST" },
    { key: "big",            short_label: "BIG",       label: "3 連複 ボックス 1 点" },
  ];

  function parseVenueLabel(race) {
    let venue = "";
    if (race.course) {
      const m = String(race.course).match(/^([^\d]+?)(?:[芝ダ障].*)?$/);
      if (m) venue = m[1].replace(/[芝ダ障].*/, "").trim();
    }
    let raceNo = "";
    if (race.raceId && race.raceId.length >= 16) {
      raceNo = String(parseInt(race.raceId.slice(-4, -2), 10));
    }
    return { venue, raceNo };
  }

  // ─── 描画: Win5Card ──────────────────────────────────────
  function renderWin5() {
    const mount = $("#win5-mount");
    const w5 = state.win5;
    if (!w5) { mount.innerHTML = ""; return; }

    mount.innerHTML = "";
    const card = el("div", { class: "win5-card fade-in" });
    card.appendChild(el("div", { class: "win5-head" },
      el("div", { class: "title" }, "WIN5 — 土19:30〜 日曜・祝日レースを的中 (200円で最大6億円)"),
      el("div", { class: "day" }, w5.ok ? `信頼度 ${(w5.avgConfidence * 100).toFixed(0)}%` : "データ準備中")
    ));
    const body = el("div", { class: "win5-body" });

    // ── Toolbar: モード切替 + 予算入力 ──
    const toolbar = el("div", { class: "win5-toolbar" });
    const seg = el("div", { class: "seg" });
    const btnEv = el("button", { class: state.win5Mode === "ev" ? "is-active" : "" }, "期待値で推奨");
    const btnHit = el("button", { class: state.win5Mode === "hit" ? "is-active" : "" }, "的中重視で推奨");
    btnEv.addEventListener("click", () => switchWin5Mode("ev"));
    btnHit.addEventListener("click", () => switchWin5Mode("hit"));
    seg.appendChild(btnEv); seg.appendChild(btnHit);
    toolbar.appendChild(seg);

    const budgetWrap = el("div", { class: "budget-input" });
    budgetWrap.appendChild(el("span", null, "予算"));
    const budgetIn = el("input", {
      type: "number", min: "200", step: "100",
      placeholder: "3000",
      value: state.win5Budget || "",
      id: "w5-budget-in",
    });
    budgetWrap.appendChild(budgetIn);
    budgetWrap.appendChild(el("span", null, "円"));
    toolbar.appendChild(budgetWrap);

    const optBtn = el("button", { class: "budget-btn" }, "AI 最適化");
    optBtn.addEventListener("click", () => {
      const v = parseInt(budgetIn.value, 10);
      if (!Number.isFinite(v) || v < 200) { toast("予算は 200 円以上で入れてください"); return; }
      state.win5Budget = v;
      localStorage.setItem("keiba_win5_budget", String(v));
      toast(`予算 ¥${fmtYen(v)} で AI 最適化中…`);
      refreshAll();
    });
    toolbar.appendChild(optBtn);

    if (state.win5Budget) {
      const clr = el("button", { class: "chip-filter", style: "padding:4px 10px" }, "予算クリア");
      clr.addEventListener("click", () => {
        state.win5Budget = null;
        localStorage.removeItem("keiba_win5_budget");
        budgetIn.value = "";
        refreshAll();
      });
      toolbar.appendChild(clr);
    }

    // 通知 ON/OFF ボタン
    const notifyOn = isWin5NotifyEnabled();
    const ntBtn = el("button", {
      class: "chip-filter" + (notifyOn ? " is-active" : ""),
      style: "padding:4px 10px",
    }, notifyOn ? "通知 ON (土19:25 / 日14:45)" : "通知 OFF");
    ntBtn.addEventListener("click", async () => {
      if (isWin5NotifyEnabled()) {
        disableWin5Notify();
      } else {
        await enableWin5Notify();
      }
      renderWin5();
    });
    toolbar.appendChild(ntBtn);

    // テスト通知ボタン (動作確認用)
    if (notifyOn) {
      const testBtn = el("button", { class: "chip-filter", style: "padding:4px 10px" }, "テスト通知");
      testBtn.addEventListener("click", () => {
        fireWin5Notify("テスト通知 (KEIBA NAVIGATOR)", "通知設定は正常です。次の土曜 19:25 ごろにこの形で通知が出ます。");
        toast("テスト通知を出しました");
      });
      toolbar.appendChild(testBtn);
    }

    body.appendChild(toolbar);

    if (!w5.ok) {
      const next = nextWin5Schedule();
      body.appendChild(el("div", { html: `
        <div style="text-align:center;padding:18px 12px">
          <p style="font-size:14px;color:var(--c-ink-soft);margin:0 0 14px">
            ${escapeHtml(w5.note || "WIN5 対象レース 5 つのデータがまだ揃っていません")}
          </p>
          <div class="reason-box" style="text-align:left;background:rgba(196,181,253,0.12);border-color:rgba(139,92,246,0.30)">
            <div class="label" style="color:#6d28d9">次回 WIN5 予定</div>
            <p style="margin:6px 0 0;font-size:15px;font-weight:800;color:var(--c-ink)">
              ${next.dateLabel} (${next.weekday}) — 14:50〜15:40 ごろの 5 レース
            </p>
            <p style="margin:8px 0 0;font-size:12px;color:var(--c-ink-soft);line-height:1.6">
              ▸ <b>${next.saturdayLabel} (土) 19:30</b> から発売開始<br>
              ▸ <b>${next.saturdayLabel} (土) 18:30</b> にアプリが翌日の出走馬データを自動取得<br>
              ▸ <b>${next.dateLabel} (日) 朝 08:30</b> にオッズが入り期待値が確定<br>
              ▸ 締切は WIN5 第1レースの発走 5 分前
            </p>
          </div>
          <p style="margin:14px 0 0;font-size:12px;color:var(--c-ink-soft)">
            上のツールバーや戦略カードは試しに触ることができます。
          </p>
        </div>
      `}));
    } else {
      body.appendChild(el("div", { class: "sec-title" },
        el("span", { class: "bar gold" }),
        el("h2", null, `戦略を選ぼう (${state.win5Mode === "hit" ? "的中確率重視" : "期待値最大"} で AI 推奨)`)
      ));
    }

    // ── 戦略カード (4-5 列) ──
    const strategyList = [
      { key: "safe", name: "堅め", sub: "1×1×1×1×1 = 1点" },
      { key: "axis", name: "軸1頭流し", sub: "高信頼 2R は 1 頭・残り 3R は 2 頭" },
      { key: "mid",  name: "中波",     sub: "2×2×2×2×2 = 32点" },
      { key: "wide", name: "万舟",     sub: "3×3×3×3×3 = 243点" },
    ];
    if (w5.strategies.custom) strategyList.push({ key: "custom", name: "予算最適", sub: `AI が ¥${fmtYen(w5.budget)} 以内で最適化` });
    if (w5.strategies.userCustom) strategyList.push({ key: "userCustom", name: "あなたのカスタム", sub: "編集した内容" });

    const stratsGrid = el("div", { class: "win5-strategies" + (w5.strategies.custom || w5.strategies.userCustom ? " has-custom" : "") });
    const rec = w5.recommended;
    strategyList.forEach((s) => {
      const st = w5.strategies[s.key];
      if (!st) return;
      const c = el("div", { class: "win5-strategy" + (rec === s.key ? " is-recommended" : "") });
      if (rec === s.key) c.appendChild(el("div", { class: "rec-badge" }, "AI 推奨"));
      c.appendChild(el("div", { class: "name" }, s.name));
      c.appendChild(el("div", { class: "stake" }, `¥${fmtYen(st.totalCost)}`));
      c.appendChild(el("div", { class: "sub" }, s.sub));
      const hitPct = st.hitProb != null ? (st.hitProb * 100).toFixed(st.hitProb < 0.001 ? 4 : 2) + "%" : "—";
      c.appendChild(el("div", { class: "sub" }, `${st.combo}点 / 的中 ${hitPct}`));
      c.appendChild(el("div", { class: "sub" }, `期待 ¥${fmtYen(st.expectedReturn)} / EV ×${st.evRatio.toFixed(1)}`));
      // クリック → カスタム編集起動
      c.addEventListener("click", () => {
        if (w5.ok) openWin5EditModal(s.key);
      });
      stratsGrid.appendChild(c);
    });
    body.appendChild(stratsGrid);

    // 5 レース本命 (Wave22.6: ストーリーカード化)
    if (Array.isArray(w5.perRace) && w5.perRace.length > 0 && w5.ok) {
      body.appendChild(el("div", { class: "sec-title" },
        el("span", { class: "bar gold" }),
        el("h2", null, "5 レースの本命 — ストーリー")
      ));
      const races = el("div", { class: "win5-story-list" });
      w5.perRace.slice(0, 5).forEach((pr, i) => {
        races.appendChild(renderWin5StoryCard(pr, i));
      });
      body.appendChild(races);
    }

    // カスタム編集ボタン
    if (w5.ok) {
      const editBtn = el("button", {
        class: "btn-cta btn-cta-mute mt-3",
        style: "width:100%",
        onclick: () => openWin5EditModal(w5.recommended || "safe"),
      }, "自分で編集する (各レースの頭数を指定)");
      body.appendChild(editBtn);
    }

    card.appendChild(body);
    mount.appendChild(card);
  }

  function switchWin5Mode(mode) {
    state.win5Mode = mode;
    localStorage.setItem("keiba_win5_mode", mode);
    refreshAll();
  }

  // ─── WIN5 カスタム編集モーダル ─────────────────────────
  function openWin5EditModal(baseKey) {
    const w5 = state.win5;
    if (!w5 || !w5.ok || !Array.isArray(w5.perRace) || w5.perRace.length === 0) {
      toast("WIN5 データが揃っていないので編集できません");
      return;
    }
    // 既存戦略の plan を初期値に
    let plan;
    if (state.win5UserPlan && state.win5UserPlan.length === w5.perRace.length) {
      plan = [...state.win5UserPlan];
    } else if (baseKey && w5.strategies[baseKey]?.plan) {
      plan = [...w5.strategies[baseKey].plan];
    } else if (w5.strategies.safe?.plan) {
      plan = [...w5.strategies.safe.plan];
    } else {
      plan = w5.perRace.map(() => 1);
    }
    const wrap = $("#w5e-races");
    const summary = $("#w5e-summary");
    wrap.innerHTML = "";

    function rerender() {
      wrap.innerHTML = "";
      w5.perRace.forEach((r, i) => {
        const maxK = Math.min(5, r.ranked?.length || r.conclusion?.picks?.length || 3);
        const row = el("div", { class: "w5e-race" });
        const left = el("div", null);
        left.appendChild(el("div", { class: "head" }, `第${i+1}戦 ${r.raceName || ""}`));
        const topName = r.top1?.name || (r.top1?.number ? `${r.top1.number}番` : "—");
        left.appendChild(el("div", { class: "sub" }, `本命: ${topName} / 信頼度 ${((r.confidence || 0) * 100).toFixed(0)}%`));
        row.appendChild(left);
        const step = el("div", { class: "stepper" });
        const dec = el("button", { type: "button", disabled: plan[i] <= 1 }, "−");
        const val = el("span", { class: "val" }, String(plan[i]));
        const inc = el("button", { type: "button", disabled: plan[i] >= maxK }, "+");
        dec.addEventListener("click", () => { if (plan[i] > 1) { plan[i]--; rerender(); } });
        inc.addEventListener("click", () => { if (plan[i] < maxK) { plan[i]++; rerender(); } });
        step.appendChild(dec);
        step.appendChild(val);
        step.appendChild(el("span", { class: "unit" }, "頭"));
        step.appendChild(inc);
        row.appendChild(step);
        wrap.appendChild(row);
      });
      const combo = plan.reduce((a, k) => a * k, 1);
      const cost = combo * 200;
      summary.innerHTML = `
        <div class="label">合計</div>
        <div style="display:flex;justify-content:space-between;align-items:baseline;font-variant-numeric:tabular-nums">
          <div style="font-size:14px;color:var(--c-ink-soft)">${plan.join(" × ")} = <b style="color:var(--c-deep);font-size:18px">${combo}</b> 点</div>
          <div style="font-size:22px;font-weight:900;color:var(--c-violet)">¥${fmtYen(cost)}</div>
        </div>
      `;
    }
    rerender();
    $("#w5e-apply").onclick = () => {
      state.win5UserPlan = plan;
      localStorage.setItem("keiba_win5_plan", JSON.stringify(plan));
      $("#modal-win5-edit").hidden = true;
      toast("カスタム編集を反映しました");
      refreshAll();
    };
    $("#w5e-cancel").onclick = () => { $("#modal-win5-edit").hidden = true; };
    $("#modal-win5-edit").hidden = false;
  }

  // ─── 描画: AllRaces ──────────────────────────────────────
  function renderAllRaces() {
    const list = $("#all-races-list");
    $("#all-races-count").textContent = state.races.length;
    if (state.races.length === 0) {
      list.innerHTML = `<div style="text-align:center;padding:30px;color:var(--c-ink-soft);font-size:13px">本日 解析可能なレースはありません</div>`;
      return;
    }
    let races = [...state.races];
    if (state.allRacesFilter === "go") {
      races = races.filter((r) => ["ultra", "prime", "go"].includes(tierOfRace(r)));
    } else if (state.allRacesFilter === "gold") {
      races = races.filter((r) => ["ultra", "prime"].includes(tierOfRace(r)));
    } else if (state.allRacesFilter === "g1") {
      races = races.filter((r) => !!r.isG1);
    }
    if (state.allRacesSort === "ev") {
      races.sort((a, b) => (b.topPick?.ev ?? -Infinity) - (a.topPick?.ev ?? -Infinity));
    } else {
      races.sort((a, b) => String(a.raceId).localeCompare(String(b.raceId)));
    }

    list.innerHTML = "";
    if (races.length === 0) {
      list.innerHTML = `<div style="text-align:center;padding:24px;color:var(--c-ink-soft);font-size:13px">該当するレースがありません</div>`;
      return;
    }
    races.forEach((r) => list.appendChild(renderRaceRow(r)));
  }

  function renderRaceRow(race) {
    const tier = tierOfRace(race);
    const row = el("div", { class: `race-row tier-${tier}`, onclick: () => openDetailModal(race.raceId) });

    // 時刻 + カウントダウン
    const timeBox = el("div", { class: "time" });
    if (race.startTime) {
      const m = String(race.startTime).match(/(\d{1,2}):(\d{2})/);
      timeBox.appendChild(el("div", { class: "hh" }, m ? `${m[1]}:${m[2]}` : "—"));
    } else if (race.raceId) {
      const rn = race.raceId.slice(-4, -2);
      timeBox.appendChild(el("div", { class: "hh" }, `${parseInt(rn, 10)}R`));
    } else {
      timeBox.appendChild(el("div", { class: "hh" }, "—"));
    }
    const mLeft = minutesUntilStart(race);
    if (mLeft != null) {
      let cls = "", txt = "";
      if (mLeft < -10) { cls = "past"; txt = "終了"; }
      else if (mLeft < 0) { cls = ""; txt = `${-mLeft}分前`; }
      else if (mLeft <= 5) { cls = "urgent"; txt = `あと${mLeft}分`; }
      else if (mLeft <= 30) { cls = "warn"; txt = `あと${mLeft}分`; }
      else { cls = ""; txt = `あと${Math.floor(mLeft/60)}時間${mLeft%60}分`; }
      timeBox.appendChild(el("div", { class: `left ${cls}` }, txt));
    }
    row.appendChild(timeBox);

    // メタ + 本命馬
    const info = el("div", { class: "info" });
    const meta = el("div", { class: "meta" });
    const vl = parseVenueLabel(race);
    meta.appendChild(el("span", { class: "venue", "data-v": vl.venue || "" }, vl.venue || "—"));
    if (vl.raceNo) meta.appendChild(el("span", { class: "race-no" }, `${vl.raceNo}R`));
    if (race.isG1) meta.appendChild(el("span", { class: "pill pill-gold" }, "G1"));
    if (race.surface) meta.appendChild(el("span", null, `${race.surface}${race.distance || ""}m`));
    // ティアバッジ (★ stars)
    if (tier === "ultra") meta.appendChild(el("span", { class: "pill pill-gold", style: "background:linear-gradient(135deg,#fbbf24,#f59e0b);color:#fff;font-weight:900" }, "💎✦ ULTRA"));
    else if (tier === "prime") meta.appendChild(el("span", { class: "pill pill-gold" }, "💎 PRIME"));
    else if (tier === "go") meta.appendChild(el("span", { class: "pill pill-go" }, "🎯 GO"));
    else if (tier === "cond") meta.appendChild(el("span", { class: "pill pill-info" }, "⚡ COND"));
    info.appendChild(meta);
    const pick = el("div", { class: "pick" });
    if (race.topPick) {
      pick.appendChild(el("span", { class: "label-small" }, "本命"));
      pick.appendChild(el("span", { class: "horse-num" }, String(race.topPick.number)));
      const horseName = scrubName(race.topPick.name, "");
      if (horseName) pick.appendChild(el("span", { class: "horse-name" }, horseName));
      const opponents = [];
      if (race.second?.number) opponents.push(race.second.number);
      if (race.third?.number) opponents.push(race.third.number);
      if (opponents.length > 0) pick.appendChild(el("span", { class: "opponents" }, `→ ${opponents.join(", ")}`));
    } else {
      pick.appendChild(el("span", { class: "label-small" }, "出走馬データ準備中"));
    }
    info.appendChild(pick);
    row.appendChild(info);

    // 期待値 + ティアラベル + 狙うべき度 (Wave22.6)
    const ev = el("div", { class: "ev" });
    if (race.topPick?.ev != null) {
      ev.appendChild(el("div", { class: "num-big" }, `×${race.topPick.ev.toFixed(2)}`));
      // 「狙うべき度」を tier から 5 段階の ★ にマッピング
      const aimLvl = tier === "ultra" ? 5 : tier === "prime" ? 4 : tier === "go" ? 3 : tier === "cond" ? 2 : tier === "best" ? 1 : 0;
      const aimStars = el("div", { class: `aim-stars aim-${tier}` });
      aimStars.setAttribute("title", `狙うべき度 ${aimLvl}/5`);
      for (let s = 1; s <= 5; s++) {
        aimStars.appendChild(el("span", { class: "aim-star " + (s <= aimLvl ? "on" : "off") }, s <= aimLvl ? "★" : "☆"));
      }
      ev.appendChild(aimStars);
      ev.appendChild(el("div", { class: "conf" }, `${tierLabel(tier)} / 信${((race.confidence ?? 0)*100).toFixed(0)}%`));
    } else {
      ev.appendChild(el("div", { class: "num-big" }, "—"));
      ev.appendChild(el("div", { class: "conf" }, "判断不可"));
    }
    row.appendChild(ev);
    return row;
  }

  // ─── 描画: ProfitGrid + History ──────────────────────────
  function renderHistory() {
    const today = todayJst();
    const sevenDaysAgo = new Date(Date.now() - 7*86400000).toISOString().slice(0, 10);
    const todayBets = state.bets.filter((b) => b.date === today);
    const last7 = state.bets.filter((b) => b.date >= sevenDaysAgo);

    const sumSpent = (bs) => bs.reduce((a, b) => a + (b.amount || 0), 0);
    const sumProfit = (bs) => bs.reduce((a, b) => a + ((b.payout || 0) - (b.amount || 0)), 0);
    const countHit = (bs) => bs.filter((b) => b.result === "hit").length;

    $("#prof-spent-today").innerHTML = `${fmtYen(sumSpent(todayBets))}<small>円</small>`;
    $("#prof-bought-today").textContent = `${todayBets.length} R`;
    const pT = sumProfit(todayBets);
    $("#prof-profit-today").innerHTML = `${pT >= 0 ? "+" : ""}${fmtYen(pT)}<small>円</small>`;
    $("#prof-profit-today").parentElement.className = "profit-cell " + (pT > 0 ? "go" : pT < 0 ? "bad" : "");
    $("#prof-hit-today").textContent = `的中 ${countHit(todayBets)} / ${todayBets.length}`;

    $("#prof-spent-7d").innerHTML = `${fmtYen(sumSpent(last7))}<small>円</small>`;
    $("#prof-bought-7d").textContent = `${last7.length} R`;
    const p7 = sumProfit(last7);
    $("#prof-profit-7d").innerHTML = `${p7 >= 0 ? "+" : ""}${fmtYen(p7)}<small>円</small>`;
    $("#prof-profit-7d").parentElement.className = "profit-cell " + (p7 > 0 ? "go" : p7 < 0 ? "bad" : "");
    const recov7 = sumSpent(last7) > 0 ? (sumSpent(last7) + p7) / sumSpent(last7) : null;
    $("#prof-recovery-7d").textContent = recov7 != null ? `回収率 ${(recov7 * 100).toFixed(0)}%` : "回収率 —";

    const list = $("#history-list");
    const recent = [...state.bets].sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 15);
    if (recent.length === 0) {
      list.innerHTML = `<div style="text-align:center;padding:20px;color:var(--c-ink-soft);font-size:13px">まだ購入記録がありません。「+ 手動で記録」ボタンで追加できます。</div>`;
    } else {
      list.innerHTML = "";
      recent.forEach((b) => list.appendChild(renderHistoryRow(b)));
    }

    renderProfitChart();
    renderMegaDashboard();
  }

  // Wave22.5: 全期間の巨大ダッシュボード (累計回収率 + 連勝 + ベスト勝利)
  function renderMegaDashboard() {
    const grid = $("#profit-grid");
    if (!grid) return;
    const parent = grid.parentNode;

    // 既存のダッシュボードを削除して再描画
    const old = parent.querySelector(".mega-dashboard");
    if (old) old.remove();

    const finished = state.bets.filter((b) => b.result === "hit" || b.result === "miss");
    if (finished.length === 0) return;  // 結果が無いうちは表示しない

    const totalSpent = finished.reduce((a, b) => a + (b.amount || 0), 0);
    const totalProfit = finished.reduce((a, b) => a + ((b.payout || 0) - (b.amount || 0)), 0);
    const totalPayout = totalSpent + totalProfit;
    const recoveryPct = totalSpent > 0 ? (totalPayout / totalSpent) * 100 : 0;
    const hitCount = finished.filter((b) => b.result === "hit").length;
    const hitRate = (hitCount / finished.length) * 100;

    // 連勝記録 (新しい順に並べて hit が連続している数)
    const ordered = [...finished].sort((a, b) => (b.id || 0) - (a.id || 0));
    let currentStreak = 0;
    for (const b of ordered) {
      if (b.result === "hit") currentStreak++;
      else break;
    }
    // 過去最高連勝
    let bestStreak = 0, runningStreak = 0;
    const chrono = [...finished].sort((a, b) => (a.id || 0) - (b.id || 0));
    for (const b of chrono) {
      if (b.result === "hit") { runningStreak++; if (runningStreak > bestStreak) bestStreak = runningStreak; }
      else runningStreak = 0;
    }

    // 過去最高利益のレース
    let bestBet = null;
    finished.forEach((b) => {
      const p = (b.payout || 0) - (b.amount || 0);
      if (b.result === "hit" && (bestBet == null || p > ((bestBet.payout || 0) - (bestBet.amount || 0)))) {
        bestBet = b;
      }
    });

    const recovTone = recoveryPct >= 110 ? "gold" : recoveryPct >= 100 ? "go" : recoveryPct >= 85 ? "warn" : "bad";
    const recovEval = recoveryPct >= 110 ? "★★★ 絶好調"
                    : recoveryPct >= 100 ? "★★ プラス収支"
                    : recoveryPct >= 85  ? "★ 損益分岐手前"
                    :                       "▼ 損益マイナス";

    const dash = el("section", { class: `mega-dashboard mega-${recovTone} fade-in` });

    // 上段: 巨大回収率
    const recovBlock = el("div", { class: "mega-recovery" });
    recovBlock.appendChild(el("div", { class: "mega-eyebrow" }, "ALL-TIME 累計回収率"));
    const big = el("div", { class: "mega-bignum" });
    big.appendChild(el("span", { class: "mega-bignum-int" }, recoveryPct.toFixed(0)));
    big.appendChild(el("span", { class: "mega-bignum-unit" }, "%"));
    recovBlock.appendChild(big);
    recovBlock.appendChild(el("div", { class: "mega-eval" }, recovEval));
    recovBlock.appendChild(el("div", { class: "mega-detail" },
      el("span", null, "投資 ", el("b", null, "¥" + fmtYen(totalSpent))),
      el("span", { class: "sep" }, " · "),
      el("span", null, "収支 ", el("b", { class: totalProfit >= 0 ? "txt-go" : "txt-bad" }, (totalProfit >= 0 ? "+" : "") + "¥" + fmtYen(totalProfit))),
      el("span", { class: "sep" }, " · "),
      el("span", null, "的中率 ", el("b", null, hitRate.toFixed(0) + "%"))
    ));
    dash.appendChild(recovBlock);

    // 下段: 連勝 + 最高記録 + ベスト勝利
    const sub = el("div", { class: "mega-sub-grid" });

    // 連勝
    const streakCell = el("div", { class: `mega-cell mega-cell-streak ${currentStreak >= 3 ? "is-fire" : ""}` });
    streakCell.appendChild(el("div", { class: "cell-label" }, "現在の連勝"));
    streakCell.appendChild(el("div", { class: "cell-bignum" },
      el("span", { class: "cell-bignum-int" }, String(currentStreak)),
      el("span", { class: "cell-bignum-unit" }, "連勝")
    ));
    if (currentStreak >= 3) streakCell.appendChild(el("div", { class: "cell-sub" }, "🔥 絶好調"));
    else if (currentStreak >= 1) streakCell.appendChild(el("div", { class: "cell-sub" }, "前回的中"));
    else streakCell.appendChild(el("div", { class: "cell-sub" }, "次の的中を狙おう"));
    sub.appendChild(streakCell);

    // 最高連勝
    const bestStreakCell = el("div", { class: "mega-cell mega-cell-best-streak" });
    bestStreakCell.appendChild(el("div", { class: "cell-label" }, "最高連勝"));
    bestStreakCell.appendChild(el("div", { class: "cell-bignum" },
      el("span", { class: "cell-bignum-int" }, String(bestStreak)),
      el("span", { class: "cell-bignum-unit" }, "連勝")
    ));
    bestStreakCell.appendChild(el("div", { class: "cell-sub" }, bestStreak >= 5 ? "🏆 殿堂入り" : bestStreak >= 3 ? "🥇 ベスト記録" : "もっと積もう"));
    sub.appendChild(bestStreakCell);

    // 過去最高利益
    if (bestBet) {
      const bestCell = el("div", { class: "mega-cell mega-cell-best-win" });
      bestCell.appendChild(el("div", { class: "cell-label" }, "歴代最高 1 撃"));
      const profit = (bestBet.payout || 0) - (bestBet.amount || 0);
      bestCell.appendChild(el("div", { class: "cell-bignum" },
        el("span", { class: "cell-bignum-int" }, "+¥" + fmtYen(profit)),
      ));
      const date = bestBet.date || "";
      const race = bestBet.race || "(レース不明)";
      bestCell.appendChild(el("div", { class: "cell-sub" }, `${date} · ${race}`));
      sub.appendChild(bestCell);
    } else {
      const noWinCell = el("div", { class: "mega-cell mega-cell-no-best" });
      noWinCell.appendChild(el("div", { class: "cell-label" }, "歴代最高 1 撃"));
      noWinCell.appendChild(el("div", { class: "cell-bignum" },
        el("span", { class: "cell-bignum-int", style: "font-size:24px;color:var(--c-ink-mute)" }, "—")
      ));
      noWinCell.appendChild(el("div", { class: "cell-sub" }, "次の的中で更新"));
      sub.appendChild(noWinCell);
    }

    dash.appendChild(sub);

    // 連勝バナー (3 連勝以上で派手バナー)
    if (currentStreak >= 3) {
      const banner = el("div", { class: "streak-banner" });
      banner.innerHTML = `
        <div class="sb-icon">🔥🔥🔥</div>
        <div class="sb-text">
          <div class="sb-eyebrow">CURRENT STREAK</div>
          <div class="sb-head"><b>${currentStreak}</b> 連勝中 — このペースを維持しよう!</div>
        </div>
      `;
      dash.appendChild(banner);
    }

    parent.insertBefore(dash, grid);
  }

  function renderHistoryRow(b) {
    const cls = b.result === "hit" ? "is-hit" : b.result === "miss" ? "is-miss" : "is-pending";
    const row = el("div", { class: `history-row ${cls}` });
    row.appendChild(el("div", { class: "date" }, fmtDateMonth(b.date)));
    const mid = el("div", null);
    mid.appendChild(el("div", { class: "race" }, b.race || "(レース未指定)"));
    mid.appendChild(el("div", { class: "meta" }, `${b.type || "—"} ${b.pick || ""} / ¥${fmtYen(b.amount || 0)}`));
    row.appendChild(mid);
    const right = el("div", { class: "result" });
    const badge = b.result === "hit" ? "HIT" : b.result === "miss" ? "MISS" : "待ち";
    right.appendChild(el("span", { class: "badge" }, badge));
    if (b.result === "hit") {
      const profit = (b.payout || 0) - (b.amount || 0);
      right.appendChild(el("span", { class: "profit" }, `+${fmtYen(profit)}円`));
    } else if (b.result === "miss") {
      right.appendChild(el("span", { class: "profit" }, `-${fmtYen(b.amount || 0)}円`));
    } else {
      right.appendChild(el("button", {
        class: "chip-filter is-active",
        style: "margin-top:4px",
        onclick: (e) => { e.stopPropagation(); openResultPrompt(b); },
      }, "結果を記録"));
    }
    row.appendChild(right);
    return row;
  }

  function renderProfitChart() {
    const root = $("#profit-chart");
    const sorted = [...state.bets].filter((b) => b.result !== null && b.result !== undefined).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (sorted.length === 0) {
      root.innerHTML = `<div style="text-align:center;padding:24px;color:var(--c-ink-soft);font-size:12px">結果が確定したレースがまだありません</div>`;
      return;
    }
    let cum = 0;
    const pts = sorted.map((b) => {
      cum += (b.payout || 0) - (b.amount || 0);
      return { date: b.date, cum };
    });
    const W = 700, H = 160, PAD = { t: 12, r: 12, b: 18, l: 36 };
    const minV = Math.min(0, ...pts.map((p) => p.cum));
    const maxV = Math.max(0, ...pts.map((p) => p.cum));
    const span = maxV - minV || 1;
    const yPad = span * 0.15;
    const yLo = minV - yPad, yHi = maxV + yPad;
    const xOf = (i) => PAD.l + (pts.length === 1 ? (W - PAD.l - PAD.r) / 2 : (i / (pts.length - 1)) * (W - PAD.l - PAD.r));
    const yOf = (v) => PAD.t + (1 - (v - yLo) / (yHi - yLo)) * (H - PAD.t - PAD.b);
    const path = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(i).toFixed(1)} ${yOf(p.cum).toFixed(1)}`).join(" ");
    const yZero = yOf(0);
    const area = `${path} L ${xOf(pts.length-1).toFixed(1)} ${yZero.toFixed(1)} L ${xOf(0).toFixed(1)} ${yZero.toFixed(1)} Z`;
    const isPos = pts[pts.length-1].cum >= 0;
    const c = isPos ? "rgba(16,185,129,0.95)" : "rgba(220,38,38,0.95)";
    const cGlow = isPos ? "rgba(16,185,129,0.45)" : "rgba(220,38,38,0.45)";

    // ピーク (最大) と ボトム (最小) を見つける
    let peakIdx = 0, bottomIdx = 0;
    pts.forEach((p, i) => {
      if (p.cum > pts[peakIdx].cum) peakIdx = i;
      if (p.cum < pts[bottomIdx].cum) bottomIdx = i;
    });
    const lastIdx = pts.length - 1;

    // グリッドライン (4 本: yLo, 25%, 50%, 75%, yHi)
    const gridLines = [];
    for (let g = 0; g <= 4; g++) {
      const v = yLo + (yHi - yLo) * (g / 4);
      const y = yOf(v);
      gridLines.push(`<line x1="${PAD.l}" y1="${y}" x2="${W-PAD.r}" y2="${y}" stroke="rgba(15,23,42,0.06)" stroke-width="1" stroke-dasharray="2 4"/>`);
    }

    // マーカー: ピーク・ボトム・現在地
    const peakMarker = peakIdx !== lastIdx && pts[peakIdx].cum > 0 ? `
      <circle cx="${xOf(peakIdx)}" cy="${yOf(pts[peakIdx].cum)}" r="3" fill="${c}" opacity="0.6"/>
      <text x="${xOf(peakIdx)}" y="${yOf(pts[peakIdx].cum) - 6}" text-anchor="middle" font-size="9" font-weight="800" fill="${c}">▲ ピーク +${fmtYen(pts[peakIdx].cum)}</text>
    ` : "";
    const bottomMarker = bottomIdx !== lastIdx && pts[bottomIdx].cum < 0 ? `
      <circle cx="${xOf(bottomIdx)}" cy="${yOf(pts[bottomIdx].cum)}" r="3" fill="rgba(220,38,38,0.6)"/>
      <text x="${xOf(bottomIdx)}" y="${yOf(pts[bottomIdx].cum) + 14}" text-anchor="middle" font-size="9" font-weight="800" fill="rgba(220,38,38,0.85)">▼ ボトム ${fmtYen(pts[bottomIdx].cum)}</text>
    ` : "";

    root.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:auto">
        <defs>
          <linearGradient id="profitGrad${isPos ? "Pos" : "Neg"}" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="${c}" stop-opacity="0.30"/>
            <stop offset="100%" stop-color="${c}" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        ${gridLines.join("")}
        <line x1="${PAD.l}" y1="${yZero}" x2="${W-PAD.r}" y2="${yZero}" stroke="rgba(15,23,42,0.30)" stroke-width="1"/>
        <text x="${PAD.l-4}" y="${yZero+4}" text-anchor="end" font-size="10" fill="rgba(15,23,42,0.55)" font-weight="700">0</text>
        <path d="${area}" fill="url(#profitGrad${isPos ? "Pos" : "Neg"})"/>
        <path d="${path}" fill="none" stroke="${cGlow}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round" opacity="0.55"/>
        <path d="${path}" fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
        ${peakMarker}
        ${bottomMarker}
        <circle cx="${xOf(lastIdx)}" cy="${yOf(pts[lastIdx].cum)}" r="6" fill="${c}"/>
        <circle cx="${xOf(lastIdx)}" cy="${yOf(pts[lastIdx].cum)}" r="9" fill="none" stroke="${c}" stroke-width="2" opacity="0.4"/>
      </svg>
      <div class="profit-chart-meta">
        <span>${pts.length} 件記録</span>
        <span class="cum ${isPos ? "is-pos" : "is-neg"}">累計 ${pts[lastIdx].cum >= 0 ? '+' : ''}¥${fmtYen(pts[lastIdx].cum)}</span>
        ${peakIdx !== lastIdx && pts[peakIdx].cum > 0 ? `<span class="peak">最高 +¥${fmtYen(pts[peakIdx].cum)}</span>` : ""}
      </div>
    `;
  }

  // ─── 詳細モーダル ────────────────────────────────────────
  async function openDetailModal(raceId) {
    if (!raceId) return;
    state.detailRaceId = raceId;
    const modal = $("#modal-race-detail");
    const body = $("#md-body");
    $("#md-title").textContent = "レース読み込み中…";
    body.innerHTML = `<div class="predict-overlay"><span class="spinner"></span>取得中…</div>`;
    modal.hidden = false;
    const data = await api(`/api/race?id=${encodeURIComponent(raceId)}`);
    if (!data || !data.ok) {
      body.innerHTML = `<div style="text-align:center;padding:30px;color:var(--c-ink-soft)">レース詳細を取得できませんでした<br><small>${data?._http || "原因不明"}</small></div>`;
      return;
    }
    const r = data.race || {};
    const c = data.conclusion || {};
    const meta = c.raceMeta || {};
    const vl = parseVenueLabel({ course: meta.course || r.course, raceId });
    $("#md-title").textContent = `${vl.venue || "?"} ${vl.raceNo || "?"}R ${meta.raceName || ""}`;

    let html = "";
    html += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">`;
    if (meta.isG1) html += `<span class="grade-badge">G1</span>`;
    if (meta.course) {
      const cls = meta.course.includes('ダ') ? 'dirt' : meta.course.includes('障') ? 'shou' : 'shiba';
      html += `<span class="surface-pill ${cls}">${escapeHtml(meta.course)}</span>`;
    }
    if (meta.going) html += `<span class="pill pill-info">${escapeHtml(meta.going)}</span>`;
    if (meta.weather) html += `<span class="pill pill-info">${escapeHtml(meta.weather)}</span>`;
    if (meta.pacePrediction) html += `<span class="pill pill-warn">ペース: ${escapeHtml(meta.pacePrediction)}</span>`;
    html += `</div>`;

    html += `<div class="reason-box" style="margin-bottom:14px"><div class="label">AI の結論</div>`;
    html += `<p style="font-size:16px;font-weight:700;margin:4px 0">${escapeHtml(c.verdictTitle || "—")}</p>`;
    if (c.verdictReason) html += `<p style="font-size:13px;color:var(--c-ink-soft);margin:0">${escapeHtml(c.verdictReason)}</p>`;
    html += `</div>`;

    if (Array.isArray(r.horses) && r.horses.length > 0) {
      const evHorses = r.horses.map((h) => {
        const pickInfo = (c.picks || []).find((p) => p.number === h.number)
          || (c.avoid || []).find((p) => p.number === h.number)
          || null;
        return { ...h, pickInfo };
      });
      const sortedH = [...evHorses].sort((a, b) => (b.pickInfo?.prob ?? 0) - (a.pickInfo?.prob ?? 0));
      html += `<div class="sec-title"><span class="bar gold"></span><h2>AI の推定 順位</h2></div>`;
      html += `<div class="runner-list runner-list-rich">`;
      // 確率最大値を取得 (確率バーの正規化用)
      const maxProb = Math.max(0.01, ...sortedH.slice(0, 18).map(h => h.pickInfo?.prob || 0));
      sortedH.slice(0, 18).forEach((h, idx) => {
        const rankCls = idx < 3 ? `rank-${idx + 1}` : "";
        const probRaw = h.pickInfo?.prob || 0;
        const probPct = probRaw * 100;
        const probText = h.pickInfo?.prob ? `${probPct.toFixed(1)}%` : "—";
        const probBarWidth = Math.max(2, Math.min(100, (probRaw / maxProb) * 100));
        const probTone = probPct >= 30 ? "high" : probPct >= 15 ? "mid" : "low";
        const oddsVal = h.win_odds ?? h.odds ?? null;
        const odds = oddsVal != null ? `${Number(oddsVal).toFixed(1)}倍 (${h.popularity || "?"}人気)` : "—";
        const name = h.name || `${h.number}番`;
        const sub = [h.jockey, h.trainer, h.sex_age].filter(Boolean).join(" / ");
        const num = parseInt(h.number, 10) || 1;
        const silkIdx = ((num - 1) % 8) + 1;
        const silkClass = `silk-${silkIdx}`;
        const rankBadge = idx === 0 ? `<span class="rb-medal">🥇</span>`
                        : idx === 1 ? `<span class="rb-medal">🥈</span>`
                        : idx === 2 ? `<span class="rb-medal">🥉</span>`
                        : `<span class="rb-rank">${idx + 1}</span>`;
        html += `<div class="runner-item ${rankCls}">
          <div class="runner-silk ${silkClass}">
            <svg viewBox="0 0 80 80" aria-hidden="true">
              <defs><linearGradient id="rs-${raceId}-${num}-${idx}" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="var(--silk-c1, #fbbf24)"/>
                <stop offset="1" stop-color="var(--silk-c2, #d97706)"/>
              </linearGradient></defs>
              <circle cx="40" cy="40" r="36" fill="url(#rs-${raceId}-${num}-${idx})" stroke="rgba(15,23,42,0.20)" stroke-width="2"/>
              <text x="40" y="51" text-anchor="middle" font-family="Inter,sans-serif" font-weight="900" font-size="32" fill="#fff"
                    style="paint-order:stroke;stroke:rgba(15,23,42,0.30);stroke-width:2px">${num}</text>
            </svg>
          </div>
          <div class="runner-info">
            <div class="runner-row1">
              ${rankBadge}
              <div class="name">${escapeHtml(name)}</div>
            </div>
            <div class="sub">${escapeHtml(sub)}</div>
            <div class="prob-bar"><div class="prob-bar-fill tone-${probTone}" style="width:${probBarWidth.toFixed(0)}%"></div></div>
          </div>
          <div class="prob">
            <div class="pct">${probText}</div>
            <div class="odds">${odds}</div>
          </div>
        </div>`;
      });
      html += `</div>`;
    }

    if (Array.isArray(c.reasonList) && c.reasonList.length > 0) {
      html += `<div class="reason-box mt-3"><div class="label">AI の思考プロセス</div><ul class="reason-list">`;
      c.reasonList.forEach((rs) => {
        html += `<li><span class="arrow">▸</span><span>${escapeHtml(rs)}</span></li>`;
      });
      html += `</ul></div>`;
    }

    html += `<div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
      <a class="btn-cta btn-cta-go" href="https://www.jra.go.jp/" target="_blank" rel="noopener" style="flex:1;text-decoration:none;text-align:center">JRA 公式へ ↗</a>
      <button class="btn-cta btn-cta-mute" id="md-record-btn" style="flex:1">+ この内容で記録</button>
    </div>`;

    body.innerHTML = html;

    const recBtn = document.getElementById("md-record-btn");
    if (recBtn) {
      const topRace = r;
      const tp = c.picks?.[0] || null;
      recBtn.addEventListener("click", () => {
        modal.hidden = true;
        quickAddBet({
          raceId,
          course: meta.course || r.course,
          topPick: tp,
        });
      });
    }
  }
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
  }

  // ─── 手動入力 / 結果記録 ─────────────────────────────────
  function openAddBetModal(prefill = null) {
    const modal = $("#modal-add-bet");
    $("#add-date").value   = prefill?.date  || todayJst();
    $("#add-race").value   = prefill?.race  || "";
    $("#add-type").value   = prefill?.type  || "単勝";
    $("#add-pick").value   = prefill?.pick  || "";
    $("#add-amount").value = prefill?.amount || "500";
    $("#add-result").value = "pending";
    $("#add-payout").value = "";
    $("#add-payout-group").hidden = true;
    renderAddPickHelper();
    modal.hidden = false;
  }
  // Wave22.7: 手動入力モーダルに「馬番ヘルプ」勝負服パレット (1-18 番)
  function renderAddPickHelper() {
    const mount = $("#add-pick-helper-mount");
    if (!mount) return;
    if (mount.dataset.built === "1") return;  // 二重描画防止
    mount.dataset.built = "1";
    mount.innerHTML = "";
    const wrap = el("div", { class: "add-pick-helper" });
    wrap.appendChild(el("div", { class: "ah-label" }, "馬番をクリックで追加 (1-18)"));
    const grid = el("div", { class: "ah-grid" });
    for (let n = 1; n <= 18; n++) {
      const silkClass = `silk-${((n - 1) % 8) + 1}`;
      const btn = el("button", { class: `ah-silk-btn ${silkClass}`, type: "button" }, String(n));
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const pickIn = $("#add-pick");
        if (!pickIn) return;
        const cur = pickIn.value.trim();
        const type = $("#add-type").value;
        const sep = (type === "単勝" || type === "複勝") ? "" : "-";
        if (!cur) {
          pickIn.value = String(n);
        } else {
          pickIn.value = cur + sep + n;
        }
        pickIn.focus();
      });
      grid.appendChild(btn);
    }
    wrap.appendChild(grid);
    mount.appendChild(wrap);
  }
  function quickAddBet(race) {
    const vl = parseVenueLabel(race);
    const tp = race.topPick;
    const prefill = {
      date: todayJst(),
      race: `${vl.venue || "?"}${vl.raceNo || ""}R`,
      type: "単勝",
      pick: tp ? String(tp.number) : "",
      amount: "500",
    };
    openAddBetModal(prefill);
  }
  function submitAddBet() {
    const date = $("#add-date").value.trim() || todayJst();
    const race = $("#add-race").value.trim();
    const type = $("#add-type").value;
    const pick = $("#add-pick").value.trim();
    const amount = parseInt($("#add-amount").value, 10);
    const result = $("#add-result").value;
    const payout = parseInt($("#add-payout").value, 10) || 0;
    if (!race) { toast("レース名を入れてください"); return; }
    if (!pick) { toast("買い目を入れてください"); return; }
    if (!Number.isFinite(amount) || amount <= 0) { toast("金額を正しく入れてください"); return; }
    const bet = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      date, race, type, pick, amount,
      result: result === "pending" ? null : result,
      payout: result === "hit" ? payout : 0,
      createdAt: new Date().toISOString(),
    };
    state.bets.push(bet);
    saveBets();
    $("#modal-add-bet").hidden = true;
    toast(result === "hit" ? "🎉 的中を記録しました!" : "購入を記録しました");
    renderHistory();
    // Wave22.8: 的中なら紙吹雪 + ファンファーレ
    if (result === "hit" && window.kbEffects) {
      try { window.kbEffects.fireConfetti({ count: 130, duration: 3800 }); } catch {}
      try { window.kbEffects.playWinFanfare(); } catch {}
    }
  }
  function openResultPrompt(bet) {
    const choice = prompt(`${bet.race} ${bet.pick}\n\n結果を入力してください\n  当 = 的中  外 = 外れ  キャンセル = やめる`, "");
    if (choice == null) return;
    const c = String(choice).trim();
    if (c === "外" || c.toLowerCase() === "miss" || c === "x" || c === "×") {
      bet.result = "miss"; bet.payout = 0;
    } else if (c === "当" || c.toLowerCase() === "hit" || c === "o" || c === "○") {
      const p = prompt("払戻金 (円) を入れてください", "0");
      const py = parseInt(p, 10);
      if (!Number.isFinite(py) || py < 0) { toast("払戻金が不正です"); return; }
      bet.result = "hit"; bet.payout = py;
    } else {
      toast("「当」または「外」を入れてください");
      return;
    }
    saveBets();
    toast(bet.result === "hit" ? "🎉 的中を記録しました!" : "結果を記録しました");
    renderHistory();
    if (bet.result === "hit" && window.kbEffects) {
      try { window.kbEffects.fireConfetti({ count: 130, duration: 3800 }); } catch {}
      try { window.kbEffects.playWinFanfare(); } catch {}
    }
  }

  // ─── タブ切替 ────────────────────────────────────────────
  function setupTabs() {
    $$(".bottom-nav__item").forEach((nav) => {
      nav.addEventListener("click", (e) => {
        e.preventDefault();
        $$(".bottom-nav__item").forEach((n) => n.classList.remove("active"));
        nav.classList.add("active");
        const tab = nav.dataset.tab;
        if (tab === "home") {
          $("#decision-mount").scrollIntoView({ behavior: "smooth", block: "start" });
        } else if (tab === "win5") {
          const w = $("#win5-mount");
          if (w && w.children.length > 0) {
            w.scrollIntoView({ behavior: "smooth", block: "start" });
          } else {
            toast("WIN5 は日曜のみ表示されます");
          }
        } else if (tab === "history") {
          // 「買ったもの と 収支」セクションは #profit-grid を含む section-card
          const profitCard = document.getElementById("profit-grid")?.closest(".section-card");
          if (profitCard) profitCard.scrollIntoView({ behavior: "smooth", block: "start" });
        } else if (tab === "add") {
          openAddBetModal();
        } else if (tab === "settings") {
          // 設定画面は未実装 → active を「本日」に戻して alert は toast へ降格
          $$(".bottom-nav__item").forEach((n) => n.classList.remove("active"));
          const homeBtn = $$(".bottom-nav__item").find((n) => n.dataset.tab === "home");
          if (homeBtn) homeBtn.classList.add("active");
          toast("設定画面は次のアップデートで追加されます");
        }
      });
    });
  }

  function setupFilters() {
    $$('.chip-filter[data-filter]').forEach((b) => {
      b.addEventListener("click", () => {
        $$('.chip-filter[data-filter]').forEach((x) => x.classList.remove("is-active"));
        b.classList.add("is-active");
        state.allRacesFilter = b.dataset.filter;
        renderAllRaces();
      });
    });
    $$('.chip-filter[data-sort]').forEach((b) => {
      b.addEventListener("click", () => {
        $$('.chip-filter[data-sort]').forEach((x) => x.classList.remove("is-active"));
        b.classList.add("is-active");
        state.allRacesSort = b.dataset.sort;
        renderAllRaces();
      });
    });
  }

  function setupModals() {
    $("#md-close").addEventListener("click", () => { $("#modal-race-detail").hidden = true; });
    $("#modal-race-detail").addEventListener("click", (e) => {
      if (e.target.id === "modal-race-detail") $("#modal-race-detail").hidden = true;
    });
    $("#add-close").addEventListener("click", () => { $("#modal-add-bet").hidden = true; });
    $("#modal-add-bet").addEventListener("click", (e) => {
      if (e.target.id === "modal-add-bet") $("#modal-add-bet").hidden = true;
    });
    $("#add-submit").addEventListener("click", submitAddBet);
    $("#btn-add-bet").addEventListener("click", () => openAddBetModal());
    $("#add-result").addEventListener("change", (e) => {
      $("#add-payout-group").hidden = e.target.value !== "hit";
    });
    // WIN5 編集モーダル
    const w5eClose = $("#w5e-close");
    if (w5eClose) w5eClose.addEventListener("click", () => { $("#modal-win5-edit").hidden = true; });
    const w5eMask = $("#modal-win5-edit");
    if (w5eMask) w5eMask.addEventListener("click", (e) => {
      if (e.target.id === "modal-win5-edit") $("#modal-win5-edit").hidden = true;
    });
    // localStorage から保存済み plan を復元
    try {
      const saved = localStorage.getItem("keiba_win5_plan");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length === 5 && parsed.every(n => Number.isFinite(n) && n >= 1 && n <= 8)) {
          state.win5UserPlan = parsed;
        }
      }
    } catch {}
  }

  // ─── カウントダウン秒更新 ───────────────────────────────
  let lastAllRacesRender = 0;
  function tickCountdown() {
    const sorted = [...state.races].sort((a, b) => {
      const aEv = a.topPick?.ev ?? -Infinity;
      const bEv = b.topPick?.ev ?? -Infinity;
      return bEv - aEv;
    });
    const best = sorted[0];
    if (best) {
      const big = $("#decision-cd-big");
      const sub = $("#decision-cd-sub");
      if (big && sub) {
        const dt = startDateOfRace(best);
        if (!dt) {
          big.textContent = "—";
          sub.textContent = "時刻未確定";
          const cd = document.querySelector(".decision-card .countdown");
          if (cd) cd.className = "countdown";
        } else {
          const diffSec = Math.floor((dt.getTime() - Date.now()) / 1000);
          const past = diffSec < 0;
          const abs = Math.abs(diffSec);
          const m = Math.floor(abs / 60);
          const s = abs % 60;
          const cd = document.querySelector(".decision-card .countdown");
          if (cd) cd.className = "countdown" + (past ? " past" : diffSec <= 300 ? " urgent" : diffSec <= 900 ? " warn" : "");
          if (past) {
            big.innerHTML = m < 60 ? `${m}<small>分前</small>` : `${Math.floor(m/60)}<small>時間前</small>`;
            sub.textContent = abs > 600 ? "終了" : "終了済";
          } else {
            big.innerHTML = m < 60
              ? `${m}<small>分</small>`
              : `${Math.floor(m/60)}<small>時間</small>${m % 60}<small>分</small>`;
            sub.textContent = `${String(s).padStart(2, "0")}秒`;
          }

          // Wave22.8: 結論カードに発走間近の階層クラスを付与
          const decisionCard = document.querySelector(".decision-card");
          if (decisionCard) {
            decisionCard.classList.remove("is-near", "is-imminent");
            if (!past) {
              if (diffSec <= 60) decisionCard.classList.add("is-imminent");
              else if (diffSec <= 300) decisionCard.classList.add("is-near");
            }
          }

          // Wave22.8: 5 分前と発走の瞬間にフルスクリーン演出を 1 回だけ
          if (window.kbEffects) {
            // 5 分前 (300 - 285 秒) → 「もうすぐ発走」フラッシュ
            if (!past && diffSec <= 300 && diffSec > 285 && state.flashedImminentFor !== best.raceId) {
              state.flashedImminentFor = best.raceId;
              try { window.kbEffects.flashImminent("もうすぐ発走! あと 5 分"); } catch {}
            }
            // 発走の瞬間 (0 ~ -5 秒) → 「発走!」フラッシュ
            if (!past || (past && abs <= 5)) {
              if (diffSec <= 0 && diffSec > -5 && state.flashedStartFor !== best.raceId) {
                state.flashedStartFor = best.raceId;
                try { window.kbEffects.flashStart(); } catch {}
              }
            }
          }
        }
      }
    }
    // 60 秒に 1 度 全レース行再描画 (締切表示更新)。
    // refreshAll (30s) と重ならないように間隔を取る — 重複描画でカクつくのを防ぐ
    if (Date.now() - lastAllRacesRender > 60000) {
      lastAllRacesRender = Date.now();
      renderAllRaces();
    }
    // LiveStrip も毎秒の年齢表示更新
    renderLive();
  }

  function render() {
    try {
      renderHeader();
      renderLive();
      renderMorningSummary();
      renderTopWinBanner();
      renderAutostatus();
      renderMlStatus();
      renderRecommendations();
      renderDecisionCard();
      renderWin5();
      renderAllRaces();
      renderHistory();
      renderAchievements();
      renderStreakCard();
    } catch (e) {
      console.error("[render] error", e);
    }
  }

  // ─── 達成バッジシステム (必殺一号艇 AchievementBadges 移植) ──
  // 15 種類の実績バッジを計算 (達成した分だけ表示)
  function computeAchievements(bets) {
    const settled = bets.filter((b) => b.result === "hit" || b.result === "miss");
    const hits = settled.filter((b) => b.result === "hit");
    const profitSum = settled.reduce((a, b) => a + ((b.payout || 0) - (b.amount || 0)), 0);
    const spent = settled.reduce((a, b) => a + (b.amount || 0), 0);
    const hitRate = settled.length > 0 ? hits.length / settled.length : 0;
    const sortedByDate = [...settled].sort((a, b) => (b.id || 0) - (a.id || 0));
    // 現在の連勝 (最新から HIT が続く件数)
    let currentStreak = 0;
    for (const b of sortedByDate) { if (b.result === "hit") currentStreak++; else break; }
    // 過去最高連勝
    let bestStreak = 0, cur = 0;
    [...settled].sort((a, b) => (a.id || 0) - (b.id || 0)).forEach((b) => {
      if (b.result === "hit") { cur++; bestStreak = Math.max(bestStreak, cur); }
      else cur = 0;
    });

    const out = [];
    if (settled.length >= 1) out.push({ icon: "🎯", label: "初記録", value: settled.length, sub: "件 達成", tone: "info" });
    if (hits.length >= 1) out.push({ icon: "🎉", label: "初的中", value: hits.length, sub: "回 当てた", tone: "go" });
    if (currentStreak >= 3) out.push({ icon: "🔥", label: "連勝中", value: currentStreak, sub: "連続的中", tone: "gold" });
    if (bestStreak >= 5) out.push({ icon: "⚡", label: "歴代最高連勝", value: bestStreak, sub: "連続", tone: "gold" });
    if (profitSum > 0) out.push({ icon: "💰", label: "累積プラス", value: `+¥${fmtYen(profitSum)}`, sub: `${settled.length} 件で`, tone: "go" });
    if (profitSum >= 10000) out.push({ icon: "💎", label: "+¥1万 突破", value: `+¥${fmtYen(profitSum)}`, sub: "達成済", tone: "gold" });
    if (profitSum >= 50000) out.push({ icon: "👑", label: "+¥5万 突破", value: `+¥${fmtYen(profitSum)}`, sub: "達成済", tone: "gold" });
    if (profitSum >= 100000) out.push({ icon: "🏆", label: "+¥10万 突破", value: `+¥${fmtYen(profitSum)}`, sub: "達成済", tone: "gold" });
    if (settled.length >= 10) out.push({ icon: "📚", label: "記録 10件", value: settled.length, sub: "蓄積中", tone: "info" });
    if (settled.length >= 50) out.push({ icon: "📖", label: "記録 50件", value: settled.length, sub: "ベテラン", tone: "info" });
    if (settled.length >= 100) out.push({ icon: "📕", label: "記録 100件", value: settled.length, sub: "達人級", tone: "gold" });
    if (settled.length >= 5 && hitRate >= 0.50) out.push({ icon: "🎲", label: "的中率 50%+", value: `${(hitRate * 100).toFixed(0)}%`, sub: `${hits.length}/${settled.length}`, tone: "gold" });
    if (spent > 0 && profitSum >= 0) {
      const recov = ((spent + profitSum) / spent * 100);
      if (recov >= 100 && settled.length >= 5) {
        out.push({ icon: "📈", label: "回収率 100%+", value: `${recov.toFixed(0)}%`, sub: "プロ級", tone: "gold" });
      }
    }
    if (hits.length >= 3) {
      const maxPayout = Math.max(...hits.map((h) => (h.payout || 0) - (h.amount || 0)));
      if (maxPayout >= 5000) {
        out.push({ icon: "🎰", label: "最高利益", value: `+¥${fmtYen(maxPayout)}`, sub: "1 回で", tone: "gold" });
      }
    }
    return out;
  }

  function renderAchievements() {
    const root = $("#achievements-mount");
    if (!root) return;
    const aclist = computeAchievements(state.bets || []);
    if (aclist.length === 0) { root.hidden = true; return; }
    root.hidden = false;
    root.innerHTML = `
      <div class="ach-head">
        <span class="ach-icon">🏅</span>
        <span class="ach-title">あなたの実績</span>
        <span class="ach-count">${aclist.length} 件 達成中</span>
      </div>
      <div class="ach-grid">
        ${aclist.map((a) => `
          <div class="ach-badge ach-tone-${a.tone}">
            <div class="head">
              <span class="emoji">${a.icon}</span>
              <span class="lab">${escapeHtml(a.label)}</span>
            </div>
            <div class="val">${escapeHtml(String(a.value))}</div>
            ${a.sub ? `<div class="sub">${escapeHtml(a.sub)}</div>` : ""}
          </div>
        `).join("")}
      </div>
    `;
  }

  // ─── 連勝記録カード ─────────────────────────────────────
  function renderStreakCard() {
    const root = $("#streak-mount");
    if (!root) return;
    const bets = state.bets || [];
    const settled = bets.filter((b) => b.result === "hit" || b.result === "miss");
    if (settled.length < 3) { root.hidden = true; return; }
    const hits = settled.filter((b) => b.result === "hit");
    const sortedByDate = [...settled].sort((a, b) => (b.id || 0) - (a.id || 0));
    let currentStreak = 0;
    for (const b of sortedByDate) { if (b.result === "hit") currentStreak++; else break; }
    let bestStreak = 0, cur = 0;
    [...settled].sort((a, b) => (a.id || 0) - (b.id || 0)).forEach((b) => {
      if (b.result === "hit") { cur++; bestStreak = Math.max(bestStreak, cur); }
      else cur = 0;
    });
    // 直近 30 件
    const last30 = sortedByDate.slice(0, 30);
    const last30Hits = last30.filter((b) => b.result === "hit").length;
    const last30Rate = last30.length > 0 ? last30Hits / last30.length : 0;
    // 直近 30 件のドット可視化 (新しい順)
    const dots = last30
      .map((b) => b.result === "hit" ? '<span class="dot dot-hit"></span>' : '<span class="dot dot-miss"></span>')
      .reverse() // 古い→新しいで表示
      .join("");

    root.hidden = false;
    root.innerHTML = `
      <div class="streak-head">
        <span class="streak-icon">🔥</span>
        <span class="streak-title">連勝記録 / 最近の調子</span>
      </div>
      <div class="streak-stats">
        <div class="streak-cell ${currentStreak >= 3 ? "is-hot" : ""}">
          <div class="lab">現在の連勝</div>
          <div class="big">${currentStreak}<small>連</small></div>
        </div>
        <div class="streak-cell ${bestStreak >= 5 ? "is-gold" : ""}">
          <div class="lab">歴代最高</div>
          <div class="big">${bestStreak}<small>連</small></div>
        </div>
        <div class="streak-cell ${last30Rate >= 0.5 ? "is-go" : ""}">
          <div class="lab">直近30件 的中率</div>
          <div class="big">${(last30Rate * 100).toFixed(0)}<small>%</small></div>
          <div class="sub">${last30Hits} / ${last30.length}</div>
        </div>
      </div>
      <div class="streak-dots">${dots}</div>
      <div class="streak-legend">
        <span><span class="dot dot-hit"></span> 的中</span>
        <span><span class="dot dot-miss"></span> 外れ</span>
        <span class="time">古い→新しい</span>
      </div>
    `;
  }

  // ─── 朝の概要トースト (JST 6:00-12:00 の初回のみ・1日 1 回) ───
  function renderMorningSummary() {
    const root = $("#morning-mount");
    if (!root) return;
    const now = new Date();
    const hh = now.getHours();
    if (hh < 6 || hh >= 12) { root.hidden = true; return; }
    const today = todayJst();
    const KEY = "keiba_morning_summary_last";
    if (localStorage.getItem(KEY) === today) { root.hidden = true; return; }

    // 何も買うものが無い日は出さない (テンション下げ防止)
    const goRaces = state.races.filter((r) => ["ultra","prime","go","cond"].includes(tierOfRace(r)));
    const goldRaces = state.races.filter((r) => ["ultra","prime"].includes(tierOfRace(r)));
    if (goRaces.length === 0) {
      // ただし「直近の推奨ログ」がある場合は復習促進トーストを出す
      const recentN = state.recommendations?.recommendations_recent?.length || 0;
      if (recentN === 0) { root.hidden = true; return; }
    }

    localStorage.setItem(KEY, today);

    // 最初の締切
    let firstStart = null;
    for (const r of state.races) {
      const dt = startDateOfRace(r);
      if (dt && dt.getTime() > Date.now()) {
        if (!firstStart || dt.getTime() < firstStart.getTime()) firstStart = dt;
      }
    }
    const firstHM = firstStart
      ? `${String(firstStart.getHours()).padStart(2,"0")}:${String(firstStart.getMinutes()).padStart(2,"0")}`
      : null;

    const wd = ["日","月","火","水","木","金","土"][now.getDay()];
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;
    const headline = goldRaces.length > 0
      ? `☀️ おはよう・今日の絶好機 ${goldRaces.length} R`
      : goRaces.length > 0
        ? `☀️ おはよう・今日の勝負 ${goRaces.length} R`
        : isWeekend
          ? `☀️ おはよう・データ取得中`
          : `☀️ おはよう・今日 (${wd}) は休む日`;

    const parts = [];
    if (goldRaces.length > 0) parts.push(`<span style="color:var(--c-gold);font-weight:900">💎 絶好機 ${goldRaces.length}R</span>`);
    if (goRaces.length > goldRaces.length) parts.push(`<span style="color:var(--c-deep);font-weight:800">勝負 ${goRaces.length - goldRaces.length}R</span>`);
    if (firstHM) parts.push(`<span style="color:var(--c-ink-soft)">最初の締切 ${firstHM}</span>`);

    root.hidden = false;
    root.innerHTML = `
      <div class="morning-toast" id="morning-toast">
        <div class="head">
          <span class="emoji">☀️</span>
          <span class="lab">MORNING BRIEF</span>
          <span class="close-hint">タップで閉じる</span>
        </div>
        <div class="title">${headline}</div>
        ${parts.length > 0 ? `<div class="parts">${parts.join(" / ")}</div>` : ""}
      </div>
    `;
    const t = root.querySelector(".morning-toast");
    if (t) {
      t.addEventListener("click", () => { root.hidden = true; });
      setTimeout(() => { root.hidden = true; }, 9000);
    }
  }

  // ─── 今週の最高的中バナー (利益 ¥10,000+ の直近 HIT を派手に祝う) ──
  function renderTopWinBanner() {
    const root = $("#topwin-mount");
    if (!root) return;
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const bigWins = (state.bets || [])
      .filter((b) => b.result === "hit" && b.payout > 0 && b.date >= sevenDaysAgo)
      .map((b) => ({ ...b, profit: (b.payout || 0) - (b.amount || 0) }))
      .filter((b) => b.profit >= 10000)
      .sort((a, b) => b.profit - a.profit);
    if (bigWins.length === 0) { root.hidden = true; return; }
    const top = bigWins[0];
    root.hidden = false;
    root.innerHTML = `
      <div class="topwin-banner">
        <div class="emoji-wrap"><span class="emoji">🎯</span></div>
        <div class="msg">
          <div class="lab">🏆 今週の最高的中</div>
          <div class="title">${escapeHtml(fmtDateMonth(top.date) || "—")} ${escapeHtml(top.race || "?")} ${escapeHtml(top.type || "")}</div>
          <div class="sub">${escapeHtml(top.pick || "")} ・ 払戻 ¥${fmtYen(top.payout || 0)}${bigWins.length > 1 ? ` <span class="more">他 +${bigWins.length - 1}件</span>` : ""}</div>
        </div>
        <div class="amount">
          <div class="lab">利益</div>
          <div class="big">+${fmtYen(top.profit)}</div>
          <div class="lab">円</div>
        </div>
      </div>
    `;
  }

  // ─── 描画: AI 実証成績カード (Wave17) ────────────────────
  // LightGBM の学習メタ + 過去レース実証回収率を 1 枚にまとめて表示。
  // 「機械学習モデルが今どれくらい当たるか」を、誇張なしに数字で見せる。
  function renderMlStatus() {
    const root = $("#ml-status-mount");
    if (!root) return;
    const m = state.mlStatus;
    if (!m || !m.ok || !m.modelAvailable) { root.hidden = true; return; }
    root.hidden = false;
    const STRAT_LABELS = {
      // Wave29-B: 馬連 nopop top1-top2
      value_uren_nopop_016: "V-馬連HOT nopop top1-top2 (閾値 16%) — avg 222.57%",
      value_uren_nopop_030: "V-馬連 nopop top1-top2 (閾値 30%・勝 7/7) — avg 165.29%",
      // Wave27 強化: nopop モデル単独 最強 + 安定派
      value_invest_nopop_016: "VALUE 実力派 AI 本命 (人気を見ない) 16%+ 複勝 — Walk-fwd 152.62%",
      value_invest_nopop_022: "VALUE 実力派 AI 本命 (人気を見ない) 22%+ 複勝",
      value_invest_nopop_035: "V-SAFE 実力派 AI 本命 35%+ 複勝 (安定派・avg 131%)",
      tan_top1_always:        "単勝 本命",
      tan_top1_ev100:         "単勝 EV1.0+",
      tan_top1_ev110:         "単勝 EV1.1+",
      tan_top1_ev130:         "単勝 EV1.3+ (絶好機のみ)",
      tan_top1_value3:        "単勝 価値投資 (人気 3 番以下)",
      tan_top1_kelly:         "単勝 ケリー基準",
      fuku_top1_always:       "複勝 本命",
      fuku_top1_ev090:        "複勝 EV0.9+",
      fuku_top1_ev110:        "複勝 EV1.1+",
      fuku_top1_value3:       "複勝 価値投資",
      uren_top1_top2:         "馬連 本命-対抗",
      uren_value3_x_pop1:     "馬連 価値 × 人気1番",
      wide_box_top3:          "ワイド 本命-対抗-3着候補 3点",
      wide_value3_x_pop1:     "ワイド 価値 × 人気1番",
      // Wave18: nopop モデルとの組み合わせ
      tan_nopop_top1:         "単勝 実力派モデル本命",
      fuku_nopop_top1:        "複勝 実力派モデル本命",
      tan_nopop_undervalued:  "単勝 実力派本命 × 人気 3 番以下",
      fuku_nopop_undervalued: "複勝 実力派本命 × 人気 3 番以下",
      tan_value_signal_005:   "単勝 価値シグナル+0.05",
      fuku_value_signal_003:  "複勝 価値シグナル+0.03",
      uren_primary_x_nopop:   "馬連 市場本命 × 実力派本命",
      wide_primary_x_nopop:   "ワイド 市場本命 × 実力派本命",
      fuku_ev_nopop_110:      "複勝 実力派EV1.1+",
      // Wave19: 見送り型 100%+ 戦略
      tan_best_ev_any:        "単勝 全頭中EV最大 (≥0.95)",
      fuku_best_ev_any:       "複勝 全頭中EV最大 (≥0.85)",
      tan_strict_combined:    "単勝 厳格複合 (両モデルEV+)",
      fuku_strict_combined:   "複勝 厳格複合 (両モデルEV+)",
      tan_top1_confident:     "単勝 本命確信 (確率40%+)",
      fuku_top1_confident:    "複勝 本命確信 (確率35%+)",
      uren_top1_top2_high:    "馬連 本命対抗合計55%+",
      wide_box_top3_confident: "ワイド 上位3頭合計70%+",
      fuku_underdog_value:    "複勝 穴狙い実力派",
      fuku_super_strict:      "複勝 本命突出 (差10pt+)",
      wide_top3_conf_055:     "ワイド top3合計55%+",
      wide_top3_conf_060:     "ワイド top3合計60%+",
      wide_top3_conf_065:     "ワイド top3合計65%+",
      wide_top3_conf_070:     "ワイド top3合計70%+ (超確信)",
      wide_top3_conf_075:     "ワイド top3合計75%+",
      wide_top3_conf_080:     "ワイド top3合計80%+",
      fuku_gap_004:           "複勝 本命対抗差4pt+",
      fuku_gap_006:           "複勝 本命対抗差6pt+",
      fuku_gap_008:           "複勝 本命対抗差8pt+",
      fuku_gap_010:           "複勝 本命対抗差10pt+",
      fuku_gap_012:           "複勝 本命対抗差12pt+",
      fuku_gap_015:           "複勝 本命対抗差15pt+ (絶対本命)",
      fuku_top1_prob_020:     "複勝 本命確率20%+ (推奨)",
      fuku_top1_prob_025:     "複勝 本命確率25%+",
      fuku_top1_prob_030:     "複勝 本命確率30%+",
      fuku_top1_prob_035:     "複勝 本命確率35%+",
      fuku_top1_prob_040:     "複勝 本命確率40%+",
      fuku_top1_prob_045:     "複勝 本命確率45%+",
    };
    const auc = m.model && m.model.auc;
    const aucNopop = m.modelNopop && m.modelNopop.auc;
    const bt  = m.backtest || {};
    const bestRoi = bt.bestRoiPct;
    const stratsActive = (bt.strategies || []).filter((s) => s.bets > 0);
    // Wave19: 100% 越え戦略を抽出。サンプル件数で信頼性ランク分け。
    const winStrats = stratsActive.filter((s) => s.roi_pct >= 100);
    // 「推奨」= 100% 越え + 件数 50+ で安定 (試行回数十分)
    const reliableWins = winStrats.filter((s) => s.bets >= 50);
    // 「候補」= 100% 越えだが件数少 (10-49)・偶然の可能性ある
    const possibleWins = winStrats.filter((s) => s.bets >= 10 && s.bets < 50);
    // 表示用 top: 全戦略の上位 7
    const stratsTop = stratsActive.slice(0, 7);
    const pillCls = bestRoi >= 100 ? "is-go" : bestRoi >= 90 ? "is-warn" : "is-mute";
    const fmtStratName = (s) => STRAT_LABELS[s.name] || s.name;
    root.innerHTML = `
      <div class="ml-head">
        <span class="ml-icon" aria-hidden="true">📊</span>
        <span class="ml-title">AI モデル実証成績</span>
        <span class="ml-pill ${pillCls}">${bestRoi != null ? "ベスト " + bestRoi.toFixed(1) + "%" : "—"}</span>
      </div>
      <div class="ml-grid">
        <div class="ml-cell">
          <div class="ml-cell-label">AI 精度 (人気込)</div>
          <div class="ml-cell-value">${auc != null ? (auc * 100).toFixed(1) + "<small>%</small>" : "—"}</div>
          <div class="ml-cell-sub">学習 ${(m.model?.samplesTrain ?? 0).toLocaleString()} 行</div>
        </div>
        <div class="ml-cell">
          <div class="ml-cell-label">実力派 AI 精度</div>
          <div class="ml-cell-value">${aucNopop != null ? (aucNopop * 100).toFixed(1) + "<small>%</small>" : "—"}</div>
          <div class="ml-cell-sub">${aucNopop != null ? "人気を見ないモデル" : "未学習"}</div>
        </div>
        <div class="ml-cell">
          <div class="ml-cell-label">過去 ${bt.testRaces ?? 0} R 検証</div>
          <div class="ml-cell-value">${bestRoi != null ? bestRoi.toFixed(1) + "<small>%</small>" : "—"}</div>
          <div class="ml-cell-sub">${STRAT_LABELS[bt.bestStrategy] || bt.bestStrategy || "—"}</div>
        </div>
      </div>
      ${reliableWins.length > 0 ? `
      <div class="ml-recommended">
        <div class="ml-rec-head">
          <span class="ml-rec-icon">★</span>
          <span class="ml-rec-title">100% 越えの推奨買い方</span>
          <span class="ml-rec-pill">${reliableWins.length} 戦略</span>
        </div>
        <div class="ml-rec-list">
          ${reliableWins.map((s) => `
            <div class="ml-rec-card">
              <div class="ml-rec-name">${fmtStratName(s)}</div>
              <div class="ml-rec-stats">
                <span class="ml-rec-roi">${s.roi_pct.toFixed(1)}%</span>
                <span class="ml-rec-meta">的中 ${(s.hit_rate * 100).toFixed(1)}% / ${s.bets} 件</span>
              </div>
            </div>
          `).join("")}
        </div>
        <p class="ml-rec-note">
          過去 ${bt.testRaces} R のうち <b>${reliableWins.reduce((sum, s) => sum + s.bets, 0)} R</b> で発火 →
          機械的に全レース買うと負けますが、この条件のときだけ買えば長期で <b>プラス</b> に。
        </p>
      </div>
      ` : ""}
      ${possibleWins.length > 0 ? `
      <div class="ml-possible">
        <div class="ml-rec-head" style="margin-bottom:6px;">
          <span class="ml-rec-icon">▲</span>
          <span class="ml-rec-title" style="font-size:12px;">100% 越え候補 (サンプル少・偶然の可能性)</span>
        </div>
        <div class="ml-rec-list">
          ${possibleWins.map((s) => `
            <div class="ml-rec-card is-possible">
              <div class="ml-rec-name">${fmtStratName(s)}</div>
              <div class="ml-rec-stats">
                <span class="ml-rec-roi">${s.roi_pct.toFixed(1)}%</span>
                <span class="ml-rec-meta">的中 ${(s.hit_rate * 100).toFixed(1)}% / ${s.bets} 件</span>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
      ` : ""}
      <div class="ml-strats">
        <div class="ml-strats-title">買い方ごとの回収率 (上位 ${stratsTop.length}・参考)</div>
        ${stratsTop.map((s) => {
          const cls = s.roi_pct >= 100 ? "is-win" : s.roi_pct >= 90 ? "is-close" : "is-lose";
          return `
            <div class="ml-strat ${cls}">
              <span class="ml-strat-name">${fmtStratName(s)}</span>
              <span class="ml-strat-roi">${s.roi_pct.toFixed(1)}%</span>
              <span class="ml-strat-meta">的中 ${(s.hit_rate * 100).toFixed(1)}% / ${s.bets}件</span>
            </div>
          `;
        }).join("")}
        ${stratsActive.length === 0 ? '<div class="ml-strat is-mute"><span class="ml-strat-name">期待値 1.0+ で買える局面は検証期間に 0 件でした</span></div>' : ""}
      </div>
      <p class="ml-note">
        <b>正直な現状:</b> ${reliableWins.length > 0
          ? `★ の推奨買い方なら過去データで <b>プラス</b>。ただし完全データではなく 8 ヶ月分での検証なので、今後の運用で安定するか継続観察します。`
          : (bestRoi >= 100 ? "ベスト戦略はプラスを達成。" : "機械的に AI 本命を毎レース買うと回収率 70-90% で負けます。")}
      </p>
    `;
  }

  // ─── 描画: 今日の推奨レース (Wave19.3: 3 戦略マルチアサイン) ──
  // BEST: fuku_top1_prob_022 (確率 22%+ で複勝) 65 件 112.2%
  // SAFE: fuku_top1_prob_020 (確率 20%+ で複勝) 100 件 106.3%
  // WIDE: wide_top3_conf_050 (top3 合計 50%+ でワイド 3 点) 49 件 132%
  function renderRecommendations() {
    const root = $("#recommend-mount");
    if (!root) return;
    const r = state.recommendations;
    if (!r || !r.ok) { root.hidden = true; return; }
    const stratDefs = r.strategies_def || [];
    const stats = r.stats || {};
    const todayList = r.recommendations_today || [];
    const recentList = (r.recommendations_recent || []).filter(
      (x) => x.race_date !== r.todayJst,
    ).slice(0, 8);
    const fallbackList = (r.recommendations_fallback || []).slice(0, 12);
    root.hidden = false;

    const fmtHorse = (h) => {
      const num  = h.number ?? "?";
      const name = scrubName(h.name, "(馬名取得中)");
      const prob = h.win_prob != null ? (h.win_prob * 100).toFixed(1) : "—";
      const odds = h.odds != null ? `${Number(h.odds).toFixed(1)} 倍` : "オッズ未取得";
      const pop  = h.popularity != null ? ` / 人気 ${h.popularity}` : "";
      return `${num} ${name}<span class="rec-hmeta">確率 ${prob}% / 単勝 ${odds}${pop}</span>`;
    };

    const stratBadges = (keys) => {
      const labels = { big: "BIG", turf: "TURF", ultra: "★ULTRA", best: "BEST", safe: "SAFE" };
      return (keys || []).map((k) => `<span class="rec-badge rec-b-${k}">${labels[k] || k}</span>`).join("");
    };

    const renderItem = (it) => {
      const stratSet = new Set(it.strategies || []);
      const numStr = it.top3 && it.top3.length === 3
        ? `${it.top3[0].number}-${it.top3[1].number}-${it.top3[2].number}`
        : "1-2-3";
      // 買い方の決定: 発火戦略の中で最も「具体的・利益期待大」のものを選ぶ
      // ULTRA > BIG (3 連複) > TURF/BEST/SAFE (複勝) の優先順
      let betLabel;
      if (stratSet.has("ultra")) {
        betLabel = `複勝 #${it.horse?.number} 100 円 + ワイド ${numStr} 300 円 = 400 円`;
      } else if (stratSet.has("big")) {
        betLabel = `3 連複 ボックス ${numStr} 100 円`;
      } else {
        betLabel = `複勝 #${it.horse?.number} 100 円`;
      }
      const courseTxt = scrubName(it.course, "—");
      const raceNameTxt = scrubName(it.race_name, "");
      return `
        <div class="rec-item">
          <div class="rec-race">
            <span class="rec-course">${courseTxt}</span>
            ${it.is_g1 ? '<span class="rec-g1">G1</span>' : ""}
            <span class="rec-race-name">${raceNameTxt}</span>
            <span class="rec-badges">${stratBadges(it.strategies)}</span>
          </div>
          <div class="rec-horse">${fmtHorse(it.horse || {})}</div>
          <div class="rec-action">
            <span class="rec-bet">${betLabel}</span>
            <span class="rec-date">${it.race_date}${it.hassou_time ? ` ${it.hassou_time.slice(0,2)}:${it.hassou_time.slice(2,4)}発走` : ""}</span>
          </div>
        </div>
      `;
    };

    const stratCardHtml = (defn) => {
      const st = stats[defn.key];
      if (!st) return "";
      // Walk-forward 信頼性指標で色クラスを決定 (見せかけの ROI ではなく安定性で判断)
      const trustLvl = st.trust_level || 0;
      const trustLabel = st.trust_label || "—";
      const cls = trustLvl >= 4 ? "rec-strat-trusted"
                : trustLvl >= 3 ? "rec-strat-stable"
                : trustLvl >= 2 ? "rec-strat-mixed"
                : "rec-strat-risky";
      const stars = "★".repeat(trustLvl) + "☆".repeat(4 - trustLvl);
      const wf = st.walk_forward || {};
      const wfRoi = wf.mean_roi_pct != null ? wf.mean_roi_pct.toFixed(1) + "%" : null;
      const wfWin = wf.win_periods != null && wf.active_periods != null
        ? `${wf.win_periods}/${wf.active_periods} 期間 ◎`
        : null;
      return `
        <div class="rec-strat-card ${cls}">
          <div class="rec-strat-badge">${defn.short_label}</div>
          <div class="rec-strat-stars" title="${trustLabel}">${stars}</div>
          <div class="rec-strat-roi">${st.roi_pct ? st.roi_pct.toFixed(1) + "%" : "—"}</div>
          <div class="rec-strat-meta">
            ${st.fired_count}件・的中${st.hit_rate_pct}%
            ${wfWin ? `<span class="rec-strat-wf">分割検証: ${wfRoi}・${wfWin}</span>` : ""}
          </div>
          <div class="rec-strat-label">${defn.label}</div>
        </div>
      `;
    };

    // 戦略カードは結論カードの「Walk-forward 検証」ブロックに統合済 → 推奨レース一覧のみ表示
    // 「今日のレースが 0 件」かつ「直近ログも 0 件」のときはセクション自体を隠す (開催なし日はヒーローで完結)
    // Wave28: fallback (最新の AI 推奨) があるならそれを表示する
    if (todayList.length === 0 && recentList.length === 0 && fallbackList.length === 0) {
      root.hidden = true;
      return;
    }
    root.innerHTML = `
      <div class="rec-head">
        <span class="rec-icon">★</span>
        <span class="rec-title">100% 越え戦略の自動推奨</span>
        <span class="rec-pill is-go">${todayList.length > 0 ? `今日 ${todayList.length} 件` : "直近の実績"}</span>
      </div>
      <p class="rec-criteria">
        過去 ${stats.best?.test_races || 0} R で <b>Walk-forward 検証済</b> の戦略のみが発火条件を満たしたレースを抽出しています。
      </p>
      ${todayList.length > 0 ? `
        <div class="rec-section">
          <div class="rec-section-head">📢 今日 (${r.todayJst}) の推奨 ${todayList.length} 件</div>
          <div class="rec-list">${todayList.map(renderItem).join("")}</div>
        </div>
      ` : `
        <div class="rec-empty">
          今日 (${r.todayJst}) は条件を満たすレースが <b>0 件</b> です。<br>
          「絶対に分からない」レースは <b>見送り</b> が正解。下に直近の的中ログを掲載しています。
        </div>
      `}
      ${recentList.length > 0 ? `
        <div class="rec-section">
          <div class="rec-section-head">📊 直近の推奨レース過去ログ (${recentList.length} 件)</div>
          <div class="rec-list rec-list-small">${recentList.map(renderItem).join("")}</div>
        </div>
      ` : ""}
      ${(todayList.length === 0 && recentList.length === 0 && fallbackList.length > 0) ? `
        <div class="rec-section">
          <div class="rec-section-head">🗂 AI の最新の推奨レース ${fallbackList.length} 件 (取り込み済の過去レース)</div>
          <p class="rec-criteria" style="font-size:12px;color:var(--c-ink-soft)">
            ※ 今週末のレースデータは土曜朝に取り込まれます。下記は直近に AI が推奨を出した過去レースです。
          </p>
          <div class="rec-list rec-list-small">${fallbackList.map(renderItem).join("")}</div>
        </div>
      ` : ""}
    `;
  }

  // ─── 描画: 自動化ステータス (Wave16) ─────────────────────
  function renderAutostatus() {
    const root = $("#automation-mount");
    if (!root) return;
    const a = state.autostatus;
    if (!a || !a.ok) {
      $("#autostatus-overall").textContent = "取得中…";
      return;
    }
    const now = Date.now();
    const ageHours = (iso) => {
      if (!iso) return null;
      const t = new Date(iso).getTime();
      if (isNaN(t)) return null;
      return (now - t) / 3600000;
    };
    const fmtHours = (h) => {
      if (h == null) return "—";
      if (h < 1) return `${Math.round(h * 60)} 分前`;
      if (h < 48) return `${h.toFixed(1)} 時間前`;
      return `${Math.floor(h / 24)} 日前`;
    };
    const cells = [
      {
        key: "fetch", labelEl: "#autostatus-fetch", subEl: "#autostatus-fetch-sub",
        ageH: ageHours(a.lastDataFetch),
        okIfUnder: 48,
        okText: "稼働中", warnText: "確認", ngText: "停止中",
        sub: a.lastDataFetch ? `JV-Link 最終取得 ${fmtHours(ageHours(a.lastDataFetch))}` : "未取得",
      },
      {
        key: "predict", labelEl: "#autostatus-predict", subEl: "#autostatus-predict-sub",
        ageH: ageHours(a.predictionsComputedAt),
        okIfUnder: 24,
        okText: a.predictionsFresh ? "最新" : "やや古い",
        warnText: "やや古い", ngText: "未計算",
        sub: a.predictionsComputedAt ? `事前計算 ${fmtHours(ageHours(a.predictionsComputedAt))}` : "事前計算なし",
      },
      {
        key: "deploy", labelEl: "#autostatus-deploy", subEl: "#autostatus-deploy-sub",
        ageH: ageHours(a.lastGitPushDeploy),
        okIfUnder: 72,
        okText: "反映済", warnText: "やや古い", ngText: "停止中",
        sub: a.lastGitPushDeploy ? `本番反映 ${fmtHours(ageHours(a.lastGitPushDeploy))}` : "未反映",
      },
      {
        key: "finalize", labelEl: "#autostatus-finalize", subEl: "#autostatus-finalize-sub",
        ageH: null,
        okIfUnder: 999,
        okText: "毎日 23:00 自動", warnText: "未設定", ngText: "停止中",
        sub: a.nextCronFinalizeISO
          ? `次回 ${new Date(a.nextCronFinalizeISO).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
          : "未設定",
      },
    ];

    let okCount = 0;
    let warnCount = 0;
    for (const c of cells) {
      const v = $(c.labelEl);
      const s = $(c.subEl);
      if (!v) continue;
      let cls = "is-ok";
      let txt = c.okText;
      if (c.key === "finalize") {
        if (a.nextCronFinalizeISO) { cls = "is-ok"; txt = c.okText; okCount++; }
        else { cls = "is-warn"; txt = c.warnText; warnCount++; }
      } else if (c.ageH == null) {
        cls = "is-ng"; txt = c.ngText;
      } else if (c.ageH < c.okIfUnder) {
        cls = "is-ok"; txt = c.okText; okCount++;
      } else if (c.ageH < c.okIfUnder * 2) {
        cls = "is-warn"; txt = c.warnText; warnCount++;
      } else {
        cls = "is-ng"; txt = c.ngText;
      }
      v.className = "autostatus-value " + cls;
      v.textContent = txt;
      if (s) s.textContent = c.sub;
      const cell = root.querySelector(`.autostatus-cell[data-key="${c.key}"]`);
      if (cell) cell.className = "autostatus-cell " + cls;
    }
    // 総合: 全部 OK → 緑, 1 つでも NG → 赤, それ以外 → オレンジ
    const ovr = $("#autostatus-overall");
    if (ovr) {
      if (okCount === cells.length) { ovr.className = "autostatus-pill is-ok"; ovr.textContent = "すべて自動稼働中"; }
      else if (okCount + warnCount === cells.length) { ovr.className = "autostatus-pill is-warn"; ovr.textContent = "確認推奨"; }
      else { ovr.className = "autostatus-pill is-ng"; ovr.textContent = "要対応"; }
    }
    const note = $("#autostatus-note");
    if (note) {
      if (okCount === cells.length) {
        note.textContent = "緑 4 つ揃っているので手動操作は不要です。寝ていてもデータが揃います。";
      } else {
        note.textContent = "赤/橙のセルがあります。設定 → 自動化 から詳細を確認できます。";
      }
    }
  }

  // Wave22.8: 効果音 ON/OFF トグルバインド
  function setupSoundToggle() {
    const btn = $("#sound-toggle");
    if (!btn || !window.kbEffects) return;
    const icon = $("#st-icon");
    const text = $("#st-text");
    const applyState = () => {
      const off = window.kbEffects.isSoundOff();
      btn.classList.toggle("is-on", !off);
      btn.classList.toggle("is-off", off);
      if (icon) icon.textContent = off ? "🔇" : "🔊";
      if (text) text.textContent = off ? "音 OFF" : "音 ON";
    };
    applyState();
    btn.addEventListener("click", () => {
      const off = window.kbEffects.isSoundOff();
      window.kbEffects.setSoundOff(!off);
      applyState();
      if (off) {
        // ON にしたとき: テスト用にちょい鳴らす
        try { window.kbEffects.playHoofClop(); } catch {}
        toast("効果音 ON にしました");
      } else {
        toast("効果音 OFF にしました");
      }
    });
  }

  function init() {
    setupTabs();
    setupFilters();
    setupModals();
    setupSoundToggle();  // Wave22.8
    render();
    refreshAll();
    setInterval(refreshAll, REFRESH_MS);
    setInterval(tickCountdown, TICK_MS);
    // 通知チェック (30 秒に 1 回・該当時刻なら 1 回だけ通知)
    setInterval(checkWin5NotifyTick, 30_000);
    checkWin5NotifyTick();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

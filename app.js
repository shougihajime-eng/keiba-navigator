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
  function fmtAge(sec) {
    if (sec == null || sec < 0) return "—";
    if (sec < 60) return `${Math.floor(sec)}秒`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}分`;
    const h = Math.floor(m / 60);
    return `${h}時間${m % 60}分`;
  }
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    t.style.animation = "none";
    t.offsetHeight;
    t.style.animation = "";
    setTimeout(() => { t.hidden = true; }, 3000);
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

  // ─── ティア判定 ─────────────────────────────────────────
  function tierOfRace(race) {
    const ev = race.topPick?.ev ?? null;
    const conf = race.confidence ?? 0;
    if (ev == null) return "none";
    if (ev >= 1.30 && conf >= 0.30) return "gold";
    if (ev >= 1.10) return "go";
    if (ev >= 0.95) return "cond";
    if (ev >= 0.80) return "best";
    return "none";
  }
  function tierTitle(t) {
    return {
      gold: "AI の絶好機予想 ★★★★ ・ 今日いちばん買う1点",
      go:   "AI の勝負予想 ★★★ ・ 本気で買う",
      cond: "AI の条件付き予想 ★★ ・ 慎重に",
      best: "AI のおすすめ ★ ・ 自信は控えめ",
      none: "今日は休む日 ・ 買う価値のあるレースがない",
    }[t] || "—";
  }
  function tierLabel(t) {
    return { gold: "絶好機", go: "勝負", cond: "条件付き", best: "ベター", none: "見送り" }[t] || "—";
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
  }

  function renderBuyCard(race, tier, sorted) {
    const card = el("div", { class: `decision-card tier-${tier} fade-in`, id: "decision-card" });
    const head = el("div", { class: "decision-head" });
    head.appendChild(el("div", { class: "decision-tier-label" }, tierTitle(tier)));
    const extraCnt = sorted.filter((r) => r !== race && (tierOfRace(r) === "gold" || tierOfRace(r) === "go")).length;
    if (extraCnt > 0) {
      head.appendChild(el("div", { class: "decision-tier-extra" }, `他に `, el("b", null, `+${extraCnt}R`)));
    }
    card.appendChild(head);

    const body = el("div", { class: "decision-body" });
    body.appendChild(el("div", { class: "decision-prelabel" },
      el("span", { class: "pl-bar" }),
      el("span", null, "AI の予想 — このレースを買おう")
    ));

    const headline = el("div", { class: "decision-headline" });
    const nameBlock = el("div", { class: "race-name-block" });
    if (race.isG1) nameBlock.appendChild(el("div", { class: "grade-badge grade-l" }, "G1"));
    const venueLabel = parseVenueLabel(race);
    nameBlock.appendChild(el("h2", { class: "venue-display" }, venueLabel.venue || "—"));
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

    const stats = el("div", { class: "bigstat-grid" });
    const ev = race.topPick.ev;
    const evTone = ev >= 1.5 ? "gold" : ev >= 1.1 ? "go" : ev >= 0.9 ? "ink" : "mute";
    const probPct = (race.topPick.prob ?? 0) * 100;
    const probTone = probPct >= 40 ? "go" : probPct >= 25 ? "warn" : "mute";
    const confPct = (race.confidence ?? 0) * 100;
    const confTone = confPct >= 60 ? "gold" : confPct >= 35 ? "go" : "mute";
    stats.appendChild(makeBigStat("期待値", `×${ev.toFixed(2)}`, evTone, true));
    stats.appendChild(makeBigStat("1着確率", `${probPct.toFixed(0)}%`, probTone, false));
    stats.appendChild(makeBigStat("AI 信頼度", `${confPct.toFixed(0)}%`, confTone, false));
    body.appendChild(stats);

    const reasons = buildReasons(race);
    if (reasons.length > 0) {
      const rb = el("div", { class: "reason-box" });
      rb.appendChild(el("div", { class: "label" }, "この1点で勝負する理由"));
      const ul = el("ul", { class: "reason-list" });
      reasons.slice(0, 3).forEach((r) =>
        ul.appendChild(el("li", null, el("span", { class: "arrow" }, "▸"), el("span", null, r))));
      rb.appendChild(ul);
      body.appendChild(rb);
    }

    const buyBox = buildBuyBox(race, tier);
    if (buyBox) body.appendChild(buyBox);

    const cta = el("div", { class: "cta-grid" });
    cta.appendChild(el("button", {
      class: tier === "gold" ? "btn-cta btn-cta-gold" : "btn-cta btn-cta-go",
      onclick: () => openDetailModal(race.raceId),
    }, "このレースの詳細を見る ▸"));
    cta.appendChild(el("button", {
      class: "btn-cta btn-cta-mute",
      onclick: () => quickAddBet(race),
    }, "+ 買った内容を記録する"));
    body.appendChild(cta);

    card.appendChild(body);
    return card;
  }

  function makeBigStat(label, value, tone, primary) {
    const wrap = el("div", { class: "bigstat" + (primary ? " primary" : "") });
    wrap.appendChild(el("div", { class: "label" }, label));
    wrap.appendChild(el("div", { class: `val tone-${tone}` }, value));
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
    head.appendChild(el("div", { class: "title" }, "このとおりに買おう"));
    const items = makeBuyItems(race);
    const total = items.reduce((a, x) => a + x.amount, 0);
    head.appendChild(el("div", { class: "total" }, "合計 ", el("b", null, `¥${fmtYen(total)}`)));
    box.appendChild(head);

    const ul = el("ul", { class: "buy-list" });
    items.forEach((it, i) => {
      const li = el("li", { class: "buy-item" + (i === 0 ? " is-main" : "") });
      li.appendChild(el("span", { class: "role" }, it.role));
      const combo = el("div", null);
      combo.appendChild(el("span", { class: "combo" }, it.combo));
      if (it.name) combo.appendChild(el("span", { class: "horse-name" }, it.name));
      li.appendChild(combo);
      const right = el("div", { class: "right" });
      right.appendChild(el("span", { class: "amount" }, `¥${fmtYen(it.amount)}`));
      if (it.odds) right.appendChild(el("span", { class: "odds" }, `${it.odds.toFixed(1)}倍`));
      if (it.ret) right.appendChild(el("span", { class: "return" }, `→ ¥${fmtYen(it.ret)}`));
      li.appendChild(right);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }

  function makeBuyItems(race) {
    const items = [];
    const tp = race.topPick, s2 = race.second, s3 = race.third;
    if (!tp) return items;
    const baseAmt = 500;
    items.push({
      role: "本命 単勝", combo: String(tp.number), name: tp.name || "",
      amount: baseAmt, odds: tp.odds,
      ret: tp.odds ? Math.round((baseAmt / 100) * tp.odds) : null,
    });
    items.push({ role: "押さえ 複勝", combo: String(tp.number), name: tp.name || "", amount: baseAmt, odds: null, ret: null });
    if (s2) {
      items.push({ role: "対抗 馬連", combo: `${tp.number}-${s2.number}`, name: s2.name || "", amount: baseAmt, odds: null, ret: null });
    }
    if (s3) {
      items.push({ role: "保険 ワイド", combo: `${tp.number}-${s3.number}`, name: s3.name || "", amount: baseAmt, odds: null, ret: null });
    }
    return items;
  }

  function renderNoBetCard(sorted) {
    const card = el("div", { class: "decision-card tier-none fade-in" });
    card.appendChild(el("div", { class: "decision-head" },
      el("div", { class: "decision-tier-label" }, "今日は買わない方が安全 ・ 期待値プラスの馬がいません")
    ));
    const body = el("div", { class: "decision-body" });
    body.appendChild(el("div", { html: `
      <div class="decision-prelabel"><span class="pl-bar"></span><span>AI の判定 — 本日は見送り推奨</span></div>
      <p style="text-align:center;font-size:28px;font-weight:900;line-height:1.2;margin:8px 0">
        今日は <span class="text-grad-sky">休む日</span> です
      </p>
      <p style="text-align:center;font-size:14px;color:var(--c-ink-soft)">
        ${sorted.length} レース解析しましたが、期待値が +0% を超える馬が見つかりませんでした。<br>
        無理に買わずに、過去の答え合わせを見て明日に備えましょう。
      </p>
    `}));
    if (sorted.length > 0) {
      const top = sorted[0];
      if (top.topPick) {
        const better = el("div", { class: "reason-box mt-3" });
        better.appendChild(el("div", { class: "label" }, "強いて挙げるなら"));
        const ul = el("ul", { class: "reason-list" });
        const vl = parseVenueLabel(top);
        ul.appendChild(el("li", null,
          el("span", { class: "arrow" }, "▸"),
          el("span", null, `${vl.venue || "?"} ${vl.raceNo || "?"}R: ${top.topPick.number}番 ${top.topPick.name || ""} (EV ×${(top.topPick.ev ?? 0).toFixed(2)})`)
        ));
        better.appendChild(ul);
        body.appendChild(better);
      }
    }
    card.appendChild(body);
    return card;
  }

  function renderNoRaceDay() {
    const card = el("div", { class: "decision-card tier-none fade-in" });
    card.appendChild(el("div", { class: "decision-head" },
      el("div", { class: "decision-tier-label" }, "本日 開催レース無し ・ AI は休憩中")
    ));
    const body = el("div", { class: "decision-body" });
    const featCount = state.racesLast?.learning?.lgbm?.feature_importance
      ? Object.keys(state.racesLast.learning.lgbm.feature_importance).length : "—";
    const auc = state.racesLast?.learning?.lgbm?.metrics?.auc;
    const aucPct = auc != null ? (auc * 100).toFixed(1) : "—";
    body.appendChild(el("div", { html: `
      <p style="text-align:center;font-size:30px;font-weight:900;margin:8px 0">
        今日は <span class="text-grad-turf">開催なし</span> の日
      </p>
      <p style="text-align:center;font-size:14px;color:var(--c-ink-soft);line-height:1.6">
        AI は明日のレースに備えて学習を続けています。<br>
        過去 ${featCount} の特徴量で<br>
        モデル精度 <b style="color:var(--c-deep)">${aucPct}%</b> を維持中。
      </p>
    `}));
    card.appendChild(body);
    return card;
  }

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

    // 5 レース本命
    if (Array.isArray(w5.perRace) && w5.perRace.length > 0 && w5.ok) {
      body.appendChild(el("div", { class: "sec-title" },
        el("span", { class: "bar gold" }),
        el("h2", null, "5 レースの本命")
      ));
      const races = el("div", { class: "win5-races" });
      w5.perRace.slice(0, 5).forEach((pr, i) => {
        const item = el("div", { class: "win5-race" });
        item.appendChild(el("div", { class: "label" }, `第${i+1}戦`));
        const topNum = pr.top1?.number ?? "—";
        const topName = pr.top1?.name ?? "";
        item.appendChild(el("div", { class: "horse" }, String(topNum)));
        item.appendChild(el("div", { class: "name" }, topName));
        races.appendChild(item);
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
      races = races.filter((r) => ["go", "gold"].includes(tierOfRace(r)));
    } else if (state.allRacesFilter === "gold") {
      races = races.filter((r) => tierOfRace(r) === "gold");
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
    const info = el("div", { class: "info" });
    const meta = el("div", { class: "meta" });
    const vl = parseVenueLabel(race);
    meta.appendChild(el("span", { class: "venue" }, vl.venue || "—"));
    if (vl.raceNo) meta.appendChild(el("span", { class: "race-no" }, `${vl.raceNo}R`));
    if (race.isG1) meta.appendChild(el("span", { class: "pill pill-gold" }, "G1"));
    if (race.surface) meta.appendChild(el("span", null, `${race.surface}${race.distance || ""}m`));
    info.appendChild(meta);
    const pick = el("div", { class: "pick" });
    if (race.topPick) {
      pick.appendChild(el("span", { class: "label-small" }, "本命"));
      pick.appendChild(el("span", { class: "horse-num" }, String(race.topPick.number)));
      if (race.topPick.name) pick.appendChild(el("span", { class: "horse-name" }, race.topPick.name));
      const opponents = [];
      if (race.second?.number) opponents.push(race.second.number);
      if (race.third?.number) opponents.push(race.third.number);
      if (opponents.length > 0) pick.appendChild(el("span", { class: "opponents" }, `→ ${opponents.join(", ")}`));
    } else {
      pick.appendChild(el("span", { class: "label-small" }, "出走馬データ準備中"));
    }
    info.appendChild(pick);
    row.appendChild(info);
    const ev = el("div", { class: "ev" });
    if (race.topPick?.ev != null) {
      ev.appendChild(el("div", { class: "num-big" }, `×${race.topPick.ev.toFixed(2)}`));
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
    root.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:auto">
        <line x1="${PAD.l}" y1="${yZero}" x2="${W-PAD.r}" y2="${yZero}" stroke="rgba(15,23,42,0.18)" stroke-width="1"/>
        <text x="${PAD.l-4}" y="${yZero+4}" text-anchor="end" font-size="10" fill="rgba(15,23,42,0.55)">0</text>
        <path d="${area}" fill="${c}" opacity="0.12"/>
        <path d="${path}" fill="none" stroke="${cGlow}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round" opacity="0.55"/>
        <path d="${path}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${xOf(pts.length-1)}" cy="${yOf(pts[pts.length-1].cum)}" r="5" fill="${c}"/>
      </svg>
      <div style="text-align:center;font-size:11px;color:var(--c-ink-soft);margin-top:6px">
        ${pts.length} 件 / 累計 <b style="color:${isPos ? 'var(--c-deep)' : 'var(--c-bad)'}">${pts[pts.length-1].cum >= 0 ? '+' : ''}${fmtYen(pts[pts.length-1].cum)}円</b>
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
      html += `<div class="runner-list">`;
      sortedH.slice(0, 18).forEach((h, idx) => {
        const rankCls = idx < 3 ? `rank-${idx + 1}` : "";
        const prob = h.pickInfo?.prob ? `${(h.pickInfo.prob * 100).toFixed(1)}%` : "—";
        const oddsVal = h.win_odds ?? h.odds ?? null;
        const odds = oddsVal != null ? `${Number(oddsVal).toFixed(1)}倍 (${h.popularity || "?"}人気)` : "—";
        const name = h.name || `${h.number}番`;
        const sub = [h.jockey, h.trainer, h.sex_age].filter(Boolean).join(" / ");
        html += `<div class="runner-item ${rankCls}">
          <div class="rank-no">${h.number}</div>
          <div>
            <div class="name">${escapeHtml(name)}</div>
            <div class="sub">${escapeHtml(sub)}</div>
          </div>
          <div class="prob">
            <div class="pct">${prob}</div>
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
    modal.hidden = false;
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
    toast("購入を記録しました");
    renderHistory();
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
    toast("結果を記録しました");
    renderHistory();
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
      renderAutostatus();
      renderMlStatus();
      renderRecommendations();
      renderDecisionCard();
      renderWin5();
      renderAllRaces();
      renderHistory();
    } catch (e) {
      console.error("[render] error", e);
    }
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

  // ─── 描画: 今日の推奨レース (Wave19) ─────────────────────
  // 100% 越え戦略 fuku_top1_prob_020 = AI 本命の確率 20% 以上で複勝 100 円
  // recommendations.json から today / recent を抽出して表示。
  function renderRecommendations() {
    const root = $("#recommend-mount");
    if (!root) return;
    const r = state.recommendations;
    if (!r || !r.ok) { root.hidden = true; return; }
    const stats = r.stats || {};
    const todayList = r.recommendations_today || [];
    const recentList = (r.recommendations_recent || []).filter(
      (x) => x.race_date !== r.todayJst,
    ).slice(0, 8);
    // 何も該当しないとき (今日もう開催なし or 推奨レースがない) もカード自体は出して、
    // 「今日は推奨レースなし (見送り推奨)」と明示する
    root.hidden = false;
    const fmtHorse = (h) => {
      const num  = h.number ?? "?";
      const name = h.name || "(名前未取得)";
      const prob = h.win_prob != null ? (h.win_prob * 100).toFixed(1) : "—";
      const odds = h.odds != null ? `${Number(h.odds).toFixed(1)} 倍` : "オッズ未取得";
      const pop  = h.popularity != null ? ` / 人気 ${h.popularity}` : "";
      return `${num} ${name}<span class="rec-hmeta">確率 ${prob}% / 単勝 ${odds}${pop}</span>`;
    };
    const renderItem = (it) => `
      <div class="rec-item">
        <div class="rec-race">
          <span class="rec-course">${it.course || "—"}</span>
          ${it.is_g1 ? '<span class="rec-g1">G1</span>' : ""}
          <span class="rec-race-name">${it.race_name || ""}</span>
        </div>
        <div class="rec-horse">${fmtHorse(it.horse || {})}</div>
        <div class="rec-action">
          <span class="rec-bet">複勝 100 円</span>
          <span class="rec-date">${it.race_date}${it.hassou_time ? ` ${it.hassou_time.slice(0,2)}:${it.hassou_time.slice(2,4)}発走` : ""}</span>
        </div>
      </div>
    `;
    root.innerHTML = `
      <div class="rec-head">
        <span class="rec-icon">★</span>
        <span class="rec-title">100% 越え戦略の自動推奨</span>
        <span class="rec-pill ${stats.roi_pct >= 100 ? 'is-go' : 'is-mute'}">
          ${stats.roi_pct ? `過去 ${stats.roi_pct}%` : "—"}
        </span>
      </div>
      <p class="rec-criteria">
        買い方: <b>${r.criteria?.label || "AI 本命の確率 20% 以上で複勝"}</b>
        <span class="rec-stats">
          過去 ${stats.test_races || 0} R で ${stats.fired_count || 0} 件発火・的中率 ${stats.hit_rate_pct || 0}%
        </span>
      </p>
      ${todayList.length > 0 ? `
        <div class="rec-section">
          <div class="rec-section-head">今日 (${r.todayJst}) の推奨</div>
          <div class="rec-list">${todayList.map(renderItem).join("")}</div>
        </div>
      ` : `
        <div class="rec-empty">
          今日 (${r.todayJst}) は条件を満たすレースが <b>0 件</b> です。<br>
          「絶対に分からない」レースは <b>見送り</b> が正解です。
        </div>
      `}
      ${recentList.length > 0 ? `
        <div class="rec-section">
          <div class="rec-section-head">直近の推奨レース 過去ログ (${recentList.length})</div>
          <div class="rec-list rec-list-small">${recentList.map(renderItem).join("")}</div>
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

  function init() {
    setupTabs();
    setupFilters();
    setupModals();
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

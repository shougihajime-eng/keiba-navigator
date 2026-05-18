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
      const [status, races, win5] = await Promise.all([
        api("/api/status"),
        api("/api/races"),
        api("/api/win5"),
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
      if (m) venue = m[1].replace(/[芝ダ障].*/, "");
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
    if (!w5 || !w5.ok || !w5.strategies) {
      const today = new Date();
      if (today.getDay() !== 0) {
        mount.innerHTML = "";
        return;
      }
      mount.innerHTML = "";
      const card = el("div", { class: "win5-card fade-in" });
      card.appendChild(el("div", { class: "win5-head" },
        el("div", { class: "title" }, "WIN5 — 日曜の祭り"),
        el("div", { class: "day" }, "データ準備中")
      ));
      card.appendChild(el("div", { class: "win5-body", html: `
        <p style="text-align:center;color:var(--c-ink-soft);font-size:14px;padding:16px 0">
          ${w5?.note || "WIN5 対象レース 5 つのデータがまだ揃っていません"}<br>
          <small>競馬場で発売が始まる土曜21:00 以降に表示されます</small>
        </p>
      `}));
      mount.appendChild(card);
      return;
    }

    mount.innerHTML = "";
    const card = el("div", { class: "win5-card fade-in" });
    card.appendChild(el("div", { class: "win5-head" },
      el("div", { class: "title" }, "WIN5 — 日曜の祭り (200円 で最大 6 億円)"),
      el("div", { class: "day" }, `信頼度 ${(w5.avgConfidence * 100).toFixed(0)}%`)
    ));
    const body = el("div", { class: "win5-body" });
    body.appendChild(el("div", { class: "sec-title" },
      el("span", { class: "bar gold" }),
      el("h2", null, "戦略を選ぼう (AI推奨にバッジ付き)")
    ));

    const stratsGrid = el("div", { class: "win5-strategies" });
    const strategies = [
      { key: "safe", name: "堅め", sub: "1×1×1×1×1 = 1点" },
      { key: "mid",  name: "中波", sub: "2^5 = 32点" },
      { key: "wide", name: "万舟", sub: "3^5 = 243点" },
    ];
    const rec = w5.recommended;
    strategies.forEach((s) => {
      const st = w5.strategies[s.key];
      if (!st) return;
      const c = el("div", { class: "win5-strategy" + (rec === s.key ? " is-recommended" : "") });
      if (rec === s.key) c.appendChild(el("div", { class: "rec-badge" }, "AI 推奨"));
      c.appendChild(el("div", { class: "name" }, s.name));
      c.appendChild(el("div", { class: "stake" }, `¥${fmtYen(st.totalCost)}`));
      c.appendChild(el("div", { class: "sub" }, s.sub));
      c.appendChild(el("div", { class: "sub" }, `期待 ¥${fmtYen(st.expectedReturn)} / EV ×${st.evRatio.toFixed(1)}`));
      stratsGrid.appendChild(c);
    });
    body.appendChild(stratsGrid);

    if (Array.isArray(w5.perRace) && w5.perRace.length > 0) {
      body.appendChild(el("div", { class: "sec-title" },
        el("span", { class: "bar gold" }),
        el("h2", null, "5 レースの本命")
      ));
      const races = el("div", { class: "win5-races" });
      w5.perRace.slice(0, 5).forEach((pr, i) => {
        const item = el("div", { class: "win5-race" });
        item.appendChild(el("div", { class: "label" }, `第${i+1}戦`));
        const topNum = pr.top1?.number ?? pr.picks?.[0]?.number ?? "—";
        const topName = pr.top1?.name ?? pr.picks?.[0]?.name ?? "";
        item.appendChild(el("div", { class: "horse" }, String(topNum)));
        item.appendChild(el("div", { class: "name" }, topName));
        races.appendChild(item);
      });
      body.appendChild(races);
    }

    card.appendChild(body);
    mount.appendChild(card);
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
          const lastCard = $$('.section-card').pop();
          if (lastCard) lastCard.scrollIntoView({ behavior: "smooth", block: "start" });
        } else if (tab === "add") {
          openAddBetModal();
        } else if (tab === "settings") {
          alert("設定画面は次のアップデートで追加されます");
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
    // 30 秒に 1 度 全レース行再描画 (締切表示の更新)
    if (Date.now() - lastAllRacesRender > 30000) {
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
      renderDecisionCard();
      renderWin5();
      renderAllRaces();
      renderHistory();
    } catch (e) {
      console.error("[render] error", e);
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

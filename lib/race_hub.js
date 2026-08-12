/* =====================================================================
   KEIBA NAVIGATOR — lib/race_hub.js
   「1レース＝1つのハブ画面＋タブ」(netkeiba 型の基本設計)

   公開: window.kbRaceHub.renderRaceHub(mountEl, ctx)

   ctx = {
     raceId,                     // レースの番号 (文字列)
     race,                       // /api/race の race (出走馬つき)
     conclusion,                 // /api/race の conclusion (無ければ null)
     fetchUmabashira: () => Promise,   // /api/umabashira?raceId=…
     fetchOddsHistory: () => Promise,  // まだ無ければ null を返してよい
     escapeHtml, scrubName,      // 既存ヘルパ (無ければ内蔵の予備を使う)
   }

   設計の約束:
     ・タブ「① 予想」が必ず最初に開く (一番見たいのは「何を買うか」)
     ・タブの中身は開いた時に初めて作る (最初の表示を待たせない)
     ・データが無いタブは「まだありません」と正直に出す (空のまま黙って見せない)
     ・数字や馬名をこのファイルで作らない (渡されたデータだけを表示する)
     ・position:sticky / dvh は使わない (アプリ全体ルール)
   ===================================================================== */
(function () {
  "use strict";

  // ─── 予備ヘルパ (ctx から本物が来ればそちらを使う) ──────────────
  function escFallback(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function scrubFallback(s, fallback) { return s || fallback || ""; }

  // "1830" / "18:30" → "18:30"。読めない形は null (勝手に作らない)
  function fmtHassou(t) {
    if (t == null) return null;
    const s = String(t).trim();
    if (/^\d{1,2}:\d{2}$/.test(s)) return s;
    if (/^\d{3,4}$/.test(s)) {
      const p = s.padStart(4, "0");
      return `${p.slice(0, 2)}:${p.slice(2, 4)}`;
    }
    return null;
  }

  // 0.272 → "27.2%" (無ければ "—")
  function pct(p, digits) {
    if (!Number.isFinite(p)) return "—";
    return `${(p * 100).toFixed(digits == null ? 1 : digits)}%`;
  }

  // 0.24 → "およそ4回に1回"
  function oneIn(rate) {
    if (!Number.isFinite(rate) || rate <= 0) return null;
    const n = Math.round(1 / rate);
    return n >= 2 ? `およそ${n}回に1回` : "2回に1回より多い見込み";
  }

  // "20260705" → "26.07.05"
  function fmtDate8(d) {
    const s = String(d || "");
    if (!/^\d{8}$/.test(s)) return s;
    return `${s.slice(2, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`;
  }

  // ISO日時 → "8/11 8:50 時点" (読めなければ null)
  function fmtStamp(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")} 時点`;
  }

  // ─── 本体 ──────────────────────────────────────────────
  function renderRaceHub(mountEl, ctx) {
    if (!mountEl) return null;
    ctx = ctx || {};
    const esc = typeof ctx.escapeHtml === "function" ? ctx.escapeHtml : escFallback;
    const scrub = typeof ctx.scrubName === "function" ? ctx.scrubName : scrubFallback;
    const race = ctx.race || {};
    const conc = (ctx.conclusion && ctx.conclusion.ok !== false) ? ctx.conclusion : null;
    const concRaw = ctx.conclusion || null;   // 判断不可でも理由は見せる
    const horses = Array.isArray(race.horses) ? race.horses : [];

    // 枠色つきの馬番チップ (JRA の枠色: 1白 2黒 3赤 4青 5黄 6緑 7橙 8桃)
    function numChip(frame, number) {
      const f = Math.min(8, Math.max(1, parseInt(frame, 10) || 1));
      return `<span class="rh-num rh-f${f}">${esc(number)}</span>`;
    }
    function horseByNumber(n) {
      return horses.find((h) => h.number === n) || null;
    }
    function chipFor(n) {
      const h = horseByNumber(n);
      return numChip(h ? h.frame : 0, n);
    }
    function empty(icon, title, note) {
      return `<div class="rh-empty"><div class="rh-empty-ico">${icon}</div>`
        + `<div class="rh-empty-title">${esc(title)}</div>`
        + (note ? `<div class="rh-empty-note">${esc(note)}</div>` : "")
        + `</div>`;
    }

    // ── タブ① 予想 (本命・買い目・締切) ─────────────────────
    function renderYoso() {
      let h = "";

      // 締切 (発走時刻)。データが無ければ正直にそう書く
      const hasso = fmtHassou(race.hassou_time || race.hassouTime || race.start_time);
      if (hasso) {
        h += `<div class="rh-deadline"><span class="rh-deadline-clock">🕐</span>`
          + `<b>${esc(hasso)} 発走</b><span class="rh-deadline-sub">投票の締切は発走の数分前です</span></div>`;
      } else {
        h += `<div class="rh-deadline rh-deadline-none">🕐 発走時刻のデータがありません</div>`;
      }

      if (!conc) {
        const reason = concRaw && concRaw.verdictReason ? concRaw.verdictReason : "";
        h += empty("◎", "予想はまだありません",
          reason || "予想のデータが届くと、ここに本命と買い目が出ます。");
        return h;
      }

      // 結論 (見送り/狙える 等)
      const passCls = conc.verdict === "pass" ? " rh-verdict-pass" : "";
      h += `<div class="rh-verdict${passCls}">`
        + `<div class="rh-verdict-head"><span class="rh-verdict-title">${esc(conc.verdictTitle || "—")}</span>`
        + (conc.confidenceLabel ? `<span class="rh-pill rh-pill-conf">${esc(conc.confidenceLabel)}</span>` : "")
        + `</div>`
        + (conc.verdictReason ? `<p class="rh-verdict-reason">${esc(conc.verdictReason)}</p>` : "")
        + `</div>`;

      if (conc.dataSource === "dummy") {
        h += `<div class="rh-warn">⚠ これは練習用のダミーデータです。本物のレースではありません。</div>`;
      }

      const picks = Array.isArray(conc.picks) ? conc.picks : [];
      const MARKS = [
        { mark: "◎", label: "本命", cls: "honmei" },
        { mark: "○", label: "対抗", cls: "taikou" },
        { mark: "▲", label: "単穴", cls: "tanana" },
      ];

      h += `<div class="rh-cards">`;

      // 印 (本命・対抗・単穴)
      h += `<section class="rh-card"><h3 class="rh-card-title">印 (この3頭が有力)</h3>`;
      if (!picks.length) {
        h += empty("◎", "今回は推せる馬がありません", "見送りのレースです。無理に買わないのも作戦のうちです。");
      } else {
        const maxProb = Math.max(0.01, ...picks.map((p) => p.prob || 0));
        h += `<ul class="rh-picks">`;
        picks.slice(0, 3).forEach((p, i) => {
          const m = MARKS[i] || { mark: "△", label: "", cls: "hold" };
          const barW = Math.max(4, Math.round(((p.prob || 0) / maxProb) * 100));
          const sub = [p.jockey, p.trainer].filter(Boolean).join(" / ");
          h += `<li class="rh-pick rh-pick-${m.cls}">`
            + `<span class="rh-mark">${m.mark}</span>`
            + `<span class="rh-mark-label">${m.label}</span>`
            + chipFor(p.number)
            + `<span class="rh-pick-name"><b>${esc(scrub(p.name, `${p.number}番`))}</b>`
            + (sub ? `<small>${esc(sub)}</small>` : "")
            + `</span>`
            + `<span class="rh-pick-nums"><b class="rh-prob">${pct(p.prob)}</b><small>勝つ見込み</small>`
            + (p.odds != null ? `<small class="rh-odds-s">単勝 ${esc(Number(p.odds).toFixed(1))}倍</small>` : "")
            + `</span>`
            + `<span class="rh-bar"><span class="rh-bar-fill" style="width:${barW}%"></span></span>`
            + (Number.isFinite(p.place) ? `<span class="rh-place-note">3着以内の見込み ${pct(p.place, 0)}</span>` : "")
            + `</li>`;
        });
        h += `</ul>`;
      }
      h += `</section>`;

      // 買い目
      h += `<section class="rh-card"><h3 class="rh-card-title">買い目 (買うならこれ)</h3>`;
      const bets = conc.bets || {};
      const rows = [];
      if (bets.tan) rows.push({ label: "単勝", body: bets.tan, note: "1着を当てる" });
      if (bets.fuku) rows.push({ label: "複勝", body: bets.fuku, note: "3着以内で当たり" });
      if (bets.uren) rows.push({ label: "馬連", body: bets.uren, note: "1・2着の2頭 (順不同)" });
      const ex = conc.exotic || null;
      if (ex && ex.wide && Array.isArray(ex.wide.pair)) {
        const r = ex.wide.rate;
        rows.push({ label: "ワイド", body: ex.wide.pair.join(" - "),
          note: Number.isFinite(r) ? `当たる見込み ${pct(r, 0)}${oneIn(r) ? ` (${oneIn(r)})` : ""}` : "" });
      }
      if (ex && ex.trio && Array.isArray(ex.trio.combo)) {
        const r = ex.trio.rate;
        rows.push({ label: "3連複", body: `${ex.trio.combo.join(" - ")} BOX`,
          note: Number.isFinite(r) ? `当たる見込み ${pct(r, 1)}${oneIn(r) ? ` (${oneIn(r)})` : ""}` : "" });
      }
      if (!rows.length) {
        h += empty("🎫", "今回は買い目がありません", "見送り推奨のレースか、オッズがまだ出ていません。");
      } else {
        h += `<ul class="rh-bets">`;
        for (const r of rows) {
          h += `<li class="rh-bet"><span class="rh-bet-type">${esc(r.label)}</span>`
            + `<span class="rh-bet-body">${esc(r.body)}</span>`
            + (r.note ? `<span class="rh-bet-note">${esc(r.note)}</span>` : "")
            + `</li>`;
        }
        h += `</ul>`;
        h += `<p class="rh-honest">※ 当たる見込みは過去の実測にもとづく推定です。馬券の払戻しは全体で約80%のため、買い続けると長い目では平均マイナスになります。</p>`;
      }
      h += `</section>`;

      h += `</div>`; // rh-cards
      return h;
    }

    // ── タブ② 出馬表 ─────────────────────────────────────
    function renderShutuba() {
      if (!horses.length) {
        return empty("📋", "出馬表はまだありません", "出走馬のデータが届くと、ここに一覧が出ます。");
      }
      const sorted = [...horses].sort((a, b) => (a.number || 0) - (b.number || 0));
      const hasResult = sorted.some((x) => Number(x.kakutei_jyuni) > 0);
      const hasOdds = sorted.some((x) => x.win_odds != null);
      let h = `<div class="rh-scroll"><table class="rh-tbl"><thead><tr>`
        + `<th>枠</th><th>馬番</th><th class="rh-left">馬名</th><th>性齢</th><th>斤量</th>`
        + `<th class="rh-left">騎手</th><th class="rh-left">調教師</th><th>馬体重</th><th>人気</th>`
        + (hasOdds ? `<th>単勝</th>` : "")
        + (hasResult ? `<th>着順</th>` : "")
        + `</tr></thead><tbody>`;
      for (const x of sorted) {
        const body = x.body_weight
          ? `${x.body_weight}${x.weight_diff != null ? `(${x.weight_diff > 0 ? "+" : ""}${x.weight_diff})` : ""}`
          : "—";
        const rank = Number(x.kakutei_jyuni) > 0 ? x.kakutei_jyuni : "—";
        const rkCls = rank === 1 ? " rh-r1" : rank === 2 ? " rh-r2" : rank === 3 ? " rh-r3" : "";
        h += `<tr>`
          + `<td>${esc(x.frame != null ? x.frame : "—")}</td>`
          + `<td>${numChip(x.frame, x.number)}</td>`
          + `<td class="rh-left"><b>${esc(scrub(x.name, `${x.number}番`))}</b></td>`
          + `<td>${esc(x.sex_age || "—")}</td>`
          + `<td>${esc(x.weight != null ? x.weight : "—")}</td>`
          + `<td class="rh-left">${esc(scrub(x.jockey, "—"))}</td>`
          + `<td class="rh-left">${esc(scrub(x.trainer, "—"))}</td>`
          + `<td>${esc(body)}</td>`
          + `<td>${esc(x.popularity != null ? `${x.popularity}` : "—")}</td>`
          + (hasOdds ? `<td>${x.win_odds != null ? esc(Number(x.win_odds).toFixed(1)) : "—"}</td>` : "")
          + (hasResult ? `<td class="rh-rank${rkCls}">${esc(rank)}</td>` : "")
          + `</tr>`;
      }
      h += `</tbody></table></div>`;
      h += `<p class="rh-note">横にすべらせると続きが見えます。</p>`;
      return h;
    }

    // ── タブ③ 馬柱 (過去走) ────────────────────────────────
    function renderUmabashira(data) {
      const rows = data && Array.isArray(data.rows) ? data.rows : [];
      if (!rows.length) {
        return empty("🐴", "馬柱はまだありません", "各馬の過去のレース記録が届くと、ここに出ます。");
      }
      let h = "";
      for (const row of rows) {
        const rec = row.record || {};
        const others = Math.max(0, (rec.starts || 0) - (rec.win || 0) - (rec.second || 0) - (rec.third || 0));
        h += `<div class="rh-umb">`;
        h += `<div class="rh-umb-head">${numChip(row.frame, row.number)}`
          + `<b class="rh-umb-name">${esc(scrub(row.name, `${row.number}番`))}</b>`
          + `<span class="rh-umb-sex">${esc(row.sexAge || "")}</span>`
          + (rec.starts ? `<span class="rh-umb-rec">${esc(rec.win)}-${esc(rec.second)}-${esc(rec.third)}-${esc(others)}</span>` : "")
          + `</div>`;
        if (!row.runs || !row.runs.length) {
          h += `<div class="rh-umb-none">${esc(row.historyNote || "過去走の記録がありません")}</div></div>`;
          continue;
        }
        h += `<div class="rh-scroll"><table class="rh-tbl rh-tbl-umb"><thead><tr>`
          + `<th>日付</th><th>場</th><th>距離</th><th>馬場</th><th>頭</th><th>人気</th><th>着順</th>`
          + `<th>タイム</th><th>上り</th><th>通過</th><th>斤量</th><th class="rh-left">騎手</th><th>馬体重</th>`
          + `</tr></thead><tbody>`;
        for (const r of row.runs) {
          const rk = Number(r.rank);
          const rkCls = rk === 1 ? " rh-r1" : rk === 2 ? " rh-r2" : rk === 3 ? " rh-r3" : "";
          h += `<tr>`
            + `<td>${esc(fmtDate8(r.date))}</td>`
            + `<td>${esc(r.venue || "—")}</td>`
            + `<td>${esc(r.courseLabel || "—")}</td>`
            + `<td>${esc(r.going || "—")}</td>`
            + `<td>${esc(r.fieldSize != null ? r.fieldSize : "—")}</td>`
            + `<td>${esc(r.popularity != null ? r.popularity : "—")}</td>`
            + `<td class="rh-rank${rkCls}">${esc(r.rankLabel != null ? r.rankLabel : (r.rank != null ? r.rank : "—"))}</td>`
            + `<td>${esc(r.time || "—")}</td>`
            + `<td>${esc(r.last3f != null ? r.last3f : "—")}</td>`
            + `<td>${esc(r.passing || "—")}</td>`
            + `<td>${esc(r.weight != null ? r.weight : "—")}</td>`
            + `<td class="rh-left">${esc(scrub(r.jockey, "—"))}</td>`
            + `<td>${esc(r.bodyLabel || "—")}</td>`
            + `</tr>`;
        }
        h += `</tbody></table></div></div>`;
      }
      h += `<p class="rh-note">このアプリが持っている記録だけを表示しています。横にすべらせると続きが見えます。</p>`;
      return h;
    }

    // ── タブ④ オッズ ─────────────────────────────────────
    function renderOdds(hist) {
      let h = "";
      const withOdds = horses.filter((x) => x.win_odds != null);
      h += `<section class="rh-card"><h3 class="rh-card-title">いまの単勝オッズ</h3>`;
      if (!withOdds.length) {
        h += empty("💹", "単勝オッズはまだ取得できていません", "オッズが出るのはレース当日です。届くとここに人気順で並びます。");
      } else {
        const sorted = [...withOdds].sort((a, b) => (a.popularity || 999) - (b.popularity || 999));
        h += `<div class="rh-scroll"><table class="rh-tbl"><thead><tr>`
          + `<th>人気</th><th>馬番</th><th class="rh-left">馬名</th><th>単勝</th></tr></thead><tbody>`;
        for (const x of sorted) {
          h += `<tr><td>${esc(x.popularity != null ? x.popularity : "—")}</td>`
            + `<td>${numChip(x.frame, x.number)}</td>`
            + `<td class="rh-left"><b>${esc(scrub(x.name, `${x.number}番`))}</b></td>`
            + `<td><b>${esc(Number(x.win_odds).toFixed(1))}</b>倍</td></tr>`;
        }
        h += `</tbody></table></div>`;
        const stamp = fmtStamp(race.last_updated);
        if (stamp) h += `<p class="rh-note">${esc(stamp)}のオッズです。</p>`;
      }
      h += `</section>`;

      // オッズの推移 (記録があるときだけ)
      h += `<section class="rh-card"><h3 class="rh-card-title">オッズの動き</h3>`;
      const snaps = Array.isArray(hist) ? hist : (hist && Array.isArray(hist.history) ? hist.history : null);
      if (!snaps || snaps.length === 0) {
        h += empty("📈", "オッズの動きの記録はまだありません", "当日にオッズを何回か取得すると、上がり下がりがここに出ます。");
      } else if (snaps.length === 1) {
        h += empty("📈", "記録が1回ぶんだけあります", "上がり下がりを出すには、もう1回以上の取得が必要です。");
      } else {
        const first = snaps[0], last = snaps[snaps.length - 1];
        const fo = first.odds || {}, lo = last.odds || {};
        const nums = Object.keys(lo).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
        if (!nums.length) {
          h += empty("📈", "オッズの動きの記録を読めませんでした", "記録の形が想定と違います。");
        } else {
          h += `<div class="rh-scroll"><table class="rh-tbl"><thead><tr>`
            + `<th>馬番</th><th class="rh-left">馬名</th><th>はじめ</th><th>いま</th><th>動き</th></tr></thead><tbody>`;
          for (const n of nums) {
            const a = Number(fo[n]), b = Number(lo[n]);
            const hHorse = horseByNumber(n);
            let move = "—", cls = "";
            if (Number.isFinite(a) && Number.isFinite(b) && a > 0) {
              const d = ((b - a) / a) * 100;
              if (d <= -3) { move = `↓ 売れている (${d.toFixed(0)}%)`; cls = " rh-move-down"; }
              else if (d >= 3) { move = `↑ ゆるんだ (+${d.toFixed(0)}%)`; cls = " rh-move-up"; }
              else move = "→ ほぼ同じ";
            }
            h += `<tr><td>${chipFor(n)}</td>`
              + `<td class="rh-left">${esc(scrub(hHorse && hHorse.name, `${n}番`))}</td>`
              + `<td>${Number.isFinite(a) ? esc(a.toFixed(1)) : "—"}</td>`
              + `<td>${Number.isFinite(b) ? esc(b.toFixed(1)) : "—"}</td>`
              + `<td class="rh-move${cls}">${esc(move)}</td></tr>`;
          }
          h += `</tbody></table></div>`;
          h += `<p class="rh-note">オッズが下がる＝その馬にお金が集まっている、というしるしです。</p>`;
        }
      }
      h += `</section>`;
      return h;
    }

    // ── タブ⑤ 根拠 ──────────────────────────────────────
    function renderKonkyo() {
      const reasons = (conc && Array.isArray(conc.reasonList)) ? conc.reasonList.filter(Boolean) : [];
      const meta = (conc && conc.raceMeta) || {};
      let h = "";
      if (!reasons.length && !meta.trackBiasNote && !meta.pacePrediction) {
        return empty("🔍", "根拠のデータはまだありません", "予想が計算されると、その理由がここに並びます。");
      }
      if (reasons.length) {
        h += `<section class="rh-card"><h3 class="rh-card-title">予想の理由</h3><ul class="rh-reasons">`;
        for (const r of reasons) h += `<li>${esc(r)}</li>`;
        h += `</ul></section>`;
      }
      const facts = [];
      if (meta.trackBiasNote) facts.push({ k: "馬場のかたより", v: meta.trackBiasNote });
      if (meta.pacePrediction) facts.push({ k: "ペース予想", v: meta.pacePrediction });
      if (conc && conc.predictor && conc.predictor.version) facts.push({ k: "計算モデル", v: `版 ${conc.predictor.version}` });
      if (meta.dataSource === "jv_link") facts.push({ k: "データの出どころ", v: "JRA-VAN (本物の公式データ)" });
      else if (meta.dataSource === "dummy") facts.push({ k: "データの出どころ", v: "練習用のダミーデータ" });
      const stamp = fmtStamp(meta.lastUpdated || race.last_updated);
      if (stamp) facts.push({ k: "データの新しさ", v: stamp });
      if (facts.length) {
        h += `<section class="rh-card"><h3 class="rh-card-title">前提にした情報</h3><dl class="rh-facts">`;
        for (const f of facts) h += `<div class="rh-fact"><dt>${esc(f.k)}</dt><dd>${esc(f.v)}</dd></div>`;
        h += `</dl></section>`;
      }
      return h;
    }

    // ─── タブの骨組み ─────────────────────────────────────
    const TABS = [
      { id: "yoso",   icon: "◎",  label: "予想",   render: () => renderYoso() },
      { id: "shutuba", icon: "📋", label: "出馬表", render: () => renderShutuba() },
      { id: "umabashira", icon: "🐴", label: "馬柱", lazy: true },
      { id: "odds",   icon: "💹", label: "オッズ", lazy: true },
      { id: "konkyo", icon: "🔍", label: "根拠",   render: () => renderKonkyo() },
    ];

    // 上のメタ帯 (コース・馬場・天気・頭数)
    function metaStrip() {
      const pills = [];
      if (race.is_g1) pills.push(`<span class="rh-pill rh-pill-g1">G1</span>`);
      if (race.course) {
        const cls = String(race.course).includes("ダ") ? "dirt" : String(race.course).includes("障") ? "shou" : "shiba";
        pills.push(`<span class="rh-pill rh-pill-${cls}">${esc(race.course)}</span>`);
      }
      if (race.going) pills.push(`<span class="rh-pill">馬場 ${esc(race.going)}</span>`);
      if (race.weather) pills.push(`<span class="rh-pill">${esc(race.weather)}</span>`);
      if (horses.length) pills.push(`<span class="rh-pill">${horses.length}頭</span>`);
      const hasso = fmtHassou(race.hassou_time || race.hassouTime || race.start_time);
      if (hasso) pills.push(`<span class="rh-pill rh-pill-time">🕐 ${esc(hasso)}</span>`);
      return pills.length ? `<div class="rh-meta">${pills.join("")}</div>` : "";
    }

    // 骨組みを描く
    const root = document.createElement("div");
    root.className = "rh-hub";
    let html = metaStrip();
    html += `<div class="rh-tabs" role="tablist" aria-label="レース情報の切り替え">`;
    TABS.forEach((t, i) => {
      html += `<button type="button" class="rh-tab${i === 0 ? " rh-tab-on" : ""}" role="tab" `
        + `id="rh-tab-${t.id}" aria-controls="rh-panel-${t.id}" aria-selected="${i === 0 ? "true" : "false"}" `
        + `tabindex="${i === 0 ? "0" : "-1"}" data-tab="${t.id}">`
        + `<span class="rh-tab-ico" aria-hidden="true">${t.icon}</span>`
        + `<span class="rh-tab-label">${t.label}</span></button>`;
    });
    html += `</div>`;
    TABS.forEach((t, i) => {
      html += `<div class="rh-panel" role="tabpanel" id="rh-panel-${t.id}" aria-labelledby="rh-tab-${t.id}"${i === 0 ? "" : " hidden"}></div>`;
    });
    root.innerHTML = html;
    mountEl.innerHTML = "";
    mountEl.appendChild(root);

    // 中身は「開いた時に初めて作る」
    const built = {};    // id → true (作成ずみ)
    const loading = {};  // id → true (読み込み中)

    function panelOf(id) { return root.querySelector(`#rh-panel-${id}`); }

    function buildPanel(id) {
      const tab = TABS.find((t) => t.id === id);
      const panel = panelOf(id);
      if (!tab || !panel || built[id] || loading[id]) return;
      if (!tab.lazy) {
        try { panel.innerHTML = tab.render(); }
        catch (e) { panel.innerHTML = empty("⚠", "この中身をうまく表示できませんでした", String(e && e.message || e)); }
        built[id] = true;
        return;
      }
      // 読み込みが要るタブ (馬柱・オッズ)
      loading[id] = true;
      panel.innerHTML = `<div class="rh-loading"><span class="rh-spinner" aria-hidden="true"></span>読み込み中…</div>`;
      const fetcher = id === "umabashira"
        ? (typeof ctx.fetchUmabashira === "function" ? ctx.fetchUmabashira : () => Promise.resolve(null))
        : (typeof ctx.fetchOddsHistory === "function" ? ctx.fetchOddsHistory : () => Promise.resolve(null));
      Promise.resolve()
        .then(() => fetcher())
        .then((data) => {
          loading[id] = false;
          built[id] = true;
          try {
            panel.innerHTML = id === "umabashira" ? renderUmabashira(data) : renderOdds(data);
          } catch (e) {
            panel.innerHTML = empty("⚠", "この中身をうまく表示できませんでした", String(e && e.message || e));
          }
        })
        .catch(() => {
          loading[id] = false;
          panel.innerHTML = `<div class="rh-empty"><div class="rh-empty-ico">⚠</div>`
            + `<div class="rh-empty-title">読み込みに失敗しました</div>`
            + `<div class="rh-empty-note">通信の調子が悪いかもしれません。</div>`
            + `<button type="button" class="rh-btn rh-retry" data-retry="${id}">もう一度読み込む</button></div>`;
        });
    }

    function activate(id) {
      for (const t of TABS) {
        const btn = root.querySelector(`#rh-tab-${t.id}`);
        const panel = panelOf(t.id);
        const on = t.id === id;
        if (btn) {
          btn.classList.toggle("rh-tab-on", on);
          btn.setAttribute("aria-selected", on ? "true" : "false");
          btn.setAttribute("tabindex", on ? "0" : "-1");
        }
        if (panel) panel.hidden = !on;
      }
      buildPanel(id);
    }

    // クリックと再試行 (まとめて受ける)
    root.addEventListener("click", (ev) => {
      const tabBtn = ev.target.closest(".rh-tab");
      if (tabBtn && root.contains(tabBtn)) { activate(tabBtn.dataset.tab); return; }
      const retryBtn = ev.target.closest(".rh-retry");
      if (retryBtn && root.contains(retryBtn)) {
        const id = retryBtn.dataset.retry;
        built[id] = false; loading[id] = false;
        buildPanel(id);
      }
    });

    // 矢印キーでもタブを移動できる
    root.querySelector(".rh-tabs").addEventListener("keydown", (ev) => {
      const idx = TABS.findIndex((t) => root.querySelector(`#rh-tab-${t.id}`) === document.activeElement);
      if (idx < 0) return;
      let next = -1;
      if (ev.key === "ArrowRight") next = (idx + 1) % TABS.length;
      else if (ev.key === "ArrowLeft") next = (idx - 1 + TABS.length) % TABS.length;
      else if (ev.key === "Home") next = 0;
      else if (ev.key === "End") next = TABS.length - 1;
      if (next >= 0) {
        ev.preventDefault();
        const id = TABS[next].id;
        activate(id);
        const btn = root.querySelector(`#rh-tab-${id}`);
        if (btn) btn.focus();
      }
    });

    // ① 予想 を即座に作る (既定で開いている)
    buildPanel("yoso");
    return root;
  }

  // 公開 (ブラウザ) + テスト用 (Node)
  if (typeof window !== "undefined") {
    window.kbRaceHub = { renderRaceHub };
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { renderRaceHub };
  }
})();

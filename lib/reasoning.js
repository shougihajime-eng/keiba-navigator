"use strict";

/*
 * lib/reasoning.js — AI の判断プロセスを「読める日本語」に翻訳する
 *
 * 入力: conclusion (lib/conclusion.js の戻り値)
 * 出力: { steps: [{title, body}], math: HTML文字列, share: { title, text } }
 *
 * 設計:
 * - 非エンジニアでも分かる「ステップ式の説明」を組み立てる
 * - 計算過程は「もっと見る」を開いた時だけ出す (情報過多にしない)
 * - シェア用テキストも一緒に組み立てる (Web Share API 用)
 */

function fmtEv(ev) {
  if (ev == null || !Number.isFinite(Number(ev))) return "--";
  const n = (Number(ev) - 1) * 100;
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(0)}%`;
}
function fmtPct(p) {
  if (p == null || !Number.isFinite(Number(p))) return "--";
  return (Number(p) * 100).toFixed(1) + "%";
}
function fmtOdds(o) {
  if (o == null || !Number.isFinite(Number(o))) return "--";
  return Number(o).toFixed(1) + "倍";
}

function gradeWords(g) {
  return ({
    "S": "S級 (最高クラス・強い買い候補)",
    "A": "A級 (買い候補)",
    "B": "B級 (小幅プラス候補)",
    "C": "C級 (慎重)",
    "D": "D級 (見送り推奨)",
  })[g] || "—";
}

function confWords(conf) {
  if (conf == null) return { word: "—", emoji: "⚪" };
  if (conf >= 0.5)  return { word: "とても高い", emoji: "🟢🟢" };
  if (conf >= 0.35) return { word: "高め",       emoji: "🟢" };
  if (conf >= 0.20) return { word: "中くらい",   emoji: "🟡" };
  return                  { word: "低い (データ不足)", emoji: "🔴" };
}

/**
 * conclusion から「読める考え方」を組み立てる
 * @param {Object} c - conclusion オブジェクト
 * @param {Object} [opts] - { calRatio: グレード別の補正係数 }
 */
function explain(c, opts = {}) {
  if (!c || !c.ok || !c.picks?.length) {
    return {
      steps: [
        {
          title: "判定できません",
          body: c?.verdictReason || "出走馬データが取得できていないため、根拠を組み立てられません。",
        },
      ],
      math: "",
      share: null,
    };
  }

  const top = c.picks[0];
  const conf = c.confidence;
  const cw = confWords(conf);
  const calRatio = opts.calRatio != null && Number.isFinite(opts.calRatio) ? opts.calRatio : null;
  const probRaw = top.prob;
  const probAdj = (calRatio && probRaw) ? probRaw * Math.min(1, calRatio) : probRaw;
  const evRaw = top.ev;
  const evAdj = (calRatio && evRaw != null) ? evRaw * calRatio : evRaw;
  const grade = top.grade;
  const popularity = top.popularity;
  const oddsTxt = fmtOdds(top.odds);

  // ─── ステップ群を組み立てる ──────────────────────────
  const steps = [];

  // 1. 出走馬の中で最も期待値が高い候補
  steps.push({
    title: "① まず全頭の期待値を計算",
    body: `${c.picks.length + (c.avoid?.length || 0)} 頭ぶんの 推定勝率 × オッズ を計算しました。<br>その中で <b>${top.number} ${top.name || ""}</b> の期待値が一番高い結果に。`,
  });

  // 2. 推定勝率の根拠
  let probBody;
  if (probRaw == null) {
    probBody = "推定勝率を計算できませんでした(オッズ/前走順位など、必要な情報が足りません)。";
  } else {
    const probTxt = fmtPct(probRaw);
    probBody = `この馬の<b>推定勝率は ${probTxt}</b>。`;
    if (top.jockey || top.trainer) {
      const extras = [];
      if (top.jockey) extras.push(`騎手「${top.jockey}」の過去成績`);
      if (top.trainer) extras.push(`調教師「${top.trainer}」の過去成績`);
      probBody += `<br>${extras.join("・")}も考慮しています。`;
    } else {
      probBody += `<br>(現モデルはヒューリスティック・前走順位とオッズ非依存の特徴量から算出)`;
    }
  }
  steps.push({
    title: "② 推定勝率",
    body: probBody,
  });

  // 3. オッズ × 勝率 = 期待値
  let evBody;
  if (top.odds == null || probRaw == null) {
    evBody = "オッズか勝率のどちらかが取れていないため、期待値が出ません。";
  } else {
    evBody = `<b>推定勝率 ${fmtPct(probRaw)} × オッズ ${oddsTxt}</b> = 期待値 <b>${fmtEv(evRaw)}</b><br>(プラスなら「賭けるほど長期で得」、マイナスなら「賭けるほど長期で損」)`;
  }
  steps.push({
    title: "③ オッズと組み合わせて期待値を出す",
    body: evBody,
  });

  // 4. 過去実績による補正 (calibration)
  if (calRatio != null) {
    if (Math.abs(calRatio - 1.0) > 0.05) {
      const dir = calRatio > 1.0 ? "上振れ" : "下振れ";
      const reason = calRatio > 1.0
        ? "このグレードの過去実績がモデル予想を上回っていたため、上方修正"
        : "このグレードの過去実績がモデル予想を下回っていたため、下方修正";
      steps.push({
        title: "④ 過去の実績で補正",
        body: `<b>グレード ${grade}</b> の自己校正係数 <b>×${calRatio.toFixed(2)}</b>(${dir}補正)<br>${reason} → 補正後の期待値 <b>${fmtEv(evAdj)}</b>`,
      });
    } else {
      steps.push({
        title: "④ 過去の実績で補正",
        body: `<b>グレード ${grade}</b> はモデル予想と実績がほぼ一致 (係数 ×${calRatio.toFixed(2)})。<br>そのまま採用 → 期待値 <b>${fmtEv(evAdj)}</b>`,
      });
    }
  } else {
    steps.push({
      title: "④ 過去の実績で補正",
      body: `グレード ${grade} の記録がまだ少なく、自己校正は未発動。<br>10 件以上溜まると、ここで上下に補正が入るようになります。`,
    });
  }

  // 5. 信頼度
  steps.push({
    title: "⑤ 信頼度の見立て",
    body: `${cw.emoji} <b>${cw.word}</b>(${conf == null ? "—" : (conf * 100).toFixed(0) + "%"})<br>${c.confidenceLabel || ""}`,
  });

  // 6. 結論
  const verdictHuman = ({
    "go": "🟢 狙えるレース",
    "neutral": "🟡 少額ならあり",
    "pass": "🔴 見送り推奨",
  })[c.verdict] || c.verdictTitle || "—";
  let finalBody = `判定: <b>${verdictHuman}</b><br>${c.verdictReason || ""}`;
  if (popularity != null) {
    if (popularity >= 6 && (evAdj ?? evRaw ?? 0) >= 1.10) finalBody += "<br>※ 穴目で美味しいパターンです。";
    if (popularity <= 2 && (evAdj ?? evRaw ?? 0) < 1.00)  finalBody += "<br>※ 上位人気ですが、オッズが見合っていません。";
  }
  steps.push({
    title: "⑥ 結論",
    body: finalBody,
  });

  // ─── 計算の中身 (詳細表示用) ─────────────────────────
  const mathLines = [];
  mathLines.push(`<div><span class="rm-k">候補</span> ${top.number} <b>${top.name || ""}</b></div>`);
  if (probRaw != null)  mathLines.push(`<div><span class="rm-k">推定勝率</span> <code>${fmtPct(probRaw)}</code></div>`);
  if (top.odds != null) mathLines.push(`<div><span class="rm-k">オッズ</span> <code>${oddsTxt}</code></div>`);
  if (evRaw != null)    mathLines.push(`<div><span class="rm-k">期待値 (生)</span> <code>${(evRaw).toFixed(3)}</code> → ${fmtEv(evRaw)}</div>`);
  if (calRatio != null) mathLines.push(`<div><span class="rm-k">校正係数</span> <code>×${calRatio.toFixed(3)}</code></div>`);
  if (calRatio != null && evAdj != null) mathLines.push(`<div><span class="rm-k">期待値 (校正後)</span> <code>${evAdj.toFixed(3)}</code> → ${fmtEv(evAdj)}</div>`);
  if (popularity != null) mathLines.push(`<div><span class="rm-k">人気</span> ${popularity}番人気</div>`);
  if (grade)              mathLines.push(`<div><span class="rm-k">EVグレード</span> ${grade} (${gradeWords(grade)})</div>`);
  if (conf != null)       mathLines.push(`<div><span class="rm-k">信頼度</span> ${(conf * 100).toFixed(0)}%</div>`);
  if (c.predictor)        mathLines.push(`<div><span class="rm-k">使用モデル</span> ${c.predictor.name} v${c.predictor.version}</div>`);

  // ─── シェア用テキスト ─────────────────────────────
  const evDisp = evAdj != null ? fmtEv(evAdj) : fmtEv(evRaw);
  const shareText =
    `[KEIBA NAVIGATOR の AI 判定]\n` +
    `${c.raceMeta?.raceName ? c.raceMeta.raceName + "\n" : ""}` +
    `🎯 ${top.number} ${top.name || ""} (${oddsTxt})\n` +
    `期待値 ${evDisp} / グレード ${grade} / ${verdictHuman}\n` +
    `信頼度: ${cw.word}`;

  return {
    steps,
    math: mathLines.join(""),
    share: {
      title: "KEIBA NAVIGATOR の AI 判定",
      text: shareText,
    },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { explain, gradeWords, confWords, fmtEv, fmtPct, fmtOdds };
}
if (typeof window !== "undefined") {
  window.KNReasoning = { explain, gradeWords, confWords, fmtEv, fmtPct, fmtOdds };
}

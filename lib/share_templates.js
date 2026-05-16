"use strict";

/**
 * KEIBA NAVIGATOR — シェアテンプレート集 (Wave12.1)
 *
 * 用途別の文言と長さで 4 種類のテンプレートを用意し、1 タップで切替えてシェアできるようにする。
 *
 * テンプレ:
 *   short      ── 1 行サマリ (X / Bluesky など文字数制限ありの SNS 向け)
 *   tweet      ── Tweet 用 (馬+EV+結論を 140 字以内に圧縮 + ハッシュタグ)
 *   line       ── LINE 用 (改行多めの読みやすいレイアウト)
 *   detail     ── 詳細 (狙う / 押さえ / 見送りの理由を含むフル版)
 *
 * 公開 API:
 *   ShareTemplates.list -> [{id, label, desc}]
 *   ShareTemplates.format(conclusion, id) -> string
 *   ShareTemplates.openShare(conclusion, id) -> Promise (Web Share API)
 */
(function (global) {
  const LIST = [
    { id: "short",  label: "📝 短文",   desc: "1 行 (Bluesky・X など)" },
    { id: "tweet",  label: "🐦 ツイート", desc: "140 字以内 + ハッシュタグ" },
    { id: "line",   label: "💬 LINE",   desc: "読みやすい改行レイアウト" },
    { id: "detail", label: "📋 詳細",   desc: "狙う/押さえ/見送り 全部" },
  ];

  function _pickText(p) {
    if (!p) return "—";
    const ev = Number.isFinite(p.ev) ? `EV${p.ev >= 1 ? "+" : ""}${((p.ev - 1) * 100).toFixed(0)}%` : "";
    return `${p.number || "?"}番 ${p.name || ""}${ev ? " (" + ev + ")" : ""}`;
  }

  function _verdictText(c) {
    const v = c?.verdict;
    if (v === "buy" || v === "go") return "🟢 狙う";
    if (v === "pass" || v === "skip") return "🔴 見送り";
    return "🟡 様子見";
  }

  function _short(c) {
    const top = c?.picks?.[0];
    const name = c?.raceName || c?.race_name || c?.raceMeta?.raceName || "";
    return `${_verdictText(c)} ${name ? name + " / " : ""}本命 ${_pickText(top)} [KEIBA NAVIGATOR]`;
  }

  function _tweet(c) {
    const top = c?.picks?.[0];
    const name = c?.raceName || c?.race_name || "";
    const verdict = _verdictText(c);
    const star = c?.confidence != null ? "★".repeat(Math.round(c.confidence * 5)) + "☆".repeat(5 - Math.round(c.confidence * 5)) : "";
    return [
      `🤖 AI 予想`,
      `${verdict} ${name}`,
      `本命: ${_pickText(top)}`,
      star ? `信頼度: ${star}` : "",
      `#KEIBA #競馬 #AI予想`,
    ].filter(Boolean).join("\n").slice(0, 140);
  }

  function _line(c) {
    const top = c?.picks?.[0];
    const alt = c?.picks?.slice(1, 3) || [];
    const name = c?.raceName || c?.race_name || "今日のレース";
    const verdict = _verdictText(c);
    const lines = [
      `━━━━━━━━━━`,
      `🏇 ${name}`,
      `━━━━━━━━━━`,
      `判定: ${verdict}`,
      `本命: ${_pickText(top)}`,
    ];
    if (alt.length) {
      lines.push(`対抗: ${alt.map(_pickText).join(" / ")}`);
    }
    if (c?.confidence != null) {
      lines.push(`信頼度: ${(c.confidence * 100).toFixed(0)}%`);
    }
    lines.push("", "(KEIBA NAVIGATOR — 買わないAI)");
    return lines.join("\n");
  }

  function _detail(c) {
    const top = c?.picks?.[0];
    const alt = c?.picks?.slice(1, 3) || [];
    const danger = c?.avoid?.[0] || c?.overpopular?.[0];
    const under = c?.undervalued?.[0];
    const name = c?.raceName || c?.race_name || "今日のレース";

    const lines = [
      `【KEIBA NAVIGATOR の予想】`,
      ``,
      `■ レース: ${name}`,
      `■ 判定: ${_verdictText(c)}`,
      `■ 信頼度: ${c?.confidence != null ? (c.confidence * 100).toFixed(0) + "%" : "—"}`,
      ``,
      `▶ 本命: ${_pickText(top)}`,
    ];
    if (top?.reason) lines.push(`   理由: ${top.reason}`);
    if (alt.length) {
      lines.push(``);
      lines.push(`▷ 対抗: ${alt.map(_pickText).join(" / ")}`);
    }
    if (under) {
      lines.push(``);
      lines.push(`★ 穴注目: ${_pickText(under)}`);
    }
    if (danger) {
      lines.push(``);
      lines.push(`⚠ 危険な人気: ${_pickText(danger)}`);
    }
    lines.push(``);
    lines.push(`※ 期待値計算ベースの「買わないAI」の判定です。`);
    lines.push(`※ 必ず的中する馬券はありません。長期で回収率100%超を目指す設計。`);
    return lines.join("\n");
  }

  function format(conclusion, id) {
    switch (id) {
      case "short":  return _short(conclusion);
      case "tweet":  return _tweet(conclusion);
      case "line":   return _line(conclusion);
      case "detail": return _detail(conclusion);
      default:       return _short(conclusion);
    }
  }

  async function openShare(conclusion, id) {
    const text = format(conclusion, id);
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: "KEIBA NAVIGATOR 予想", text });
        return { ok: true, mode: "share" };
      } catch (e) {
        // ユーザがキャンセル or 共有 API 拒否 → クリップボードへフォールバック
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, mode: "clipboard", text };
    } catch {
      return { ok: false, error: "share/clipboard 両方失敗", text };
    }
  }

  global.ShareTemplates = { list: LIST, format, openShare };
})(typeof window !== "undefined" ? window : globalThis);

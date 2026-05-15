"use strict";

/*
 * lib/share_image.js — シェア用の綺麗な画像をその場で生成 (Canvas)
 *
 * 1080x1080 (Twitter/Instagram シェア向き) のカードを生成。
 * AI 判定の主役(top pick)を主題に、グレード・期待値・信頼度を一覧で。
 *
 * 仕様:
 * - 純粋クライアントサイド (外部依存ゼロ)
 * - HiDPI を意識した内部解像度
 * - フォント: Inter + Noto Sans JP (CSS で既に読み込み済み)
 * - 出力: Blob / DataURL
 */

(function () {
  if (typeof window === "undefined") return;

  const W = 1080, H = 1080;

  function evGrade(ev) {
    if (!Number.isFinite(ev)) return "-";
    if (ev >= 1.30) return "S";
    if (ev >= 1.10) return "A";
    if (ev >= 1.00) return "B";
    if (ev >= 0.85) return "C";
    return "D";
  }
  function gradeColor(g) {
    return ({
      "S": "#34d399",
      "A": "#10b981",
      "B": "#fbbf24",
      "C": "#f59e0b",
      "D": "#ef4444",
    })[g] || "#94a3b8";
  }
  function fmtEv(ev) {
    if (!Number.isFinite(Number(ev))) return "--";
    const n = (Number(ev) - 1) * 100;
    return `${n >= 0 ? "+" : ""}${n.toFixed(0)}%`;
  }

  /**
   * @param {Object} conclusion - lib/conclusion.js の戻り値
   * @returns {Promise<HTMLCanvasElement>}
   */
  async function generate(conclusion) {
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");

    // ─── 背景: メッシュグラデ ───────────────────────────
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0f1424");
    bg.addColorStop(1, "#0a0e1a");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 上に緑の radial グロー
    const glow1 = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, W * 0.7);
    glow1.addColorStop(0, "rgba(16,185,129,0.20)");
    glow1.addColorStop(1, "rgba(16,185,129,0)");
    ctx.fillStyle = glow1; ctx.fillRect(0, 0, W, H);

    // 右下に青のグロー
    const glow2 = ctx.createRadialGradient(W, H, 0, W, H, W * 0.6);
    glow2.addColorStop(0, "rgba(59,130,246,0.18)");
    glow2.addColorStop(1, "rgba(59,130,246,0)");
    ctx.fillStyle = glow2; ctx.fillRect(0, 0, W, H);

    // 左上ロゴ
    const padX = 60;
    ctx.fillStyle = "#34d399";
    ctx.font = "900 36px 'Inter', 'Noto Sans JP', sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText("◆ KEIBA NAVIGATOR", padX, 60);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "500 18px 'Inter', 'Noto Sans JP', sans-serif";
    ctx.fillText("買わない AI · 期待値で判定", padX, 108);

    // ─── 主役カード ─────────────────────────────────────
    if (!conclusion?.ok || !conclusion.picks?.length) {
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "800 60px 'Inter', 'Noto Sans JP', sans-serif";
      ctx.fillText("判定できません", padX, H / 2 - 30);
      ctx.fillStyle = "#64748b";
      ctx.font = "500 24px 'Inter', 'Noto Sans JP', sans-serif";
      ctx.fillText("レースデータが取得できていません", padX, H / 2 + 40);
      return canvas;
    }

    const top = conclusion.picks[0];
    const grade = top.grade || evGrade(top.ev);
    const gc = gradeColor(grade);

    // レース名
    if (conclusion.raceMeta?.raceName) {
      ctx.fillStyle = "#cbd5e1";
      ctx.font = "700 26px 'Noto Sans JP', sans-serif";
      ctx.fillText(conclusion.raceMeta.raceName.slice(0, 26), padX, 180);
    }

    // 大判の馬番
    const numCx = padX + 220;
    const numCy = 460;
    ctx.beginPath(); ctx.arc(numCx, numCy, 180, 0, Math.PI * 2);
    const numFill = ctx.createRadialGradient(numCx - 40, numCy - 60, 20, numCx, numCy, 200);
    numFill.addColorStop(0, gc + "B0");
    numFill.addColorStop(1, gc + "30");
    ctx.fillStyle = numFill;
    ctx.fill();
    ctx.strokeStyle = gc + "FF";
    ctx.lineWidth = 6;
    ctx.stroke();

    ctx.fillStyle = "#0a0e1a";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = "900 220px 'Inter', sans-serif";
    ctx.fillText(String(top.number), numCx, numCy);
    ctx.textAlign = "left"; ctx.textBaseline = "top";

    // 馬名
    if (top.name) {
      ctx.fillStyle = "#f1f5f9";
      ctx.font = "900 52px 'Noto Sans JP', sans-serif";
      ctx.fillText(top.name.slice(0, 16), padX + 440, 380);
    }
    // オッズ + 人気
    if (top.odds != null) {
      ctx.fillStyle = "#cbd5e1";
      ctx.font = "700 32px 'Inter', 'Noto Sans JP', sans-serif";
      const oddsTxt = `${Number(top.odds).toFixed(1)} 倍${top.popularity ? "  ·  " + top.popularity + "番人気" : ""}`;
      ctx.fillText(oddsTxt, padX + 440, 460);
    }
    // 期待値バッジ
    const evX = padX + 440, evY = 530;
    const evW = 280, evH = 80;
    ctx.fillStyle = gc;
    roundRect(ctx, evX, evY, evW, evH, 16); ctx.fill();
    ctx.fillStyle = "#0a0e1a";
    ctx.font = "900 38px 'Inter', sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(`期待値 ${fmtEv(top.ev)}`, evX + evW / 2, evY + evH / 2);
    ctx.textAlign = "left"; ctx.textBaseline = "top";

    // グレード大判
    ctx.fillStyle = gc;
    ctx.font = "900 220px 'Inter', sans-serif";
    ctx.textAlign = "right"; ctx.textBaseline = "top";
    ctx.fillText(grade, W - padX, 360);
    ctx.textAlign = "left"; ctx.textBaseline = "top";

    // ─── 下部: 信頼度 + 結論 ────────────────────────────
    const lineY = 720;
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padX, lineY); ctx.lineTo(W - padX, lineY); ctx.stroke();

    // 信頼度ラベル + バー
    ctx.fillStyle = "#94a3b8";
    ctx.font = "600 22px 'Noto Sans JP', sans-serif";
    ctx.fillText("信頼度", padX, lineY + 40);

    const conf = Math.max(0, Math.min(1, Number(conclusion.confidence) || 0));
    // 5 つの星 (信頼度 0〜1 を 0〜5 に)
    const stars = Math.round(conf * 5);
    ctx.font = "900 60px 'Inter', sans-serif";
    let starsTxt = "";
    for (let i = 0; i < 5; i++) starsTxt += i < stars ? "★" : "☆";
    ctx.fillStyle = "#fbbf24";
    ctx.fillText(starsTxt, padX + 150, lineY + 22);

    // 結論ラベル
    const verdictTxt = ({
      "go": "🎯 狙えるレース",
      "neutral": "⚠ 少額ならあり",
      "pass": "🛑 見送り推奨",
    })[conclusion.verdict] || conclusion.verdictTitle || "—";

    ctx.fillStyle = "#94a3b8";
    ctx.font = "600 22px 'Noto Sans JP', sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("結論", W - padX - 200, lineY + 40);
    ctx.fillStyle = "#f1f5f9";
    ctx.font = "900 38px 'Noto Sans JP', sans-serif";
    ctx.fillText(verdictTxt, W - padX, lineY + 70);
    ctx.textAlign = "left";

    // ─── フッタ ──────────────────────────────────────
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath(); ctx.moveTo(padX, H - 130); ctx.lineTo(W - padX, H - 130); ctx.stroke();
    ctx.fillStyle = "#475569";
    ctx.font = "500 18px 'Inter', 'Noto Sans JP', sans-serif";
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    ctx.fillText(dateStr, padX, H - 80);
    ctx.textAlign = "right";
    ctx.fillStyle = "#64748b";
    ctx.fillText("keiba-navigator.vercel.app", W - padX, H - 80);
    ctx.textAlign = "left";

    return canvas;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  async function asBlob(conclusion) {
    const canvas = await generate(conclusion);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  async function asDataUrl(conclusion) {
    const canvas = await generate(conclusion);
    return canvas.toDataURL("image/png");
  }

  async function download(conclusion, filename) {
    const blob = await asBlob(conclusion);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || `keiba_nav_${Date.now()}.png`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
  }

  /**
   * Web Share API でファイル付きシェア (対応端末のみ)、フォールバックはダウンロード
   */
  async function share(conclusion) {
    const blob = await asBlob(conclusion);
    if (!blob) return { ok: false, error: "blob 生成失敗" };
    const file = new File([blob], `keiba_nav_${Date.now()}.png`, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          title: "KEIBA NAVIGATOR の AI 判定",
          text: "私の AI の判定です",
          files: [file],
        });
        return { ok: true };
      } catch (e) {
        if (e?.name !== "AbortError") return { ok: false, error: e.message || String(e) };
        return { ok: false, aborted: true };
      }
    }
    // フォールバック: ダウンロード
    await download(conclusion);
    return { ok: true, downloaded: true };
  }

  window.KNShareImage = { generate, asBlob, asDataUrl, download, share };
})();

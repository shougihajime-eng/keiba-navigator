// Phase 2 用の簡易反省文ジェネレータ
// Phase 4 で構造化タグ付き本実装に置き換える

import type { Bet } from "@/lib/store";

const REASON_TEMPLATES = [
  "重馬場適性を軽視。本命馬は良馬場限定の脚質だった可能性。",
  "前走の着差を過大評価。距離変更で力を発揮しきれず。",
  "人気馬の地力を見誤った。期待値計算の信頼度を再調整したい。",
  "ペース想定が外れた。前残り想定が後方有利のペースに変わった。",
  "騎手の重み付けが甘かった。乗り替わりでの過大評価かも。",
  "馬体重の変化を見落とした。直近の調子をもっと重視すべき。",
];

export function reflectionFor(bet: Bet): string {
  if (!bet) return "";
  const seed =
    (bet.id?.length || 0) +
    (bet.raceId?.length || 0) +
    Math.floor((Date.parse(bet.createdAt || "") / 86400000) || 0);
  const tpl = REASON_TEMPLATES[seed % REASON_TEMPLATES.length];
  const evHint = bet.ev
    ? `予想 EV ${bet.ev.toFixed(2)} だったが外れ。`
    : "";
  return `${evHint}${tpl} 次回は同条件で重み調整を検討する。`;
}

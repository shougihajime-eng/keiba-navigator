// Phase 4: 構造化反省文の自動生成
// 外したレースの特徴量から、なぜ外したかをタグ付きで推定する

import type { Bet } from "@/lib/store";
import type { RaceSummary } from "@/types/api";

export type MissTag =
  | "track_condition"      // 馬場適性
  | "distance_misjudge"    // 距離適性
  | "weight_overestimate"  // 斤量・負担を過大評価
  | "pace_misread"         // ペース想定外れ
  | "jockey_overweight"    // 騎手の重み付け過大
  | "horse_form_drop"      // 馬の調子下降
  | "prevrun_overweight"   // 前走を過大評価
  | "popularity_under"     // 人気馬の地力を過小評価
  | "popularity_over"      // 人気馬を過大評価
  | "field_quality"        // メンバー構成
  | "post_position"        // 枠順
  | "weather_change"       // 天候・馬場変化
  | "pedigree_misread"     // 血統適性
  | "confidence_too_high"  // 信頼度を過大に見積もった
  | "unknown";             // 特定不能

export type StructuredReflection = {
  id: string;
  betId: string;
  raceId?: string;
  raceName?: string;
  course?: string;
  tags: MissTag[];
  freeText: string;
  weightSuggestion?: Record<string, string>; // e.g., { track_condition_weight: "+0.05" }
  createdAt: string;
};

const TAG_LABELS: Record<MissTag, string> = {
  track_condition:     "馬場適性を軽視",
  distance_misjudge:   "距離適性を見誤った",
  weight_overestimate: "斤量・負担を過大評価",
  pace_misread:        "ペース想定が外れた",
  jockey_overweight:   "騎手の重み付け過大",
  horse_form_drop:     "馬の調子下降を見落とし",
  prevrun_overweight:  "前走の着差を過大評価",
  popularity_under:    "人気馬の地力を過小評価",
  popularity_over:     "人気馬を過大評価",
  field_quality:       "メンバー構成の見落とし",
  post_position:       "枠順の影響を軽視",
  weather_change:      "天候・馬場変化に対応できず",
  pedigree_misread:    "血統適性の判断が甘かった",
  confidence_too_high: "信頼度を過大に見積もった",
  unknown:             "原因特定が難しい外れ",
};

export function tagLabel(tag: MissTag): string {
  return TAG_LABELS[tag];
}

export function allTagLabels(): { tag: MissTag; label: string }[] {
  return (Object.entries(TAG_LABELS) as [MissTag, string][])
    .map(([tag, label]) => ({ tag, label }));
}

/**
 * Bet + RaceSummary から構造化反省を推定生成
 * 確定情報が無い時は freeText のみ
 */
export function generateReflection(bet: Bet, race?: RaceSummary | null): StructuredReflection {
  const tags: MissTag[] = [];

  if (race) {
    // EV が高かったのに外れた → 信頼度過大評価の疑い
    if ((bet.ev ?? 0) >= 1.2) tags.push("confidence_too_high");

    // 重馬場・不良馬場 → track_condition
    // race.surface だけでは情報不足だが、注釈から検出
    const note = (race.trackBiasNote || "").toLowerCase();
    if (note.includes("重") || note.includes("不良") || note.includes("track")) {
      tags.push("track_condition");
    }
    if (note.includes("先行") || note.includes("差し") || note.includes("逃げ") || note.includes("pace")) {
      tags.push("pace_misread");
    }

    // 人気被り注意フラグが立っていた → popularity_over
    if (race.hasOverpop) tags.push("popularity_over");
    // 過小評価馬がいた → popularity_under (本命と違う馬が来た可能性)
    if (race.hasUnderval) tags.push("popularity_under");

    // 距離・コースの特殊 → distance_misjudge
    if (race.distance && (race.distance >= 2400 || race.distance <= 1200)) {
      tags.push("distance_misjudge");
    }
  }

  if (tags.length === 0) tags.push("unknown");

  const evHint = bet.ev ? `予想 EV ${bet.ev.toFixed(2)} だったが外れ。` : "";
  const tagLines = tags.map((t) => `• ${TAG_LABELS[t]}`).join("\n");
  const freeText = `${evHint}\n推定原因:\n${tagLines}\n次回は同条件でこれらの重みを再調整する。`;

  // 学習用 重み調整ヒント
  const weightSuggestion: Record<string, string> = {};
  for (const t of tags) {
    const key = `${t}_weight`;
    weightSuggestion[key] = "+0.03"; // 今は固定。Phase 4 v3+ で実際の調整に
  }

  return {
    id: `refl_${bet.id}_${Date.now()}`,
    betId: bet.id,
    raceId: bet.raceId,
    raceName: bet.raceName,
    course: bet.course,
    tags,
    freeText,
    weightSuggestion,
    createdAt: new Date().toISOString(),
  };
}

/** 1行サマリ (BlockB で表示用) */
export function reflectionSummary(r: StructuredReflection): string {
  if (r.tags.length === 0) return "原因特定中";
  return r.tags.slice(0, 2).map((t) => TAG_LABELS[t]).join(" · ");
}

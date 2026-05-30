import type { RaceSummary } from "@/types/api";

export type Rating = 1 | 2 | 3 | 4 | 5;

/**
 * 期待値の冷まし倍率 (必殺一号艇の ev-calibration を移植)
 * 生EV(AI勝率×オッズ)を、過去に実際そういう馬を買って戻ってきた割合に冷ます。
 * 競馬の検証(8ヶ月3593R)では実回収率 約67〜81%。穴馬(高オッズ)ほど買われ過ぎで強く冷ます。
 * jv_bridge/honest_ev.py の _COOL_BANDS と同じ値。
 */
export function coolFactor(odds?: number | null): number {
  if (odds == null || odds <= 1) return 0.7;
  if (odds < 1.5) return 0.75;
  if (odds < 3) return 0.74;
  if (odds < 7) return 0.76;
  if (odds < 15) return 0.74;
  if (odds < 30) return 0.66;
  if (odds < 70) return 0.55;
  return 0.42;
}

/** 生EVを実績ベースに冷ました「正直な期待値」。100円が現実的に何円戻るかの見込み。 */
export function cooledEv(race: RaceSummary): number {
  const ev = race.topPick?.ev ?? 0;
  const odds = race.topPick?.odds ?? null;
  return Math.round(ev * coolFactor(odds) * 100) / 100;
}

/**
 * 必殺一号艇方式の判定を 5段階の星に対応。
 *   5: 絶好機 (本命が堅く・冷まし後も妙味が残る稀なレース)
 *   4: 勝負  (本命が抜けて堅い・複勝向き)  ← これ以上が「買うなら候補」
 *   3: 様子見 (堅めだが抜けてはいない)
 *   2: 参考  (五分・お買い得なし)
 *   1: 見送り (荒れ/過剰人気/狙い無し)
 *
 * 「堅さ」は AI本命の勝率(topPick.prob) か 信頼度(confidence) のうち取れる方で測る。
 */
export function ratingFromRace(race: RaceSummary): Rating {
  const dominance = race.topPick?.prob ?? race.confidence ?? 0;
  const odds = race.topPick?.odds ?? null;
  const hev = cooledEv(race);

  // 過剰人気(配当が安すぎ)は妙味なしで見送り
  if (odds != null && odds < 1.8) return 1;

  const reliable = dominance >= 0.2; // 本命が抜けて堅い (実測で3着内 約70%)
  if (reliable && hev >= 0.95) return 5; // 絶好機: 堅い + 冷まし後も妙味
  if (reliable) return 4; // 勝負
  if (dominance >= 0.16) return 3; // 様子見
  if (hev >= 0.7) return 2; // 参考
  return 1; // 見送り
}

export function isBettable(race: RaceSummary): boolean {
  return ratingFromRace(race) >= 4;
}

export function ratingLabelFromRace(race: RaceSummary): string {
  const r = ratingFromRace(race);
  return ["見送り", "参考", "様子見", "勝負", "絶好機"][r - 1];
}

/** 評価の高い順 → 同点は冷ましEVの高い順 */
export function sortByRating(races: RaceSummary[]): RaceSummary[] {
  return [...races].sort((a, b) => {
    const ra = ratingFromRace(a);
    const rb = ratingFromRace(b);
    if (ra !== rb) return rb - ra;
    return cooledEv(b) - cooledEv(a);
  });
}

/** 1-2 行で説明する根拠文 (30文字目安) */
export function shortReason(race: RaceSummary): string {
  const rating = ratingFromRace(race);
  const num = race.topPick?.number;
  if (rating >= 4) {
    return `本命${num != null ? `${num}番` : ""}が抜けて堅い・買うなら複勝向き`;
  }
  const parts: string[] = [];
  if (race.isG1) parts.push("G1");
  if (race.hasOverpop) parts.push("本命が人気被りで妙味薄");
  const surface = race.surface === "turf" ? "芝" : race.surface === "dirt" ? "ダ" : "";
  if (surface && race.distance) parts.push(`${surface}${race.distance}m`);
  if (parts.length === 0) parts.push("狙いを絞れない・見送り推奨");
  return parts.join(" · ");
}

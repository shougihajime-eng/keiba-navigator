import type { RaceSummary } from "@/types/api";

export type Rating = 1 | 2 | 3 | 4 | 5;

/**
 * EV と AI 信頼度から 5段階評価を算出
 *   5: 絶好機 (EV >= 1.30 + 信頼度高)
 *   4: 勝負  (EV >= 1.15)
 *   3: 条件付 (EV >= 1.05)
 *   2: 参考  (EV >= 0.95)
 *   1: 見送り (EV < 0.95)
 */
export function ratingFromRace(race: RaceSummary): Rating {
  const ev = race.topPick?.ev ?? 0;
  const conf = race.confidence ?? 0;
  const grade = race.topGrade || race.topPick?.grade || "";

  if (grade === "ultra" || (ev >= 1.30 && conf >= 0.30)) return 5;
  if (grade === "prime" || ev >= 1.15) return 4;
  if (grade === "go"    || ev >= 1.05) return 3;
  if (ev >= 0.95) return 2;
  return 1;
}

export function isBettable(race: RaceSummary): boolean {
  return ratingFromRace(race) >= 4;
}

export function ratingLabelFromRace(race: RaceSummary): string {
  const r = ratingFromRace(race);
  return ["見送り", "参考", "条件付", "勝負", "絶好機"][r - 1];
}

/** EV >= 1.0 のレースだけ抽出して評価順にソート */
export function sortByRating(races: RaceSummary[]): RaceSummary[] {
  return [...races].sort((a, b) => {
    const ra = ratingFromRace(a);
    const rb = ratingFromRace(b);
    if (ra !== rb) return rb - ra;
    const ea = a.topPick?.ev ?? 0;
    const eb = b.topPick?.ev ?? 0;
    return eb - ea;
  });
}

/** 1-2 行で説明する根拠文 (30文字目安) */
export function shortReason(race: RaceSummary): string {
  const parts: string[] = [];
  if (race.isG1) parts.push("G1");
  if (race.hasUnderval) parts.push("過小評価馬あり");
  if (race.hasOverpop) parts.push("人気被り注意");
  const surface = race.surface === "turf" ? "芝" : race.surface === "dirt" ? "ダ" : "";
  if (surface && race.distance) parts.push(`${surface}${race.distance}m`);
  if (race.trackBiasNote) parts.push(race.trackBiasNote);
  return parts.join(" · ");
}

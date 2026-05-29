import { GallopHorse } from "./icons/GallopHorse";

/**
 * TurfBackdrop — 画面のいちばん奥に敷く「ターフ（芝）を走る馬」の背景。
 * 全ページの後ろ(z=-1)に固定。文字の上には被らないので読みやすさは維持。
 * 馬は左から右へ流れ、上下にギャロップで弾む。
 * 大きさ・速さ・濃さ・高さを変えて、群れで走っているように見せる。
 */
export function TurfBackdrop() {
  const runners = ["lead", "near", "mid", "back", "far"] as const;
  return (
    <div className="turf-backdrop" aria-hidden="true">
      {/* 奥の芝の帯 */}
      <div className="turf-band" />
      {/* 走る馬たち */}
      {runners.map((r) => (
        <div key={r} className={`turf-runner turf-runner--${r}`}>
          <span className="turf-gallop">
            <GallopHorse className="h-full w-full" />
          </span>
        </div>
      ))}
    </div>
  );
}

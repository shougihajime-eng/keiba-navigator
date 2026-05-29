import { GallopHorse } from "./icons/GallopHorse";

/**
 * TurfBackdrop — 画面のいちばん奥に敷く「ターフ（芝）を走る馬」の背景。
 * 全ページの後ろ(z-0)に固定。文字の読みやすさを壊さないよう、ごく薄い緑で。
 * 馬は左から右へゆっくり流れ、上下にギャロップで弾む。
 */
export function TurfBackdrop() {
  return (
    <div className="turf-backdrop" aria-hidden="true">
      {/* 奥の芝の帯 */}
      <div className="turf-band" />
      {/* 走る馬たち（大きさ・速さ・濃さを変えて奥行きを出す） */}
      <div className="turf-runner turf-runner--far">
        <span className="turf-gallop">
          <GallopHorse className="h-full w-full" />
        </span>
      </div>
      <div className="turf-runner turf-runner--mid">
        <span className="turf-gallop">
          <GallopHorse className="h-full w-full" />
        </span>
      </div>
      <div className="turf-runner turf-runner--near">
        <span className="turf-gallop">
          <GallopHorse className="h-full w-full" />
        </span>
      </div>
    </div>
  );
}

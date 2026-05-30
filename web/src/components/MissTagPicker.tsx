"use client";

import { cn } from "@/lib/utils";
import { allTagLabels, type MissTag } from "@/lib/reflection";

interface Props {
  selected: MissTag[];
  onChange: (tags: MissTag[]) => void;
  /** よく使う理由だけに絞る (true なら全部出す) */
  showAll?: boolean;
}

// 競馬で「外した理由」としてよくあるものを上位に
const COMMON: MissTag[] = [
  "popularity_over",     // 人気馬を過大評価
  "popularity_under",    // 人気薄が来た(地力を過小評価)
  "pace_misread",        // ペースが想定外
  "track_condition",     // 馬場が合わなかった
  "distance_misjudge",   // 距離が合わなかった
  "horse_form_drop",     // 調子が下降
  "confidence_too_high", // 自信を持ちすぎた
  "post_position",       // 枠順が不利
];

/** 外した理由をタップで選ぶ (複数可)。選ぶほど反省が賢くなる。 */
export function MissTagPicker({ selected, onChange, showAll = false }: Props) {
  const all = allTagLabels();
  const list = showAll
    ? all
    : all.filter((t) => COMMON.includes(t.tag)).sort(
        (a, b) => COMMON.indexOf(a.tag) - COMMON.indexOf(b.tag),
      );

  const toggle = (tag: MissTag) => {
    if (selected.includes(tag)) onChange(selected.filter((t) => t !== tag));
    else onChange([...selected, tag]);
  };

  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map(({ tag, label }) => {
        const on = selected.includes(tag);
        return (
          <button
            key={tag}
            type="button"
            onClick={() => toggle(tag)}
            aria-pressed={on}
            className={cn(
              "px-2.5 py-1.5 rounded-full text-xs font-medium border transition-colors",
              on
                ? "border-wine bg-wine text-white"
                : "border-line bg-paper-soft text-ink-soft hover:border-wine/40",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

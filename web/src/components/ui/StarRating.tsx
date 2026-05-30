import { cn } from "@/lib/utils";

type Size = "sm" | "md" | "lg" | "xl";

interface StarRatingProps {
  rating: 1 | 2 | 3 | 4 | 5;
  size?: Size;
  className?: string;
  showLabel?: boolean;
}

const sizeMap: Record<Size, { star: string; gap: string; label: string }> = {
  sm: { star: "w-3.5 h-3.5", gap: "gap-[2px]",  label: "text-[11px]" },
  md: { star: "w-5 h-5",     gap: "gap-[3px]",  label: "text-xs"     },
  lg: { star: "w-7 h-7",     gap: "gap-[4px]",  label: "text-sm"     },
  xl: { star: "w-10 h-10",   gap: "gap-[6px]",  label: "text-base"   },
};

/**
 * Star rating — 金/銀のグラデ・上品な質感
 * 5: 金 (絶好機)
 * 4: 金 (勝負)
 * 3: 銀 (条件付)
 * 2: 銀 (参考)
 * 1: グレー (見送り)
 */
export function StarRating({ rating, size = "md", className, showLabel = false }: StarRatingProps) {
  const sz = sizeMap[size];
  const stars = [1, 2, 3, 4, 5].map((i) => i <= rating);
  const tone =
    rating >= 4 ? "gold" : rating >= 2 ? "silver" : "mute";

  return (
    <span
      className={cn("inline-flex items-center", sz.gap, className)}
      role="img"
      aria-label={`評価 ${rating} / 5`}
    >
      {stars.map((filled, idx) => (
        <Star
          key={idx}
          filled={filled}
          tone={tone}
          className={sz.star}
        />
      ))}
      {showLabel && (
        <span className={cn("ml-2 font-medium tabular", sz.label, "text-ink-muted")}>
          {rating}.0
        </span>
      )}
    </span>
  );
}

function Star({
  filled,
  tone,
  className,
}: {
  filled: boolean;
  tone: "gold" | "silver" | "mute";
  className?: string;
}) {
  const fillColor =
    tone === "gold"   ? "url(#starGold)"   :
    tone === "silver" ? "url(#starSilver)" :
                        "#C2D4BF";
  const strokeColor =
    tone === "gold"   ? "#E8920C" :
    tone === "silver" ? "#677A6C" :
                        "#A0AEA2";

  return (
    <svg
      viewBox="0 0 24 24"
      className={cn(className, filled && tone === "gold" && "anim-twinkle")}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="starGold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stopColor="#FFD27A" />
          <stop offset="52%" stopColor="#F5A623" />
          <stop offset="100%" stopColor="#D67E00" />
        </linearGradient>
        <linearGradient id="starSilver" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stopColor="#CBD8C8" />
          <stop offset="55%" stopColor="#93A597" />
          <stop offset="100%" stopColor="#677A6C" />
        </linearGradient>
      </defs>
      <path
        d="M12 2.6l2.95 5.97 6.6.96-4.78 4.66 1.13 6.57L12 17.66l-5.9 3.1 1.13-6.57L2.45 9.53l6.6-.96L12 2.6Z"
        fill={filled ? fillColor : "#14201A"}
        stroke={filled ? strokeColor : "#32453B"}
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Label text for ratings (e.g., 絶好機 / 勝負 / 様子見 / 参考 / 見送り) */
export function ratingLabel(rating: 1 | 2 | 3 | 4 | 5): string {
  return ["見送り", "参考", "様子見", "勝負", "絶好機"][rating - 1];
}

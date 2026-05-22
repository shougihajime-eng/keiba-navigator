import { cn } from "@/lib/utils";

interface StatProps {
  label: string;
  value: string | number;
  unit?: string;
  tone?: "default" | "positive" | "negative" | "gold" | "ink-blue";
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  sub?: string;
}

const toneMap = {
  default:    "text-ink",
  positive:   "text-deep-green",
  negative:   "text-wine",
  gold:       "text-gold-deep",
  "ink-blue": "text-ink-blue",
};

const sizeMap = {
  sm: { value: "text-lg",       label: "text-[11px]" },
  md: { value: "text-2xl",      label: "text-xs" },
  lg: { value: "text-3xl",      label: "text-xs" },
  xl: { value: "text-5xl md:text-6xl", label: "text-sm" },
};

/** Apple 風の上品な数値表示 — 等幅フォントで美しく揃う */
export function Stat({
  label,
  value,
  unit,
  tone = "default",
  size = "md",
  className,
  sub,
}: StatProps) {
  const sz = sizeMap[size];
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className={cn(sz.label, "uppercase tracking-[0.08em] font-medium text-ink-muted")}>
        {label}
      </span>
      <span className={cn(sz.value, toneMap[tone], "font-display tabular leading-none")}>
        {value}
        {unit && (
          <span className="text-[60%] ml-1 font-normal text-ink-muted">{unit}</span>
        )}
      </span>
      {sub && <span className="text-xs text-ink-muted">{sub}</span>}
    </div>
  );
}

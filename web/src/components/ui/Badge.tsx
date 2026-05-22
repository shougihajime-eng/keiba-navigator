import { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Tone =
  | "neutral"
  | "tentative"
  | "final"
  | "won"
  | "lost"
  | "gold"
  | "silver"
  | "info";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  size?: "xs" | "sm" | "md";
}

const toneMap: Record<Tone, string> = {
  neutral:   "bg-paper-soft text-ink-soft border border-line",
  tentative: "bg-ink-blue-soft text-ink-blue border border-ink-blue/15",
  final:     "bg-ruby-soft text-ruby border border-ruby/20",
  won:       "bg-deep-green-soft text-deep-green border border-deep-green/15",
  lost:      "bg-wine-soft text-wine border border-wine/15",
  gold:      "bg-gold-soft text-gold-deep border border-gold/30",
  silver:    "bg-silver-soft text-silver-deep border border-silver/30",
  info:      "bg-paper-soft text-ink-muted border border-line",
};

const sizeMap = {
  xs: "px-1.5 py-0.5 text-[10px] rounded-md font-medium",
  sm: "px-2 py-0.5 text-xs rounded-md font-medium",
  md: "px-2.5 py-1 text-xs rounded-md font-medium",
};

export function Badge({ tone = "neutral", size = "sm", className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 tracking-tight",
        toneMap[tone],
        sizeMap[size],
        className,
      )}
      {...rest}
    />
  );
}

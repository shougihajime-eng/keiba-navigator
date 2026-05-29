import { cn } from "@/lib/utils";
import { Horseshoe } from "@/components/icons/Horseshoe";

interface LogoProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeMap = {
  sm: { badge: "w-8 h-8", icon: "w-4 h-4",  text: "text-base", sub: "text-[10px]" },
  md: { badge: "w-10 h-10", icon: "w-5 h-5",  text: "text-xl",   sub: "text-[11px]" },
  lg: { badge: "w-12 h-12", icon: "w-6 h-6",  text: "text-2xl",  sub: "text-xs" },
};

export function Logo({ size = "md", className }: LogoProps) {
  const sz = sizeMap[size];
  return (
    <div className={cn("inline-flex items-center gap-2.5", className)}>
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-[12px] text-white shrink-0",
          "bg-gradient-to-b from-[#16A35A] to-deep-green shadow-[0_6px_16px_rgba(14,140,74,0.30)]",
          sz.badge,
        )}
      >
        <Horseshoe className={cn(sz.icon, "text-white")} />
      </span>
      <div className="flex flex-col leading-none">
        <span className={cn(sz.text, "font-display font-semibold tracking-tight text-ink")}>
          KEIBA
          <span className="ml-1 text-deep-green font-bold">NAVIGATOR</span>
        </span>
        <span className={cn(sz.sub, "text-ink-muted mt-1 tracking-wide")}>
          買わない勇気の競馬予想
        </span>
      </div>
    </div>
  );
}

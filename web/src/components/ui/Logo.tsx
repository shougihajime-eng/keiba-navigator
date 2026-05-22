import { cn } from "@/lib/utils";
import { Horseshoe } from "@/components/icons/Horseshoe";

interface LogoProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeMap = {
  sm: { icon: "w-5 h-5",  text: "text-base", sub: "text-[10px]" },
  md: { icon: "w-7 h-7",  text: "text-xl",   sub: "text-xs" },
  lg: { icon: "w-9 h-9",  text: "text-2xl",  sub: "text-xs" },
};

export function Logo({ size = "md", className }: LogoProps) {
  const sz = sizeMap[size];
  return (
    <div className={cn("inline-flex items-center gap-2.5", className)}>
      <Horseshoe className={cn(sz.icon, "text-gold-deep")} />
      <div className="flex flex-col leading-none">
        <span className={cn(sz.text, "font-display font-semibold tracking-tight")}>
          KEIBA
          <span className="ml-1 text-gold-deep font-normal">NAVIGATOR</span>
        </span>
        <span className={cn(sz.sub, "text-ink-muted mt-0.5 tracking-wider")}>
          Long-term EV {">"} 1.0
        </span>
      </div>
    </div>
  );
}

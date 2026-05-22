import { cn } from "@/lib/utils";
import { RunningHorse } from "@/components/icons/RunningHorse";

interface HorseLoaderProps {
  label?: string;
  className?: string;
}

/** ローディング — 馬が横に走る・モノクロ */
export function HorseLoader({ label = "読み込み中…", className }: HorseLoaderProps) {
  return (
    <div className={cn("flex flex-col items-center gap-3 py-8", className)} role="status">
      <div className="relative w-48 h-10 overflow-hidden">
        <div className="absolute inset-x-0 bottom-0 h-px bg-line" />
        <div className="absolute inset-y-0 left-0 anim-horse-run">
          <RunningHorse className="w-12 h-7 text-ink-soft" />
        </div>
      </div>
      <span className="text-xs text-ink-muted tracking-wide">{label}</span>
    </div>
  );
}

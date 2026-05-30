"use client";

import { ReactNode, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface CollapsibleProps {
  icon?: ReactNode;
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  badge?: ReactNode;
  children: ReactNode;
  tone?: "neutral" | "gold" | "info";
  /** 他の場所からこのセクションを開きたい時の合言葉。
   *  window に CustomEvent("keiba:open-section", { detail: openOn }) が来たら
   *  自動で開いてここまでスクロールする。 */
  openOn?: string;
}

const toneMap = {
  neutral: "border-line",
  gold:    "border-gold/30",
  info:    "border-ink-blue/20",
};

export function Collapsible({
  icon,
  title,
  hint,
  defaultOpen = false,
  badge,
  children,
  tone = "neutral",
  openOn,
}: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openOn) return;
    const onOpen = (e: Event) => {
      if ((e as CustomEvent).detail !== openOn) return;
      setOpen(true);
      // 開いた直後にスクロール (描画を待ってから)
      requestAnimationFrame(() => {
        rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    };
    window.addEventListener("keiba:open-section", onOpen);
    return () => window.removeEventListener("keiba:open-section", onOpen);
  }, [openOn]);

  return (
    <div
      ref={rootRef}
      className={cn(
        "bg-paper rounded-[16px] border transition-shadow scroll-mt-20",
        toneMap[tone],
        open ? "shadow-[var(--shadow-sm)]" : "shadow-[var(--shadow-xs)]",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "w-full flex items-center justify-between gap-3 px-5 py-4 text-left",
          "transition-colors duration-150",
          "hover:bg-paper-hover/40 rounded-[16px]",
        )}
      >
        <span className="flex items-center gap-3 min-w-0">
          {icon && <span className="text-ink-soft shrink-0">{icon}</span>}
          <span className="flex flex-col min-w-0">
            <span className="font-display font-semibold tracking-tight text-base">
              {title}
            </span>
            {hint && (
              <span className="text-xs text-ink-muted truncate">{hint}</span>
            )}
          </span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {badge}
          <ChevronDown
            className={cn(
              "w-4 h-4 text-ink-muted transition-transform duration-300",
              open && "rotate-180",
            )}
          />
        </span>
      </button>
      {open && (
        <div className="px-5 pb-5 pt-1 anim-fade-up border-t border-line/60">
          {children}
        </div>
      )}
    </div>
  );
}

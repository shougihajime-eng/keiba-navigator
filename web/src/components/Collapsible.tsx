"use client";

import { ReactNode, useState } from "react";
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
}: CollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className={cn(
        "bg-paper rounded-[16px] border transition-shadow",
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

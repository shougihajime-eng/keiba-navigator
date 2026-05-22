"use client";

import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "ruby" | "gold";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const variantStyles: Record<Variant, string> = {
  primary:
    "bg-ink text-paper hover:bg-ink-soft active:bg-ink shadow-[var(--shadow-xs)]",
  secondary:
    "bg-paper text-ink border border-line hover:bg-paper-hover active:bg-paper-soft",
  ghost:
    "bg-transparent text-ink-soft hover:bg-paper-hover active:bg-paper-soft",
  ruby:
    "bg-ruby text-paper hover:bg-wine active:bg-ruby shadow-[var(--shadow-sm)]",
  gold:
    "bg-gold text-ink hover:bg-gold-deep active:bg-gold shadow-[var(--shadow-sm)]",
};

const sizeStyles: Record<Size, string> = {
  sm: "h-9 px-3 text-sm rounded-[10px]",
  md: "h-11 px-5 text-[15px] rounded-[12px]",
  lg: "h-14 px-7 text-base rounded-[14px] font-medium",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, className, children, disabled, onClick, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      onClick={(e) => {
        e.currentTarget.classList.remove("anim-gate-out");
        // Restart animation
        void e.currentTarget.offsetWidth;
        e.currentTarget.classList.add("anim-gate-out");
        onClick?.(e);
      }}
      className={cn(
        "inline-flex items-center justify-center gap-2",
        "font-medium tracking-tight",
        "transition-all duration-150 ease-out",
        "disabled:opacity-50 disabled:pointer-events-none",
        "hover:scale-[1.015] active:scale-[0.985]",
        variantStyles[variant],
        sizeStyles[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
      ) : (
        children
      )}
    </button>
  );
});

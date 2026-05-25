import { HTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";

type CardTone = "default" | "tentative" | "final" | "won" | "lost" | "gold";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: CardTone;
  elevated?: boolean;
  interactive?: boolean;
}

const toneStyles: Record<CardTone, string> = {
  default:   "bg-paper border-line",
  tentative: "bg-paper border-ink-blue/25 ring-1 ring-ink-blue/10",
  final:     "bg-paper border-ruby/35 ring-1 ring-ruby/15",
  won:       "bg-paper border-deep-green/30 ring-1 ring-deep-green/12",
  lost:      "bg-paper border-wine/25 ring-1 ring-wine/10",
  gold:      "bg-gradient-to-b from-[#1A2418] to-paper border-gold/45 ring-1 ring-gold/20 shadow-[var(--shadow-gold)]",
};

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { tone = "default", elevated = false, interactive = false, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-[16px] border transition-all duration-200",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
        toneStyles[tone],
        elevated && "shadow-[var(--shadow-md),inset_0_1px_0_rgba(255,255,255,0.05)]",
        !elevated && tone === "default" && "shadow-[var(--shadow-xs),inset_0_1px_0_rgba(255,255,255,0.04)]",
        interactive &&
          "cursor-pointer hover:-translate-y-0.5 hover:shadow-[var(--shadow-md),inset_0_1px_0_rgba(255,255,255,0.06)] active:scale-[0.995]",
        className,
      )}
      {...rest}
    />
  );
});

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pt-5 pb-3", className)} {...rest} />;
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-4", className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pb-5 pt-3", className)} {...rest} />;
}

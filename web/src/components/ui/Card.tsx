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
  tentative: "bg-paper border-ink-blue/15 ring-1 ring-ink-blue/8",
  final:     "bg-paper border-ruby/25 ring-1 ring-ruby/10",
  won:       "bg-paper border-deep-green/20 ring-1 ring-deep-green/8",
  lost:      "bg-paper border-wine/15 ring-1 ring-wine/8",
  gold:      "bg-paper border-gold/40 ring-1 ring-gold/15",
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
        toneStyles[tone],
        elevated && "shadow-[var(--shadow-md)]",
        !elevated && "shadow-[var(--shadow-xs)]",
        interactive &&
          "cursor-pointer hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] active:scale-[0.995]",
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

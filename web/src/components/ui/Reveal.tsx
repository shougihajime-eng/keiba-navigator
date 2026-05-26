"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Reveal — スクロールで視界に入った瞬間にふわっと現れるラッパー。
 * 既存ブロック (BlockA/BlockC) は内部に金の脈動・sheen・rise-in を持つが、
 * 後から足したカード (正直な現在地・全レース予想・資金管理など) は静止していて
 * 画面の中で浮いていた。これで全セクションの「登場」を上品に揃える。
 * prefers-reduced-motion の人には一切動かさず即表示する。
 */
export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShown(true);
            io.disconnect();
            break;
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={cn(
        "transition-all duration-[680ms] ease-out will-change-transform motion-reduce:transition-none",
        shown ? "opacity-100 translate-y-0" : "opacity-0 translate-y-5",
        className,
      )}
      style={delay && shown ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

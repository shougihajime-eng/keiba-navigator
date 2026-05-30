"use client";

import { useEffect, useState } from "react";
import { HorseHero } from "@/components/icons/HorseHero";

function greeting(h: number): { hello: string; emoji: string } {
  if (h < 5) return { hello: "ねむれない夜の競馬好きへ", emoji: "🌙" };
  if (h < 11) return { hello: "おはようございます", emoji: "🌅" };
  if (h < 16) return { hello: "こんにちは", emoji: "🌤" };
  if (h < 19) return { hello: "夕方のレース、いきましょう", emoji: "🌇" };
  return { hello: "こんばんは", emoji: "✨" };
}

export function HeroBanner() {
  // ビルド時刻で固まらないよう、クライアントで実時刻を使う
  const [hour, setHour] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setHour(new Date().getHours());
    update();
    const t = setInterval(update, 60_000);
    return () => clearInterval(t);
  }, []);

  const g = hour === null ? { hello: "ようこそ", emoji: "🐎" } : greeting(hour);

  return (
    <section
      className="relative overflow-hidden rounded-[22px] border border-line shadow-[var(--shadow-md)]"
      style={{
        background:
          "radial-gradient(120% 140% at 80% -20%, rgba(47,240,224,0.18) 0%, transparent 45%), radial-gradient(120% 160% at 8% 120%, rgba(22,224,126,0.20) 0%, transparent 50%), linear-gradient(180deg, #0B1A14 0%, #081310 52%, #050C0A 100%)",
      }}
    >
      {/* 太陽 */}
      <div className="absolute right-10 top-5 h-12 w-12 rounded-full bg-gradient-to-b from-[#FFE08A] to-[#FFBC4D] opacity-80 blur-[1px]" />

      {/* 流れる雲 */}
      <Cloud className="absolute left-6 top-6 w-16 opacity-20 anim-drift" />
      <Cloud className="absolute left-1/2 top-10 w-12 opacity-[0.12] anim-drift" />

      <div className="relative flex items-center justify-between gap-3 px-5 py-6 md:px-8 md:py-8">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-1.5 text-[11px] md:text-xs font-medium text-deep-green">
            <span>{g.emoji}</span>
            <span className="tracking-wide">{g.hello}</span>
          </div>
          <h1 className="mt-2 font-display text-[22px] leading-tight md:text-[34px] font-bold tracking-tight text-ink">
            買う前に、<span className="text-green-grad">見極める</span>。
          </h1>
          <p className="mt-2 text-xs md:text-sm text-ink-soft max-w-sm leading-relaxed">
            AIが今日のレースを採点。<span className="font-semibold text-ink">自信のあるレースだけ</span>をおすすめし、迷う日は「見送り」とはっきり伝えます。
          </p>
        </div>

        {/* 走る馬イラスト */}
        <div className="shrink-0 w-[42%] max-w-[230px] anim-gallop">
          <HorseHero className="w-full h-auto drop-shadow-[0_10px_18px_rgba(21,39,27,0.18)]" />
        </div>
      </div>

      {/* 下端の芝 */}
      <div
        className="h-3 w-full"
        style={{
          background:
            "repeating-linear-gradient(90deg,#138A47 0 10px,#16A35A 10px 20px)",
          opacity: 0.85,
        }}
      />
    </section>
  );
}

function Cloud({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 28" className={className} aria-hidden="true">
      <path
        d="M14 24c-7 0-12-5-12-10S7 5 13 6c2-4 8-6 13-3 3-3 9-3 12 1 6-1 12 3 12 9 0 6-5 11-12 11H14Z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

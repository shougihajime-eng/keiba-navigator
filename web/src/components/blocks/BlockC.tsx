"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardBody } from "@/components/ui/Card";
import {
  loadBets,
  summaryAll,
  summaryLast7Days,
  summaryToday,
  type Summary,
} from "@/lib/store";
import { formatYen, formatPct, cn } from "@/lib/utils";

/** 0 → target へ滑らかに数値を回す (ease-out cubic) */
function useCountUp(target: number, active: boolean, durationMs = 950): number {
  const [value, setValue] = useState(0);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (!active) {
      setValue(0);
      return;
    }
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(target * eased);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [target, active, durationMs]);
  return value;
}

export function BlockC() {
  const [data, setData] = useState<{
    today: Summary;
    last7: Summary;
    all: Summary;
  } | null>(null);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("keiba:bet-added", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("keiba:bet-added", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  function refresh() {
    const bets = loadBets();
    setData({
      today: summaryToday(bets),
      last7: summaryLast7Days(bets),
      all: summaryAll(bets),
    });
  }

  const hasData = !!data && data.all.count > 0;
  const roi = data?.all.roi ?? 0;
  const shown = useCountUp(roi, hasData);

  if (!data) return null;

  const isProfitable = data.all.roi >= 100;
  const isBreakeven = data.all.roi >= 90 && data.all.roi < 100;
  const tone =
    isProfitable ? "positive" :
    isBreakeven  ? "default"  :
                   "negative";

  // 100% ラインに対するゲージ (0〜150% を表示域とする)
  const gaugePct = Math.max(0, Math.min(100, (roi / 150) * 100));
  const targetPct = (100 / 150) * 100; // 100% の位置

  return (
    <section>
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-[0.16em] text-deep-green font-medium">
          P&amp;L · 収支サマリー
        </div>
        <h2 className="mt-1 font-display text-xl md:text-2xl font-semibold tracking-tight">
          長期で 100% を超えているか
        </h2>
      </div>

      <Card elevated tone={isProfitable ? "gold" : "default"} className={cn(isProfitable && "sheen")}>
        <CardBody className="space-y-6">
          {/* Hero: 累計回収率 */}
          <div className="text-center py-3">
            <div className="text-[10px] uppercase tracking-[0.2em] text-ink-muted font-medium">
              累計回収率
            </div>
            <div className={cn(
              "mt-2 font-display tabular text-6xl md:text-7xl font-semibold leading-none anim-rise-in",
              !hasData ? "text-ink-faint" :
              isProfitable ? "text-gold-grad num-glow" : isBreakeven ? "text-ink" : "text-wine",
            )}>
              {hasData ? formatPct(shown, 1) : "—"}
            </div>

            {hasData && (
              <>
                {/* 100% ライン ゲージ */}
                <div className="mt-5 max-w-xs mx-auto">
                  <div className="relative h-2 rounded-full bg-paper-soft overflow-hidden border border-line">
                    <div
                      className={cn(
                        "absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out",
                        isProfitable
                          ? "bg-gradient-to-r from-gold-deep to-gold-bright"
                          : "bg-gradient-to-r from-wine/70 to-wine",
                      )}
                      style={{ width: `${gaugePct}%` }}
                    />
                    {/* 100% の基準線 */}
                    <div
                      className="absolute inset-y-0 w-px bg-ink-soft/70"
                      style={{ left: `${targetPct}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex justify-between text-[11px] text-ink-muted tabular">
                    <span>0%</span>
                    <span className="text-ink-muted">目標 100%</span>
                    <span>150%</span>
                  </div>
                </div>

                <div className="mt-4 text-sm text-ink-muted">
                  投資 {formatYen(data.all.totalStake)} → 回収 {formatYen(data.all.totalPayout)} ·
                  <span className={cn(
                    "ml-1 font-medium tabular",
                    data.all.profit >= 0 ? "text-deep-green" : "text-wine",
                  )}>
                    {data.all.profit >= 0 ? "+" : ""}{formatYen(data.all.profit)}
                  </span>
                </div>
              </>
            )}

            {!hasData && (
              <div className="mt-3 text-sm text-ink-muted max-w-sm mx-auto">
                まだ買い目を記録していません。星4以上のレースで「これ買う」を押すと、ここに累計の成績が育っていきます。
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3 pt-3 border-t border-line">
            <SubStat label="今日" s={data.today} />
            <SubStat label="7日間" s={data.last7} />
            <SubStat label="累計" s={data.all} tone={tone} />
          </div>
        </CardBody>
      </Card>
    </section>
  );
}

function SubStat({
  label,
  s,
  tone = "default",
}: {
  label: string;
  s: Summary;
  tone?: "default" | "positive" | "negative";
}) {
  return (
    <div className="text-center">
      <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted font-medium">
        {label}
      </div>
      <div className={cn(
        "mt-1.5 font-display tabular text-xl md:text-2xl font-semibold",
        tone === "positive" && "text-deep-green",
        tone === "negative" && "text-wine",
      )}>
        {s.count > 0 ? formatPct(s.roi, 1) : "—"}
      </div>
      <div className="mt-0.5 text-xs text-ink-muted tabular">
        {formatYen(s.profit)} / {s.count} R
      </div>
    </div>
  );
}

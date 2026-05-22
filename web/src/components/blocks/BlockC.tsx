"use client";

import { useEffect, useState } from "react";
import { Card, CardBody } from "@/components/ui/Card";
import { Stat } from "@/components/ui/Stat";
import {
  loadBets,
  summaryAll,
  summaryLast7Days,
  summaryToday,
  type Summary,
} from "@/lib/store";
import { formatYen, formatPct, cn } from "@/lib/utils";

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

  if (!data) return null;

  const isProfitable = data.all.roi >= 100;
  const isBreakeven = data.all.roi >= 90 && data.all.roi < 100;
  const tone =
    isProfitable ? "positive" :
    isBreakeven  ? "default"  :
                   "negative";

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

      <Card elevated>
        <CardBody className="space-y-6">
          {/* Hero: 累計回収率 */}
          <div className="text-center py-3">
            <div className="text-[10px] uppercase tracking-[0.2em] text-ink-muted font-medium">
              累計回収率
            </div>
            <div className={cn(
              "mt-2 font-display tabular text-6xl md:text-7xl font-semibold leading-none",
              isProfitable ? "text-deep-green" : isBreakeven ? "text-ink" : "text-wine",
            )}>
              {data.all.count > 0 ? formatPct(data.all.roi, 1) : "—"}
            </div>
            {data.all.count > 0 && (
              <div className="mt-2 text-sm text-ink-muted">
                投資 {formatYen(data.all.totalStake)} → 回収 {formatYen(data.all.totalPayout)} ·
                <span className={cn(
                  "ml-1 font-medium tabular",
                  data.all.profit >= 0 ? "text-deep-green" : "text-wine",
                )}>
                  {data.all.profit >= 0 ? "+" : ""}{formatYen(data.all.profit)}
                </span>
              </div>
            )}
            {data.all.count === 0 && (
              <div className="mt-2 text-sm text-ink-muted">
                まだ買い目を記録していません。星4以上のレースで「これ買う」を押すと記録されます。
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3 pt-3 border-t border-line/60">
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
      <div className="text-[10px] uppercase tracking-[0.14em] text-ink-muted font-medium">
        {label}
      </div>
      <div className={cn(
        "mt-1.5 font-display tabular text-xl md:text-2xl font-semibold",
        tone === "positive" && "text-deep-green",
        tone === "negative" && "text-wine",
      )}>
        {s.count > 0 ? formatPct(s.roi, 1) : "—"}
      </div>
      <div className="mt-0.5 text-[11px] text-ink-muted tabular">
        {formatYen(s.profit)} / {s.count} R
      </div>
    </div>
  );
}

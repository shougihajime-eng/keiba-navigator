"use client";

import { useEffect, useState } from "react";
import { BarChart3 } from "lucide-react";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import {
  loadBets, summaryAll, monthlyPL, tierBreakdown,
  type Summary, type MonthPL, type TierPerf,
} from "@/lib/store";
import { formatYen, formatPct, cn } from "@/lib/utils";

const TIER_TONE: Record<number, "gold" | "won" | "tentative" | "silver"> = {
  5: "gold", 4: "won", 3: "tentative", 2: "silver", 1: "silver",
};

export function PerformanceInsights() {
  const [all, setAll] = useState<Summary | null>(null);
  const [months, setMonths] = useState<MonthPL[]>([]);
  const [tiers, setTiers] = useState<TierPerf[]>([]);

  useEffect(() => {
    const refresh = () => {
      const bets = loadBets();
      setAll(summaryAll(bets));
      setMonths(monthlyPL(bets, 6));
      setTiers(tierBreakdown(bets));
    };
    refresh();
    window.addEventListener("keiba:bet-added", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("keiba:bet-added", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // まだ記録が無いときは出さない (空のグラフでユーザーを戸惑わせない)
  if (!all || all.count === 0) return null;

  const settled = all.hitCount + all.missCount;
  const hitRate = settled > 0 ? (all.hitCount / settled) * 100 : 0;

  return (
    <section aria-label="成績の見える化">
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-[0.16em] text-deep-green font-medium flex items-center gap-1.5">
          <BarChart3 className="w-3.5 h-3.5" /> INSIGHTS · 成績の見える化
        </div>
        <h2 className="mt-1 font-display text-xl md:text-2xl font-semibold tracking-tight">
          どこで当たって、どこで負けているか
        </h2>
      </div>

      <Card elevated>
        <CardBody className="space-y-6">
          {/* 的中率 + 結果待ち */}
          <div className="grid grid-cols-3 gap-3 text-center">
            <HeadStat label="的中率" value={settled > 0 ? formatPct(hitRate, 0) : "—"} sub={`${all.hitCount} / ${settled} 的中`} tone={hitRate >= 50 ? "positive" : "default"} />
            <HeadStat label="記録数" value={`${all.count}`} sub={`結果待ち ${all.pendingCount}`} />
            <HeadStat
              label="累計収支"
              value={`${all.profit >= 0 ? "+" : ""}${formatYen(all.profit)}`}
              sub={`回収率 ${formatPct(all.roi, 0)}`}
              tone={all.profit >= 0 ? "positive" : "negative"}
            />
          </div>

          {/* 月別収支グラフ */}
          <div>
            <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted font-medium mb-3">
              月ごとの収支（直近6ヶ月）
            </div>
            <MonthlyBars months={months} />
          </div>

          {/* 段階別成績 */}
          {tiers.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted font-medium mb-2.5">
                段階別の成績（買った時の判定ごと）
              </div>
              <div className="space-y-1.5">
                {tiers.map((t) => <TierRow key={t.rating} t={t} />)}
              </div>
              <p className="mt-2 text-[11px] text-ink-muted leading-relaxed">
                「絶好機・勝負」の方が的中率が高ければ、AIの選別が効いている証拠です。回収率は控除率(約20-25%)の壁で100%超えは難しいですが、段階が上がるほどマシになっていれば成功です。
              </p>
            </div>
          )}
        </CardBody>
      </Card>
    </section>
  );
}

function HeadStat({ label, value, sub, tone = "default" }: {
  label: string; value: string; sub?: string; tone?: "default" | "positive" | "negative";
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted font-medium">{label}</div>
      <div className={cn(
        "mt-1 font-display tabular text-2xl md:text-3xl font-semibold leading-none",
        tone === "positive" && "text-deep-green",
        tone === "negative" && "text-wine",
      )}>
        {value}
      </div>
      {sub && <div className="mt-1 text-[11px] text-ink-muted tabular">{sub}</div>}
    </div>
  );
}

function MonthlyBars({ months }: { months: MonthPL[] }) {
  const maxAbs = Math.max(1, ...months.map((m) => Math.abs(m.profit)));
  const H = 64; // 上下それぞれの最大高さ(px)

  return (
    <div className="flex items-end justify-between gap-2">
      {months.map((m) => {
        const ratio = Math.abs(m.profit) / maxAbs;
        const barH = Math.max(m.count > 0 ? 3 : 0, Math.round(ratio * H));
        const up = m.profit >= 0;
        return (
          <div key={m.ym} className="flex-1 flex flex-col items-center gap-1 min-w-0">
            {/* 収支金額 */}
            <div className={cn(
              "text-[10px] tabular font-medium h-3.5",
              m.count === 0 ? "text-ink-faint" : up ? "text-deep-green" : "text-wine",
            )}>
              {m.count > 0 ? `${up ? "+" : ""}${(m.profit / 1000).toFixed(m.profit % 1000 === 0 ? 0 : 1)}k` : ""}
            </div>
            {/* 上方向バー(プラス) */}
            <div className="w-full flex items-end justify-center" style={{ height: H }}>
              {up && <div className="w-[60%] max-w-[28px] rounded-t-[4px] bg-gradient-to-t from-deep-green/70 to-deep-green transition-[height] duration-500" style={{ height: barH }} />}
            </div>
            {/* 0 基準線 */}
            <div className="w-full h-px bg-line" />
            {/* 下方向バー(マイナス) */}
            <div className="w-full flex items-start justify-center" style={{ height: H }}>
              {!up && <div className="w-[60%] max-w-[28px] rounded-b-[4px] bg-gradient-to-b from-wine/70 to-wine transition-[height] duration-500" style={{ height: barH }} />}
            </div>
            {/* 月ラベル */}
            <div className="text-[11px] text-ink-muted tabular">{m.label}</div>
          </div>
        );
      })}
    </div>
  );
}

function TierRow({ t }: { t: TierPerf }) {
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-line/60 bg-paper-soft/40 px-3 py-2">
      <Badge tone={TIER_TONE[t.rating] || "silver"} size="sm">{t.label}</Badge>
      <span className="text-xs text-ink-muted tabular shrink-0">
        {t.count}戦{t.settled < t.count ? `（${t.settled}確定）` : ""}
      </span>
      <div className="ml-auto flex items-center gap-4 text-sm tabular">
        <span>
          <span className="text-ink-muted text-xs">的中 </span>
          <span className={cn("font-medium", t.hitRate >= 50 ? "text-deep-green" : "text-ink")}>
            {t.settled > 0 ? formatPct(t.hitRate, 0) : "—"}
          </span>
        </span>
        <span>
          <span className="text-ink-muted text-xs">回収 </span>
          <span className={cn("font-medium", t.roi >= 100 ? "text-deep-green" : "text-ink")}>
            {t.settled > 0 ? formatPct(t.roi, 0) : "—"}
          </span>
        </span>
      </div>
    </div>
  );
}

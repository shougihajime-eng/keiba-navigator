"use client";

import { useEffect, useState } from "react";
import { Wallet, Pencil, Check, ShieldCheck, AlertTriangle } from "lucide-react";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { loadBets, summaryThisMonth, type Summary } from "@/lib/store";
import { getBudget, setBudget, perRaceUnit } from "@/lib/bankroll";
import { formatYen, cn } from "@/lib/utils";

export function BankrollCard() {
  const [budget, setBudgetState] = useState<number>(10000);
  const [month, setMonth] = useState<Summary | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const refresh = () => {
      setBudgetState(getBudget());
      setMonth(summaryThisMonth(loadBets()));
    };
    refresh();
    window.addEventListener("keiba:bet-added", refresh);
    window.addEventListener("keiba:budget-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("keiba:bet-added", refresh);
      window.removeEventListener("keiba:budget-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  if (!month) return null;

  const used = month.totalStake;
  const remaining = Math.max(0, budget - used);
  const over = used > budget;
  const fillPct = budget > 0 ? Math.min(100, (used / budget) * 100) : 0;
  const unit = perRaceUnit(budget);
  const profit = month.profit;

  const fillTone = over
    ? "from-wine/70 to-wine"
    : fillPct > 80
      ? "from-gold-deep to-gold-bright"
      : "from-deep-green/70 to-deep-green";

  const saveEdit = () => {
    const n = Number(draft.replace(/[^\d]/g, ""));
    if (Number.isFinite(n) && n > 0) setBudget(n);
    setEditing(false);
  };

  return (
    <section aria-label="資金管理・規律">
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-[0.16em] text-deep-green font-medium">
          DISCIPLINE · 資金管理
        </div>
        <h2 className="mt-1 font-display text-xl md:text-2xl font-semibold tracking-tight">
          今月いくらまで、と決めて守る
        </h2>
      </div>

      <Card elevated>
        <CardBody className="space-y-5">
          {/* 予算 */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-ink-muted">
              <Wallet className="w-4 h-4 text-gold-deep" />
              今月の予算
            </div>
            {editing ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  autoFocus
                  defaultValue={String(budget)}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveEdit()}
                  className="w-28 text-right tabular bg-paper-soft border border-line rounded-md px-2 py-1 text-sm text-ink focus:outline-none focus:border-gold"
                />
                <Button size="sm" variant="gold" onClick={saveEdit}><Check className="w-3.5 h-3.5" /></Button>
              </div>
            ) : (
              <button onClick={() => { setDraft(String(budget)); setEditing(true); }} className="flex items-center gap-1.5 group">
                <span className="font-display text-xl font-semibold tabular text-ink">{formatYen(budget)}</span>
                <Pencil className="w-3.5 h-3.5 text-ink-faint group-hover:text-gold-deep transition-colors" />
              </button>
            )}
          </div>

          {/* 使用状況バー */}
          <div>
            <div className="relative h-2.5 rounded-full bg-paper-soft overflow-hidden border border-line">
              <div
                className={cn("absolute inset-y-0 left-0 rounded-full bg-gradient-to-r transition-[width] duration-700 ease-out", fillTone)}
                style={{ width: `${fillPct}%` }}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-xs tabular">
              <span className="text-ink-muted">使った {formatYen(used)}</span>
              <span className={cn("font-medium", over ? "text-wine" : "text-ink-soft")}>
                {over ? `${formatYen(used - budget)} 超過` : `残り ${formatYen(remaining)}`}
              </span>
            </div>
          </div>

          {/* 規律メッセージ */}
          {over ? (
            <div className="flex items-start gap-2.5 rounded-[12px] bg-wine-soft/50 border border-wine/25 p-3.5">
              <AlertTriangle className="w-4.5 h-4.5 text-wine shrink-0 mt-0.5" />
              <p className="text-sm text-ink-soft leading-relaxed">
                今月の予算を使い切りました。<span className="font-semibold text-ink">今月はもう買わないのが正解</span>です。来月またゼロから。
              </p>
            </div>
          ) : (
            <div className="flex items-start gap-2.5 rounded-[12px] bg-deep-green-soft/40 border border-deep-green/20 p-3.5">
              <ShieldCheck className="w-4.5 h-4.5 text-deep-green shrink-0 mt-0.5" />
              <p className="text-sm text-ink-soft leading-relaxed">
                1レースは <span className="font-semibold text-ink tabular">{formatYen(unit)}</span> まで（予算の3%）。
                当たらない前提で小さく。<span className="font-medium">期待値プラスの確信が無いレースは見送る</span>のが長期で勝つ唯一の道です。
              </p>
            </div>
          )}

          {/* 今月の収支 */}
          <div className="grid grid-cols-3 gap-3 pt-3 border-t border-line text-center">
            <MiniStat label="今月 投資" value={formatYen(used)} />
            <MiniStat label="今月 回収" value={formatYen(month.totalPayout)} />
            <MiniStat
              label="今月 収支"
              value={`${profit >= 0 ? "+" : ""}${formatYen(profit)}`}
              tone={month.count === 0 ? "muted" : profit >= 0 ? "positive" : "negative"}
            />
          </div>
        </CardBody>
      </Card>
    </section>
  );
}

function MiniStat({ label, value, tone = "muted" }: { label: string; value: string; tone?: "muted" | "positive" | "negative" }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-ink-muted font-medium">{label}</div>
      <div className={cn(
        "mt-1 font-display tabular text-base md:text-lg font-semibold",
        tone === "positive" && "text-deep-green",
        tone === "negative" && "text-wine",
        tone === "muted" && "text-ink",
      )}>
        {value}
      </div>
    </div>
  );
}

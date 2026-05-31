"use client";

import { useEffect, useState } from "react";
import { Lightbulb } from "lucide-react";
import { loadBets, summaryThisMonth, type Bet } from "@/lib/store";
import { getBudget } from "@/lib/bankroll";
import { formatYen } from "@/lib/utils";

type Advice = { text: string; tone: "calm" | "warn" | "good" };

/** 使う人の記録から「今日のひとこと」を組み立てる (ローカル計算のみ) */
function buildAdvice(bets: Bet[]): Advice {
  const budget = getBudget();
  const month = summaryThisMonth(bets);

  // 直近の確定記録から連敗・連勝を見る (新しい順)
  const settled = [...bets]
    .filter((b) => b.result === "hit" || b.result === "miss")
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  let recentLossStreak = 0;
  for (const b of settled) {
    if (b.result === "miss") recentLossStreak += 1;
    else break;
  }
  let recentWinStreak = 0;
  for (const b of settled) {
    if (b.result === "hit") recentWinStreak += 1;
    else break;
  }

  const used = month.totalStake;
  const overBudget = used > budget;
  const usedRatio = budget > 0 ? used / budget : 0;

  // 優先度: 予算オーバー > 連敗 > 予算8割 > 連勝 > 通常
  if (overBudget) {
    return {
      tone: "warn",
      text: `今月は予算 ${formatYen(budget)} を使い切りました。来月までお休みが正解。買わない月もあって当たり前です。`,
    };
  }
  if (recentLossStreak >= 3) {
    return {
      tone: "warn",
      text: `直近 ${recentLossStreak} 連敗中。熱くならず、いったん一回お休みするのも立派な作戦です。`,
    };
  }
  if (usedRatio >= 0.8) {
    return {
      tone: "warn",
      text: `今月はもう予算の ${Math.round(usedRatio * 100)}%。残りは「絶好機」だけに絞りましょう。`,
    };
  }
  if (recentWinStreak >= 3) {
    return {
      tone: "good",
      text: `${recentWinStreak} 連勝中。好調でも金額は変えず、自分のルールどおり淡々と。`,
    };
  }
  if (bets.length === 0) {
    return {
      tone: "calm",
      text: `今日もムリせず。AIが「絶好機」と言った時だけ、決めた金額で。買わない日も勝つための一日です。`,
    };
  }
  return {
    tone: "calm",
    text: `今月は予算の ${Math.round(usedRatio * 100)}% を使用。残り ${formatYen(Math.max(0, budget - used))}。確信のあるレースだけに。`,
  };
}

/** 画面上部に出す、その日の状況に合わせた短い助言 */
export function DailyAdvice() {
  const [advice, setAdvice] = useState<Advice | null>(null);

  useEffect(() => {
    const refresh = () => setAdvice(buildAdvice(loadBets()));
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

  if (!advice) return null;

  const toneCls =
    advice.tone === "warn"
      ? "border-wine/30 bg-wine-soft/40 text-ink-soft"
      : advice.tone === "good"
        ? "border-deep-green/30 bg-deep-green-soft/40 text-ink-soft"
        : "border-line bg-paper-soft/60 text-ink-soft";
  const iconCls =
    advice.tone === "warn" ? "text-wine" : advice.tone === "good" ? "text-deep-green" : "text-gold-deep";

  return (
    <div className={`flex items-start gap-2.5 rounded-[14px] border px-4 py-3 ${toneCls}`}>
      <Lightbulb className={`w-4 h-4 shrink-0 mt-0.5 ${iconCls}`} />
      <p className="text-sm leading-relaxed">
        <span className="text-[10px] uppercase tracking-[0.14em] font-medium text-ink-muted mr-2">今日のひとこと</span>
        {advice.text}
      </p>
    </div>
  );
}

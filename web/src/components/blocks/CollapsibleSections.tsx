"use client";

import { useEffect, useState } from "react";
import {
  Newspaper, Trophy as TrophyIcon, Home, Target, BarChart3, Award, Activity,
  ClipboardList, BookOpen, Cloud,
} from "lucide-react";
import { Collapsible } from "@/components/Collapsible";
import { Badge } from "@/components/ui/Badge";
import { PendingBetsList } from "@/components/PendingBetsList";
import { ReflectionDashboard } from "@/components/ReflectionDashboard";
import { SyncCard } from "@/components/SyncCard";
import { fetchNews, fetchMlStatus, fetchWin5 } from "@/lib/api";
import { loadBets } from "@/lib/store";
import { loadReflections } from "@/lib/reflectionStore";
import { cn } from "@/lib/utils";

export function CollapsibleSections() {
  const [news, setNews] = useState<unknown[] | null>(null);
  const [ml, setMl] = useState<{
    backtest?: { strategies?: Array<{ name: string; roi_pct?: number; count?: number }> };
  } | null>(null);
  const [win5, setWin5] = useState<unknown | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [reflectionCount, setReflectionCount] = useState(0);

  useEffect(() => {
    (async () => {
      const n = await fetchNews();
      if (n?.items) setNews(n.items as unknown[]);
      const m = await fetchMlStatus();
      if (m) setMl(m as unknown as typeof ml);
      const w = await fetchWin5();
      if (w?.ok) setWin5(w);
    })();
    refreshCounts();
    const onChange = () => refreshCounts();
    window.addEventListener("keiba:bet-added", onChange);
    window.addEventListener("keiba:reflection-added", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("keiba:bet-added", onChange);
      window.removeEventListener("keiba:reflection-added", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  function refreshCounts() {
    const bets = loadBets();
    setPendingCount(bets.filter((b) => b.result === "pending" || !b.result).length);
    setReflectionCount(loadReflections().length);
  }

  const today = new Date();
  const isSunday = today.getDay() === 0;

  return (
    <section className="space-y-3">
      <SectionLabel>もっと知る</SectionLabel>

      <Collapsible
        icon={<ClipboardList className="w-4 h-4" />}
        title="結果待ち の記録"
        hint="買った馬券に結果を記録すると反省文が自動生成されます"
        badge={pendingCount > 0 ? <Badge tone="tentative" size="sm">{pendingCount}</Badge> : null}
        tone="info"
      >
        <div className="mt-2">
          <PendingBetsList />
        </div>
      </Collapsible>

      <Collapsible
        icon={<BookOpen className="w-4 h-4" />}
        title="反省ダッシュボード"
        hint="外したレースの構造化タグ集計"
        badge={reflectionCount > 0 ? <Badge tone="lost" size="sm">{reflectionCount}</Badge> : null}
        tone="info"
      >
        <ReflectionDashboard />
      </Collapsible>

      <Collapsible
        icon={<Newspaper className="w-4 h-4" />}
        title="競馬ニュース"
        hint="重賞情報・出走馬・調整状況"
        badge={news?.length ? <Badge size="sm">{news.length}</Badge> : null}
      >
        {news && news.length > 0 ? (
          <ul className="space-y-2 mt-2">
            {(news as Array<{ title?: string; link?: string; published?: string }>).slice(0, 8).map((n, i) => (
              <li key={i} className="text-sm">
                <a
                  href={n.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ink-soft hover:text-ink hover:underline"
                >
                  {n.title}
                </a>
                {n.published && (
                  <span className="ml-2 text-xs text-ink-muted tabular">
                    {n.published.slice(5, 10)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-sm text-ink-muted py-2">読み込み中...</div>
        )}
      </Collapsible>

      <Collapsible
        icon={<TrophyIcon className="w-4 h-4" />}
        title="騎手ランキング"
        hint="最近勝ってる騎手 TOP10"
      >
        <div className="text-sm text-ink-muted py-2">
          直近の取得データから自動集計。データ拡充中。
        </div>
      </Collapsible>

      <Collapsible
        icon={<Home className="w-4 h-4" />}
        title="厩舎ランキング"
        hint="最近勝ってる厩舎 TOP10"
      >
        <div className="text-sm text-ink-muted py-2">
          直近の取得データから自動集計。データ拡充中。
        </div>
      </Collapsible>

      {isSunday && (
        <Collapsible
          icon={<Target className="w-4 h-4" />}
          title="WIN5 戦略"
          hint="日曜限定 · 3 戦略 (堅め / 中波 / 万舟)"
          tone="info"
          badge={<Badge tone="info" size="sm">日曜</Badge>}
        >
          <div className="text-sm text-ink-soft py-2">
            {win5 ? "WIN5 データを表示" : "読み込み中..."}
          </div>
        </Collapsible>
      )}

      <Collapsible
        icon={<BarChart3 className="w-4 h-4" />}
        title="過去検証データ"
        hint="8 期間 Walk-forward 検証の中身"
      >
        {ml?.backtest?.strategies ? (
          <div className="space-y-2 mt-2">
            {ml.backtest.strategies
              .filter((s) => (s.roi_pct ?? 0) >= 100)
              .slice(0, 5)
              .map((s) => (
                <div key={s.name} className="flex items-center justify-between text-sm py-1.5 border-b border-line/40 last:border-0">
                  <span className="font-mono text-xs text-ink-soft truncate">{s.name}</span>
                  <span className={cn(
                    "tabular font-medium",
                    (s.roi_pct ?? 0) >= 110 ? "text-deep-green" : "text-ink",
                  )}>
                    {(s.roi_pct ?? 0).toFixed(1)}% / {s.count ?? 0}件
                  </span>
                </div>
              ))}
          </div>
        ) : (
          <div className="text-sm text-ink-muted py-2">読み込み中...</div>
        )}
      </Collapsible>

      <Collapsible
        icon={<Award className="w-4 h-4" />}
        title="達成バッジ"
        hint="連勝記録・歴代最高"
      >
        <div className="text-sm text-ink-muted py-2">
          長期で結果を出すモチベーション維持用。データが蓄積されると表示されます。
        </div>
      </Collapsible>

      <Collapsible
        icon={<Activity className="w-4 h-4" />}
        title="自動化ステータス"
        hint="データ取得・予想計算・反映の状態"
      >
        <div className="text-sm text-ink-muted py-2">
          土日 8:30 / 11:00 / 13:30 / 16:00 に自動取得。バックエンドは既存パイプライン継続。
        </div>
      </Collapsible>

      <Collapsible
        icon={<Cloud className="w-4 h-4" />}
        title="クラウド同期"
        hint="複数の端末で買い目・反省を共有"
      >
        <div className="mt-2">
          <SyncCard />
        </div>
      </Collapsible>
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-[0.16em] text-ink-muted font-medium pt-3">
      {children}
    </div>
  );
}

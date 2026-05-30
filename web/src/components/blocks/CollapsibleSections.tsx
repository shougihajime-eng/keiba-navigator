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
import { fetchNews, fetchWin5, fetchAutomationStatus, fetchRecommendations, fetchRankings } from "@/lib/api";
import { loadBets, summaryAll, type Bet } from "@/lib/store";
import { loadReflections } from "@/lib/reflectionStore";
import { cn, formatYen } from "@/lib/utils";

export function CollapsibleSections() {
  const [news, setNews] = useState<unknown[] | null>(null);
  const [win5, setWin5] = useState<Win5Resp | null>(null);
  const [auto, setAuto] = useState<AutoResp | null>(null);
  const [rec, setRec] = useState<RecData | null>(null);
  const [rankings, setRankings] = useState<RankData | null>(null);
  const [bets, setBets] = useState<Bet[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [reflectionCount, setReflectionCount] = useState(0);

  useEffect(() => {
    (async () => {
      const n = await fetchNews();
      if (n?.items) setNews(n.items as unknown[]);
      const w = await fetchWin5();
      if (w) setWin5(w as unknown as Win5Resp);
      const a = await fetchAutomationStatus();
      if (a) setAuto(a as unknown as AutoResp);
      const r = await fetchRecommendations();
      if (r) setRec(r as unknown as RecData);
      const rk = await fetchRankings();
      if (rk) setRankings(rk as unknown as RankData);
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
    const all = loadBets();
    setBets(all);
    setPendingCount(all.filter((b) => b.result === "pending" || !b.result).length);
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
        hint="1着率順 · 過去データ集計 (30走以上)"
      >
        <RankingList rows={rankings?.jockeys} loading={!rankings} />
      </Collapsible>

      <Collapsible
        icon={<Home className="w-4 h-4" />}
        title="厩舎ランキング"
        hint="1着率順 · 過去データ集計 (30走以上)"
      >
        <RankingList rows={rankings?.trainers} loading={!rankings} />
      </Collapsible>

      {isSunday && (
        <Collapsible
          icon={<Target className="w-4 h-4" />}
          title="WIN5 戦略"
          hint="日曜限定 · 3 戦略 (堅め / 中波 / 万舟)"
          tone="info"
          badge={<Badge tone="info" size="sm">日曜</Badge>}
        >
          <Win5Body win5={win5} />
        </Collapsible>
      )}

      <Collapsible
        icon={<BarChart3 className="w-4 h-4" />}
        title="戦略の正直な成績"
        hint="嘘のない検証（未来を見ない）での回収率"
      >
        <StrategyTruth rec={rec} />
      </Collapsible>

      <Collapsible
        icon={<Award className="w-4 h-4" />}
        title="達成バッジ"
        hint="買い目の記録から自動で解除"
      >
        <BadgesBody bets={bets} />
      </Collapsible>

      <Collapsible
        icon={<Activity className="w-4 h-4" />}
        title="自動化ステータス"
        hint="データ取得・予想計算・結果照合の状態"
      >
        <AutomationBody auto={auto} />
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

function PreparingHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 flex items-start gap-2.5 rounded-[12px] bg-paper-soft/50 border border-line/60 px-3.5 py-3">
      <Activity className="w-4 h-4 text-ink-faint shrink-0 mt-0.5" />
      <p className="text-sm text-ink-muted leading-relaxed">{children}</p>
    </div>
  );
}

// =========================================
// WIN5
// =========================================
type Win5Strategy = {
  name?: string;
  combo?: number;
  totalCost?: number;
  evRatio?: number;
  hitProb?: number;
};
type Win5Resp = {
  ok: boolean;
  reason?: string;
  note?: string;
  recommended?: string | null;
  strategies?: Record<string, Win5Strategy | null>;
};

function Win5Body({ win5 }: { win5: Win5Resp | null }) {
  if (!win5) return <div className="text-sm text-ink-muted py-2">読み込み中...</div>;
  if (!win5.ok) {
    return (
      <PreparingHint>
        {win5.note || win5.reason || "本日の WIN5 対象レースはまだ配信されていません。"}
      </PreparingHint>
    );
  }
  const order = ["safe", "axis", "mid", "wide"];
  const items = order
    .map((k) => ({ key: k, s: win5.strategies?.[k] }))
    .filter((x): x is { key: string; s: Win5Strategy } => !!x.s);

  return (
    <div className="mt-2 space-y-2">
      <div className="rounded-[10px] bg-ink-blue-soft/40 border border-ink-blue/20 px-3 py-2 text-xs text-ink-soft leading-relaxed">
        WIN5 は金額を決めず、<span className="font-medium">自信があるときだけ</span>買う方針です（買う額はその時のお気持ちで）。下は参考の組み立て方です。
      </div>
      {win5.note && <p className="text-sm text-ink-soft">{win5.note}</p>}
      {items.map(({ key, s }) => (
        <div
          key={key}
          className={cn(
            "flex items-center justify-between gap-3 p-3 rounded-[12px] border",
            win5.recommended === key
              ? "border-ink-blue/30 bg-ink-blue-soft/50"
              : "border-line bg-paper-soft/40",
          )}
        >
          <span className="flex items-center gap-2 min-w-0">
            {win5.recommended === key && <Badge tone="info" size="xs">推奨</Badge>}
            <span className="font-medium text-sm truncate">{s.name || key}</span>
          </span>
          <span className="text-xs tabular text-ink-muted shrink-0">
            {s.combo != null ? `${s.combo}点` : ""}
            {s.totalCost != null ? ` · ${formatYen(s.totalCost)}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

// =========================================
// 達成バッジ (ローカルの記録から算出)
// =========================================
function BadgesBody({ bets }: { bets: Bet[] }) {
  const sorted = [...bets].sort((a, b) =>
    (a.createdAt || "").localeCompare(b.createdAt || ""),
  );
  const sum = summaryAll(bets);
  const hits = sorted.filter((b) => b.result === "hit");
  // 連勝の最大記録
  let streak = 0, bestStreak = 0;
  for (const b of sorted) {
    if (b.result === "hit") { streak += 1; bestStreak = Math.max(bestStreak, streak); }
    else if (b.result === "miss") streak = 0;
  }
  const maxPayout = bets.reduce((m, b) => Math.max(m, Number(b.payout) || 0), 0);

  const badges = [
    { id: "first_bet", icon: "🎫", label: "はじめての記録", got: bets.length >= 1, hint: "買い目を1件記録" },
    { id: "first_hit", icon: "🎯", label: "はじめての的中", got: hits.length >= 1, hint: "1回的中させる" },
    { id: "profit", icon: "💰", label: "プラス収支", got: sum.count > 0 && sum.profit > 0, hint: "累計の収支がプラス" },
    { id: "roi110", icon: "📈", label: "回収率110%超え", got: sum.count >= 5 && sum.roi >= 110, hint: "5件以上で回収率110%" },
    { id: "streak3", icon: "🔥", label: "3連勝", got: bestStreak >= 3, hint: "3回連続で的中" },
    { id: "streak5", icon: "👑", label: "5連勝", got: bestStreak >= 5, hint: "5回連続で的中" },
    { id: "big_hit", icon: "💎", label: "大当たり (1万円超え)", got: maxPayout >= 10000, hint: "1回の払戻が1万円超え" },
    { id: "veteran", icon: "🏅", label: "20レース記録", got: bets.length >= 20, hint: "通算20件記録" },
  ];
  const gotCount = badges.filter((b) => b.got).length;

  return (
    <div className="mt-2">
      <div className="text-xs text-ink-muted mb-2 tabular">
        解除済み {gotCount} / {badges.length}
        {bestStreak > 0 && ` · 最高 ${bestStreak} 連勝`}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {badges.map((b) => (
          <div
            key={b.id}
            title={b.hint}
            className={cn(
              "rounded-[12px] border p-3 text-center transition-colors",
              b.got
                ? "border-gold/40 bg-gold-soft/50"
                : "border-line bg-paper-soft/30 opacity-55",
            )}
          >
            <div className={cn("text-3xl", !b.got && "grayscale")}>{b.icon}</div>
            <div className="mt-1.5 text-xs font-semibold leading-tight">{b.label}</div>
          </div>
        ))}
      </div>
      {bets.length === 0 && (
        <p className="mt-3 text-xs text-ink-muted">
          星4以上のレースで「これ買う」を押して記録を始めると、バッジが解除されていきます。
        </p>
      )}
    </div>
  );
}

// =========================================
// 自動化ステータス (本物の状態)
// =========================================
type AutoResp = {
  predictionsFresh?: boolean;
  predictionsComputedAt?: string | null;
  lastDataFetch?: string | null;
  nextCronFinalizeISO?: string | null;
  learning?: { lgbm?: { trained_at?: string } } | null;
};

function agoLabel(iso?: string | null): string {
  if (!iso) return "記録なし";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "記録なし";
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min} 分前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 時間前`;
  return `${Math.round(h / 24)} 日前`;
}

function AutomationBody({ auto }: { auto: AutoResp | null }) {
  if (!auto) return <div className="text-sm text-ink-muted py-2">読み込み中...</div>;
  const rows = [
    {
      label: "予想計算",
      ok: !!auto.predictionsFresh,
      detail: auto.predictionsComputedAt ? agoLabel(auto.predictionsComputedAt) : "未計算",
    },
    {
      label: "データ取得",
      ok: !!auto.lastDataFetch,
      detail: auto.lastDataFetch ? agoLabel(auto.lastDataFetch) : "待機中",
    },
    {
      label: "AI 学習",
      ok: !!auto.learning?.lgbm?.trained_at,
      detail: agoLabel(auto.learning?.lgbm?.trained_at),
    },
  ];
  return (
    <div className="mt-2 space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-3 text-sm py-1">
          <span className="flex items-center gap-2">
            <span
              className={cn(
                "inline-block w-2 h-2 rounded-full",
                r.ok ? "bg-deep-green" : "bg-silver",
              )}
            />
            {r.label}
          </span>
          <span className="text-xs text-ink-muted tabular">{r.detail}</span>
        </div>
      ))}
      <p className="text-xs text-ink-muted pt-1 border-t border-line/50">
        土日 8:30 / 11:00 / 13:30 / 16:00 に自動取得 · 結果照合は毎晩 23:00
      </p>
    </div>
  );
}

// =========================================
// 戦略の正直な成績 (嘘のない walk-forward 検証の回収率)
// =========================================
type StratStat = {
  overall_roi_pct?: number | null;
  overall_roi_pct_v2?: number | null;
  trust_label?: string | null;
};
type StratDef = { key: string; short_label?: string; label?: string; bet_type?: string };
type RecData = { strategies_def?: StratDef[]; stats?: Record<string, StratStat> };

function StrategyTruth({ rec }: { rec: RecData | null }) {
  if (!rec) return <div className="text-sm text-ink-muted py-2">読み込み中...</div>;
  const defs = rec.strategies_def || [];
  const stats = rec.stats || {};
  if (defs.length === 0) {
    return <div className="text-sm text-ink-muted py-2">検証データがまだありません。</div>;
  }

  // 嘘のない値 (overall_roi_pct_v2) を優先。無ければ overall_roi_pct。
  const rows = defs
    .map((d) => {
      const s = stats[d.key] || {};
      const roi = s.overall_roi_pct_v2 ?? s.overall_roi_pct ?? null;
      const leakFree = s.overall_roi_pct_v2 != null;
      return { label: d.short_label || d.label || d.key, roi, trust: s.trust_label || "", leakFree };
    })
    .filter((r) => r.roi != null)
    .sort((a, b) => (b.roi as number) - (a.roi as number));

  const profitable = rows.filter((r) => (r.roi as number) >= 100).length;

  return (
    <div className="mt-2 space-y-3">
      <div className="rounded-[12px] bg-wine-soft/40 border border-wine/20 p-3">
        <p className="text-sm text-ink-soft leading-relaxed">
          未来を見ない正直な検証では、
          <span className="font-semibold text-ink"> {rows.length} 戦略中 回収率100%超は {profitable} 個</span>
          （安定して勝てる戦略はありません）。下は各戦略の本当の回収率です。
        </p>
      </div>
      <div className="space-y-1.5">
        {rows.map((r) => {
          const roi = r.roi as number;
          const tone = roi >= 100 ? "text-deep-green" : roi >= 90 ? "text-ink-soft" : "text-wine";
          return (
            <div key={r.label} className="flex items-center justify-between gap-2 text-sm py-1.5 border-b border-line/30 last:border-0">
              <span className="text-ink-soft truncate min-w-0">{r.label}</span>
              <span className="flex items-center gap-2 shrink-0">
                {r.trust && <span className="text-[11px] text-ink-muted">{r.trust.replace(/\s*\(.*\)/, "")}</span>}
                <span className={cn("tabular font-medium", tone)}>{roi.toFixed(0)}%</span>
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-ink-muted">
        回収率100% = 賭けた額がそのまま戻る分岐点。それ未満は平均すると損です。
      </p>
    </div>
  );
}

// =========================================
// 騎手・調教師ランキング (過去データの集計)
// =========================================
type RankRow = { name: string; starts: number; wins: number; in3: number; win_rate: number; in3_rate: number };
type RankData = { jockeys?: RankRow[]; trainers?: RankRow[] };

function RankingList({ rows, loading }: { rows?: RankRow[]; loading: boolean }) {
  if (loading) return <div className="text-sm text-ink-muted py-2">読み込み中...</div>;
  if (!rows || rows.length === 0) return <div className="text-sm text-ink-muted py-2">集計データがまだありません。</div>;
  return (
    <div className="mt-2 space-y-1">
      {rows.map((r, i) => (
        <div key={r.name} className="flex items-center gap-3 text-sm py-1.5 border-b border-line/30 last:border-0">
          <span className={cn("w-5 text-center tabular text-xs font-semibold shrink-0", i === 0 ? "text-gold" : i < 3 ? "text-gold-deep" : "text-ink-faint")}>
            {i + 1}
          </span>
          <span className="flex-1 truncate text-ink-soft">{r.name}</span>
          <span className="text-sm text-ink-muted tabular shrink-0">{r.wins}勝/{r.starts}走</span>
          <span className="tabular font-medium text-ink shrink-0 w-14 text-right">勝率{r.win_rate}%</span>
        </div>
      ))}
      <p className="text-xs text-ink-muted pt-1">勝率＝1着になった割合。上位ほど安定して勝っています。</p>
    </div>
  );
}

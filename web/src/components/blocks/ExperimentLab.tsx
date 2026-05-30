"use client";

import { useEffect, useState } from "react";
import { FlaskConical, Trophy, TrendingDown, Sparkles } from "lucide-react";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { fetchExperimentStatus } from "@/lib/api";
import type { ExperimentStatusResponse, ExperimentStrategy } from "@/types/api";

/**
 * 実験室 — 自己成長する実験モード
 * ------------------------------------------------------------------
 * 2026-05-30 ユーザー指示「世の中の成功例を学習して試す検証モード・使うほど成長」。
 * 世の中の成功例(単勝・実力派AI本命・オッズ帯・期待値差)を9作戦として
 * 「紙の上で買ったつもり」にし、未来を見ない(リークなし)採点で正直に競わせる。
 * 本物の機能(本日の予想・収支など)は一切壊さず、別ブロックとして併存。
 */
export function ExperimentLab() {
  const [data, setData] = useState<ExperimentStatusResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetchExperimentStatus()
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const strategies = (data?.strategies || []).filter((s) => s.bets >= 30);

  return (
    <section aria-label="実験室・自己成長モード">
      <Card elevated className="overflow-hidden">
        {/* ヘッダ帯 */}
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-3 border-b border-line/60">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-ink-blue-soft text-ink-blue shrink-0">
            <FlaskConical className="w-4.5 h-4.5" />
          </span>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.16em] text-ink-blue font-medium">
              EXPERIMENT · 実験室
            </div>
            <h2 className="font-display text-lg md:text-xl font-semibold tracking-tight leading-tight">
              育つAI — 世の中の成功例を試して、自分で成長します
            </h2>
          </div>
        </div>

        <CardBody className="space-y-5">
          {/* 説明 */}
          <p className="text-sm md:text-[15px] text-ink-soft leading-relaxed">
            世の中で「当たった」と言われる作戦を集めて、
            <span className="font-semibold text-ink">紙の上で買ったつもり</span>にして競わせています。
            実際のお金は 1 円も使いません。未来の結果を一切見ずに採点しているので、ここの数字は
            <span className="font-semibold text-ink">正直な見込み</span>です。データが増えるたびに数字は更新され、作戦は自動で並び替わります。
          </p>

          {/* 今のひとこと */}
          {data?.ok && (
            <div className="rounded-[12px] bg-paper-soft/70 border border-line/60 p-4">
              <div className="flex items-start gap-2">
                <Sparkles className="w-4 h-4 text-gold shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink leading-snug">{data.headline}</p>
                  <p className="mt-1 text-[11px] text-ink-muted">
                    紙の元手 {data.start_bankroll?.toLocaleString()} 円 ・ 1 点 {data.unit_yen} 円 ・ {data.total_bet_records?.toLocaleString()} 回ぶんで採点
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* 作戦ランキング */}
          {strategies.length > 0 ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-[0.14em] text-ink-muted font-medium">
                  作戦ランキング（回収率の良い順）
                </div>
                <div className="text-[10px] text-ink-faint">★=100%超 / ▼=損</div>
              </div>
              {strategies.map((s, i) => (
                <StrategyRow key={s.key} s={s} rank={i + 1} champion={s.key === data?.champion_key} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-ink-muted">
              {loaded ? "準備中です。週末のデータがそろうと結果が出ます。" : "読み込み中…"}
            </p>
          )}

          {/* 自己成長の注記 */}
          {data?.note && (
            <p className="text-[11px] leading-relaxed text-ink-faint border-t border-line/60 pt-3">{data.note}</p>
          )}
        </CardBody>
      </Card>
    </section>
  );
}

/** 紙上収支カーブの小さなスパークライン */
function Sparkline({ curve }: { curve: number[] }) {
  if (!curve || curve.length < 2) return null;
  const w = 110;
  const h = 30;
  const min = Math.min(...curve);
  const max = Math.max(...curve);
  const span = max - min || 1;
  const pts = curve
    .map((v, i) => {
      const x = (i / (curve.length - 1)) * w;
      const y = h - ((v - min) / span) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = curve[curve.length - 1] >= curve[0];
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline
        points={pts}
        fill="none"
        stroke={up ? "var(--color-deep-green, #1a7a4a)" : "var(--color-wine, #b03a4a)"}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function originBadge(origin: string): "info" | "neutral" | "won" {
  if (origin === "世の中の成功例") return "info";
  if (origin === "手堅い") return "won";
  return "neutral";
}

function StrategyRow({ s, rank, champion }: { s: ExperimentStrategy; rank: number; champion: boolean }) {
  const roi = s.roi_pct;
  const winning = s.is_winning && s.bets >= 100;
  const isRuler = s.origin === "ものさし";
  const roiCls =
    roi == null ? "text-ink-faint" : roi >= 100 ? "text-deep-green" : roi >= 90 ? "text-gold" : "text-wine";
  return (
    <div
      className={`rounded-[12px] border p-3.5 ${
        champion
          ? "border-gold/40 bg-gold-soft/30"
          : isRuler
            ? "border-dashed border-line/70 bg-paper-soft/50"
            : "border-line/60 bg-paper"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-bold text-ink-faint tabular">{rank}.</span>
            <span className={`truncate text-sm font-semibold ${isRuler ? "text-ink-muted" : "text-ink"}`}>{s.name}</span>
            {champion && (
              <span className="inline-flex items-center gap-1 shrink-0 rounded-full bg-gold/20 px-1.5 py-0.5 text-[9px] font-bold text-gold">
                <Trophy className="w-3 h-3" />AI首位
              </span>
            )}
            {isRuler && (
              <span className="shrink-0 rounded-full bg-paper-soft px-1.5 py-0.5 text-[9px] font-medium text-ink-muted border border-line">
                比較用の基準
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] leading-snug text-ink-muted">{s.desc}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={originBadge(s.origin)} size="xs">{s.origin}</Badge>
            <span className="rounded-md border border-line/60 px-1.5 py-0.5 text-[9px] text-ink-muted">{s.bet_type}</span>
            <span className="text-[10px] text-ink-faint">
              的中 {s.hit_rate_pct ?? "—"}% ・ 紙上 {s.bets.toLocaleString()} 回
            </span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={`text-xl font-bold tabular ${roiCls}`}>{roi == null ? "—" : `${roi}%`}</div>
          <div className="text-[9px] text-ink-faint">回収率</div>
          <div className="mt-1 flex justify-end">
            <Sparkline curve={s.bankroll_curve} />
          </div>
        </div>
      </div>
      {roi != null && !winning && (
        <div className="mt-2 flex items-center gap-1 text-[10px] text-wine/80">
          <TrendingDown className="w-3 h-3" />まだ 100% に届かず（この作戦は長期で損）
        </div>
      )}
      {winning && (
        <div className="mt-2 text-[10px] text-deep-green">★ 過去データ上は 100% 超（継続観察中・まだ確定ではありません）</div>
      )}
    </div>
  );
}

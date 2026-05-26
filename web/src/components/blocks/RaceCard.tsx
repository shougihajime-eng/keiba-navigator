"use client";

import { useEffect, useState } from "react";
import { ChevronDown, CheckCircle2, Trophy } from "lucide-react";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { fetchRaceCard } from "@/lib/api";
import { cn } from "@/lib/utils";

type CardHorse = {
  number: number;
  name: string | null;
  win_prob: number | null;
  nopop_prob: number | null;
  odds: number | null;
  popularity: number | null;
  ev: number | null;
  finish: number | null;
  won: number;
};
type CardRace = {
  race_id: string;
  race_name: string | null;
  course: string | null;
  distance: number | null;
  going: string | null;
  is_g1: boolean;
  horse_count: number;
  has_result: boolean;
  winner_number: number | null;
  top_number: number | null;
  top_name: string | null;
  top_prob: number | null;
  top_odds: number | null;
  top_finish: number | null;
  top_in3: number;
  top_won: number;
  horses: CardHorse[];
};
type CardResp = {
  ok?: boolean;
  date?: string;
  race_count?: number;
  settled_count?: number;
  top1_win?: number;
  top1_in3?: number;
  races?: CardRace[];
};

const pct = (v?: number | null) => (typeof v === "number" ? `${Math.round(v * 100)}%` : "—");
const fmtDate = (d?: string) =>
  d && d.length === 8 ? `${Number(d.slice(4, 6))}月${Number(d.slice(6, 8))}日` : "";

export function RaceCard() {
  const [resp, setResp] = useState<CardResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchRaceCard().then((d) => {
      if (!alive) return;
      setResp((d as unknown as CardResp) || null);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  const races = resp?.races ?? [];
  const settled = resp?.settled_count ?? 0;

  return (
    <section aria-label="全レース予想">
      <div className="flex items-end justify-between mb-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em] text-gold-deep font-medium">
            FULL CARD · 全レース予想
          </div>
          <h2 className="mt-1 font-display text-2xl md:text-3xl font-semibold tracking-tight">
            全レースをAIが予想します
          </h2>
        </div>
        {resp?.date && (
          <Badge tone="gold" size="md">直近 {fmtDate(resp.date)} · {races.length}R</Badge>
        )}
      </div>

      <Card>
        <CardBody className="space-y-4">
          {loading ? (
            <div className="text-sm text-ink-muted py-6 text-center">全レースのAI予想を読み込み中...</div>
          ) : races.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">
              開催日のデータが入ると、その日の全レースのAI予想がここに並びます。
            </div>
          ) : (
            <>
              {/* 正直なトラックレコード */}
              {settled > 0 && (
                <div className="rounded-[12px] bg-paper-soft/70 border border-line/60 p-3.5">
                  <div className="text-[10px] uppercase tracking-[0.14em] text-ink-muted font-medium mb-2">
                    この日のAI本命の成績（正直な実績）
                  </div>
                  <div className="flex items-center gap-5">
                    <div>
                      <span className="font-display text-2xl font-semibold tabular text-ink">
                        {resp?.top1_in3}/{settled}
                      </span>
                      <span className="ml-1.5 text-xs text-ink-muted">が3着内</span>
                    </div>
                    <div>
                      <span className="font-display text-2xl font-semibold tabular text-ink">
                        {resp?.top1_win}/{settled}
                      </span>
                      <span className="ml-1.5 text-xs text-ink-muted">が1着</span>
                    </div>
                  </div>
                  <p className="mt-2 text-[11px] text-ink-faint leading-relaxed">
                    AIは全レースを予想しますが、買って勝てる場面は無いため全レース「見送り」が正直な判定です。下は各レースのAIの読みと実際の結果です。
                  </p>
                </div>
              )}

              <div className="divide-y divide-line/50">
                {races.map((r) => (
                  <RaceRow
                    key={r.race_id}
                    race={r}
                    open={open === r.race_id}
                    onToggle={() => setOpen(open === r.race_id ? null : r.race_id)}
                  />
                ))}
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </section>
  );
}

function RaceRow({ race, open, onToggle }: { race: CardRace; open: boolean; onToggle: () => void }) {
  const hit = race.has_result && race.top_in3 === 1;
  const won = race.has_result && race.top_won === 1;
  return (
    <div className="py-2.5">
      <button onClick={onToggle} className="w-full flex items-center gap-3 text-left group">
        <ChevronDown className={cn("w-4 h-4 text-ink-faint shrink-0 transition-transform", open && "rotate-180")} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            <span className="tabular truncate">{race.course || "—"}</span>
            {race.going && <span className="text-ink-faint">· {race.going}</span>}
            {race.is_g1 && <Badge tone="gold" size="xs">G1</Badge>}
          </div>
          <div className="mt-0.5 text-sm truncate">
            <span className="text-ink-muted">AI本命</span>{" "}
            <span className="font-medium text-ink">#{race.top_number} {race.top_name}</span>{" "}
            <span className="text-ink-muted tabular">
              {pct(race.top_prob)}{race.top_odds ? ` · ${race.top_odds.toFixed(1)}倍` : ""}
            </span>
          </div>
        </div>
        {race.has_result ? (
          won ? (
            <Badge tone="won" size="sm"><Trophy className="w-3 h-3" />的中 {race.top_finish}着</Badge>
          ) : hit ? (
            <Badge tone="won" size="sm"><CheckCircle2 className="w-3 h-3" />3着内 {race.top_finish}着</Badge>
          ) : (
            <Badge tone="silver" size="sm">{race.top_finish ? `${race.top_finish}着` : "—"}</Badge>
          )
        ) : (
          <Badge tone="silver" size="sm">見送り</Badge>
        )}
      </button>

      {open && (
        <>
        <div className="mt-3 ml-7 rounded-[12px] border border-line/60 bg-paper-soft/40 overflow-x-auto">
          <table className="w-full text-xs min-w-[360px]">
            <thead>
              <tr className="text-ink-faint border-b border-line/50">
                <th className="text-left font-medium px-3 py-2">AI順</th>
                <th className="text-left font-medium px-2 py-2">馬</th>
                <th className="text-right font-medium px-2 py-2">AI勝率</th>
                <th className="text-right font-medium px-2 py-2">市場%</th>
                <th className="text-right font-medium px-2 py-2">人気</th>
                <th className="text-right font-medium px-2 py-2">オッズ</th>
                {race.has_result && <th className="text-right font-medium px-3 py-2">着</th>}
              </tr>
            </thead>
            <tbody>
              {race.horses.slice(0, 18).map((h, i) => {
                const market = h.odds && h.odds > 0 ? Math.round((1 / h.odds) * 100) : null;
                return (
                  <tr key={h.number} className={cn("border-b border-line/30 last:border-0", h.won && "bg-deep-green-soft/40")}>
                    <td className="px-3 py-1.5 tabular text-ink-muted">{h.win_prob != null ? i + 1 : "—"}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <span className="tabular text-ink-muted">{h.number}</span>{" "}
                      <span className="text-ink-soft">{h.name}</span>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular text-ink">{pct(h.win_prob)}</td>
                    <td className="px-2 py-1.5 text-right tabular text-ink-muted">{market != null ? `${market}%` : "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular text-ink-muted">{h.popularity || "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular text-ink-muted">{h.odds != null ? `${h.odds.toFixed(1)}` : "—"}</td>
                    {race.has_result && (
                      <td className="px-3 py-1.5 text-right tabular font-medium">
                        {h.finish ? h.finish : "—"}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 ml-7 text-[11px] text-ink-faint leading-relaxed">
          「AI勝率」と「市場%（オッズが示す勝率）」がほぼ同じ＝AIと世間の評価が一致。だから市場が見落とした“お買い得”はほぼ無く、見送りが基本です。
        </p>
        </>
      )}
    </div>
  );
}

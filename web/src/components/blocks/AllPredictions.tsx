"use client";

import { useEffect, useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { fetchRecommendations } from "@/lib/api";

// /api/recommendations の実レスポンス (型定義に無いフィールドを補う)
type RecHorse = {
  number?: number;
  name?: string;
  win_prob?: number;
  nopop_prob?: number;
  value_signal?: number;
  odds?: number | null;
  popularity?: number;
};
type RecRace = {
  race_id?: string;
  race_name?: string | null;
  course?: string | null;
  distance?: number | null;
  going?: string | null;
  is_g1?: boolean;
  horse?: RecHorse;
  top3?: RecHorse[];
};
type RecResp = {
  ok?: boolean;
  total_predictions?: number;
  count_recent?: number;
  recommendations_recent?: RecRace[];
};

const pct = (v?: number) => (typeof v === "number" ? `${Math.round(v * 100)}%` : "—");

export function AllPredictions() {
  const [resp, setResp] = useState<RecResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchRecommendations().then((d) => {
      if (!alive) return;
      setResp((d as unknown as RecResp) || null);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  const races = resp?.recommendations_recent ?? [];
  const shown = showAll ? races : races.slice(0, 10);
  const total = resp?.total_predictions ?? 0;

  return (
    <section aria-label="AIの全レース予想">
      <div className="flex items-end justify-between mb-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em] text-gold-deep font-medium">
            AI PREDICTIONS · AIの予想
          </div>
          <h2 className="mt-1 font-display text-2xl md:text-3xl font-semibold tracking-tight">
            全レースをAIが予想します
          </h2>
        </div>
        {total > 0 && (
          <Badge tone="gold" size="md">
            <Brain className="w-3.5 h-3.5" />
            学習 {total.toLocaleString()} R
          </Badge>
        )}
      </div>

      <Card>
        <CardBody className="space-y-4">
          <p className="text-sm text-ink-soft leading-relaxed">
            人気を見ない「実力派AI」が、各レースで勝つ可能性が高いと見た馬です。
            <span className="text-ink-muted">
              {" "}ただし検証では買って勝てる場面が無いため、すべて
            </span>
            <span className="font-medium text-ink"> 参考（見送り推奨）</span>
            <span className="text-ink-muted"> としてご覧ください。</span>
          </p>

          {loading ? (
            <div className="text-sm text-ink-muted py-6 text-center">AIの予想を読み込み中...</div>
          ) : races.length === 0 ? (
            <div className="text-sm text-ink-muted py-6 text-center">
              開催日のデータが入ると、直近レースのAI予想がここに並びます。
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {shown.map((r, i) => (
                  <PredictionRow key={r.race_id || i} race={r} />
                ))}
              </div>
              {races.length > 10 && (
                <button
                  onClick={() => setShowAll((v) => !v)}
                  className="w-full text-center text-xs text-gold-deep hover:text-gold font-medium py-1.5 transition-colors"
                >
                  {showAll ? "閉じる" : `他 ${races.length - 10} レースも見る`}
                </button>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </section>
  );
}

function PredictionRow({ race }: { race: RecRace }) {
  const h = race.horse;
  const prob = h?.nopop_prob ?? h?.win_prob;
  // 実力派AIの確信度バー (0.30で満タン目安)
  const fill = Math.min(100, Math.round(((prob ?? 0) / 0.3) * 100));

  return (
    <div className="rounded-[12px] border border-line/60 bg-paper-soft/40 p-3.5">
      <div className="flex items-center gap-2 text-xs text-ink-muted">
        <span className="tabular truncate">{race.course || "—"}</span>
        {race.going && <span className="text-ink-faint">· {race.going}</span>}
        {race.is_g1 && <Badge tone="gold" size="xs">G1</Badge>}
        <span className="ml-auto shrink-0">
          <Badge tone="silver" size="xs">参考</Badge>
        </span>
      </div>

      {race.race_name && (
        <div className="mt-1 text-sm font-medium text-ink-soft truncate">{race.race_name}</div>
      )}

      <div className="mt-2 flex items-center gap-2.5">
        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-gold-soft text-gold-deep font-display font-semibold text-sm tabular shrink-0">
          {h?.number ?? "—"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{h?.name || "—"}</div>
          <div className="mt-1 h-1.5 rounded-full bg-line/60 overflow-hidden">
            <div className="h-full rounded-full bg-gold/70" style={{ width: `${fill}%` }} />
          </div>
        </div>
        <span className="text-sm tabular text-ink-soft shrink-0">{pct(prob)}</span>
      </div>

      {race.top3 && race.top3.length > 1 && (
        <div className="mt-2 flex items-center gap-1 text-[11px] text-ink-muted">
          <ChevronRight className="w-3 h-3 shrink-0" />
          <span className="truncate">
            相手: {race.top3.slice(1, 3).map((t) => `${t.number}番`).join(" / ")}
          </span>
        </div>
      )}
    </div>
  );
}

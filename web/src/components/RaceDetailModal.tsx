"use client";

import { useEffect } from "react";
import { X, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { StarRating, ratingLabel } from "@/components/ui/StarRating";
import { formatHHMM, cn } from "@/lib/utils";
import { ratingFromRace, shortReason } from "@/lib/rating";
import type { RaceSummary, HorsePick } from "@/types/api";

interface Props {
  race: RaceSummary | null;
  onClose: () => void;
  onBuy?: () => void;
}

const ROLE = ["本命", "対抗", "3着候補"];

export function RaceDetailModal({ race, onClose, onBuy }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!race) return null;

  const rating = ratingFromRace(race);
  const venueLabel = race.venue || race.course || "";
  const raceNum = race.raceName?.match(/(\d{1,2})R/)?.[1] || "";
  const picks = [race.topPick, race.second, race.third].filter(
    (p): p is HorsePick => !!p && p.number != null,
  );
  const surface =
    race.surface === "turf" ? "芝" : race.surface === "dirt" ? "ダート" : "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/70 backdrop-blur-md anim-fade-up"
      onClick={onClose}
    >
      <div
        className="bg-paper border border-line-strong w-full md:max-w-lg rounded-t-[24px] md:rounded-[20px] shadow-[var(--shadow-lg)] surface-raised anim-rise-in max-h-[92dvh] overflow-y-auto overscroll-contain"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="レース詳細"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-line sticky top-0 bg-paper/95 backdrop-blur-sm z-10">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {race.isG1 && <Badge tone="gold">G1</Badge>}
              <StarRating rating={rating} size="sm" />
              <span className="text-xs text-ink-muted">{ratingLabel(rating)}</span>
            </div>
            <div className="mt-1.5 text-xs text-ink-muted tabular">
              {venueLabel} {raceNum && `${raceNum}R`} ·{" "}
              {race.startTime ? `${formatHHMM(race.startTime)} 発走` : ""}
              {surface && race.distance ? ` · ${surface}${race.distance}m` : ""}
            </div>
            <h3 className="font-display text-xl font-semibold tracking-tight mt-0.5">
              {race.raceName || venueLabel}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-paper-hover text-ink-muted transition-colors shrink-0"
            aria-label="閉じる"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-5 space-y-5">
          {/* AI の結論 */}
          <div className="grid grid-cols-3 gap-3">
            <MiniStat label="期待値" value={race.topPick?.ev?.toFixed(2) ?? "—"} />
            <MiniStat
              label="信頼度"
              value={race.confidence ? `${Math.round(race.confidence * 100)}%` : "—"}
            />
            <MiniStat
              label="出走頭数"
              value={race.horseCount ? `${race.horseCount}頭` : "—"}
            />
          </div>

          {/* AI 予想ランキング */}
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-ink-muted font-medium mb-2">
              AI の予想 (上位)
            </div>
            {picks.length > 0 ? (
              <div className="space-y-2">
                {picks.map((p, i) => (
                  <div
                    key={`${p.number}-${i}`}
                    className={cn(
                      "flex items-center gap-3 p-3 rounded-[12px] border",
                      i === 0
                        ? "border-gold/40 bg-gold-soft/40"
                        : "border-line bg-paper-soft/40",
                    )}
                  >
                    <span className="text-[10px] text-ink-muted w-12 shrink-0 font-medium">
                      {ROLE[i] || `${i + 1}番手`}
                    </span>
                    <span
                      className={cn(
                        "inline-flex items-center justify-center w-8 h-8 rounded-full font-display font-semibold tabular shrink-0",
                        i === 0
                          ? "bg-gradient-to-b from-gold-bright to-gold text-on-gold shadow-[0_4px_14px_rgba(232,194,108,0.35)]"
                          : "bg-paper-hover text-ink border border-line-strong",
                      )}
                    >
                      {p.number}
                    </span>
                    <span className="font-medium truncate flex-1">{p.name || "—"}</span>
                    <span className="text-right shrink-0">
                      {p.prob != null && (
                        <span className="block text-sm tabular font-medium">
                          {Math.round(p.prob * 100)}%
                        </span>
                      )}
                      <span className="block text-xs tabular text-ink-muted">
                        {p.odds != null ? `${p.odds.toFixed(1)}倍` : ""}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-muted py-2">
                予想データがまだ揃っていません。
              </p>
            )}
          </div>

          {/* 根拠 */}
          {shortReason(race) && (
            <div className="rounded-[12px] bg-paper-soft/60 border border-line/60 p-3.5">
              <div className="text-[10px] uppercase tracking-[0.14em] text-ink-muted font-medium mb-1">
                このレースの根拠
              </div>
              <p className="text-sm text-ink-soft leading-relaxed">{shortReason(race)}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-line flex gap-2 sticky bottom-0 bg-paper/95 backdrop-blur-sm">
          <a
            href="https://www.jra.go.jp/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 h-11 px-5 text-[15px] rounded-[12px] font-medium bg-paper text-ink border border-line hover:bg-paper-hover transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            JRA公式
          </a>
          {onBuy && (
            <Button variant="gold" size="md" className="flex-1" onClick={onBuy}>
              これ買う
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="text-center rounded-[12px] border border-line/60 bg-paper-soft/40 py-2.5">
      <div className="text-[10px] uppercase tracking-[0.12em] text-ink-muted font-medium">
        {label}
      </div>
      <div className="mt-1 font-display tabular text-lg font-semibold">{value}</div>
    </div>
  );
}

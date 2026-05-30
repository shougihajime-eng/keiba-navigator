"use client";

import { useEffect, useState } from "react";
import { X, Check } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { StarRating } from "@/components/ui/StarRating";
import { Stat } from "@/components/ui/Stat";
import { formatYen, cn } from "@/lib/utils";
import { addBet } from "@/lib/store";
import type { RaceSummary } from "@/types/api";
import type { Rating } from "@/lib/rating";

interface BetConfirmModalProps {
  race: RaceSummary | null;
  rating: Rating;
  stake: number;
  betType?: string;
  isFinal?: boolean;
  onClose: () => void;
}

export function BetConfirmModal({
  race,
  rating,
  stake: initialStake,
  betType = "複勝",
  isFinal = false,
  onClose,
}: BetConfirmModalProps) {
  const [stake, setStake] = useState(initialStake);
  const [type, setType] = useState(betType);
  const [horses, setHorses] = useState(String(race?.topPick?.number ?? ""));
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setStake(initialStake);
    setHorses(String(race?.topPick?.number ?? ""));
  }, [initialStake, race]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!race) return null;

  const expectedReturn = stake && race.topPick?.ev
    ? Math.round(stake * race.topPick.ev)
    : null;

  const handleConfirm = () => {
    if (!race.raceId) return;
    addBet({
      id: `${race.raceId}_${Date.now()}`,
      raceId: race.raceId,
      raceName: race.raceName ?? undefined,
      course: race.course ?? undefined,
      startTime: race.startTime ?? undefined,
      type,
      horses,
      amount: stake,
      ev: race.topPick?.ev ?? undefined,
      result: "pending",
      isDraft: true,
      createdAt: new Date().toISOString(),
      factors: { rating, source: "phase3_modal", isFinal },
    });
    setSaved(true);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("keiba:bet-added"));
    }
    setTimeout(onClose, 900);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/70 backdrop-blur-md anim-fade-up"
      onClick={onClose}
    >
      <div
        className="bg-paper border border-line-strong w-full md:max-w-md rounded-t-[24px] md:rounded-[20px] shadow-[var(--shadow-lg)] surface-raised anim-rise-in max-h-[92dvh] overflow-y-auto overscroll-contain"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {saved ? (
          <div className="py-10 px-6 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-deep-green-soft text-deep-green mb-4">
              <Check className="w-8 h-8" strokeWidth={2.5} />
            </div>
            <h3 className="font-display text-xl font-semibold">記録しました</h3>
            <p className="mt-2 text-sm text-ink-muted">レース後に自動で結果照合されます</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <div className="flex items-center gap-2">
                {isFinal ? (
                  <Badge tone="final">最終確定</Badge>
                ) : (
                  <Badge tone="tentative">暫定買い</Badge>
                )}
                <StarRating rating={rating} size="sm" />
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded-full hover:bg-paper-hover text-ink-muted transition-colors"
                aria-label="閉じる"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-5 py-5 space-y-5">
              <div>
                <div className="text-xs text-ink-muted tabular">
                  {race.venue || race.course} · {race.startTime?.slice(11, 16) || "--:--"} 発走
                </div>
                <h3 className="font-display text-xl font-semibold tracking-tight mt-1">
                  {race.raceName}
                </h3>
              </div>

              <div className="bg-paper-soft/70 rounded-[12px] p-3.5 border border-line/60">
                <div className="text-[10px] uppercase tracking-[0.14em] text-ink-muted font-medium">
                  本命
                </div>
                <div className="mt-1 flex items-center gap-2.5">
                  <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-b from-gold-bright to-gold text-on-gold font-display font-semibold tabular text-base shadow-[0_4px_14px_rgba(232,194,108,0.35)]">
                    {race.topPick?.number ?? "—"}
                  </span>
                  <span className="font-medium text-base">{race.topPick?.name ?? "—"}</span>
                  <span className="ml-auto text-sm tabular text-ink-muted">
                    {race.topPick?.odds ? `${race.topPick.odds.toFixed(1)}倍` : ""}
                  </span>
                </div>
              </div>

              {/* Bet type */}
              <div>
                <label className="text-[11px] uppercase tracking-[0.14em] text-ink-muted font-medium">
                  券種
                </label>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {["複勝", "単勝", "馬連", "ワイド", "3連複", "3連単"].map((t) => (
                    <button
                      key={t}
                      onClick={() => setType(t)}
                      className={cn(
                        "py-2 text-sm font-medium rounded-[10px] border transition-all",
                        type === t
                          ? "border-ink bg-ink text-paper"
                          : "border-line bg-paper hover:bg-paper-hover text-ink-soft",
                      )}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              {/* Horses */}
              <div>
                <label className="text-[11px] uppercase tracking-[0.14em] text-ink-muted font-medium">
                  買い目 (馬番)
                </label>
                <input
                  type="text"
                  value={horses}
                  onChange={(e) => setHorses(e.target.value)}
                  placeholder="例: 5  または  5-7"
                  className="mt-2 w-full h-11 px-3 rounded-[10px] border border-line bg-paper text-base tabular focus:border-gold outline-none transition-colors"
                />
              </div>

              {/* Amount */}
              <div>
                <label className="text-[11px] uppercase tracking-[0.14em] text-ink-muted font-medium">
                  投資額
                </label>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {[5000, 10000, 15000].map((amt) => (
                    <button
                      key={amt}
                      onClick={() => setStake(amt)}
                      className={cn(
                        "py-2.5 text-sm font-medium rounded-[10px] border transition-all tabular",
                        stake === amt
                          ? "border-gold bg-gold-soft text-ink"
                          : "border-line bg-paper hover:bg-paper-hover text-ink-soft",
                      )}
                    >
                      ¥{amt.toLocaleString()}
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  step={100}
                  min={100}
                  value={stake}
                  onChange={(e) => setStake(Math.max(100, Number(e.target.value) || 100))}
                  className="mt-2 w-full h-11 px-3 rounded-[10px] border border-line bg-paper text-base tabular focus:border-gold outline-none transition-colors"
                />
              </div>

              {/* Summary */}
              <div className="grid grid-cols-3 gap-3 pt-2 border-t border-line">
                <Stat label="期待値" value={race.topPick?.ev?.toFixed(2) ?? "—"} size="md" />
                <Stat label="信頼度" value={race.confidence ? Math.round(race.confidence * 100) : "—"} unit="%" size="md" />
                <Stat
                  label="予想戻り"
                  value={expectedReturn ? formatYen(expectedReturn) : "—"}
                  tone="positive"
                  size="md"
                />
              </div>
            </div>

            <div className="px-5 py-4 border-t border-line flex gap-2">
              <Button variant="secondary" size="md" onClick={onClose}>キャンセル</Button>
              <Button
                variant={isFinal ? "ruby" : "gold"}
                size="md"
                className="flex-1"
                onClick={handleConfirm}
                disabled={!horses || stake < 100}
              >
                {formatYen(stake)} で記録
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

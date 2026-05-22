"use client";

import { useEffect, useState } from "react";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { StarRating, ratingLabel } from "@/components/ui/StarRating";
import { Stat } from "@/components/ui/Stat";
import { HorseLoader } from "@/components/ui/HorseLoader";
import { Horseshoe } from "@/components/icons/Horseshoe";
import { fetchRaces } from "@/lib/api";
import { ratingFromRace, sortByRating, shortReason } from "@/lib/rating";
import { formatHHMM, minutesUntil, formatYen } from "@/lib/utils";
import { addBet } from "@/lib/store";
import type { RaceSummary, RacesResponse } from "@/types/api";
import { cn } from "@/lib/utils";

const RECOMMEND_AMOUNT: Record<number, number> = {
  5: 1000,
  4: 600,
  3: 400,
  2: 300,
  1: 0,
};

export function BlockA() {
  const [resp, setResp] = useState<RacesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    (async () => {
      const data = await fetchRaces();
      if (!alive) return;
      setResp(data);
      setLoading(false);
    })();
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => { alive = false; clearInterval(tick); };
  }, []);

  if (loading) {
    return (
      <section>
        <SectionHeader />
        <Card><CardBody><HorseLoader label="今日のレースを集計中..." /></CardBody></Card>
      </section>
    );
  }

  if (!resp || !resp.ok || !resp.races || resp.races.length === 0) {
    return (
      <section>
        <SectionHeader />
        <NoRaceCard reason={resp?.reason || "本日は開催がありません"} />
      </section>
    );
  }

  const sorted = sortByRating(resp.races);
  const bettable = sorted.filter((r) => ratingFromRace(r) >= 4);
  const skip = sorted.filter((r) => ratingFromRace(r) <= 3);

  if (bettable.length === 0) {
    return (
      <section>
        <SectionHeader />
        <NoBettableCard skipCount={skip.length} sample={sorted.slice(0, 3)} />
      </section>
    );
  }

  return (
    <section>
      <SectionHeader count={bettable.length} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 stagger">
        {bettable.map((race) => (
          <RaceCard key={race.raceId || race.raceName} race={race} now={now} />
        ))}
      </div>

      {skip.length > 0 && (
        <div className="mt-6">
          <div className="text-xs uppercase tracking-[0.16em] text-ink-muted mb-2">
            見送り推奨 · {skip.length} 件
          </div>
          <Card>
            <CardBody className="divide-y divide-line/60">
              {skip.slice(0, 6).map((r) => (
                <SkipRow key={r.raceId} race={r} />
              ))}
              {skip.length > 6 && (
                <div className="pt-3 text-xs text-ink-muted">
                  他 {skip.length - 6} レースも見送り
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </section>
  );
}

// =========================================
// Sub components
// =========================================

function SectionHeader({ count }: { count?: number }) {
  return (
    <div className="flex items-end justify-between mb-3">
      <div>
        <div className="text-[10px] uppercase tracking-[0.16em] text-gold-deep font-medium">
          TODAY · 本日の勝負レース
        </div>
        <h2 className="mt-1 font-display text-2xl md:text-3xl font-semibold tracking-tight">
          今日いちばん買うのはこれ
        </h2>
      </div>
      {count !== undefined && (
        <Badge tone="gold" size="md" className="anim-gold-pulse">
          <Horseshoe className="w-3.5 h-3.5" />
          {count} 件
        </Badge>
      )}
    </div>
  );
}

function RaceCard({ race, now }: { race: RaceSummary; now: number }) {
  const rating = ratingFromRace(race);
  const isUltra = rating === 5;
  const startMs = race.startTime ? Date.parse(race.startTime) : NaN;
  const minutes = Number.isFinite(startMs) ? Math.round((startMs - now) / 60000) : NaN;
  const isFinalMode = Number.isFinite(minutes) && minutes <= 10 && minutes >= -5;
  const isImminent = Number.isFinite(minutes) && minutes <= 5 && minutes >= -1;

  const tone = isUltra ? "gold" : isFinalMode ? "final" : "tentative";
  const stake = RECOMMEND_AMOUNT[rating] ?? 0;
  const expectedReturn = stake && race.topPick?.ev ? Math.round(stake * race.topPick.ev) : null;

  const venueLabel = race.venue || race.course || "";
  const raceNum = race.raceName?.match(/(\d{1,2})R/)?.[1] || "";

  const handleBuy = () => {
    if (!race.raceId || !race.topPick) return;
    addBet({
      id: `${race.raceId}_${Date.now()}`,
      raceId: race.raceId,
      raceName: race.raceName ?? undefined,
      course: race.course ?? undefined,
      startTime: race.startTime ?? undefined,
      type: "複勝",
      horses: String(race.topPick.number),
      amount: stake,
      ev: race.topPick.ev ?? undefined,
      result: "pending",
      isDraft: true,
      createdAt: new Date().toISOString(),
      factors: { rating, source: "phase2_block_a" },
    });
    if (typeof window !== "undefined") {
      const evt = new CustomEvent("keiba:bet-added");
      window.dispatchEvent(evt);
    }
  };

  return (
    <Card tone={tone} elevated className={cn(isUltra && "anim-gold-pulse")}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {isFinalMode ? (
                <Badge tone="final">最終確定 · {minutes <= 0 ? "発走間近" : `${minutes}分前`}</Badge>
              ) : (
                <Badge tone="tentative">暫定予想</Badge>
              )}
              {race.isG1 && <Badge tone="gold">G1</Badge>}
            </div>
            <div className="mt-2 text-xs text-ink-muted tabular">
              {venueLabel} {raceNum && `${raceNum}R`} · {race.startTime ? formatHHMM(race.startTime) : "--:--"} 発走
            </div>
            <h3 className={cn(
              "font-display text-2xl md:text-[26px] font-semibold tracking-tight mt-1",
              isUltra && "shimmer-text",
            )}>
              {race.raceName || venueLabel}
            </h3>
          </div>
          {isUltra && <Horseshoe className="w-7 h-7 text-gold-deep shrink-0" />}
        </div>
      </CardHeader>

      <CardBody className="pt-0 space-y-4">
        <div className="flex items-center justify-between">
          <StarRating rating={rating} size="lg" />
          <span className="text-xs text-ink-muted font-medium">{ratingLabel(rating)}</span>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Stat
            label="期待値"
            value={race.topPick?.ev?.toFixed(2) ?? "—"}
            tone={isUltra ? "gold" : "default"}
            size="md"
          />
          <Stat
            label="信頼度"
            value={race.confidence ? Math.round(race.confidence * 100) : "—"}
            unit="%"
            size="md"
          />
          <Stat
            label="推奨"
            value={formatYen(stake)}
            size="md"
          />
        </div>

        <div className="bg-paper-soft/70 rounded-[12px] p-3.5 border border-line/60">
          <div className="text-[10px] uppercase tracking-[0.14em] text-ink-muted font-medium">本命</div>
          <div className="mt-1 flex items-center gap-2.5">
            <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-ink text-paper font-display font-semibold tabular">
              {race.topPick?.number ?? "—"}
            </span>
            <span className="font-medium text-base truncate">{race.topPick?.name ?? "—"}</span>
            <span className="ml-auto text-sm tabular text-ink-muted">
              {race.topPick?.odds ? `${race.topPick.odds.toFixed(1)}倍` : ""}
            </span>
          </div>
        </div>

        <p className="text-sm text-ink-soft leading-relaxed">
          {shortReason(race) || "—"}
          {expectedReturn !== null && (
            <span className="block mt-1 text-xs text-ink-muted">
              予想戻り: 約 {formatYen(expectedReturn)}
            </span>
          )}
        </p>
      </CardBody>

      <CardFooter className="flex gap-2">
        <Button
          variant={isUltra ? "gold" : isFinalMode ? "ruby" : "primary"}
          size="md"
          className={cn("flex-1", isImminent && "anim-gold-pulse")}
          onClick={handleBuy}
        >
          これ買う {stake > 0 && `· ${formatYen(stake)}`}
        </Button>
        <Button variant="secondary" size="md">詳細</Button>
      </CardFooter>
    </Card>
  );
}

function SkipRow({ race }: { race: RaceSummary }) {
  const rating = ratingFromRace(race);
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
      <div className="flex items-center gap-3 min-w-0">
        <StarRating rating={rating} size="sm" />
        <span className="text-xs text-ink-muted tabular shrink-0">
          {race.startTime ? formatHHMM(race.startTime) : "--:--"}
        </span>
        <span className="truncate text-ink-soft">
          {race.venue || race.course} · {race.raceName}
        </span>
      </div>
      <span className="text-xs text-ink-muted tabular shrink-0">
        EV {race.topPick?.ev?.toFixed(2) ?? "—"}
      </span>
    </div>
  );
}

function NoRaceCard({ reason }: { reason: string }) {
  return (
    <Card>
      <CardBody className="py-12 text-center">
        <Horseshoe className="w-12 h-12 text-line-strong mx-auto mb-4" />
        <h3 className="font-display text-2xl font-semibold tracking-tight">今日は開催なし</h3>
        <p className="mt-2 text-sm text-ink-muted max-w-md mx-auto">{reason}</p>
        <p className="mt-4 text-xs text-ink-faint">次の開催日まで休む日。AI は明日以降の予想を準備しています</p>
      </CardBody>
    </Card>
  );
}

function NoBettableCard({ skipCount, sample }: { skipCount: number; sample: RaceSummary[] }) {
  return (
    <Card>
      <CardBody>
        <div className="text-center py-6">
          <Horseshoe className="w-10 h-10 text-line-strong mx-auto mb-3" />
          <h3 className="font-display text-xl font-semibold">今日は買うべきレースなし</h3>
          <p className="mt-2 text-sm text-ink-muted">
            {skipCount} レース全部で期待値プラスが出なかった日。<br />
            <span className="text-ink-soft font-medium">買わないのも勝つための判断</span>
          </p>
        </div>
        {sample.length > 0 && (
          <div className="mt-4 pt-4 border-t border-line/60">
            <div className="text-[10px] uppercase tracking-[0.14em] text-ink-muted mb-2">
              強いて挙げるなら
            </div>
            <div className="divide-y divide-line/60">
              {sample.map((r) => <SkipRow key={r.raceId} race={r} />)}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

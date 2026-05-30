"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { StarRating, ratingLabel } from "@/components/ui/StarRating";
import { Stat } from "@/components/ui/Stat";
import { HorseLoader } from "@/components/ui/HorseLoader";
import { Horseshoe } from "@/components/icons/Horseshoe";
import { HorseHero } from "@/components/icons/HorseHero";
import { BetConfirmModal } from "@/components/BetConfirmModal";
import { RaceDetailModal } from "@/components/RaceDetailModal";
import { fetchRaces } from "@/lib/api";
import { ratingFromRace, sortByRating, shortReason, cooledEv, type Rating } from "@/lib/rating";
import { getBudget, fukushoStake } from "@/lib/bankroll";
import { formatHHMM, formatYen, cn } from "@/lib/utils";
import { saveSnapshot, compareWithSnapshot, pruneOldSnapshots, type Diff } from "@/lib/snapshot";
import { notifyOnce, pruneNotifyHistory } from "@/lib/notify";
import type { RaceSummary, RacesResponse } from "@/types/api";

/** 星(rating)を4段階tierに対応 */
function ratingToTier(rating: number): "prime" | "bet" | "watch" | "skip" {
  if (rating >= 5) return "prime";
  if (rating >= 4) return "bet";
  if (rating >= 3) return "watch";
  return "skip";
}
/** 予算連動の複勝おすすめ金額 (絶好機=予算3% / 勝負=その7割) */
function recommendStake(rating: number, budget: number): number {
  return fukushoStake(ratingToTier(rating), budget);
}

export function BlockA() {
  const [resp, setResp] = useState<RacesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [budget, setBudget] = useState(10000);
  const [modalRace, setModalRace] = useState<{
    race: RaceSummary; rating: Rating; stake: number; isFinal: boolean;
  } | null>(null);
  const [detailRace, setDetailRace] = useState<RaceSummary | null>(null);

  // 資金管理カードの予算に追従 (複勝おすすめ金額に使う)
  useEffect(() => {
    const read = () => setBudget(getBudget());
    read();
    window.addEventListener("keiba:budget-changed", read);
    return () => window.removeEventListener("keiba:budget-changed", read);
  }, []);

  useEffect(() => {
    pruneOldSnapshots();
    pruneNotifyHistory();

    let alive = true;
    let fetchTimer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      const data = await fetchRaces();
      if (!alive) return;
      setResp(data);
      setLoading(false);

      // 朝の暫定スナップショットを保存
      if (data?.ok && data.races) {
        for (const r of data.races) {
          if (!r.raceId) continue;
          const rating = ratingFromRace(r);
          if (r.startTime) {
            const min = Math.round((Date.parse(r.startTime) - Date.now()) / 60000);
            if (min > 15) saveSnapshot(r, rating);
          } else {
            saveSnapshot(r, rating);
          }
        }
      }

      // 次回のポーリング間隔を動的に決定:
      //   レース発走 15 分前 ~ 5 分後の窓内に居るなら 20 秒
      //   それ以外は 60 秒
      const intervalMs = computeNextInterval(data?.races || []);
      if (alive) fetchTimer = setTimeout(load, intervalMs);
    };

    load();
    const tickClock = setInterval(() => setNow(Date.now()), 30_000);

    // Page Visibility: 非アクティブで停止・復帰で即取得
    const onVisibility = () => {
      if (document.hidden) {
        if (fetchTimer) { clearTimeout(fetchTimer); fetchTimer = null; }
      } else {
        setNow(Date.now());
        if (alive && !fetchTimer) load();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      clearInterval(tickClock);
      if (fetchTimer) clearTimeout(fetchTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // 10 分前通知
  useEffect(() => {
    if (!resp?.races) return;
    for (const r of resp.races) {
      if (!r.startTime || !r.raceId) continue;
      const rating = ratingFromRace(r);
      if (rating < 4) continue;
      const min = Math.round((Date.parse(r.startTime) - now) / 60000);
      if (min <= 10 && min > 0) {
        const stars = "★".repeat(rating) + "☆".repeat(5 - rating);
        notifyOnce(r.raceId, "10min-before", {
          title: `${stars} ${min} 分前 · ${r.venue || r.course || ""} ${r.raceName || ""}`,
          body: `本命 ${r.topPick?.number}番 ${r.topPick?.name || ""}  EV ${r.topPick?.ev?.toFixed(2) || "—"}`,
        });
      }
      // 降格通知 (暫定で 4+ だったが今 3 以下に落ちた)
      const diff = compareWithSnapshot(r, rating);
      if (diff.ratingChanged && diff.oldRating !== null && diff.oldRating >= 4 && rating < 4 && r.raceId) {
        notifyOnce(r.raceId, "demoted", {
          title: `見送り推奨に降格: ${r.raceName}`,
          body: diff.message,
        });
      }
    }
  }, [resp, now]);

  const sorted = useMemo(() => (resp?.races ? sortByRating(resp.races) : []), [resp]);

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

  const bettable = sorted.filter((r) => ratingFromRace(r) >= 4);
  const skip = sorted.filter((r) => ratingFromRace(r) <= 3);

  // 全レースで topPick が空 or EV が全て 0 = JRA-VAN がまだ出走馬・オッズを配信していない状態
  const allPending =
    sorted.length > 0 &&
    sorted.every((r) => !r.topPick?.number || (r.topPick?.ev ?? 0) === 0);

  return (
    <section>
      <SectionHeader count={bettable.length} />

      {allPending ? (
        <PendingDataCard
          raceCount={sorted.length}
          fetchedAt={resp.fetchedAt}
          onRefresh={() => {
            setLoading(true);
            fetchRaces().then((data) => {
              setResp(data);
              setLoading(false);
            });
          }}
        />
      ) : bettable.length === 0 ? (
        <NoBettableCard skipCount={skip.length} sample={sorted.slice(0, 3)} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 stagger">
          {bettable.map((race) => (
            <RaceCard
              key={race.raceId || race.raceName}
              race={race}
              now={now}
              budget={budget}
              onBuyClick={(r, rating, stake, isFinal) =>
                setModalRace({ race: r, rating, stake, isFinal })
              }
              onDetailClick={(r) => setDetailRace(r)}
            />
          ))}
        </div>
      )}

      {skip.length > 0 && (
        <div className="mt-6">
          <div className="text-xs uppercase tracking-[0.16em] text-ink-muted mb-2">
            見送り推奨 · {skip.length} 件
          </div>
          <Card>
            <CardBody className="divide-y divide-line/60">
              {skip.slice(0, 6).map((r) => (
                <SkipRow key={r.raceId} race={r} onClick={() => setDetailRace(r)} />
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

      {modalRace && (
        <BetConfirmModal
          race={modalRace.race}
          rating={modalRace.rating}
          stake={modalRace.stake}
          isFinal={modalRace.isFinal}
          onClose={() => setModalRace(null)}
        />
      )}

      {detailRace && (
        <RaceDetailModal
          race={detailRace}
          onClose={() => setDetailRace(null)}
          onBuy={() => {
            const r = detailRace;
            const rating = ratingFromRace(r);
            const startMs = r.startTime ? Date.parse(r.startTime) : NaN;
            const minutes = Number.isFinite(startMs)
              ? Math.round((startMs - Date.now()) / 60000)
              : NaN;
            const isFinal = Number.isFinite(minutes) && minutes <= 10 && minutes >= -5;
            setDetailRace(null);
            setModalRace({ race: r, rating, stake: recommendStake(rating, budget), isFinal });
          }}
        />
      )}
    </section>
  );
}

// =========================================
// Smart polling: 発走前後 15 分窓では 20 秒・それ以外は 60 秒
// =========================================
function computeNextInterval(races: RaceSummary[]): number {
  const now = Date.now();
  for (const r of races) {
    if (!r.startTime) continue;
    const startMs = Date.parse(r.startTime);
    if (!Number.isFinite(startMs)) continue;
    const min = (startMs - now) / 60000;
    if (min <= 15 && min >= -5) {
      return 20_000; // 集中窓: 20 秒
    }
  }
  return 60_000; // 通常: 60 秒
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
      {count !== undefined && count > 0 && (
        <Badge tone="gold" size="md" className="anim-gold-pulse">
          <Horseshoe className="w-3.5 h-3.5" />
          {count} 件
        </Badge>
      )}
    </div>
  );
}

function RaceCard({
  race,
  now,
  budget,
  onBuyClick,
  onDetailClick,
}: {
  race: RaceSummary;
  now: number;
  budget: number;
  onBuyClick: (race: RaceSummary, rating: Rating, stake: number, isFinal: boolean) => void;
  onDetailClick: (race: RaceSummary) => void;
}) {
  const rating = ratingFromRace(race);
  const isUltra = rating === 5;
  const startMs = race.startTime ? Date.parse(race.startTime) : NaN;
  const minutes = Number.isFinite(startMs) ? Math.round((startMs - now) / 60000) : NaN;
  const isFinalMode = Number.isFinite(minutes) && minutes <= 10 && minutes >= -5;
  const isImminent = Number.isFinite(minutes) && minutes <= 5 && minutes >= -1;

  const tone = isUltra ? "gold" : isFinalMode ? "final" : "tentative";
  const stake = recommendStake(rating, budget);
  const hev = cooledEv(race);
  const expectedReturn = stake && hev ? Math.round(stake * hev) : null;

  const diff = compareWithSnapshot(race, rating);
  const showDiff = isFinalMode && diff.changed;

  const venueLabel = race.venue || race.course || "";
  const raceNum = race.raceName?.match(/(\d{1,2})R/)?.[1] || "";

  return (
    <Card tone={tone} elevated className={cn(isUltra && "anim-gold-pulse sheen")}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {isFinalMode ? (
                <Badge tone="final">
                  最終確定 · {minutes <= 0 ? (minutes >= -1 ? "発走" : "発走済") : `${minutes}分前`}
                </Badge>
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
        {/* Diff banner: 暫定→最終確定で何が変わったか */}
        {showDiff && <DiffBanner diff={diff} />}

        <div className="flex items-center justify-between">
          <StarRating rating={rating} size="lg" />
          <span className="text-xs text-ink-muted font-medium">{ratingLabel(rating)}</span>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Stat label="正直EV" value={hev ? hev.toFixed(2) : "—"} tone={isUltra ? "gold" : "default"} size="md" />
          <Stat label="信頼度" value={race.confidence ? Math.round(race.confidence * 100) : "—"} unit="%" size="md" />
          <Stat label="複勝の目安" value={formatYen(stake)} size="md" />
        </div>

        <div className="bg-paper-soft/70 rounded-[12px] p-3.5 border border-line">
          <div className="text-[10px] uppercase tracking-[0.14em] text-gold-deep font-medium">本命</div>
          <div className="mt-1.5 flex items-center gap-2.5">
            <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-gradient-to-b from-gold-bright to-gold text-on-gold font-display font-semibold tabular shadow-[0_4px_14px_rgba(232,194,108,0.35)]">
              {race.topPick?.number ?? "—"}
            </span>
            <span className="font-medium text-base truncate">{race.topPick?.name ?? "—"}</span>
            <span className="ml-auto text-sm tabular text-ink-soft">
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
          onClick={() => onBuyClick(race, rating, stake, isFinalMode)}
        >
          これ買う {stake > 0 && `· ${formatYen(stake)}`}
        </Button>
        <Button variant="secondary" size="md" onClick={() => onDetailClick(race)}>
          詳細
        </Button>
      </CardFooter>
    </Card>
  );
}

function DiffBanner({ diff }: { diff: Diff }) {
  const isDemotion = diff.oldRating !== null && diff.oldRating > diff.newRating;
  return (
    <div className={cn(
      "rounded-[10px] px-3 py-2.5 text-xs leading-relaxed border",
      isDemotion
        ? "bg-wine-soft border-wine/20 text-wine"
        : "bg-deep-green-soft border-deep-green/20 text-deep-green",
    )}>
      <div className="font-medium mb-0.5">
        {isDemotion ? "⚠ 暫定からの変更点" : "✓ 暫定から強化"}
      </div>
      {diff.message}
    </div>
  );
}

function SkipRow({ race, onClick }: { race: RaceSummary; onClick?: () => void }) {
  const rating = ratingFromRace(race);
  const content = (
    <>
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
        正直EV {cooledEv(race) ? cooledEv(race).toFixed(2) : "—"}
      </span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="w-full flex items-center justify-between gap-3 py-2.5 text-sm text-left -mx-1 px-1 rounded-[8px] hover:bg-paper-hover/50 transition-colors"
      >
        {content}
      </button>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-sm">{content}</div>
  );
}

function PendingDataCard({
  raceCount,
  fetchedAt,
  onRefresh,
}: {
  raceCount: number;
  fetchedAt?: string;
  onRefresh?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const minutesAgo = fetchedAt
    ? Math.max(0, Math.round((now - Date.parse(fetchedAt)) / 60000))
    : null;

  return (
    <Card tone="gold" className="sheen">
      <CardBody className="py-10 text-center">
        <Horseshoe className="w-12 h-12 text-gold mx-auto mb-4 anim-gold-pulse rounded-full" />
        <h3 className="font-display text-2xl font-semibold tracking-tight">
          出走馬・オッズの配信待ち
        </h3>
        <p className="mt-3 text-sm text-ink-soft max-w-md mx-auto leading-relaxed">
          今日は <span className="font-semibold tabular text-gold-deep">{raceCount} レース</span> 開催が確認できています。
          JRA-VAN から出走馬・騎手・オッズが配信され次第、星評価と買い目をお出しします。
        </p>
        <p className="mt-4 text-xs text-ink-muted">
          通常 9:00〜10:00 頃に配信開始 · 10 分おきに自動取得中
        </p>
        {minutesAgo !== null && (
          <p className="mt-2 text-[11px] text-ink-faint tabular">
            最終チェック: {minutesAgo === 0 ? "たった今" : `${minutesAgo} 分前`}
          </p>
        )}
        {onRefresh && (
          <div className="mt-5">
            <Button variant="gold" size="md" onClick={onRefresh}>
              <RefreshCw className="w-4 h-4" />
              今すぐ更新
            </Button>
          </div>
        )}
        <p className="mt-3 text-[11px] text-ink-faint">
          画面を開いたまましばらくお待ちください。完了すると自動で表示が切り替わります。
        </p>
      </CardBody>
    </Card>
  );
}

/** 次の開催日 (土 or 日) の朝 9:30 を返す */
function nextRaceDay(from: Date): Date {
  const d = new Date(from);
  // 当日が土日でも「次」を探すため翌日から走査
  d.setHours(9, 30, 0, 0);
  if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1);
  for (let i = 0; i < 8; i++) {
    const day = d.getDay();
    if (day === 0 || day === 6) return d;
    d.setDate(d.getDate() + 1);
  }
  return d;
}

function NoRaceCard({ reason }: { reason: string }) {
  // 「JRA-VAN (有料) の接続設定後...」は契約済みユーザーには失礼なので、
  // バックエンドが今日のデータを取り込み中の場合と未契約を区別して表示
  const isDataPending = /取得していません|接続設定後/.test(reason);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const today = new Date(now);
  const isRaceDay = today.getDay() === 0 || today.getDay() === 6;

  // 取り込み中 (土日の朝など) は別の落ち着いた表示
  if (isDataPending && isRaceDay) {
    return (
      <Card tone="gold" className="sheen">
        <CardBody className="py-12 text-center">
          <span className="inline-block anim-floaty mb-4">
            <HorseHero className="w-40 h-auto mx-auto" />
          </span>
          <h3 className="font-display text-2xl font-semibold tracking-tight">
            今日のレースを取り込み中
          </h3>
          <p className="mt-3 text-sm text-ink-soft max-w-md mx-auto leading-relaxed">
            JRA-VAN からの自動取得が完了するまでもう少しお待ちください。土日は 8:30 / 11:00 / 13:30 / 16:00 に取得が走ります。
          </p>
          <p className="mt-4 text-xs text-ink-faint">
            数分待って再読み込みすると最新データが反映されます
          </p>
        </CardBody>
      </Card>
    );
  }

  // 平日など休む日 — 夜のターフ・カウントダウン
  const next = nextRaceDay(today);
  const diffMs = Math.max(0, next.getTime() - now);
  const totalH = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(totalH / 24);
  const hours = totalH % 24;
  const nextLabel = `${next.getMonth() + 1}月${next.getDate()}日 (${["日","月","火","水","木","金","土"][next.getDay()]})`;

  return (
    <Card tone="gold" elevated className="sheen relative overflow-hidden">
      <CardBody className="py-12 text-center relative">
        <div className="text-[10px] uppercase tracking-[0.22em] text-deep-green font-medium">
          NEXT RACE DAY
        </div>

        <span className="inline-block anim-floaty my-4">
          <HorseHero className="w-48 h-auto mx-auto drop-shadow-[0_10px_18px_rgba(21,39,27,0.16)]" />
        </span>

        <h3 className="font-display text-3xl font-semibold tracking-tight">
          今日は<span className="text-green-grad">休む日</span>
        </h3>
        <p className="mt-3 text-sm text-ink-soft max-w-md mx-auto leading-relaxed">
          中央競馬は土日が開催。買わない日も、勝つための大切な一日です。
          AI は次の開催に向けて静かに準備しています。
        </p>

        {/* 次の開催までのカウントダウン */}
        <div className="mt-7 inline-flex items-stretch gap-3">
          <CountUnit value={days} unit="日" />
          <span className="self-center text-2xl text-gold/40 font-display">:</span>
          <CountUnit value={hours} unit="時間" />
        </div>
        <p className="mt-4 text-xs text-ink-muted">
          次の開催 · <span className="text-ink-soft font-medium tabular">{nextLabel}</span>
        </p>
      </CardBody>
    </Card>
  );
}

function CountUnit({ value, unit }: { value: number; unit: string }) {
  return (
    <div className="flex flex-col items-center">
      <div className="min-w-[72px] rounded-[14px] border border-gold/30 bg-paper-soft/70 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
        <span className="font-display tabular text-4xl font-semibold text-gold-grad num-glow leading-none">
          {String(value).padStart(2, "0")}
        </span>
      </div>
      <span className="mt-1.5 text-[11px] tracking-wider text-ink-muted">{unit}</span>
    </div>
  );
}

function NoBettableCard({ skipCount, sample }: { skipCount: number; sample: RaceSummary[] }) {
  return (
    <Card>
      <CardBody>
        <div className="text-center py-6">
          <Horseshoe className="w-10 h-10 text-gold-deep/70 mx-auto mb-3" />
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

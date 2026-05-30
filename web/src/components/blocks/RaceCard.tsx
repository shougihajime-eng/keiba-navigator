"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, CheckCircle2, Trophy } from "lucide-react";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { fetchRaceCard } from "@/lib/api";
import { getBudget, fukushoStake } from "@/lib/bankroll";
import { cn, formatYen } from "@/lib/utils";

type Tier = "prime" | "bet" | "watch" | "skip";

type CardHorse = {
  number: number;
  name: string | null;
  win_prob: number | null;
  nopop_prob: number | null;
  odds: number | null;
  popularity: number | null;
  ev: number | null;
  cooled_ev: number | null;
  finish: number | null;
  won: number;
};
type RaceFact = { number: number; name: string | null; kind: string; detail: string };
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
  tier?: Tier;
  tier_label?: string;
  reason?: string | null;
  bet_style?: string | null;
  best_honest_ev?: number | null;
  facts?: RaceFact[];
  horses: CardHorse[];
};
type TierCounts = { prime: number; bet: number; watch: number; skip: number };
type CardResp = {
  ok?: boolean;
  date?: string;
  race_count?: number;
  settled_count?: number;
  top1_win?: number;
  top1_in3?: number;
  tier_counts?: TierCounts;
  races?: CardRace[];
};

// 4段階の見た目 (必殺一号艇方式: 買う/見送りを色で一目で)
const TIER_META: Record<Tier, {
  label: string; tone: "gold" | "won" | "tentative" | "silver"; dot: string; ring: string;
}> = {
  prime: { label: "絶好機", tone: "gold",      dot: "bg-gold",       ring: "border-gold/40 bg-gold-soft/30" },
  bet:   { label: "勝負",   tone: "won",       dot: "bg-deep-green", ring: "border-deep-green/30 bg-deep-green-soft/25" },
  watch: { label: "様子見", tone: "tentative", dot: "bg-ink-blue",   ring: "border-line/60" },
  skip:  { label: "見送り", tone: "silver",    dot: "bg-silver",     ring: "border-line/50" },
};

// 事実メモ (参考) の色: お金が入った=緑 / 馬体重=金 / 装備=青 / 取消・お金が抜けた=銀
const FACT_TONE: Record<string, "gold" | "won" | "silver" | "tentative"> = {
  money_in: "won", money_out: "silver", scratch: "silver",
  weight_up: "gold", weight_down: "gold", blinker: "tentative",
};

/** 「人が見落としがちな硬い事実」を参考メモとして出す (未検証・予想には混ぜない) */
function FactRow({ facts }: { facts?: RaceFact[] }) {
  if (!facts || facts.length === 0) return null;
  return (
    <div className="mt-2.5">
      <div className="text-[10px] uppercase tracking-[0.12em] text-ink-faint font-medium mb-1">
        事実メモ（参考）
      </div>
      <div className="flex flex-wrap gap-1.5">
        {facts.map((f, i) => (
          <Badge key={i} tone={FACT_TONE[f.kind] ?? "silver"} size="xs">
            #{f.number} {f.detail}
          </Badge>
        ))}
      </div>
      <p className="mt-1.5 text-[10px] text-ink-faint leading-snug">
        レース直前の変化です。<span className="text-ink-muted">まだ「当たりやすさに効くか」は検証していない</span>ので、予想には混ぜていません（これから数ヶ月ぶん貯めて確かめます）。
      </p>
    </div>
  );
}

const pct = (v?: number | null) => (typeof v === "number" ? `${Math.round(v * 100)}%` : "—");
const fmtDate = (d?: string) =>
  d && d.length === 8 ? `${Number(d.slice(4, 6))}月${Number(d.slice(6, 8))}日` : "";
const raceNum = (name?: string | null) => name?.match(/(\d{1,2})\s*R/)?.[1] || "";

export function RaceCard() {
  const [resp, setResp] = useState<CardResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [showAllRest, setShowAllRest] = useState(false);
  const [budget, setBudgetState] = useState(10000);

  useEffect(() => {
    let alive = true;
    fetchRaceCard().then((d) => {
      if (!alive) return;
      setResp((d as unknown as CardResp) || null);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  // 資金管理カードの予算に追従 (複勝おすすめ金額に使う)
  useEffect(() => {
    const read = () => setBudgetState(getBudget());
    read();
    window.addEventListener("keiba:budget-changed", read);
    return () => window.removeEventListener("keiba:budget-changed", read);
  }, []);

  const races = resp?.races ?? [];
  const settled = resp?.settled_count ?? 0;
  const tc = useMemo<TierCounts>(() => {
    if (resp?.tier_counts) return resp.tier_counts;
    const z: TierCounts = { prime: 0, bet: 0, watch: 0, skip: 0 };
    for (const r of races) z[(r.tier ?? "skip") as Tier]++;
    return z;
  }, [resp, races]);
  const buyCount = tc.prime + tc.bet;

  const buyRaces = useMemo(
    () => races.filter((r) => r.tier === "prime" || r.tier === "bet"),
    [races],
  );
  const restRaces = useMemo(
    () => races.filter((r) => r.tier !== "prime" && r.tier !== "bet"),
    [races],
  );
  const restShown = showAllRest ? restRaces : restRaces.slice(0, 8);

  return (
    <section aria-label="全レース予想">
      <div className="flex items-end justify-between mb-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em] text-gold-deep font-medium">
            FULL CARD · 全レース予想
          </div>
          <h2 className="mt-1 font-display text-2xl md:text-3xl font-semibold tracking-tight">
            全レースを4段階で判定
          </h2>
        </div>
        {resp?.date && (
          <Badge tone="gold" size="md">直近 {fmtDate(resp.date)} · {races.length}R</Badge>
        )}
      </div>

      {loading ? (
        <Card><CardBody><div className="text-sm text-ink-muted py-6 text-center">全レースのAI判定を読み込み中...</div></CardBody></Card>
      ) : races.length === 0 ? (
        <Card><CardBody><div className="text-sm text-ink-muted py-6 text-center">
          開催日のデータが入ると、その日の全レースを4段階で判定してここに並べます。
        </div></CardBody></Card>
      ) : (
        <div className="space-y-4">
          {/* 4段階の件数サマリ (一目で「買う/見送り」の内訳) */}
          <div className="grid grid-cols-4 gap-2">
            <TierStat tier="prime" n={tc.prime} />
            <TierStat tier="bet" n={tc.bet} />
            <TierStat tier="watch" n={tc.watch} />
            <TierStat tier="skip" n={tc.skip} />
          </div>

          {/* この判定の読み方 (正直な説明) */}
          <Card>
            <CardBody className="py-3.5">
              <p className="text-xs text-ink-soft leading-relaxed">
                <span className="text-deep-green font-medium">勝負・絶好機</span>は「AI本命が抜けて堅く、3着内に来やすい」とAIが選んだレース（買うなら<span className="text-ink-soft font-medium">複勝</span>が損を抑えやすい）。
                <span className="text-ink-muted">様子見・見送り</span>は狙いを絞れない・配当の妙味がないレースです。
              </p>
              <p className="mt-1.5 text-[11px] text-ink-muted leading-relaxed">
                ※競馬は市場(オッズ)がとても賢く「必ず儲かる買い方」はありません。これは利益の保証ではなく、<span className="text-ink-soft">ムダな赤字を減らすための選別</span>です。
                {buyCount > 0
                  ? `本日は${buyCount}レースだけが「買うなら候補」です。`
                  : "本日は買うなら候補は0件。見送りが正直な判定です。"}
              </p>
              {settled > 0 && (
                <div className="mt-3 pt-3 border-t border-line/60 flex items-center gap-5">
                  <div className="text-[10px] uppercase tracking-[0.14em] text-ink-muted font-medium">この日のAI本命</div>
                  <div><span className="font-display text-xl font-semibold tabular text-ink">{resp?.top1_in3}/{settled}</span><span className="ml-1.5 text-xs text-ink-muted">3着内</span></div>
                  <div><span className="font-display text-xl font-semibold tabular text-ink">{resp?.top1_win}/{settled}</span><span className="ml-1.5 text-xs text-ink-muted">1着</span></div>
                </div>
              )}
            </CardBody>
          </Card>

          {/* 買うなら候補 (絶好機・勝負) を目立つカードで */}
          {buyRaces.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-[0.16em] text-deep-green font-medium mb-2">
                買うなら候補 · {buyRaces.length} 件
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 stagger">
                {buyRaces.map((r) => (
                  <BuyCard
                    key={r.race_id}
                    race={r}
                    budget={budget}
                    open={open === r.race_id}
                    onToggle={() => setOpen(open === r.race_id ? null : r.race_id)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* 様子見・見送り はコンパクトな一覧で */}
          {restRaces.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-[0.16em] text-ink-muted mb-2">
                様子見・見送り · {restRaces.length} 件
              </div>
              <Card>
                <CardBody className="divide-y divide-line/50 py-1">
                  {restShown.map((r) => (
                    <CompactRow
                      key={r.race_id}
                      race={r}
                      open={open === r.race_id}
                      onToggle={() => setOpen(open === r.race_id ? null : r.race_id)}
                    />
                  ))}
                  {restRaces.length > 8 && (
                    <button
                      onClick={() => setShowAllRest((v) => !v)}
                      className="w-full pt-3 pb-1 text-xs text-ink-muted hover:text-ink-soft transition-colors"
                    >
                      {showAllRest ? "閉じる" : `残り ${restRaces.length - 8} レースも見る`}
                    </button>
                  )}
                </CardBody>
              </Card>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function TierStat({ tier, n }: { tier: Tier; n: number }) {
  const m = TIER_META[tier];
  const dim = n === 0;
  const glow = tier === "prime" && n > 0;
  return (
    <div className={cn(
      "rounded-[10px] border px-2 py-2.5 text-center transition-opacity",
      m.ring, dim && "opacity-45", glow && "anim-gold-pulse",
    )}>
      <div className="flex items-center justify-center gap-1.5">
        <span className={cn("inline-block w-2 h-2 rounded-full", m.dot)} />
        <span className="text-[11px] text-ink-soft font-medium">{m.label}</span>
      </div>
      <div className="mt-1 font-display text-xl font-semibold tabular text-ink">{n}</div>
    </div>
  );
}

/** 結果バッジ (確定後) */
function ResultBadge({ race }: { race: CardRace }) {
  if (!race.has_result) return null;
  const won = race.top_won === 1;
  const hit = race.top_in3 === 1;
  if (won) return <Badge tone="won" size="sm"><Trophy className="w-3 h-3" />的中 {race.top_finish}着</Badge>;
  if (hit) return <Badge tone="won" size="sm"><CheckCircle2 className="w-3 h-3" />3着内 {race.top_finish}着</Badge>;
  return <Badge tone="silver" size="sm">{race.top_finish ? `${race.top_finish}着` : "—"}</Badge>;
}

/** 絶好機・勝負 の目立つカード */
function BuyCard({ race, budget, open, onToggle }: { race: CardRace; budget: number; open: boolean; onToggle: () => void }) {
  const tier = (race.tier ?? "bet") as Tier;
  const isPrime = tier === "prime";
  const m = TIER_META[tier];
  const stake = fukushoStake(tier, budget);
  const rn = raceNum(race.race_name);

  return (
    <div className={cn(
      "rounded-[16px] border p-4 relative overflow-hidden transition-shadow",
      isPrime
        ? "border-gold/50 bg-gradient-to-b from-gold-soft/40 to-canvas anim-gold-pulse sheen"
        : "border-deep-green/30 bg-gradient-to-b from-deep-green-soft/30 to-canvas",
    )}>
      {/* ヘッダ行 */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Badge tone={m.tone} size="sm">
            <span className={cn("inline-block w-1.5 h-1.5 rounded-full", m.dot)} />
            {m.label}
          </Badge>
          {race.is_g1 && <Badge tone="gold" size="xs">G1</Badge>}
          <span className="text-xs text-ink-muted tabular truncate">
            {race.course || "—"}{rn && ` ${rn}R`}{race.going ? ` · ${race.going}` : ""}
          </span>
        </div>
        <ResultBadge race={race} />
      </div>

      {/* 本命 */}
      <div className="mt-3 flex items-center gap-3">
        <span className={cn(
          "inline-flex items-center justify-center w-10 h-10 rounded-full font-display font-semibold tabular text-lg shrink-0",
          isPrime
            ? "bg-gradient-to-b from-gold-bright to-gold text-on-gold shadow-[0_4px_14px_rgba(232,194,108,0.4)]"
            : "bg-gradient-to-b from-deep-green to-deep-green text-white",
        )}>
          {race.top_number ?? "—"}
        </span>
        <div className="min-w-0">
          <div className={cn("font-medium truncate", isPrime && "shimmer-text", "text-[15px]")}>
            {race.top_name || "—"}
          </div>
          <div className="text-xs text-ink-muted tabular">
            AI勝率 {pct(race.top_prob)}{race.top_odds ? ` · ${race.top_odds.toFixed(1)}倍` : ""}
          </div>
        </div>
      </div>

      {/* 一言理由 */}
      {race.reason && (
        <p className="mt-2.5 text-xs text-deep-green leading-snug">▸ {race.reason}</p>
      )}

      {/* 事実メモ (参考・未検証) */}
      <FactRow facts={race.facts} />

      {/* 複勝おすすめ金額 (大きく) */}
      {stake > 0 && (
        <div className="mt-3 rounded-[12px] border border-deep-green/25 bg-deep-green-soft/40 px-3.5 py-2.5">
          <div className="text-[10px] uppercase tracking-[0.12em] text-deep-green/80 font-medium">おすすめの買い方</div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="text-sm text-ink-soft">複勝 #{race.top_number} に</span>
            <span className="font-display text-2xl font-semibold tabular text-deep-green num-glow-green">{formatYen(stake)}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-ink-muted leading-snug">
            予算連動の小額（{isPrime ? "予算の3%" : "予算の約2%"}）。儲けではなく損を抑えるのが目的。
          </div>
        </div>
      )}

      {/* 詳細トグル */}
      <button onClick={onToggle} className="mt-3 flex items-center gap-1 text-xs text-ink-muted hover:text-ink-soft transition-colors">
        <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", open && "rotate-180")} />
        全頭のAI予想を{open ? "閉じる" : "見る"}
      </button>
      {open && <HorseDetail race={race} />}
    </div>
  );
}

/** 様子見・見送り のコンパクト行 */
function CompactRow({ race, open, onToggle }: { race: CardRace; open: boolean; onToggle: () => void }) {
  const tier = (race.tier ?? "skip") as Tier;
  const m = TIER_META[tier];
  return (
    <div className="py-2.5">
      <button onClick={onToggle} className="w-full flex items-center gap-3 text-left">
        <ChevronDown className={cn("w-4 h-4 text-ink-faint shrink-0 transition-transform", open && "rotate-180")} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-ink-muted">
            <Badge tone={m.tone} size="xs">
              <span className={cn("inline-block w-1.5 h-1.5 rounded-full", m.dot)} />{m.label}
            </Badge>
            <span className="tabular truncate">{race.course || "—"}</span>
            {race.is_g1 && <Badge tone="gold" size="xs">G1</Badge>}
          </div>
          <div className="mt-0.5 text-sm truncate">
            <span className="text-ink-muted">本命</span>{" "}
            <span className="text-ink-soft">#{race.top_number} {race.top_name}</span>{" "}
            <span className="text-ink-muted tabular text-xs">{pct(race.top_prob)}{race.top_odds ? ` · ${race.top_odds.toFixed(1)}倍` : ""}</span>
          </div>
          {race.reason && <div className="mt-0.5 text-[11px] text-ink-muted truncate">{race.reason}</div>}
        </div>
        {race.has_result ? <ResultBadge race={race} /> : <Badge tone={m.tone} size="sm">{m.label}</Badge>}
      </button>
      {open && <div className="ml-7"><FactRow facts={race.facts} /><HorseDetail race={race} /></div>}
    </div>
  );
}

/** 全頭テーブル + 正直EVの説明 (展開時に共用) */
function HorseDetail({ race }: { race: CardRace }) {
  return (
    <>
      <div className="mt-3 rounded-[12px] border border-line/60 bg-paper-soft/40 overflow-x-auto">
        <table className="w-full text-sm min-w-[460px]">
          <thead>
            <tr className="text-ink-muted border-b border-line/50">
              <th className="text-left font-medium px-3 py-2">AI順</th>
              <th className="text-left font-medium px-2 py-2">馬</th>
              <th className="text-right font-medium px-2 py-2">AI勝率</th>
              <th className="text-right font-medium px-2 py-2">人気</th>
              <th className="text-right font-medium px-2 py-2">オッズ</th>
              <th className="text-right font-medium px-2 py-2">期待値</th>
              <th className="text-right font-medium px-2 py-2">正直EV</th>
              {race.has_result && <th className="text-right font-medium px-3 py-2">着</th>}
            </tr>
          </thead>
          <tbody>
            {race.horses.slice(0, 18).map((h, i) => (
              <tr key={h.number} className={cn("border-b border-line/30 last:border-0", h.won && "bg-deep-green-soft/40")}>
                <td className="px-3 py-1.5 tabular text-ink-muted">{h.win_prob != null ? i + 1 : "—"}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  <span className="tabular text-ink-muted">{h.number}</span>{" "}
                  <span className="text-ink-soft">{h.name}</span>
                </td>
                <td className="px-2 py-1.5 text-right tabular text-ink">{pct(h.win_prob)}</td>
                <td className="px-2 py-1.5 text-right tabular text-ink-muted">{h.popularity || "—"}</td>
                <td className="px-2 py-1.5 text-right tabular text-ink-muted">{h.odds != null ? `${h.odds.toFixed(1)}` : "—"}</td>
                <td className="px-2 py-1.5 text-right tabular text-ink-faint">{h.ev != null ? h.ev.toFixed(2) : "—"}</td>
                <td className={cn(
                  "px-2 py-1.5 text-right tabular",
                  h.cooled_ev == null ? "text-ink-faint" : h.cooled_ev >= 1 ? "text-deep-green font-medium" : "text-ink-muted",
                )}>
                  {h.cooled_ev != null ? h.cooled_ev.toFixed(2) : "—"}
                </td>
                {race.has_result && (
                  <td className="px-3 py-1.5 text-right tabular font-medium">{h.finish ? h.finish : "—"}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-muted leading-relaxed">
        <span className="text-ink-soft">「期待値」</span>はAI勝率×オッズの理論値。<span className="text-ink-soft">「正直EV」</span>は、その数字を
        <span className="text-ink-soft">過去に実際そういう馬を買って戻ってきた割合（約0.7〜0.8倍・穴馬ほど低い）</span>に冷ました現実的な見込みです。
        正直EVが1.00を超えればお買い得ですが、競馬では市場が賢く<span className="text-ink-soft">ほぼ1.00未満＝お買い得は基本ありません</span>。
      </p>
    </>
  );
}

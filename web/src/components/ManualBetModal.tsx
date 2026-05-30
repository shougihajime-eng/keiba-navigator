"use client";

import { useEffect, useState } from "react";
import { X, Check, PencilLine } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { formatYen, cn } from "@/lib/utils";
import { addBet } from "@/lib/store";
import { getBudget } from "@/lib/bankroll";
import { generateReflection } from "@/lib/reflection";
import { saveReflection } from "@/lib/reflectionStore";
import { MissTagPicker } from "@/components/MissTagPicker";
import type { MissTag } from "@/lib/reflection";

// WIN5 も含めた券種 (本人の運用に合わせる)
const BET_TYPES = ["複勝", "単勝", "馬連", "ワイド", "3連複", "3連単", "WIN5"];
const RESULTS = [
  { key: "pending", label: "まだ" },
  { key: "hit", label: "当たり" },
  { key: "miss", label: "外れ" },
] as const;

type ResultKey = (typeof RESULTS)[number]["key"];

interface Props {
  /** 最初から券種を指定したい時 (WIN5記録ボタンなど) */
  initialType?: string;
  initialRaceName?: string;
  onClose: () => void;
}

function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 手入力で どんな馬券でも記録する画面 (開催なしの日・WIN5・過去分もOK) */
export function ManualBetModal({ initialType = "複勝", initialRaceName = "", onClose }: Props) {
  const [date, setDate] = useState(todayLocal());
  const [raceName, setRaceName] = useState(initialRaceName);
  const [type, setType] = useState(initialType);
  const [horses, setHorses] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [result, setResult] = useState<ResultKey>("pending");
  const [payoutStr, setPayoutStr] = useState("");
  const [missTags, setMissTags] = useState<MissTag[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 全角数字も受ける
  const toNum = (s: string) =>
    Math.max(0, Math.round(Number(
      s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[^\d]/g, ""),
    ) || 0));
  const amount = toNum(amountStr);
  const payout = toNum(payoutStr);

  const isWin5 = type === "WIN5";
  // WIN5 は買い目入力を任意にする (5レースぶんで長いため)
  const valid =
    amount >= 100 &&
    (isWin5 || horses.trim().length > 0) &&
    (result !== "hit" || payout > 0);

  const profit = (result === "hit" ? payout : result === "miss" ? 0 : payout) - amount;
  const budget = getBudget();

  const handleSave = () => {
    if (!valid) return;
    // 選んだ日付の正午を記録時刻に (収支の月・日の集計に正しく入る)
    const createdAt = new Date(`${date}T12:00:00`).toISOString();
    const id = `manual_${Date.now()}_${Math.floor(performance.now())}`;
    const resolved = result === "pending" ? "pending" : result;

    addBet({
      id,
      raceName: raceName.trim() || (isWin5 ? "WIN5" : "手入力"),
      type,
      horses: horses.trim() || (isWin5 ? "—" : ""),
      amount,
      payout: result === "hit" ? payout : result === "miss" ? 0 : undefined,
      result: resolved,
      createdAt,
      factors: { source: "manual_entry", isManual: true },
    });

    // 外れなら反省文を保存 (タグを選んでいればそれを使う)
    if (result === "miss") {
      const refl = generateReflection({
        id, raceName: raceName.trim() || undefined, type,
        horses: horses.trim(), amount, result: "miss", payout: 0, createdAt,
      });
      if (missTags.length > 0) {
        refl.tags = missTags;
        refl.freeText = `手入力で記録した外れ。\n推定原因:\n${missTags
          .map((t) => `• ${tagJp(t)}`).join("\n")}`;
      }
      saveReflection(refl);
    }

    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("keiba:bet-added"));
    }
    setSaved(true);
    setTimeout(onClose, 850);
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
        aria-label="手で記録する"
      >
        {saved ? (
          <div className="py-10 px-6 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-deep-green-soft text-deep-green mb-4">
              <Check className="w-8 h-8" strokeWidth={2.5} />
            </div>
            <h3 className="font-display text-xl font-semibold">記録しました</h3>
            <p className="mt-2 text-sm text-ink-muted">収支と成績に反映しました</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <div className="flex items-center gap-2">
                <PencilLine className="w-4 h-4 text-gold-deep" />
                <span className="font-display font-semibold tracking-tight">手で記録する</span>
              </div>
              <button onClick={onClose} className="p-1.5 rounded-full hover:bg-paper-hover text-ink-muted transition-colors" aria-label="閉じる">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-5 py-5 space-y-5">
              <p className="text-xs text-ink-muted leading-relaxed -mt-1">
                開催なしの日・WIN5・過去に買った分も、ここから自分で記録できます。収支と成績に足されます。
              </p>

              {/* 日付 */}
              <Field label="買った日">
                <input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="w-full h-11 px-3 rounded-[10px] border border-line bg-paper text-base tabular focus:border-gold outline-none transition-colors"
                />
              </Field>

              {/* レース名 */}
              <Field label="レース名（任意）">
                <input
                  type="text"
                  value={raceName}
                  onChange={(e) => setRaceName(e.target.value)}
                  placeholder={isWin5 ? "例: 5/31 WIN5" : "例: 東京11R 日本ダービー"}
                  className="w-full h-11 px-3 rounded-[10px] border border-line bg-paper text-base focus:border-gold outline-none transition-colors"
                />
              </Field>

              {/* 券種 */}
              <Field label="券種">
                <div className="grid grid-cols-4 gap-2">
                  {BET_TYPES.map((t) => (
                    <button
                      key={t}
                      onClick={() => setType(t)}
                      className={cn(
                        "py-2 text-sm font-medium rounded-[10px] border transition-all",
                        type === t ? "border-ink bg-ink text-paper" : "border-line bg-paper hover:bg-paper-hover text-ink-soft",
                      )}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </Field>

              {/* 買い目 */}
              <Field label={isWin5 ? "買い目（任意・例 3-7-1-12-5）" : "買い目（馬番）"}>
                <input
                  type="text"
                  value={horses}
                  onChange={(e) => setHorses(e.target.value)}
                  placeholder={isWin5 ? "例: 3-7-1-12-5" : "例: 5  または  5-7"}
                  className="w-full h-11 px-3 rounded-[10px] border border-line bg-paper text-base tabular focus:border-gold outline-none transition-colors"
                />
              </Field>

              {/* 金額 */}
              <Field label="買った金額">
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted text-sm">¥</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={amountStr}
                    onChange={(e) => setAmountStr(e.target.value)}
                    placeholder="例 5000"
                    className="w-full h-11 pl-7 pr-3 rounded-[10px] border border-line bg-paper text-base tabular focus:border-gold outline-none transition-colors"
                  />
                </div>
              </Field>

              {/* 結果 */}
              <Field label="結果">
                <div className="grid grid-cols-3 gap-2">
                  {RESULTS.map((r) => (
                    <button
                      key={r.key}
                      onClick={() => setResult(r.key)}
                      className={cn(
                        "py-2.5 text-sm font-medium rounded-[10px] border transition-all",
                        result === r.key
                          ? r.key === "hit" ? "border-deep-green bg-deep-green text-white"
                            : r.key === "miss" ? "border-wine bg-wine text-white"
                            : "border-ink bg-ink text-paper"
                          : "border-line bg-paper hover:bg-paper-hover text-ink-soft",
                      )}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </Field>

              {/* 当たりなら払戻金 */}
              {result === "hit" && (
                <Field label="受け取った払戻金">
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted text-sm">¥</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={payoutStr}
                      onChange={(e) => setPayoutStr(e.target.value)}
                      placeholder="例 8000"
                      className="w-full h-11 pl-7 pr-3 rounded-[10px] border border-line bg-paper text-base tabular focus:border-deep-green outline-none transition-colors"
                    />
                  </div>
                </Field>
              )}

              {/* 外れなら理由タグ (任意) */}
              {result === "miss" && (
                <Field label="外した理由（任意・選ぶほど反省が賢くなります）">
                  <MissTagPicker selected={missTags} onChange={setMissTags} />
                </Field>
              )}

              {/* その場の収支プレビュー */}
              {amount >= 100 && result !== "pending" && (
                <div className="flex items-center gap-3 text-sm tabular pt-1">
                  <span className="text-ink-muted">投資 {formatYen(amount)}</span>
                  <span className={cn("font-medium", profit >= 0 ? "text-deep-green" : "text-wine")}>
                    収支 {profit >= 0 ? "+" : ""}{formatYen(profit)}
                  </span>
                </div>
              )}

              {/* 予算の注意 (今月の予算を超える買いなら) */}
              {amount > budget && (
                <div className="text-xs text-wine">
                  ※ この金額は今月の予算 {formatYen(budget)} を超えています。
                </div>
              )}
            </div>

            <div className="px-5 py-4 border-t border-line flex gap-2">
              <Button variant="secondary" size="md" onClick={onClose}>キャンセル</Button>
              <Button variant="gold" size="md" className="flex-1" onClick={handleSave} disabled={!valid}>
                {amount >= 100 ? `${formatYen(amount)} で記録` : "記録する"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-[0.1em] text-ink-muted font-medium">{label}</label>
      <div className="mt-2">{children}</div>
    </div>
  );
}

// reflection.ts の TAG_LABELS と同じ表記 (循環 import を避けてここに最小限)
function tagJp(t: MissTag): string {
  const m: Record<string, string> = {
    track_condition: "馬場適性を軽視", distance_misjudge: "距離適性を見誤った",
    weight_overestimate: "斤量・負担を過大評価", pace_misread: "ペース想定が外れた",
    jockey_overweight: "騎手の重み付け過大", horse_form_drop: "馬の調子下降を見落とし",
    prevrun_overweight: "前走の着差を過大評価", popularity_under: "人気馬の地力を過小評価",
    popularity_over: "人気馬を過大評価", field_quality: "メンバー構成の見落とし",
    post_position: "枠順の影響を軽視", weather_change: "天候・馬場変化に対応できず",
    pedigree_misread: "血統適性の判断が甘かった", confidence_too_high: "信頼度を過大に見積もった",
    unknown: "原因特定が難しい外れ",
  };
  return m[t] || t;
}

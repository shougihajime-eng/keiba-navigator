"use client";

import { useEffect, useRef, useState } from "react";
import { Check, X as XIcon, Trash2 } from "lucide-react";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { loadBets, updateBet, deleteBet, type Bet } from "@/lib/store";
import { formatYen, cn } from "@/lib/utils";
import { generateReflection } from "@/lib/reflection";
import { saveReflection } from "@/lib/reflectionStore";

export function PendingBetsList() {
  const [bets, setBets] = useState<Bet[]>([]);
  // 的中の払戻金を画面内で入力中のベットid
  const [recordingId, setRecordingId] = useState<string | null>(null);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("keiba:bet-added", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("keiba:bet-added", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  function refresh() {
    const all = loadBets();
    const pending = all.filter((b) => b.result === "pending" || !b.result);
    // createdAt が欠けた古い記録でも落ちないように防御
    setBets(pending.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")));
  }

  function emitChange() {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("keiba:bet-added"));
    }
  }

  // 的中: 払戻金を確定して保存
  const confirmHit = (bet: Bet, payout: number) => {
    updateBet(bet.id, { result: "hit", payout: Math.round(payout), isDraft: false });
    emitChange();
    setRecordingId(null);
    refresh();
  };

  const onMiss = (bet: Bet) => {
    updateBet(bet.id, { result: "miss", payout: 0, isDraft: false });
    // 自動で反省文を生成して保存
    const refl = generateReflection({ ...bet, result: "miss", payout: 0 });
    saveReflection(refl);
    emitChange();
    setRecordingId(null);
    refresh();
  };

  const onDelete = (bet: Bet) => {
    if (typeof window !== "undefined") {
      if (!window.confirm("この記録を削除しますか?")) return;
    }
    deleteBet(bet.id);
    setRecordingId(null);
    refresh();
  };

  if (bets.length === 0) {
    return (
      <Card>
        <CardBody className="py-6 text-center text-sm text-ink-muted">
          結果待ちの記録はありません
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="text-xs text-ink-muted">
          結果が出たら <span className="text-deep-green font-medium">的中</span> か <span className="text-wine font-medium">外れ</span> を押すだけ。成績と収支に自動で反映されます。
        </div>
        {bets.map((b) => (
          <PendingRow
            key={b.id}
            bet={b}
            recording={recordingId === b.id}
            onStartHit={() => setRecordingId(b.id)}
            onCancelHit={() => setRecordingId(null)}
            onConfirmHit={confirmHit}
            onMiss={onMiss}
            onDelete={onDelete}
          />
        ))}
      </CardBody>
    </Card>
  );
}

function PendingRow({
  bet,
  recording,
  onStartHit,
  onCancelHit,
  onConfirmHit,
  onMiss,
  onDelete,
}: {
  bet: Bet;
  recording: boolean;
  onStartHit: () => void;
  onCancelHit: () => void;
  onConfirmHit: (b: Bet, payout: number) => void;
  onMiss: (b: Bet) => void;
  onDelete: (b: Bet) => void;
}) {
  return (
    <div className={cn(
      "p-3 rounded-[12px] border bg-paper-soft/40",
      recording ? "border-deep-green/40 bg-deep-green-soft/20" : "border-line",
    )}>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Badge tone="tentative" size="xs">結果待ち</Badge>
            {bet.isDraft && <Badge size="xs">下書き</Badge>}
            <span className="text-[11px] text-ink-muted tabular">
              {bet.createdAt?.slice(5, 16).replace("T", " ")}
            </span>
          </div>
          <div className="text-sm font-medium truncate">
            {bet.course || ""} {bet.raceName || "—"}
          </div>
          <div className="text-xs text-ink-muted tabular">
            {bet.type} {bet.horses} · {formatYen(bet.amount)}
          </div>
        </div>
        {!recording && (
          <div className="flex items-center gap-1.5 shrink-0">
            <Button size="sm" variant="secondary" onClick={onStartHit} className="!h-9 !px-3">
              <Check className="w-4 h-4 text-deep-green" />
              的中
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onMiss(bet)} className="!h-9 !px-3">
              <XIcon className="w-4 h-4 text-wine" />
              外れ
            </Button>
            <button
              onClick={() => onDelete(bet)}
              className="p-2 rounded-[8px] hover:bg-paper-hover text-ink-faint hover:text-wine transition-colors"
              aria-label="削除"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {recording && (
        <HitForm bet={bet} onConfirm={(p) => onConfirmHit(bet, p)} onCancel={onCancelHit} />
      )}
    </div>
  );
}

/** 的中時の払戻金を画面内で入力 (ブラウザのprompt廃止) */
function HitForm({ bet, onConfirm, onCancel }: { bet: Bet; onConfirm: (payout: number) => void; onCancel: () => void }) {
  const [value, setValue] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 全角数字も受け付ける (６００ → 600)
  const half = value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const payout = Math.max(0, Math.round(Number(half.replace(/[^\d]/g, "")) || 0));
  const profit = payout - bet.amount;
  // 的中なら払戻金は必ず1円以上 (0円で確定できないように)
  const valid = payout > 0;

  return (
    <div className="mt-3 pt-3 border-t border-deep-green/20">
      <label className="block text-xs text-ink-soft font-medium mb-1.5">
        受け取った払戻金は？（当たった金額を入れてください）
      </label>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted text-sm">¥</span>
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => { if (e.key === "Enter" && valid) onConfirm(payout); if (e.key === "Escape") onCancel(); }}
            placeholder="例 600"
            className="w-full tabular bg-paper border border-line rounded-[10px] pl-7 pr-3 py-2.5 text-base text-ink focus:outline-none focus:border-deep-green"
          />
        </div>
        <Button size="md" variant="primary" disabled={!valid} onClick={() => onConfirm(payout)} className="shrink-0">
          確定
        </Button>
        <Button size="md" variant="ghost" onClick={onCancel} className="shrink-0">
          やめる
        </Button>
      </div>
      {/* 入力に応じて収支をその場で表示 */}
      <div className="mt-2 flex items-center gap-3 text-xs tabular">
        <span className="text-ink-muted">投資 {formatYen(bet.amount)}</span>
        {value.trim() !== "" && (
          <span className={cn("font-medium", profit >= 0 ? "text-deep-green" : "text-wine")}>
            収支 {profit >= 0 ? "+" : ""}{formatYen(profit)}
          </span>
        )}
      </div>
      {/* よくある外し: 当たったのに0円は無いので、はずれボタンへの誘導はしない */}
    </div>
  );
}

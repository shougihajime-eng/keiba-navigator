"use client";

import { useEffect, useState } from "react";
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
    setBets(pending.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  const onHit = (bet: Bet) => {
    let payout: number | undefined;
    if (typeof window !== "undefined") {
      const raw = window.prompt("払戻金額 (円)", String(bet.amount * 2));
      if (raw === null) return;
      const cleaned = raw.replace(/[^\d.]/g, "");
      const n = parseFloat(cleaned);
      if (!Number.isFinite(n) || n < 0) return;
      payout = Math.round(n);
    }
    updateBet(bet.id, { result: "hit", payout, isDraft: false });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("keiba:bet-added"));
    }
    refresh();
  };

  const onMiss = (bet: Bet) => {
    updateBet(bet.id, { result: "miss", payout: 0, isDraft: false });
    // 自動で反省文を生成して保存
    const refl = generateReflection({ ...bet, result: "miss", payout: 0 });
    saveReflection(refl);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("keiba:bet-added"));
    }
    refresh();
  };

  const onDelete = (bet: Bet) => {
    if (typeof window !== "undefined") {
      if (!window.confirm("この記録を削除しますか?")) return;
    }
    deleteBet(bet.id);
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
        {bets.map((b) => (
          <PendingRow key={b.id} bet={b} onHit={onHit} onMiss={onMiss} onDelete={onDelete} />
        ))}
      </CardBody>
    </Card>
  );
}

function PendingRow({
  bet,
  onHit,
  onMiss,
  onDelete,
}: {
  bet: Bet;
  onHit: (b: Bet) => void;
  onMiss: (b: Bet) => void;
  onDelete: (b: Bet) => void;
}) {
  return (
    <div className={cn(
      "flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-[12px]",
      "border border-line bg-paper-soft/40",
    )}>
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
      <div className="flex items-center gap-1.5 shrink-0">
        <Button size="sm" variant="secondary" onClick={() => onHit(bet)} className="!h-9 !px-3">
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
    </div>
  );
}

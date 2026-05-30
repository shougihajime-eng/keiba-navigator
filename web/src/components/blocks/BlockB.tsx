"use client";

import { useEffect, useState } from "react";
import { Card, CardBody, CardFooter } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { latestMiss, type Bet } from "@/lib/store";
import { formatYen } from "@/lib/utils";
import {
  loadReflections, recentReflections,
} from "@/lib/reflectionStore";
import { tagLabel, type StructuredReflection } from "@/lib/reflection";

export function BlockB() {
  const [bet, setBet] = useState<Bet | null>(null);
  const [reflection, setReflection] = useState<StructuredReflection | null>(null);
  const [allCount, setAllCount] = useState(0);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("keiba:bet-added", onChange);
    window.addEventListener("keiba:reflection-added", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("keiba:bet-added", onChange);
      window.removeEventListener("keiba:reflection-added", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  function refresh() {
    const lastBet = latestMiss();
    setBet(lastBet);
    const all = loadReflections();
    setAllCount(all.length);
    setReflection(recentReflections(1)[0] ?? null);
  }

  return (
    <section>
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-[0.16em] text-ink-blue font-medium">
          LATEST REFLECTION · 直近の反省
        </div>
        <h2 className="mt-1 font-display text-xl md:text-2xl font-semibold tracking-tight">
          {bet || reflection ? "外したレースから学ぶ" : "外したレースはまだなし"}
        </h2>
      </div>

      {bet || reflection ? (
        <Card tone="lost">
          <CardBody className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <Badge tone="lost">外れ</Badge>
              {reflection && (
                <span className="text-xs text-ink-muted tabular">
                  {reflection.createdAt.slice(5, 10)} · #{allCount}
                </span>
              )}
            </div>
            <div>
              <h3 className="font-display text-lg font-semibold tracking-tight">
                {reflection?.course || bet?.course || ""} {reflection?.raceName || bet?.raceName || "—"}
              </h3>
              {bet && (
                <div className="mt-1 text-sm text-ink-muted">
                  {bet.type} {bet.horses} · {formatYen(bet.amount)}
                </div>
              )}
            </div>

            {reflection && reflection.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {reflection.tags.slice(0, 4).map((t) => (
                  <Badge key={t} tone="lost" size="sm">
                    {tagLabel(t)}
                  </Badge>
                ))}
              </div>
            )}

            <div className="bg-paper-soft/60 rounded-[10px] p-3 text-sm text-ink-soft leading-relaxed whitespace-pre-line">
              {reflection?.freeText || "原因を推定中..."}
            </div>
          </CardBody>
          <CardFooter className="flex justify-between gap-2 items-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (typeof window !== "undefined") {
                  window.dispatchEvent(
                    new CustomEvent("keiba:open-section", { detail: "reflections" }),
                  );
                }
              }}
            >
              全反省履歴を見る
            </Button>
            <span className="text-xs text-ink-muted">
              累計 {allCount} 件 · 次回の重み調整に反映
            </span>
          </CardFooter>
        </Card>
      ) : (
        <Card>
          <CardBody className="py-8 text-center text-ink-muted text-sm">
            まだ外れ記録なし。これから記録を積み上げて AI を育てよう。
          </CardBody>
        </Card>
      )}
    </section>
  );
}

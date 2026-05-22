"use client";

import { useEffect, useState } from "react";
import { Card, CardBody, CardFooter } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { latestMiss, type Bet } from "@/lib/store";
import { formatYen } from "@/lib/utils";
import { reflectionFor } from "@/lib/reflection";

export function BlockB() {
  const [bet, setBet] = useState<Bet | null>(null);
  const [reflection, setReflection] = useState<string>("");

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
    const last = latestMiss();
    setBet(last);
    if (last) setReflection(reflectionFor(last));
  }

  return (
    <section>
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-[0.16em] text-ink-blue font-medium">
          LATEST REFLECTION · 直近の反省
        </div>
        <h2 className="mt-1 font-display text-xl md:text-2xl font-semibold tracking-tight">
          {bet ? "外したレースから学ぶ" : "外したレースはまだなし"}
        </h2>
      </div>

      {bet ? (
        <Card tone="lost">
          <CardBody className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <Badge tone="lost">外れ</Badge>
              <span className="text-xs text-ink-muted tabular">
                {bet.createdAt?.slice(5, 10)} {bet.startTime?.slice(11, 16) || ""}
              </span>
            </div>
            <div>
              <h3 className="font-display text-lg font-semibold tracking-tight">
                {bet.course || ""} {bet.raceName || "—"}
              </h3>
              <div className="mt-1 text-sm text-ink-muted">
                {bet.type} {bet.horses} · {formatYen(bet.amount)}
              </div>
            </div>
            <div className="bg-paper-soft/60 rounded-[10px] p-3 text-sm text-ink-soft leading-relaxed">
              {reflection}
            </div>
          </CardBody>
          <CardFooter className="flex justify-between gap-2">
            <Button variant="ghost" size="sm">全反省履歴を見る</Button>
            <span className="text-xs text-ink-muted self-center">Phase 4 で完全実装</span>
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

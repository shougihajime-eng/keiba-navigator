"use client";

import { useEffect, useState } from "react";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import {
  loadReflections, tagFrequency, recentReflections,
} from "@/lib/reflectionStore";
import { tagLabel, type StructuredReflection, type MissTag } from "@/lib/reflection";
import { cn } from "@/lib/utils";

export function ReflectionDashboard() {
  const [refs, setRefs] = useState<StructuredReflection[]>([]);
  const [freq, setFreq] = useState<Array<{ tag: MissTag; count: number }>>([]);
  const [recent, setRecent] = useState<StructuredReflection[]>([]);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("keiba:reflection-added", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("keiba:reflection-added", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  function refresh() {
    const all = loadReflections();
    setRefs(all);
    setFreq(tagFrequency(all));
    setRecent(recentReflections(5));
  }

  if (refs.length === 0) {
    return (
      <div className="text-sm text-ink-muted py-3">
        外したレースを「外れ」で記録すると、自動で反省文を生成してここに集計されます。
      </div>
    );
  }

  const total = refs.length;
  const top5 = freq.slice(0, 5);
  const max = top5[0]?.count ?? 1;

  return (
    <div className="space-y-5 mt-3">
      <div>
        <div className="text-[10px] uppercase tracking-[0.14em] text-ink-muted font-medium mb-2">
          最近よく外す理由 TOP5
        </div>
        <Card>
          <CardBody className="space-y-2">
            {top5.map((row) => {
              const pct = (row.count / max) * 100;
              return (
                <div key={row.tag} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-ink-soft">{tagLabel(row.tag)}</span>
                    <span className="tabular text-ink-muted">{row.count} 回</span>
                  </div>
                  <div className="h-1.5 bg-paper-soft rounded-full overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all duration-500",
                        row.count >= 3 ? "bg-wine" : "bg-ink-blue",
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
            <div className="pt-2 mt-2 border-t border-line/60 text-xs text-ink-muted">
              全 {total} 件の反省文から集計
            </div>
          </CardBody>
        </Card>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-[0.14em] text-ink-muted font-medium mb-2">
          最近の反省 (直近5件)
        </div>
        <Card>
          <CardBody className="divide-y divide-line/60">
            {recent.map((r) => (
              <div key={r.id} className="py-3 first:pt-0 last:pb-0 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium truncate">
                    {r.course || ""} {r.raceName || "—"}
                  </div>
                  <span className="text-[11px] text-ink-muted tabular shrink-0">
                    {r.createdAt.slice(5, 10)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {r.tags.slice(0, 4).map((t) => (
                    <Badge key={t} tone="lost" size="xs">
                      {tagLabel(t)}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

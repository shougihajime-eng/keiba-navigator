"use client";

import { useEffect, useState } from "react";

const WD = ["日", "月", "火", "水", "木", "金", "土"];

function label(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日 (${WD[d.getDay()]})`;
}

/**
 * ヘッダの日付表示。
 * ページは静的生成されるため、サーバ側の new Date() はビルド時刻で固まる。
 * クライアントで実際の「今日」を出し、日付の境目で自動更新する。
 */
export function LiveDate({ className }: { className?: string }) {
  // 初期値はクライアントの現在時刻 (hydration 後に即正しい日付になる)
  const [text, setText] = useState(() => label(new Date()));

  useEffect(() => {
    const tick = () => setText(label(new Date()));
    tick();
    // 1 分ごとに確認 (日付が変わった瞬間に追従)
    const id = setInterval(tick, 60_000);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <time className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}

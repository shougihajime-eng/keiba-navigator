"use client";

import { useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { isNotifySupported, isPermissionGranted, requestPermission } from "@/lib/notify";

const DISMISS_KEY = "keiba.notify-bar.dismissed";

export function NotifyBar() {
  const [show, setShow] = useState(false);
  const [granting, setGranting] = useState(false);

  useEffect(() => {
    if (!isNotifySupported()) return;
    if (isPermissionGranted()) return;
    const dismissed = window.localStorage.getItem(DISMISS_KEY);
    if (dismissed) {
      const ts = Date.parse(dismissed);
      // 3 日間は再表示しない
      if (Number.isFinite(ts) && Date.now() - ts < 3 * 24 * 60 * 60 * 1000) return;
    }
    setShow(true);
  }, []);

  const handleAllow = async () => {
    setGranting(true);
    const r = await requestPermission();
    setGranting(false);
    if (r === "granted") {
      setShow(false);
    } else {
      // denied → 1 週間表示しない
      const ts = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString();
      window.localStorage.setItem(DISMISS_KEY, ts);
      setShow(false);
    }
  };

  const handleDismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, new Date().toISOString());
    setShow(false);
  };

  if (!show) return null;

  return (
    <div className="bg-gold-soft border-b border-gold/30 text-ink-soft">
      <div className="max-w-4xl mx-auto px-3 sm:px-4 py-2.5 flex items-center justify-between gap-2 sm:gap-3">
        <span className="flex items-center gap-2 text-xs md:text-sm min-w-0 flex-1">
          <Bell className="w-4 h-4 text-gold-deep shrink-0" />
          <span className="truncate">
            <span className="sm:hidden">星5・星4の10分前に通知</span>
            <span className="hidden sm:inline">星5・星4 レースの発走 10 分前に通知します</span>
          </span>
        </span>
        <span className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          <Button variant="gold" size="sm" loading={granting} onClick={handleAllow}>
            通知ON
          </Button>
          <button
            onClick={handleDismiss}
            className="p-1.5 rounded-full hover:bg-gold/15 text-ink-muted transition-colors"
            aria-label="閉じる"
          >
            <X className="w-4 h-4" />
          </button>
        </span>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Horseshoe } from "@/components/icons/Horseshoe";

const KEY = "keiba.install-prompt.dismissed";

// BeforeInstallPromptEvent (TS は標準で持ってない)
interface BIPEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BIPEvent | null>(null);
  const [show, setShow] = useState(false);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const dismissed = window.localStorage.getItem(KEY);
    if (dismissed) {
      const ts = Date.parse(dismissed);
      // 14 日間は再表示しない
      if (Number.isFinite(ts) && Date.now() - ts < 14 * 24 * 60 * 60 * 1000) return;
    }

    // すでにスタンドアロン (PWA) で起動中なら何もしない
    if (window.matchMedia("(display-mode: standalone)").matches) return;

    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIos) {
      // iOS Safari は beforeinstallprompt 不発火・手動説明モード
      setIosHint(true);
      setShow(true);
      return;
    }

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BIPEvent);
      setShow(true);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const handleInstall = async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice.outcome === "accepted") {
        setShow(false);
      } else {
        snooze();
      }
    } catch {
      snooze();
    }
  };

  const snooze = () => {
    window.localStorage.setItem(KEY, new Date().toISOString());
    setShow(false);
  };

  if (!show) return null;

  return (
    <div className="fixed bottom-4 inset-x-4 z-40 md:max-w-md md:left-auto md:right-4 anim-fade-up">
      <div className="bg-paper border border-line rounded-[16px] shadow-[var(--shadow-lg)] p-4">
        <div className="flex items-start gap-3">
          <div className="shrink-0 w-10 h-10 rounded-[10px] bg-gold-soft flex items-center justify-center">
            <Horseshoe className="w-5 h-5 text-gold-deep" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-display font-semibold text-[15px] tracking-tight">
              ホーム画面に追加
            </div>
            <p className="mt-1 text-xs text-ink-muted leading-relaxed">
              {iosHint
                ? "Safari の共有 (□↑) → 「ホーム画面に追加」で 1 タップ起動できます"
                : "アプリのように起動・通知も受け取れます"}
            </p>
            <div className="mt-3 flex items-center gap-2">
              {iosHint ? (
                <Button variant="secondary" size="sm" onClick={snooze}>
                  わかった
                </Button>
              ) : (
                <>
                  <Button variant="gold" size="sm" onClick={handleInstall}>
                    <Download className="w-3.5 h-3.5" />
                    追加する
                  </Button>
                  <Button variant="ghost" size="sm" onClick={snooze}>
                    後で
                  </Button>
                </>
              )}
            </div>
          </div>
          <button
            onClick={snooze}
            className="shrink-0 p-1.5 rounded-full hover:bg-paper-hover text-ink-muted transition-colors"
            aria-label="閉じる"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

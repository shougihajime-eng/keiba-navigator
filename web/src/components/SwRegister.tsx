"use client";

import { useEffect } from "react";

/** Service Worker の登録 — manifest と並んで PWA の基盤 */
export function SwRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    const onLoad = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((reg) => {
          if (reg.waiting) reg.waiting.postMessage("skipWaiting");
          reg.addEventListener("updatefound", () => {
            const newSw = reg.installing;
            if (!newSw) return;
            newSw.addEventListener("statechange", () => {
              if (newSw.state === "installed" && navigator.serviceWorker.controller) {
                newSw.postMessage("skipWaiting");
              }
            });
          });
        })
        .catch((err) => console.warn("[sw] registration failed", err));
    };

    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });

    return () => window.removeEventListener("load", onLoad);
  }, []);

  return null;
}

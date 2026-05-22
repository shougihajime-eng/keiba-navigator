// Web Notification API ラッパ
// 10分前通知の重複防止と permission 管理
"use client";

const NOTIFIED_KEY = "keiba.notified.v1";

export function isNotifySupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function isPermissionGranted(): boolean {
  if (!isNotifySupported()) return false;
  return Notification.permission === "granted";
}

export async function requestPermission(): Promise<NotificationPermission> {
  if (!isNotifySupported()) return "denied";
  if (Notification.permission === "default") {
    try {
      return await Notification.requestPermission();
    } catch {
      return "denied";
    }
  }
  return Notification.permission;
}

export function notify(opts: { title: string; body?: string; tag?: string; icon?: string }) {
  if (!isPermissionGranted()) return;
  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      icon: opts.icon,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* ignore */
  }
}

function getNotified(): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(NOTIFIED_KEY) || "{}");
  } catch {
    return {};
  }
}

function setNotified(map: Record<string, string>) {
  try {
    window.localStorage.setItem(NOTIFIED_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** raceId + kind の組み合わせで 1 回だけ通知。重複防止 */
export function notifyOnce(raceId: string, kind: string, opts: { title: string; body?: string }) {
  const key = `${raceId}:${kind}`;
  const map = getNotified();
  if (map[key]) return false;
  map[key] = new Date().toISOString();
  setNotified(map);
  notify({ ...opts, tag: key });
  return true;
}

/** 古い通知記録を掃除 (3日以上前) */
export function pruneNotifyHistory() {
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
  const map = getNotified();
  for (const k of Object.keys(map)) {
    if (Date.parse(map[k]) < cutoff) delete map[k];
  }
  setNotified(map);
}

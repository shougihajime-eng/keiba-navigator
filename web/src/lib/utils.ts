import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatYen(n: number): string {
  if (!Number.isFinite(n)) return "¥—";
  const sign = n < 0 ? "-" : "";
  return `${sign}¥${Math.abs(Math.round(n)).toLocaleString("ja-JP")}`;
}

export function formatPct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

export function formatHHMM(d: Date | string | number): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "--:--";
  const hh = date.getHours().toString().padStart(2, "0");
  const mm = date.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

export function minutesUntil(d: Date | string | number): number {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return NaN;
  return Math.round((date.getTime() - Date.now()) / 60000);
}

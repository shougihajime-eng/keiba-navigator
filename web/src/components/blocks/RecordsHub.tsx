"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays, ListChecks, Download, Upload, Trash2, Pencil, X, Check, ChevronLeft, ChevronRight,
} from "lucide-react";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import {
  loadBets, updateBet, deleteBet, mergeBets, type Bet,
} from "@/lib/store";
import { betsToCsv, csvToBets, downloadCsv } from "@/lib/csv";
import { formatYen, cn } from "@/lib/utils";

type Tab = "calendar" | "list" | "io";

export function RecordsHub() {
  const [bets, setBets] = useState<Bet[]>([]);
  const [tab, setTab] = useState<Tab>("calendar");

  useEffect(() => {
    const refresh = () => setBets(loadBets());
    refresh();
    window.addEventListener("keiba:bet-added", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("keiba:bet-added", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const emit = () => {
    setBets(loadBets());
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("keiba:bet-added"));
  };

  return (
    <section aria-label="記録ノート">
      <div className="mb-3">
        <div className="text-[10px] uppercase tracking-[0.16em] text-deep-green font-medium flex items-center gap-1.5">
          <CalendarDays className="w-3.5 h-3.5" /> RECORDS · 記録ノート
        </div>
        <h2 className="mt-1 font-display text-xl md:text-2xl font-semibold tracking-tight">
          いつ買って、勝ったか負けたか
        </h2>
      </div>

      <Card elevated>
        <CardBody className="space-y-4">
          {/* タブ */}
          <div className="grid grid-cols-3 gap-2">
            <TabBtn active={tab === "calendar"} onClick={() => setTab("calendar")} icon={<CalendarDays className="w-4 h-4" />} label="カレンダー" />
            <TabBtn active={tab === "list"} onClick={() => setTab("list")} icon={<ListChecks className="w-4 h-4" />} label="一覧・編集" />
            <TabBtn active={tab === "io"} onClick={() => setTab("io")} icon={<Download className="w-4 h-4" />} label="書き出し・取り込み" />
          </div>

          {tab === "calendar" && <CalendarView bets={bets} />}
          {tab === "list" && <ListView bets={bets} onChanged={emit} />}
          {tab === "io" && <IoView onImported={emit} />}
        </CardBody>
      </Card>
    </section>
  );
}

function TabBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-1.5 py-2 rounded-[10px] text-xs sm:text-sm font-medium border transition-all",
        active ? "border-ink bg-ink text-paper" : "border-line bg-paper hover:bg-paper-hover text-ink-soft",
      )}
    >
      {icon}<span className="truncate">{label}</span>
    </button>
  );
}

// =========================================
// カレンダー (月ごとに勝ち負けを色で)
// =========================================
const WD = ["日", "月", "火", "水", "木", "金", "土"];

function dayKey(iso: string): string {
  // ローカル日付の YYYY-MM-DD
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function CalendarView({ bets }: { bets: Bet[] }) {
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [selected, setSelected] = useState<string | null>(null);

  // 日ごとに集計
  const byDay = useMemo(() => {
    const map = new Map<string, { stake: number; payout: number; settled: number; count: number }>();
    for (const b of bets) {
      const k = dayKey(b.createdAt || "");
      if (!k) continue;
      const v = map.get(k) ?? { stake: 0, payout: 0, settled: 0, count: 0 };
      v.stake += Number(b.amount) || 0;
      v.count += 1;
      if (b.result === "hit" || b.result === "miss") {
        v.settled += 1;
        v.payout += Number(b.payout) || 0;
      }
      map.set(k, v);
    }
    return map;
  }, [bets]);

  const first = new Date(cursor.y, cursor.m, 1);
  const startWd = first.getDay();
  const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startWd; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) cells.push(d);

  const monthStr = `${cursor.y}年${cursor.m + 1}月`;
  const prev = () => setCursor((c) => c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 });
  const next = () => setCursor((c) => c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 });

  const selBets = selected
    ? bets.filter((b) => dayKey(b.createdAt || "") === selected)
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    : [];

  return (
    <div className="space-y-3">
      {/* 月の移動 */}
      <div className="flex items-center justify-between">
        <button onClick={prev} className="p-1.5 rounded-full hover:bg-paper-hover text-ink-muted" aria-label="前の月"><ChevronLeft className="w-5 h-5" /></button>
        <span className="font-display font-semibold tabular">{monthStr}</span>
        <button onClick={next} className="p-1.5 rounded-full hover:bg-paper-hover text-ink-muted" aria-label="次の月"><ChevronRight className="w-5 h-5" /></button>
      </div>

      {/* 曜日見出し */}
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-ink-muted font-medium">
        {WD.map((w, i) => <div key={w} className={cn(i === 0 && "text-wine/70", i === 6 && "text-ink-blue/70")}>{w}</div>)}
      </div>

      {/* 日マス */}
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (d === null) return <div key={`e${i}`} />;
          const k = `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const v = byDay.get(k);
          const profit = v ? v.payout - v.stake : 0;
          const hasSettled = v && v.settled > 0;
          const tone = !v ? "" : !hasSettled ? "pending" : profit > 0 ? "win" : profit < 0 ? "loss" : "even";
          const isSel = selected === k;
          return (
            <button
              key={k}
              onClick={() => setSelected(isSel ? null : (v ? k : null))}
              disabled={!v}
              className={cn(
                "aspect-square rounded-[8px] border flex flex-col items-center justify-center text-xs transition-all",
                !v && "border-transparent text-ink-faint cursor-default",
                tone === "win" && "border-deep-green/30 bg-deep-green-soft/50 text-deep-green font-semibold",
                tone === "loss" && "border-wine/25 bg-wine-soft/45 text-wine font-semibold",
                tone === "even" && "border-line bg-paper-soft text-ink-soft",
                tone === "pending" && "border-ink-blue/25 bg-ink-blue-soft/40 text-ink-blue",
                isSel && "ring-2 ring-ink",
              )}
            >
              <span className="tabular leading-none">{d}</span>
              {v && (
                <span className="mt-0.5 text-[8px] leading-none tabular">
                  {hasSettled ? `${profit >= 0 ? "+" : ""}${Math.round(profit / 1000)}k` : `${v.count}件`}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 凡例 */}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-muted">
        <LegendDot cls="bg-deep-green-soft border-deep-green/30" label="勝ち" />
        <LegendDot cls="bg-wine-soft border-wine/25" label="負け" />
        <LegendDot cls="bg-ink-blue-soft border-ink-blue/25" label="結果待ち" />
        <span className="text-ink-faint">日をタップでその日の馬券</span>
      </div>

      {/* 選んだ日の一覧 */}
      {selected && selBets.length > 0 && (
        <div className="pt-3 border-t border-line/60 space-y-2">
          <div className="text-xs text-ink-muted font-medium">{selected.replace(/-/g, "/")} の記録</div>
          {selBets.map((b) => <MiniBetRow key={b.id} bet={b} />)}
        </div>
      )}
    </div>
  );
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return <span className="inline-flex items-center gap-1"><span className={cn("inline-block w-3 h-3 rounded border", cls)} />{label}</span>;
}

function MiniBetRow({ bet }: { bet: Bet }) {
  const profit = (Number(bet.payout) || 0) - (Number(bet.amount) || 0);
  const done = bet.result === "hit" || bet.result === "miss";
  return (
    <div className="flex items-center justify-between gap-2 text-sm py-1.5 border-b border-line/30 last:border-0">
      <div className="min-w-0">
        <div className="truncate text-ink-soft">{bet.raceName || bet.course || "手入力"}</div>
        <div className="text-xs text-ink-muted tabular">{bet.type} {bet.horses} · {formatYen(bet.amount)}</div>
      </div>
      <div className="shrink-0 text-right">
        {done ? (
          <span className={cn("tabular font-medium", profit >= 0 ? "text-deep-green" : "text-wine")}>
            {profit >= 0 ? "+" : ""}{formatYen(profit)}
          </span>
        ) : (
          <Badge tone="tentative" size="xs">結果待ち</Badge>
        )}
      </div>
    </div>
  );
}

// =========================================
// 一覧・編集 (全記録を見て直す/消す)
// =========================================
function ListView({ bets, onChanged }: { bets: Bet[]; onChanged: () => void }) {
  const [editId, setEditId] = useState<string | null>(null);
  const sorted = useMemo(
    () => [...bets].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")),
    [bets],
  );

  if (sorted.length === 0) {
    return <p className="text-sm text-ink-muted py-4 text-center">まだ記録がありません。</p>;
  }

  return (
    <div className="space-y-2">
      <div className="text-xs text-ink-muted">全 {sorted.length} 件。鉛筆で直す・ゴミ箱で消す。</div>
      {sorted.map((b) =>
        editId === b.id
          ? <EditRow key={b.id} bet={b} onDone={() => { setEditId(null); onChanged(); }} onCancel={() => setEditId(null)} />
          : <ViewRow key={b.id} bet={b} onEdit={() => setEditId(b.id)} onDelete={() => {
              if (typeof window !== "undefined" && !window.confirm("この記録を消しますか?")) return;
              deleteBet(b.id); onChanged();
            }} />,
      )}
    </div>
  );
}

function resultBadge(b: Bet) {
  if (b.result === "hit") return <Badge tone="won" size="xs">当たり</Badge>;
  if (b.result === "miss") return <Badge tone="lost" size="xs">外れ</Badge>;
  return <Badge tone="tentative" size="xs">結果待ち</Badge>;
}

function ViewRow({ bet, onEdit, onDelete }: { bet: Bet; onEdit: () => void; onDelete: () => void }) {
  const profit = (Number(bet.payout) || 0) - (Number(bet.amount) || 0);
  const done = bet.result === "hit" || bet.result === "miss";
  return (
    <div className="flex items-center gap-2 p-2.5 rounded-[10px] border border-line bg-paper-soft/40">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {resultBadge(bet)}
          <span className="text-[11px] text-ink-muted tabular">{(bet.createdAt || "").slice(0, 10).replace(/-/g, "/")}</span>
        </div>
        <div className="mt-0.5 text-sm truncate">{bet.raceName || bet.course || "手入力"}</div>
        <div className="text-xs text-ink-muted tabular">{bet.type} {bet.horses} · {formatYen(bet.amount)}{done && <> → {formatYen(Number(bet.payout) || 0)}</>}</div>
      </div>
      {done && (
        <span className={cn("shrink-0 tabular text-sm font-medium", profit >= 0 ? "text-deep-green" : "text-wine")}>
          {profit >= 0 ? "+" : ""}{formatYen(profit)}
        </span>
      )}
      <div className="flex items-center gap-1 shrink-0">
        <button onClick={onEdit} className="p-2 rounded-[8px] hover:bg-paper-hover text-ink-muted" aria-label="直す"><Pencil className="w-4 h-4" /></button>
        <button onClick={onDelete} className="p-2 rounded-[8px] hover:bg-paper-hover text-ink-faint hover:text-wine" aria-label="消す"><Trash2 className="w-4 h-4" /></button>
      </div>
    </div>
  );
}

const RES_OPTS = [
  { key: "pending", label: "まだ" },
  { key: "hit", label: "当たり" },
  { key: "miss", label: "外れ" },
] as const;

function EditRow({ bet, onDone, onCancel }: { bet: Bet; onDone: () => void; onCancel: () => void }) {
  const [amount, setAmount] = useState(String(bet.amount ?? ""));
  const [horses, setHorses] = useState(bet.horses ?? "");
  const [result, setResult] = useState<"hit" | "miss" | "pending">((bet.result as "hit" | "miss" | "pending") || "pending");
  const [payout, setPayout] = useState(String(bet.payout ?? ""));

  const toNum = (s: string) => Math.max(0, Math.round(Number((s || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[^\d]/g, "")) || 0));
  const amt = toNum(amount);
  const pay = toNum(payout);
  const valid = amt >= 100 && (result !== "hit" || pay > 0);

  const save = () => {
    if (!valid) return;
    updateBet(bet.id, {
      amount: amt,
      horses: horses.trim(),
      result,
      payout: result === "hit" ? pay : result === "miss" ? 0 : undefined,
      isDraft: false,
    });
    onDone();
  };

  return (
    <div className="p-3 rounded-[10px] border border-ink/30 bg-paper space-y-3">
      <div className="text-xs text-ink-muted">{bet.raceName || bet.course || "手入力"} · {bet.type}</div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11px] text-ink-muted">買い目
          <input value={horses} onChange={(e) => setHorses(e.target.value)} className="mt-1 w-full h-10 px-2.5 rounded-[8px] border border-line bg-paper text-sm tabular focus:border-gold outline-none" />
        </label>
        <label className="text-[11px] text-ink-muted">金額
          <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 w-full h-10 px-2.5 rounded-[8px] border border-line bg-paper text-sm tabular focus:border-gold outline-none" />
        </label>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {RES_OPTS.map((r) => (
          <button key={r.key} onClick={() => setResult(r.key)}
            className={cn("py-2 text-sm rounded-[8px] border transition-all",
              result === r.key
                ? r.key === "hit" ? "border-deep-green bg-deep-green text-white" : r.key === "miss" ? "border-wine bg-wine text-white" : "border-ink bg-ink text-paper"
                : "border-line bg-paper text-ink-soft")}>
            {r.label}
          </button>
        ))}
      </div>
      {result === "hit" && (
        <label className="block text-[11px] text-ink-muted">払戻金
          <input inputMode="numeric" value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="例 8000" className="mt-1 w-full h-10 px-2.5 rounded-[8px] border border-line bg-paper text-sm tabular focus:border-deep-green outline-none" />
        </label>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}><X className="w-4 h-4" />やめる</Button>
        <Button size="sm" variant="primary" className="flex-1" disabled={!valid} onClick={save}><Check className="w-4 h-4" />保存</Button>
      </div>
    </div>
  );
}

// =========================================
// 書き出し・取り込み (CSV)
// =========================================
function IoView({ onImported }: { onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const handleExport = () => {
    const bets = loadBets();
    if (bets.length === 0) { setMsg({ type: "err", text: "書き出す記録がありません。" }); return; }
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`keiba-records-${stamp}.csv`, betsToCsv(bets));
    setMsg({ type: "ok", text: `${bets.length} 件を書き出しました（ダウンロード）。` });
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const { bets, errors } = csvToBets(String(reader.result || ""));
        if (bets.length === 0) {
          setMsg({ type: "err", text: errors[0] || "取り込める記録がありませんでした。" });
        } else {
          const { added, skipped } = mergeBets(bets);
          setMsg({
            type: "ok",
            text: `${added} 件を取り込みました${skipped > 0 ? `（重複 ${skipped} 件はスキップ）` : ""}。`,
          });
          if (added > 0) onImported();
        }
      } catch {
        setMsg({ type: "err", text: "ファイルを読めませんでした。CSV ファイルか確認してください。" });
      }
    };
    reader.readAsText(file, "utf-8");
    e.target.value = ""; // 同じファイルを連続で選べるように
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-soft leading-relaxed">
        記録をファイル (CSV) に書き出して保存・バックアップできます。別の端末で取り込めば記録を引き継げます。表計算ソフト (Excel など) でも開けます。
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button onClick={handleExport}
          className="flex items-center gap-3 p-4 rounded-[12px] border border-deep-green/30 bg-deep-green-soft/30 hover:bg-deep-green-soft/50 transition-colors text-left">
          <Download className="w-5 h-5 text-deep-green shrink-0" />
          <div>
            <div className="font-medium text-sm">書き出す</div>
            <div className="text-xs text-ink-muted">今ある記録をCSVで保存</div>
          </div>
        </button>

        <button onClick={() => fileRef.current?.click()}
          className="flex items-center gap-3 p-4 rounded-[12px] border border-gold/30 bg-gold-soft/30 hover:bg-gold-soft/50 transition-colors text-left">
          <Upload className="w-5 h-5 text-gold-deep shrink-0" />
          <div>
            <div className="font-medium text-sm">取り込む</div>
            <div className="text-xs text-ink-muted">CSVファイルから記録を追加</div>
          </div>
        </button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" />
      </div>

      {msg && (
        <div className={cn("text-sm px-3 py-2.5 rounded-[10px]", msg.type === "ok" ? "bg-deep-green-soft text-deep-green" : "bg-wine-soft text-wine")}>
          {msg.text}
        </div>
      )}

      <p className="text-[11px] text-ink-faint leading-relaxed">
        取り込みは「追加」です（今ある記録は消えません）。同じ記録 (同じID) は二重に入らないようスキップします。
        書き出したCSVをそのまま取り込めます。
      </p>
    </div>
  );
}

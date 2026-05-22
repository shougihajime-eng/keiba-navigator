"use client";

import { useEffect, useState, useTransition } from "react";
import { Mail, Cloud, CloudCheck, LogOut, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { currentUser, signInWithEmail, signOut } from "@/lib/supabase";
import { runSync } from "@/lib/sync";
import { cn } from "@/lib/utils";

interface SyncCardProps {
  compact?: boolean;
}

export function SyncCard({ compact = false }: SyncCardProps) {
  const [email, setEmail] = useState("");
  const [user, setUser] = useState<{ email?: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "err" | "info"; text: string } | null>(null);

  useEffect(() => {
    refresh();
    const onSynced = () => refresh();
    window.addEventListener("keiba:synced", onSynced);
    return () => window.removeEventListener("keiba:synced", onSynced);
  }, []);

  async function refresh() {
    const u = await currentUser();
    setUser(u ? { email: u.email } : null);
    setLastSync(window.localStorage.getItem("keiba.last-sync.v1"));
  }

  const handleSignIn = (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    startTransition(async () => {
      const { error } = await signInWithEmail(email.trim());
      if (error) {
        setMsg({ type: "err", text: error.message });
      } else {
        setMsg({ type: "info", text: `${email} にログインリンクを送りました。メールから開いてください。` });
      }
    });
  };

  const handleSignOut = () => {
    startTransition(async () => {
      await signOut();
      await refresh();
    });
  };

  const handleSync = () => {
    setSyncing(true);
    runSync().then((r) => {
      if (r.error) setMsg({ type: "err", text: r.error });
      else setMsg({ type: "ok", text: `同期完了 · ${r.pendingBets + r.pendingRefs} 件をアップロード` });
      setSyncing(false);
      refresh();
    });
  };

  if (user) {
    return (
      <Card>
        <CardBody className={cn("space-y-3", compact && "py-3")}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <CloudCheck className="w-4 h-4 text-deep-green shrink-0" />
              <span className="text-sm font-medium truncate">{user.email}</span>
            </div>
            <Button variant="ghost" size="sm" onClick={handleSignOut} disabled={pending}>
              <LogOut className="w-3.5 h-3.5" />
              ログアウト
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-line/60">
            <span className="text-xs text-ink-muted tabular">
              {lastSync ? `最終同期: ${lastSync.slice(5, 16).replace("T", " ")}` : "未同期"}
            </span>
            <Button variant="secondary" size="sm" loading={syncing} onClick={handleSync}>
              <RefreshCw className="w-3.5 h-3.5" />
              今すぐ同期
            </Button>
          </div>
          {msg && (
            <div className={cn(
              "text-xs px-3 py-2 rounded-[8px]",
              msg.type === "ok" && "bg-deep-green-soft text-deep-green",
              msg.type === "err" && "bg-wine-soft text-wine",
              msg.type === "info" && "bg-ink-blue-soft text-ink-blue",
            )}>
              {msg.text}
            </div>
          )}
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-start gap-3">
          <Cloud className="w-5 h-5 text-ink-muted shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="text-sm font-medium">クラウド同期 (上級者向け)</div>
            <p className="text-xs text-ink-muted leading-relaxed">
              メールアドレスを登録すると、別の端末 (PC・スマホ・タブレット) の間で
              買った馬券と反省ノートが自動同期されます。
            </p>
          </div>
        </div>
        <form onSubmit={handleSignIn} className="flex gap-2 pt-2 border-t border-line/60">
          <div className="flex-1 relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" />
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="メールアドレス"
              className="w-full h-10 pl-9 pr-3 rounded-[10px] border border-line bg-paper text-sm focus:border-ink outline-none transition-colors"
            />
          </div>
          <Button type="submit" variant="primary" size="md" loading={pending} disabled={!email.trim()}>
            送信
          </Button>
        </form>
        {msg && (
          <div className={cn(
            "text-xs px-3 py-2 rounded-[8px]",
            msg.type === "ok" && "bg-deep-green-soft text-deep-green",
            msg.type === "err" && "bg-wine-soft text-wine",
            msg.type === "info" && "bg-ink-blue-soft text-ink-blue",
          )}>
            {msg.text}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

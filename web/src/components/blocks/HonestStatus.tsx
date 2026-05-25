"use client";

import { ShieldCheck, TrendingDown, Target, Database, CheckCircle2, XCircle } from "lucide-react";
import { Card, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";

/**
 * AIの正直な現在地
 * ------------------------------------------------------------------
 * 2026-05-26 の徹底検証 (ズルなし walk-forward + 補正済みEV + 総当たり分析) で確定した
 * 「今のデータでは必ず勝てる買い方は無い」という事実を、お金をかける人を守るために
 * 最上段で正直に伝える。嘘の高ROIで損させない = このアプリの最重要原則。
 */
export function HonestStatus() {
  return (
    <section aria-label="AIの正直な現在地">
      <Card elevated className="overflow-hidden">
        {/* ヘッダ帯 */}
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-3 border-b border-line/60">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-deep-green-soft text-deep-green shrink-0">
            <ShieldCheck className="w-4.5 h-4.5" />
          </span>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.16em] text-deep-green font-medium">
              HONEST STATUS · AIの正直な現在地
            </div>
            <h2 className="font-display text-lg md:text-xl font-semibold tracking-tight leading-tight">
              嘘はつきません — 今わかっている本当のこと
            </h2>
          </div>
        </div>

        <CardBody className="space-y-5">
          {/* 結論 */}
          <p className="text-sm md:text-[15px] text-ink-soft leading-relaxed">
            過去 3,636 レースを、未来を見ずに検証する方法 (3 通り) で徹底的に調べました。結論は正直に言います。
            <span className="font-semibold text-ink">
              今のデータでは、平均して必ず勝てる買い方は見つかっていません。
            </span>
            競馬は JRA の取り分が約 2 割あり、世間 (オッズ) がとても正確なので、誰が作っても
            「必ず儲かるアプリ」は作れない、というのが現実です。
          </p>

          {/* データで分かった3つの事実 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FactCard
              icon={<Target className="w-4 h-4" />}
              tone="green"
              stat="20% → 20.6%"
              title="AIの予想は正確"
              body="「勝率20%」と出した馬は、実際にもほぼ20%勝つ。AI自体は優秀です。"
            />
            <FactCard
              icon={<TrendingDown className="w-4 h-4" />}
              tone="blue"
              stat="市場も正確"
              title="安い馬がほぼ無い"
              body="オッズ (世間の評価) も同じくらい正確。だから市場が見落とした“お買い得”はほぼ存在しません。"
            />
            <FactCard
              icon={<XCircle className="w-4 h-4" />}
              tone="wine"
              stat="5% → 1.3%"
              title="穴馬は罠"
              body="高オッズの馬は世間が買われすぎ。期待より大きく負けます。穴狙いは特に損。"
            />
          </div>

          {/* このアプリの正しい使い方 */}
          <div className="rounded-[12px] bg-paper-soft/70 border border-line/60 p-4">
            <div className="text-[10px] uppercase tracking-[0.14em] text-ink-muted font-medium mb-2.5">
              だからこのアプリは、こう使うのが正解です
            </div>
            <ul className="space-y-2 text-sm text-ink-soft">
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-deep-green shrink-0 mt-0.5" />
                <span>全レースを予想し、<span className="font-medium text-ink">本当に期待値プラスの稀な場面だけ</span>「買い」と教える</span>
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-deep-green shrink-0 mt-0.5" />
                <span>それ以外は<span className="font-medium text-ink">「見送り」とはっきり言う</span> — 買わない判断が長期で損を抑える</span>
              </li>
              <li className="flex items-start gap-2">
                <XCircle className="w-4 h-4 text-wine shrink-0 mt-0.5" />
                <span>「必ず当たる」「絶対儲かる」とは<span className="font-medium text-ink">絶対に言わない</span></span>
              </li>
            </ul>
          </div>

          {/* 唯一の打ち手 */}
          <div className="flex items-start gap-2.5 text-xs text-ink-muted leading-relaxed">
            <Database className="w-4 h-4 text-ink-faint shrink-0 mt-0.5" />
            <p>
              唯一の打ち手は、学習データを今の約 15 倍 (過去 10 年) に増やすこと。
              取得を自動でリトライ中です。ただし市場が賢いため、データが増えても“勝てる隙間”が見つかる保証はありません。
              <Badge tone="info" size="xs" className="ml-1">取得リトライ中</Badge>
            </p>
          </div>
        </CardBody>
      </Card>
    </section>
  );
}

function FactCard({
  icon, tone, stat, title, body,
}: {
  icon: React.ReactNode;
  tone: "green" | "blue" | "wine";
  stat: string;
  title: string;
  body: string;
}) {
  const toneCls = {
    green: "bg-deep-green-soft/60 text-deep-green border-deep-green/15",
    blue: "bg-ink-blue-soft/50 text-ink-blue border-ink-blue/15",
    wine: "bg-wine-soft/60 text-wine border-wine/15",
  }[tone];
  return (
    <div className="rounded-[12px] border border-line/60 bg-paper p-3.5">
      <div className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${toneCls}`}>
        {icon}
        <span className="tabular">{stat}</span>
      </div>
      <div className="mt-2 text-sm font-semibold text-ink">{title}</div>
      <p className="mt-1 text-xs text-ink-muted leading-relaxed">{body}</p>
    </div>
  );
}

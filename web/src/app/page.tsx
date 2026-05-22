import { Card, CardBody, CardHeader, CardFooter } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StarRating, ratingLabel } from "@/components/ui/StarRating";
import { Badge } from "@/components/ui/Badge";
import { Stat } from "@/components/ui/Stat";
import { Logo } from "@/components/ui/Logo";
import { HorseLoader } from "@/components/ui/HorseLoader";
import { Horseshoe } from "@/components/icons/Horseshoe";
import { RunningHorse } from "@/components/icons/RunningHorse";
import { Trophy } from "@/components/icons/Trophy";

export default function ShowcasePage() {
  return (
    <main className="min-h-screen px-5 py-10 md:py-16">
      <div className="max-w-5xl mx-auto space-y-12">
        {/* Header */}
        <header className="flex items-end justify-between border-b border-line pb-6">
          <Logo size="lg" />
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-[0.16em] text-ink-muted">
              Phase 1 — Design Foundation
            </div>
            <div className="text-xs text-ink-muted mt-1">2026 / Apple x Stripe x 競馬</div>
          </div>
        </header>

        {/* Hero stat */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4 stagger">
          <Card elevated>
            <CardBody>
              <Stat label="累計回収率" value="107.2" unit="%" tone="positive" size="xl" />
              <div className="mt-2 text-xs text-deep-green">+ 7.2% over breakeven</div>
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <Stat label="今日 投資" value="¥3,000" size="lg" sub="本日 3 レース" />
            </CardBody>
          </Card>
          <Card>
            <CardBody>
              <Stat label="今日 回収" value="¥4,820" tone="positive" size="lg" sub="+ ¥1,820" />
            </CardBody>
          </Card>
        </section>

        {/* Star rating showcase */}
        <section>
          <SectionTitle eyebrow="STAR RATING" title="星評価が画面で一番目立つ" />
          <Card>
            <CardBody className="space-y-5">
              {([5, 4, 3, 2, 1] as const).map((r) => (
                <div key={r} className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <StarRating rating={r} size="xl" />
                    <span className="text-sm font-medium">{ratingLabel(r)}</span>
                  </div>
                  <div className="text-xs text-ink-muted">rating {r}</div>
                </div>
              ))}
            </CardBody>
          </Card>
        </section>

        {/* Race cards */}
        <section>
          <SectionTitle eyebrow="RACE CARDS" title="勝負レースカード" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Gold tone */}
            <Card tone="gold" elevated>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <Badge tone="tentative">暫定予想</Badge>
                    <div className="mt-3 text-xs text-ink-muted">東京 11R · 15:40 発走</div>
                    <h3 className="font-display text-2xl font-semibold tracking-tight mt-1">
                      ヴィクトリアマイル
                    </h3>
                  </div>
                  <Horseshoe className="w-7 h-7 text-gold-deep" />
                </div>
              </CardHeader>
              <CardBody className="pt-0">
                <StarRating rating={5} size="lg" />
                <div className="mt-4 grid grid-cols-3 gap-3">
                  <Stat label="期待値" value="1.34" tone="gold" size="md" />
                  <Stat label="信頼度" value="78" unit="%" size="md" />
                  <Stat label="推奨" value="¥1,000" size="md" />
                </div>
                <p className="mt-4 text-sm text-ink-soft leading-relaxed">
                  本命 5番 ナミュール 重賞勝ち実績と東京1600m 適性。前走の0.3秒差は評価できる。
                </p>
              </CardBody>
              <CardFooter className="flex gap-2">
                <Button variant="gold" size="md" className="flex-1">これ買う</Button>
                <Button variant="secondary" size="md">詳細</Button>
              </CardFooter>
            </Card>

            {/* Final tone */}
            <Card tone="final" elevated>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <Badge tone="final">最終確定 · 10分前</Badge>
                    <div className="mt-3 text-xs text-ink-muted">京都 10R · 16:00 発走</div>
                    <h3 className="font-display text-2xl font-semibold tracking-tight mt-1">
                      京都新聞杯
                    </h3>
                  </div>
                </div>
              </CardHeader>
              <CardBody className="pt-0">
                <StarRating rating={4} size="lg" />
                <div className="mt-4 grid grid-cols-3 gap-3">
                  <Stat label="期待値" value="1.18" tone="ink-blue" size="md" />
                  <Stat label="信頼度" value="64" unit="%" size="md" />
                  <Stat label="推奨" value="¥600" size="md" />
                </div>
                <p className="mt-4 text-sm text-ink-soft leading-relaxed">
                  本命 7番 軸 + 1, 4, 9 流し。馬連 3点。前残り想定。
                </p>
              </CardBody>
              <CardFooter className="flex gap-2">
                <Button variant="ruby" size="md" className="flex-1">これ買う</Button>
                <Button variant="secondary" size="md">詳細</Button>
              </CardFooter>
            </Card>
          </div>
        </section>

        {/* Result cards */}
        <section>
          <SectionTitle eyebrow="RESULT STATES" title="結果カード" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card tone="won">
              <CardBody>
                <Badge tone="won">的中</Badge>
                <div className="mt-3 font-display text-xl">中山 12R · ¥1,000 → ¥4,820</div>
                <div className="mt-2 text-sm text-deep-green">+ ¥3,820</div>
              </CardBody>
            </Card>
            <Card tone="lost">
              <CardBody>
                <Badge tone="lost">外れ</Badge>
                <div className="mt-3 font-display text-xl">阪神 11R · ¥600</div>
                <p className="mt-2 text-sm text-ink-soft leading-relaxed">
                  反省: 重馬場適性を軽視。本命5番は良馬場限定の脚質だった。
                </p>
              </CardBody>
            </Card>
          </div>
        </section>

        {/* Buttons */}
        <section>
          <SectionTitle eyebrow="BUTTONS" title="ボタン群" />
          <Card>
            <CardBody className="flex flex-wrap gap-3 items-center">
              <Button variant="primary">これ買う</Button>
              <Button variant="gold">買い目を見る</Button>
              <Button variant="ruby">最終確定</Button>
              <Button variant="secondary">詳細</Button>
              <Button variant="ghost">キャンセル</Button>
              <Button variant="primary" size="lg">主アクション (large)</Button>
              <Button variant="primary" size="sm">小</Button>
              <Button variant="primary" loading>送信中</Button>
            </CardBody>
          </Card>
        </section>

        {/* Loading */}
        <section>
          <SectionTitle eyebrow="LOADING" title="馬が走るローディング" />
          <Card>
            <CardBody>
              <HorseLoader label="予想を計算中..." />
            </CardBody>
          </Card>
        </section>

        {/* Color palette */}
        <section>
          <SectionTitle eyebrow="COLOR PALETTE" title="配色トークン" />
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { name: "canvas",     css: "bg-canvas border border-line",     label: "#FAFAF7" },
              { name: "paper",      css: "bg-paper border border-line",      label: "#FFFFFF" },
              { name: "ink",        css: "bg-ink text-paper",                label: "#1A1A1A" },
              { name: "ink-muted",  css: "bg-ink-muted text-paper",          label: "#6B7280" },
              { name: "line",       css: "bg-line",                           label: "#E8E6DF" },
              { name: "gold",       css: "bg-gold text-ink",                  label: "#D4A85A" },
              { name: "silver",     css: "bg-silver text-paper",              label: "#9CA3AF" },
              { name: "ink-blue",   css: "bg-ink-blue text-paper",            label: "#1E40AF" },
              { name: "ruby",       css: "bg-ruby text-paper",                label: "#9F1239" },
              { name: "deep-green", css: "bg-deep-green text-paper",          label: "#065F46" },
            ].map((c) => (
              <div
                key={c.name}
                className={`${c.css} rounded-[12px] p-4 h-24 flex flex-col justify-between text-xs`}
              >
                <span className="font-mono">{c.name}</span>
                <span className="tabular text-[10px] opacity-80">{c.label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Typography */}
        <section>
          <SectionTitle eyebrow="TYPOGRAPHY" title="タイポグラフィ" />
          <Card>
            <CardBody className="space-y-4">
              <div className="font-display text-5xl font-semibold tracking-tight">
                Display 48 — 勝負レース
              </div>
              <div className="font-display text-3xl font-semibold">Headline 30</div>
              <div className="text-xl">Body large 20</div>
              <div className="text-base text-ink-soft">Body 16 メインで使う本文サイズ</div>
              <div className="text-sm text-ink-muted">Caption 14</div>
              <div className="tabular text-4xl font-display">
                ¥1,234,567 · 107.2% · 1.34
              </div>
              <div className="text-xs text-ink-faint">
                数字は等幅フォント (tabular-nums)。並んだ時にきっちり揃う。
              </div>
            </CardBody>
          </Card>
        </section>

        {/* Icons showcase */}
        <section>
          <SectionTitle eyebrow="ICONS" title="馬モチーフ" />
          <Card>
            <CardBody className="flex items-center gap-8">
              <div className="flex flex-col items-center gap-2">
                <Horseshoe className="w-12 h-12 text-gold-deep" />
                <span className="text-xs text-ink-muted">蹄鉄</span>
              </div>
              <div className="flex flex-col items-center gap-2">
                <RunningHorse className="w-16 h-9 text-ink-soft" />
                <span className="text-xs text-ink-muted">走る馬</span>
              </div>
              <div className="flex flex-col items-center gap-2">
                <Trophy className="w-12 h-12 text-gold-deep" />
                <span className="text-xs text-ink-muted">トロフィー</span>
              </div>
            </CardBody>
          </Card>
        </section>

        <footer className="text-center text-xs text-ink-muted py-8 border-t border-line">
          KEIBA NAVIGATOR · Design Foundation v1 · 2026
        </footer>
      </div>
    </main>
  );
}

function SectionTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="mb-4">
      <div className="text-[10px] uppercase tracking-[0.16em] text-gold-deep font-medium">
        {eyebrow}
      </div>
      <h2 className="mt-1 font-display text-xl font-semibold tracking-tight">{title}</h2>
    </div>
  );
}

import { BlockA } from "@/components/blocks/BlockA";
import { BlockB } from "@/components/blocks/BlockB";
import { BlockC } from "@/components/blocks/BlockC";
import { PerformanceInsights } from "@/components/blocks/PerformanceInsights";
import { CollapsibleSections } from "@/components/blocks/CollapsibleSections";
import { ExperimentLab } from "@/components/blocks/ExperimentLab";
import { HonestStatus } from "@/components/blocks/HonestStatus";
import { RaceCard } from "@/components/blocks/RaceCard";
import { BankrollCard } from "@/components/blocks/BankrollCard";
import { Logo } from "@/components/ui/Logo";
import { Reveal } from "@/components/ui/Reveal";
import { LegendStrip } from "@/components/LegendStrip";
import { NotifyBar } from "@/components/NotifyBar";
import { SwRegister } from "@/components/SwRegister";
import { InstallPrompt } from "@/components/InstallPrompt";
import { LiveDate } from "@/components/LiveDate";
import { HeroBanner } from "@/components/HeroBanner";

export default function Home() {
  return (
    <main className="min-h-screen">
      {/* 最上部の緑の輝線 */}
      <div className="h-[3px] w-full bg-gradient-to-r from-transparent via-deep-green to-transparent opacity-80" />

      <NotifyBar />

      {/* Header */}
      <header className="border-b border-line/70 bg-canvas/75 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-5 py-3.5 flex items-center justify-between">
          <Logo size="md" />
          <div className="flex items-center gap-2 text-xs text-ink-muted tabular">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper-soft/70 px-2.5 py-1">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-deep-green opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-deep-green" />
              </span>
              LIVE
            </span>
            <LiveDate />
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="max-w-4xl mx-auto px-4 md:px-5 py-6 md:py-10 space-y-10">
        <HeroBanner />
        <LegendStrip />
        <BlockA />
        <Reveal><HonestStatus /></Reveal>
        <Reveal><RaceCard /></Reveal>
        <Reveal><BlockB /></Reveal>
        <Reveal><BlockC /></Reveal>
        <Reveal><PerformanceInsights /></Reveal>
        <Reveal><BankrollCard /></Reveal>
        <Reveal><ExperimentLab /></Reveal>
        <Reveal><CollapsibleSections /></Reveal>

        <footer className="text-center text-xs text-ink-muted py-8 border-t border-line/60">
          KEIBA NAVIGATOR · 長期回収率 100% 超えを目指す · 2026
        </footer>
      </div>

      <SwRegister />
      <InstallPrompt />
    </main>
  );
}

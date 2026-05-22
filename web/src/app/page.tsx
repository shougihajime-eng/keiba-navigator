import { BlockA } from "@/components/blocks/BlockA";
import { BlockB } from "@/components/blocks/BlockB";
import { BlockC } from "@/components/blocks/BlockC";
import { CollapsibleSections } from "@/components/blocks/CollapsibleSections";
import { Logo } from "@/components/ui/Logo";
import { NotifyBar } from "@/components/NotifyBar";
import { SwRegister } from "@/components/SwRegister";
import { InstallPrompt } from "@/components/InstallPrompt";

export default function Home() {
  const today = new Date();
  const dateLabel = `${today.getMonth() + 1}月${today.getDate()}日 (${["日","月","火","水","木","金","土"][today.getDay()]})`;

  return (
    <main className="min-h-screen">
      <NotifyBar />

      {/* Header */}
      <header className="border-b border-line/60 bg-paper/70 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-5 py-3.5 flex items-center justify-between">
          <Logo size="md" />
          <div className="text-right text-xs text-ink-muted tabular">
            {dateLabel}
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="max-w-3xl mx-auto px-4 md:px-5 py-6 md:py-10 space-y-10">
        <BlockA />
        <BlockB />
        <BlockC />
        <CollapsibleSections />

        <footer className="text-center text-xs text-ink-muted py-8 border-t border-line/60">
          KEIBA NAVIGATOR · 長期回収率 100% 超えを目指す · 2026
        </footer>
      </div>

      <SwRegister />
      <InstallPrompt />
    </main>
  );
}

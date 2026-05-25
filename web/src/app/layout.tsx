import type { Metadata, Viewport } from "next";
import { Inter, Noto_Sans_JP, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const notoJp = Noto_Sans_JP({
  variable: "--font-noto-jp",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "KEIBA NAVIGATOR",
  description: "長期回収率 100% 超えを目指す競馬予想",
  applicationName: "KEIBA NAVIGATOR",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "KEIBA",
    startupImage: ["/icon-512.svg"],
  },
  icons: {
    icon: [
      { url: "/icon-192.svg", type: "image/svg+xml", sizes: "192x192" },
      { url: "/icon-512.svg", type: "image/svg+xml", sizes: "512x512" },
    ],
    apple: [{ url: "/icon-512.svg", type: "image/svg+xml" }],
    shortcut: ["/icon-192.svg"],
  },
};

export const viewport: Viewport = {
  themeColor: "#080D0A",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  // ピンチ操作での拡大を許可 (文字を大きく見たい人のため・アクセシビリティ)
  maximumScale: 5,
  userScalable: true,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="ja"
      className={`${inter.variable} ${notoJp.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-canvas text-ink font-sans">{children}</body>
    </html>
  );
}

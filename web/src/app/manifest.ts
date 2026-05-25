import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "KEIBA NAVIGATOR",
    short_name: "KEIBA",
    description: "長期回収率 100% 超えを目指す競馬予想 — 暫定→確定の差分検出・10分前通知・反省自動生成",
    start_url: "/",
    display: "standalone",
    background_color: "#080D0A",
    theme_color: "#080D0A",
    orientation: "portrait",
    lang: "ja",
    categories: ["sports", "finance", "productivity"],
    icons: [
      {
        src: "/icon-192.svg",
        sizes: "192x192",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon-512.svg",
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon-maskable.svg",
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}

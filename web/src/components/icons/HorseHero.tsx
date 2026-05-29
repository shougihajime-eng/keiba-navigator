import { SVGProps } from "react";

/**
 * 走る競走馬とジョッキー — カラーのフラットイラスト
 * 緑の勝負服・茶色の馬体・スピード線。ヒーローの主役。
 */
export function HorseHero(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 220 150" fill="none" aria-hidden="true" {...props}>
      <defs>
        <linearGradient id="hh-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#A9703F" />
          <stop offset="100%" stopColor="#7E4F28" />
        </linearGradient>
        <linearGradient id="hh-silk" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2FB56E" />
          <stop offset="100%" stopColor="#0E8C4A" />
        </linearGradient>
        <linearGradient id="hh-turf" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3FBF77" />
          <stop offset="100%" stopColor="#138A47" />
        </linearGradient>
      </defs>

      {/* 地面の影 */}
      <ellipse cx="112" cy="138" rx="74" ry="9" fill="#0E8C4A" opacity="0.16" />

      {/* スピード線 */}
      <g stroke="#7CC8FF" strokeWidth="4" strokeLinecap="round" opacity="0.7">
        <path d="M4 58 H40" />
        <path d="M0 78 H30" />
        <path d="M10 98 H44" />
      </g>
      <g stroke="#FFC24D" strokeWidth="3" strokeLinecap="round" opacity="0.8">
        <path d="M16 48 H38" />
        <path d="M8 110 H34" />
      </g>

      {/* しっぽ */}
      <path d="M44 60 C24 58 18 76 26 96 C34 84 40 80 52 78 Z" fill="#5E3A1C" />

      {/* 後ろ脚 */}
      <path d="M70 92 C66 108 60 120 52 132 L60 134 C70 122 78 110 82 96 Z" fill="url(#hh-body)" />
      <path d="M96 96 C98 112 100 124 100 134 L108 134 C108 122 108 110 106 96 Z" fill="#8A5A30" />

      {/* 馬体 */}
      <path d="M52 70 C60 54 86 48 112 52 C134 55 150 60 166 66 C176 70 180 78 176 86 C168 94 150 98 128 98 C104 98 74 98 60 92 C50 88 48 80 52 70 Z" fill="url(#hh-body)" />

      {/* 前脚 */}
      <path d="M150 92 C156 108 160 122 158 134 L150 134 C148 122 144 110 140 96 Z" fill="url(#hh-body)" />
      <path d="M128 94 C128 110 124 124 120 134 L112 132 C118 120 120 108 120 94 Z" fill="#8A5A30" />

      {/* 首と頭 */}
      <path d="M160 66 C170 54 182 44 196 40 C204 38 210 44 208 52 C206 60 198 66 190 70 L196 80 C198 86 194 92 188 90 C180 88 172 82 166 74 C162 70 160 68 160 66 Z" fill="url(#hh-body)" />
      {/* たてがみ */}
      <path d="M158 60 C166 50 176 44 186 40 C182 48 178 56 176 64 C170 62 164 60 158 60 Z" fill="#5E3A1C" />
      {/* 耳 */}
      <path d="M198 40 L202 30 L206 42 Z" fill="#8A5A30" />
      {/* 目 */}
      <circle cx="198" cy="52" r="2.4" fill="#1B1B1B" />

      {/* ジョッキー — 緑の勝負服 */}
      <path d="M96 44 C100 30 112 26 122 30 C132 34 134 46 128 56 C120 62 108 62 100 56 C96 52 94 48 96 44 Z" fill="url(#hh-silk)" />
      {/* 白い差し色 */}
      <path d="M104 36 C110 32 118 32 124 36 L120 50 C114 52 108 50 104 46 Z" fill="#FFFFFF" opacity="0.85" />
      {/* 腕（前へ） */}
      <path d="M124 46 C140 44 152 50 162 60 L156 66 C148 58 138 54 126 56 Z" fill="url(#hh-silk)" />
      {/* ヘルメット */}
      <path d="M104 30 C108 18 122 16 130 24 C134 28 134 34 130 38 C122 32 112 32 104 36 Z" fill="#15271B" />
      <path d="M128 26 L138 24 L134 32 Z" fill="#FFBC4D" />
      {/* ゴーグル */}
      <rect x="110" y="28" width="14" height="5" rx="2.5" fill="#7CC8FF" />
    </svg>
  );
}

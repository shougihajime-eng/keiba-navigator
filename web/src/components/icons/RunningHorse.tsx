import { SVGProps } from "react";

/** 走る馬のシルエット — モノクロ・上品 */
export function RunningHorse(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 64 36"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M6 28 L10 22 L14 24 L13 28 Z" opacity="0.85" />
      <path d="M50 28 L54 22 L58 24 L57 28 Z" opacity="0.85" />
      <path d="M2 30 L8 22 C10 19 14 16 18 16 L22 12 C24 9 28 8 32 9 L40 7 C44 6 48 7 50 11 L56 14 C60 16 62 19 60 22 L56 24 L52 24 C50 25 47 24 46 22 L42 22 L40 26 L34 27 L32 24 L26 25 L24 28 L18 28 L14 26 L10 28 Z" />
      <path d="M48 9 L52 4 L56 4 L58 8 L54 11" opacity="0.9" />
      <circle cx="56" cy="8" r="0.8" fill="#FAFAF7" />
      <path d="M56 4 C58 2 60 3 60 5" stroke="currentColor" strokeWidth="0.8" fill="none" opacity="0.7" />
    </svg>
  );
}

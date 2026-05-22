import { SVGProps } from "react";

/** 蹄鉄 — 星5レースのバッジに使用。やや太めで質感あり */
export function Horseshoe(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M5 4.6c0 6.4 1.6 11.4 7 11.4s7-5 7-11.4" />
      <path d="M5 4.6c.5-.6 1.3-1 2-1" />
      <path d="M19 4.6c-.5-.6-1.3-1-2-1" />
      <path d="M5.4 8.4l-.7 1.2" />
      <path d="M4.6 11.6l-.4 1.3" />
      <path d="M4.7 15l.5 1.3" />
      <path d="M18.6 8.4l.7 1.2" />
      <path d="M19.4 11.6l.4 1.3" />
      <path d="M19.3 15l-.5 1.3" />
      <path d="M9 18.8h.01" />
      <path d="M15 18.8h.01" />
    </svg>
  );
}

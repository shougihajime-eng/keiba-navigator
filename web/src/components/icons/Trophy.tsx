import { SVGProps } from "react";

export function Trophy(props: SVGProps<SVGSVGElement>) {
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
      <path d="M7 4h10v4a5 5 0 0 1-10 0V4Z" />
      <path d="M17 6h2a2 2 0 0 1 2 2v0a3 3 0 0 1-3 3" />
      <path d="M7 6H5a2 2 0 0 0-2 2v0a3 3 0 0 0 3 3" />
      <path d="M10 13h4l-1 4h-2l-1-4Z" />
      <path d="M9 17h6" />
      <path d="M10 20h4" />
    </svg>
  );
}

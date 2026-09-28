import React, { useId } from "react";

// 앱 아이콘과 같은 육각 군집 로고. 기존 로고 칸(.brand span, .brand-mark)을 가득 채우고 칸의 연두 배경은 끈다.
export function BrandMark(): React.ReactElement {
  const gradientId = `brand-bg-${useId().replace(/:/g, "")}`;
  return <svg viewBox="18 18 72 72" width="100%" height="100%" role="img" aria-label="web-agent-manager" style={{ display: "block" }}>
    <defs><linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#111827" /><stop offset="1" stopColor="#312E81" /></linearGradient></defs>
    <rect x="18" y="18" width="72" height="72" rx="20" fill={`url(#${gradientId})`} />
    <path fill="#B8FF63" d="M54,30l12,7v14l-12,7l-12,-7v-14z" />
    <path fill="#7C6FF2" d="M40.5,54l12,7v14l-12,7l-12,-7v-14z" />
    <path fill="#A89CFF" d="M67.5,54l12,7v14l-12,7l-12,-7v-14z" />
  </svg>;
}

// 로고 칸의 CSS 연두 배경·그림자를 SVG 로고에 맞게 덮어쓰는 인라인 스타일.
export const brandMarkSlotStyle: React.CSSProperties = { background: "none", boxShadow: "0 6px 18px rgba(124, 111, 242, .25)", overflow: "hidden" };

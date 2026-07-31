import React from "react";
import { LoaderCircle } from "lucide-react";

// 서버 응답을 기다리는 화면 영역에 공통 스피너와 상태 문구를 표시한다.
export function LoadingState({ label }: { label: string }): React.ReactElement {
  return <div className="resource-loading" role="status" aria-live="polite">
    <LoaderCircle className="spin" size={20} aria-hidden="true" />
    <span>{label}</span>
  </div>;
}

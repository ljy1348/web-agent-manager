import { useCallback, useEffect, useRef } from "react";

const DIALOG_STATE_KEY = "webAgentManagerDialog";
let dialogSequence = 0;

export type DialogDismiss = (afterClose?: () => void) => void;

// 열린 모달을 history에 쌓고 뒤로가기나 명시적 닫기를 같은 경로로 처리한다.
export function useDialogHistory(open: boolean, onClose: () => void, dialogId: string): DialogDismiss {
  const markerRef = useRef<string | null>(null);
  const onCloseRef = useRef(onClose);
  const afterCloseRef = useRef<(() => void) | null>(null);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    let marker = markerRef.current;
    if (!marker || window.history.state?.[DIALOG_STATE_KEY] !== marker) {
      marker = `${dialogId}:${++dialogSequence}`;
      markerRef.current = marker;
      window.history.pushState({ ...window.history.state, [DIALOG_STATE_KEY]: marker }, "", window.location.href);
    }

    // 목적지 history가 현재 marker가 아니면 최상위 모달이 빠진 것이다.
    function handlePopState(event: PopStateEvent): void {
      if (markerRef.current !== marker || event.state?.[DIALOG_STATE_KEY] === marker) return;
      markerRef.current = null;
      onCloseRef.current();
      const afterClose = afterCloseRef.current;
      afterCloseRef.current = null;
      afterClose?.();
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [dialogId, open]);

  return useCallback((afterClose?: () => void) => {
    const marker = markerRef.current;
    if (marker && window.history.state?.[DIALOG_STATE_KEY] === marker) {
      afterCloseRef.current = afterClose ?? null;
      window.history.back();
      return;
    }
    markerRef.current = null;
    onCloseRef.current();
    afterClose?.();
  }, []);
}

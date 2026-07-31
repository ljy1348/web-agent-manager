import React, { useState } from "react";
import { approvalActions, approvalSummary, askUserQuestionPayload } from "../lib/approvals";
import type { Json } from "../types";

// 승인 요청 하나를 표시한다. "닫기"는 웹 목록에서만 정리하는 안전한 동작이다 — AI가 이 요청에 대한
// 응답을 아직 실제로 기다리고 있으면 서버가 에러를 던지고 실패하며, 그 경우엔 실제 답변/거부로만 끝낼
// 수 있다(살아있는 작업을 조용히 끊어버리지 않기 위함). AskUserQuestion 도구 호출은 "실행 허용"이
// 아니라 실제 사용자 답변이 필요하므로 질문·선택지를 그대로 보여주고, 고른 답을 decline의 message로
// 실어 보내 터미널 조작 없이 웹에서 바로 답변을 완료시킨다.
export function ApprovalCard({ item, decide }: { item: Json; decide: (id: string, decision: string, answer?: string) => Promise<void> }): React.ReactElement {
  const questions = askUserQuestionPayload(item);
  const [selections, setSelections] = useState<Record<number, string>>({});
  const [customText, setCustomText] = useState("");
  const [error, setError] = useState("");

  const dismiss = (): void => {
    setError("");
    void decide(item.id, "dismiss").catch((caught: any) => setError(caught?.message || "닫지 못했습니다."));
  };

  if (questions) {
    const allAnswered = questions.every((_, index) => selections[index]);
    const canSubmit = allAnswered || customText.trim().length > 0;
    const submit = (): void => {
      setError("");
      const lines = questions.map((question, index) => selections[index] ? `${question.question}\n→ ${selections[index]}` : null).filter(Boolean);
      if (customText.trim()) lines.push(`추가 의견: ${customText.trim()}`);
      void decide(item.id, "decline", lines.join("\n\n")).catch((caught: any) => setError(caught?.message || "답변을 보내지 못했습니다."));
    };
    return <article className="approval approval-question">
      <b>{item.provider} · 질문{questions.length > 1 ? ` (${questions.length}개)` : ""}</b>
      {questions.map((question, index) => <div className="approval-question-block" key={index}>
        <p className="approval-question-text">{question.header ? `[${question.header}] ` : ""}{question.question}</p>
        <div className="approval-question-options">{question.options.map((option) => <button type="button" key={option.label} className={selections[index] === option.label ? "primary" : ""} title={option.description} onClick={() => setSelections((current) => ({ ...current, [index]: option.label }))}>{option.label}</button>)}</div>
      </div>)}
      <input value={customText} onChange={(event) => setCustomText(event.target.value)} placeholder="직접 입력(선택지에 없는 답변이나 추가 의견 — 그냥 넘어가려면 '스킵'처럼 적어서 보내면 된다)" />
      {error && <p className="approval-error">{error}</p>}
      <div className="approval-question-buttons">
        <button type="button" className="primary" onClick={submit} disabled={!canSubmit}>답변 전송</button>
        <button type="button" onClick={dismiss} title="AI가 아직 실제로 기다리고 있으면 실패합니다(웹 목록에서만 정리, 작업엔 영향 없음)">닫기</button>
      </div>
    </article>;
  }

  return <article className="approval">
    <b>{item.provider}</b>
    <pre>{approvalSummary(item)}</pre>
    {error && <p className="approval-error">{error}</p>}
    <div>
      {approvalActions(item).map((action) => <button key={action.decision} className={action.className} onClick={() => { setError(""); void decide(item.id, action.decision).catch((caught: any) => setError(caught?.message || "처리하지 못했습니다.")); }}>{action.label}</button>)}
      <button type="button" onClick={dismiss} title="AI가 아직 실제로 기다리고 있으면 실패합니다(웹 목록에서만 정리, 작업엔 영향 없음)">닫기</button>
    </div>
  </article>;
}

interface DisplayMessage {
  role?: string;
  kind?: string;
  content?: string;
}

// 이전 페이지(과거)와 새 페이지(최신 재조회)를 id 기준 중복 제거 후 시간순으로 합친다.
export function mergeMessages(...batches: Array<Array<Record<string, any>>>): Array<Record<string, any>> {
  const byId = new Map<string, Record<string, any>>();
  for (const batch of batches) for (const message of batch) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
}

// 새로 기록된 실제 user 메시지와 일치하는 낙관적 메시지만 하나씩 확정해 나머지 큐 입력을 보존한다.
export function reconcileOptimisticMessages(
  current: Array<Record<string, any>>,
  incoming: Array<Record<string, any>>,
): Array<Record<string, any>> {
  const knownIds = new Set(current.filter((item) => !item.optimistic).map((item) => item.id));
  const newlyRecordedUserContents = incoming
    .filter((item) => item.role === "user" && !knownIds.has(item.id))
    .map((item) => String(item.content ?? ""));
  const pending = current.filter((item) => {
    if (!item.optimistic) return true;
    const match = newlyRecordedUserContents.indexOf(String(item.content ?? ""));
    if (match < 0) return true;
    newlyRecordedUserContents.splice(match, 1);
    return false;
  });
  return mergeMessages(pending, incoming);
}

export interface MessageDisplay {
  primary: string;
  details: string[];
  detailLabel: string;
}

const TOOL_MARKER = /(?:^|\n)\[(?:도구(?::[^\]]+)?|도구 결과)\]/m;
const FENCED_CHANGE = /```(?:diff|patch)\s*\n[\s\S]*?```/gi;
const RAW_CHANGE = /(?:^|\n)(?:diff --git |--- a\/|\*\*\* Begin Patch)/m;

// 메시지 본문과 기본 접힘 상태로 표시할 도구·변경 상세를 분리한다.
export function splitMessageContent(message: DisplayMessage): MessageDisplay {
  const content = String(message.content ?? "").trim();
  const kind = String(message.kind ?? "");
  const detailOnly = message.role === "tool" || message.role === "system";
  if (detailOnly) {
    const detailLabel = kind === "project_instructions" ? "프로젝트 지침 보기" : kind === "local_command" ? "로컬 명령 실행 보기" : kind === "task_notification" ? "백그라운드 작업 알림 보기" : kind === "compact_summary" ? "컨텍스트 요약 보기(자동 생성, 실제 발화 아님)" : message.role === "system" ? "시스템 정보 보기" : "도구 실행 내용 보기";
    return { primary: "", details: content ? [content] : [], detailLabel };
  }

  const details: string[] = [];
  let primary = content;
  primary = primary.replace(FENCED_CHANGE, (block) => {
    details.push(block.trim());
    return "";
  });

  const toolIndex = primary.search(TOOL_MARKER);
  if (toolIndex >= 0) {
    details.push(primary.slice(toolIndex).trim());
    primary = primary.slice(0, toolIndex).trim();
  }

  const rawChangeIndex = primary.search(RAW_CHANGE);
  if (rawChangeIndex >= 0) {
    details.push(primary.slice(rawChangeIndex).trim());
    primary = primary.slice(0, rawChangeIndex).trim();
  }

  const detailText = `${kind}\n${details.join("\n")}`;
  const detailLabel = /(?:diff|patch|변경|Begin Patch)/i.test(detailText) ? "변경사항 보기" : "도구 실행 내용 보기";
  return { primary: primary.trim(), details, detailLabel };
}

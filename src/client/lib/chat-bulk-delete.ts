export interface ChatBulkDeleteFailure {
  id: number;
  message: string;
}

export interface ChatBulkDeleteResult {
  deletedIds: number[];
  failures: ChatBulkDeleteFailure[];
}

// 같은 작업공간을 공유하는 채팅을 병렬로 지우면 마지막 채팅 판정과 worktree 정리가 경합할 수 있다.
// 기존 단건 API를 선택 순서대로 호출하고, 한 건이 실패해도 나머지는 계속 처리해 결과를 개별 집계한다.
export async function deleteChatsSequentially(
  chatIds: number[],
  backup: boolean,
  deleteChat: (id: number, backup: boolean) => Promise<unknown>,
): Promise<ChatBulkDeleteResult> {
  const deletedIds: number[] = [];
  const failures: ChatBulkDeleteFailure[] = [];
  for (const id of [...new Set(chatIds)]) {
    try {
      await deleteChat(id, backup);
      deletedIds.push(id);
    } catch (error) {
      failures.push({ id, message: error instanceof Error ? error.message : "삭제에 실패했습니다." });
    }
  }
  return { deletedIds, failures };
}

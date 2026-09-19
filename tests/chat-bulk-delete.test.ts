import { describe, expect, it, vi } from "vitest";
import { deleteChatsSequentially } from "../src/client/lib/chat-bulk-delete";

describe("채팅 다중 삭제", () => {
  it("중복 ID를 제거하고 선택 순서대로 백업 후 삭제한다", async () => {
    const order: number[] = [];
    const deleteChat = vi.fn(async (id: number, backup: boolean) => {
      expect(backup).toBe(true);
      order.push(id);
    });

    const result = await deleteChatsSequentially([3, 1, 3, 2], true, deleteChat);

    expect(order).toEqual([3, 1, 2]);
    expect(result).toEqual({ deletedIds: [3, 1, 2], failures: [] });
  });

  it("일부 삭제가 실패해도 나머지를 계속하고 실패 ID와 이유를 보존한다", async () => {
    const deleteChat = vi.fn(async (id: number, backup: boolean) => {
      expect(backup).toBe(false);
      if (id === 2) throw new Error("작업공간에 커밋하지 않은 변경이 있습니다.");
    });

    const result = await deleteChatsSequentially([1, 2, 3], false, deleteChat);

    expect(deleteChat.mock.calls.map(([id]) => id)).toEqual([1, 2, 3]);
    expect(result).toEqual({
      deletedIds: [1, 3],
      failures: [{ id: 2, message: "작업공간에 커밋하지 않은 변경이 있습니다." }],
    });
  });
});

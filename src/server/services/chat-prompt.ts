import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveProjectPath, writeFileAtomic } from "../routes/helpers";
import { LONG_PROMPT_CHARACTER_THRESHOLD, promptCharacterCount } from "../../shared/chat-prompt";

const ATTACHMENTS_DIRNAME = ".web-agent-manager-uploads";

export interface PreparedChatPrompt {
  terminalText: string;
  attachmentPath: string | null;
  cleanup(): void;
}

// 장문 일반 메시지를 프로젝트와 채팅 작업공간의 텍스트 첨부로 저장하고 짧은 참조문을 만든다.
export function prepareChatPrompt(chatId: number, projectPath: string, workspacePath: string, text: string): PreparedChatPrompt {
  const command = text.trimStart();
  if (promptCharacterCount(text) <= LONG_PROMPT_CHARACTER_THRESHOLD || command.startsWith("/") || command.startsWith("!")) {
    return { terminalText: text, attachmentPath: null, cleanup: () => undefined };
  }

  const relativeDir = path.join(ATTACHMENTS_DIRNAME, String(chatId));
  const filename = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}_pasted-text.txt`;
  const relativePath = path.join(relativeDir, filename);
  const storedTargets: string[] = [];
  const seenRoots = new Set<string>();
  try {
    for (const root of [projectPath, workspacePath]) {
      const actualRoot = fs.realpathSync(root);
      if (seenRoots.has(actualRoot)) continue;
      seenRoots.add(actualRoot);
      const directory = resolveProjectPath(actualRoot, relativeDir, false);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const target = resolveProjectPath(actualRoot, relativePath, false);
      writeFileAtomic(target, text);
      storedTargets.push(target);
    }
  } catch (error) {
    for (const target of storedTargets) fs.rmSync(target, { force: true });
    throw error;
  }
  const attachmentPath = relativePath.split(path.sep).join("/");
  return {
    terminalText: `긴 메시지 원문을 다음 첨부 파일에 저장했습니다. 파일 전체를 읽고 그 내용을 사용자 요청으로 처리해주세요.\n[첨부: ${attachmentPath}]`,
    attachmentPath,
    cleanup: () => {
      for (const target of storedTargets) fs.rmSync(target, { force: true });
    },
  };
}

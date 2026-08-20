export const LONG_PROMPT_CHARACTER_THRESHOLD = 1_000;

// 유니코드 코드 포인트 기준으로 채팅 프롬프트 길이를 계산한다.
export function promptCharacterCount(text: string): number {
  let count = 0;
  for (const _character of text) count += 1;
  return count;
}

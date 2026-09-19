// 키 입력은 수행했지만 공급자 제출 ACK를 증명하지 못한 경우다. 일반 오류와 달리 자동 재전송하면
// 중복 실행 위험이 있으므로 원장에 delivery_unknown으로 보존해야 한다.
export class PromptDeliveryUnknownError extends Error {
  readonly code = "PROMPT_DELIVERY_UNKNOWN";

  constructor(message: string, readonly deliveryContentHash?: string) {
    super(message);
    this.name = "PromptDeliveryUnknownError";
  }
}

// 운영 알림을 보낼 수 있는 채널의 공통 계약(Slack, ntfy 등). 이벤트 ID 기준 중복 전송 방지는
// 각 채널 구현체가 알아서 책임진다(채널마다 전송 성공/실패가 다를 수 있어 공유하지 않는다).
export interface Notifier {
  notify(eventId: string, eventType: string, text: string): Promise<void>;
}

// 등록된 모든 채널에 동시에 알림을 보낸다. 한 채널이 실패해도(설정 안 됨, 네트워크 오류 등)
// 다른 채널 전송에는 영향을 주지 않는다.
export class NotificationHub implements Notifier {
  constructor(private readonly channels: Notifier[]) {}

  async notify(eventId: string, eventType: string, text: string): Promise<void> {
    await Promise.all(this.channels.map((channel) => channel.notify(eventId, eventType, text).catch(() => undefined)));
  }
}

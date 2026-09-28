import { api } from "../api";

// Android 앱 WebView에만 주입되는 지문 서명 브리지(BiometricBridge.java).
interface BiometricBridge {
  isAvailable(): boolean;
  prepareEnrollment(challenge: string, callbackId: string): void;
  signReauth(challenge: string, callbackId: string): void;
  removeKey(): void;
}

type BridgeResult = { ok: true; publicKey?: string; signature: string } | { ok: false; code: string; message: string };

// 앱 브리지 실패를 코드와 함께 전달해 무효화·취소를 화면에서 구분하게 한다.
export class BiometricError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "BiometricError";
  }
}

declare global {
  interface Window {
    WamAndroidBiometric?: BiometricBridge;
    __wamBiometricCallback?: (id: string, result: BridgeResult) => void;
  }
}

const pending = new Map<string, (result: BridgeResult) => void>();
let sequence = 0;

// 앱 안이고 강한 생체인증을 쓸 수 있을 때만 브리지를 돌려준다.
export function biometricBridge(): BiometricBridge | null {
  const bridge = typeof window === "undefined" ? undefined : window.WamAndroidBiometric;
  try {
    return bridge && bridge.isAvailable() ? bridge : null;
  } catch {
    return null;
  }
}

// 브리지의 비동기 콜백을 Promise로 바꾼다.
function callBridge(invoke: (bridge: BiometricBridge, callbackId: string) => void): Promise<{ publicKey?: string; signature: string }> {
  const bridge = biometricBridge();
  if (!bridge) return Promise.reject(new BiometricError("이 기기에서는 지문 본인 확인을 쓸 수 없습니다.", "unavailable"));
  window.__wamBiometricCallback ??= (id, result) => {
    const resolve = pending.get(id);
    pending.delete(id);
    resolve?.(result);
  };
  const callbackId = `bio-${++sequence}`;
  return new Promise((resolve, reject) => {
    pending.set(callbackId, (result) => result.ok ? resolve(result) : reject(new BiometricError(result.message, result.code)));
    invoke(bridge, callbackId);
  });
}

// 현재 세션의 지문 사용 가능 상태. 기기 서명으로 묶인 세션(deviceBound)만 등록할 수 있다.
export async function biometricStatus(): Promise<{ deviceBound: boolean; enrolled: boolean } | null> {
  if (!biometricBridge()) return null;
  try {
    return await api("/mobile/biometric");
  } catch {
    return null;
  }
}

// 지문으로 서버 challenge를 서명해 최근 본인 확인을 갱신한다.
export async function reauthenticateWithBiometric(): Promise<void> {
  const { challenge } = await api("/mobile/biometric/reauth/challenge", { method: "POST" });
  const { signature } = await callBridge((bridge, id) => bridge.signReauth(challenge, id));
  await api("/mobile/biometric/reauth", { method: "POST", body: JSON.stringify({ challenge, signature }) });
}

// 이 기기의 지문 키를 만들어 서버에 등록한다. 최근 본인 확인이 없으면 api()가 안내창을 먼저 띄운다.
export async function enrollBiometric(): Promise<void> {
  const { challenge } = await api("/mobile/biometric/enroll/challenge", { method: "POST" });
  const { publicKey, signature } = await callBridge((bridge, id) => bridge.prepareEnrollment(challenge, id));
  await api("/mobile/biometric/enroll", { method: "POST", body: JSON.stringify({ challenge, publicKey, signature }) });
}

// 서버 등록과 기기의 지문 키를 함께 지운다.
export async function removeBiometric(): Promise<void> {
  await api("/mobile/biometric", { method: "DELETE" });
  try { biometricBridge()?.removeKey(); } catch { /* 서버 등록이 지워졌으면 남은 키는 쓰이지 않는다. */ }
}

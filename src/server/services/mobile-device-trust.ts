import crypto, { type KeyObject } from "node:crypto";
import type { AppDatabase } from "../core/database";
import { createToken, hashToken, timingSafeEqualString } from "../core/security";

const CHALLENGE_TTL_SECONDS = 120;

export interface MobileTrustDeviceStatus {
  enrolled: boolean;
  sessionTrusted: boolean;
}

export interface ResolvedMobileTrustDevice extends MobileTrustDeviceStatus {
  deviceId: string | null;
}

export interface MobileBiometricStatus {
  deviceBound: boolean;
  enrolled: boolean;
}

export type MobileBiometricPurpose = "enroll" | "reauth";

export interface MobileTrustLoginIdentity {
  deviceId: string;
  userId: number;
}

// Android Keystore 공개키를 검증하고 현재 웹 세션의 기기 서명 신뢰를 관리한다.
export class MobileDeviceTrustService {
  constructor(private readonly database: AppDatabase) {}

  // 내부망에서 검증한 P-256 공개키를 관리자 계정의 활성 기기로 등록한다.
  enroll(userId: number, publicKey: string, label?: string): { deviceId: string } {
    const key = parseDevicePublicKey(publicKey);
    const canonicalKey = key.export({ format: "der", type: "spki" }).toString("base64");
    const fingerprint = publicKeyFingerprint(canonicalKey);
    const safeLabel = typeof label === "string" ? label.trim().slice(0, 120) : "";
    const existing = this.database.prepare(`
      SELECT id FROM mobile_trusted_devices WHERE user_id = ? AND key_fingerprint = ?
    `).get(userId, fingerprint) as { id: string } | undefined;
    const deviceId = existing?.id ?? crypto.randomUUID();
    if (existing) {
      this.database.prepare(`
        UPDATE mobile_trusted_devices
        SET public_key = ?, label = ?, active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).run(canonicalKey, safeLabel || null, deviceId, userId);
    } else {
      this.database.prepare(`
        INSERT INTO mobile_trusted_devices(id, user_id, public_key, key_fingerprint, label)
        VALUES (?, ?, ?, ?, ?)
      `).run(deviceId, userId, canonicalKey, fingerprint, safeLabel || null);
    }
    return { deviceId };
  }

  // 현재 사용자에게 등록된 기기와 이 웹 세션의 인증 상태만 반환한다.
  status(userId: number, sessionId: number, deviceId: string): MobileTrustDeviceStatus {
    const enrolled = Boolean(this.findDevice(userId, deviceId));
    const trusted = this.database.prepare(`
      SELECT 1 FROM web_sessions
      WHERE id = ? AND user_id = ? AND mobile_trusted_device_id = ? AND expires_at > datetime('now')
    `).get(sessionId, userId, deviceId);
    return { enrolled, sessionTrusted: enrolled && Boolean(trusted) };
  }

  // 같은 관리자에게 등록된 공개키 지문으로 현재 접속 주소와 무관한 기기 ID를 다시 찾는다.
  resolve(userId: number, sessionId: number, publicKey: string): ResolvedMobileTrustDevice {
    const key = parseDevicePublicKey(publicKey);
    const canonicalKey = key.export({ format: "der", type: "spki" }).toString("base64");
    const row = this.database.prepare(`
      SELECT id FROM mobile_trusted_devices
      WHERE user_id = ? AND key_fingerprint = ? AND active = 1
    `).get(userId, publicKeyFingerprint(canonicalKey)) as { id: string } | undefined;
    if (!row) return { deviceId: null, enrolled: false, sessionTrusted: false };
    return { deviceId: row.id, ...this.status(userId, sessionId, row.id) };
  }

  // 로그인 쿠키가 없는 새 origin에 등록 기기용 2분짜리 1회성 challenge를 발급한다.
  createLoginChallenge(deviceId: string, publicKey: string, origin: string): string {
    if (!deviceId || deviceId.length > 80) throw new Error("등록된 앱 기기를 찾을 수 없습니다.");
    if (!origin || origin.length > 512) throw new Error("앱 기기 로그인 origin이 올바르지 않습니다.");
    const key = parseDevicePublicKey(publicKey);
    const canonicalKey = key.export({ format: "der", type: "spki" }).toString("base64");
    const row = this.database.prepare(`
      SELECT d.id FROM mobile_trusted_devices d
      JOIN users u ON u.id = d.user_id AND u.role = 'admin'
      WHERE d.id = ? AND d.key_fingerprint = ? AND d.active = 1
    `).get(deviceId, publicKeyFingerprint(canonicalKey));
    if (!row) throw new Error("등록된 앱 기기를 찾을 수 없습니다.");
    const challenge = createToken(32);
    this.database.prepare(`
      INSERT INTO mobile_trust_login_challenges(device_id, challenge_hash, origin, expires_at)
      VALUES (?, ?, ?, datetime('now', ?))
      ON CONFLICT(device_id) DO UPDATE SET
        challenge_hash = excluded.challenge_hash,
        origin = excluded.origin,
        expires_at = excluded.expires_at,
        created_at = CURRENT_TIMESTAMP
    `).run(deviceId, hashToken(challenge), origin, `+${CHALLENGE_TTL_SECONDS} seconds`);
    return challenge;
  }

  // 유효한 기기 서명 challenge를 한 번 소비하고 새 세션을 만들 관리자·기기 관계를 반환한다.
  consumeLoginChallenge(deviceId: string, challenge: string, signature: string): MobileTrustLoginIdentity | null {
    if (!deviceId || deviceId.length > 80 || !challenge || challenge.length > 256 || !signature || signature.length > 1024) return null;
    const row = this.database.prepare(`
      SELECT c.challenge_hash, c.origin, d.public_key, d.user_id
      FROM mobile_trust_login_challenges c
      JOIN mobile_trusted_devices d ON d.id = c.device_id AND d.active = 1
      JOIN users u ON u.id = d.user_id AND u.role = 'admin'
      WHERE c.device_id = ? AND c.expires_at > datetime('now')
    `).get(deviceId) as { challenge_hash: string; origin: string; public_key: string; user_id: number } | undefined;
    if (!row || !timingSafeEqualString(hashToken(challenge), row.challenge_hash)) return null;
    let verified = false;
    try {
      verified = crypto.verify("sha256", Buffer.from(loginSignaturePayload(row.origin, challenge), "utf8"), parseDevicePublicKey(row.public_key), Buffer.from(signature, "base64"));
    } catch {
      verified = false;
    }
    if (!verified) return null;
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM mobile_trust_login_challenges WHERE device_id = ?").run(deviceId);
      this.database.prepare(`
        UPDATE mobile_trusted_devices SET last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(deviceId);
    })();
    return { deviceId, userId: row.user_id };
  }

  // 등록 기기와 현재 웹 세션을 묶은 짧은 1회성 서명 challenge를 발급한다.
  createChallenge(userId: number, sessionId: number, deviceId: string): string {
    if (!this.findDevice(userId, deviceId)) throw new Error("등록된 앱 기기를 찾을 수 없습니다.");
    const challenge = createToken(32);
    this.database.prepare(`
      INSERT INTO mobile_trust_challenges(web_session_id, device_id, challenge_hash, expires_at)
      VALUES (?, ?, ?, datetime('now', ?))
      ON CONFLICT(web_session_id) DO UPDATE SET
        device_id = excluded.device_id,
        challenge_hash = excluded.challenge_hash,
        expires_at = excluded.expires_at,
        created_at = CURRENT_TIMESTAMP
    `).run(sessionId, deviceId, hashToken(challenge), `+${CHALLENGE_TTL_SECONDS} seconds`);
    return challenge;
  }

  // P-256 서명이 유효한 경우 challenge를 폐기하고 현재 웹 세션만 앱 신뢰 상태로 승격한다.
  activate(userId: number, sessionId: number, deviceId: string, challenge: string, signature: string): boolean {
    if (!challenge || challenge.length > 256 || !signature || signature.length > 1024) return false;
    const row = this.database.prepare(`
      SELECT c.challenge_hash, d.public_key
      FROM mobile_trust_challenges c
      JOIN mobile_trusted_devices d ON d.id = c.device_id AND d.active = 1
      WHERE c.web_session_id = ? AND c.device_id = ? AND d.user_id = ?
        AND c.expires_at > datetime('now')
    `).get(sessionId, deviceId, userId) as { challenge_hash: string; public_key: string } | undefined;
    if (!row || !timingSafeEqualString(hashToken(challenge), row.challenge_hash)) return false;
    let verified = false;
    try {
      verified = crypto.verify(
        "sha256",
        Buffer.from(challenge, "utf8"),
        parseDevicePublicKey(row.public_key),
        Buffer.from(signature, "base64"),
      );
    } catch {
      verified = false;
    }
    if (!verified) return false;
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM mobile_trust_challenges WHERE web_session_id = ?").run(sessionId);
      this.database.prepare(`
        UPDATE web_sessions SET mobile_trusted_device_id = ? WHERE id = ? AND user_id = ?
      `).run(deviceId, sessionId, userId);
      this.database.prepare(`
        UPDATE mobile_trusted_devices SET last_used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(deviceId);
    })();
    return true;
  }

  // 사용자 소유 기기를 비활성화하고 그 기기로 승격된 모든 웹 세션 신뢰를 즉시 회수한다.
  revoke(userId: number, deviceId: string): boolean {
    if (!this.findDevice(userId, deviceId)) return false;
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM mobile_trust_challenges WHERE device_id = ?").run(deviceId);
      this.database.prepare("DELETE FROM mobile_trust_login_challenges WHERE device_id = ?").run(deviceId);
      this.database.prepare("DELETE FROM mobile_biometric_challenges WHERE device_id = ?").run(deviceId);
      this.database.prepare("UPDATE web_sessions SET mobile_trusted_device_id = NULL WHERE user_id = ? AND mobile_trusted_device_id = ?").run(userId, deviceId);
      // 재등록 시 예전 지문 키가 되살아나지 않도록 해제와 함께 지운다.
      this.database.prepare("UPDATE mobile_trusted_devices SET active = 0, biometric_public_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").run(deviceId, userId);
    })();
    return true;
  }

  // 현재 웹 세션이 기기 서명으로 묶인 활성 기기인지와 지문 키 등록 여부를 반환한다.
  biometricStatus(userId: number, sessionId: number): MobileBiometricStatus {
    const device = this.sessionDevice(userId, sessionId);
    return { deviceBound: Boolean(device), enrolled: Boolean(device?.biometric_public_key) };
  }

  // 세션에 묶인 기기용 지문 등록·본인 확인 1회성 challenge를 발급한다.
  createBiometricChallenge(userId: number, sessionId: number, purpose: MobileBiometricPurpose): string {
    const device = this.sessionDevice(userId, sessionId);
    if (!device) throw new Error("앱 기기 인증으로 연결된 세션에서만 지문을 사용할 수 있습니다.");
    if (purpose === "reauth" && !device.biometric_public_key) throw new Error("이 기기에 지문 본인 확인이 등록되어 있지 않습니다.");
    const challenge = createToken(32);
    this.database.prepare(`
      INSERT INTO mobile_biometric_challenges(web_session_id, device_id, purpose, challenge_hash, expires_at)
      VALUES (?, ?, ?, ?, datetime('now', ?))
      ON CONFLICT(web_session_id) DO UPDATE SET
        device_id = excluded.device_id,
        purpose = excluded.purpose,
        challenge_hash = excluded.challenge_hash,
        expires_at = excluded.expires_at,
        created_at = CURRENT_TIMESTAMP
    `).run(sessionId, device.id, purpose, hashToken(challenge), `+${CHALLENGE_TTL_SECONDS} seconds`);
    return challenge;
  }

  // 기존 기기 키가 서명한 지문 공개키를 검증해 이 기기의 지문 본인 확인 키로 저장한다.
  enrollBiometric(userId: number, sessionId: number, biometricPublicKey: string, challenge: string, signature: string): boolean {
    let canonicalKey: string;
    try {
      canonicalKey = parseDevicePublicKey(biometricPublicKey).export({ format: "der", type: "spki" }).toString("base64");
    } catch {
      return false;
    }
    const device = this.consumeBiometricChallenge(userId, sessionId, "enroll", challenge);
    if (!device || !verifySignature(device.public_key, biometricEnrollPayload(challenge, biometricPublicKey), signature)) return false;
    this.database.prepare(`
      UPDATE mobile_trusted_devices SET biometric_public_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?
    `).run(canonicalKey, device.id, userId);
    return true;
  }

  // 지문 키 서명을 검증하면 현재 웹 세션의 최근 본인 확인 시각을 갱신한다.
  verifyBiometricReauth(userId: number, sessionId: number, challenge: string, signature: string): boolean {
    const device = this.consumeBiometricChallenge(userId, sessionId, "reauth", challenge);
    if (!device?.biometric_public_key || !verifySignature(device.biometric_public_key, biometricReauthPayload(challenge), signature)) return false;
    this.database.transaction(() => {
      this.database.prepare("UPDATE web_sessions SET reauthenticated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").run(sessionId, userId);
      this.database.prepare("UPDATE mobile_trusted_devices SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?").run(device.id);
    })();
    return true;
  }

  // 세션에 묶인 기기의 지문 키를 지운다.
  removeBiometric(userId: number, sessionId: number): boolean {
    const device = this.sessionDevice(userId, sessionId);
    if (!device?.biometric_public_key) return false;
    this.database.prepare("UPDATE mobile_trusted_devices SET biometric_public_key = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").run(device.id, userId);
    return true;
  }

  // 용도가 일치하는 유효 challenge를 서명 검증 전에 먼저 폐기해 실패 시에도 재사용하지 못하게 한다.
  private consumeBiometricChallenge(userId: number, sessionId: number, purpose: MobileBiometricPurpose, challenge: string): SessionDevice | undefined {
    if (!challenge || challenge.length > 256) return undefined;
    const row = this.database.prepare(`
      SELECT challenge_hash, device_id FROM mobile_biometric_challenges
      WHERE web_session_id = ? AND purpose = ? AND expires_at > datetime('now')
    `).get(sessionId, purpose) as { challenge_hash: string; device_id: string } | undefined;
    if (!row || !timingSafeEqualString(hashToken(challenge), row.challenge_hash)) return undefined;
    this.database.prepare("DELETE FROM mobile_biometric_challenges WHERE web_session_id = ?").run(sessionId);
    const device = this.sessionDevice(userId, sessionId);
    return device?.id === row.device_id ? device : undefined;
  }

  // 현재 웹 세션을 기기 서명으로 인증한 활성 기기를 조회한다.
  private sessionDevice(userId: number, sessionId: number): SessionDevice | undefined {
    return this.database.prepare(`
      SELECT d.id, d.public_key, d.biometric_public_key
      FROM web_sessions s JOIN mobile_trusted_devices d ON d.id = s.mobile_trusted_device_id AND d.user_id = s.user_id AND d.active = 1
      WHERE s.id = ? AND s.user_id = ? AND s.expires_at > datetime('now')
    `).get(sessionId, userId) as SessionDevice | undefined;
  }

  // 사용자 소유의 활성 기기만 조회해 다른 계정의 식별자를 재사용하지 못하게 한다.
  private findDevice(userId: number, deviceId: string): { id: string } | undefined {
    if (!deviceId || deviceId.length > 80) return undefined;
    return this.database.prepare(`
      SELECT id FROM mobile_trusted_devices WHERE id = ? AND user_id = ? AND active = 1
    `).get(deviceId, userId) as { id: string } | undefined;
  }
}

type SessionDevice = { id: string; public_key: string; biometric_public_key: string | null };

// 저장된 P-256 공개키로 base64 ECDSA 서명을 검증하며 형식 오류는 실패로 본다.
function verifySignature(publicKey: string, payload: string, signature: string): boolean {
  if (!signature || signature.length > 1024) return false;
  try {
    return crypto.verify("sha256", Buffer.from(payload, "utf8"), parseDevicePublicKey(publicKey), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

// 기기 키가 지문 공개키를 보증하는 서명 문구. 용도 접두어로 다른 challenge 서명과 섞이지 않게 한다.
function biometricEnrollPayload(challenge: string, biometricPublicKey: string): string {
  return `wam-biometric-enroll-v1\n${challenge}\n${biometricPublicKey}`;
}

// 지문 키로 서명하는 본인 확인 문구.
function biometricReauthPayload(challenge: string): string {
  return `wam-biometric-reauth-v1\n${challenge}`;
}

// DER SPKI 입력이 Android Keystore와 맞는 P-256 EC 공개키인지 제한한다.
function parseDevicePublicKey(encoded: string): KeyObject {
  if (!encoded || encoded.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("앱 공개키 형식이 올바르지 않습니다.");
  const key = crypto.createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("앱 공개키는 P-256 형식이어야 합니다.");
  }
  return key;
}

// 정규화한 DER 공개키의 계정별 기기 조회용 SHA-256 지문을 계산한다.
function publicKeyFingerprint(encoded: string): string {
  return crypto.createHash("sha256").update(Buffer.from(encoded, "base64")).digest("hex");
}

// 기기 로그인 서명을 요청이 도착한 origin에 결합해 다른 서버의 challenge relay를 막는다.
function loginSignaturePayload(origin: string, challenge: string): string {
  return `wam-device-login-v1\n${origin}\n${challenge}`;
}

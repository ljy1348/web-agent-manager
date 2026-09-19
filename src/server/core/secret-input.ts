import fs from "node:fs";
import path from "node:path";

export interface SecretInputOptions {
  valueEnvironment: string;
  fileEnvironment: string;
  label: string;
  minimumLength: number;
  maximumLength: number;
}

function normalizeSecret(raw: string, options: SecretInputOptions): string {
  const value = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (/[\u0000\r\n]/.test(value)) throw new Error(`${options.label}에는 NUL 또는 줄바꿈을 사용할 수 없습니다.`);
  if (value.length < options.minimumLength || value.length > options.maximumLength) {
    throw new Error(`${options.label}는 ${options.minimumLength}~${options.maximumLength}자여야 합니다.`);
  }
  return value;
}

// secret 원문을 argv나 저장소 파일에 넣지 않고, 직접 env 또는 current-user owner-only 파일 하나에서만 읽는다.
export function readSecretInput(options: SecretInputOptions): string {
  const direct = process.env[options.valueEnvironment];
  const fileInput = process.env[options.fileEnvironment];
  if (direct !== undefined && fileInput !== undefined) {
    throw new Error(`${options.valueEnvironment}와 ${options.fileEnvironment}는 동시에 설정할 수 없습니다.`);
  }
  if (direct !== undefined) return normalizeSecret(direct, options);
  if (!fileInput) throw new Error(`${options.valueEnvironment} 또는 ${options.fileEnvironment}가 필요합니다.`);
  if (!path.isAbsolute(fileInput)) throw new Error(`${options.fileEnvironment}는 absolute path여야 합니다.`);

  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(fileInput, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0) {
      throw new Error(`${options.label} 파일은 owner만 읽을 수 있는 일반 파일이어야 합니다.`);
    }
    if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
      throw new Error(`${options.label} 파일은 현재 실행 사용자가 소유해야 합니다.`);
    }
    if (stat.size > options.maximumLength * 4 + 2) throw new Error(`${options.label} 파일이 너무 큽니다.`);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error(`${options.label} 파일이 읽는 중 변경됐습니다.`);
      offset += count;
    }
    let decoded: string;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    finally { bytes.fill(0); }
    return normalizeSecret(decoded, options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`${options.label} 파일은 symlink일 수 없습니다.`);
    throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

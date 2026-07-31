import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import Busboy, { type FileInfo } from "busboy";

const MAX_CONCURRENT_UPLOAD_REQUESTS = 4;
const MIN_FREE_SPACE_BYTES = 64 * 1024 * 1024;
let activeUploadRequests = 0;

export interface StreamToFileOptions {
  overwrite?: boolean;
  maxBytes?: number;
  accountBytes?: (bytes: number) => void;
}

export interface MultipartUploadLimits {
  destinationDir: string;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  timeoutMs?: number;
}

type MultipartFileHandler = (stream: Readable, info: FileInfo, accountBytes: (bytes: number) => void) => Promise<void>;

// 업로드 대상 파일시스템에 예상 요청 크기와 최소 여유 공간이 남는지 확인한다.
function assertUploadCapacity(request: IncomingMessage, limits: MultipartUploadLimits): void {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > limits.maxTotalBytes + 2 * 1024 * 1024) {
    throw new Error("업로드 요청 전체 크기가 제한을 초과했습니다.");
  }
  const expectedBytes = contentLength > 0 ? Math.min(contentLength, limits.maxTotalBytes) : limits.maxTotalBytes;
  const stat = fs.statfsSync(limits.destinationDir);
  const availableBytes = Number(stat.bavail) * Number(stat.bsize);
  if (availableBytes < expectedBytes + MIN_FREE_SPACE_BYTES) throw new Error("업로드를 저장할 디스크 여유 공간이 부족합니다.");
}

// 여러 파일 multipart 요청의 총량·개수·시간·동시성을 제한하고 모든 파일 처리를 완료한다.
export async function processMultipartFiles(request: IncomingMessage, limits: MultipartUploadLimits, handleFile: MultipartFileHandler): Promise<void> {
  if (activeUploadRequests >= MAX_CONCURRENT_UPLOAD_REQUESTS) throw new Error("동시에 처리할 수 있는 업로드 요청 수를 초과했습니다.");
  assertUploadCapacity(request, limits);
  activeUploadRequests += 1;
  try {
    await new Promise<void>((resolve, reject) => {
      const pending: Promise<void>[] = [];
      let totalBytes = 0;
      let fileCount = 0;
      let settled = false;
      let parser: ReturnType<typeof Busboy>;
      const timeout = setTimeout(() => fail(new Error("업로드 처리 시간을 초과했습니다.")), limits.timeoutMs ?? 120_000);
      timeout.unref();

      // 파서 오류 뒤 남은 요청을 비우고 진행 중 파일 정리가 끝난 뒤 한 번만 실패시킨다.
      function fail(reason: unknown): void {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        request.removeListener("aborted", onAborted);
        request.unpipe(parser);
        parser.destroy();
        request.resume();
        void Promise.allSettled(pending).then(() => reject(reason instanceof Error ? reason : new Error(String(reason))));
      }

      // 클라이언트가 연결을 끊으면 임시 파일을 남기지 않고 전체 요청을 중단한다.
      function onAborted(): void {
        fail(new Error("업로드 요청이 중단되었습니다."));
      }

      try {
        parser = Busboy({
          headers: request.headers,
          limits: {
            fileSize: limits.maxFileBytes,
            files: limits.maxFiles,
            fields: 0,
            parts: limits.maxFiles,
          },
        });
      } catch (error) {
        clearTimeout(timeout);
        request.removeListener("aborted", onAborted);
        reject(error);
        return;
      }

      request.once("aborted", onAborted);
      parser.on("file", (_field, stream, info) => {
        if (settled) {
          stream.resume();
          return;
        }
        fileCount += 1;
        const accountBytes = (bytes: number): void => {
          totalBytes += bytes;
          if (totalBytes > limits.maxTotalBytes) throw new Error("업로드 요청 전체 크기가 제한을 초과했습니다.");
        };
        let task: Promise<void>;
        try {
          task = handleFile(stream, info, accountBytes);
        } catch (error) {
          stream.resume();
          fail(error);
          return;
        }
        pending.push(task);
        void task.catch(fail);
      });
      parser.on("filesLimit", () => fail(new Error(`한 번에 ${limits.maxFiles}개까지만 업로드할 수 있습니다.`)));
      parser.on("partsLimit", () => fail(new Error("업로드 요청의 multipart 항목 수가 제한을 초과했습니다.")));
      parser.on("fieldsLimit", () => fail(new Error("업로드 요청에는 파일 외 필드를 포함할 수 없습니다.")));
      parser.on("error", fail);
      parser.on("finish", () => {
        if (settled) return;
        if (!fileCount) {
          fail(new Error("업로드할 파일이 없습니다."));
          return;
        }
        void Promise.all(pending).then(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          request.removeListener("aborted", onAborted);
          resolve();
        }).catch(fail);
      });
      request.pipe(parser);
    });
  } finally {
    activeUploadRequests -= 1;
  }
}

// 업로드 스트림을 임시 파일로 받은 뒤 덮어쓰기 정책에 맞게 원자적으로 반영한다.
export function streamToFile(stream: Readable, destinationDir: string, targetName: string, options: StreamToFileOptions = {}): Promise<{ size: number; hash: string }> {
  const target = path.join(destinationDir, targetName);
  const temporary = path.join(destinationDir, `.web-agent-manager-upload-${crypto.randomUUID()}`);
  const hash = crypto.createHash("sha256");
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  let size = 0;
  let settled = false;

  return new Promise<{ size: number; hash: string }>((resolve, reject) => {
    const output = fs.createWriteStream(temporary, { mode: 0o600, flags: "wx" });

    // 입력·출력을 중단하고 파일 핸들이 닫힌 뒤 임시 파일을 제거해 한 번만 실패시킨다.
    function fail(reason: unknown): void {
      if (settled) return;
      settled = true;
      stream.unpipe(output);
      stream.resume();
      const finishFailure = (): void => {
        fs.rmSync(temporary, { force: true });
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      };
      if (output.closed) finishFailure();
      else {
        output.once("close", finishFailure);
        output.destroy();
      }
    }

    stream.on("data", (chunk: Buffer | string | Uint8Array) => {
      if (settled) return;
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBytes) throw new Error(`${targetName} 파일이 업로드 제한을 초과했습니다.`);
        options.accountBytes?.(buffer.length);
        hash.update(buffer);
      } catch (error) {
        fail(error);
      }
    });
    stream.once("limit", () => fail(new Error(`${targetName} 파일이 업로드 제한을 초과했습니다.`)));
    stream.once("error", fail);
    output.once("error", fail);
    output.once("finish", () => {
      if (settled) return;
      settled = true;
      try {
        if (options.overwrite) {
          fs.renameSync(temporary, target);
        } else {
          fs.linkSync(temporary, target);
          fs.rmSync(temporary, { force: true });
        }
        resolve({ size, hash: hash.digest("hex") });
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        const code = (error as NodeJS.ErrnoException).code;
        reject(code === "EEXIST" ? new Error(`${targetName} 파일이 이미 존재합니다.`) : error);
      }
    });
    stream.pipe(output);
  });
}

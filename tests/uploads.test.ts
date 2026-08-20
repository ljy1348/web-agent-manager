import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { Readable, PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processMultipartFiles, streamToFile } from "../src/server/core/uploads";

const roots: string[] = [];

// 각 테스트용 임시 업로드 디렉터리를 만들고 종료 후 정리 대상으로 등록한다.
function temporaryDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-upload-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("업로드 저장", () => {
  it("덮어쓰기 금지 시 기존 파일을 원자적으로 보존한다", async () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "same.txt"), "기존 내용");

    await expect(streamToFile(Readable.from("새 내용"), root, "same.txt")).rejects.toThrow("이미 존재합니다");

    expect(fs.readFileSync(path.join(root, "same.txt"), "utf8")).toBe("기존 내용");
    expect(fs.readdirSync(root).some((name) => name.startsWith(".web-agent-manager-upload-"))).toBe(false);
  });

  it("명시적 덮어쓰기만 기존 파일을 교체한다", async () => {
    const root = temporaryDirectory();
    fs.writeFileSync(path.join(root, "same.txt"), "기존 내용");

    const result = await streamToFile(Readable.from("새 내용"), root, "same.txt", { overwrite: true });

    expect(result.size).toBe(Buffer.byteLength("새 내용"));
    expect(fs.readFileSync(path.join(root, "same.txt"), "utf8")).toBe("새 내용");
  });

  it("크기 제한 이벤트가 발생하면 대상과 임시 파일을 남기지 않는다", async () => {
    const root = temporaryDirectory();
    const input = new PassThrough();
    const result = streamToFile(input, root, "large.bin", { maxBytes: 4 });

    input.write(Buffer.from("12345"));
    input.emit("limit");
    input.end();

    await expect(result).rejects.toThrow("업로드 제한");
    expect(fs.existsSync(path.join(root, "large.bin"))).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe("multipart 조기 거부", () => {
  // Content-Length가 총량 제한을 넘으면 파서를 시작하지도 않고 즉시 거부하는데, 이때 요청
  // 스트림을 그대로 두면 클라이언트가 계속 보내는 바디가 소켓에 남아 응답이 전달되지 않고
  // pending 상태로 남는다. destroy()로 소켓을 끊어 클라이언트가 바로 실패를 알게 해야 한다.
  it("전체 크기 제한을 넘는 요청은 즉시 실패시키고 요청 소켓을 끊는다", async () => {
    const root = temporaryDirectory();
    const request = new PassThrough() as unknown as IncomingMessage;
    (request as unknown as { headers: Record<string, string> }).headers = { "content-length": String(100 * 1024 * 1024) };
    const destroySpy = vi.spyOn(request, "destroy");

    await expect(processMultipartFiles(request, {
      destinationDir: root,
      maxFileBytes: 25 * 1024 * 1024,
      maxTotalBytes: 50 * 1024 * 1024,
      maxFiles: 5,
    }, async () => {})).rejects.toThrow("전체 크기가 제한을 초과했습니다");

    expect(destroySpy).toHaveBeenCalled();
  });
});

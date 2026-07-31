import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { streamToFile } from "../src/server/core/uploads";

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

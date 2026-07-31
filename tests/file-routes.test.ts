import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { AppDatabase } from "../src/server/core/database";
import type { AuthenticatedRequest } from "../src/server/core/auth";
import { createFileRouter } from "../src/server/routes/file-routes";

let closeServer: (() => Promise<void>) | undefined;

// 테스트용 Express 앱을 띄우고 파일 라우터 의존성을 주입한다.
async function startFileApi(database: AppDatabase, trustedNetwork = true): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((request: AuthenticatedRequest, _response, next) => {
    request.authUser = { id: 1, username: "admin", role: "admin" };
    request.trustedNetwork = trustedNetwork;
    next();
  });
  app.use(createFileRouter(database));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(400).json({ error: error instanceof Error ? error.message : "오류" });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  closeServer = () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

describe("파일 API", () => {
  it("ZIP 다운로드 요청을 비활성 상태로 거부한다", async () => {
    const baseUrl = await startFileApi({} as AppDatabase);

    const response = await fetch(`${baseUrl}/projects/1/files/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["src"] }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "ZIP 다운로드 기능은 현재 비활성화되어 있습니다." });
  });

  it("텍스트 파일은 내용 미리보기를 반환하고 바이너리는 거부한다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-files-"));
    fs.writeFileSync(path.join(root, "note.txt"), "첫 줄\nsecond line", "utf8");
    fs.writeFileSync(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
    const database = {
      prepare: () => ({ get: () => ({ path: root }) }),
    } as unknown as AppDatabase;
    const baseUrl = await startFileApi(database);

    const textResponse = await fetch(`${baseUrl}/projects/1/files/preview?path=note.txt`);
    const textPreview = await textResponse.json();
    const binaryResponse = await fetch(`${baseUrl}/projects/1/files/preview?path=image.bin`);
    const binaryPreview = await binaryResponse.json();

    expect(textResponse.status).toBe(200);
    expect(textPreview).toMatchObject({ previewable: true, content: "첫 줄\nsecond line", truncated: false });
    expect(binaryResponse.status).toBe(200);
    expect(binaryPreview).toMatchObject({ previewable: false, reason: "지원하거나 검증할 수 없는 파일 형식입니다." });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("파일 목록에서 symlink를 제외해 외부 대상 메타데이터를 노출하지 않는다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-files-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-outside-"));
    fs.writeFileSync(path.join(root, "visible.txt"), "ok");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "linked.txt"));
    const database = {
      prepare: () => ({ get: () => ({ path: root }), run: () => undefined }),
    } as unknown as AppDatabase;
    const baseUrl = await startFileApi(database);

    const response = await fetch(`${baseUrl}/projects/1/files`);
    const data = await response.json();

    expect(data.entries.map((entry: { name: string }) => entry.name)).toEqual(["visible.txt"]);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("외부망에서는 점 파일을 숨기고 내부망에서도 민감 설정은 숨긴다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-files-"));
    fs.mkdirSync(path.join(root, ".vscode"));
    fs.writeFileSync(path.join(root, ".vscode", "settings.json"), "{}");
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=secret");
    fs.writeFileSync(path.join(root, "visible.txt"), "ok");
    const database = {
      prepare: () => ({ get: () => ({ path: root }), run: () => undefined }),
    } as unknown as AppDatabase;

    const externalUrl = await startFileApi(database, false);
    const external = await (await fetch(`${externalUrl}/projects/1/files`)).json();
    expect(external.hiddenFilesVisible).toBe(false);
    expect(external.entries.map((entry: { name: string }) => entry.name)).toEqual(["visible.txt"]);
    expect((await fetch(`${externalUrl}/projects/1/files?path=.vscode`)).status).toBe(400);
    await closeServer?.();
    closeServer = undefined;

    const internalUrl = await startFileApi(database, true);
    const internal = await (await fetch(`${internalUrl}/projects/1/files`)).json();
    expect(internal.hiddenFilesVisible).toBe(true);
    expect(internal.entries.map((entry: { name: string }) => entry.name)).toEqual([".vscode", "visible.txt"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("전용 첨부 API는 채팅과 프로젝트 소유권을 확인하고 일반 숨김 경로 접근과 분리한다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-files-"));
    const uploadDir = path.join(root, ".web-agent-manager-uploads", "41");
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fs.writeFileSync(path.join(uploadDir, "note.txt"), "내용");
    const legacyUploadDir = path.join(root, ".myagent-uploads", "41");
    fs.mkdirSync(legacyUploadDir, { recursive: true });
    fs.writeFileSync(path.join(legacyUploadDir, "legacy.txt"), "기존 첨부");
    const database = {
      prepare: (sql: string) => ({
        get: (...values: unknown[]) => sql.includes("FROM chats")
          ? (values[0] === 41 && values[1] === 1 ? { id: 41 } : undefined)
          : { path: root },
        run: () => undefined,
      }),
    } as unknown as AppDatabase;
    const baseUrl = await startFileApi(database, false);

    expect((await fetch(`${baseUrl}/projects/1/files/preview?path=.web-agent-manager-uploads%2F41%2Fnote.txt`)).status).toBe(400);
    const image = await fetch(`${baseUrl}/projects/1/attachments/content?path=.web-agent-manager-uploads%2F41%2Fshot.png`);
    const download = await fetch(`${baseUrl}/projects/1/attachments/content?path=.web-agent-manager-uploads%2F41%2Fnote.txt&download=1`);
    const legacyDownload = await fetch(`${baseUrl}/projects/1/attachments/content?path=.myagent-uploads%2F41%2Flegacy.txt&download=1`);
    const wrongProject = await fetch(`${baseUrl}/projects/2/attachments/content?path=.web-agent-manager-uploads%2F41%2Fshot.png`);

    expect(image.status).toBe(200);
    expect(image.headers.get("content-disposition")).toMatch(/^inline/);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(legacyDownload.status).toBe(200);
    expect(wrongProject.status).toBe(400);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("기존 파일은 명시적 overwrite 없이는 보존하고 요청 시에만 교체한다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-files-"));
    fs.writeFileSync(path.join(root, "note.txt"), "기존 내용");
    const database = {
      prepare: () => ({ get: () => ({ path: root }), run: () => undefined }),
    } as unknown as AppDatabase;
    const baseUrl = await startFileApi(database);
    const form = new FormData();
    form.append("files", new Blob(["새 내용"]), "note.txt");

    const rejected = await fetch(`${baseUrl}/projects/1/files/upload`, { method: "POST", body: form });
    expect(rejected.status).toBe(400);
    expect(fs.readFileSync(path.join(root, "note.txt"), "utf8")).toBe("기존 내용");

    const overwriteForm = new FormData();
    overwriteForm.append("files", new Blob(["새 내용"]), "note.txt");
    const replaced = await fetch(`${baseUrl}/projects/1/files/upload?overwrite=true`, { method: "POST", body: overwriteForm });
    expect(replaced.status).toBe(201);
    expect(fs.readFileSync(path.join(root, "note.txt"), "utf8")).toBe("새 내용");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("파일이 없는 multipart 업로드를 성공으로 처리하지 않는다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-files-"));
    const database = {
      prepare: () => ({ get: () => ({ path: root }), run: () => undefined }),
    } as unknown as AppDatabase;
    const baseUrl = await startFileApi(database);
    const form = new FormData();

    const response = await fetch(`${baseUrl}/projects/1/files/upload`, { method: "POST", body: form });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "업로드할 파일이 없습니다." });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("Markdown과 HTML은 서로 다른 미리보기 종류로 판정하고 HTML을 sandbox CSP로 제공한다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-files-"));
    fs.writeFileSync(path.join(root, "README.md"), "# 제목\n\n**본문**", "utf8");
    fs.writeFileSync(path.join(root, "page.html"), "<h1>페이지</h1><script>top.location='https://example.com'</script>", "utf8");
    const database = {
      prepare: () => ({ get: () => ({ path: root }), run: () => undefined }),
    } as unknown as AppDatabase;
    const baseUrl = await startFileApi(database);

    const markdown = await (await fetch(`${baseUrl}/projects/1/files/preview?path=README.md`)).json();
    const html = await (await fetch(`${baseUrl}/projects/1/files/preview?path=page.html`)).json();
    const htmlContent = await fetch(`${baseUrl}/projects/1/files/content/page.html`);

    expect(markdown).toMatchObject({ previewable: true, kind: "markdown", content: "# 제목\n\n**본문**" });
    expect(html).toMatchObject({ previewable: true, kind: "html" });
    expect(htmlContent.status).toBe(200);
    expect(htmlContent.headers.get("content-type")).toContain("text/html");
    expect(htmlContent.headers.get("content-security-policy")).toContain("sandbox");
    expect(htmlContent.headers.get("content-security-policy")).toContain("script-src 'none'");
    expect(htmlContent.headers.get("cache-control")).toBe("private, no-store");
    expect(await htmlContent.text()).toContain("<h1>페이지</h1>");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("PDF는 문서로 제공하고 ZIP·EPUB은 압축파일 안내만 허용한다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-files-"));
    fs.writeFileSync(path.join(root, "sample.pdf"), "%PDF-1.7\n1 0 obj\n<<>>\nendobj", "ascii");
    fs.writeFileSync(path.join(root, "fake.pdf"), "<html>not pdf</html>", "utf8");
    const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    fs.writeFileSync(path.join(root, "book.epub"), zipHeader);
    fs.writeFileSync(path.join(root, "archive.zip"), zipHeader);
    fs.writeFileSync(path.join(root, "fake.zip"), "not zip", "utf8");
    const database = {
      prepare: () => ({ get: () => ({ path: root }), run: () => undefined }),
    } as unknown as AppDatabase;
    const baseUrl = await startFileApi(database);

    const pdf = await (await fetch(`${baseUrl}/projects/1/files/preview?path=sample.pdf`)).json();
    const fakePdf = await (await fetch(`${baseUrl}/projects/1/files/preview?path=fake.pdf`)).json();
    const epub = await (await fetch(`${baseUrl}/projects/1/files/preview?path=book.epub`)).json();
    const archive = await (await fetch(`${baseUrl}/projects/1/files/preview?path=archive.zip`)).json();
    const fakeArchive = await (await fetch(`${baseUrl}/projects/1/files/preview?path=fake.zip`)).json();
    const pdfContent = await fetch(`${baseUrl}/projects/1/files/content/sample.pdf`);
    const archiveContent = await fetch(`${baseUrl}/projects/1/files/content/archive.zip`);

    expect(pdf).toMatchObject({ previewable: true, kind: "pdf" });
    expect(fakePdf).toMatchObject({ previewable: false });
    expect(epub).toMatchObject({ previewable: true, kind: "archive" });
    expect(archive).toMatchObject({ previewable: true, kind: "archive" });
    expect(fakeArchive).toMatchObject({ previewable: false });
    expect(pdfContent.status).toBe(200);
    expect(pdfContent.headers.get("content-type")).toContain("application/pdf");
    expect(archiveContent.status).toBe(400);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("이미지·영상·오디오를 시그니처에 맞는 미디어 미리보기로 분류한다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-files-"));
    fs.writeFileSync(path.join(root, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const mp4 = Buffer.alloc(16);
    mp4.write("ftyp", 4, "ascii");
    fs.writeFileSync(path.join(root, "clip.mp4"), mp4);
    const wav = Buffer.alloc(16);
    wav.write("RIFF", 0, "ascii");
    wav.write("WAVE", 8, "ascii");
    fs.writeFileSync(path.join(root, "sound.wav"), wav);
    const database = {
      prepare: () => ({ get: () => ({ path: root }), run: () => undefined }),
    } as unknown as AppDatabase;
    const baseUrl = await startFileApi(database);

    const image = await (await fetch(`${baseUrl}/projects/1/files/preview?path=shot.png`)).json();
    const video = await (await fetch(`${baseUrl}/projects/1/files/preview?path=clip.mp4`)).json();
    const audio = await (await fetch(`${baseUrl}/projects/1/files/preview?path=sound.wav`)).json();
    const videoContent = await fetch(`${baseUrl}/projects/1/files/content/clip.mp4`);

    expect(image).toMatchObject({ previewable: true, kind: "image" });
    expect(video).toMatchObject({ previewable: true, kind: "video" });
    expect(audio).toMatchObject({ previewable: true, kind: "audio" });
    expect(videoContent.headers.get("content-type")).toContain("video/mp4");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("inline=1이면 Content-Disposition을 inline으로, 없으면 attachment로 응답한다", async () => {
    // 채팅에 첨부된 이미지를 탭했을 때 모바일 브라우저가 다운로드 창을 띄우던 문제의 원인이
    // res.download()이 항상 attachment로 응답하는 것이었다 — inline=1 분기가 실제로 헤더를
    // 바꾸는지 여기서 직접 확인한다. 파일 탭의 진짜 "다운로드" 버튼은 이 파라미터를 안 붙이므로
    // 그 경로(기본값)는 attachment가 그대로 유지돼야 한다.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-files-"));
    fs.writeFileSync(path.join(root, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const database = {
      prepare: () => ({ get: () => ({ path: root }), run: () => undefined }),
    } as unknown as AppDatabase;
    const baseUrl = await startFileApi(database);

    const inlineResponse = await fetch(`${baseUrl}/projects/1/files/download?path=shot.png&inline=1`);
    const attachmentResponse = await fetch(`${baseUrl}/projects/1/files/download?path=shot.png`);

    expect(inlineResponse.status).toBe(200);
    expect(inlineResponse.headers.get("content-disposition")).toMatch(/^inline/);
    expect(attachmentResponse.status).toBe(200);
    expect(attachmentResponse.headers.get("content-disposition")).toMatch(/^attachment/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("symlink가 가리키는 실제 민감 파일 다운로드를 거부한다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-files-"));
    fs.writeFileSync(path.join(root, ".env"), "TOKEN=secret", "utf8");
    fs.symlinkSync(path.join(root, ".env"), path.join(root, "public-link"));
    const database = {
      prepare: () => ({ get: () => ({ path: root }), run: () => undefined }),
    } as unknown as AppDatabase;
    const baseUrl = await startFileApi(database);

    const response = await fetch(`${baseUrl}/projects/1/files/download?path=public-link`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "일반 파일 기능으로 접근할 수 없는 경로입니다." });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("SVG처럼 active content가 될 수 있는 파일은 inline 미리보기를 거부한다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-files-"));
    fs.writeFileSync(path.join(root, "icon.svg"), "<svg><script>alert(1)</script></svg>", "utf8");
    const database = {
      prepare: () => ({ get: () => ({ path: root }), run: () => undefined }),
    } as unknown as AppDatabase;
    const baseUrl = await startFileApi(database);

    const response = await fetch(`${baseUrl}/projects/1/files/download?path=icon.svg&inline=1`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "inline 미리보기를 허용하지 않는 파일 형식입니다." });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("이미지 확장자로 위장한 HTML은 inline 미리보기를 거부한다", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-agent-manager-files-"));
    fs.writeFileSync(path.join(root, "fake.png"), "<html><script>alert(1)</script></html>", "utf8");
    const database = {
      prepare: () => ({ get: () => ({ path: root }), run: () => undefined }),
    } as unknown as AppDatabase;
    const baseUrl = await startFileApi(database);

    const response = await fetch(`${baseUrl}/projects/1/files/download?path=fake.png&inline=1`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "파일 내용이 이미지 형식과 일치하지 않습니다." });
    fs.rmSync(root, { recursive: true, force: true });
  });
});

import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { ZipArchive } from "archiver";
import type { AppDatabase } from "../core/database";
import { requireAdmin, type AuthenticatedRequest } from "../core/auth";
import { safeBasename } from "../core/security";
import { writeAudit } from "../core/audit";
import { assertNonSensitiveRelativePath, chatWorkspacePath, resolveNonSensitiveProjectPath, resolveProjectPath, writeFileAtomic } from "./helpers";
import type { GitWorkspaceService } from "../services/git-workspaces";
import { processMultipartFiles, streamToFile } from "../core/uploads";

// 재귀 압축의 민감 경로 필터링을 보강할 때까지 ZIP 다운로드를 차단한다.
const archiveDownloadEnabled = false;
const TEXT_PREVIEW_LIMIT = 256 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".js", ".jsx", ".ts", ".tsx", ".css", ".scss", ".html", ".xml",
  ".yml", ".yaml", ".toml", ".ini", ".conf", ".sh", ".bash", ".zsh", ".sql", ".py", ".rb", ".go", ".rs", ".java",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".kt", ".swift", ".log", ".csv", ".tsv", ".gitignore",
]);
const INLINE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".ogv"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".oga", ".m4a", ".flac"]);
const ZIP_ARCHIVE_EXTENSIONS = new Set([".zip", ".epub"]);
const PREVIEW_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".ogv": "video/ogg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac",
  ".pdf": "application/pdf", ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
};
type PreviewKind = "markdown" | "html" | "image" | "video" | "audio" | "pdf" | "archive" | "text";

// 요청의 신뢰 네트워크 여부를 일반 파일 경로 정책 옵션으로 변환한다.
function fileAccess(request: AuthenticatedRequest): { allowHidden: boolean } {
  return { allowHidden: request.trustedNetwork === true };
}

// 디렉터리 항목을 웹 파일 탐색기용 메타데이터로 변환한다.
function listDirectory(root: string, relativePath: string, access: { allowHidden: boolean }): Array<Record<string, unknown>> {
  const directory = resolveNonSensitiveProjectPath(root, relativePath, true, access);
  if (!fs.statSync(directory).isDirectory()) throw new Error("디렉터리가 아닙니다.");
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => {
      if (entry.isSymbolicLink()) return false;
      try {
        assertNonSensitiveRelativePath(path.join(relativePath, entry.name), access);
        return true;
      } catch {
        return false;
      }
    })
    .map((entry) => {
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      return { name: entry.name, directory: entry.isDirectory(), size: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => Number(b.directory) - Number(a.directory) || String(a.name).localeCompare(String(b.name)));
}

// 파일 전체를 읽지 않고 형식 판별에 필요한 앞부분만 읽는다.
function readFilePrefix(target: string, length: number): Buffer {
  const header = Buffer.alloc(length);
  const fd = fs.openSync(target, "r");
  let read = 0;
  try {
    read = fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return header.subarray(0, read);
}

// 브라우저 미리보기 형식이 실제 파일 앞부분과 일치하는지 확인한다.
function hasPreviewSignature(target: string, extension = path.extname(target).toLowerCase()): boolean {
  const header = readFilePrefix(target, 1024);
  if (extension === ".png") return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === ".jpg" || extension === ".jpeg") return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (extension === ".gif") return header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a";
  if (extension === ".webp") return header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP";
  if (extension === ".bmp") return header[0] === 0x42 && header[1] === 0x4d;
  if ([".mp4", ".m4v", ".mov", ".m4a"].includes(extension)) return header.subarray(4, 8).toString("ascii") === "ftyp";
  if (extension === ".webm") return header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (extension === ".ogv" || extension === ".ogg" || extension === ".oga") return header.subarray(0, 4).toString("ascii") === "OggS";
  if (extension === ".mp3") return header.subarray(0, 3).toString("ascii") === "ID3" || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0);
  if (extension === ".wav") return header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WAVE";
  if (extension === ".flac") return header.subarray(0, 4).toString("ascii") === "fLaC";
  if (extension === ".pdf") return header.indexOf(Buffer.from("%PDF-")) >= 0;
  if (ZIP_ARCHIVE_EXTENSIONS.has(extension)) {
    const signature = header.subarray(0, 4);
    return signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
      || signature.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
      || signature.equals(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
  }
  return false;
}

// 브라우저에서 inline으로 렌더해도 스크립트가 실행되지 않는 이미지 형식만 허용한다.
function assertInlinePreviewAllowed(target: string): void {
  if (!INLINE_IMAGE_EXTENSIONS.has(path.extname(target).toLowerCase())) throw new Error("inline 미리보기를 허용하지 않는 파일 형식입니다.");
  if (!hasPreviewSignature(target)) throw new Error("파일 내용이 이미지 형식과 일치하지 않습니다.");
}

// 확장자와 앞부분 바이트를 기준으로 브라우저 텍스트 미리보기에 적합한 파일인지 확인한다.
function isTextPreviewable(target: string): boolean {
  const extension = path.extname(target).toLowerCase();
  const knownText = TEXT_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(path.basename(target).toLowerCase());
  const sample = readFilePrefix(target, 4096);
  if (sample.includes(0)) return false;
  if (!sample.length) return true;
  let control = 0;
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  return knownText || control / sample.length < 0.02;
}

// 확장자와 파일 시그니처를 함께 사용해 안전한 미리보기 종류를 결정한다.
function previewKind(target: string): PreviewKind | null {
  const extension = path.extname(target).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(extension) && isTextPreviewable(target)) return "markdown";
  if (HTML_EXTENSIONS.has(extension) && isTextPreviewable(target)) return "html";
  if (INLINE_IMAGE_EXTENSIONS.has(extension)) return hasPreviewSignature(target, extension) ? "image" : null;
  if (VIDEO_EXTENSIONS.has(extension)) return hasPreviewSignature(target, extension) ? "video" : null;
  if (AUDIO_EXTENSIONS.has(extension)) return hasPreviewSignature(target, extension) ? "audio" : null;
  if (extension === ".pdf") return hasPreviewSignature(target, extension) ? "pdf" : null;
  if (ZIP_ARCHIVE_EXTENSIONS.has(extension)) return hasPreviewSignature(target, extension) ? "archive" : null;
  return isTextPreviewable(target) ? "text" : null;
}

// Express 5 wildcard 파라미터를 프로젝트 상대 경로 문자열로 복원한다.
function wildcardPath(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join("/");
  return typeof value === "string" ? value : "";
}

// 첨부 경로를 채팅 ID와 단일 저장 파일명으로 제한해 일반 숨김 경로 접근과 분리한다.
function parseAttachmentPath(relativePath: string): { chatId: number; normalized: string } {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  const match = normalized.match(/^\.(?:web-agent-manager|myagent)-uploads\/([1-9]\d*)\/([^/]+)$/);
  if (!match || safeBasename(match[2]) !== match[2]) throw new Error("유효하지 않은 첨부 경로입니다.");
  return { chatId: Number(match[1]), normalized };
}

// 프로젝트 파일 탐색·업로드·다운로드·ZIP API를 구성한다.
export function createFileRouter(database: AppDatabase, workspaces?: GitWorkspaceService): Router {
  // 선택한 채팅이 전용 worktree를 쓰면 파일 탭도 그 폴더를 봐야 한다(요청의 chatId 기준).
  const rootFor = (request: AuthenticatedRequest, projectId: number): string =>
    chatWorkspacePath(database, workspaces, projectId, Number(request.query.chatId) || null);
  const router = Router();
  // 권한 정책: 파일 목록 조회는 로그인 사용자에게 허용하고, 파일 반출·업로드·압축은 관리자만 허용한다.
  router.get("/projects/:id/files", (request: AuthenticatedRequest, response, next) => {
    try {
      const root = rootFor(request, Number(request.params.id));
      const relativePath = typeof request.query.path === "string" ? request.query.path : "";
      response.json({ path: relativePath, entries: listDirectory(root, relativePath, fileAccess(request)), hiddenFilesVisible: request.trustedNetwork === true });
    } catch (error) {
      next(error);
    }
  });
  router.post("/projects/:id/files/upload", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    const projectId = Number(request.params.id);
    let root: string;
    try {
      root = rootFor(request, projectId);
    } catch (error) {
      next(error);
      return;
    }
    const relativeDirectory = typeof request.query.path === "string" ? request.query.path : "";
    const overwrite = request.query.overwrite === "true";
    try {
      const access = fileAccess(request);
      const destination = resolveNonSensitiveProjectPath(root, relativeDirectory, true, access);
      if (!fs.statSync(destination).isDirectory()) throw new Error("업로드 대상이 디렉터리가 아닙니다.");
      const uploads: Array<{ name: string; size: number; hash: string }> = [];
      void processMultipartFiles(request, {
        destinationDir: destination,
        maxFileBytes: 100 * 1024 * 1024,
        maxTotalBytes: 200 * 1024 * 1024,
        maxFiles: 20,
      }, async (stream, info, accountBytes) => {
        const filename = safeBasename(info.filename);
        resolveNonSensitiveProjectPath(root, path.join(relativeDirectory, filename), false, access);
        const { size, hash } = await streamToFile(stream, destination, filename, {
          overwrite,
          maxBytes: 100 * 1024 * 1024,
          accountBytes,
        });
        uploads.push({ name: filename, size, hash });
      }).then(() => {
        writeAudit(database, request.authUser!.id, "file.upload", "project", projectId, { path: relativeDirectory, uploads });
        response.status(201).json({ uploads });
      }).catch(next);
    } catch (error) {
      next(error);
    }
  });
  router.get("/projects/:id/files/download", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const relativePath = String(request.query.path ?? "");
      const target = resolveNonSensitiveProjectPath(rootFor(request, projectId), relativePath, true, fileAccess(request));
      if (!fs.statSync(target).isFile()) throw new Error("다운로드 대상이 파일이 아닙니다.");
      writeAudit(database, request.authUser!.id, "file.download", "project", projectId, { path: relativePath, size: fs.statSync(target).size });
      // res.download()은 항상 Content-Disposition: attachment를 보내 브라우저가 무조건 저장 창을
      // 띄운다 — 채팅에 첨부된 이미지를 탭해서 "크게 보기"로 쓰는 경우(inline=1)에는 그 자리에서
      // 바로 보여줘야 하는데, 모바일 브라우저는 attachment 응답을 받으면 페이지 이동 없이 다운로드
      // 알림만 띄워 아무 반응이 없는 것처럼 보였다(실기기로 확인). 파일 탭의 진짜 "다운로드" 버튼은
      // inline 파라미터 없이 이 라우트를 그대로 쓰므로 기존 저장 동작이 그대로 유지된다.
      const filename = path.basename(target);
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (request.query.inline) {
        assertInlinePreviewAllowed(target);
        // response.download과 동일하게 dotfiles를 허용해야 숨김 첨부 폴더 안의 파일도 열린다.
        response.sendFile(target, { dotfiles: "allow", headers: { "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"` } });
      } else {
        response.download(target, filename, { dotfiles: "allow" });
      }
    } catch (error) {
      next(error);
    }
  });
  router.get("/projects/:id/attachments/content", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const { chatId, normalized } = parseAttachmentPath(String(request.query.path ?? ""));
      const chat = database.prepare("SELECT id FROM chats WHERE id = ? AND project_id = ?").get(chatId, projectId);
      if (!chat) throw new Error("이 프로젝트의 첨부파일이 아닙니다.");
      const target = resolveProjectPath(chatWorkspacePath(database, workspaces, projectId, chatId), normalized);
      if (!fs.statSync(target).isFile()) throw new Error("첨부 대상이 파일이 아닙니다.");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Cache-Control", "private, no-store");
      if (request.query.download === "1") {
        writeAudit(database, request.authUser!.id, "chat.attachment_download", "chat", chatId, { path: normalized });
        response.download(target, path.basename(target), { dotfiles: "allow" });
      } else {
        assertInlinePreviewAllowed(target);
        response.sendFile(target, { dotfiles: "allow", headers: { "Content-Disposition": `inline; filename="${encodeURIComponent(path.basename(target))}"` } });
      }
    } catch (error) {
      next(error);
    }
  });
  router.get("/projects/:id/files/content/{*filePath}", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const relativePath = wildcardPath(request.params.filePath);
      const target = resolveNonSensitiveProjectPath(rootFor(request, projectId), relativePath, true, fileAccess(request));
      if (!fs.statSync(target).isFile()) throw new Error("미리보기 대상이 파일이 아닙니다.");
      const kind = previewKind(target);
      if (!kind || kind === "archive") throw new Error("미리보기 콘텐츠를 제공하지 않는 파일 형식입니다.");
      const extension = path.extname(target).toLowerCase();
      response.setHeader("Content-Type", PREVIEW_CONTENT_TYPES[extension] ?? "text/plain; charset=utf-8");
      response.setHeader("Content-Disposition", "inline");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      if (kind === "html") {
        response.setHeader("X-Frame-Options", "SAMEORIGIN");
        response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
      }
      if (kind === "pdf") {
        response.setHeader("X-Frame-Options", "SAMEORIGIN");
        response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'");
      }
      response.sendFile(target, { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });
  router.get("/projects/:id/files/preview", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const relativePath = String(request.query.path ?? "");
      const target = resolveNonSensitiveProjectPath(rootFor(request, projectId), relativePath, true, fileAccess(request));
      const stat = fs.statSync(target);
      if (!stat.isFile()) throw new Error("미리보기 대상이 파일이 아닙니다.");
      const kind = previewKind(target);
      if (!kind) {
        response.json({ previewable: false, reason: "지원하거나 검증할 수 없는 파일 형식입니다.", size: stat.size });
        return;
      }
      if (!["markdown", "text"].includes(kind)) {
        response.json({ previewable: true, kind, size: stat.size });
        return;
      }
      const buffer = Buffer.alloc(Math.min(stat.size, TEXT_PREVIEW_LIMIT));
      const fd = fs.openSync(target, "r");
      try {
        fs.readSync(fd, buffer, 0, buffer.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      response.json({ previewable: true, kind, content: buffer.toString("utf8"), truncated: stat.size > TEXT_PREVIEW_LIMIT, size: stat.size });
    } catch (error) {
      next(error);
    }
  });
  // 텍스트로 미리볼 수 있는 파일만 편집을 허용한다. 미리보기가 잘린 파일은 편집 화면에 전체 내용이
  // 없어 그대로 저장하면 뒷부분이 사라지므로 클라이언트뿐 아니라 여기서도 막는다.
  router.put("/projects/:id/files/content", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    try {
      const projectId = Number(request.params.id);
      const relativePath = String(request.body?.path ?? "");
      if (typeof request.body?.content !== "string") throw new Error("저장할 내용이 필요합니다.");
      const content = request.body.content as string;
      const size = Buffer.byteLength(content);
      if (size > TEXT_PREVIEW_LIMIT) throw new Error(`텍스트 편집은 ${TEXT_PREVIEW_LIMIT / 1024}KiB를 초과할 수 없습니다.`);
      const target = resolveNonSensitiveProjectPath(rootFor(request, projectId), relativePath, true, fileAccess(request));
      const stat = fs.statSync(target);
      if (!stat.isFile()) throw new Error("편집 대상이 파일이 아닙니다.");
      if (stat.size > TEXT_PREVIEW_LIMIT) throw new Error("미리보기에서 일부만 읽은 파일은 편집할 수 없습니다.");
      const kind = previewKind(target);
      if (kind !== "text" && kind !== "markdown") throw new Error("텍스트 형식이 아닌 파일은 편집할 수 없습니다.");
      writeFileAtomic(target, content);
      writeAudit(database, request.authUser!.id, "file.write", "project", projectId, { path: relativePath, bytes: size });
      response.json({ saved: true, size });
    } catch (error) {
      next(error);
    }
  });
  router.post("/projects/:id/files/archive", requireAdmin, (request: AuthenticatedRequest, response, next) => {
    if (!archiveDownloadEnabled) {
      response.status(503).json({ error: "ZIP 다운로드 기능은 현재 비활성화되어 있습니다." });
      return;
    }
    try {
      const projectId = Number(request.params.id);
      const root = rootFor(request, projectId);
      const paths = Array.isArray(request.body?.paths) ? request.body.paths.filter((item: unknown) => typeof item === "string").slice(0, 100) as string[] : [];
      if (!paths.length) throw new Error("압축할 파일을 선택해주세요.");
      response.attachment("project-files.zip");
      const archive = new ZipArchive({ zlib: { level: 6 } });
      archive.on("error", next);
      archive.pipe(response);
      for (const relativePath of paths) {
        const target = resolveNonSensitiveProjectPath(root, relativePath, true, fileAccess(request));
        const stat = fs.statSync(target);
        if (stat.isDirectory()) archive.directory(target, relativePath);
        else archive.file(target, { name: relativePath });
      }
      writeAudit(database, request.authUser!.id, "file.archive", "project", projectId, { count: paths.length });
      void archive.finalize();
    } catch (error) {
      next(error);
    }
  });
  return router;
}

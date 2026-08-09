// URL 조각과 에디터 줄 번호를 제거해 실제 파일 경로 후보로 정규화한다.
function cleanLinkedPath(href: string): string {
  const withoutFragment = href.split("#", 1)[0].split("?", 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    return "";
  }
  return decoded.replace(/^file:\/\//i, "").replace(/:(\d+)(?::\d+)?$/, "");
}

// 슬래시 경로를 정규화하되 프로젝트 위로 벗어나는 상대 경로는 거부한다.
function normalizeRelativePath(value: string): string | null {
  const parts: string[] = [];
  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

// 채팅 링크가 현재 프로젝트 내부 파일이면 프로젝트 상대 경로를 반환한다.
export function projectFilePathFromHref(href: string | undefined, projectPath: string | undefined, relativeTo = ""): string | null {
  if (!href || !projectPath || href.startsWith("#") || (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:\/\//i.test(href))) return null;
  const linkedPath = cleanLinkedPath(href);
  if (!linkedPath) return null;
  const normalizedRoot = projectPath.replaceAll("\\", "/").replace(/\/+$/, "");
  if (linkedPath.startsWith("/")) {
    if (linkedPath !== normalizedRoot && !linkedPath.startsWith(`${normalizedRoot}/`)) return null;
    return normalizeRelativePath(linkedPath.slice(normalizedRoot.length));
  }
  return normalizeRelativePath([relativeTo, linkedPath].filter(Boolean).join("/"));
}

// 프로젝트 상대 파일 경로를 현재 채팅 작업공간의 inline 콘텐츠 API URL로 만든다.
export function projectFileContentUrl(projectId: number, filePath: string, chatId?: number | null): string {
  const encodedPath = filePath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/api/projects/${projectId}/files/content/${encodedPath}${chatId ? `?chatId=${chatId}` : ""}`;
}

import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(process.cwd());
const distDir = path.join(rootDir, "dist");
const textExtensions = new Set([".css", ".html", ".js", ".json", ".map"]);

// 공개 산출물 검사 대상인 텍스트 파일을 재귀적으로 수집한다.
function listBuildFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return listBuildFiles(target);
    return entry.isFile() && textExtensions.has(path.extname(entry.name)) ? [target] : [];
  });
}

// 빌드 시점의 로컬 절대 경로가 공개 산출물에 포함되지 않았는지 검사한다.
function checkPublicBuild() {
  if (!fs.existsSync(distDir)) throw new Error("dist 디렉터리가 없습니다. 프로덕션 빌드를 먼저 실행하세요.");
  const forbiddenPaths = new Set([rootDir, rootDir.replaceAll("\\", "/")]);
  const leakedFiles = listBuildFiles(distDir).filter((file) => {
    const content = fs.readFileSync(file, "utf8");
    return [...forbiddenPaths].some((forbidden) => content.includes(forbidden));
  });
  if (leakedFiles.length) {
    throw new Error(`공개 빌드에 로컬 절대 경로가 포함됐습니다:\n${leakedFiles.map((file) => path.relative(rootDir, file)).join("\n")}`);
  }
  process.stdout.write("공개 빌드 경로 검사 통과\n");
}

checkPublicBuild();

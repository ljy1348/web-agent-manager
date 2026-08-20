import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ZipArchive } from "archiver";

interface ReleaseTarget {
  id: string;
  description: string;
}

const rootDir = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as { name: string; version: string };
const releaseDir = path.join(rootDir, "release", "archives");
const targets: ReleaseTarget[] = [
  { id: "linux-x64", description: "Linux x64" },
  { id: "macos-x64", description: "macOS Intel x64" },
  { id: "macos-arm64", description: "macOS Apple Silicon arm64" },
  { id: "windows-wsl-x64", description: "Windows x64 / WSL2" },
];

// 한 대상의 production 빌드와 설치 진입점을 ZIP 배포 파일로 묶는다.
async function createArchive(target: ReleaseTarget): Promise<void> {
  const outputPath = path.join(releaseDir, `web-agent-manager-v${packageJson.version}-${target.id}.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("warning", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(path.join(rootDir, "dist"), "dist");
    archive.directory(path.join(rootDir, "skills"), "skills");
    archive.file(path.join(rootDir, "package.json"), { name: "package.json" });
    archive.file(path.join(rootDir, "package-lock.json"), { name: "package-lock.json" });
    archive.file(path.join(rootDir, "README.md"), { name: "README.md" });
    archive.file(path.join(rootDir, "CHANGELOG.md"), { name: "CHANGELOG.md" });
    archive.file(path.join(rootDir, "SECURITY.md"), { name: "SECURITY.md" });
    archive.file(path.join(rootDir, "CONTRIBUTING.md"), { name: "CONTRIBUTING.md" });
    const licensePath = path.join(rootDir, "LICENSE");
    if (fs.existsSync(licensePath)) archive.file(licensePath, { name: "LICENSE" });
    archive.file(path.join(rootDir, "Dockerfile"), { name: "Dockerfile" });
    archive.file(path.join(rootDir, "docker-compose.yml"), { name: "docker-compose.yml" });
    archive.file(path.join(rootDir, ".dockerignore"), { name: ".dockerignore" });
    archive.directory(path.join(rootDir, "docker"), "docker");
    archive.directory(path.join(rootDir, "artifacts"), "artifacts");
    archive.directory(path.join(rootDir, "packaging"), false);
    archive.append(`${target.description}\nweb-agent-manager v${packageJson.version}\n`, { name: "RELEASE_TARGET.txt" });
    void archive.finalize();
  });
  process.stdout.write(`${path.relative(rootDir, outputPath)}\n`);
}

// 설치 패키지에 포함된 운영 의존성의 CycloneDX SBOM을 생성한다.
function createSbom(): void {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const rawSbom = execFileSync(
    npmCommand,
    ["sbom", "--omit=dev", "--package-lock-only", "--sbom-format", "cyclonedx", "--sbom-type", "application"],
    { cwd: rootDir, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
  const sbom = JSON.parse(rawSbom) as { metadata?: { component?: { name?: string } } };
  if (!sbom.metadata?.component) throw new Error("npm이 생성한 SBOM에 최상위 컴포넌트가 없습니다.");
  sbom.metadata.component.name = packageJson.name;
  fs.writeFileSync(path.join(releaseDir, "web-agent-manager-sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`, { mode: 0o644 });
}

// 릴리즈 디렉터리의 파일 무결성 목록을 공통 스크립트로 생성한다.
function createChecksums(): void {
  execFileSync(process.execPath, [path.join(rootDir, "scripts", "create-release-checksums.mjs"), releaseDir], {
    cwd: rootDir,
    stdio: "inherit",
  });
}

// 지원 플랫폼별 압축 파일을 빈 release 디렉터리에 생성한다.
async function main(): Promise<void> {
  fs.rmSync(releaseDir, { recursive: true, force: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  for (const target of targets) await createArchive(target);
  createSbom();
  createChecksums();
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

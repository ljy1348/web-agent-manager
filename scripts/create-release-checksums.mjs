import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 지정한 디렉터리의 일반 파일에 대한 재현 가능한 SHA-256 목록을 작성한다.
export function writeChecksums(directory, outputName = "SHA256SUMS") {
  const outputPath = path.join(directory, outputName);
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== outputName)
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  const lines = entries.map((name) => {
    const digest = createHash("sha256").update(fs.readFileSync(path.join(directory, name))).digest("hex");
    return `${digest}  ${name}`;
  });
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, { mode: 0o644 });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(process.argv[2] ?? ".");
  writeChecksums(directory, process.argv[3] ?? "SHA256SUMS");
}

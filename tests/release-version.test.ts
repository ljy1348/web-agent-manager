import { createHash } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("릴리즈 버전과 Android wrapper", () => {
  it("package와 Android 앱 버전이 일치한다", () => {
    const packageVersion = (JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string }).version;
    const androidBuild = fs.readFileSync("android/app/build.gradle", "utf8");
    expect(androidBuild).toContain(`versionName "${packageVersion}"`);
  });

  it("Gradle 9.5.0 배포 파일과 wrapper JAR의 공식 해시를 고정한다", () => {
    const properties = fs.readFileSync("android/gradle/wrapper/gradle-wrapper.properties", "utf8");
    const wrapperHash = createHash("sha256").update(fs.readFileSync("android/gradle/wrapper/gradle-wrapper.jar")).digest("hex");
    expect(properties).toContain("distributionSha256Sum=553c78f50dafcd54d65b9a444649057857469edf836431389695608536d6b746");
    expect(wrapperHash).toBe("497c8c2a7e5031f6aa847f88104aa80a93532ec32ee17bdb8d1d2f67a194a9c7");
  });
});

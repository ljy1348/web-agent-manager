import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Android network security config", () => {
  it("주석이 base-config cleartext 실제 정책과 모순되지 않는다", () => {
    const xml = readFileSync("android/app/src/main/res/xml/network_security_config.xml", "utf8");
    const baseAllowsCleartext = /<base-config[^>]*cleartextTrafficPermitted="true"/.test(xml);
    const commentClaimsPrivateOnly = /사설망[^\n]*만 허용/.test(xml);
    expect(baseAllowsCleartext && commentClaimsPrivateOnly).toBe(false);
  });
});

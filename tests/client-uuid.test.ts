import { describe, expect, it } from "vitest";
import { createClientUuid } from "../src/client/lib/client-uuid";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("browser-compatible client UUID", () => {
  it("uses crypto.randomUUID when the secure-context API exists", () => {
    const expected = "6cb81b1c-2664-4b40-b12f-1dff3b140ef2";
    expect(createClientUuid({ randomUUID: () => expected })).toBe(expected);
  });

  it("builds an RFC 4122 v4 UUID from getRandomValues on private HTTP origins", () => {
    const id = createClientUuid({
      getRandomValues: (values) => {
        const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
        bytes.forEach((_, index) => { bytes[index] = index; });
        return values;
      },
    });

    expect(id).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(id).toMatch(UUID_V4);
  });

  it("keeps keys valid and unique when both Web Crypto APIs are unavailable", () => {
    const first = createClientUuid({}, () => 1_800_000_000_000, () => 0);
    const second = createClientUuid({}, () => 1_800_000_000_000, () => 0);

    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(second).not.toBe(first);
  });

  it("falls back when an exposed randomUUID implementation throws", () => {
    const id = createClientUuid({
      randomUUID: () => { throw new Error("secure context required"); },
      getRandomValues: (values) => {
        new Uint8Array(values.buffer, values.byteOffset, values.byteLength).fill(0xab);
        return values;
      },
    });

    expect(id).toBe("abababab-abab-4bab-abab-abababababab");
  });
});

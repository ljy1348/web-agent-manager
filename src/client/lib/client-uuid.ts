type BrowserCrypto = {
  randomUUID?: () => string;
  getRandomValues?: Crypto["getRandomValues"];
};

let fallbackCounter = 0;

function currentBrowserCrypto(): BrowserCrypto | undefined {
  return typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

// Idempotency keys are not credentials, but they must stay unique when a private HTTP origin or an
// older WebView does not expose secure-context-only crypto.randomUUID(). Prefer cryptographic bytes
// when available; the last fallback also mixes time and an in-page counter so deterministic/randomly
// weak engines still do not reuse a key during the same page lifetime.
export function createClientUuid(
  cryptoApi: BrowserCrypto = currentBrowserCrypto() ?? {},
  now: () => number = Date.now,
  random: () => number = Math.random,
): string {
  if (typeof cryptoApi.randomUUID === "function") {
    try { return cryptoApi.randomUUID(); } catch { /* fall through to a compatible generator */ }
  }

  const bytes = new Uint8Array(16);
  let securelyFilled = false;
  if (typeof cryptoApi.getRandomValues === "function") {
    try {
      cryptoApi.getRandomValues(bytes);
      securelyFilled = true;
    } catch { /* fall through to the non-cryptographic idempotency-key fallback */ }
  }

  if (!securelyFilled) {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(random() * 256) & 0xff;
    const timestamp = now();
    fallbackCounter = (fallbackCounter + 1) >>> 0;
    for (let index = 0; index < 6; index += 1) bytes[15 - index] ^= Math.floor(timestamp / (2 ** (index * 8))) & 0xff;
    for (let index = 0; index < 4; index += 1) bytes[9 + index] ^= (fallbackCounter >>> (index * 8)) & 0xff;
  }

  // RFC 4122 version 4 / variant 1 bits keep the fallback acceptable anywhere a UUID is expected.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { EncryptionManager } from "../../src/secrets/encryption-manager.js";
import { KMSClient } from "@aws-sdk/client-kms";
import type { Logger } from "../../src/logger.js";

const noopLogger: Logger = {
  startInvocation: () => {},
  getInvocationId: () => "",
  trackPoint: () => {},
  info: () => {},
  track: () => {},
  warn: () => {},
  error: () => {},
  critical: () => {},
};

// Inject a known 32-byte key directly, bypassing KMS init()
function createTestManager(): EncryptionManager {
  const manager = new EncryptionManager(new KMSClient({}), noopLogger);
  (manager as unknown as { key: Buffer }).key = randomBytes(32);
  return manager;
}

function createMockKms(options?: { fail?: boolean; failTimes?: number }): KMSClient {
  let failCount = 0;
  const maxFails = options?.failTimes ?? (options?.fail ? Infinity : 0);
  const key = randomBytes(32);

  const client = new KMSClient({});
  client.send = vi.fn(async () => {
    if (failCount < maxFails) {
      failCount++;
      const error = new Error("InvalidCiphertextException: UnknownError");
      (error as unknown as { name: string }).name = "InvalidCiphertextException";
      throw error;
    }
    return { Plaintext: key };
  }) as unknown as typeof client.send;

  return client;
}

// ---------------------------------------------------------------------------
// Encrypt/Decrypt round-trip
// ---------------------------------------------------------------------------

describe("EncryptionManager encrypt/decrypt round-trip", () => {
  it("decrypts back to the original plaintext", async () => {
    const manager = createTestManager();
    const encrypted = (await manager.encrypt("hello world"))._unsafeUnwrap();
    expect((await manager.decrypt(encrypted))._unsafeUnwrap()).toBe("hello world");
  });

  it("handles empty string", async () => {
    const manager = createTestManager();
    const encrypted = (await manager.encrypt(""))._unsafeUnwrap();
    expect((await manager.decrypt(encrypted))._unsafeUnwrap()).toBe("");
  });

  it("handles unicode content", async () => {
    const manager = createTestManager();
    const plaintext = "Ångström café 日本語 🎉";
    const encrypted = (await manager.encrypt(plaintext))._unsafeUnwrap();
    expect((await manager.decrypt(encrypted))._unsafeUnwrap()).toBe(plaintext);
  });
});

// ---------------------------------------------------------------------------
// Decrypt with corrupted ciphertext (auth tag validation)
// ---------------------------------------------------------------------------

describe("EncryptionManager decrypt with corrupted ciphertext", () => {
  it("returns crypto_failed when ciphertext bytes are flipped", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = createTestManager();
    const encrypted = (await manager.encrypt("secret data"))._unsafeUnwrap();
    const buf = Buffer.from(encrypted, "base64");
    buf.writeUInt8(buf.readUInt8(28) ^ 0xff, 28);
    const corrupted = buf.toString("base64");
    const result = await manager.decrypt(corrupted);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("crypto_failed");
    vi.restoreAllMocks();
  });

  it("returns crypto_failed when auth tag bytes are flipped", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = createTestManager();
    const encrypted = (await manager.encrypt("secret data"))._unsafeUnwrap();
    const buf = Buffer.from(encrypted, "base64");
    buf.writeUInt8(buf.readUInt8(12) ^ 0xff, 12);
    const corrupted = buf.toString("base64");
    const result = await manager.decrypt(corrupted);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("crypto_failed");
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Decrypt with truncated input
// ---------------------------------------------------------------------------

describe("EncryptionManager decrypt with truncated input", () => {
  it("returns crypto_failed when input is shorter than iv + authTag", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = createTestManager();
    const truncated = Buffer.alloc(20).toString("base64");
    const result = await manager.decrypt(truncated);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("crypto_failed");
    vi.restoreAllMocks();
  });

  it("returns crypto_failed when input is exactly iv length", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = createTestManager();
    const truncated = Buffer.alloc(12).toString("base64");
    const result = await manager.decrypt(truncated);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("crypto_failed");
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Encrypt produces different output each call (random IV)
// ---------------------------------------------------------------------------

describe("EncryptionManager random IV produces unique ciphertext", () => {
  it("two encryptions of the same plaintext produce different base64 outputs", async () => {
    const manager = createTestManager();
    const a = (await manager.encrypt("same"))._unsafeUnwrap();
    const b = (await manager.encrypt("same"))._unsafeUnwrap();
    expect(a).not.toBe(b);
  });

  it("the first 12 bytes (IV) differ between encryptions", async () => {
    const manager = createTestManager();
    const a = Buffer.from((await manager.encrypt("same"))._unsafeUnwrap(), "base64");
    const b = Buffer.from((await manager.encrypt("same"))._unsafeUnwrap(), "base64");
    const ivA = a.subarray(0, 12);
    const ivB = b.subarray(0, 12);
    expect(ivA.equals(ivB)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// init() — fire-and-forget safety
// ---------------------------------------------------------------------------

describe("EncryptionManager init()", () => {
  it("does not throw when KMS fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const kms = createMockKms({ fail: true });
    const manager = new EncryptionManager(kms, noopLogger);
    await expect(manager.init()).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });

  it("logs InvalidCiphertextException with specific message", async () => {
    const spyLogger: Logger = { ...noopLogger, critical: vi.fn() };
    const kms = new KMSClient({});
    kms.send = vi.fn(async () => {
      const error = new Error("UnknownError");
      (error as unknown as { name: string }).name = "InvalidCiphertextException";
      throw error;
    }) as unknown as typeof kms.send;
    const manager = new EncryptionManager(kms, spyLogger);
    await manager.init();
    expect(spyLogger.critical).toHaveBeenCalledWith(
      expect.stringContaining("encryption.kms.json contains invalid ciphertext"),
      expect.objectContaining({ code: "encryption.invalid_ciphertext" }),
    );
  });

  it("async methods retry after failed init", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const kms = createMockKms({ failTimes: 1 });
    const manager = new EncryptionManager(kms, noopLogger);
    await manager.init(); // fails
    const result = await manager.encrypt("retry works");
    expect(result.isOk()).toBe(true);
    expect(kms.send).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("async methods return kms_unavailable when permanently unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const kms = createMockKms({ fail: true });
    const manager = new EncryptionManager(kms, noopLogger);
    await manager.init();
    const result = await manager.encrypt("nope");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().kind).toBe("kms_unavailable");
    vi.restoreAllMocks();
  });
});


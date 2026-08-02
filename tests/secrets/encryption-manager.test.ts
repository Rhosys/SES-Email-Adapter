import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { EncryptionManager } from "../../src/secrets/encryption-manager.js";
import { KMSClient } from "@aws-sdk/client-kms";

// Inject a known 32-byte key directly, bypassing KMS init()
function createTestManager(): EncryptionManager {
  const manager = new EncryptionManager(new KMSClient({}));
  (manager as unknown as { key: Buffer }).key = randomBytes(32);
  return manager;
}

// ---------------------------------------------------------------------------
// Encrypt/Decrypt round-trip
// Validates: Requirements 2.1, 2.3, 2.4
// ---------------------------------------------------------------------------

describe("EncryptionManager encrypt/decrypt round-trip", () => {
  it("decrypts back to the original plaintext", () => {
    const manager = createTestManager();
    const plaintext = "hello world";
    const encrypted = manager.encrypt(plaintext);
    expect(manager.decrypt(encrypted)).toBe(plaintext);
  });

  it("handles empty string", () => {
    const manager = createTestManager();
    const encrypted = manager.encrypt("");
    expect(manager.decrypt(encrypted)).toBe("");
  });

  it("handles unicode content", () => {
    const manager = createTestManager();
    const plaintext = "Ångström café 日本語 🎉";
    const encrypted = manager.encrypt(plaintext);
    expect(manager.decrypt(encrypted)).toBe(plaintext);
  });
});

// ---------------------------------------------------------------------------
// Decrypt with corrupted ciphertext (auth tag validation)
// Validates: Requirements 2.3, 2.4
// ---------------------------------------------------------------------------

describe("EncryptionManager decrypt with corrupted ciphertext", () => {
  it("throws when ciphertext bytes are flipped", () => {
    const manager = createTestManager();
    const encrypted = manager.encrypt("secret data");
    const buf = Buffer.from(encrypted, "base64");
    // Flip a byte in the ciphertext region (after iv=12 + authTag=16 = offset 28)
    buf.writeUInt8(buf.readUInt8(28) ^ 0xff, 28);
    const corrupted = buf.toString("base64");
    expect(() => manager.decrypt(corrupted)).toThrow();
  });

  it("throws when auth tag bytes are flipped", () => {
    const manager = createTestManager();
    const encrypted = manager.encrypt("secret data");
    const buf = Buffer.from(encrypted, "base64");
    // Flip a byte in the auth tag region (offset 12..28)
    buf.writeUInt8(buf.readUInt8(12) ^ 0xff, 12);
    const corrupted = buf.toString("base64");
    expect(() => manager.decrypt(corrupted)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Decrypt with truncated input
// Validates: Requirements 2.3, 2.4
// ---------------------------------------------------------------------------

describe("EncryptionManager decrypt with truncated input", () => {
  it("throws when input is shorter than iv + authTag (28 bytes)", () => {
    const manager = createTestManager();
    // 20 bytes — too short to contain iv(12) + authTag(16)
    const truncated = Buffer.alloc(20).toString("base64");
    expect(() => manager.decrypt(truncated)).toThrow();
  });

  it("throws when input is exactly iv length (12 bytes)", () => {
    const manager = createTestManager();
    const truncated = Buffer.alloc(12).toString("base64");
    expect(() => manager.decrypt(truncated)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Encrypt produces different output each call (random IV)
// Validates: Requirements 2.4
// ---------------------------------------------------------------------------

describe("EncryptionManager random IV produces unique ciphertext", () => {
  it("two encryptions of the same plaintext produce different base64 outputs", () => {
    const manager = createTestManager();
    const a = manager.encrypt("same");
    const b = manager.encrypt("same");
    expect(a).not.toBe(b);
  });

  it("the first 12 bytes (IV) differ between encryptions", () => {
    const manager = createTestManager();
    const a = Buffer.from(manager.encrypt("same"), "base64");
    const b = Buffer.from(manager.encrypt("same"), "base64");
    const ivA = a.subarray(0, 12);
    const ivB = b.subarray(0, 12);
    expect(ivA.equals(ivB)).toBe(false);
  });
});

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";
import encryptionSecret from "./encryption.kms.json" with { type: "json" };

export class EncryptionManager {
  private key: Buffer | null = null;

  constructor(private readonly kms: KMSClient) {}

  async init(): Promise<void> {
    const ciphertext = Buffer.from(encryptionSecret.ciphertext, "base64");
    const result = await this.kms.send(new DecryptCommand({ CiphertextBlob: ciphertext }));
    this.key = Buffer.from(result.Plaintext!);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key!, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const encoded = Buffer.concat([iv, authTag, encrypted]).toString("base64");
    // Round-trip verify — decrypt inline (independent decipher instance) to catch encoding bugs at write time
    const buf = Buffer.from(encoded, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key!, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const verified = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf-8");
    if (verified !== plaintext) {
      throw new Error("Encryption round-trip verification failed");
    }
    return encoded;
  }

  decrypt(encoded: string): string {
    const buf = Buffer.from(encoded, "base64");
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key!, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
  }
}

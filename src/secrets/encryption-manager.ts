import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KMSClient, DecryptCommand } from "@aws-sdk/client-kms";

export class EncryptionManager {
  private key: Buffer | null = null;

  constructor(private readonly kms: KMSClient) {}

  async init(): Promise<void> {
    const ciphertext = readFileSync(resolve(import.meta.dirname!, "encryption.kms"));
    const result = await this.kms.send(new DecryptCommand({ CiphertextBlob: ciphertext }));
    this.key = Buffer.from(result.Plaintext!);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key!, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]).toString("base64");
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

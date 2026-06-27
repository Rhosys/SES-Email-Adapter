import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3"
import { ok, err } from "../errors.js"
import type { Result, DbError } from "../errors.js"
import { dbError } from "../errors.js"

export interface IEmailSignalStore {
  getOriginalEmail(s3Key: string): Promise<Result<Uint8Array, DbError>>
}

export class EmailSignalStore implements IEmailSignalStore {
  constructor(private readonly s3: S3Client, private readonly bucket: string) {}

  async getOriginalEmail(s3Key: string): Promise<Result<Uint8Array, DbError>> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }))
      return ok(await res.Body!.transformToByteArray())
    } catch (e) {
      return err(dbError(e))
    }
  }
}

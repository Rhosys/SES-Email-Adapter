// ---------------------------------------------------------------------------
// Shared embedding pipeline: S3 → MIME parse → embed text → Bedrock vector
// Used by both the inbound signal processor and the reindex worker.
// ---------------------------------------------------------------------------

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { MailparserMimeParser } from "../processor/mime.js";
import { buildEmbedText, extractEmbedTextInput } from "./embed-text.js";
import type { EmbeddingGenerator, EmbeddingResult } from "./embedding-generator.js";
import type { BedrockError, DbError, Result } from "../errors.js";
import { ok, err, dbError } from "../errors.js";

const EMAIL_BUCKET = process.env["EMAIL_BUCKET"] ?? "";

const s3 = new S3Client({});
const mimeParser = new MailparserMimeParser();

export interface GenerateEmbeddingFromS3Opts {
  s3Key: string;
  accountId: string;
  recipientAddress: string;
  modelId: string;
  embeddingGenerator: EmbeddingGenerator;
}

export async function generateEmbeddingFromS3(opts: GenerateEmbeddingFromS3Opts): Promise<Result<EmbeddingResult, DbError | BedrockError>> {
  const { s3Key, accountId, recipientAddress, modelId, embeddingGenerator } = opts;

  // 1. Fetch raw MIME from S3
  let rawBytes: Buffer;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: EMAIL_BUCKET, Key: s3Key }));
    const body = await res.Body?.transformToByteArray();
    if (!body) return err(dbError(`Empty S3 object: ${s3Key}`));
    rawBytes = Buffer.from(body);
  } catch (e) {
    return err(dbError(e));
  }

  // 2. Parse MIME
  const parseResult = await mimeParser.parseBuffer(rawBytes);
  if (parseResult.isErr()) return err(parseResult.error);
  const parsed = parseResult.value;

  // 3. Build embed text
  const embedTextInput = extractEmbedTextInput(parsed, accountId, recipientAddress);
  const embedText = buildEmbedText(embedTextInput);

  // 4. Generate embedding vector
  const result = await embeddingGenerator.generateForModel(embedText, modelId);
  if (result.isErr()) return err(result.error);

  return ok(result.value);
}

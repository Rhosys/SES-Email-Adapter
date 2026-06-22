# Design: Embed-Text Refactor

## Overview

Unify the embedding generation pipeline so both the live processor and the reindex worker use the same code path: reconstruct `ClassificationOutput` from stored signal fields → `buildEmbedText` → Bedrock vector. Eliminate the legacy S3/MIME-based path entirely.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Live Processor                            │
│  classify() → ClassificationOutput                              │
│       ↓                                                         │
│  buildEmbedText(senderDomain, classification)                   │
│       ↓                                                         │
│  generateEmbeddingFromClassification(classification,            │
│      senderDomain, embeddingGenerator, modelId)                 │
│       ↓                                                         │
│  signal.data.embeddings[modelId] = vector                       │
│  saveSignal() → DDB                                             │
│  executeAuroraUpserts() → Aurora                                │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                       Reindex Worker                             │
│  readSignal() ← DDB                                            │
│       ↓                                                         │
│  reconstructClassification(signal) → ClassificationOutput       │
│  deriveSenderDomain(signal.data.from.address)                   │
│       ↓                                                         │
│  if !force && signal.data.embeddings[modelId] exists:           │
│      upsert cached vector → Aurora                              │
│  else:                                                          │
│      generateEmbeddingFromClassification(...)                   │
│      signal.data.embeddings[modelId] = vector                   │
│      updateSignal() → DDB                                       │
│      upsert vector → Aurora                                     │
└─────────────────────────────────────────────────────────────────┘
```

## File Changes

### Modified Files

| File | Change |
|------|--------|
| `src/types/index.ts` | Add `labels: string[]` to `SignalBase`. Remove `EmbedTextInput` interface. |
| `src/embedding/embed-text.ts` | Rewrite `buildEmbedText` to accept `(senderDomain, classification)`. Delete `buildMimeEmbedText`, `extractEmbedTextInput`, `EmbedTextInput`, `sanitizeBody`, `buildBodyContent`, `reduceLinks`, `stripCss`, `stripScripts`, `stripImages`, `stripHtmlTags`, `extractReturnPathAddress`. Keep `reduceLink` (exported, tested) only if still referenced. |
| `src/processor/processor.ts` | Update `buildSignal` to set `labels` on SignalBase. Update embedding generation call to use `generateEmbeddingFromClassification`. |
| `src/database/arc-database.ts` | Default `labels` to `[]` on read when missing from DDB item. |
| `src/api/app.ts` | Add `force: z.boolean().optional().default(false)` to `/reindex` request schema. Pass through to reindex handler. |

### New Files

| File | Purpose |
|------|---------|
| `src/embedding/generate-embedding.ts` | Exports `generateEmbeddingFromClassification(classification, senderDomain, embeddingGenerator, modelId)`. Single shared function. |

### Deleted Files

| File | Reason |
|------|--------|
| `src/embedding/generate-embedding-from-s3.ts` | Dead code — S3/MIME path replaced. |

## Type Changes

### SignalBase (add `labels`)

```typescript
export interface SignalBase {
  id: string;
  signalLookupId: string;
  arcId?: string;
  gsi2pk?: string;
  accountId: string;
  source: SignalSource;
  type: SignalType;
  status: SignalStatus;
  labels: string[];       // ← NEW: full resolved label set
  createdAt: string;
  ttl?: number;
  retentionDuration?: RetentionDuration;
}
```

### buildEmbedText signature

```typescript
// Before:
export function buildEmbedText(classification: ClassificationOutput): string

// After:
export function buildEmbedText(senderDomain: string, classification: ClassificationOutput): string
```

### Embed text output format

```
marketing.stripe.com
payments
Your Stripe invoice for June is ready
system:workflow:payments,invoice
workflowData.paymentType=invoice
workflowData.vendor=Stripe
workflowData.amount=29.99
workflowData.currency=USD
```

Line order: senderDomain, workflow, summary, labels (comma-joined or empty string), then flattened workflowData key=value pairs.

### generateEmbeddingFromClassification

```typescript
import type { ClassificationOutput } from "../classifier/classifier.js";
import type { EmbeddingGenerator, EmbeddingResult } from "./embedding-generator.js";
import type { BedrockError } from "../errors.js";
import type { Result } from "neverthrow";
import { buildEmbedText } from "./embed-text.js";

export async function generateEmbeddingFromClassification(
  classification: ClassificationOutput,
  senderDomain: string,
  embeddingGenerator: EmbeddingGenerator,
  modelId: string,
): Promise<Result<EmbeddingResult, BedrockError>> {
  const embedText = buildEmbedText(senderDomain, classification);
  return embeddingGenerator.generateForModel(embedText, modelId);
}
```

## Reindex Worker Logic

```typescript
async function reindexSignal(signal: Signal, targetModelId: string, force: boolean): Promise<void> {
  // 1. Validate required fields
  const missing = getMissingClassificationFields(signal);
  if (missing.length > 0) {
    logger.error("Signal missing fields required for embedding reconstruction — skipping.", {
      code: "reindex.signal_missing_fields",
      signal,
      missingFields: missing,
    });
    return;
  }

  // 2. Reconstruct classification
  const classification: ClassificationOutput = {
    workflow: signal.data.workflow,
    workflowData: signal.data.workflowData,
    spamScore: signal.data.spamScore,
    summary: signal.data.summary,
    labels: signal.labels,
  };
  const senderDomain = signal.data.from.address.split("@")[1] ?? "";

  // 3. Check cache
  const cachedVector = signal.data.embeddings?.[targetModelId];
  if (cachedVector && !force) {
    await auroraWriter.upsertEmbedding({ ... , embedding: cachedVector });
    return;
  }

  // 4. Generate fresh vector
  const result = await generateEmbeddingFromClassification(classification, senderDomain, embeddingGenerator, targetModelId);
  if (result.isErr()) { /* log and skip */ return; }

  // 5. Save to signal + upsert to Aurora
  await arcDb.updateSignalEmbedding(signal.accountId, signal.id, targetModelId, result.value.vector);
  await auroraWriter.upsertEmbedding({ ... , embedding: result.value.vector });
}
```

## Processor Changes (labels on SignalBase)

In `buildSignal`, after rule evaluation:

```typescript
// Merge labels: system + classifier + rule-assigned (deduped)
const allLabels = [...new Set([...systemLabels, ...classificationOutput.labels, ...outcome.additionalLabels])];

const signal: Signal = {
  id: signalId,
  signalLookupId: ...,
  labels: allLabels,          // ← set on SignalBase
  ...
};
```

## Database Read-Time Default

In `ArcDatabase` read methods (getSignalById, listSignals, etc.):

```typescript
function hydrateSignal(item: Record<string, unknown>): Signal {
  return {
    ...item,
    labels: (item.labels as string[] | undefined) ?? [],
  } as Signal;
}
```

## Alignment Test

```typescript
it("signal built by buildSignal can reconstruct a valid ClassificationOutput", () => {
  const classification: ClassificationOutput = {
    workflow: "payments",
    workflowData: { workflow: "payments", paymentType: "invoice", vendor: "Stripe" },
    spamScore: 0.05,
    summary: "Stripe invoice for June",
    labels: ["invoices"],
  };

  const signal = buildSignal({ ..., classification, ... });

  const reconstructed: ClassificationOutput = {
    workflow: signal.data.workflow,
    workflowData: signal.data.workflowData,
    spamScore: signal.data.spamScore,
    summary: signal.data.summary,
    labels: signal.labels,
  };

  expect(reconstructed).toEqual(classification);
});
```

## Migration Strategy

- No data migration needed. Old signals missing `labels` get `[]` at read-time.
- Existing cached embeddings in `signal.data.embeddings` remain valid — they drift naturally until a `force: true` reindex is run.
- No S3 access removed from IAM — other parts of the Lambda still read from S3 (MIME parsing for classification, attachment serving).

## Decisions

| Decision | Rationale |
|----------|-----------|
| No backfill of labels on old signals | Classifier labels were never persisted — cannot reconstruct them. `[]` is the honest default. |
| No immediate reindex on format change | Vectors drift and align on next model migration. Avoids expensive bulk Bedrock calls. |
| `force` is a boolean | Exception per 012-API rule — semantics are unambiguous "ignore cache." |
| Sender domain is full domain, not eTLD+1 | More context for embedding similarity — doesn't prevent cross-subdomain matches. |
| Aurora write not inside shared function | Shared function returns the vector. Caller decides storage. Live path stores on signal + Aurora. Reindex stores on signal + Aurora with its own write pattern. |

# ADR-001: Self-managed Aurora pgvector over Bedrock Knowledge Bases

**Date:** 2026-05-11  
**Status:** Accepted  
**Deciders:** Warren  

## Context

The email-catcher backend uses vector embeddings for arc threading — matching incoming email signals to existing conversation arcs by semantic similarity. The current architecture:

- **Embedding generation:** Bedrock `InvokeModel` with Amazon Titan Embed Text v2 (1024 dimensions)
- **Vector storage:** Aurora Serverless v2 with pgvector extension, accessed via RDS Data API
- **Multi-tenancy:** Row-level security (RLS) scoped per account + recipient address, enforced inside transactions
- **Write pattern:** Real-time upsert on every incoming signal (not batch)
- **Read pattern:** Nearest-neighbour search scoped to account + recipient, returning the best-matching arc ID

The question was whether AWS Bedrock Knowledge Bases — a managed RAG service that handles ingestion, chunking, embedding, storage, and retrieval as a unified pipeline — would be a better fit than the self-managed approach.

## Decision

Keep the self-managed Aurora pgvector architecture. Do not adopt Bedrock Knowledge Bases for arc threading.

## Rationale

### 1. Use case mismatch

Bedrock Knowledge Bases is designed for document-corpus RAG: batch-ingest files from S3, chunk them, embed them, then answer natural-language questions against the corpus. Our use case is real-time signal-to-arc matching — every inbound email generates an embedding and upserts immediately. Knowledge Bases has no real-time per-message upsert path; it expects periodic sync jobs against an S3 data source.

### 2. Custom embedding input

`buildEmbedText` constructs a purpose-built text representation for embedding: structured headers (account, sender, recipient, subject) + sanitized body (CSS stripped, HTML removed, links reduced to domain + first path segment, truncated to 4000 chars). Knowledge Bases owns the chunking and embedding step — adopting it would mean surrendering control over what text gets embedded, which directly affects match quality.

### 3. Multi-tenant isolation already solved

The Aurora writer enforces RLS via `SET LOCAL` inside each transaction, scoping all reads and writes to a specific account + recipient address. Bedrock Knowledge Bases offers metadata filtering at query time, but this is a weaker guarantee than database-level row-level security. Switching would be a security regression.

### 4. Cost argument doesn't apply

The primary cost motivation for Knowledge Bases + Aurora (vs Knowledge Bases + OpenSearch Serverless) is avoiding the ~$700/month AOSS floor. We already use Aurora directly — there is no OpenSearch cost to eliminate. Adding Knowledge Bases on top of our existing Aurora cluster would add managed-service overhead without reducing spend.

### 5. Operational simplicity

The current stack has exactly two moving parts for embeddings: a Bedrock `InvokeModel` call and an RDS Data API transaction. Adding Knowledge Bases introduces a third service with its own ingestion jobs, sync state, IAM roles, and failure modes — complexity without corresponding benefit.

## Alternatives Considered

| Option | Verdict |
|--------|---------|
| **Bedrock Knowledge Bases with Aurora backing store** | Adds managed orchestration on top of infrastructure we already own. No benefit for real-time upsert workloads. |
| **Bedrock Knowledge Bases with OpenSearch Serverless** | $700/month floor for a workload that fits in 0.5 ACU. Massive cost regression. |
| **Amazon S3 Vectors** | New (2025) serverless vector store. Designed for batch RAG, not real-time per-signal upserts. Same use-case mismatch as Knowledge Bases. |

## Consequences

- Arc threading continues to use the existing `BedrockEmbeddingGenerator` → `MultiClusterAuroraWriter` pipeline.
- No infrastructure changes required.
- If a future **semantic search** feature is added (natural-language queries across email history), that feature should be evaluated independently — it may benefit from Knowledge Bases or a dedicated search index, since its access pattern (user query → retrieve relevant chunks → LLM synthesis) matches the managed RAG model. That decision is deferred until the feature is scoped.

## References

- [Aurora PostgreSQL as a Knowledge Base for Bedrock](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.VectorDB.html)
- [Multi-tenant vector search with Aurora PostgreSQL and Bedrock Knowledge Bases](https://aws.amazon.com/blogs/database/multi-tenant-vector-search-with-amazon-aurora-postgresql-and-amazon-bedrock-knowledge-bases/) (Feb 2025)
- [Cost comparison: AOSS vs Aurora pgvector](https://ercanermis.com/cutting-amazon-bedrock-knowledge-base-costs-by-90-migrating-from-opensearch-serverless-to-aurora-serverless-v2-with-pgvector/) (Feb 2026)

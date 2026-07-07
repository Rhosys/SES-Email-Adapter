// ---------------------------------------------------------------------------
// Drizzle schema — single source of truth for the Aurora PostgreSQL schema.
// Runtime queries and drizzle-kit migrations both derive from this file.
// ---------------------------------------------------------------------------

import { pgTable, text, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { vector } from "drizzle-orm/pg-core";

export const threadEmbeddings = pgTable("thread_embeddings", {
  signalId: text("signal_id").notNull(),
  threadId: text("thread_id").notNull(),
  accountId: text("account_id").notNull(),
  recipientAddress: text("recipient_address").notNull(),
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.signalId, table.threadId, table.accountId, table.recipientAddress] }),
  index("thread_embeddings_hnsw_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
]);

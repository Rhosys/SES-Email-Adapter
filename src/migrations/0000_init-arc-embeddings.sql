-- Custom: pgvector extension (must exist before vector column types are used)
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "arc_embeddings" (
	"arc_id" text NOT NULL,
	"account_id" text NOT NULL,
	"recipient_address" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arc_embeddings_arc_id_account_id_recipient_address_pk" PRIMARY KEY("arc_id","account_id","recipient_address")
);
--> statement-breakpoint
CREATE INDEX "arc_embeddings_hnsw_idx" ON "arc_embeddings" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
-- Custom: Row-Level Security for tenant isolation
ALTER TABLE "arc_embeddings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "arc_embeddings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY arc_tenant_isolation ON arc_embeddings
    USING (account_id = current_setting('app.current_account_id', true))
    WITH CHECK (account_id = current_setting('app.current_account_id', true));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
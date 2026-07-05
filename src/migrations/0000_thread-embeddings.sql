CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "thread_embeddings" (
	"thread_id" text NOT NULL,
	"account_id" text NOT NULL,
	"recipient_address" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_embeddings_thread_id_account_id_recipient_address_pk" PRIMARY KEY("thread_id","account_id","recipient_address")
);
--> statement-breakpoint
CREATE INDEX "thread_embeddings_hnsw_idx" ON "thread_embeddings" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
ALTER TABLE "thread_embeddings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "thread_embeddings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY thread_tenant_isolation ON thread_embeddings
    USING (account_id = current_setting('app.current_account_id', true))
    WITH CHECK (account_id = current_setting('app.current_account_id', true));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_cron;
--> statement-breakpoint
SELECT cron.schedule(
  'thread_embeddings_ttl',
  '0 6 * * *',
  $$DELETE FROM thread_embeddings WHERE updated_at < NOW() - INTERVAL '5 years'$$
);

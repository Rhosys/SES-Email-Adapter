ALTER TABLE "thread_embeddings" ADD COLUMN "expires_at" timestamp with time zone DEFAULT NOW() + INTERVAL '2 years';
--> statement-breakpoint
SELECT cron.unschedule('thread_embeddings_ttl');
--> statement-breakpoint
SELECT cron.schedule(
  'thread_embeddings_ttl',
  '0 6 * * *',
  $$DELETE FROM thread_embeddings WHERE expires_at < NOW() OR expires_at IS NULL$$
);

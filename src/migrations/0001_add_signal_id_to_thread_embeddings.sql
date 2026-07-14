-- Add signal_id to thread_embeddings and fold it into the primary key so a single
-- thread/recipient can hold one embedding row per signal (see src/database/schema.ts).
-- Statement order matters: the column must exist and be populated before it can be
-- marked NOT NULL and pulled into the primary key.

-- Add nullable first so existing rows don't violate NOT NULL.
ALTER TABLE "thread_embeddings" ADD COLUMN "signal_id" text;--> statement-breakpoint

-- Backfill pre-existing rows (written before per-signal tracking). The old primary key
-- (thread_id, account_id, recipient_address) was already unique, so a constant keeps the
-- new four-column key unique for legacy rows.
UPDATE "thread_embeddings" SET "signal_id" = 'legacy' WHERE "signal_id" IS NULL;--> statement-breakpoint

ALTER TABLE "thread_embeddings" ALTER COLUMN "signal_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "thread_embeddings" DROP CONSTRAINT "thread_embeddings_thread_id_account_id_recipient_address_pk";--> statement-breakpoint

ALTER TABLE "thread_embeddings" ADD CONSTRAINT "thread_embeddings_signal_id_thread_id_account_id_recipient_address_pk" PRIMARY KEY("signal_id","thread_id","account_id","recipient_address");

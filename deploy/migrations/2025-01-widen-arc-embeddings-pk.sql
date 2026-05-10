-- Migration: Widen arc_embeddings primary key for multi-cluster support
-- 
-- This migration changes the primary key from (arc_id) to (arc_id, account_id, recipient_address)
-- to support multiple Aurora clusters with different embedding models.
--
-- Idempotent: This script safely runs multiple times. It checks if the composite PK already
-- exists before attempting the change.
--
-- Dependencies: pgvector extension must be installed (handled by terraform_data.pgvector_init)

-- Step 1: Drop the existing primary key if it exists (single-column arc_id)
DO $$
BEGIN
    -- Check if the current primary key is the old single-column arc_id
    IF EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
        WHERE tc.table_name = 'arc_embeddings'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'arc_id'
          AND kcu.position_in_unique_constraint IS NULL
    ) THEN
        -- Drop the old primary key constraint
        ALTER TABLE arc_embeddings DROP CONSTRAINT arc_embeddings_pkey;
    END IF;
END $$;

-- Step 2: Add the new composite primary key
-- This will fail if the table already has the composite PK (idempotent)
DO $$
BEGIN
    -- Check if the composite primary key already exists
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
        WHERE tc.table_name = 'arc_embeddings'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.column_name = 'arc_id'
          AND kcu.position_in_unique_constraint IS NULL
    ) THEN
        -- Add the composite primary key
        ALTER TABLE arc_embeddings 
        ADD PRIMARY KEY (arc_id, account_id, recipient_address);
    END IF;
END $$;

-- Step 3: Rebuild HNSW index if it exists (it should survive the PK change, but rebuild to be safe)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE tablename = 'arc_embeddings' 
        AND indexname = 'arc_embeddings_embedding_idx'
    ) THEN
        -- Drop and recreate the HNSW index
        DROP INDEX IF EXISTS arc_embeddings_embedding_idx;
        CREATE INDEX arc_embeddings_embedding_idx 
        ON arc_embeddings USING hnsw (embedding vector_cosine_ops);
    END IF;
END $$;

-- Step 4: Ensure RLS is enabled and policy exists
DO $$
BEGIN
    -- Enable RLS if not already enabled
    IF NOT EXISTS (
        SELECT 1 FROM pg_tables 
        WHERE tablename = 'arc_embeddings' 
        AND rowsecurity = true
    ) THEN
        ALTER TABLE arc_embeddings ENABLE ROW LEVEL SECURITY;
        ALTER TABLE arc_embeddings FORCE ROW LEVEL SECURITY;
    END IF;
    
    -- Recreate the RLS policy if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'arc_embeddings' 
        AND policyname = 'arc_tenant_isolation'
    ) THEN
        DROP POLICY IF EXISTS arc_tenant_isolation ON arc_embeddings;
        CREATE POLICY arc_tenant_isolation ON arc_embeddings
            USING (account_id = current_setting('app.current_account_id', true))
            WITH CHECK (account_id = current_setting('app.current_account_id', true));
    END IF;
END $$;

import { Pool } from "pg";
import type { ArcMatcher } from "../processor/processor.js";
import type { Arc } from "../types/index.js";

const SIMILARITY_THRESHOLD = 0.5; // cosine distance — lower = more similar; 0.5 ≈ 75% cosine similarity

// Pool is created lazily and reused across warm Lambda invocations.
// Max 2 connections per instance to avoid exhausting the RDS Proxy pool under concurrent invocations.
let _pool: Pool | null = null;

function getPool(): Pool {
  if (_pool) return _pool;
  _pool = new Pool({
    host: process.env["RDS_PROXY_ENDPOINT"],
    database: process.env["AURORA_DB_NAME"] ?? "signals",
    user: process.env["DB_USER"] ?? "lambda",
    password: process.env["DB_PASSWORD"],
    port: 5432,
    ssl: { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  _pool.on("error", (err) => {
    console.error("pgvector pool error:", err);
    _pool = null; // force reconnect on next call
  });
  return _pool;
}

export class PgvectorArcMatcher implements ArcMatcher {
  async findMatch(accountId: string, recipientAddress: string, embedding: number[]): Promise<Arc | null> {
    const pool = getPool();
    const vectorLiteral = `[${embedding.join(",")}]`;

    const res = await pool.query<{ arc_id: string }>(
      `SELECT arc_id
       FROM arc_embeddings
       WHERE account_id = $1 AND recipient_address = $2
         AND embedding <=> $3::vector < $4
       ORDER BY embedding <=> $3::vector
       LIMIT 1`,
      [accountId, recipientAddress, vectorLiteral, SIMILARITY_THRESHOLD],
    );

    return res.rows[0] ? ({ id: res.rows[0].arc_id } as Arc) : null;
  }

  async upsertEmbedding(arcId: string, embedding: number[], accountId: string, recipientAddress: string): Promise<void> {
    const pool = getPool();
    const vectorLiteral = `[${embedding.join(",")}]`;

    await pool.query(
      `INSERT INTO arc_embeddings (arc_id, account_id, recipient_address, embedding, updated_at)
       VALUES ($1, $2, $3, $4::vector, NOW())
       ON CONFLICT (arc_id) DO UPDATE
         SET embedding = EXCLUDED.embedding,
             updated_at = NOW()`,
      [arcId, accountId, recipientAddress, vectorLiteral],
    );
  }
}

const DEFAULT_D1_BATCH_SIZE = 100;

/**
 * Executes D1 write statements atomically via `db.batch()` when available,
 * chunking large batches to stay within D1 statement-per-batch limits.
 */
export async function runD1Batch(
  db: D1Database,
  statements: D1PreparedStatement[],
  chunkSize = DEFAULT_D1_BATCH_SIZE,
): Promise<void> {
  if (statements.length === 0) {
    return;
  }

  const batchFn = (db as { batch?: (stmts: D1PreparedStatement[]) => Promise<unknown> }).batch;
  if (typeof batchFn === "function") {
    for (let index = 0; index < statements.length; index += chunkSize) {
      await batchFn.call(db, statements.slice(index, index + chunkSize));
    }
    return;
  }

  for (const statement of statements) {
    await statement.run();
  }
}

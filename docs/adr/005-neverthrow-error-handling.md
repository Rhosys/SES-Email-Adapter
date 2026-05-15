# ADR-005: neverthrow for Typed Error Handling

**Date:** 2026-05-11  
**Status:** Accepted  
**Deciders:** Warren  

## Context

The codebase uses traditional throw/catch patterns exclusively. Database methods let SDK errors bubble as unhandled rejections. The processor uses `.catch()` for fire-and-forget side effects. The API layer has no try/catch around store calls — unhandled errors become 500s. Error handling is implicit, inconsistent, and invisible at the type level.

`neverthrow` is listed as a project dependency but has zero usage.

## Decision

Adopt `neverthrow` `Result` and `ResultAsync` types as the standard error handling mechanism across the entire codebase.

## Rules

### 1. No throwing, no catching

Functions return `Result<T, E>` or `ResultAsync<T, E>`. Callers check `isErr()` explicitly.

### 2. No `.andThen()` chaining

Use explicit sequential checks:

```ts
const configResult = await store.getAccount(accountId);
if (configResult.isErr()) return err(configResult.error);
const config = configResult.value;

const parseResult = await mime.parse(s3Key);
if (parseResult.isErr()) return err(parseResult.error);
const parsed = parseResult.value;
```

Never use fluent chaining (`.andThen()`, `.map()`, `.mapErr()`). Each step is one line of work, one line of error check, one line of unwrap. Reads top to bottom.

### 3. No `.catch()`, no fire-and-forget

Every operation that can fail returns a Result. The caller handles the error explicitly — at minimum by logging at TRACK or ERROR level:

```ts
const notifyResult = await notifier.notifyBlocked(accountId, signal);
if (notifyResult.isErr()) {
  log("track", "notification_failed", { accountId, error: notifyResult.error });
}
```

There is no fire-and-forget. Every failure is visible.

### 4. Error types are standalone, named by their kind

Each error type is a single shape. The type name matches the `kind` value conceptually — no indirection.

```ts
type DbError = { kind: "db_error"; cause: Error };
type NotFoundError = { kind: "not_found"; resource: string; id: string };
type InvalidResponseError = { kind: "invalid_response" };
type ProcessError = { kind: "process_error"; messageId: string };
```

There are no composite error types like `ClassifyError` or `EmbedError`. Unions only exist inline at the return type:

```ts
renameAlias(accountId, old, new): ResultAsync<Alias, DbError | NotFoundError>
classify(input): ResultAsync<Classification, DbError | InvalidResponseError>
```

Never define a named type for a union of errors — the union lives at the call site.

### 5. Null is a success case for reads

Database read methods return `ResultAsync<T | null, DbError>`. Null means "not found" — that's a valid query result, not an error. The caller decides what null means in context (404 in an API route, skip in the processor).

### 6. NotFoundError is for mutations requiring existing resources

When a mutation requires a resource to exist (e.g. `renameAlias`), the method returns `ResultAsync<T, DbError | NotFoundError>`. The caller handles `not_found` explicitly — in an API route that's a 404, in a migration script it might be a skip-and-log.

### 7. SQS batch processing uses Results explicitly

The batch handler collects Results and builds `batchItemFailures` from the error cases. No throwing, no catching:

```ts
const results = await Promise.all(records.map(r => processRecord(r)));
const failures: { itemIdentifier: string }[] = [];
for (const r of results) {
  if (r.isErr()) {
    log("error", "processor.signal.failed", { messageId: r.error.messageId });
    failures.push({ itemIdentifier: r.error.messageId });
  }
}
return { batchItemFailures: failures };
```

### 8. API routes unwrap inline

Route handlers call store methods, check `isErr()`, and return HTTP responses directly. No global error middleware, no error-to-response mapping layer:

```ts
app.get("/accounts/:accountId/arcs/:id", async (c) => {
  const { accountId } = c.get("auth");
  const arcResult = await store.getArc(accountId, c.req.param("id"));
  if (arcResult.isErr()) return err(c, 500, "Internal Server Error");
  const arc = arcResult.value;
  if (!arc) return err(c, 404, "Arc not found", "ARC_NOT_FOUND");
  return c.json(arc);
});
```

### 9. No exceptions anywhere

Every function returns `Result` or `ResultAsync`. The TypeScript type system enforces that callers handle errors — if a function returns `Result<T, E>`, the caller must check `isErr()` before accessing the value. This applies to middleware, auth services, and all other code equally.

## Consequences

- Every function signature communicates its failure modes at the type level.
- No unhandled rejections — SDK errors are caught at the boundary (inside database/service methods) and wrapped as typed errors.
- Code reviewers can see every error path by reading the function linearly.
- The `.catch()` pattern is eliminated entirely.
- Test assertions become simpler — assert `isOk()` or `isErr()` with specific error kinds rather than `expect(...).rejects.toThrow()`.
- Slightly more verbose code (3 lines per fallible operation instead of 1), but every failure point is visible and intentional.

## References

- [neverthrow documentation](https://github.com/supermacro/neverthrow)

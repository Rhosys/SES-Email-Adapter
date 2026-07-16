import { describe, it, expect } from "vitest";
import { dbError, notFoundError, invalidResponseError, isSchemaMismatchError } from "../src/errors.js";

describe("Error type constructors produce correct kind fields", () => {
  it("dbError wraps an Error with kind 'db_error'", () => {
    const cause = new Error("connection timeout");
    const result = dbError(cause);
    expect(result.kind).toBe("db_error");
    expect(result.cause).toBe(cause);
    expect(result.cause).toBeInstanceOf(Error);
  });

  it("notFoundError stores resource and id with kind 'not_found'", () => {
    const result = notFoundError("account", "acc_123");
    expect(result.kind).toBe("not_found");
    expect(result.resource).toBe("account");
    expect(result.id).toBe("acc_123");
  });

  it("invalidResponseError produces a singleton object with kind 'invalid_response'", () => {
    const result = invalidResponseError();
    expect(result.kind).toBe("invalid_response");
    expect(Object.keys(result)).toEqual(["kind"]);
  });
});

describe("dbError schema-mismatch classification", () => {
  it("flags a missing-column error (the thread_embeddings signal_id drift) as schemaMismatch", () => {
    const cause = new Error('ERROR: column "signal_id" of relation "thread_embeddings" does not exist');
    expect(dbError(cause).schemaMismatch).toBe(true);
  });

  it("flags a missing-relation error as schemaMismatch", () => {
    expect(dbError(new Error('relation "thread_embeddings" does not exist')).schemaMismatch).toBe(true);
  });

  it("does NOT flag connectivity/transient errors as schemaMismatch", () => {
    expect(dbError(new Error("Connection reset by peer")).schemaMismatch).toBeUndefined();
    expect(dbError(new Error("resuming after being auto-paused")).schemaMismatch).toBeUndefined();
    expect(dbError(new Error("statement timeout")).schemaMismatch).toBeUndefined();
  });

  it("does NOT flag data-integrity errors (e.g. NOT NULL / unique violations) as schemaMismatch", () => {
    expect(dbError(new Error('null value in column "signal_id" violates not-null constraint')).schemaMismatch).toBeUndefined();
    expect(dbError(new Error("duplicate key value violates unique constraint")).schemaMismatch).toBeUndefined();
  });

  it("isSchemaMismatchError matches missing-object messages and rejects others", () => {
    expect(isSchemaMismatchError('column "x" does not exist')).toBe(true);
    expect(isSchemaMismatchError('type "vector" does not exist')).toBe(true);
    expect(isSchemaMismatchError("Connection reset")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { dbError, notFoundError, invalidResponseError, isSchemaMismatchError, errorMessage, processorError } from "../src/errors.js";

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

describe("errorMessage walks the error tree without JSON.stringify", () => {
  it("returns the message for a plain Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("returns the message field for our plain-object error kinds", () => {
    expect(errorMessage(dbError(new Error("connection timeout")))).toBe("connection timeout");
  });

  it("uses errorName and nested cause for SES-style kinds that have no top-level message", () => {
    const transient = { kind: "transient_ses_error", errorName: "BadRequestException", httpStatus: 400, cause: { message: "Header <Content-Type> is not supported" } };
    expect(errorMessage(transient)).toBe("BadRequestException: Header <Content-Type> is not supported");
  });

  it("walks a ProcessorError over an AggregateError of SES errors into a full joined path", () => {
    const transient = { kind: "transient_ses_error", errorName: "BadRequestException", httpStatus: 400, cause: { message: "Header <Content-Type> is not supported" } };
    const aggregate = new AggregateError([transient], "1 critical side-effect failure");
    const error = processorError(aggregate);

    // Full path: outer summary, then the SES branch — no duplicated summary, no JSON dump.
    expect(errorMessage(error)).toBe("1 critical side-effect failure: BadRequestException: Header <Content-Type> is not supported");
    expect(errorMessage(error)).not.toContain("{");
  });

  it("joins multiple aggregate children with the —— separator", () => {
    const a = { kind: "transient_ses_error", errorName: "Throttling", httpStatus: 429, cause: { message: "rate exceeded" } };
    const b = { kind: "transient_ses_error", errorName: "BadRequestException", httpStatus: 400, cause: { message: "bad header" } };
    const error = processorError(new AggregateError([a, b], "2 critical side-effect failures"));
    expect(errorMessage(error)).toBe("2 critical side-effect failures: Throttling: rate exceeded —— BadRequestException: bad header");
  });

  it("falls back to kind, never a raw dump, when no readable message exists", () => {
    expect(errorMessage({ kind: "invalid_response" })).toBe("invalid_response");
    expect(errorMessage(12345)).toBe("unknown error");
  });
});

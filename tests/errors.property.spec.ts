import { describe, it, expect } from "vitest";
import { dbError, notFoundError, invalidResponseError } from "../src/errors.js";

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

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { propertyRunner } from "./testing/property-runner.js";
import { dbError, notFoundError, invalidResponseError, processError } from "./errors.js";

// ---------------------------------------------------------------------------
// Property 1: Database boundary completeness (partial — type shape validation)
// Verify each constructor produces an object with the correct `kind` field
// Verify `DbError.cause` is always an `Error` instance
// **Validates: Requirements 1.6**
// ---------------------------------------------------------------------------

describe("Property 1: Error type kind field consistency", () => {
  it("dbError(cause) always produces { kind: 'db_error', cause } where cause is an Error", async () => {
    const arbError = fc.string({ minLength: 0, maxLength: 200 }).map((msg) => new Error(msg));

    await propertyRunner.assert(
      fc.asyncProperty(arbError, async (cause) => {
        const result = dbError(cause);
        expect(result.kind).toBe("db_error");
        expect(result.cause).toBe(cause);
        expect(result.cause).toBeInstanceOf(Error);
      }),
    );
  });

  it("notFoundError(resource, id) always produces { kind: 'not_found', resource, id }", async () => {
    const arbResource = fc.string({ minLength: 1, maxLength: 100 });
    const arbId = fc.string({ minLength: 1, maxLength: 100 });

    await propertyRunner.assert(
      fc.asyncProperty(arbResource, arbId, async (resource, id) => {
        const result = notFoundError(resource, id);
        expect(result.kind).toBe("not_found");
        expect(result.resource).toBe(resource);
        expect(result.id).toBe(id);
      }),
    );
  });

  it("invalidResponseError() always produces { kind: 'invalid_response' }", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const result = invalidResponseError();
        expect(result.kind).toBe("invalid_response");
        expect(Object.keys(result)).toEqual(["kind"]);
      }),
    );
  });

  it("processError(messageId) always produces { kind: 'process_error', messageId }", async () => {
    const arbMessageId = fc.string({ minLength: 1, maxLength: 100 });

    await propertyRunner.assert(
      fc.asyncProperty(arbMessageId, async (messageId) => {
        const result = processError(messageId);
        expect(result.kind).toBe("process_error");
        expect(result.messageId).toBe(messageId);
      }),
    );
  });
});

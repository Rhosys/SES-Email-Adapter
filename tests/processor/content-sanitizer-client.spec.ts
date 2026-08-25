import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { LambdaClient as AwsLambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { LambdaContentSanitizer } from "../../src/processor/content-sanitizer-client.js";
import type { ContentSanitizeRequest } from "../../src/processor/content-sanitizer-client.js";
import { createMockLogger } from "../helpers/mock-logger.js";

const lambdaMock = mockClient(AwsLambdaClient);

const FUNCTION_ARN = "arn:aws:lambda:eu-central-1:123456789012:function:content-sanitizer";

const REQUEST: ContentSanitizeRequest = {
  presignedGetUrl: "https://example.com/get",
  presignedPost: { url: "https://example.com/post", fields: {} },
  accountId: "acc-123",
  senderEtld1: "example.com",
  keyPrefix: "prefix/",
  retentionTag: "365",
};

// InvokeCommandOutput's Payload is typed as IUint8ArrayBlobAdapter (adds transformToString());
// the client under test only ever calls TextDecoder().decode() on it, so a plain Uint8Array
// with a stub transformToString satisfies both the runtime and compile-time contract.
function payloadFrom(obj: unknown): Uint8Array & { transformToString(): string } {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return Object.assign(bytes, { transformToString: () => JSON.stringify(obj) });
}

describe("LambdaContentSanitizer", () => {
  let client: LambdaContentSanitizer;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    lambdaMock.reset();
    logger = createMockLogger();
    client = new LambdaContentSanitizer(new AwsLambdaClient({}), FUNCTION_ARN, logger);
  });

  afterEach(() => {
    lambdaMock.restore();
  });

  it("strips the per-invocation RequestId from a sandbox timeout error so the message can be aggregated", async () => {
    lambdaMock.on(InvokeCommand).resolves({
      FunctionError: "Unhandled",
      Payload: payloadFrom({
        errorType: "Sandbox.Timedout",
        errorMessage: "RequestId: 0fdb18b6-f166-4949-b101-e5e2e495fe54 Error: Task timed out after 10.00 seconds",
      }),
    });

    const result = await client.invoke(REQUEST);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe("Content Sanitizer Lambda error: Unhandled — Sandbox.Timedout: Error: Task timed out after 10.00 seconds");
      expect(result.error.message).not.toContain("0fdb18b6-f166-4949-b101-e5e2e495fe54");
    }
  });

  it("passes through an errorMessage with no embedded RequestId unchanged", async () => {
    lambdaMock.on(InvokeCommand).resolves({
      FunctionError: "Unhandled",
      Payload: payloadFrom({
        errorType: "Error",
        errorMessage: "Something went wrong",
      }),
    });

    const result = await client.invoke(REQUEST);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe("Content Sanitizer Lambda error: Unhandled — Error: Something went wrong");
    }
  });
});

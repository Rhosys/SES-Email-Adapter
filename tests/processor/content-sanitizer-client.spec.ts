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

  it("moves the per-invocation RequestId out of the message and into a structured field", async () => {
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
      expect(result.error.message).toBe("Content Sanitizer Lambda error (vunknown): Unhandled — Sandbox.Timedout: Error: Task timed out after 10.00 seconds");
      expect(result.error.message).not.toContain("0fdb18b6-f166-4949-b101-e5e2e495fe54");
      expect(result.error.lambdaRequestId).toBe("0fdb18b6-f166-4949-b101-e5e2e495fe54");
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
      expect(result.error.message).toBe("Content Sanitizer Lambda error (vunknown): Unhandled — Error: Something went wrong");
      expect(result.error.lambdaRequestId).toBeUndefined();
    }
  });

  it("logs an immediate ERROR when the sanitizer runs out of memory", async () => {
    lambdaMock.on(InvokeCommand).resolves({
      FunctionError: "Unhandled",
      ExecutedVersion: "$LATEST",
      Payload: payloadFrom({
        errorType: "Runtime.OutOfMemory",
        errorMessage: "RequestId: 0fdb18b6-f166-4949-b101-e5e2e495fe54 Error: Runtime exited with error: signal: killed",
      }),
    });

    const result = await client.invoke(REQUEST);

    expect(result.isErr()).toBe(true);
    const errors = logger.calls.filter(c => c.method === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("ran out of memory");
    expect(errors[0]!.context).toMatchObject({ code: "content_sanitizer.out_of_memory", accountId: "acc-123", lambdaRequestId: "0fdb18b6-f166-4949-b101-e5e2e495fe54" });
  });

  it("does not log an out-of-memory ERROR for other unhandled errors", async () => {
    lambdaMock.on(InvokeCommand).resolves({
      FunctionError: "Unhandled",
      Payload: payloadFrom({ errorType: "Error", errorMessage: "Something went wrong" }),
    });

    await client.invoke(REQUEST);

    expect(logger.calls.filter(c => c.method === "error")).toHaveLength(0);
  });

  it("WARNs when reported memory usage is above 60% of the limit", async () => {
    lambdaMock.on(InvokeCommand).resolves({
      Payload: payloadFrom({ success: true, parsed: { from: { address: "a@b.c" }, to: [], cc: [], subject: "", attachments: [], headers: {} }, memory: { maxRssMb: 160, limitMb: 256 } }),
    });

    const result = await client.invoke(REQUEST);

    expect(result.isOk()).toBe(true);
    const warns = logger.calls.filter(c => c.method === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("160MB");
    expect(warns[0]!.context).toMatchObject({ code: "content_sanitizer.high_memory_usage", maxRssMb: 160, limitMb: 256 });
  });

  it("WARNs on high memory usage even when the sanitizer returns a handled error", async () => {
    lambdaMock.on(InvokeCommand).resolves({
      Payload: payloadFrom({ success: false, error: { message: "bad", type: "parse_error" }, memory: { maxRssMb: 200, limitMb: 256 } }),
    });

    const result = await client.invoke(REQUEST);

    expect(result.isErr()).toBe(true);
    expect(logger.calls.filter(c => c.method === "warn")[0]?.context).toMatchObject({ code: "content_sanitizer.high_memory_usage" });
  });

  it("does not WARN when memory usage is at or below 60% of the limit", async () => {
    lambdaMock.on(InvokeCommand).resolves({
      Payload: payloadFrom({ success: true, parsed: { from: { address: "a@b.c" }, to: [], cc: [], subject: "", attachments: [], headers: {} }, memory: { maxRssMb: 150, limitMb: 256 } }),
    });

    await client.invoke(REQUEST);

    expect(logger.calls.filter(c => c.method === "warn")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for job-dispatch-handler
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { handleJobDispatch, type JobDispatcher } from "./job-dispatch-handler.js";
import { ok, err, notFoundError } from "../errors.js";

// ---------------------------------------------------------------------------
// Mock dispatcher
// ---------------------------------------------------------------------------

function createMockDispatcher(): JobDispatcher & { dispatch: ReturnType<typeof vi.fn>; getReport: ReturnType<typeof vi.fn> } {
  return {
    dispatch: vi.fn(),
    getReport: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: {
  method?: string;
  path?: string;
  body?: string | null;
  pathParams?: Record<string, string>;
  isBase64Encoded?: boolean;
}): APIGatewayProxyEventV2 {
  const { method = "GET", path = "/", body = null, pathParams, isBase64Encoded = false } = overrides;
  return {
    version: "2.0",
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: { "content-type": "application/json" },
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: "api.example.com",
      domainPrefix: "api",
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
      requestId: "req-id",
      routeKey: `${method} ${path}`,
      stage: "$default",
      time: "01/Jan/2025:00:00:00 +0000",
      timeEpoch: 1735689600000,
    },
    body: body ?? undefined,
    isBase64Encoded,
    pathParameters: pathParams ?? undefined,
  } as unknown as APIGatewayProxyEventV2;
}

/** Narrows APIGatewayProxyResultV2 to the structured variant (always returned by handleJobDispatch). */
async function dispatch(event: APIGatewayProxyEventV2, d: JobDispatcher): Promise<APIGatewayProxyStructuredResultV2> {
  return await handleJobDispatch(event, d) as APIGatewayProxyStructuredResultV2;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleJobDispatch", () => {
  let dispatcher: ReturnType<typeof createMockDispatcher>;

  beforeEach(() => {
    dispatcher = createMockDispatcher();
  });

  // -------------------------------------------------------------------------
  // POST /reindex — validation
  // -------------------------------------------------------------------------

  describe("POST /reindex", () => {
    it("returns 400 when body is not valid JSON", async () => {
      const event = makeEvent({ method: "POST", path: "/reindex", body: "not json" });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body as string).title).toContain("Invalid JSON");
    });

    it("returns 400 when targetRegistryId is missing", async () => {
      const event = makeEvent({ method: "POST", path: "/reindex", body: JSON.stringify({}) });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body as string).title).toContain("targetRegistryId");
    });

    it("returns 400 when targetRegistryId is not a string", async () => {
      const event = makeEvent({ method: "POST", path: "/reindex", body: JSON.stringify({ targetRegistryId: 123 }) });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body as string).title).toContain("targetRegistryId");
    });

    it("returns 400 when targetRegistryId is empty string", async () => {
      const event = makeEvent({ method: "POST", path: "/reindex", body: JSON.stringify({ targetRegistryId: "" }) });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body as string).title).toContain("targetRegistryId");
    });

    it("returns 400 when segmentCount is below 1", async () => {
      const event = makeEvent({
        method: "POST",
        path: "/reindex",
        body: JSON.stringify({ targetRegistryId: "cluster-1", segmentCount: 0 }),
      });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body as string).title).toContain("between 1 and 256");
    });

    it("returns 400 when segmentCount is above 256", async () => {
      const event = makeEvent({
        method: "POST",
        path: "/reindex",
        body: JSON.stringify({ targetRegistryId: "cluster-1", segmentCount: 257 }),
      });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body as string).title).toContain("between 1 and 256");
    });

    it("returns 400 when segmentCount is not an integer", async () => {
      const event = makeEvent({
        method: "POST",
        path: "/reindex",
        body: JSON.stringify({ targetRegistryId: "cluster-1", segmentCount: 3.5 }),
      });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body as string).title).toContain("integer");
    });

    it("returns 400 when body is an array", async () => {
      const event = makeEvent({ method: "POST", path: "/reindex", body: JSON.stringify([1, 2, 3]) });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body as string).title).toContain("JSON object");
    });

    // -----------------------------------------------------------------------
    // POST /reindex — success
    // -----------------------------------------------------------------------

    it("returns 202 with ReindexJob on success", async () => {
      const job = {
        jobId: "job-123",
        targetRegistryId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
        segmentCount: 32,
        startedAt: "2025-01-01T00:00:00.000Z",
      };
      dispatcher.dispatch.mockResolvedValue(ok(job));

      const event = makeEvent({
        method: "POST",
        path: "/reindex",
        body: JSON.stringify({ targetRegistryId: "aurora-prod-titan-v2" }),
      });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(202);
      expect(JSON.parse(result.body as string)).toEqual(job);
      expect(dispatcher.dispatch).toHaveBeenCalledWith("aurora-prod-titan-v2", undefined);
    });

    it("passes segmentCount to dispatcher when provided", async () => {
      dispatcher.dispatch.mockResolvedValue(ok({
        jobId: "j", targetRegistryId: "c", modelId: "m", segmentCount: 16, startedAt: "",
      }));

      const event = makeEvent({
        method: "POST",
        path: "/reindex",
        body: JSON.stringify({ targetRegistryId: "aurora-prod-titan-v2", segmentCount: 16 }),
      });
      await dispatch(event, dispatcher);

      expect(dispatcher.dispatch).toHaveBeenCalledWith("aurora-prod-titan-v2", 16);
    });

    it("handles base64-encoded body", async () => {
      const job = {
        jobId: "job-b64",
        targetRegistryId: "aurora-prod-titan-v2",
        modelId: "amazon.titan-embed-text-v2:0",
        segmentCount: 32,
        startedAt: "2025-01-01T00:00:00.000Z",
      };
      dispatcher.dispatch.mockResolvedValue(ok(job));

      const bodyStr = JSON.stringify({ targetRegistryId: "aurora-prod-titan-v2" });
      const event = makeEvent({
        method: "POST",
        path: "/reindex",
        body: Buffer.from(bodyStr).toString("base64"),
        isBase64Encoded: true,
      });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(202);
      expect(dispatcher.dispatch).toHaveBeenCalledWith("aurora-prod-titan-v2", undefined);
    });

    // -----------------------------------------------------------------------
    // POST /reindex — cluster not found
    // -----------------------------------------------------------------------

    it("returns 404 when cluster not found in registry", async () => {
      dispatcher.dispatch.mockResolvedValue(err(notFoundError("cluster", "unknown-cluster")));

      const event = makeEvent({
        method: "POST",
        path: "/reindex",
        body: JSON.stringify({ targetRegistryId: "unknown-cluster" }),
      });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body as string).title).toContain("not found");
    });

    // -----------------------------------------------------------------------
    // POST /reindex — unexpected error
    // -----------------------------------------------------------------------

    it("returns 500 on unexpected dispatcher error", async () => {
      dispatcher.dispatch.mockRejectedValue(new Error("SQS timeout"));

      const event = makeEvent({
        method: "POST",
        path: "/reindex",
        body: JSON.stringify({ targetRegistryId: "aurora-prod-titan-v2" }),
      });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(500);
    });
  });

  // -------------------------------------------------------------------------
  // GET /reindex/{jobId}
  // -------------------------------------------------------------------------

  describe("GET /reindex/{jobId}", () => {
    it("returns 200 with ReindexReport on success", async () => {
      const report = {
        jobId: "job-456",
        signalsScanned: 100,
        copiedCount: 95,
        regeneratedCount: 3,
        unrecoverableCount: 2,
        validationOk: true,
        validationDetail: "All good",
        durationMs: 5000,
      };
      dispatcher.getReport.mockResolvedValue(ok(report));

      const event = makeEvent({
        method: "GET",
        path: "/reindex/job-456",
        pathParams: { jobId: "job-456" },
      });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body as string)).toEqual(report);
      expect(dispatcher.getReport).toHaveBeenCalledWith("job-456");
    });

    it("extracts jobId from path when pathParameters not set", async () => {
      dispatcher.getReport.mockResolvedValue(ok({
        jobId: "path-job", signalsScanned: 0, copiedCount: 0, regeneratedCount: 0,
        unrecoverableCount: 0, validationOk: true, validationDetail: "", durationMs: 0,
      }));

      const event = makeEvent({ method: "GET", path: "/reindex/path-job" });
      await dispatch(event, dispatcher);

      expect(dispatcher.getReport).toHaveBeenCalledWith("path-job");
    });

    it("returns 404 when job not found", async () => {
      dispatcher.getReport.mockResolvedValue(err(notFoundError("reindex_job", "missing-job")));

      const event = makeEvent({
        method: "GET",
        path: "/reindex/missing-job",
        pathParams: { jobId: "missing-job" },
      });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body as string).title).toContain("not found");
    });

    it("returns 500 on unexpected error", async () => {
      dispatcher.getReport.mockRejectedValue(new Error("DynamoDB timeout"));

      const event = makeEvent({
        method: "GET",
        path: "/reindex/job-789",
        pathParams: { jobId: "job-789" },
      });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(500);
    });
  });

  // -------------------------------------------------------------------------
  // Unknown routes
  // -------------------------------------------------------------------------

  describe("unknown routes", () => {
    it("returns 404 for unmatched paths", async () => {
      const event = makeEvent({ method: "GET", path: "/unknown" });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(404);
    });

    it("returns 404 for DELETE /reindex", async () => {
      const event = makeEvent({ method: "DELETE", path: "/reindex" });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(404);
    });

    it("returns 404 for PUT /reindex", async () => {
      const event = makeEvent({ method: "PUT", path: "/reindex" });
      const result = await dispatch(event, dispatcher);

      expect(result.statusCode).toBe(404);
    });
  });
});

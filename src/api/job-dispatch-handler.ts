// ---------------------------------------------------------------------------
// Job Dispatch Handler
// Routes API Gateway proxy events for reindex operations to the dispatcher.
// ---------------------------------------------------------------------------

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { ReindexDispatcher } from "../jobs/reindex/reindex-dispatcher.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SEGMENT_COUNT = 1;
const MAX_SEGMENT_COUNT = 256;

// ---------------------------------------------------------------------------
// Dispatcher interface (subset used by this handler)
// ---------------------------------------------------------------------------

export interface JobDispatcher {
  dispatch(targetRegistryId: string, segmentCount?: number): Promise<{
    jobId: string; targetRegistryId: string; modelId: string; segmentCount: number; startedAt: string;
  }>;
  getReport(jobId: string): Promise<{
    jobId: string; signalsScanned: number; copiedCount: number; regeneratedCount: number;
    unrecoverableCount: number; validationOk: boolean; validationDetail: string; durationMs: number;
  }>;
}

// ---------------------------------------------------------------------------
// Default singleton (lazy-initialized for testability)
// ---------------------------------------------------------------------------

let defaultDispatcher: JobDispatcher | undefined;

function getDispatcher(injected?: JobDispatcher): JobDispatcher {
  if (injected) return injected;
  if (!defaultDispatcher) {
    defaultDispatcher = new ReindexDispatcher();
  }
  return defaultDispatcher;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function errorResponse(statusCode: number, title: string): APIGatewayProxyResultV2 {
  return jsonResponse(statusCode, { title });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleJobDispatch(
  event: APIGatewayProxyEventV2,
  injectedDispatcher?: JobDispatcher,
): Promise<APIGatewayProxyResultV2> {
  const dispatcher = getDispatcher(injectedDispatcher);

  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath ?? "";

    // POST /reindex
    if (method === "POST" && /^\/reindex\/?$/.test(path)) {
      return await handlePostReindex(event, dispatcher);
    }

    // GET /reindex/{jobId}
    const getMatch = /^\/reindex\/([^/]+)\/?$/.exec(path);
    if (method === "GET" && getMatch) {
      const jobId = event.pathParameters?.["jobId"] ?? getMatch[1]!;
      return await handleGetReindex(jobId, dispatcher);
    }

    return errorResponse(404, "Not found");
  } catch (error: unknown) {
    return errorResponse(500, "Internal server error");
  }
}

// ---------------------------------------------------------------------------
// POST /reindex
// ---------------------------------------------------------------------------

async function handlePostReindex(
  event: APIGatewayProxyEventV2,
  dispatcher: JobDispatcher,
): Promise<APIGatewayProxyResultV2> {
  // Parse JSON body
  let body: unknown;
  try {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, "base64").toString("utf-8")
      : event.body;
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(400, "Request body must be a JSON object");
  }

  const { targetRegistryId, segmentCount } = body as Record<string, unknown>;

  // Validate targetRegistryId is present
  if (!targetRegistryId || typeof targetRegistryId !== "string") {
    return errorResponse(400, "targetRegistryId is required and must be a string");
  }

  // Validate segmentCount if provided
  if (segmentCount !== undefined) {
    if (typeof segmentCount !== "number" || !Number.isInteger(segmentCount)) {
      return errorResponse(400, "segmentCount must be an integer");
    }
    if (segmentCount < MIN_SEGMENT_COUNT || segmentCount > MAX_SEGMENT_COUNT) {
      return errorResponse(400, `segmentCount must be between ${MIN_SEGMENT_COUNT} and ${MAX_SEGMENT_COUNT}`);
    }
  }

  try {
    const job = await dispatcher.dispatch(targetRegistryId, segmentCount as number | undefined);
    return jsonResponse(202, job);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found in CLUSTER_REGISTRY")) {
      return errorResponse(404, `Cluster "${targetRegistryId}" not found`);
    }
    return errorResponse(500, "Internal server error");
  }
}

// ---------------------------------------------------------------------------
// GET /reindex/{jobId}
// ---------------------------------------------------------------------------

async function handleGetReindex(jobId: string, dispatcher: JobDispatcher): Promise<APIGatewayProxyResultV2> {
  try {
    const report = await dispatcher.getReport(jobId);
    return jsonResponse(200, report);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not found")) {
      return errorResponse(404, `Reindex job "${jobId}" not found`);
    }
    return errorResponse(500, "Internal server error");
  }
}

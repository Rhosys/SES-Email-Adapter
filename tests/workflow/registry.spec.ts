import { describe, it, expect, vi } from "vitest";
import { ok, err } from "../../src/errors.js";
import type { DbError } from "../../src/errors.js";
import type { Signal, Arc } from "../../src/types/index.js";
import type { WorkflowHandler } from "../../src/workflow/types.js";
import { HandlerRegistry } from "../../src/workflow/registry.js";

// ---------------------------------------------------------------------------
// Minimal stubs — satisfy the type checker without importing real deps
// ---------------------------------------------------------------------------

const stubSignal: Signal = {
  id: "sgn-test-001",
  signalLookupId: "sgn-test-001",
  accountId: "acc-1",
  source: "email",
  receivedAt: "2024-01-01T00:00:00Z",
  from: { address: "noreply@example.com" },
  to: [{ address: "me@mydomain.com" }],
  cc: [],
  subject: "Test signal",
  attachments: [],
  headers: {},
  recipientAddress: "me@mydomain.com",
  workflow: "auth",
  workflowData: { workflow: "auth", authType: "otp", code: "123456", service: "Example" },
  spamScore: 0,
  summary: "Test",
  s3Key: "signals/test.eml",
  status: "active",
  createdAt: "2024-01-01T00:00:00Z",
};

const stubArc: Arc = {
  id: "arc-test-001",
  accountId: "acc-1",
  workflow: "auth",
  labels: [],
  status: "active",
  summary: "Test arc",
  lastSignalAt: "2024-01-01T00:00:00Z",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

// ---------------------------------------------------------------------------
// Registry tests
// Validates: Requirements 1.1, 1.2, 1.4, 1.5
// ---------------------------------------------------------------------------

describe("HandlerRegistry", () => {
  it("routes to correct handler for a registered workflow", async () => {
    const execute = vi.fn().mockResolvedValue(ok(undefined));
    const handler: WorkflowHandler = { workflow: "auth", execute };

    const registry = new HandlerRegistry([handler]);
    const result = await registry.dispatch(stubSignal, stubArc, "acc-1");

    expect(result.isOk()).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("returns ok() when no handler registered for the workflow", async () => {
    const registry = new HandlerRegistry([]);
    const arc: Arc = { ...stubArc, workflow: "conversation" };

    const result = await registry.dispatch(stubSignal, arc, "acc-1");

    expect(result.isOk()).toBe(true);
  });

  it("propagates err() from handler", async () => {
    const dbErr: DbError = { kind: "db_error", cause: "connection lost" };
    const execute = vi.fn().mockResolvedValue(err(dbErr));
    const handler: WorkflowHandler = { workflow: "auth", execute };

    const registry = new HandlerRegistry([handler]);
    const result = await registry.dispatch(stubSignal, stubArc, "acc-1");

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(dbErr);
  });

  it("passes signal, arc, and accountId to handler's execute method", async () => {
    const execute = vi.fn().mockResolvedValue(ok(undefined));
    const handler: WorkflowHandler = { workflow: "auth", execute };

    const registry = new HandlerRegistry([handler]);
    await registry.dispatch(stubSignal, stubArc, "acc-1");

    expect(execute).toHaveBeenCalledWith(stubSignal, stubArc, "acc-1");
  });
});

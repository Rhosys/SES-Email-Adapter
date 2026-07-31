import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Resource } from "../../src/types/index.js";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import { encodeResourceId } from "../../src/api/transform.js";
import type { AuthService, AccessService } from "../../src/api/app.js";
import type { ResourceDatabase } from "../../src/database/resource-database.js";
import { ok } from "../../src/errors.js";
import { createMockLogger } from "../helpers/mock-logger.js";

const TEST_ACCOUNT_ID = "acct-resources-001";
const A = `/accounts/${TEST_ACCOUNT_ID}`;

function makeAuth(): AuthService {
  return { verify: vi.fn().mockResolvedValue(ok({ userId: "user-001" })) };
}

function makeAccess(): AccessService & { checkAccess: ReturnType<typeof vi.fn> } {
  return {
    listUsers: vi.fn().mockResolvedValue(ok([])),
    listAccountsForUser: vi.fn().mockResolvedValue(ok([])),
    addUser: vi.fn().mockResolvedValue(ok(undefined)),
    updateUserRole: vi.fn().mockResolvedValue(ok(undefined)),
    removeUser: vi.fn().mockResolvedValue(ok(undefined)),
    checkAccess: vi.fn().mockResolvedValue(undefined),
    createInvite: vi.fn().mockResolvedValue(ok({ inviteId: "inv-test" })),
    getUserProfile: vi.fn().mockReturnValue(Promise.resolve(ok({}))),
  } as unknown as AccessService & { checkAccess: ReturnType<typeof vi.fn> };
}

function makeResource(overrides: Partial<Resource> = {}): Resource {
  return {
    accountId: TEST_ACCOUNT_ID,
    threadId: "thr-001",
    workflow: "package",
    resourceKey: "123-456",
    status: "active",
    expectedResolutionDate: "2024-07-01T00:00:00Z",
    assets: [],
    createdAt: "2024-06-15T10:00:00Z",
    updatedAt: "2024-06-15T10:00:00Z",
    ...overrides,
  };
}

function makeResourceDb() {
  return {
    saveResource: vi.fn(),
    getResource: vi.fn().mockResolvedValue(ok(null)),
    listResources: vi.fn().mockResolvedValue(ok({ items: [] })),
    setResourceStatus: vi.fn(),
  };
}

async function req(app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
}

describe("Resources API", () => {
  let resourceDb: ReturnType<typeof makeResourceDb>;
  let access: ReturnType<typeof makeAccess>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    resourceDb = makeResourceDb();
    access = makeAccess();
    app = createApp(makeAppDeps({
      resourceDb: resourceDb as unknown as ResourceDatabase,
      auth: makeAuth(),
      access,
      logger: createMockLogger(),
    }));
  });

  describe("GET /accounts/:accountId/resources", () => {
    it("defaults status to active and queries listResources scoped by status only when workflow is omitted", async () => {
      resourceDb.listResources.mockResolvedValue(ok({ items: [makeResource()] }));

      const res = await req(app, "GET", `${A}/resources`);

      expect(res.status).toBe(200);
      expect(resourceDb.listResources).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "active", {});
      const body = await res.json() as { resources: unknown[] };
      expect(body.resources).toHaveLength(1);
    });

    it("spans every resource workflow when workflow is omitted — no application-side filter applied", async () => {
      resourceDb.listResources.mockResolvedValue(ok({
        items: [makeResource({ workflow: "package" }), makeResource({ workflow: "travel", resourceKey: "UA123" })],
      }));

      const res = await req(app, "GET", `${A}/resources`);
      const body = await res.json() as { resources: Array<{ workflow: string }> };

      expect(body.resources.map(r => r.workflow).sort()).toEqual(["package", "travel"]);
    });

    it("filters the DB result set to the requested workflow (GSI is not workflow-scoped)", async () => {
      resourceDb.listResources.mockResolvedValue(ok({
        items: [makeResource({ workflow: "package" }), makeResource({ workflow: "travel", resourceKey: "UA123" })],
      }));

      const res = await req(app, "GET", `${A}/resources?workflow=package`);

      expect(resourceDb.listResources).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "active", {});
      const body = await res.json() as { resources: Array<{ workflow: string }> };
      expect(body.resources).toHaveLength(1);
      expect(body.resources[0]!.workflow).toBe("package");
    });

    it("passes an explicit status through", async () => {
      resourceDb.listResources.mockResolvedValue(ok({ items: [] }));

      await req(app, "GET", `${A}/resources?workflow=package&status=complete`);

      expect(resourceDb.listResources).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "complete", {});
    });

    it("passes dateFrom/dateTo through for the native range query (e.g. today/this week across all workflows)", async () => {
      resourceDb.listResources.mockResolvedValue(ok({ items: [] }));

      await req(app, "GET", `${A}/resources?dateFrom=2024-07-01&dateTo=2024-07-04`);

      expect(resourceDb.listResources).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "active", {
        dateFrom: "2024-07-01", dateTo: "2024-07-04",
      });
    });

    it("maps each resource's public id to an encoded threadId+sk composite", async () => {
      resourceDb.listResources.mockResolvedValue(ok({ items: [makeResource()] }));

      const res = await req(app, "GET", `${A}/resources?workflow=package`);
      const body = await res.json() as { resources: Array<{ resourceId: string; threadId: string }> };

      expect(body.resources[0]!.resourceId).toBe(encodeResourceId("thr-001", "package#123-456"));
      expect(body.resources[0]!.threadId).toBe("thr-001");
    });

    it("400s on a workflow that never produces a resource (e.g. auth)", async () => {
      const res = await req(app, "GET", `${A}/resources?workflow=auth`);
      expect(res.status).toBe(400);
      expect(resourceDb.listResources).not.toHaveBeenCalled();
    });

    it("400s on an unrecognized status value", async () => {
      const res = await req(app, "GET", `${A}/resources?workflow=package&status=bogus`);
      expect(res.status).toBe(400);
      expect(resourceDb.listResources).not.toHaveBeenCalled();
    });

    it("authorizes the list route against the account-level URI (no resourceId to scope to)", async () => {
      resourceDb.listResources.mockResolvedValue(ok({ items: [] }));
      await req(app, "GET", `${A}/resources?workflow=package`);
      expect(access.checkAccess).toHaveBeenCalledWith("user-001", `accounts/${TEST_ACCOUNT_ID}/resources`, "resources:read");
    });
  });

  describe("GET /accounts/:accountId/resources/:resourceId", () => {
    it("404s on a malformed/undecodable resourceId", async () => {
      const res = await req(app, "GET", `${A}/resources/not-a-real-id`);
      expect(res.status).toBe(404);
      expect(resourceDb.getResource).not.toHaveBeenCalled();
    });

    it("decodes the id, fetches by threadId+sk, and returns 200 on a match", async () => {
      resourceDb.getResource.mockResolvedValue(ok(makeResource()));
      const resourceId = encodeResourceId("thr-001", "package#123-456");

      const res = await req(app, "GET", `${A}/resources/${resourceId}`);

      expect(res.status).toBe(200);
      expect(resourceDb.getResource).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "thr-001", "package#123-456");
    });

    it("404s when getResource returns null", async () => {
      resourceDb.getResource.mockResolvedValue(ok(null));
      const resourceId = encodeResourceId("thr-001", "package#123-456");

      const res = await req(app, "GET", `${A}/resources/${resourceId}`);

      expect(res.status).toBe(404);
    });

    it("404s when the decoded resource belongs to a different account (tenant isolation)", async () => {
      resourceDb.getResource.mockResolvedValue(ok(makeResource({ accountId: "acct-other" })));
      const resourceId = encodeResourceId("thr-001", "package#123-456");

      const res = await req(app, "GET", `${A}/resources/${resourceId}`);

      expect(res.status).toBe(404);
    });

    it("authorizes against the specific resourceId, not just the account-level URI", async () => {
      resourceDb.getResource.mockResolvedValue(ok(makeResource()));
      const resourceId = encodeResourceId("thr-001", "package#123-456");

      await req(app, "GET", `${A}/resources/${resourceId}`);

      expect(access.checkAccess).toHaveBeenCalledWith("user-001", `accounts/${TEST_ACCOUNT_ID}/resources/${resourceId}`, "resources:read");
    });
  });

  describe("PATCH /accounts/:accountId/resources/:resourceId", () => {
    it("404s on a malformed/undecodable resourceId, never touches the DB", async () => {
      const res = await req(app, "PATCH", `${A}/resources/not-a-real-id`, { status: "complete" });
      expect(res.status).toBe(404);
      expect(resourceDb.getResource).not.toHaveBeenCalled();
      expect(resourceDb.setResourceStatus).not.toHaveBeenCalled();
    });

    it("404s when the resource does not exist, without calling setResourceStatus", async () => {
      resourceDb.getResource.mockResolvedValue(ok(null));
      const resourceId = encodeResourceId("thr-001", "package#123-456");

      const res = await req(app, "PATCH", `${A}/resources/${resourceId}`, { status: "complete" });

      expect(res.status).toBe(404);
      expect(resourceDb.setResourceStatus).not.toHaveBeenCalled();
    });

    it("404s when the resource belongs to a different account (tenant isolation)", async () => {
      resourceDb.getResource.mockResolvedValue(ok(makeResource({ accountId: "acct-other" })));
      const resourceId = encodeResourceId("thr-001", "package#123-456");

      const res = await req(app, "PATCH", `${A}/resources/${resourceId}`, { status: "complete" });

      expect(res.status).toBe(404);
      expect(resourceDb.setResourceStatus).not.toHaveBeenCalled();
    });

    it("400s on an invalid status value", async () => {
      resourceDb.getResource.mockResolvedValue(ok(makeResource()));
      const resourceId = encodeResourceId("thr-001", "package#123-456");

      const res = await req(app, "PATCH", `${A}/resources/${resourceId}`, { status: "bogus" });

      expect(res.status).toBe(400);
      expect(resourceDb.setResourceStatus).not.toHaveBeenCalled();
    });

    it("marks a resource complete: decodes id, verifies existence, calls setResourceStatus, returns 200", async () => {
      resourceDb.getResource.mockResolvedValue(ok(makeResource()));
      resourceDb.setResourceStatus.mockResolvedValue(ok(makeResource({ status: "complete", resolvedAt: "2024-06-16T00:00:00Z" })));
      const resourceId = encodeResourceId("thr-001", "package#123-456");

      const res = await req(app, "PATCH", `${A}/resources/${resourceId}`, { status: "complete" });

      expect(res.status).toBe(200);
      expect(resourceDb.setResourceStatus).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "thr-001", "package#123-456", "complete");
      const body = await res.json() as { status: string; resolvedAt?: string };
      expect(body.status).toBe("complete");
      expect(body.resolvedAt).toBe("2024-06-16T00:00:00Z");
    });

    it("reopens a resource: marks active, resolvedAt disappears", async () => {
      resourceDb.getResource.mockResolvedValue(ok(makeResource({ status: "complete", resolvedAt: "2024-06-16T00:00:00Z" })));
      resourceDb.setResourceStatus.mockResolvedValue(ok(makeResource({ status: "active" })));
      const resourceId = encodeResourceId("thr-001", "package#123-456");

      const res = await req(app, "PATCH", `${A}/resources/${resourceId}`, { status: "active" });

      expect(res.status).toBe(200);
      expect(resourceDb.setResourceStatus).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "thr-001", "package#123-456", "active");
      const body = await res.json() as { status: string; resolvedAt?: string };
      expect(body.status).toBe("active");
      expect(body.resolvedAt).toBeUndefined();
    });

    it("404s (not a phantom 200) when the row vanishes between the existence check and the write", async () => {
      resourceDb.getResource.mockResolvedValue(ok(makeResource()));
      resourceDb.setResourceStatus.mockResolvedValue(ok(null));
      const resourceId = encodeResourceId("thr-001", "package#123-456");

      const res = await req(app, "PATCH", `${A}/resources/${resourceId}`, { status: "complete" });

      expect(res.status).toBe(404);
    });

    it("authorizes against the specific resourceId, not just the account-level URI", async () => {
      resourceDb.getResource.mockResolvedValue(ok(makeResource()));
      resourceDb.setResourceStatus.mockResolvedValue(ok(makeResource({ status: "complete" })));
      const resourceId = encodeResourceId("thr-001", "package#123-456");

      await req(app, "PATCH", `${A}/resources/${resourceId}`, { status: "complete" });

      expect(access.checkAccess).toHaveBeenCalledWith("user-001", `accounts/${TEST_ACCOUNT_ID}/resources/${resourceId}`, "resources:write");
    });
  });
});

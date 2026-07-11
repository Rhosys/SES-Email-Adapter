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

function makeAccess(): AccessService {
  return {
    listUsers: vi.fn().mockResolvedValue(ok([])),
    listAccountsForUser: vi.fn().mockResolvedValue(ok([])),
    addUser: vi.fn().mockResolvedValue(ok(undefined)),
    updateUserRole: vi.fn().mockResolvedValue(ok(undefined)),
    removeUser: vi.fn().mockResolvedValue(ok(undefined)),
    checkAccess: vi.fn().mockResolvedValue(undefined),
    createInvite: vi.fn().mockResolvedValue(ok({ inviteId: "inv-test" })),
    getUserProfile: vi.fn().mockReturnValue(Promise.resolve(ok({}))),
  } as unknown as AccessService;
}

function makeResource(overrides: Partial<Resource> = {}): Resource {
  return {
    accountId: TEST_ACCOUNT_ID,
    threadId: "thr-001",
    workflow: "package",
    resourceKey: "123-456",
    status: "active",
    expectedResolutionDate: "2024-07-01T00:00:00Z",
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
  };
}

async function req(app: ReturnType<typeof createApp>, method: string, path: string): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer valid-token" },
  }));
}

describe("Resources API", () => {
  let resourceDb: ReturnType<typeof makeResourceDb>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    resourceDb = makeResourceDb();
    app = createApp(makeAppDeps({
      resourceDb: resourceDb as unknown as ResourceDatabase,
      auth: makeAuth(),
      access: makeAccess(),
      logger: createMockLogger(),
    }));
  });

  describe("GET /accounts/:accountId/resources", () => {
    it("400s when workflow query param is missing", async () => {
      const res = await req(app, "GET", `${A}/resources`);
      expect(res.status).toBe(400);
      expect(resourceDb.listResources).not.toHaveBeenCalled();
    });

    it("defaults status to active and queries listResources with the given workflow", async () => {
      resourceDb.listResources.mockResolvedValue(ok({ items: [makeResource()] }));

      const res = await req(app, "GET", `${A}/resources?workflow=package`);

      expect(res.status).toBe(200);
      expect(resourceDb.listResources).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "package", "active", {});
      const body = await res.json() as { resources: unknown[] };
      expect(body.resources).toHaveLength(1);
    });

    it("passes an explicit status through", async () => {
      resourceDb.listResources.mockResolvedValue(ok({ items: [] }));

      await req(app, "GET", `${A}/resources?workflow=package&status=complete`);

      expect(resourceDb.listResources).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "package", "complete", {});
    });

    it("passes dateFrom/dateTo through for the native range query", async () => {
      resourceDb.listResources.mockResolvedValue(ok({ items: [] }));

      await req(app, "GET", `${A}/resources?workflow=package&dateFrom=2024-07-01&dateTo=2024-07-04`);

      expect(resourceDb.listResources).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "package", "active", {
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
  });
});

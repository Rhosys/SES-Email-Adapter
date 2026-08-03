import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { zParse } from "./validate.js";
import { toApiLabel } from "./transform.js";
import { CreateLabelRequest, UpdateLabelRequest } from "./requests.js";
import { Label as LabelSchema, ListLabelsResponse } from "./schemas.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";

export class LabelsApi {
  constructor(private readonly accountDb: AccountDatabase, private readonly logger: Logger) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { accountDb, logger } = this;

    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/labels",
      tags: ["Labels"],
      request: { params: z.object({ accountId: z.string() }) },
      middleware: [authz("labels:read", c => `accounts/${c.req.param("accountId")!}/labels`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListLabelsResponse } }, description: "List labels" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const labelsResult = await accountDb.listLabels(accountId);
      if (labelsResult.isErr()) { logger.error("Failed to list labels", { code: "api.labels.list_failed", error: labelsResult.error }); return err(c, 500, "Internal Server Error"); }
      return c.json({ labels: labelsResult.value.map(toApiLabel) }, 200);
    });

    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/labels",
      tags: ["Labels"],
      request: { params: z.object({ accountId: z.string() }) },
      middleware: [authz("labels:write", c => `accounts/${c.req.param("accountId")!}/labels`)] as const,
      responses: { 201: { content: { "application/json": { schema: LabelSchema } }, description: "Label created" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      logger.info("Creating label", { code: "api.labels.create", accountId });
      const body = await zParse(CreateLabelRequest, c.req.raw);
      const labelResult = await accountDb.createLabel(accountId, body);
      if (labelResult.isErr()) { logger.error("Failed to create label", { code: "api.labels.create_failed", error: labelResult.error }); return err(c, 500, "Internal Server Error"); }
      logger.info("Label created", { code: "api.labels.created", accountId, labelId: labelResult.value.id });
      return c.json(toApiLabel(labelResult.value), 201);
    });

    app.openapi(route({
      method: "patch",
      path: "/accounts/{accountId}/labels/{id}",
      tags: ["Labels"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("labels:write", c => `accounts/${c.req.param("accountId")!}/labels/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: LabelSchema } }, description: "Update label" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const labelId = c.req.param("id")!;
      logger.info("Updating label", { code: "api.labels.update", accountId, labelId });
      const labelsResult = await accountDb.listLabels(accountId);
      if (labelsResult.isErr()) { logger.error("Failed to list labels for patch", { code: "api.labels.patch.list_failed", error: labelsResult.error }); return err(c, 500, "Internal Server Error"); }
      const label = labelsResult.value.find((l) => l.id === labelId);
      if (!label) return err(c, 404, "Label not found", "LABEL_NOT_FOUND");
      const body = await zParse(UpdateLabelRequest, c.req.raw);
      const updateResult = await accountDb.updateLabel(accountId, label.id, body);
      if (updateResult.isErr()) { logger.error("Failed to update label", { code: "api.labels.patch.update_failed", error: updateResult.error }); return err(c, 500, "Internal Server Error"); }
      logger.info("Label updated", { code: "api.labels.updated", accountId, labelId });
      return c.json(toApiLabel(updateResult.value), 200);
    });

    app.openapi(route({
      method: "delete",
      path: "/accounts/{accountId}/labels/{id}",
      tags: ["Labels"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("labels:write", c => `accounts/${c.req.param("accountId")!}/labels/${c.req.param("id")!}`)] as const,
      responses: { 204: { description: "Label deleted" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const labelId = c.req.param("id")!;
      logger.info("Deleting label", { code: "api.labels.delete", accountId, labelId });
      const labelsResult = await accountDb.listLabels(accountId);
      if (labelsResult.isErr()) { logger.error("Failed to list labels for delete", { code: "api.labels.delete.list_failed", error: labelsResult.error }); return err(c, 500, "Internal Server Error"); }
      const label = labelsResult.value.find((l) => l.id === labelId);
      if (!label) return err(c, 404, "Label not found", "LABEL_NOT_FOUND");
      const deleteResult = await accountDb.deleteLabel(accountId, label.id);
      if (deleteResult.isErr()) { logger.error("Failed to delete label", { code: "api.labels.delete_failed", error: deleteResult.error }); return err(c, 500, "Internal Server Error"); }
      logger.info("Label deleted", { code: "api.labels.deleted", accountId, labelId });
      return new Response(null, { status: 204 });
    });
  }
}

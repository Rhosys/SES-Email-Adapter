import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { zParse } from "./validate.js";
import { toApiLabel } from "./transform.js";
import { CreateLabelRequest, UpdateLabelRequest } from "./requests.js";
import { Label as LabelSchema, ListLabelsResponse } from "./schemas.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";

export class LabelsApi {
  constructor(private readonly accountDb: AccountDatabase) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { accountDb } = this;

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
      if (labelsResult.isErr()) return err(c, 500, "Internal Server Error");
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
      const body = await zParse(CreateLabelRequest, c.req.raw);
      const labelResult = await accountDb.createLabel(accountId, body);
      if (labelResult.isErr()) return err(c, 500, "Internal Server Error");
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
      const labelsResult = await accountDb.listLabels(accountId);
      if (labelsResult.isErr()) return err(c, 500, "Internal Server Error");
      const label = labelsResult.value.find((l) => l.id === c.req.param("id")!);
      if (!label) return err(c, 404, "Label not found", "LABEL_NOT_FOUND");
      const body = await zParse(UpdateLabelRequest, c.req.raw);
      const updateResult = await accountDb.updateLabel(accountId, label.id, body);
      if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
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
      const labelsResult = await accountDb.listLabels(accountId);
      if (labelsResult.isErr()) return err(c, 500, "Internal Server Error");
      const label = labelsResult.value.find((l) => l.id === c.req.param("id")!);
      if (!label) return err(c, 404, "Label not found", "LABEL_NOT_FOUND");
      const deleteResult = await accountDb.deleteLabel(accountId, label.id);
      if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
      return new Response(null, { status: 204 });
    });
  }
}

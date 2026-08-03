import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { DateTime } from "luxon";
import { generateId } from "../utils/id.js";
import { zParse } from "./validate.js";
import { toApiTemplate } from "./transform.js";
import { CreateTemplateRequest, ReplaceTemplateRequest, UpdateTemplateRequest } from "./requests.js";
import { EmailTemplate as EmailTemplateSchema, ListTemplatesResponse } from "./schemas.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { AuditDatabase } from "../database/audit-database.js";
import type { UserCodeExecutorClient } from "../processor/user-code-client.js";
import type { Logger } from "../logger.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";

export class TemplatesApi {
  constructor(
    private readonly accountDb: AccountDatabase,
    private readonly auditDb: AuditDatabase,
    private readonly astValidator: UserCodeExecutorClient,
    private readonly logger: Logger,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { accountDb, auditDb, astValidator, logger } = this;

    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/templates",
      tags: ["Templates"],
      request: { params: z.object({ accountId: z.string() }) },
      middleware: [authz("templates:read", c => `accounts/${c.req.param("accountId")!}/templates`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListTemplatesResponse } }, description: "List templates" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const templatesResult = await accountDb.listTemplates(accountId);
      if (templatesResult.isErr()) { logger.error("Failed to list templates", { code: "api.templates.list_failed", error: templatesResult.error }); return err(c, 500, "Internal Server Error"); }
      return c.json({ templates: templatesResult.value.map(toApiTemplate) }, 200);
    });

    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/templates",
      tags: ["Templates"],
      request: { params: z.object({ accountId: z.string() }) },
      middleware: [authz("templates:write", c => `accounts/${c.req.param("accountId")!}/templates`)] as const,
      responses: { 201: { content: { "application/json": { schema: EmailTemplateSchema } }, description: "Template created" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      logger.info("Creating template", { code: "api.templates.create", accountId });
      const body = await zParse(CreateTemplateRequest, c.req.raw);
      if (body.functions) {
        if (astValidator) {
          const astResult = await astValidator.validateAstBatch(body.functions);
          if (astResult.isErr()) {
            const e = astResult.error;
            const message = e.kind === "ast_validation_error" ? e.message : e.message;
            const location = e.kind === "ast_validation_error" ? e.location : undefined;
            return err(c, 400, `Invalid code in function: ${message}`, "INVALID_CODE", location ? { location } : undefined);
          }
        }
      }
      const now = DateTime.utc().toISO()!;
      // Audit: write functions change event before persisting (best-effort)
      if (body.functions) {
        const { userId } = c.get("auth");
        const templateId = generateId("tpl-");
        const auditResult = await auditDb.saveAuditEvent({
          accountId, userId, action: "created", resourceType: "template", resourceId: templateId,
          before: null, after: { functions: body.functions },
        });
        if (auditResult.isErr()) {
          logger.warn("Audit write failed for template creation, proceeding with resource write", { code: "api.audit.template_create_failed", accountId, error: auditResult.error });
        }
        const templateResult = await accountDb.createTemplate({
          id: templateId, accountId, name: body.name, subject: body.subject, body: body.body,
          functions: body.functions,
          createdAt: now, updatedAt: now,
        });
        if (templateResult.isErr()) { logger.error("Failed to create template", { code: "api.templates.create_failed", error: templateResult.error }); return err(c, 500, "Internal Server Error"); }
        logger.info("Template created", { code: "api.templates.created", accountId, templateId });
        return c.json(toApiTemplate(templateResult.value), 201);
      }
      const templateResult = await accountDb.createTemplate({
        id: generateId("tpl-"), accountId, name: body.name, subject: body.subject, body: body.body,
        createdAt: now, updatedAt: now,
      });
      if (templateResult.isErr()) { logger.error("Failed to create template", { code: "api.templates.create_failed", error: templateResult.error }); return err(c, 500, "Internal Server Error"); }
      logger.info("Template created", { code: "api.templates.created", accountId, templateId: templateResult.value.id });
      return c.json(toApiTemplate(templateResult.value), 201);
    });

    app.openapi(route({
      method: "patch",
      path: "/accounts/{accountId}/templates/{id}",
      tags: ["Templates"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("templates:write", c => `accounts/${c.req.param("accountId")!}/templates/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: EmailTemplateSchema } }, description: "Update template" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const templateId = c.req.param("id")!;
      logger.info("Updating template", { code: "api.templates.update", accountId, templateId });
      const body = await zParse(UpdateTemplateRequest, c.req.raw);
      if (body.functions) {
        if (astValidator) {
          const astResult = await astValidator.validateAstBatch(body.functions);
          if (astResult.isErr()) {
            const e = astResult.error;
            const message = e.kind === "ast_validation_error" ? e.message : e.message;
            const location = e.kind === "ast_validation_error" ? e.location : undefined;
            return err(c, 400, `Invalid code in function: ${message}`, "INVALID_CODE", location ? { location } : undefined);
          }
        }
      }
      const existingResult = await accountDb.getTemplate(accountId, templateId);
      if (existingResult.isErr()) { logger.error("Failed to get template for patch", { code: "api.templates.patch.get_failed", error: existingResult.error }); return err(c, 500, "Internal Server Error"); }
      if (!existingResult.value) return err(c, 404, "Template not found", "TEMPLATE_NOT_FOUND");
      // Audit: write functions change event before persisting (best-effort)
      if (body.functions) {
        const { userId } = c.get("auth");
        const auditResult = await auditDb.saveAuditEvent({
          accountId, userId, action: "updated", resourceType: "template", resourceId: templateId,
          before: { functions: existingResult.value.functions ?? null },
          after: { functions: body.functions },
        });
        if (auditResult.isErr()) {
          logger.warn("Audit write failed for template update, proceeding with resource write", { code: "api.audit.template_update_failed", accountId, templateId, error: auditResult.error });
        }
      }
      const updateResult = await accountDb.updateTemplate(accountId, templateId, body as Parameters<typeof accountDb.updateTemplate>[2]);
      if (updateResult.isErr()) { logger.error("Failed to update template", { code: "api.templates.patch.update_failed", error: updateResult.error }); return err(c, 500, "Internal Server Error"); }
      logger.info("Template updated", { code: "api.templates.updated", accountId, templateId });
      return c.json(toApiTemplate(updateResult.value), 200);
    });

    app.openapi(route({
      method: "put",
      path: "/accounts/{accountId}/templates/{id}",
      tags: ["Templates"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("templates:write", c => `accounts/${c.req.param("accountId")!}/templates/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: EmailTemplateSchema } }, description: "Replace template" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const templateId = c.req.param("id")!;
      logger.info("Replacing template", { code: "api.templates.replace", accountId, templateId });
      const body = await zParse(ReplaceTemplateRequest, c.req.raw);
      if (body.functions) {
        if (astValidator) {
          const astResult = await astValidator.validateAstBatch(body.functions);
          if (astResult.isErr()) {
            const e = astResult.error;
            const message = e.kind === "ast_validation_error" ? e.message : e.message;
            const location = e.kind === "ast_validation_error" ? e.location : undefined;
            return err(c, 400, `Invalid code in function: ${message}`, "INVALID_CODE", location ? { location } : undefined);
          }
        }
      }
      const existingResult = await accountDb.getTemplate(accountId, templateId);
      if (existingResult.isErr()) { logger.error("Failed to get template for put", { code: "api.templates.put.get_failed", error: existingResult.error }); return err(c, 500, "Internal Server Error"); }
      if (!existingResult.value) return err(c, 404, "Template not found", "TEMPLATE_NOT_FOUND");
      // Audit: write functions change event before persisting (best-effort)
      if (body.functions) {
        const { userId } = c.get("auth");
        const auditResult = await auditDb.saveAuditEvent({
          accountId, userId, action: "updated", resourceType: "template", resourceId: templateId,
          before: { functions: existingResult.value.functions ?? null },
          after: { functions: body.functions },
        });
        if (auditResult.isErr()) {
          logger.warn("Audit write failed for template replace, proceeding with resource write", { code: "api.audit.template_replace_failed", accountId, templateId, error: auditResult.error });
        }
      }
      const updateResult = await accountDb.updateTemplate(accountId, templateId, { name: body.name, subject: body.subject, body: body.body, ...(body.functions ? { functions: body.functions } : {}) });
      if (updateResult.isErr()) { logger.error("Failed to replace template", { code: "api.templates.put.update_failed", error: updateResult.error }); return err(c, 500, "Internal Server Error"); }
      logger.info("Template replaced", { code: "api.templates.replaced", accountId, templateId });
      return c.json(toApiTemplate(updateResult.value), 200);
    });

    app.openapi(route({
      method: "delete",
      path: "/accounts/{accountId}/templates/{id}",
      tags: ["Templates"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("templates:write", c => `accounts/${c.req.param("accountId")!}/templates/${c.req.param("id")!}`)] as const,
      responses: { 204: { description: "Template deleted" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const templateId = c.req.param("id")!;
      logger.info("Deleting template", { code: "api.templates.delete", accountId, templateId });
      const existingResult = await accountDb.getTemplate(accountId, templateId);
      if (existingResult.isErr()) { logger.error("Failed to get template for delete", { code: "api.templates.delete.get_failed", error: existingResult.error }); return err(c, 500, "Internal Server Error"); }
      if (!existingResult.value) return err(c, 404, "Template not found", "TEMPLATE_NOT_FOUND");
      const deleteResult = await accountDb.deleteTemplate(accountId, templateId);
      if (deleteResult.isErr()) { logger.error("Failed to delete template", { code: "api.templates.delete_failed", error: deleteResult.error }); return err(c, 500, "Internal Server Error"); }
      logger.info("Template deleted", { code: "api.templates.deleted", accountId, templateId });
      return new Response(null, { status: 204 });
    });
  }
}

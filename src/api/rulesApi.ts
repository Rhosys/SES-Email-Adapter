import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { zParse } from "./validate.js";
import { CreateRuleRequest, UpdateRuleRequest } from "./requests.js";
import { Rule as RuleSchema, ListRulesResponse } from "./schemas.js";
import type * as Api from "./schemas.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { AuditDatabase } from "../database/audit-database.js";
import type { UserCodeExecutorClient } from "../processor/user-code-client.js";
import type { BillingHandler } from "../billing/billing-handler.js";
import type { Logger } from "../logger.js";
import type { Rule as DbRule, Rule } from "../types/index.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";
import { validateRuleCondition } from "./validate-rule-condition.js";

function toApiRule(rule: DbRule): Api.Rule {
  return {
    ruleId: rule.id,
    name: rule.name,
    ...(rule.condition ? { condition: rule.condition } : {}),
    ...(rule.conditionType ? { conditionType: rule.conditionType } : {}),
    actions: rule.actions,
    status: rule.status as Api.Rule["status"],
    priorityOrder: rule.priorityOrder,
    ...(rule.accountId === "SYSTEM" ? { type: "IMMUTABLE" as const } : {}),
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

async function validateForwardTargets(
  accountId: string,
  actions: Rule["actions"],
  store: Pick<AccountDatabase, "listForwardingTargets">,
): Promise<string | null> {
  const forwardTargets = actions.filter((a) => a.type === "forward" && a.value).map((a) => a.value!);
  if (forwardTargets.length === 0) return null;
  const verifiedResult = await store.listForwardingTargets(accountId);
  if (verifiedResult.isErr()) return "Internal error validating forward targets";
  const verifiedSet = new Set(verifiedResult.value.filter((v) => v.status === "verified").map((v) => v.target));
  const unverified = forwardTargets.filter((t) => !verifiedSet.has(t));
  return unverified.length > 0 ? `Forward targets not verified: ${unverified.join(", ")}` : null;
}

export class RulesApi {
  constructor(
    private readonly accountDb: AccountDatabase,
    private readonly auditDb: AuditDatabase,
    private readonly astValidator: UserCodeExecutorClient,
    private readonly billingHandler: BillingHandler,
    private readonly logger: Logger,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { authz, err, route }: RouteHelpers): void {
    const { accountDb, auditDb, astValidator, logger } = this;

    app.openapi(route({
      method: "get",
      path: "/accounts/{accountId}/rules",
      tags: ["Rules"],
      request: { params: z.object({ accountId: z.string() }) },
      middleware: [authz("rules:read", c => `accounts/${c.req.param("accountId")!}/rules`)] as const,
      responses: { 200: { content: { "application/json": { schema: ListRulesResponse } }, description: "List rules" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const rulesResult = await accountDb.listRules(accountId);
      if (rulesResult.isErr()) { logger.error("Failed to list rules", { code: "api.rules.list_failed", error: rulesResult.error }); return err(c, 500, "Internal Server Error"); }
      return c.json({ rules: rulesResult.value.map(toApiRule) }, 200);
    });

    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/rules",
      tags: ["Rules"],
      request: { params: z.object({ accountId: z.string() }) },
      middleware: [authz("rules:write", c => `accounts/${c.req.param("accountId")!}/rules`)] as const,
      responses: { 201: { content: { "application/json": { schema: RuleSchema } }, description: "Rule created" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      logger.info("Creating rule", { code: "api.rules.create", accountId });
      const body = await zParse(CreateRuleRequest, c.req.raw);
      const effectiveConditionType = body.conditionType ?? "json_logic";
      if (effectiveConditionType === "js") {
        if (!body.condition || body.condition.trim().length === 0) {
          return err(c, 400, "condition field is required when conditionType is 'js'", "MISSING_CODE");
        }
        const astResult = astValidator ? await astValidator.validateAst(body.condition) : undefined;
        if (!astResult || astResult.isErr()) {
          const e = astResult?.error;
          const message = e?.kind === "ast_validation_error" ? e.message : (e?.message ?? "AST validator not configured");
          const location = e?.kind === "ast_validation_error" ? e.location : undefined;
          return err(c, 400, message, "INVALID_CODE", location ? { location } : undefined);
        }
      } else {
        if (body.condition) {
          const conditionError = validateRuleCondition(body.condition);
          if (conditionError) return err(c, 400, conditionError, "INVALID_CONDITION");
        }
      }
      const forwardError = await validateForwardTargets(accountId, body.actions as Rule["actions"], accountDb);
      if (forwardError) return err(c, 400, forwardError, "UNVERIFIED_FORWARD_TARGET");
      // Audit: write code change event before persisting (best-effort)
      if (effectiveConditionType === "js") {
        const { userId } = c.get("auth");
        const auditResult = await auditDb.saveAuditEvent({
          accountId, userId, action: "created", resourceType: "rule", resourceId: "",
          before: null, after: { conditionType: "js", condition: body.condition },
        });
        if (auditResult.isErr()) {
          logger.warn("Audit write failed for rule creation, proceeding with resource write", { code: "api.audit.rule_create_failed", accountId, error: auditResult.error });
        }
      }
      const ruleResult = await accountDb.createRule(accountId, body as Parameters<typeof accountDb.createRule>[1]);
      if (ruleResult.isErr()) { logger.error("Failed to create rule", { code: "api.rules.create_failed", error: ruleResult.error }); return err(c, 500, "Internal Server Error"); }
      logger.info("Rule created", { code: "api.rules.created", accountId, ruleId: ruleResult.value.id });
      return c.json(toApiRule(ruleResult.value), 201);
    });

    app.openapi(route({
      method: "patch",
      path: "/accounts/{accountId}/rules/{id}",
      tags: ["Rules"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("rules:write", c => `accounts/${c.req.param("accountId")!}/rules/${c.req.param("id")!}`)] as const,
      responses: { 200: { content: { "application/json": { schema: RuleSchema } }, description: "Update rule" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const ruleId = c.req.param("id")!;
      logger.info("Updating rule", { code: "api.rules.update", accountId, ruleId });
      const rulesResult = await accountDb.listRules(accountId);
      if (rulesResult.isErr()) { logger.error("Failed to list rules for patch", { code: "api.rules.patch.list_failed", error: rulesResult.error }); return err(c, 500, "Internal Server Error"); }
      const rule = rulesResult.value.find((r) => r.id === ruleId);
      if (!rule) return err(c, 404, "Rule not found", "RULE_NOT_FOUND");
      const body = await zParse(UpdateRuleRequest, c.req.raw);
      // System rules (SR-*) are immutable except for enable/disable and reordering —
      // only `status`/`priorityOrder` may change.
      if (rule.accountId === "SYSTEM") {
        const changedKeys = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
        if (changedKeys.some((k) => k !== "status" && k !== "priorityOrder")) {
          return err(c, 403, "System rules can only be enabled/disabled or reordered", "SYSTEM_RULE_IMMUTABLE");
        }
        if (body.status === undefined && body.priorityOrder === undefined) {
          return err(c, 403, "System rules can only be enabled/disabled or reordered", "SYSTEM_RULE_IMMUTABLE");
        }
        const result = await accountDb.upsertSystemRuleOverride(accountId, rule.id, { status: body.status, priorityOrder: body.priorityOrder });
        if (result.isErr()) { logger.error("Failed to upsert system rule override", { code: "api.rules.patch.system_override_failed", error: result.error }); return err(c, 500, "Internal Server Error"); }
        return c.json(toApiRule({ ...rule, status: body.status ?? rule.status, priorityOrder: body.priorityOrder ?? rule.priorityOrder }), 200);
      }
      const effectiveConditionType = body.conditionType ?? rule.conditionType ?? "json_logic";
      if (effectiveConditionType === "js") {
        // If condition is being provided, validate it as JS
        if (body.condition !== undefined) {
          if (!body.condition || body.condition.trim().length === 0) {
            return err(c, 400, "condition field is required when conditionType is 'js'", "MISSING_CODE");
          }
          const astResult = astValidator ? await astValidator.validateAst(body.condition) : undefined;
          if (!astResult || astResult.isErr()) {
            const e = astResult?.error;
            const message = e?.kind === "ast_validation_error" ? e.message : (e?.message ?? "AST validator not configured");
            const location = e?.kind === "ast_validation_error" ? e.location : undefined;
            return err(c, 400, message, "INVALID_CODE", location ? { location } : undefined);
          }
        }
        // If switching to "js" conditionType without providing condition, require existing condition on the rule
        if (body.conditionType === "js" && body.condition === undefined && !rule.condition) {
          return err(c, 400, "condition field is required when conditionType is 'js'", "MISSING_CODE");
        }
      } else {
        if (body.condition) {
          const conditionError = validateRuleCondition(body.condition);
          if (conditionError) return err(c, 400, conditionError, "INVALID_CONDITION");
        }
      }
      if (body.actions) {
        const forwardError = await validateForwardTargets(accountId, body.actions as Rule["actions"], accountDb);
        if (forwardError) return err(c, 400, forwardError, "UNVERIFIED_FORWARD_TARGET");
      }
      // Clear lastError when condition is updated on a JS rule
      const updateData: Parameters<typeof accountDb.updateRule>[2] = { ...body } as Parameters<typeof accountDb.updateRule>[2];
      if (effectiveConditionType === "js" && body.condition !== undefined) {
        (updateData as Record<string, unknown>)["lastError"] = null;
      }
      // Audit: write code change event before persisting (best-effort)
      if (effectiveConditionType === "js" && body.condition !== undefined) {
        const { userId } = c.get("auth");
        const auditResult = await auditDb.saveAuditEvent({
          accountId, userId, action: "updated", resourceType: "rule", resourceId: rule.id,
          before: { conditionType: rule.conditionType ?? "json_logic", condition: rule.condition },
          after: { conditionType: effectiveConditionType, condition: body.condition },
        });
        if (auditResult.isErr()) {
          logger.warn("Audit write failed for rule update, proceeding with resource write", { code: "api.audit.rule_update_failed", accountId, ruleId: rule.id, error: auditResult.error });
        }
      }
      const updateResult = await accountDb.updateRule(accountId, rule.id, updateData);
      if (updateResult.isErr()) { logger.error("Failed to update rule", { code: "api.rules.patch.update_failed", error: updateResult.error }); return err(c, 500, "Internal Server Error"); }
      logger.info("Rule updated", { code: "api.rules.updated", accountId, ruleId });
      return c.json(toApiRule(updateResult.value), 200);
    });

    app.openapi(route({
      method: "delete",
      path: "/accounts/{accountId}/rules/{id}",
      tags: ["Rules"],
      request: { params: z.object({ accountId: z.string(), id: z.string() }) },
      middleware: [authz("rules:write", c => `accounts/${c.req.param("accountId")!}/rules/${c.req.param("id")!}`)] as const,
      responses: { 204: { description: "Rule deleted" } },
    }), async (c) => {
      const accountId = c.req.param("accountId")!;
      const ruleId = c.req.param("id")!;
      logger.info("Deleting rule", { code: "api.rules.delete", accountId, ruleId });
      const rulesResult = await accountDb.listRules(accountId);
      if (rulesResult.isErr()) { logger.error("Failed to list rules for delete", { code: "api.rules.delete.list_failed", error: rulesResult.error }); return err(c, 500, "Internal Server Error"); }
      const rule = rulesResult.value.find((r) => r.id === ruleId);
      if (!rule) return err(c, 404, "Rule not found", "RULE_NOT_FOUND");
      // System rules (SR-*) cannot be deleted — only enabled/disabled via PATCH.
      if (rule.accountId === "SYSTEM") {
        return err(c, 400, "System rules cannot be deleted", "SYSTEM_RULE_IMMUTABLE");
      }
      const deleteResult = await accountDb.deleteRule(accountId, rule.id);
      if (deleteResult.isErr()) { logger.error("Failed to delete rule", { code: "api.rules.delete_failed", error: deleteResult.error }); return err(c, 500, "Internal Server Error"); }
      logger.info("Rule deleted", { code: "api.rules.deleted", accountId, ruleId });
      return new Response(null, { status: 204 });
    });
  }
}

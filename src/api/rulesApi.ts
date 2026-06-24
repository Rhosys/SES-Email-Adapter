import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { zParse } from "./validate.js";
import { toApiRule } from "./transform.js";
import { CreateRuleRequest, UpdateRuleRequest } from "./requests.js";
import { Rule as RuleSchema, ListRulesResponse, ErrorCode } from "./schemas.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { AuditDatabase } from "../database/audit-database.js";
import type { UserCodeExecutorClient } from "../processor/user-code-client.js";
import type { BillingHandler } from "../billing/billing-handler.js";
import type { BillingPlan } from "../embedding/retention-tier.js";
import type { Logger } from "../logger.js";
import type { Rule } from "../types/index.js";
import type { AppEnv } from "./app.js";
import { validateRuleCondition } from "./validate-rule-condition.js";
import { validateWebhookConfig } from "./validate-webhook-config.js";

type ErrorCodeLiteral = z.infer<typeof ErrorCode>;

export interface RulesApiDeps {
  accountDb: AccountDatabase;
  auditDb: AuditDatabase;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authz: (permission: string, resourceUri: string | ((c: Context<AppEnv>) => string)) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  err: (c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 501 | 503, title: string, errorCode?: ErrorCodeLiteral, details?: unknown) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  route: (config: any) => any;
  astValidator: UserCodeExecutorClient;
  billingHandler: BillingHandler;
  logger: Logger;
}

async function validateForwardTargets(
  accountId: string,
  actions: Rule["actions"],
  store: Pick<AccountDatabase, "listVerifiedForwardingAddresses">,
): Promise<string | null> {
  const forwardTargets = actions.filter((a) => a.type === "forward" && a.value).map((a) => a.value!);
  if (forwardTargets.length === 0) return null;
  const verifiedResult = await store.listVerifiedForwardingAddresses(accountId);
  if (verifiedResult.isErr()) return "Internal error validating forward targets";
  const verifiedSet = new Set(verifiedResult.value.filter((v) => v.status === "verified").map((v) => v.address));
  const unverified = forwardTargets.filter((t) => !verifiedSet.has(t));
  return unverified.length > 0 ? `Forward targets not verified: ${unverified.join(", ")}` : null;
}

// Validate webhook actions: config validity + plan feature gating.
// Returns an error object if invalid, null if OK.
function validateWebhookActions(
  actions: Rule["actions"],
  accountPlan: BillingPlan,
  billing: BillingHandler,
): { message: string; code: z.infer<typeof ErrorCode> } | null {
  const webhookActions = actions.filter((a) => a.type === "webhook");
  if (webhookActions.length === 0) return null;

  for (const action of webhookActions) {
    const configError = validateWebhookConfig(action.value);
    if (configError) return { message: configError, code: "INVALID_WEBHOOK_CONFIG" };
  }

  if (!billing.isFeatureEnabled(accountPlan, "webhook")) {
    return { message: "Webhook actions require a paid plan", code: "PLAN_FEATURE_REQUIRED" };
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerRulesRoutes(app: OpenAPIHono<any>, deps: RulesApiDeps): void {
  const { accountDb, auditDb, authz, err, route, astValidator, billingHandler, logger } = deps;

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
    if (rulesResult.isErr()) return err(c, 500, "Internal Server Error");
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
    const accountResult = await accountDb.getAccount(accountId);
    const accountPlan: BillingPlan = (accountResult.isOk() && accountResult.value?.billingPlan) || "Free";
    const webhookError = validateWebhookActions(body.actions as Rule["actions"], accountPlan, billingHandler);
    if (webhookError) return err(c, 400, webhookError.message, webhookError.code);
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
    if (ruleResult.isErr()) return err(c, 500, "Internal Server Error");
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
    const rulesResult = await accountDb.listRules(accountId);
    if (rulesResult.isErr()) return err(c, 500, "Internal Server Error");
    const rule = rulesResult.value.find((r) => r.id === c.req.param("id")!);
    if (!rule) return err(c, 404, "Rule not found", "RULE_NOT_FOUND");
    const body = await zParse(UpdateRuleRequest, c.req.raw);
    // System rules (SR-*) are immutable except for enable/disable — only `status` may change.
    if (rule.accountId === "SYSTEM") {
      const changedKeys = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
      if (changedKeys.some((k) => k !== "status")) {
        return err(c, 403, "System rules can only be enabled or disabled", "SYSTEM_RULE_IMMUTABLE");
      }
      if (body.status === undefined) {
        return err(c, 403, "System rules can only be enabled or disabled", "SYSTEM_RULE_IMMUTABLE");
      }
      const result = await accountDb.upsertSystemRuleStatus(accountId, rule.id, body.status);
      if (result.isErr()) return err(c, 500, "Internal Server Error");
      return c.json(toApiRule({ ...rule, status: body.status }), 200);
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
      const accountResult = await accountDb.getAccount(accountId);
      const accountPlan: BillingPlan = (accountResult.isOk() && accountResult.value?.billingPlan) || "Free";
      const webhookError = validateWebhookActions(body.actions as Rule["actions"], accountPlan, billingHandler);
      if (webhookError) return err(c, 400, webhookError.message, webhookError.code);
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
    if (updateResult.isErr()) return err(c, 500, "Internal Server Error");
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
    const rulesResult = await accountDb.listRules(accountId);
    if (rulesResult.isErr()) return err(c, 500, "Internal Server Error");
    const rule = rulesResult.value.find((r) => r.id === c.req.param("id")!);
    if (!rule) return err(c, 404, "Rule not found", "RULE_NOT_FOUND");
    // System rules (SR-*) cannot be deleted — only enabled/disabled via PATCH.
    if (rule.accountId === "SYSTEM") {
      return err(c, 400, "System rules cannot be deleted", "SYSTEM_RULE_IMMUTABLE");
    }
    const deleteResult = await accountDb.deleteRule(accountId, rule.id);
    if (deleteResult.isErr()) return err(c, 500, "Internal Server Error");
    return new Response(null, { status: 204 });
  });
}

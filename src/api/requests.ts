import { z } from "zod";
import { WORKFLOWS } from "../types/index.js";

// ---- Shared primitives ----

const UnknownSenderPolicy = z.enum(["allow_all", "quarantine_visible", "quarantine_hidden", "block_hidden", "block_reject", "violate_report"]);
const ArcStatus = z.enum(["active", "archived", "deleted"]);
const ArcUrgency = z.enum(["critical", "high", "normal", "low", "silent"]);
const Workflow = z.enum(WORKFLOWS);
const SortField = z.enum(["lastSignalAt", "createdAt"]);
const SortDirection = z.enum(["asc", "desc"]);
const NewAddressHandling = z.enum(["auto_allow", "block_until_approved"]);
const AccountRole = z.enum(["owner", "admin", "member", "viewer"]);
const RuleActionType = z.enum([
  "assign_label", "assign_workflow", "archive", "delete", "forward",
  "block_hidden", "block_reject", "quarantine", "quarantine_hidden", "set_urgency", "suppress_notification", "pong", "approve_sender",
  "auto_draft",
]);
const RuleStatus = z.enum(["enabled", "disabled"]);

const EmailAddressSchema = z.object({
  address: z.string(),
  name: z.string().optional(),
});

const RuleActionSchema = z.object({
  type: RuleActionType,
  value: z.string().optional(),
  disabled: z.boolean().optional(),
});

// ---- Arc ----

export const UpdateArcRequest = z.object({
  status: ArcStatus.optional(),
  urgency: ArcUrgency.optional(),
  labels: z.array(z.string()).optional(),
});
export type UpdateArcRequest = z.infer<typeof UpdateArcRequest> & { lastSignalAt?: string };

// ---- Signal ----

export const UpdateSignalStatusRequest = z.object({
  status: z.enum(["active", "block_hidden", "block_reject", "violate_report"]),
});
export type UpdateSignalStatusRequest = z.infer<typeof UpdateSignalStatusRequest>;

export const UpdateSignalRequest = z.object({
  status: z.literal("draft").optional(),
  subject: z.string().optional(),
  textBody: z.string().optional(),
  from: EmailAddressSchema.optional(),
  to: z.array(EmailAddressSchema).optional(),
});
export type UpdateSignalRequest = z.infer<typeof UpdateSignalRequest>;

export const CreateDraftSignalRequest = z.object({
  from: EmailAddressSchema,
  to: z.array(EmailAddressSchema).min(1),
  subject: z.string(),
  textBody: z.string().optional(),
});
export type CreateDraftSignalRequest = z.infer<typeof CreateDraftSignalRequest>;

export const ReplaceDraftSignalRequest = z.object({
  from: EmailAddressSchema,
  to: z.array(EmailAddressSchema).min(1),
  subject: z.string(),
  textBody: z.string().optional(),
});
export type ReplaceDraftSignalRequest = z.infer<typeof ReplaceDraftSignalRequest>;

// ---- View ----

export const CreateViewRequest = z.object({
  name: z.string(),
  workflow: Workflow.optional(),
  labels: z.array(z.string()).optional(),
  sortField: SortField.optional(),
  sortDirection: SortDirection.optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  position: z.number().optional(),
});
export type CreateViewRequest = z.infer<typeof CreateViewRequest>;

export const UpdateViewRequest = z.object({
  name: z.string().optional(),
  workflow: Workflow.optional(),
  labels: z.array(z.string()).optional(),
  sortField: SortField.optional(),
  sortDirection: SortDirection.optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  position: z.number().optional(),
  layout: z.array(z.unknown()).nullable().optional(),
});
export type UpdateViewRequest = z.infer<typeof UpdateViewRequest>;

// ---- Label ----

export const CreateLabelRequest = z.object({
  name: z.string(),
  color: z.string().optional(),
  icon: z.string().optional(),
});
export type CreateLabelRequest = z.infer<typeof CreateLabelRequest>;

export const UpdateLabelRequest = z.object({
  name: z.string().optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
});
export type UpdateLabelRequest = z.infer<typeof UpdateLabelRequest>;

// ---- Rule ----

export const CreateRuleRequest = z.object({
  name: z.string(),
  conditionType: z.enum(["json_logic", "js"]).optional(),
  condition: z.string().max(10_240).optional(),
  code: z.string().max(10_240).optional(),
  actions: z.array(RuleActionSchema).min(1),
  priorityOrder: z.number().int().min(0).optional(),
  status: RuleStatus.optional(),
  tags: z.record(z.string(), z.string()).optional(),
});
export type CreateRuleRequest = z.infer<typeof CreateRuleRequest>;

export const UpdateRuleRequest = z.object({
  name: z.string().optional(),
  conditionType: z.enum(["json_logic", "js"]).optional(),
  condition: z.string().max(10_240).optional(),
  code: z.string().max(10_240).optional(),
  actions: z.array(RuleActionSchema).optional(),
  priorityOrder: z.number().int().min(0).optional(),
  status: RuleStatus.optional(),
  tags: z.record(z.string(), z.string()).optional(),
});
export type UpdateRuleRequest = z.infer<typeof UpdateRuleRequest>;

// ---- Domain ----

export const CreateDomainRequest = z.object({
  domain: z.string(),
});
export type CreateDomainRequest = z.infer<typeof CreateDomainRequest>;

// ---- Alias ----

export const CreateAliasRequest = z.object({
  address: z.string(),
  unknownSenderPolicy: UnknownSenderPolicy.optional(),
  createdForOrigin: z.string().optional(),
});
export type CreateAliasRequest = z.infer<typeof CreateAliasRequest>;

export const UpdateAliasRequest = z.object({
  newAddress: z.string().email().optional(),
  unknownSenderPolicy: UnknownSenderPolicy.optional(),
  spamScoreThreshold: z.number().min(0).max(1).optional(),
  createdForOrigin: z.string().optional(),
});
export type UpdateAliasRequest = z.infer<typeof UpdateAliasRequest>;

// ---- Alias Senders ----

export const CreateSenderRequest = z.object({
  domain: z.string(),
  policy: z.enum(["allow", "block_hidden", "block_reject", "violate_report"]),
});
export type CreateSenderRequest = z.infer<typeof CreateSenderRequest>;

// ---- Email Templates ----

export const TemplateFunctionSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/),
  code: z.string().max(10_240),
});
export type TemplateFunctionSchema = z.infer<typeof TemplateFunctionSchema>;

export const CreateTemplateRequest = z.object({
  name: z.string().min(1),
  subject: z.string(),
  body: z.string(),
  functions: z.array(TemplateFunctionSchema).optional(),
});
export type CreateTemplateRequest = z.infer<typeof CreateTemplateRequest>;

export const ReplaceTemplateRequest = z.object({
  name: z.string().min(1),
  subject: z.string(),
  body: z.string(),
  functions: z.array(TemplateFunctionSchema).optional(),
});
export type ReplaceTemplateRequest = z.infer<typeof ReplaceTemplateRequest>;

export const UpdateTemplateRequest = z.object({
  name: z.string().min(1).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  functions: z.array(TemplateFunctionSchema).optional(),
});
export type UpdateTemplateRequest = z.infer<typeof UpdateTemplateRequest>;

// ---- Account ----

const EmailNotificationSettingsSchema = z.object({
  enabled: z.boolean(),
  address: z.string(),
  frequency: z.enum(["instant", "hourly", "daily"]),
});

const PushNotificationSettingsSchema = z.object({
  enabled: z.boolean(),
});

const NotificationSettingsSchema = z.object({
  email: EmailNotificationSettingsSchema.optional(),
  push: PushNotificationSettingsSchema.optional(),
});

const AccountFilteringConfigSchema = z.object({
  defaultUnknownSenderPolicy: UnknownSenderPolicy.optional(),
  newAddressHandling: NewAddressHandling.optional(),
  spamScoreThreshold: z.number().min(0).max(1).optional(),
}).passthrough();

const AccountOnboardingSchema = z.object({
  completed: z.boolean(),
  completedAt: z.string().optional(),
}).passthrough();

export const UpdateAccountRequest = z.object({
  name: z.string().optional(),
  deletionRetentionDays: z.number().int().positive().optional(),
  notifications: NotificationSettingsSchema.optional(),
  filtering: AccountFilteringConfigSchema.optional(),
  onboarding: AccountOnboardingSchema.optional(),
  afterSendAction: z.enum(["archive", "keep_active"]).optional(),
});
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequest>;

// ---- Forwarding addresses ----

export const CreateForwardingAddressRequest = z.object({
  address: z.string(),
});
export type CreateForwardingAddressRequest = z.infer<typeof CreateForwardingAddressRequest>;

export const VerifyForwardingAddressRequest = z.object({
  token: z.string(),
});
export type VerifyForwardingAddressRequest = z.infer<typeof VerifyForwardingAddressRequest>;

// ---- Users ----

export const InviteUserRequest = z.object({
  email: z.string(),
  role: z.enum(["admin", "member", "viewer"]),
});
export type InviteUserRequest = z.infer<typeof InviteUserRequest>;

export const UpdateUserRequest = z.object({
  role: AccountRole,
});
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;

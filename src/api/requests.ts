import { z } from "zod";
import { emailRegex } from "../email/validate-email.js";
import { WORKFLOWS } from "../types/index.js";
import { RetentionDuration } from "./schemas.js";

// ---- Shared primitives ----

const UnknownSenderPolicy = z.enum(["allow_all", "quarantine_visible", "quarantine_hidden", "block_hidden", "block_reject", "report_violation"]);

// Lowercases + trims, then validates with both Zod's email check and the RFC regex.
const lowerEmail = z.string()
  .transform(s => s.toLowerCase().trim())
  .pipe(z.string().email().regex(emailRegex, "Invalid email address"));

// Lowercases + trims a domain string (no email-format validation).
const lowerDomain = z.string().transform(s => s.toLowerCase().trim());
const ThreadStatus = z.enum(["active", "archived", "deleted", "report_violation"]);
const ResourceStatus = z.enum(["active", "complete"]);
const ThreadUrgency = z.enum(["critical", "high", "normal", "low", "silent"]);
const Workflow = z.enum(WORKFLOWS);
const SortField = z.enum(["lastSignalAt", "createdAt"]);
const SortDirection = z.enum(["asc", "desc"]);
const AccountRole = z.enum(["admin", "member", "viewer"]);
const RuleActionType = z.enum([
  "assign_label", "assign_workflow", "archive", "forward",
  "block_hidden", "block_reject", "quarantine_visible", "quarantine_hidden", "set_urgency", "suppress_notification", "pong", "approve_sender",
  "auto_draft", "forwardCalendarInvite",
]);
const RuleStatus = z.enum(["enabled", "disabled"]);

const EmailAddressSchema = z.object({
  address: z.string(),
  name: z.string().optional(),
});

const RuleActionSchema = z.object({
  type: RuleActionType,
  value: z.string().optional(),
});

// ---- Thread ----

export const UpdateThreadRequest = z.object({
  status: ThreadStatus.optional(),
  urgency: ThreadUrgency.optional(),
  labels: z.array(z.string()).optional(),
  lastSignalAt: z.string().optional(),
  followupAt: z.string().datetime().optional(),
});
export type UpdateThreadRequest = z.infer<typeof UpdateThreadRequest>;

// ---- Resource ----

export const UpdateResourceRequest = z.object({
  status: ResourceStatus,
});
export type UpdateResourceRequest = z.infer<typeof UpdateResourceRequest>;

// ---- Signal ----

export const QuarantineResponse = z.object({
  status: z.enum(["active", "block_hidden", "block_reject", "report_violation", "dismiss"]),
});
export type QuarantineResponse = z.infer<typeof QuarantineResponse>;

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
  actions: z.array(RuleActionSchema).optional(),
  priorityOrder: z.number().int().min(0).optional(),
  status: RuleStatus.optional(),
  tags: z.record(z.string(), z.string()).optional(),
});
export type UpdateRuleRequest = z.infer<typeof UpdateRuleRequest>;

// ---- Domain ----

export const CreateDomainRequest = z.object({
  domain: lowerDomain,
});
export type CreateDomainRequest = z.infer<typeof CreateDomainRequest>;

// ---- Alias ----

export const CreateAliasRequest = z.object({
  address: lowerEmail,
  unknownSenderPolicy: UnknownSenderPolicy.optional(),
  createdForOrigin: z.string().optional(),
});
export type CreateAliasRequest = z.infer<typeof CreateAliasRequest>;

export const UpdateAliasRequest = z.object({
  newAddress: lowerEmail.optional(),
  unknownSenderPolicy: UnknownSenderPolicy.optional(),
  createdForOrigin: z.string().optional(),
});
export type UpdateAliasRequest = z.infer<typeof UpdateAliasRequest>;

// ---- Alias Senders ----

export const CreateSenderRequest = z.object({
  domain: lowerDomain,
  policy: z.enum(["allow", "block_hidden", "block_reject", "report_violation"]),
});
export type CreateSenderRequest = z.infer<typeof CreateSenderRequest>;

export const UpdateSenderRequest = z.object({
  policy: z.enum(["allow", "block_hidden", "block_reject", "report_violation"]),
});
export type UpdateSenderRequest = z.infer<typeof UpdateSenderRequest>;

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

const AccountFilteringConfigSchema = z.object({
  defaultUnknownSenderPolicy: UnknownSenderPolicy.optional(),
}).passthrough();

const AccountOnboardingSchema = z.object({
  completed: z.boolean().optional(),
  completedAt: z.string().optional(),
  testEmailReceived: z.boolean().optional(),
  testEmailReceivedAt: z.string().optional(),
}).passthrough();

const DigestSchema = z.object({
  frequency: z.enum(["daily", "weekly", "monthly"]),
  forwardingTargetId: z.string(),
}).nullable().optional();

export const UpdateAccountRequest = z.object({
  name: z.string().optional(),
  retentionDuration: RetentionDuration.optional(),
  digest: DigestSchema,
  filtering: AccountFilteringConfigSchema.optional(),
  onboarding: AccountOnboardingSchema.optional(),
  defaultCalendarInviteForwardingTargetId: z.string().nullable().optional(),
});
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequest>;

// ---- Forwarding targets ----

export const CreateForwardingTargetRequest = z.discriminatedUnion("type", [
  z.object({ target: lowerEmail, type: z.literal("email") }),
  z.object({ target: z.string().url(), type: z.literal("webhook") }),
]);
export type CreateForwardingTargetRequest = z.infer<typeof CreateForwardingTargetRequest>;

export const VerifyForwardingTargetRequest = z.object({
  token: z.string(),
});
export type VerifyForwardingTargetRequest = z.infer<typeof VerifyForwardingTargetRequest>;

// ---- Calendar RSVP ----

export const RsvpRequest = z.object({
  decision: z.enum(["accepted", "declined", "tentative"]),
});
export type RsvpRequest = z.infer<typeof RsvpRequest>;

// ---- Users ----

export const InviteUserRequest = z.object({
  // Only trim+lowercase — the handler calls isValidEmail() for structured error reporting.
  email: z.string().transform(s => s.toLowerCase().trim()),
  role: z.enum(["admin", "member", "viewer"]),
});
export type InviteUserRequest = z.infer<typeof InviteUserRequest>;

export const UpdateUserRequest = z.object({
  role: AccountRole,
});
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;

// ---- User Configuration ----

export const UpdateUserConfigurationRequest = z.object({
  postSendView: z.enum(["return_to_inbox", "stay_on_thread"]).optional(),
});
export type UpdateUserConfigurationRequest = z.infer<typeof UpdateUserConfigurationRequest>;

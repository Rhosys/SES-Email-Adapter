import { z } from "zod";
import { WORKFLOWS } from "../types/index.js";

// ---- Shared primitives ----

const SenderFilterMode = z.enum(["strict", "sender_match", "notify_new", "allow_all"]);
const ArcStatus = z.enum(["active", "archived", "deleted"]);
const ArcUrgency = z.enum(["critical", "high", "normal", "low", "silent"]);
const Workflow = z.enum(WORKFLOWS);
const SortField = z.enum(["lastSignalAt", "createdAt"]);
const SortDirection = z.enum(["asc", "desc"]);
const NewAddressHandling = z.enum(["auto_allow", "block_until_approved"]);
const AccountRole = z.enum(["owner", "admin", "member", "viewer"]);
const RuleActionType = z.enum([
  "assign_label", "assign_workflow", "archive", "delete", "forward",
  "block", "quarantine", "set_urgency", "suppress_notification", "pong", "approve_sender",
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
export type UpdateArcRequest = z.infer<typeof UpdateArcRequest>;

export const CreateArcFromSignalRequest = z.object({
  signalId: z.string(),
  approveSender: z.boolean().optional(),
  updateFilterMode: SenderFilterMode.optional(),
});
export type CreateArcFromSignalRequest = z.infer<typeof CreateArcFromSignalRequest>;

// ---- Signal ----

export const UpdateSignalStatusRequest = z.object({
  status: z.enum(["active", "blocked"]),
});
export type UpdateSignalStatusRequest = z.infer<typeof UpdateSignalStatusRequest>;

export const UpdateSignalRequest = z.object({
  subject: z.string().optional(),
  textBody: z.string().optional(),
  from: EmailAddressSchema.optional(),
  to: z.array(EmailAddressSchema).optional(),
});
export type UpdateSignalRequest = z.infer<typeof UpdateSignalRequest>;

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
  condition: z.string().optional(),
  actions: z.array(RuleActionSchema).min(1),
  priorityOrder: z.number().int().min(0).optional(),
});
export type CreateRuleRequest = z.infer<typeof CreateRuleRequest>;

export const UpdateRuleRequest = z.object({
  name: z.string().optional(),
  condition: z.string().optional(),
  actions: z.array(RuleActionSchema).optional(),
  priorityOrder: z.number().int().min(0).optional(),
  status: RuleStatus.optional(),
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
  filterMode: SenderFilterMode.optional(),
  createdForOrigin: z.string().optional(),
});
export type CreateAliasRequest = z.infer<typeof CreateAliasRequest>;

export const UpdateAliasRequest = z.object({
  filterMode: SenderFilterMode.optional(),
  approvedSenders: z.array(z.string()).optional(),
  spamScoreThreshold: z.number().min(0).max(1).optional(),
  createdForOrigin: z.string().optional(),
});
export type UpdateAliasRequest = z.infer<typeof UpdateAliasRequest>;

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
  defaultFilterMode: SenderFilterMode.optional(),
  newAddressHandling: NewAddressHandling.optional(),
  spamScoreThreshold: z.number().min(0).max(1).optional(),
}).passthrough();

export const UpdateAccountRequest = z.object({
  name: z.string().optional(),
  deletionRetentionDays: z.number().int().positive().optional(),
  notifications: NotificationSettingsSchema.optional(),
  filtering: AccountFilteringConfigSchema.optional(),
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
  userId: z.string(),
  role: AccountRole,
});
export type InviteUserRequest = z.infer<typeof InviteUserRequest>;

export const UpdateUserRequest = z.object({
  role: AccountRole,
});
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;

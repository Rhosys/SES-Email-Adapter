import type { Result } from "neverthrow";
import { ok, err } from "neverthrow";

export interface WebhookConfig {
  url: string;
}

/** Used at API layer — returns a human-readable error string or null if valid */
export function validateWebhookConfig(value: string | undefined): string | null {
  if (!value) return "webhook action requires a value field containing the endpoint URL configuration";

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return "webhook action value must be valid JSON";
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "webhook action value must be a JSON object";
  }

  const config = parsed as Record<string, unknown>;
  if (typeof config.url !== "string" || config.url.trim().length === 0) {
    return "webhook action value must contain a non-empty 'url' field";
  }

  try {
    const url = new URL(config.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "webhook URL must use http or https protocol";
    }
  } catch {
    return "webhook URL is not a valid URL";
  }

  return null;
}

/** Used at processor layer — returns a Result<WebhookConfig, string> */
export function parseWebhookConfig(value: string | undefined): Result<WebhookConfig, string> {
  const error = validateWebhookConfig(value);
  if (error) return err(error);
  const config = JSON.parse(value!) as WebhookConfig;
  return ok(config);
}

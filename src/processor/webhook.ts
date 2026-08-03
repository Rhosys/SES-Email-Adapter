import type { Logger } from "../logger.js";
import type { Signal, Thread } from "../types/index.js";
import { ok, err } from "../errors.js";
import type { Result } from "../errors.js";

export interface WebhookPayload {
  id: string;
  threadId: string | undefined;
  receivedAt: string;
  from: { address: string; name?: string };
  to: Array<{ address: string; name?: string }>;
  cc: Array<{ address: string; name?: string }>;
  replyTo?: { address: string; name?: string };
  subject: string;
  alias: string;
  workflow: string;
  workflowData: Record<string, unknown>;
  summary: string;
  labels: string[];
}

export function buildWebhookPayload(signal: Signal, thread: Thread | null): WebhookPayload {
  return {
    id: signal.id,
    threadId: signal.threadId,
    receivedAt: signal.data.receivedAt,
    from: { address: signal.data.from.address, ...(signal.data.from.name ? { name: signal.data.from.name } : {}) },
    to: signal.data.to.map(a => ({ address: a.address, ...(a.name ? { name: a.name } : {}) })),
    cc: signal.data.cc.map(a => ({ address: a.address, ...(a.name ? { name: a.name } : {}) })),
    ...(signal.data.replyTo ? { replyTo: { address: signal.data.replyTo.address, ...(signal.data.replyTo.name ? { name: signal.data.replyTo.name } : {}) } } : {}),
    subject: signal.data.subject,
    alias: signal.data.recipientAddress,
    workflow: signal.data.workflow,
    workflowData: signal.data.workflowData as unknown as Record<string, unknown>,
    summary: signal.data.summary,
    labels: thread?.labels ?? [],
  };
}

export interface WebhookSuccess {
  statusCode: number;
}

export type WebhookError = { kind: "webhook_error"; cause: unknown; statusCode?: number | undefined };
export const webhookError = (cause: unknown, statusCode?: number): WebhookError => ({ kind: "webhook_error", cause, ...(statusCode !== undefined ? { statusCode } : {}) });

export async function deliverWebhook(url: string, payload: WebhookPayload, logger: Logger): Promise<Result<WebhookSuccess, WebhookError>> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      logger.track("Webhook delivery failed — non-2xx response.", {
        code: "processor.side_effect.webhook_failed",
        url,
        statusCode: response.status,
      });
      return err(webhookError("non-2xx response", response.status));
    }

    logger.info("Webhook delivered", { code: "processor.webhook.delivered", url, statusCode: response.status });
    return ok({ statusCode: response.status });
  } catch (e) {
    logger.track("Webhook delivery failed — network error or timeout.", {
      code: "processor.side_effect.webhook_error",
      url,
      error: e,
    });
    return err(webhookError(e));
  }
}

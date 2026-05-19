import type { Logger } from "../logger.js";
import type { Signal, Arc } from "../types/index.js";

export interface WebhookPayload {
  id: string;
  arcId: string | undefined;
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

export function buildWebhookPayload(signal: Signal, arc: Arc | null): WebhookPayload {
  return {
    id: signal.id,
    arcId: signal.arcId,
    receivedAt: signal.receivedAt,
    from: { address: signal.from.address, ...(signal.from.name ? { name: signal.from.name } : {}) },
    to: signal.to.map(a => ({ address: a.address, ...(a.name ? { name: a.name } : {}) })),
    cc: signal.cc.map(a => ({ address: a.address, ...(a.name ? { name: a.name } : {}) })),
    ...(signal.replyTo ? { replyTo: { address: signal.replyTo.address, ...(signal.replyTo.name ? { name: signal.replyTo.name } : {}) } } : {}),
    subject: signal.subject,
    alias: signal.recipientAddress,
    workflow: signal.workflow,
    workflowData: signal.workflowData as unknown as Record<string, unknown>,
    summary: signal.summary,
    labels: arc?.labels ?? [],
  };
}

export interface WebhookDeliveryResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

export async function deliverWebhook(url: string, payload: WebhookPayload, logger: Logger): Promise<WebhookDeliveryResult> {
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
      return { success: false, statusCode: response.status };
    }

    return { success: true, statusCode: response.status };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.track("Webhook delivery failed — network error or timeout.", {
      code: "processor.side_effect.webhook_error",
      url,
      error: message,
    });
    return { success: false, error: message };
  }
}

import { GoogleAuth } from "google-auth-library";

// ─── FCM Message Types ───────────────────────────────────────────────────────

export interface FcmMessage {
  token: string;
  notification?: { title: string; body: string };
  data: Record<string, string>;
  android: { priority: "high" | "normal"; notification?: { sound: string; channelId: string } };
  apns: { headers: { "apns-priority": "10" | "5" }; payload: { aps: { sound?: string; badge?: number; "content-available"?: number } } };
}

export type FcmSendResult =
  | { ok: true; messageId: string }
  | { ok: false; error: "UNREGISTERED" | "QUOTA_EXCEEDED" | "UNAVAILABLE" | "INTERNAL" | "INVALID_ARGUMENT"; detail?: string };

// ─── FcmClient Interface ─────────────────────────────────────────────────────

export interface FcmClient {
  send(message: FcmMessage): Promise<FcmSendResult>;
}

// ─── Error Code Mapping ──────────────────────────────────────────────────────

type FcmErrorCode = FcmSendResult & { ok: false };

const FCM_ERROR_MAP: Record<string, FcmErrorCode["error"]> = {
  "NOT_FOUND": "UNREGISTERED",
  "UNREGISTERED": "UNREGISTERED",
  "QUOTA_EXCEEDED": "QUOTA_EXCEEDED",
  "UNAVAILABLE": "UNAVAILABLE",
  "INTERNAL": "INTERNAL",
  "INVALID_ARGUMENT": "INVALID_ARGUMENT",
};

function mapFcmError(status: number, errorCode?: string): FcmErrorCode["error"] {
  if (errorCode && errorCode in FCM_ERROR_MAP) {
    return FCM_ERROR_MAP[errorCode]!;
  }
  if (status === 404) return "UNREGISTERED";
  if (status === 429) return "QUOTA_EXCEEDED";
  if (status === 503) return "UNAVAILABLE";
  if (status >= 500) return "INTERNAL";
  return "INVALID_ARGUMENT";
}

// ─── HttpFcmClient Implementation ───────────────────────────────────────────

export class HttpFcmClient implements FcmClient {
  private readonly auth: GoogleAuth;
  private readonly endpoint: string;

  constructor(opts: { projectId: string; credentials?: object }) {
    this.endpoint = `https://fcm.googleapis.com/v1/projects/${opts.projectId}/messages:send`;
    this.auth = opts.credentials
      ? new GoogleAuth({ credentials: opts.credentials as Record<string, string>, scopes: ["https://www.googleapis.com/auth/firebase.messaging"] })
      : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
  }

  async send(message: FcmMessage): Promise<FcmSendResult> {
    const accessToken = await this.getAccessToken();

    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    });

    if (response.ok) {
      const body = await response.json() as { name: string };
      return { ok: true, messageId: body.name };
    }

    const body = await response.json().catch(() => ({})) as {
      error?: { code?: number; status?: string; details?: Array<{ errorCode?: string }> };
    };

    const errorCode = body.error?.details?.[0]?.errorCode ?? body.error?.status;
    const mappedError = mapFcmError(response.status, errorCode);

    return { ok: false, error: mappedError, detail: `HTTP ${response.status}: ${errorCode ?? "unknown"}` };
  }

  private async getAccessToken(): Promise<string> {
    const client = await this.auth.getClient();
    const tokenResponse = await client.getAccessToken();
    return tokenResponse.token ?? "";
  }
}

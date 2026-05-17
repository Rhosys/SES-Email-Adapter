import { createSign } from "crypto";
import type { Logger } from "../logger.js";

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

// ─── Service Account JWT → Access Token ──────────────────────────────────────

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

const TOKEN_LIFETIME_SECONDS = 3600;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

function createJwt(credentials: ServiceAccountCredentials, scope: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: credentials.client_email,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + TOKEN_LIFETIME_SECONDS,
  }));

  const signInput = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signInput);
  const signature = sign.sign(credentials.private_key, "base64url");

  return `${signInput}.${signature}`;
}

async function exchangeJwtForAccessToken(jwt: string): Promise<{ token: string; expiresAt: number }> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!response.ok) {
    throw new Error(`Google OAuth token exchange failed: HTTP ${response.status}`);
  }

  const body = await response.json() as { access_token: string; expires_in: number };
  return {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
}

// ─── HttpFcmClient Implementation ───────────────────────────────────────────

export class HttpFcmClient implements FcmClient {
  private readonly credentials: ServiceAccountCredentials;
  private readonly endpoint: string;
  private readonly logger: Logger;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(opts: { projectId: string; credentials: ServiceAccountCredentials; logger: Logger }) {
    this.endpoint = `https://fcm.googleapis.com/v1/projects/${opts.projectId}/messages:send`;
    this.credentials = opts.credentials;
    this.logger = opts.logger;
  }

  async send(message: FcmMessage): Promise<FcmSendResult> {
    if (!this.credentials.client_email || !this.credentials.private_key) {
      this.logger.track("FCM push skipped — no service account configured. To enable mobile push: (1) create a Firebase project, (2) Project Settings → Service Accounts → Generate new private key, (3) KMS-encrypt the JSON, (4) set FCM_SERVICE_ACCOUNT env var to the decrypted JSON at deploy time, (5) set FCM_PROJECT_ID to the Firebase project ID.", { code: "fcm.no_credentials", token: message.token });
      return { ok: false, error: "UNAVAILABLE", detail: "FCM service account not configured" };
    }

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

    let body: { error?: { code?: number; status?: string; details?: Array<{ errorCode?: string }> } };
    try {
      body = await response.json() as typeof body;
    } catch {
      body = {};
    }

    const errorCode = body.error?.details?.[0]?.errorCode ?? body.error?.status;
    const mappedError = mapFcmError(response.status, errorCode);

    return { ok: false, error: mappedError, detail: `HTTP ${response.status}: ${errorCode ?? "unknown"}` };
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.cachedToken.token;
    }

    const jwt = createJwt(this.credentials, "https://www.googleapis.com/auth/firebase.messaging");
    this.cachedToken = await exchangeJwtForAccessToken(jwt);
    return this.cachedToken.token;
  }
}

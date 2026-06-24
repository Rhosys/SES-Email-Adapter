import type { Context } from "hono";
import type { z } from "@hono/zod-openapi";
import type { ErrorCode } from "./schemas.js";

export interface AppEnv { Variables: { auth: { userId: string }; authorizationVerified?: boolean; [key: string]: unknown } }

type ErrorCodeLiteral = z.infer<typeof ErrorCode>;

export interface RouteHelpers {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  authz: (permission: string, resourceUri: string | ((c: Context<AppEnv>) => string)) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  err: (c: Context<AppEnv>, status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 501 | 503, title: string, errorCode?: ErrorCodeLiteral, details?: unknown) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  route: (config: any) => any;
}

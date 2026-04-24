import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AuthService, AuthContext } from "./app.js";

const AUTHRESS_DOMAIN = process.env["AUTHRESS_DOMAIN"] ?? "";
const AUTHRESS_APPLICATION_ID = process.env["AUTHRESS_APPLICATION_ID"] ?? "";

// JWKS set is cached in module scope and reused across warm invocations
const JWKS = createRemoteJWKSet(
  new URL(`https://${AUTHRESS_DOMAIN}/.well-known/jwks.json`),
);

export class AuthressAuthService implements AuthService {
  async verify(token: string): Promise<AuthContext> {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://${AUTHRESS_DOMAIN}`,
      ...(AUTHRESS_APPLICATION_ID ? { audience: AUTHRESS_APPLICATION_ID } : {}),
    });

    const sub = payload.sub;
    if (!sub) throw new Error("JWT missing sub claim");

    // Authress sub is the user ID; derive accountId from it.
    // If your Authress setup uses org accounts, extract from a custom claim instead.
    const accountId = (payload["accountId"] as string | undefined) ?? sub;

    return { accountId, userId: sub };
  }
}

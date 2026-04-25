import { TokenVerifier } from "@authress/sdk";
import type { AuthService, AuthContext } from "./app.js";

const AUTHRESS_DOMAIN = process.env["AUTHRESS_DOMAIN"] ?? "";

export class AuthressAuthService implements AuthService {
  async verify(token: string): Promise<AuthContext> {
    const identity = await TokenVerifier(AUTHRESS_DOMAIN, token) as { userId?: string };
    const userId = identity.userId;
    if (!userId) throw new Error("Token missing userId");
    return { accountId: userId, userId };
  }
}

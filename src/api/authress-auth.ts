import { TokenVerifier } from "@authress/sdk";
import type { AuthService, AuthContext } from "./app.js";
import { AUTHRESS_APP_ID } from "./authress-access.js";

const AUTHRESS_API_URL = "https://login.rhosys.cloud";

export class AuthressAuthService implements AuthService {
  async verify(token: string): Promise<AuthContext> {
    const identity = await TokenVerifier(AUTHRESS_API_URL, token) as { userId?: string; sub?: string };
    const userId = identity.userId ?? identity.sub;
    if (!userId) throw new Error("Token missing userId");
    return { accountId: userId, userId };
  }
}

// Re-export for shared usage
export { AUTHRESS_APP_ID };

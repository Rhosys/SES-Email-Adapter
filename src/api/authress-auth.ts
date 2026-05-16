import { TokenVerifier } from "@authress/sdk";
import { ok, err, authError } from "../errors.js";
import type { AuthError, Result } from "../errors.js";
import type { AuthService } from "./app.js";
import { AUTHRESS_APP_ID } from "./authress-access.js";

const AUTHRESS_API_URL = "https://login.rhosys.cloud";

export class AuthressAuthService implements AuthService {
  async verify(token: string): Promise<Result<{ userId: string }, AuthError>> {
    try {
      const identity = await TokenVerifier(AUTHRESS_API_URL, token) as { userId?: string; sub?: string };
      const userId = identity.userId ?? identity.sub;
      if (!userId) return err(authError("Token missing userId"));
      return ok({ userId });
    } catch (e) {
      return err(authError(e));
    }
  }
}

// Re-export for shared usage
export { AUTHRESS_APP_ID };

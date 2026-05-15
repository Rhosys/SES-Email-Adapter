import { TokenVerifier } from "@authress/sdk";
import { ResultAsync } from "neverthrow";
import { authError } from "../errors.js";
import type { AuthError } from "../errors.js";
import type { AuthService, AuthContext } from "./app.js";
import { AUTHRESS_APP_ID } from "./authress-access.js";

const AUTHRESS_API_URL = "https://login.rhosys.cloud";

export class AuthressAuthService implements AuthService {
  verify(token: string): ResultAsync<AuthContext, AuthError> {
    return ResultAsync.fromPromise(
      (async () => {
        const identity = await TokenVerifier(AUTHRESS_API_URL, token) as { userId?: string; sub?: string };
        const userId = identity.userId ?? identity.sub;
        if (!userId) throw new Error("Token missing userId");
        return { accountId: userId, userId } as AuthContext;
      })(),
      (e) => authError(e instanceof Error ? e : new Error(String(e))),
    );
  }
}

// Re-export for shared usage
export { AUTHRESS_APP_ID };

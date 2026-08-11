import { z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { UnsubscribeTokenGenerator } from "../email/unsubscribe-token-generator.js";
import type { AccountDatabase } from "../database/account-database.js";
import type { Logger } from "../logger.js";
import type { AppEnv, RouteHelpers } from "./route-helpers.js";

// ---------------------------------------------------------------------------
// UnsubscribeApi — public RFC 8058 one-click unsubscribe endpoint
//
// No authz middleware: the signed token carried in `code` is the credential.
// ---------------------------------------------------------------------------

export class UnsubscribeApi {
  constructor(
    private readonly tokenGenerator: UnsubscribeTokenGenerator,
    private readonly accountDb: AccountDatabase,
    private readonly logger: Logger,
  ) {}

  register(app: OpenAPIHono<AppEnv>, { err, route }: RouteHelpers): void {
    const { tokenGenerator, accountDb, logger } = this;

    app.openapi(route({
      method: "post",
      path: "/accounts/{accountId}/unsubscribe",
      tags: ["Unsubscribe"],
      request: {
        params: z.object({ accountId: z.string() }),
        query: z.object({ code: z.string() }),
      },
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ status: z.string() }) } },
          description: "Unsubscribe processed",
        },
      },
    }), async (c) => {
      c.set("authorizationVerified", true);
      const accountId = c.req.param("accountId")!;
      const code = c.req.query("code");
      if (!code) return err(c, 400, "Missing unsubscribe code");

      const verified = await tokenGenerator.verify(code);
      if (verified.isErr()) {
        logger.warn("Unsubscribe token verification failed.", { code: "api.unsubscribe.verify_failed", accountId, error: verified.error });
        return err(c, 400, "Invalid or expired unsubscribe link");
      }

      if (verified.value.accountId !== accountId) {
        logger.warn("Unsubscribe token account did not match the request path.", { code: "api.unsubscribe.account_mismatch", accountId, tokenAccountId: verified.value.accountId });
        return err(c, 400, "Invalid unsubscribe link");
      }

      const updateResult = await accountDb.updateAccount(accountId, { digest: null });
      if (updateResult.isErr()) {
        logger.error("Failed to disable digest during unsubscribe.", { code: "api.unsubscribe.update_failed", accountId, error: updateResult.error });
        return err(c, 500, "Internal Server Error");
      }

      logger.track("Digest unsubscribe processed — digest disabled.", { code: "api.unsubscribe.digest_disabled", accountId });
      return c.json({ status: "unsubscribed" }, 200);
    });
  }
}

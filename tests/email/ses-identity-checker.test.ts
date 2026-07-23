import { describe, it, expect, vi } from "vitest";
import { SESv2Client, GetEmailIdentityCommand, GetAccountCommand } from "@aws-sdk/client-sesv2";
import { SesIdentityChecker } from "../../src/email/ses-identity-checker.js";

// Build a mocked SESv2Client whose `send` returns the right response shape per
// command type: GetEmailIdentityCommand -> identity attributes,
// GetAccountCommand -> account-level sending flag.
function makeClient(opts: {
  verifiedForSendingStatus?: boolean;
  dkimStatus?: string;
  sendingEnabled?: boolean;
}): SESv2Client {
  const send = vi.fn((command: unknown) => {
    if (command instanceof GetEmailIdentityCommand) {
      return Promise.resolve({
        VerifiedForSendingStatus: opts.verifiedForSendingStatus,
        DkimAttributes: { Status: opts.dkimStatus },
      });
    }
    if (command instanceof GetAccountCommand) {
      return Promise.resolve({ SendingEnabled: opts.sendingEnabled });
    }
    throw new Error("unexpected command");
  });
  return { send } as unknown as SESv2Client;
}

describe("SesIdentityChecker", () => {
  it("reports all-good when identity is verified, DKIM SUCCESS, and account sending enabled", async () => {
    const client = makeClient({ verifiedForSendingStatus: true, dkimStatus: "SUCCESS", sendingEnabled: true });
    const result = await new SesIdentityChecker(client).canSendFrom("platform.email.rhosys.cloud");

    expect(result.verified).toBe(true);
    expect(result.dkimEnabled).toBe(true);
    expect(result.accountSendingEnabled).toBe(true);
    expect(result.detail).toBeUndefined();
  });

  it("reports unverified when VerifiedForSendingStatus is not true", async () => {
    const client = makeClient({ verifiedForSendingStatus: false, dkimStatus: "SUCCESS", sendingEnabled: true });
    const result = await new SesIdentityChecker(client).canSendFrom("platform.email.rhosys.cloud");

    expect(result.verified).toBe(false);
    expect(result.dkimEnabled).toBe(true);
    expect(result.accountSendingEnabled).toBe(true);
    expect(result.detail).toBeTruthy();
    expect(result.detail).toContain("verified");
  });

  it("reports DKIM disabled when the DKIM status is not SUCCESS", async () => {
    const client = makeClient({ verifiedForSendingStatus: true, dkimStatus: "PENDING", sendingEnabled: true });
    const result = await new SesIdentityChecker(client).canSendFrom("platform.email.rhosys.cloud");

    expect(result.verified).toBe(true);
    expect(result.dkimEnabled).toBe(false);
    expect(result.accountSendingEnabled).toBe(true);
    expect(result.detail).toBeTruthy();
    expect(result.detail).toContain("PENDING");
  });

  it("reports account sending disabled when SendingEnabled is not true", async () => {
    const client = makeClient({ verifiedForSendingStatus: true, dkimStatus: "SUCCESS", sendingEnabled: false });
    const result = await new SesIdentityChecker(client).canSendFrom("platform.email.rhosys.cloud");

    expect(result.verified).toBe(true);
    expect(result.dkimEnabled).toBe(true);
    expect(result.accountSendingEnabled).toBe(false);
    expect(result.detail).toBeTruthy();
    expect(result.detail).toContain("account");
  });
});

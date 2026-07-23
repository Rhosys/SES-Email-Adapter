import { SESv2Client, GetEmailIdentityCommand, GetAccountCommand } from "@aws-sdk/client-sesv2";

export class SesIdentityChecker {
  constructor(private readonly sesv2: SESv2Client) {}

  async canSendFrom(domain: string): Promise<{ verified: boolean; dkimEnabled: boolean; accountSendingEnabled: boolean; detail?: string }> {
    const identity = await this.sesv2.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
    const account = await this.sesv2.send(new GetAccountCommand({}));

    const verified = identity.VerifiedForSendingStatus === true;
    const dkimEnabled = identity.DkimAttributes?.Status === "SUCCESS";
    const accountSendingEnabled = account.SendingEnabled === true;

    const problems: string[] = [];
    if (!verified) {
      problems.push(`identity "${domain}" is not verified for sending in SES`);
    }
    if (!dkimEnabled) {
      const status = typeof identity.DkimAttributes?.Status === "string" ? identity.DkimAttributes.Status : "unknown";
      problems.push(`DKIM signing status for "${domain}" is "${status}" — expected "SUCCESS"`);
    }
    if (!accountSendingEnabled) {
      problems.push("account-level sending is disabled in SES");
    }

    if (problems.length > 0) {
      return { verified, dkimEnabled, accountSendingEnabled, detail: problems.join("; ") };
    }
    return { verified, dkimEnabled, accountSendingEnabled };
  }
}

import { SESv2Client, GetEmailIdentityCommand } from "@aws-sdk/client-sesv2";

export class SesIdentityChecker {
  constructor(private readonly sesv2: SESv2Client) {}

  async canSendFrom(domain: string): Promise<{ verified: boolean; sendingEnabled: boolean; detail?: string }> {
    const result = await this.sesv2.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));

    const verified = result.VerifiedForSendingStatus === true;
    const sendingEnabled = result.DkimAttributes?.Status === "SUCCESS";

    if (!verified && !sendingEnabled) {
      return { verified, sendingEnabled, detail: `Domain "${domain}" is not verified and DKIM status is "${result.DkimAttributes?.Status ?? "unknown"}".` };
    }
    if (!verified) {
      return { verified, sendingEnabled, detail: `Domain "${domain}" is not verified for sending in SES.` };
    }
    if (!sendingEnabled) {
      return { verified, sendingEnabled, detail: `DKIM status for "${domain}" is "${result.DkimAttributes?.Status ?? "unknown"}" — expected SUCCESS.` };
    }
    return { verified, sendingEnabled };
  }
}

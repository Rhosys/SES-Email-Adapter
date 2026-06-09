// ---------------------------------------------------------------------------
// SES domain identity registration — called when a user adds a domain.
// Registers the domain with BYODKIM so SES will accept inbound mail and
// sign outbound mail with our shared DKIM key.
// Creates an SES Tenant per customer domain for reputation isolation.
// ---------------------------------------------------------------------------

import {
  SESv2Client,
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  CreateTenantCommand,
  CreateTenantResourceAssociationCommand,
} from "@aws-sdk/client-sesv2";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";

export interface DomainIdentityService {
  register(domain: string, accountId: string): Promise<Result<void, DbError>>;
  deregister(domain: string): Promise<Result<void, DbError>>;
}

export class SesDomainIdentityService implements DomainIdentityService {
  constructor(
    private readonly sesv2: SESv2Client,
    private readonly dkimSelector: string,
    private readonly dkimPrivateKey: string,
    private readonly mailDomain: string,
    private readonly configurationSetArn: string,
  ) {}

  async register(domain: string, accountId: string): Promise<Result<void, DbError>> {
    try {
      // Derive region, AWS account ID, and config set name from the ARN
      // Format: arn:aws:ses:{region}:{accountId}:configuration-set/{name}
      const arnParts = this.configurationSetArn.split(":");
      const region = arnParts[3];
      const awsAccountId = arnParts[4];
      const configSetName = this.configurationSetArn.split("/").pop()!;

      await this.sesv2.send(new CreateEmailIdentityCommand({
        EmailIdentity: domain,
        ConfigurationSetName: configSetName,
        Tags: [{ Key: "AccountId", Value: accountId }],
        DkimSigningAttributes: {
          DomainSigningSelector: this.dkimSelector,
          DomainSigningPrivateKey: this.dkimPrivateKey,
          NextSigningKeyLength: "RSA_2048_BIT",
        },
      }));

      // Set custom MAIL FROM so SPF alignment works via the bounce CNAME
      await this.sesv2.send(new PutEmailIdentityMailFromAttributesCommand({
        EmailIdentity: domain,
        MailFromDomain: `bounce.${domain}`,
      }));

      // Create SES tenant for reputation isolation (one per account, name = accountId)
      await this.createTenantIfNotExists(accountId);

      // Associate the identity and configuration set with the tenant
      const identityArn = `arn:aws:ses:${region}:${awsAccountId}:identity/${domain}`;
      await this.associateResource(accountId, identityArn);
      await this.associateResource(accountId, this.configurationSetArn);

      return ok(undefined);
    } catch (e: unknown) {
      // AlreadyExistsException means domain was previously registered — not an error
      if (e instanceof Error && e.name === "AlreadyExistsException") {
        return ok(undefined);
      }
      return err(dbError(e));
    }
  }

  async deregister(domain: string): Promise<Result<void, DbError>> {
    try {
      await this.sesv2.send(new DeleteEmailIdentityCommand({
        EmailIdentity: domain,
      }));

      // Note: we do NOT delete the tenant here. The tenant is per-account and
      // may still have other domain identities associated. SES automatically
      // cleans up the resource association when the identity is deleted.

      return ok(undefined);
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "NotFoundException") {
        return ok(undefined);
      }
      return err(dbError(e));
    }
  }

  private async createTenantIfNotExists(tenantName: string): Promise<void> {
    try {
      await this.sesv2.send(new CreateTenantCommand({
        TenantName: tenantName,
        Tags: [{ Key: "AccountId", Value: tenantName }],
      }));
    } catch (e: unknown) {
      // Tenant already exists — fine
      if (e instanceof Error && e.name === "AlreadyExistsException") return;
      throw e;
    }
  }

  private async associateResource(tenantName: string, resourceArn: string): Promise<void> {
    try {
      await this.sesv2.send(new CreateTenantResourceAssociationCommand({
        TenantName: tenantName,
        ResourceArn: resourceArn,
      }));
    } catch (e: unknown) {
      // Already associated — fine
      if (e instanceof Error && e.name === "AlreadyExistsException") return;
      throw e;
    }
  }
}

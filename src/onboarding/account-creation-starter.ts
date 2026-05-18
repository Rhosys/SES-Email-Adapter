import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type { Logger } from "../logger.js";

export interface AccountCreationStarter {
  start(accountId: string, email: string): Promise<void>;
}

export class SfnAccountCreationStarter implements AccountCreationStarter {
  constructor(
    private readonly sfn: SFNClient,
    private readonly stateMachineArn: string,
    private readonly logger: Logger,
  ) {}

  async start(accountId: string, email: string): Promise<void> {
    try {
      await this.sfn.send(new StartExecutionCommand({
        stateMachineArn: this.stateMachineArn,
        name: accountId,
        input: JSON.stringify({ accountId, email, callerInvocationId: this.logger.getInvocationId() }),
      }));
    } catch (e: unknown) {
      if ((e as { name?: string }).name === "ExecutionAlreadyExists") {
        return;
      }
      this.logger.error("Failed to start account creation Step Function — account is persisted, workflow will not run", {
        code: "account_creation_starter.start_failed",
        accountId,
        error: e,
      });
    }
  }
}

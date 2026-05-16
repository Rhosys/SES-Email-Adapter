import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { SfnAccountCreationStarter } from "./account-creation-starter.js";
import { createMockLogger } from "../testing/mock-logger.js";

const sfnMock = mockClient(SFNClient);

const STATE_MACHINE_ARN = "arn:aws:states:eu-central-1:REDACTED:stateMachine:email-catcher-AccountCreation";

describe("SfnAccountCreationStarter", () => {
  let starter: SfnAccountCreationStarter;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    sfnMock.reset();
    logger = createMockLogger();
    starter = new SfnAccountCreationStarter(new SFNClient({}), STATE_MACHINE_ARN, logger);
  });

  afterEach(() => {
    sfnMock.restore();
  });

  it("calls StartExecutionCommand with accountId as name and JSON input", async () => {
    sfnMock.on(StartExecutionCommand).resolves({});

    await starter.start("acc-123", "user@example.com");

    const calls = sfnMock.commandCalls(StartExecutionCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toEqual({
      stateMachineArn: STATE_MACHINE_ARN,
      name: "acc-123",
      input: JSON.stringify({ accountId: "acc-123", email: "user@example.com" }),
    });
  });

  it("treats ExecutionAlreadyExists as success (idempotent)", async () => {
    const error = Object.assign(new Error("Execution already exists"), { name: "ExecutionAlreadyExists" });
    sfnMock.on(StartExecutionCommand).rejects(error);

    await starter.start("acc-456", "dup@example.com");

    expect(logger.calls).toHaveLength(0);
  });

  it("logs and swallows other SFN errors (fire-and-forget)", async () => {
    const error = Object.assign(new Error("Service unavailable"), { name: "ServiceUnavailableException" });
    sfnMock.on(StartExecutionCommand).rejects(error);

    await starter.start("acc-789", "fail@example.com");

    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]!.method).toBe("error");
    expect(logger.calls[0]!.context).toMatchObject({
      code: "account_creation_starter.start_failed",
      accountId: "acc-789",
    });
  });
});

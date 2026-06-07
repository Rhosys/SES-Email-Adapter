import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SchedulerClient as AwsSchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-scheduler";
import { EventBridgeSchedulerClient } from "../../src/scheduler/scheduler-client.js";
import { createMockLogger } from "../helpers/mock-logger.js";

const schedulerMock = mockClient(AwsSchedulerClient);

const GROUP_NAME = "signal-followups";
const ROLE_ARN = "arn:aws:iam::123456789012:role/scheduler-sqs";
const QUEUE_ARN = "arn:aws:sqs:eu-central-1:123456789012:signals";

describe("EventBridgeSchedulerClient", () => {
  let client: EventBridgeSchedulerClient;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    schedulerMock.reset();
    logger = createMockLogger();
    client = new EventBridgeSchedulerClient({
      client: new AwsSchedulerClient({}),
      groupName: GROUP_NAME,
      roleArn: ROLE_ARN,
      queueArn: QUEUE_ARN,
      logger,
    });
  });

  afterEach(() => {
    schedulerMock.restore();
  });

  describe("createFollowup", () => {
    it("sends CreateScheduleCommand with correct params", async () => {
      schedulerMock.on(CreateScheduleCommand).resolves({});

      const result = await client.createFollowup({
        accountId: "acc-123",
        signalId: "sgn-456",
        arcId: "arc-789",
        fireAt: "2025-08-01T10:00:00Z",
        suffix: "followup",
      });

      expect(result.isOk()).toBe(true);

      const calls = schedulerMock.commandCalls(CreateScheduleCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input).toMatchObject({
        GroupName: GROUP_NAME,
        ActionAfterCompletion: "DELETE",
        FlexibleTimeWindow: { Mode: "OFF" },
        Target: {
          Arn: QUEUE_ARN,
          RoleArn: ROLE_ARN,
        },
      });
    });

    it("target input contains accountId, signalId, arcId as JSON", async () => {
      schedulerMock.on(CreateScheduleCommand).resolves({});

      await client.createFollowup({
        accountId: "acc-123",
        signalId: "sgn-456",
        arcId: "arc-789",
        fireAt: "2025-08-01T10:00:00Z",
        suffix: "followup",
      });

      const calls = schedulerMock.commandCalls(CreateScheduleCommand);
      const targetInput = JSON.parse(calls[0]!.args[0].input.Target!.Input!);
      expect(targetInput).toEqual({
        sqsMessageAttributeMessageType: "signal_followup",
        accountId: "acc-123",
        signalId: "sgn-456",
        arcId: "arc-789",
      });
    });

    it("schedule expression uses at() format without trailing Z or fractional seconds", async () => {
      schedulerMock.on(CreateScheduleCommand).resolves({});

      await client.createFollowup({
        accountId: "acc-1",
        signalId: "sgn-2",
        arcId: "arc-3",
        fireAt: "2025-12-25T08:00:00.000Z",
        suffix: "cal",
      });

      const calls = schedulerMock.commandCalls(CreateScheduleCommand);
      expect(calls[0]!.args[0].input.ScheduleExpression).toBe("at(2025-12-25T08:00:00)");
    });

    it("logs WARN on every createFollowup call", async () => {
      schedulerMock.on(CreateScheduleCommand).resolves({});

      await client.createFollowup({
        accountId: "acc-a",
        signalId: "sgn-b",
        arcId: "arc-c",
        fireAt: "2025-09-01T12:00:00Z",
        suffix: "test",
      });

      const warnCalls = logger.calls.filter((c) => c.method === "warn");
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0]!.context).toMatchObject({ code: "scheduler.create" });
    });

    it("returns err on SDK failure", async () => {
      schedulerMock.on(CreateScheduleCommand).rejects(new Error("Throttled"));

      const result = await client.createFollowup({
        accountId: "acc-x",
        signalId: "sgn-y",
        arcId: "arc-z",
        fireAt: "2025-09-01T12:00:00Z",
        suffix: "fail",
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
    });
  });

  describe("deleteFollowup", () => {
    it("sends DeleteScheduleCommand with name and group", async () => {
      schedulerMock.on(DeleteScheduleCommand).resolves({});

      const result = await client.deleteFollowup("acc-123.sgn-456.followup");

      expect(result.isOk()).toBe(true);
      const calls = schedulerMock.commandCalls(DeleteScheduleCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input).toMatchObject({
        Name: "acc-123.sgn-456.followup",
        GroupName: GROUP_NAME,
      });
    });

    it("returns ok() on ResourceNotFoundException", async () => {
      const error = new ResourceNotFoundException({ message: "Schedule not found", Message: "Schedule not found", $metadata: {} });
      schedulerMock.on(DeleteScheduleCommand).rejects(error);

      const result = await client.deleteFollowup("acc-123.sgn-456.gone");

      expect(result.isOk()).toBe(true);
    });

    it("logs TRACK on ResourceNotFoundException", async () => {
      const error = new ResourceNotFoundException({ message: "Schedule not found", Message: "Schedule not found", $metadata: {} });
      schedulerMock.on(DeleteScheduleCommand).rejects(error);

      await client.deleteFollowup("acc-123.sgn-456.gone");

      const trackCalls = logger.calls.filter((c) => c.method === "track");
      expect(trackCalls).toHaveLength(1);
      expect(trackCalls[0]!.context).toMatchObject({ code: "scheduler.delete.not_found" });
    });

    it("logs WARN on every deleteFollowup call", async () => {
      schedulerMock.on(DeleteScheduleCommand).resolves({});

      await client.deleteFollowup("acc-123.sgn-456.followup");

      const warnCalls = logger.calls.filter((c) => c.method === "warn");
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0]!.context).toMatchObject({ code: "scheduler.delete" });
    });

    it("returns err on non-ResourceNotFoundException failures", async () => {
      schedulerMock.on(DeleteScheduleCommand).rejects(new Error("Access denied"));

      const result = await client.deleteFollowup("acc-123.sgn-456.denied");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().kind).toBe("db_error");
    });
  });

  describe("getSchedule", () => {
    it("returns schedule data on success", async () => {
      schedulerMock.on(GetScheduleCommand).resolves({
        Name: "acc-123.sgn-456.followup",
        ScheduleExpression: "at(2025-08-01T10:00:00)",
      });

      const result = await client.getSchedule("acc-123.sgn-456.followup");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({
        name: "acc-123.sgn-456.followup",
        scheduleExpression: "at(2025-08-01T10:00:00)",
      });
    });

    it("returns null on ResourceNotFoundException", async () => {
      const error = new ResourceNotFoundException({ message: "Not found", Message: "Not found", $metadata: {} });
      schedulerMock.on(GetScheduleCommand).rejects(error);

      const result = await client.getSchedule("acc-123.sgn-456.gone");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });
  });
});

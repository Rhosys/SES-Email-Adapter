import {
  SchedulerClient as AwsSchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-scheduler";
import { ok, err, dbError } from "../errors.js";
import type { DbError, Result } from "../errors.js";
import type { Logger } from "../logger.js";
import { buildScheduleName } from "./schedule-name.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface FollowupScheduleParams {
  accountId: string;
  signalId: string;
  arcId: string;
  fireAt: string;   // ISO 8601
  suffix: string;   // schedule name suffix
  sqsMessageAttributeMessageType: string; // body-level routing discriminator (e.g. "signal_followup", "rsvp_reminder")
}

export interface SchedulerClient {
  createFollowup(params: FollowupScheduleParams): Promise<Result<void, DbError>>;
  deleteFollowup(scheduleName: string): Promise<Result<void, DbError>>;
  getSchedule(scheduleName: string): Promise<Result<{ name: string; scheduleExpression: string } | null, DbError>>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class EventBridgeSchedulerClient implements SchedulerClient {
  private readonly client: AwsSchedulerClient;
  private readonly groupName: string;
  private readonly roleArn: string;
  private readonly queueArn: string;
  private readonly logger: Logger;

  constructor(deps: { client: AwsSchedulerClient; groupName: string; roleArn: string; queueArn: string; logger: Logger }) {
    this.client = deps.client;
    this.groupName = deps.groupName;
    this.roleArn = deps.roleArn;
    this.queueArn = deps.queueArn;
    this.logger = deps.logger;
  }

  async createFollowup(params: FollowupScheduleParams): Promise<Result<void, DbError>> {
    const scheduleName = buildScheduleName(params.accountId, params.signalId, params.suffix);
    const fireAt = params.fireAt.replace(/Z$/, "").replace(/\.\d+$/, "");
    const scheduleExpression = `at(${fireAt})`;

    this.logger.warn("CreateSchedule — expensive API call", {
      code: "scheduler.create",
      scheduleName,
      accountId: params.accountId,
      arcId: params.arcId,
      fireAt: params.fireAt,
    });

    try {
      await this.client.send(new CreateScheduleCommand({
        Name: scheduleName,
        GroupName: this.groupName,
        ScheduleExpression: scheduleExpression,
        ScheduleExpressionTimezone: "UTC",
        ActionAfterCompletion: "DELETE",
        FlexibleTimeWindow: { Mode: "OFF" },
        Target: {
          Arn: this.queueArn,
          RoleArn: this.roleArn,
          Input: JSON.stringify({
            sqsMessageAttributeMessageType: params.sqsMessageAttributeMessageType,
            accountId: params.accountId,
            signalId: params.signalId,
            arcId: params.arcId,
          }),
        },
      }));
      return ok(undefined);
    } catch (e) {
      return err(dbError(e));
    }
  }

  async deleteFollowup(scheduleName: string): Promise<Result<void, DbError>> {
    this.logger.warn("DeleteSchedule — expensive API call", {
      code: "scheduler.delete",
      scheduleName,
    });

    try {
      await this.client.send(new DeleteScheduleCommand({
        Name: scheduleName,
        GroupName: this.groupName,
      }));
      return ok(undefined);
    } catch (e) {
      if (e instanceof ResourceNotFoundException) {
        this.logger.track("Schedule not found (already fired or never existed)", {
          code: "scheduler.delete.not_found",
          scheduleName,
        });
        return ok(undefined);
      }
      return err(dbError(e));
    }
  }

  async getSchedule(scheduleName: string): Promise<Result<{ name: string; scheduleExpression: string } | null, DbError>> {
    try {
      const response = await this.client.send(new GetScheduleCommand({
        Name: scheduleName,
        GroupName: this.groupName,
      }));
      return ok({
        name: response.Name!,
        scheduleExpression: response.ScheduleExpression!,
      });
    } catch (e) {
      if (e instanceof ResourceNotFoundException) {
        return ok(null);
      }
      return err(dbError(e));
    }
  }
}

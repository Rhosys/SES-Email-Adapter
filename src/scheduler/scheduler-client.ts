import {
  SchedulerClient as AwsSchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ConflictException,
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
  threadId: string;
  /** The ID used in the schedule name — threadId for snooze (one per thread), signalId for calendar (one per event). */
  scheduleKeyId: string;
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
    const scheduleName = buildScheduleName(params.accountId, params.scheduleKeyId, params.suffix);
    const fireAt = params.fireAt.replace(/Z$/, "").replace(/\.\d+$/, "");
    const scheduleExpression = `at(${fireAt})`;

    this.logger.warn("CreateSchedule — expensive API call", {
      code: "scheduler.create",
      scheduleName,
      accountId: params.accountId,
      threadId: params.threadId,
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
            threadId: params.threadId,
          }),
        },
      }));
      this.logger.info("Schedule created", { code: "scheduler.created", scheduleName });
      return ok(undefined);
    } catch (e) {
      if (e instanceof ConflictException) {
        // Schedule already exists (re-snooze) — update it with new fire time
        try {
          await this.client.send(new UpdateScheduleCommand({
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
                threadId: params.threadId,
              }),
            },
          }));
          this.logger.info("Schedule updated (re-snooze)", { code: "scheduler.updated", scheduleName });
          return ok(undefined);
        } catch (updateErr) {
          this.logger.warn("Schedule update failed", { code: "scheduler.update_failed", scheduleName, error: updateErr });
          return err(dbError(updateErr));
        }
      }
      this.logger.warn("Schedule creation failed", { code: "scheduler.create_failed", scheduleName, error: e });
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
      this.logger.info("Schedule deleted", { code: "scheduler.deleted", scheduleName });
      return ok(undefined);
    } catch (e) {
      if (e instanceof ResourceNotFoundException) {
        this.logger.warn("Schedule not found (already fired or never existed)", {
          code: "scheduler.delete.not_found",
          scheduleName,
        });
        return ok(undefined);
      }
      this.logger.track("DeleteSchedule failed", {
        code: "scheduler.delete.failed",
        scheduleName,
        error: e,
      });
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

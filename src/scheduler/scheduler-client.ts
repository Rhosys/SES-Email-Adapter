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
import type { FollowupMessage } from "./followup-handler.js";
import type { RsvpReminderMessage } from "./rsvp-reminder.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface FollowupScheduleParams {
  accountId: string;
  threadId: string;
  /** ID used in the schedule name — the threadId, so there is one followup schedule per thread. */
  scheduleKeyId: string;
  fireAt: string;   // ISO 8601
  suffix: string;   // schedule name suffix
}

export interface RsvpReminderScheduleParams {
  accountId: string;
  threadId: string;
  /** The calendar_event signal this reminder is for — one veventUid per signal. Also the schedule-name key. */
  calendarSignalId: string;
  fireAt: string;   // ISO 8601
  suffix: string;   // schedule name suffix
}

export interface SchedulerClient {
  createFollowupSchedule(params: FollowupScheduleParams): Promise<Result<void, DbError>>;
  createRsvpReminderSchedule(params: RsvpReminderScheduleParams): Promise<Result<void, DbError>>;
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

  async createFollowupSchedule(params: FollowupScheduleParams): Promise<Result<void, DbError>> {
    const payload: FollowupMessage = {
      sqsMessageAttributeMessageType: "signal_followup",
      accountId: params.accountId,
      threadId: params.threadId,
    };
    return this.createSchedule(params.accountId, params.scheduleKeyId, params.suffix, params.fireAt, payload);
  }

  async createRsvpReminderSchedule(params: RsvpReminderScheduleParams): Promise<Result<void, DbError>> {
    const payload: RsvpReminderMessage = {
      sqsMessageAttributeMessageType: "rsvp_reminder",
      accountId: params.accountId,
      threadId: params.threadId,
      calendarSignalId: params.calendarSignalId,
    };
    return this.createSchedule(params.accountId, params.calendarSignalId, params.suffix, params.fireAt, payload);
  }

  // Shared EventBridge Scheduler mechanics: build the one-shot schedule, and on a
  // ConflictException (the schedule already exists — a re-snooze) update it in place.
  private async createSchedule(
    accountId: string,
    scheduleKeyId: string,
    suffix: string,
    fireAtIso: string,
    payload: FollowupMessage | RsvpReminderMessage,
  ): Promise<Result<void, DbError>> {
    const scheduleName = buildScheduleName(accountId, scheduleKeyId, suffix);
    const fireAt = fireAtIso.replace(/Z$/, "").replace(/\.\d+$/, "");
    const scheduleExpression = `at(${fireAt})`;
    const input = JSON.stringify(payload);

    this.logger.warn("CreateSchedule — expensive API call", {
      code: "scheduler.create",
      scheduleName,
      accountId,
      threadId: payload.threadId,
      fireAt: fireAtIso,
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
          Input: input,
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
              Input: input,
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

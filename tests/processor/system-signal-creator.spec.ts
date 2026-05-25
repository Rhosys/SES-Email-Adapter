import { describe, it, expect, vi, beforeEach } from "vitest";
import { DynamoSystemSignalCreator } from "../../src/processor/system-signal-creator.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";
import { ok, err } from "../../src/errors.js";
import type { Signal, InvalidRuleFunctionData, InvalidTemplateFunctionData, AutoSendBlockedData } from "../../src/types/index.js";

describe("DynamoSystemSignalCreator", () => {
  let logger: MockLogger;
  let creator: DynamoSystemSignalCreator;
  let mockSaveSignal: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logger = createMockLogger();
    mockSaveSignal = vi.fn().mockResolvedValue(ok(undefined));
    creator = new DynamoSystemSignalCreator(logger, { saveSignal: mockSaveSignal });
  });

  describe("createInvalidRuleFunctionSignal", () => {
    it("saves a signal with type invalid_rule_function attached to the arc", async () => {
      await creator.createInvalidRuleFunctionSignal({
        accountId: "acc_123",
        arcId: "arc_456",
        recipientAddress: "inbox@example.com",
        resourceName: "My Rule",
        issue: "Invalid action type: unknown_action",
      });

      expect(mockSaveSignal).toHaveBeenCalledTimes(1);
      const signal = mockSaveSignal.mock.calls[0]![0] as Signal<InvalidRuleFunctionData>;

      expect(signal.accountId).toBe("acc_123");
      expect(signal.arcId).toBe("arc_456");
      expect(signal.data.resourceName).toBe("My Rule");
      expect(signal.data.issue).toBe("Invalid action type: unknown_action");
      expect(signal.type).toBe("invalid_rule_function");
      expect(signal.source).toBe("email");
      expect(signal.status).toBe("active");
      expect(signal.id).toMatch(/^sgn-/);
      expect(signal.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("logs warning and does not throw when save fails", async () => {
      mockSaveSignal.mockResolvedValueOnce(err({ type: "db_error", message: "throttled" }));

      await expect(
        creator.createInvalidRuleFunctionSignal({
          accountId: "acc_789",
          arcId: "arc_001",
          recipientAddress: "test@example.com",
          resourceName: "Failing Rule",
          issue: "Some issue",
        }),
      ).resolves.toBeUndefined();

      const warnCall = logger.calls.find(
        (c) => c.method === "warn" && c.context?.code === "system_signal.write_failed",
      );
      expect(warnCall).toBeDefined();
      expect(warnCall!.context!.accountId).toBe("acc_789");
    });
  });

  describe("createInvalidTemplateFunctionSignal", () => {
    it("saves a signal with type invalid_template_function and function name in subject", async () => {
      await creator.createInvalidTemplateFunctionSignal({
        accountId: "acc_456",
        arcId: "arc_789",
        recipientAddress: "inbox@example.com",
        resourceName: "Welcome Template",
        functionName: "greeting",
        issue: "Function returned non-string value",
      });

      expect(mockSaveSignal).toHaveBeenCalledTimes(1);
      const signal = mockSaveSignal.mock.calls[0]![0] as Signal<InvalidTemplateFunctionData>;

      expect(signal.accountId).toBe("acc_456");
      expect(signal.arcId).toBe("arc_789");
      expect(signal.type).toBe("invalid_template_function");
      expect(signal.data.resourceName).toBe("Welcome Template");
      expect(signal.data.functionName).toBe("greeting");
      expect(signal.data.issue).toBe("Function returned non-string value");
    });
  });

  describe("createAutoSendBlockedSignal", () => {
    it("saves a signal with type auto_send_blocked", async () => {
      await creator.createAutoSendBlockedSignal({
        accountId: "acc_111",
        arcId: "arc_222",
        recipientAddress: "inbox@example.com",
        fromAddress: "sender@legit.com",
        replyToAddress: "phish@evil.com",
      });

      expect(mockSaveSignal).toHaveBeenCalledTimes(1);
      const signal = mockSaveSignal.mock.calls[0]![0] as Signal<AutoSendBlockedData>;

      expect(signal.accountId).toBe("acc_111");
      expect(signal.arcId).toBe("arc_222");
      expect(signal.type).toBe("auto_send_blocked");
      expect(signal.data.fromAddress).toBe("sender@legit.com");
      expect(signal.data.replyToAddress).toBe("phish@evil.com");
      expect(signal.data.recipientAddress).toBe("inbox@example.com");
    });
  });
});

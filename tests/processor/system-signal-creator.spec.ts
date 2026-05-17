import { describe, it, expect, vi, beforeEach } from "vitest";
import { DynamoSystemSignalCreator } from "../../src/processor/system-signal-creator.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

// Mock DynamoDB
vi.mock("@aws-sdk/lib-dynamodb", () => {
  const mockSend = vi.fn().mockResolvedValue({});
  return {
    DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
    PutCommand: vi.fn().mockImplementation((input) => ({ input })),
    GetCommand: vi.fn(),
    QueryCommand: vi.fn(),
    UpdateCommand: vi.fn(),
    DeleteCommand: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({})),
}));

// Access the mocked send function
async function getMockSend() {
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  const client = DynamoDBDocumentClient.from({} as never);
  return client.send as ReturnType<typeof vi.fn>;
}

describe("DynamoSystemSignalCreator", () => {
  let logger: MockLogger;
  let creator: DynamoSystemSignalCreator;
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    logger = createMockLogger();
    creator = new DynamoSystemSignalCreator(logger);
    mockSend = await getMockSend();
    mockSend.mockClear();
  });

  describe("createInvalidOutputSignal", () => {
    it.each([
      {
        label: "rule without functionName — writes notification with rule description",
        opts: {
          accountId: "acc_123",
          resourceType: "rule" as const,
          resourceName: "My Rule",
          issue: "Invalid action type: unknown_action",
        },
        expectedDescription: 'rule "My Rule": Invalid action type: unknown_action',
        expectFunctionName: false,
      },
      {
        label: "template with functionName — writes notification with function in description",
        opts: {
          accountId: "acc_456",
          resourceType: "template" as const,
          resourceName: "Welcome Template",
          functionName: "greeting",
          issue: "Function returned non-string value",
        },
        expectedDescription: 'template "Welcome Template" function "greeting": Function returned non-string value',
        expectFunctionName: true,
      },
    ])("$label", async ({ opts, expectedDescription, expectFunctionName }) => {
      await creator.createInvalidOutputSignal(opts);

      expect(mockSend).toHaveBeenCalledTimes(1);
      const putCommand = mockSend.mock.calls[0]![0];
      const item = putCommand.input.Item;

      expect(item.pk).toBe(`ACCT#${opts.accountId}`);
      expect(item.sk).toMatch(/^SYSSIG#\d{4}-\d{2}-\d{2}T/);
      expect(item.accountId).toBe(opts.accountId);
      expect(item.type).toBe("invalid_output");
      expect(item.resourceType).toBe(opts.resourceType);
      expect(item.resourceName).toBe(opts.resourceName);
      expect(item.issue).toBe(opts.issue);
      expect(item.description).toBe(expectedDescription);
      expect(item.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));

      if (expectFunctionName) {
        expect(item.functionName).toBe(opts.functionName);
      } else {
        expect(item.functionName).toBeUndefined();
      }
    });

    it("logs warning and does not throw when DynamoDB write fails", async () => {
      mockSend.mockRejectedValueOnce(new Error("DynamoDB throttled"));

      await expect(
        creator.createInvalidOutputSignal({
          accountId: "acc_789",
          resourceType: "rule",
          resourceName: "Failing Rule",
          issue: "Some issue",
        }),
      ).resolves.toBeUndefined();

      const warnCall = logger.calls.find(
        (c) => c.method === "warn" && c.context?.code === "system_signal.write_failed",
      );
      expect(warnCall).toBeDefined();
      expect(warnCall!.context!.accountId).toBe("acc_789");
      expect(warnCall!.context!.resourceName).toBe("Failing Rule");
    });
  });
});

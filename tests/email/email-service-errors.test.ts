import { describe, it, expect, vi, beforeEach } from "vitest";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { EmailService } from "../../src/email/email-service.js";
import { createMockLogger, type MockLogger } from "../helpers/mock-logger.js";

vi.mock("@aws-sdk/client-sesv2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-sesv2")>();
  return {
    ...actual,
    SESv2Client: vi.fn().mockImplementation(() => ({
      send: vi.fn(),
    })),
  };
});

describe("EmailService error classifications — REQ-0.6", () => {
  let mockSend: ReturnType<typeof vi.fn>;
  let sesClient: SESv2Client;
  let service: EmailService;
  let logger: MockLogger;

  beforeEach(() => {
    mockSend = vi.fn();
    sesClient = { send: mockSend } as unknown as SESv2Client;
    logger = createMockLogger();
    service = new EmailService(sesClient, { from: "noreply@example.com", configSetName: "my-config-set", platformTenantName: "test-platform", mailDomain: "example.com" }, logger);
  });

  it("ConfigurationSetSendingPausedException classified as permanent — returns err with permanent_ses_error", async () => {
    const sesError = Object.assign(new Error("Configuration set sending is paused"), {
      name: "ConfigurationSetSendingPausedException",
      $metadata: { httpStatusCode: 400 },
    });
    mockSend.mockRejectedValueOnce(sesError);

    const opts = { to: ["u@e.com"], subject: "S", textBody: "B", accountId: "test-platform" };
    const result = await service.send(opts);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(expect.objectContaining({ kind: "permanent_ses_error", errorName: "ConfigurationSetSendingPausedException", httpStatus: 400 }));

    const errorCalls = logger.calls.filter(c => c.method === "error");
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]!.context).toEqual(expect.objectContaining({ errorName: "ConfigurationSetSendingPausedException", httpStatus: 400, opts }));
  });

  it("rejects empty accountId before calling SES", async () => {
    const opts = { to: ["u@e.com"], subject: "S", textBody: "B", accountId: "" };
    const result = await service.send(opts);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ kind: "invalid_argument", argument: "accountId", message: expect.stringContaining("must not be empty") });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only accountId before calling SES", async () => {
    const opts = { to: ["u@e.com"], subject: "S", textBody: "B", accountId: "   " };
    const result = await service.send(opts);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({ kind: "invalid_argument", argument: "accountId", message: expect.stringContaining("must not be empty") });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("ConfigurationSetDoesNotExistException classified as permanent — returns err with permanent_ses_error", async () => {
    const sesError = Object.assign(new Error("Configuration set does not exist"), {
      name: "ConfigurationSetDoesNotExistException",
      $metadata: { httpStatusCode: 400 },
    });
    mockSend.mockRejectedValueOnce(sesError);

    const opts = { to: ["u@e.com"], subject: "S", textBody: "B", accountId: "test-platform" };
    const result = await service.send(opts);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(expect.objectContaining({ kind: "permanent_ses_error", errorName: "ConfigurationSetDoesNotExistException", httpStatus: 400 }));

    const errorCalls = logger.calls.filter(c => c.method === "error");
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]!.context).toEqual(expect.objectContaining({ errorName: "ConfigurationSetDoesNotExistException", httpStatus: 400, opts }));
  });
});

describe("EmailService — SES Destination shape", () => {
  let mockSend: ReturnType<typeof vi.fn>;
  let sesClient: SESv2Client;
  let service: EmailService;

  beforeEach(() => {
    mockSend = vi.fn().mockResolvedValue({ MessageId: "msg-1" });
    sesClient = { send: mockSend } as unknown as SESv2Client;
    service = new EmailService(sesClient, { from: "noreply@example.com", configSetName: "my-config-set", platformTenantName: "test-platform", mailDomain: "example.com" }, createMockLogger());
  });

  // Regression test: multiple recipients must reach SES as separate ToAddresses entries, not
  // joined into a single comma-separated string — SES parses each ToAddresses entry as exactly
  // one RFC 5322 address, so a joined string is rejected outright ("Illegal address").
  it("sends multiple To recipients as separate ToAddresses entries, not a joined string", async () => {
    const result = await service.send({
      to: ["a@example.com", "b@example.com"],
      subject: "S",
      textBody: "B",
      accountId: "test-platform",
    });

    expect(result.isOk()).toBe(true);
    const command = mockSend.mock.calls[0]![0] as { input: { Destination?: { ToAddresses?: string[] } } };
    expect(command.input.Destination?.ToAddresses).toEqual(["a@example.com", "b@example.com"]);
  });

  it("passes cc and bcc through to CcAddresses/BccAddresses", async () => {
    const result = await service.send({
      to: ["a@example.com"],
      cc: ["c@example.com"],
      bcc: ["d@example.com"],
      subject: "S",
      textBody: "B",
      accountId: "test-platform",
    });

    expect(result.isOk()).toBe(true);
    const command = mockSend.mock.calls[0]![0] as { input: { Destination?: { ToAddresses?: string[]; CcAddresses?: string[]; BccAddresses?: string[] } } };
    expect(command.input.Destination?.ToAddresses).toEqual(["a@example.com"]);
    expect(command.input.Destination?.CcAddresses).toEqual(["c@example.com"]);
    expect(command.input.Destination?.BccAddresses).toEqual(["d@example.com"]);
  });

  it("omits CcAddresses/BccAddresses entirely when there are none", async () => {
    const result = await service.send({
      to: ["a@example.com"],
      subject: "S",
      textBody: "B",
      accountId: "test-platform",
    });

    expect(result.isOk()).toBe(true);
    const command = mockSend.mock.calls[0]![0] as { input: { Destination?: { CcAddresses?: string[]; BccAddresses?: string[] } } };
    expect(command.input.Destination?.CcAddresses).toBeUndefined();
    expect(command.input.Destination?.BccAddresses).toBeUndefined();
  });
});

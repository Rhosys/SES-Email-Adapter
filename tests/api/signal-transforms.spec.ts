import { describe, it, expect } from "vitest";
import { toApiSignal } from "../../src/api/signal-transforms.js";
import type { Signal } from "../../src/types/index.js";

function makeInboundSignal(overrides: { data?: Partial<Signal["data"]> } & Partial<Omit<Signal, "data">> = {}): Signal {
  const { data: dataOverrides, ...baseOverrides } = overrides;
  return {
    id: "SES#msg-001",
    signalLookupId: "SES#msg-001",
    threadId: undefined,
    accountId: "acct-test-001",
    source: "email" as const,
    type: "email",
    status: "block_hidden",
    createdAt: "2024-01-20T12:00:00Z",
    ...baseOverrides,
    data: {
      receivedAt: "2024-01-20T12:00:00Z",
      from: { address: "sender@example.com", name: "Sender" },
      to: [{ address: "user@example.com" }],
      cc: [],
      subject: "Test email",
      attachments: [],
      headers: {},
      recipientAddress: "user@example.com",
      workflow: "conversation",
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
      tags: [],
      summary: "A test signal.",
      s3Key: "emails/msg-001",
      ...dataOverrides,
    },
  } as Signal;
}

describe("toApiSignal — matchedRules collapse", () => {
  it("collapses a repeated ruleId down to the last entry found, keeping distinct ruleIds separate", () => {
    const signal = makeInboundSignal({
      data: {
        matchedRules: [
          { ruleId: "SR-05", actions: [{ type: "quarantine_hidden" }], labelsAdded: [], statusChange: "quarantine_hidden" },
          { ruleId: "SR-00", actions: [{ type: "quarantine_visible" }], labelsAdded: [], statusChange: "quarantine_visible", text: "Sender not approved" },
          { ruleId: "SR-00", actions: [{ type: "block_hidden" }], labelsAdded: [], statusChange: "block_hidden", text: "Sender not approved — dismissed by user from quarantine" },
        ],
      },
    });

    const apiSignal = toApiSignal(signal);

    expect(apiSignal.type).toBe("email");
    const data = apiSignal.data as { matchedRules?: Array<{ ruleId: string; text?: string }> };
    expect(data.matchedRules).toEqual([
      { ruleId: "SR-05", actions: [{ type: "quarantine_hidden" }], labelsAdded: [], statusChange: "quarantine_hidden" },
      { ruleId: "SR-00", actions: [{ type: "block_hidden" }], labelsAdded: [], statusChange: "block_hidden", text: "Sender not approved — dismissed by user from quarantine" },
    ]);
  });

  it("passes through a single-entry matchedRules list unchanged", () => {
    const signal = makeInboundSignal({
      data: {
        matchedRules: [{ ruleId: "SR-02", actions: [{ type: "quarantine_visible" }], labelsAdded: [], statusChange: "quarantine_visible" }],
      },
    });

    const apiSignal = toApiSignal(signal);
    const data = apiSignal.data as { matchedRules?: Array<{ ruleId: string }> };
    expect(data.matchedRules).toEqual([{ ruleId: "SR-02", actions: [{ type: "quarantine_visible" }], labelsAdded: [], statusChange: "quarantine_visible" }]);
  });
});

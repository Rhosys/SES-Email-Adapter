import { describe, it, expect } from "vitest";
import { isReplyTargetSafe } from "../../src/processor/reply-target-validator.js";
import type { Signal } from "../../src/types/index.js";

function makeSignal(overrides: { data?: Partial<Pick<Signal["data"], "from" | "replyTo">> } & Partial<Omit<Signal, "data">> = {}): Signal {
  const { data: dataOverrides, ...baseOverrides } = overrides;
  return {
    id: "sgn-test",
    signalLookupId: "sgn-test",
    accountId: "acct-001",
    source: "email",
    type: "email",
    status: "active",
    createdAt: "2024-01-01T00:00:00Z",
    ...baseOverrides,
    data: {
      receivedAt: "2024-01-01T00:00:00Z",
      from: { address: "sender@company.com" },
      to: [{ address: "me@myalias.com" }],
      cc: [],
      subject: "Test",
      attachments: [],
      headers: {},
      recipientAddress: "me@myalias.com",
      workflow: "conversation",
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
      tags: [],
      summary: "",
      s3Key: "test/key",
      actions: [],
      ...dataOverrides,
    },
  } as Signal;
}

// ---------------------------------------------------------------------------
// isReplyTargetSafe
// ---------------------------------------------------------------------------

describe("isReplyTargetSafe", () => {
  it("returns safe when replyTo is absent", () => {
    const signal = makeSignal();
    expect(isReplyTargetSafe(signal, [])).toEqual({ safe: true });
  });

  it("returns safe when replyTo eTLD+1 matches from eTLD+1", () => {
    const signal = makeSignal({
      data: {
        from: { address: "sender@mail.company.com" },
        replyTo: { address: "support@help.company.com" },
      },
    });
    expect(isReplyTargetSafe(signal, [])).toEqual({ safe: true });
  });

  it("returns safe when replyTo eTLD+1 is in approvedDomains", () => {
    const signal = makeSignal({
      data: {
        from: { address: "sender@company.com" },
        replyTo: { address: "replies@helpdesk.io" },
      },
    });
    expect(isReplyTargetSafe(signal, ["helpdesk.io"])).toEqual({ safe: true });
  });

  it("returns unsafe when replyTo eTLD+1 differs from from and is not approved", () => {
    const signal = makeSignal({
      data: {
        from: { address: "spammer@legit-domain.com" },
        replyTo: { address: "victim@innocent.org" },
      },
    });
    const result = isReplyTargetSafe(signal, []);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("victim@innocent.org");
    expect(result.reason).toContain("spammer@legit-domain.com");
  });

  it("returns unsafe when replyTo eTLD+1 differs and approvedDomains does not include it", () => {
    const signal = makeSignal({
      data: {
        from: { address: "sender@company.com" },
        replyTo: { address: "attacker@evil.net" },
      },
    });
    const result = isReplyTargetSafe(signal, ["other-approved.com"]);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("evil.net");
    expect(result.reason).toContain("company.com");
  });
});

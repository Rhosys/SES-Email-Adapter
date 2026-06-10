import { describe, it, expect } from "vitest";
import { assignSystemLabels, getETLD1, DEFAULT_SPAM_SCORE_THRESHOLD, type SystemLabelContext } from "../../src/processor/filter.js";
import { SYSTEM_RULES } from "../../src/processor/processor.js";

const LOW_SPAM = 0.1;
const MED_SPAM = 0.5;
const HIGH_SPAM = DEFAULT_SPAM_SCORE_THRESHOLD + 0.01;

function makeCtx(overrides: Partial<SystemLabelContext> = {}): SystemLabelContext {
  return {
    workflow: "conversation",
    workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
    spamScore: LOW_SPAM,
    spamScoreThreshold: DEFAULT_SPAM_SCORE_THRESHOLD,
    senderETLD1: "amazon.com",
    senderEntry: { accountId: "acct-001", aliasAddress: "user@example.com", domain: "example.com", alias: "user", senderDomain: "amazon.com", policy: "allow", addedAt: "2024-01-01T00:00:00Z" },
    unknownSenderPolicy: "quarantine_visible",
    hasSentMessages: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getETLD1
// ---------------------------------------------------------------------------

describe("getETLD1", () => {
  it("extracts eTLD+1 from a plain email address", () => {
    expect(getETLD1("user@mail.amazon.co.uk")).toBe("amazon.co.uk");
  });

  it("extracts eTLD+1 from a subdomain email", () => {
    expect(getETLD1("noreply@accounts.google.com")).toBe("google.com");
  });

  it("works with a bare domain (no @)", () => {
    expect(getETLD1("evil.attacker.com")).toBe("attacker.com");
  });

  it("falls back to the raw domain string for unrecognized TLDs", () => {
    expect(getETLD1("service@api.internal")).toBe("api.internal");
  });

  it("extracts eTLD+1 when local part contains a dot", () => {
    expect(getETLD1("first.last@subdomain.example.com")).toBe("example.com");
  });
});

// ---------------------------------------------------------------------------
// assignSystemLabels — workflow mirror
// ---------------------------------------------------------------------------

describe("assignSystemLabels — workflow label", () => {
  it("always emits system:workflow:<workflow>", () => {
    const labels = assignSystemLabels(makeCtx({ workflow: "auth", workflowData: { workflow: "auth", authType: "otp", service: "github.com" } }));
    expect(labels).toContain("system:workflow:auth");
  });

  it("emits correct label for every workflow", () => {
    const workflows = ["conversation", "crm", "package", "travel", "payments", "alert", "content", "onboarding", "status", "healthcare", "job", "support", "test"] as const;
    for (const workflow of workflows) {
      const labels = assignSystemLabels(makeCtx({ workflow, workflowData: { workflow } as never }));
      expect(labels).toContain(`system:workflow:${workflow}`);
    }
  });
});

// ---------------------------------------------------------------------------
// assignSystemLabels — spam labels
// ---------------------------------------------------------------------------

describe("assignSystemLabels — spam labels", () => {
  it("emits system:spam:high when spamScore >= threshold", () => {
    const labels = assignSystemLabels(makeCtx({ spamScore: HIGH_SPAM }));
    expect(labels).toContain("system:spam:high");
    expect(labels).not.toContain("system:spam:medium");
  });

  it("emits system:spam:medium when spamScore >= 0.4 but < threshold", () => {
    const labels = assignSystemLabels(makeCtx({ spamScore: MED_SPAM }));
    expect(labels).toContain("system:spam:medium");
    expect(labels).not.toContain("system:spam:high");
  });

  it("emits no spam label for low spam score", () => {
    const labels = assignSystemLabels(makeCtx({ spamScore: LOW_SPAM }));
    expect(labels).not.toContain("system:spam:high");
    expect(labels).not.toContain("system:spam:medium");
  });
});

// ---------------------------------------------------------------------------
// assignSystemLabels — sender trust
// ---------------------------------------------------------------------------

describe("assignSystemLabels — sender trust", () => {
  it("emits system:sender:untrusted when sender not in approvedSenders", () => {
    const labels = assignSystemLabels(makeCtx({ senderETLD1: "unknown.com", senderEntry: null }));
    expect(labels).toContain("system:sender:untrusted");
  });

  it("does not emit system:sender:untrusted when sender is in approvedSenders", () => {
    const labels = assignSystemLabels(makeCtx({ senderETLD1: "amazon.com", senderEntry: { accountId: "acct-001", aliasAddress: "user@example.com", domain: "example.com", alias: "user", senderDomain: "amazon.com", policy: "allow", addedAt: "2024-01-01T00:00:00Z" } }));
    expect(labels).not.toContain("system:sender:untrusted");
  });

  it("does not emit system:sender:untrusted in allow_all mode regardless of approvedSenders", () => {
    const labels = assignSystemLabels(makeCtx({ senderETLD1: "unknown.com", senderEntry: null, unknownSenderPolicy: "allow_all" }));
    expect(labels).not.toContain("system:sender:untrusted");
  });

  it("emits system:sender:untrusted for matched arc if not in approvedSenders (trust is purely from approvedSenders)", () => {
    const labels = assignSystemLabels(makeCtx({ senderETLD1: "unknown.com", senderEntry: null, workflow: "content", workflowData: { workflow: "content", contentType: "newsletter", publisher: "foo" } }));
    expect(labels).toContain("system:sender:untrusted");
  });
});

// ---------------------------------------------------------------------------
// assignSystemLabels — replied and test labels
// ---------------------------------------------------------------------------

describe("assignSystemLabels — replied and test labels", () => {
  it("emits system:replied when hasSentMessages is true", () => {
    expect(assignSystemLabels(makeCtx({ hasSentMessages: true }))).toContain("system:replied");
  });

  it("does not emit system:replied when hasSentMessages is false", () => {
    expect(assignSystemLabels(makeCtx({ hasSentMessages: false }))).not.toContain("system:replied");
  });

  it("emits system:test for test workflow", () => {
    const labels = assignSystemLabels(makeCtx({ workflow: "test", workflowData: { workflow: "test", triggeredBy: "user" } }));
    expect(labels).toContain("system:test");
  });

  it("does not emit system:test for non-test workflow", () => {
    expect(assignSystemLabels(makeCtx())).not.toContain("system:test");
  });
});

// ---------------------------------------------------------------------------
// assignSystemLabels — exhaustive: only known SystemLabel values emitted
// ---------------------------------------------------------------------------

describe("assignSystemLabels — no unlisted labels", () => {
  it("returns only values assignable to SystemLabel (TypeScript enforces this at compile time)", () => {
    // The compile-time contract: assignSystemLabels() is declared to return SystemLabel[].
    // Any string pushed inside the function that is not in the SystemLabel union is a type error.
    // This runtime test just confirms the function returns an array — the type checker does the real work.
    const labels: import("../../src/types/index.js").SystemLabel[] = assignSystemLabels(makeCtx());
    expect(Array.isArray(labels)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assignSystemLabels — security_alert auth label
// ---------------------------------------------------------------------------

describe("assignSystemLabels — security_alert", () => {
  it("emits system:auth:security_alert for auth signals with authType security_alert", () => {
    const labels = assignSystemLabels(makeCtx({
      workflow: "auth",
      workflowData: { workflow: "auth", authType: "security_alert", service: "google.com" },
    }));
    expect(labels).toContain("system:auth:security_alert");
  });

  it.each([
    { authType: "otp" as const, label: "otp" },
    { authType: "magic_link" as const, label: "magic_link" },
    { authType: "password_reset" as const, label: "password_reset" },
    { authType: "verification" as const, label: "verification" },
    { authType: "two_factor" as const, label: "two_factor" },
    { authType: "other" as const, label: "other" },
  ])("does NOT emit system:auth:security_alert for authType $label", ({ authType }) => {
    const labels = assignSystemLabels(makeCtx({
      workflow: "auth",
      workflowData: { workflow: "auth", authType, service: "github.com" },
    }));
    expect(labels).not.toContain("system:auth:security_alert");
  });
});

// ---------------------------------------------------------------------------
// SYSTEM_RULES — SR-25
// ---------------------------------------------------------------------------

describe("SYSTEM_RULES — SR-25", () => {
  it("SR-25 exists with condition matching system:auth:security_alert and action quarantine_hidden", () => {
    const sr25 = SYSTEM_RULES.find(r => r.id === "SR-25");
    expect(sr25).toBeDefined();
    expect(JSON.parse(sr25!.condition)).toEqual({ "in": ["system:auth:security_alert", { "var": "arc.labels" }] });
    expect(sr25!.actions).toEqual([{ type: "quarantine_hidden" }]);
    expect(sr25!.status).toBe("enabled");
  });
});

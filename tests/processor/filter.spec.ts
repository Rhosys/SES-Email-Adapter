import { describe, it, expect } from "vitest";
import { assignSystemLabels, getETLD1, type SystemLabelContext } from "../../src/processor/filter.js";
import { SYSTEM_RULES } from "../../src/processor/processor.js";

function makeCtx(overrides: Partial<SystemLabelContext> = {}): SystemLabelContext {
  return {
    workflow: "conversation",
    workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
    tags: [],
    senderETLD1: "amazon.com",
    aliasSenderConfig: { accountId: "acct-001", aliasAddress: "user@example.com", domain: "example.com", aliasName: "user", senderDomain: "amazon.com", policy: "allow", addedAt: "2024-01-01T00:00:00Z" },
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
// assignSystemLabels — spam labels
// ---------------------------------------------------------------------------

describe("assignSystemLabels — spam labels", () => {
  it("emits system:spam when tags contain phishing", () => {
    const labels = assignSystemLabels(makeCtx({ tags: ["phishing"] }));
    expect(labels).toContain("system:spam");
  });

  it("emits no spam label when tags are empty", () => {
    const labels = assignSystemLabels(makeCtx({ tags: [] }));
    expect(labels).not.toContain("system:spam");
  });
});

// ---------------------------------------------------------------------------
// assignSystemLabels — sender trust
// ---------------------------------------------------------------------------

describe("assignSystemLabels — sender trust", () => {
  it("emits system:sender:untrusted when sender not in approvedSenders", () => {
    const labels = assignSystemLabels(makeCtx({ senderETLD1: "unknown.com", aliasSenderConfig: null }));
    expect(labels).toContain("system:sender:untrusted");
  });

  it("does not emit system:sender:untrusted when sender is in approvedSenders", () => {
    const labels = assignSystemLabels(makeCtx({ senderETLD1: "amazon.com", aliasSenderConfig: { accountId: "acct-001", aliasAddress: "user@example.com", domain: "example.com", aliasName: "user", senderDomain: "amazon.com", policy: "allow", addedAt: "2024-01-01T00:00:00Z" } }));
    expect(labels).not.toContain("system:sender:untrusted");
  });

  it("does not emit system:sender:untrusted in allow_all mode regardless of approvedSenders", () => {
    const labels = assignSystemLabels(makeCtx({ senderETLD1: "unknown.com", aliasSenderConfig: null, unknownSenderPolicy: "allow_all" }));
    expect(labels).not.toContain("system:sender:untrusted");
  });

  it("emits system:sender:untrusted for matched arc if not in approvedSenders (trust is purely from approvedSenders)", () => {
    const labels = assignSystemLabels(makeCtx({ senderETLD1: "unknown.com", aliasSenderConfig: null, workflow: "content", workflowData: { workflow: "content", contentType: "newsletter", publisher: "foo" } }));
    expect(labels).toContain("system:sender:untrusted");
  });
});

// ---------------------------------------------------------------------------
// assignSystemLabels — replied
// ---------------------------------------------------------------------------

describe("assignSystemLabels — replied", () => {
  it("emits system:replied when hasSentMessages is true", () => {
    expect(assignSystemLabels(makeCtx({ hasSentMessages: true }))).toContain("system:replied");
  });

  it("does not emit system:replied when hasSentMessages is false", () => {
    expect(assignSystemLabels(makeCtx({ hasSentMessages: false }))).not.toContain("system:replied");
  });
});

// ---------------------------------------------------------------------------
// assignSystemLabels — exhaustive: only known SystemLabel values emitted
// ---------------------------------------------------------------------------

describe("assignSystemLabels — no unlisted labels", () => {
  it("returns only values assignable to SystemLabel (TypeScript enforces this at compile time)", () => {
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
// SYSTEM_RULES — SR-05
// ---------------------------------------------------------------------------

describe("SYSTEM_RULES — SR-06", () => {
  it("SR-06 exists with condition matching system:auth:security_alert and action quarantine_hidden", () => {
    const sr06 = SYSTEM_RULES.find(r => r.id === "SR-06");
    expect(sr06).toBeDefined();
    expect(JSON.parse(sr06!.condition)).toEqual({ "in": ["system:auth:security_alert", { "var": "thread.labels" }] });
    expect(sr06!.actions).toEqual([{ type: "quarantine_hidden" }]);
    expect(sr06!.status).toBe("enabled");
  });
});

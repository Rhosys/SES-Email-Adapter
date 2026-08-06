import { describe, it, expect } from "vitest";
import { assignSystemLabels, getETLD1, type SystemLabelContext } from "../../src/processor/filter.js";
import { SYSTEM_RULES } from "../../src/processor/processor.js";

function makeCtx(overrides: Partial<SystemLabelContext> = {}): SystemLabelContext {
  return {
    workflow: "conversation",
    workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
    actions: [],
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
// getETLD1 — subdomain matching for test detection (B.3, B.4)
// ---------------------------------------------------------------------------

describe("getETLD1 — eTLD+1 comparison for test detection", () => {
  // B.3: getETLD1(sender) matches getETLD1(registered domain) via eTLD+1 comparison
  it("subdomain sender matches registered apex domain", () => {
    // sender = mail.example.com, registered = example.com → both eTLD+1 = example.com
    expect(getETLD1("user@mail.example.com")).toBe(getETLD1("example.com"));
  });

  it("deep subdomain sender matches registered apex domain", () => {
    // sender = a.b.c.example.com, registered = example.com
    expect(getETLD1("noreply@a.b.c.example.com")).toBe(getETLD1("example.com"));
  });

  it("subdomain sender matches registered subdomain of same apex", () => {
    // sender = notifications.example.com, registered = app.example.com → both eTLD+1 = example.com
    expect(getETLD1("user@notifications.example.com")).toBe(getETLD1("app.example.com"));
  });

  it("ccTLD subdomain sender matches registered ccTLD apex", () => {
    // sender = mail.amazon.co.uk, registered = amazon.co.uk → both eTLD+1 = amazon.co.uk
    expect(getETLD1("user@mail.amazon.co.uk")).toBe(getETLD1("amazon.co.uk"));
  });

  // B.4: non-matching domains do not produce false positives
  it("different apex domains do not match", () => {
    // sender = attacker.com, registered = example.com → different eTLD+1
    expect(getETLD1("user@attacker.com")).not.toBe(getETLD1("example.com"));
  });

  it("subdomain of different apex does not match", () => {
    // sender = mail.attacker.com, registered = example.com
    expect(getETLD1("user@mail.attacker.com")).not.toBe(getETLD1("example.com"));
  });

  it("similar-looking domains with different eTLD+1 do not match", () => {
    // sender = example.com.evil.com — eTLD+1 = evil.com, not example.com
    expect(getETLD1("user@example.com.evil.com")).not.toBe(getETLD1("example.com"));
  });

  it("different ccTLD registrations do not match", () => {
    // sender = amazon.co.uk, registered = amazon.com → different eTLD+1
    expect(getETLD1("user@amazon.co.uk")).not.toBe(getETLD1("amazon.com"));
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

describe("SYSTEM_RULES — SR-05", () => {
  it("SR-05 exists with condition matching system:auth:security_alert and action quarantine_hidden", () => {
    const sr05 = SYSTEM_RULES.find(r => r.id === "SR-05");
    expect(sr05).toBeDefined();
    expect(JSON.parse(sr05!.condition)).toEqual({ "in": ["system:auth:security_alert", { "var": "thread.labels" }] });
    expect(sr05!.actions).toEqual([{ type: "quarantine_hidden" }]);
    expect(sr05!.status).toBe("enabled");
  });
});

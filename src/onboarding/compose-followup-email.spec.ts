import { describe, it, expect } from "vitest";
import { composeFollowupEmail, type OnboardingProgress } from "./compose-followup-email.js";

describe("composeFollowupEmail", () => {
  it.each<{ label: string; progress: OnboardingProgress; expectedSubject: string; expectedSuggestionCount: number }>([
    {
      label: "all incomplete → 3 suggestions",
      progress: { domainAdded: false, senderSetupComplete: false, emailsReceived: false },
      expectedSubject: "Next steps for your account",
      expectedSuggestionCount: 3,
    },
    {
      label: "domain added only → 2 suggestions",
      progress: { domainAdded: true, senderSetupComplete: false, emailsReceived: false },
      expectedSubject: "Next steps for your account",
      expectedSuggestionCount: 2,
    },
    {
      label: "domain + sender complete → 1 suggestion",
      progress: { domainAdded: true, senderSetupComplete: true, emailsReceived: false },
      expectedSubject: "Next steps for your account",
      expectedSuggestionCount: 1,
    },
    {
      label: "all complete → congratulatory message",
      progress: { domainAdded: true, senderSetupComplete: true, emailsReceived: true },
      expectedSubject: "You're all set!",
      expectedSuggestionCount: 0,
    },
  ])("$label", ({ progress, expectedSubject, expectedSuggestionCount }) => {
    const result = composeFollowupEmail(progress);
    expect(result.subject).toBe(expectedSubject);

    if (expectedSuggestionCount === 0) {
      expect(result.textBody).toContain("Congratulations");
      expect(result.textBody).not.toContain("•");
    } else {
      const bulletCount = (result.textBody.match(/•/g) ?? []).length;
      expect(bulletCount).toBe(expectedSuggestionCount);
    }
  });

  it("includes domain suggestion when domainAdded is false", () => {
    const result = composeFollowupEmail({ domainAdded: false, senderSetupComplete: true, emailsReceived: true });
    expect(result.textBody).toContain("Add a custom domain");
  });

  it("includes sender setup suggestion when senderSetupComplete is false", () => {
    const result = composeFollowupEmail({ domainAdded: true, senderSetupComplete: false, emailsReceived: true });
    expect(result.textBody).toContain("Complete sender setup");
  });

  it("includes test email suggestion when emailsReceived is false", () => {
    const result = composeFollowupEmail({ domainAdded: true, senderSetupComplete: true, emailsReceived: false });
    expect(result.textBody).toContain("Send a test email");
  });
});

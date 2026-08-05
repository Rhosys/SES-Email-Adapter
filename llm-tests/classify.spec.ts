// LLM Integration Tests — Real Bedrock Classifier
//
// These tests call the REAL Bedrock model (no mocks) and validate that the
// classifier returns the correct shape for every field in ClassificationOutput.
//
// WHY: Mock-only tests cannot catch missing fields. If a test mock omits a field
// (like `actions`), unit tests pass but production crashes at runtime when
// downstream code reads that field. These tests are the safety net.
//
// WHEN TO UPDATE:
// - Adding a new field to ClassificationOutput (src/classifier/classifier.ts)
// - Changing what the classifier prompt asks for (prompt-builder.ts)
// - Adding a new workflow to the registry (workflow-registry.ts)
// - Changing action/URL extraction logic
//
// RUN: npm run test:llm-bedrock-classifier
// REQUIRES: Valid AWS credentials with Bedrock InvokeModel permission

import { describe, it, expect } from "vitest";
import { SignalClassifier } from "../src/classifier/classifier.js";
import type { ClassificationInput } from "../src/classifier/classifier.js";
import { WORKFLOWS } from "../src/types/index.js";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

const logger = {
  startInvocation() {},
  getInvocationId() { return "llm-test"; },
  trackPoint() {},
  info() {},
  track() {},
  warn() {},
  error() {},
  critical() {},
};

const classifier = new SignalClassifier(
  new BedrockRuntimeClient({ region: "eu-central-1" }),
  logger as never,
);

const ALLOWED_LABELS = ["billing", "urgent", "travel", "personal", "work", "receipts", "newsletters", "security", "medical", "shopping"];

function makeInput(overrides: Partial<ClassificationInput>): ClassificationInput {
  return {
    from: "noreply@example.com",
    to: ["user@mydomain.com"],
    subject: "Test",
    body: "Test body",
    receivedAt: "2025-01-15T10:00:00Z",
    headers: {},
    allowedLabels: ALLOWED_LABELS,
    ...overrides,
  };
}

function assertCommonOutput(result: ReturnType<Awaited<ReturnType<typeof classifier.classify>>["_unsafeUnwrap"]> extends infer T ? T : never) {
  // Summary under 150 chars
  expect(result.summary.length).toBeLessThanOrEqual(150);
  // Labels are a subset of allowed labels
  for (const label of result.labels) {
    expect(ALLOWED_LABELS).toContain(label);
  }
  // Actions array always present and well-formed
  expect(Array.isArray(result.actions)).toBe(true);
  for (const action of result.actions) {
    expect(action.url).toMatch(/^https?:\/\//);
    expect(action.text === null || typeof action.text === "string").toBe(true);
  }
}

describe("Signal Classifier — LLM integration tests", () => {
  describe("Workflow classification", () => {
    it("auth — OTP email", async () => {
      const input = makeInput({
        from: "noreply@github.com",
        subject: "Your GitHub verification code",
        body: "Your verification code is 847291. This code expires in 10 minutes.",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("auth");
      expect(output.workflowData).toHaveProperty("authType");
      expect(output.workflowData).toHaveProperty("service");
      assertCommonOutput(output);
    });

    it("auth — confirmation code labelled as 'verify' must be otp with code extracted", async () => {
      const input = makeInput({
        from: "no-reply@infomaniak.com",
        subject: "Infomaniak confirmation code: JJ4-TY8",
        body: "Confirm your email address\n\nHere is your confirmation code. Copy it into the open window of your browser.\n\nJJ4-TY8\n\nIf you did not request to receive this email, contact our support.",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("auth");
      expect((output.workflowData as { authType: string }).authType).toBe("otp");
      expect((output.workflowData as { code?: string }).code).toBe("JJ4-TY8");
      expect((output.workflowData as { service: string }).service.toLowerCase()).toContain("infomaniak");
      assertCommonOutput(output);
    });

    it("conversation — personal email", async () => {
      const input = makeInput({
        from: "alice.chen@gmail.com",
        subject: "Re: Dinner Saturday?",
        body: "Hey! Saturday at 7 works for me. Should I bring anything? Looking forward to catching up — it's been too long.",
        headers: { "authentication-results": "spf=pass dkim=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("conversation");
      expect(output.workflowData).toHaveProperty("sentiment");
      expect(output.workflowData).toHaveProperty("requiresReply");
      assertCommonOutput(output);
    });

    it("crm — sales outreach", async () => {
      const input = makeInput({
        from: "sarah.williams@hubspot.com",
        subject: "Quick question about your team's workflow",
        body: "Hi there,\n\nI noticed your company recently raised a Series B — congrats! I work with similar-stage startups on streamlining their sales pipeline. Would you have 15 minutes this week for a quick chat about how we've helped teams like yours reduce deal cycle time by 30%?\n\nBest,\nSarah Williams\nAccount Executive, HubSpot",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("crm");
      assertCommonOutput(output);
    });

    it("package — shipping notification", async () => {
      const input = makeInput({
        from: "ship-confirm@amazon.co.uk",
        subject: "Your Amazon order has shipped",
        body: "Your package is on its way!\n\nOrder #302-4819372-8291045\nItem: Logitech MX Master 3S Wireless Mouse\nQuantity: 1\n\nTracking number: JD0149283746GB\nEstimated delivery: Thursday, 16 January 2025\n\nTrack your package: https://www.amazon.co.uk/gp/your-account/order-details?orderID=302-4819372-8291045",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("package");
      expect(output.workflowData).toHaveProperty("packageType");
      expect(output.workflowData).toHaveProperty("retailer");
      assertCommonOutput(output);
    });

    it("travel — flight booking confirmation", async () => {
      const input = makeInput({
        from: "booking@ryanair.com",
        subject: "Booking Confirmation - DUB to BCN",
        body: "Booking confirmed!\n\nPassenger: Warren Parad\nFlight: FR1234\nRoute: Dublin (DUB) → Barcelona (BCN)\nDate: 15 March 2025\nDeparture: 06:40\nSeat: 14A\nConfirmation: XKRJ7M\n\nTotal paid: €89.99\n\nCheck in opens 48 hours before departure at ryanair.com",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("travel");
      expect(output.workflowData).toHaveProperty("travelType");
      expect(output.workflowData).toHaveProperty("provider");
      assertCommonOutput(output);
    });

    it("payments — invoice", async () => {
      const input = makeInput({
        from: "billing@digitalocean.com",
        subject: "Invoice for January 2025",
        body: "Hi Warren,\n\nYour DigitalOcean invoice for January 2025 is ready.\n\nInvoice #INV-2025-01-84729\nAmount: $47.52 USD\nDue date: February 1, 2025\n\nPay now: https://cloud.digitalocean.com/account/billing\n\nIf you have questions about this invoice, contact our billing team.",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("payments");
      expect(output.workflowData).toHaveProperty("paymentType");
      expect(output.workflowData).toHaveProperty("vendor");
      assertCommonOutput(output);
    });

    it("alert — suspicious login", async () => {
      const input = makeInput({
        from: "security@accounts.google.com",
        subject: "Security alert: New sign-in from Windows",
        body: "New sign-in to your Google Account\n\nWe noticed a new sign-in to your Google Account on a Windows device. If this was you, you don't need to do anything. If not, we'll help you secure your account.\n\nDevice: Windows PC\nLocation: São Paulo, Brazil\nIP: 187.45.221.83\nTime: January 15, 2025, 3:42 AM GMT\n\nIf this wasn't you, review your account activity at https://myaccount.google.com/notifications",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("alert");
      expect(output.workflowData).toHaveProperty("alertType");
      expect(output.workflowData).toHaveProperty("service");
      expect(output.workflowData).toHaveProperty("requiresAction");
      assertCommonOutput(output);
    });

    it("content — newsletter", async () => {
      const input = makeInput({
        from: "hello@tldr.tech",
        subject: "TLDR Newsletter 2025-01-15",
        body: "TLDR 2025-01-15\n\nBig Tech & Startups\n\n• OpenAI launches GPT-5 with 10x context window\n• Stripe acquires fintech startup for $1.2B\n• AWS announces new region in Melbourne\n\nScience & Technology\n\n• Researchers achieve room-temperature superconductivity breakthrough\n• SpaceX Starship completes 10th successful landing\n\nUnsubscribe: https://tldr.tech/unsubscribe",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass", "list-unsubscribe": "<https://tldr.tech/unsubscribe>" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("content");
      expect(output.workflowData).toHaveProperty("contentType");
      expect(output.workflowData).toHaveProperty("publisher");
      assertCommonOutput(output);
    });

    it("onboarding — welcome email", async () => {
      const input = makeInput({
        from: "team@linear.app",
        subject: "Welcome to Linear",
        body: "Welcome to Linear!\n\nYour workspace is ready. Here's how to get started:\n\n1. Create your first project\n2. Invite your team members\n3. Connect your GitHub repos\n\nGet started: https://linear.app/workspace/getting-started\n\nIf you have questions, reply to this email or check our docs at linear.app/docs.",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("onboarding");
      expect(output.workflowData).toHaveProperty("onboardingType");
      expect(output.workflowData).toHaveProperty("service");
      assertCommonOutput(output);
    });

    it("status — terms of service update", async () => {
      const input = makeInput({
        from: "legal@notion.so",
        subject: "Updates to our Terms of Service",
        body: "We're updating our Terms of Service\n\nEffective March 1, 2025, we're making changes to how we handle data processing in the EU. Key changes:\n\n• Updated data processor agreement\n• New standard contractual clauses\n• Clarified data retention policies\n\nReview the full terms: https://notion.so/terms\n\nNo action required — continued use constitutes acceptance.",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(["status", "notice"]).toContain(output.workflow);
      // status → statusType/provider; notice → noticeType/provider
      expect(output.workflowData).toHaveProperty("provider");
      assertCommonOutput(output);
    });

    it("healthcare — appointment reminder", async () => {
      const input = makeInput({
        from: "appointments@nhs.uk",
        subject: "Appointment Reminder - Dr. Patel, 20 Jan",
        body: "Appointment Reminder\n\nPatient: Warren Parad\nDoctor: Dr. Aisha Patel\nDate: Monday 20 January 2025, 10:30 AM\nLocation: Riverside Medical Centre, 42 Thames Road, London SE1 7PQ\n\nPlease arrive 10 minutes early. If you need to cancel or reschedule, call 020 7946 0958 or visit https://nhs.uk/appointments.\n\nBring your NHS number and photo ID.",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("healthcare");
      expect(output.workflowData).toHaveProperty("eventType");
      expect(output.workflowData).toHaveProperty("requiresAction");
      assertCommonOutput(output);
    });

    it("job — interview request", async () => {
      const input = makeInput({
        from: "recruiting@stripe.com",
        subject: "Interview: Senior Backend Engineer at Stripe",
        body: "Hi Warren,\n\nThanks for your application for the Senior Backend Engineer role at Stripe. We'd love to move forward with a technical interview.\n\nRole: Senior Backend Engineer (Payments Infrastructure)\nLocation: Dublin, Ireland (hybrid)\nInterview: Thursday 23 January 2025, 2:00 PM GMT via Zoom\n\nYour interviewer will be Marcus Chen (Staff Engineer). The interview is 60 minutes: 45 min system design + 15 min Q&A.\n\nPlease confirm your availability: https://calendly.com/stripe-recruiting/warren-interview\n\nBest,\nEmma Rodriguez\nTalent Acquisition, Stripe\nemma.rodriguez@stripe.com",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("job");
      expect(output.workflowData).toHaveProperty("jobType");
      assertCommonOutput(output);
    });

    it("support — ticket update", async () => {
      const input = makeInput({
        from: "support@cloudflare.com",
        subject: "Re: [Ticket #CF-482917] DNS propagation delay",
        body: "Your support ticket has been updated.\n\nTicket: #CF-482917\nStatus: Awaiting your response\nPriority: High\n\nHi Warren,\n\nI've investigated the DNS propagation delay you reported. The issue was caused by a stale cache entry in our edge PoPs. I've purged the affected records — changes should propagate within 5 minutes.\n\nCan you confirm the records are resolving correctly on your end?\n\nBest,\nJordan Lee\nCloudflare Support\n\nReply to this email or view your ticket: https://dash.cloudflare.com/support/ticket/CF-482917",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("support");
      expect(output.workflowData).toHaveProperty("eventType");
      expect(output.workflowData).toHaveProperty("service");
      assertCommonOutput(output);
    });

    it("events — concert ticket confirmation", async () => {
      const input = makeInput({
        from: "tickets@ticketmaster.ie",
        subject: "Your tickets: Arctic Monkeys at 3Arena",
        body: "Booking Confirmed!\n\nEvent: Arctic Monkeys — Live at 3Arena\nVenue: 3Arena, North Wall Quay, Dublin 1\nDate: Saturday 8 March 2025, doors 18:30, show 20:00\nTickets: 2x Standing\nReference: TM-IE-89274631\n\nTotal: €165.00\n\nYour e-tickets: https://ticketmaster.ie/mytickets/TM-IE-89274631\n\nRemember: tickets are non-transferable and linked to your Ticketmaster account.",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("events");
      expect(output.workflowData).toHaveProperty("eventType");
      expect(output.workflowData).toHaveProperty("eventName");
      assertCommonOutput(output);
    });

    it("test — self-sent test email", async () => {
      const input = makeInput({
        from: "warren@mydomain.com",
        to: ["warren@mydomain.com"],
        subject: "Test email",
        body: "Testing that my domain is set up correctly.",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("test");
      expect(output.workflowData).toHaveProperty("triggeredBy");
      assertCommonOutput(output);
    });
  });

  describe("Edge cases", () => {
    it("spam — Nigerian prince scam", async () => {
      const input = makeInput({
        from: "prince.abubakar@yahoo.ng",
        subject: "URGENT: $15,000,000 Transfer Awaiting Your Confirmation!!!",
        body: "Dear Beloved,\n\nI am Prince Abubakar Mohammed, son of the late Chief Minister of Finance. I have $15,000,000 USD in a dormant account that I need your help transferring. You will receive 30% ($4,500,000) for your assistance.\n\nAll I need is:\n1. Your full name\n2. Your bank account number\n3. Your phone number\n\nPlease reply urgently as time is of the essence. God bless you.\n\nYours faithfully,\nPrince Abubakar Mohammed",
        headers: { "authentication-results": "spf=fail dkim=none" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(WORKFLOWS).toContain(output.workflow);
      assertCommonOutput(output);
    });

    it("multilingual — German shipping notification", async () => {
      const input = makeInput({
        from: "versand@zalando.de",
        subject: "Deine Bestellung wurde versandt",
        body: "Hallo Warren,\n\nGute Nachrichten! Deine Bestellung #ZAL-DE-8492731 ist auf dem Weg.\n\nArtikel: Nike Air Max 90 (Größe 43)\nSendungsnummer: 00340434161094015487\nVoraussichtliche Lieferung: Freitag, 17. Januar 2025\n\nSendung verfolgen: https://www.zalando.de/sendungsverfolgung/00340434161094015487\n\nViele Grüße,\nDein Zalando Team",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.workflow).toBe("package");
      expect(output.workflowData).toHaveProperty("packageType");
      expect(output.workflowData).toHaveProperty("retailer");
      assertCommonOutput(output);
    });

    it("ambiguous — could be payments or onboarding (trial started with billing)", async () => {
      const input = makeInput({
        from: "hello@vercel.com",
        subject: "Your Pro trial has started",
        body: "Welcome to Vercel Pro!\n\nYour 14-day free trial is now active. Here's what you get:\n\n• Unlimited deployments\n• Advanced analytics\n• Team collaboration\n\nYour trial ends on January 29, 2025. After that, you'll be charged $20/month to your card ending in 4242.\n\nManage your subscription: https://vercel.com/account/billing\n\nGet started with Pro features: https://vercel.com/docs/pro",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      // Acceptable: either onboarding (trial_started) or payments (subscription_renewal)
      expect(["onboarding", "payments"]).toContain(output.workflow);
      assertCommonOutput(output);
    });
  });

  describe("Actions extraction", () => {
    it("extracts actionable URLs from an invoice email", async () => {
      const input = makeInput({
        from: "billing@digitalocean.com",
        subject: "Invoice for January 2025",
        body: "Hi Warren,\n\nYour DigitalOcean invoice for January 2025 is ready.\n\nInvoice #INV-2025-01-84729\nAmount: $47.52 USD\nDue date: February 1, 2025\n\nPay now: https://cloud.digitalocean.com/account/billing\nDownload PDF: https://cloud.digitalocean.com/invoices/INV-2025-01-84729.pdf\n\nIf you have questions about this invoice, contact our billing team.",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.actions).toBeDefined();
      expect(Array.isArray(output.actions)).toBe(true);
      // Should extract at least one actionable URL
      expect(output.actions.length).toBeGreaterThanOrEqual(1);
      for (const action of output.actions) {
        expect(action.url).toMatch(/^https?:\/\//);
        // text is either a human-readable label or null
        expect(action.text === null || typeof action.text === "string").toBe(true);
        if (action.text !== null) {
          expect(action.text).not.toBe(action.url);
        }
      }
    });

    it("extracts tracking URL from a shipping notification", async () => {
      const input = makeInput({
        from: "ship-confirm@amazon.co.uk",
        subject: "Your Amazon order has shipped",
        body: "Your package is on its way!\n\nOrder #302-4819372-8291045\nItem: Logitech MX Master 3S Wireless Mouse\n\nTrack your package: https://www.amazon.co.uk/gp/your-account/order-details?orderID=302-4819372-8291045\n\nEstimated delivery: Thursday, 16 January 2025",
        headers: { "authentication-results": "spf=pass dkim=pass dmarc=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.actions).toBeDefined();
      expect(Array.isArray(output.actions)).toBe(true);
      // Tracking URL should be extracted as an action
      expect(output.actions.length).toBeGreaterThanOrEqual(1);
      const trackingAction = output.actions.find(a => a.url.includes("amazon.co.uk"));
      expect(trackingAction).toBeDefined();
    });

    it("returns empty actions for a plain personal email with no URLs", async () => {
      const input = makeInput({
        from: "alice@gmail.com",
        subject: "Re: Dinner Saturday?",
        body: "Hey! Saturday at 7 works for me. Should I bring anything? Looking forward to catching up.",
        headers: { "authentication-results": "spf=pass dkim=pass" },
      });
      const result = await classifier.classify(input);
      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.actions).toBeDefined();
      expect(Array.isArray(output.actions)).toBe(true);
      expect(output.actions).toHaveLength(0);
    });
  });
});

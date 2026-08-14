import { describe, it, expect } from "vitest";
import { buildMimeEmbedText, buildEmbedText, reduceLink, type EmbedTextInput } from "../../src/embedding/embed-text.js";
import type { ClassificationOutput } from "../../src/classifier/classifier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<EmbedTextInput> = {}): EmbedTextInput {
  return {
    accountId: "acct-123",
    from: "sender@example.com",
    recipientAddress: "recipient@example.com",
    subject: "Test Subject",
    rawTextBody: "Hello world",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildEmbedText — header construction
// ---------------------------------------------------------------------------

describe("buildEmbedText", () => {
  describe("header lines", () => {
    it("includes accountId, from, recipientAddress, subject on separate lines", () => {
      const result = buildMimeEmbedText(makeInput());
      const lines = result.split("\n");
      expect(lines[0]).toBe("acct-123");
      expect(lines[1]).toBe("sender@example.com");
      expect(lines[2]).toBe("recipient@example.com");
      expect(lines[3]).toBe("Test Subject");
    });

    it("includes replyTo when present", () => {
      const result = buildMimeEmbedText(makeInput({ replyTo: "reply@example.com" }));
      const lines = result.split("\n");
      expect(lines).toContain("reply@example.com");
    });

    it("includes returnPath when present", () => {
      const result = buildMimeEmbedText(makeInput({ returnPath: "bounce@example.com" }));
      const lines = result.split("\n");
      expect(lines).toContain("bounce@example.com");
    });

    it("omits replyTo line when undefined", () => {
      const result = buildMimeEmbedText(makeInput());
      const lines = result.split("\n");
      // Should be: accountId, from, recipientAddress, subject, body
      expect(lines.length).toBe(5);
    });

    it("omits returnPath line when empty string", () => {
      const result = buildMimeEmbedText(makeInput({ returnPath: "" }));
      const lines = result.split("\n");
      expect(lines.length).toBe(5);
    });

    it("includes both replyTo and returnPath when both present", () => {
      const result = buildMimeEmbedText(makeInput({
        replyTo: "reply@example.com",
        returnPath: "bounce@example.com",
      }));
      const lines = result.split("\n");
      expect(lines[2]).toBe("reply@example.com");
      expect(lines[3]).toBe("bounce@example.com");
      expect(lines[4]).toBe("recipient@example.com");
      expect(lines[5]).toBe("Test Subject");
    });
  });

  // ---------------------------------------------------------------------------
  // Sanitization — CSS removal
  // ---------------------------------------------------------------------------

  describe("sanitization — CSS removal", () => {
    it("removes <style> blocks and their content", () => {
      const result = buildMimeEmbedText(makeInput({
        rawTextBody: "before <style>.foo { color: red; }</style> after",
      }));
      expect(result).toContain("before");
      expect(result).toContain("after");
      expect(result).not.toContain("style");
      expect(result).not.toContain("color");
    });

    it("removes multiline <style> blocks", () => {
      const result = buildMimeEmbedText(makeInput({
        rawTextBody: "text <style type=\"text/css\">\n.a { margin: 0; }\n.b { padding: 0; }\n</style> more",
      }));
      expect(result).not.toContain("margin");
      expect(result).not.toContain("padding");
    });
  });

  // ---------------------------------------------------------------------------
  // Sanitization — HTML tag removal
  // ---------------------------------------------------------------------------

  describe("sanitization — HTML tag removal", () => {
    it("removes all HTML tags", () => {
      const result = buildMimeEmbedText(makeInput({
        rawTextBody: "<div><p>Hello</p><span>World</span></div>",
      }));
      expect(result).toContain("Hello");
      expect(result).toContain("World");
      expect(result).not.toContain("<div>");
      expect(result).not.toContain("<p>");
      expect(result).not.toContain("<span>");
    });

    it("removes self-closing tags", () => {
      const result = buildMimeEmbedText(makeInput({
        rawTextBody: "before <br/> after <hr /> end",
      }));
      expect(result).not.toContain("<br");
      expect(result).not.toContain("<hr");
    });
  });

  // ---------------------------------------------------------------------------
  // Sanitization — image removal
  // ---------------------------------------------------------------------------

  describe("sanitization — image removal", () => {
    it("removes <img> tags entirely", () => {
      const result = buildMimeEmbedText(makeInput({
        rawTextBody: 'before <img src="photo.jpg" alt="A photo"> after',
      }));
      expect(result).not.toContain("<img");
      expect(result).not.toContain("photo.jpg");
      expect(result).not.toContain("A photo");
      expect(result).toContain("before");
      expect(result).toContain("after");
    });

    it("removes self-closing <img/> tags", () => {
      const result = buildMimeEmbedText(makeInput({
        rawTextBody: 'text <img src="x.png" /> more',
      }));
      expect(result).not.toContain("<img");
      expect(result).not.toContain("x.png");
    });
  });

  // ---------------------------------------------------------------------------
  // Sanitization — link reduction
  // ---------------------------------------------------------------------------

  describe("sanitization — link reduction", () => {
    it("reduces full URL to domain + first path segment", () => {
      const result = buildMimeEmbedText(makeInput({
        rawTextBody: "Visit https://amazon.com/products/foo/bar?ref=x for details",
      }));
      expect(result).toContain("amazon.com/products");
      expect(result).not.toContain("foo/bar");
      expect(result).not.toContain("ref=x");
    });

    it("reduces URL with no path to just domain", () => {
      const result = buildMimeEmbedText(makeInput({
        rawTextBody: "Visit https://example.com for details",
      }));
      expect(result).toContain("example.com");
      expect(result).not.toContain("https://");
    });

    it("reduces URL with query string only to domain", () => {
      const result = buildMimeEmbedText(makeInput({
        rawTextBody: "Visit https://example.com?query=1 for details",
      }));
      expect(result).toContain("example.com");
      expect(result).not.toContain("query=1");
    });

    it("reduces URL with fragment to domain + first path", () => {
      const result = buildMimeEmbedText(makeInput({
        rawTextBody: "See https://docs.example.com/guide/section#heading here",
      }));
      expect(result).toContain("docs.example.com/guide");
      expect(result).not.toContain("section");
      expect(result).not.toContain("#heading");
    });

    it("handles multiple URLs in the same text", () => {
      const result = buildMimeEmbedText(makeInput({
        rawTextBody: "Link1: https://a.com/path1/sub Link2: https://b.com/path2/sub",
      }));
      expect(result).toContain("a.com/path1");
      expect(result).toContain("b.com/path2");
      expect(result).not.toContain("/sub");
    });
  });

  // ---------------------------------------------------------------------------
  // Body bounding
  // ---------------------------------------------------------------------------

  describe("body bounding", () => {
    it("passes through body ≤ 4000 chars unchanged", () => {
      const body = "x".repeat(4000);
      const result = buildMimeEmbedText(makeInput({ rawTextBody: body }));
      const lines = result.split("\n");
      const bodyLine = lines[lines.length - 1]!;
      expect(bodyLine.length).toBe(4000);
    });

    it("applies 3000+1000 split when body > 4000 chars", () => {
      // Create a body that after sanitization is > 4000 chars
      const body = "a".repeat(3000) + "b".repeat(2000) + "c".repeat(1000);
      const result = buildMimeEmbedText(makeInput({ rawTextBody: body }));
      const lines = result.split("\n");
      const bodyLine = lines[lines.length - 1]!;
      expect(bodyLine.length).toBe(4000);
      // First 3000 should be 'a's
      expect(bodyLine.slice(0, 3000)).toBe("a".repeat(3000));
      // Last 1000 should be 'c's (from the end of the sanitized body)
      expect(bodyLine.slice(-1000)).toBe("c".repeat(1000));
    });

    it("body portion never exceeds 4000 chars", () => {
      const body = "x".repeat(10000);
      const result = buildMimeEmbedText(makeInput({ rawTextBody: body }));
      const lines = result.split("\n");
      const bodyLine = lines[lines.length - 1]!;
      expect(bodyLine.length).toBe(4000);
    });
  });

  // ---------------------------------------------------------------------------
  // Determinism
  // ---------------------------------------------------------------------------

  describe("determinism", () => {
    it("produces identical output for identical input", () => {
      const input = makeInput({
        rawTextBody: '<div><style>.x{}</style><img alt="pic">Hello https://example.com/a/b/c</div>',
      });
      const result1 = buildMimeEmbedText(input);
      const result2 = buildMimeEmbedText(input);
      expect(result1).toBe(result2);
    });
  });
});

// ---------------------------------------------------------------------------
// reduceLink (exported helper)
// ---------------------------------------------------------------------------

describe("reduceLink", () => {
  it("reduces full URL to domain + first path segment", () => {
    expect(reduceLink("https://amazon.com/products/foo/bar?ref=x")).toBe("amazon.com/products");
  });

  it("returns just domain for URL with no path", () => {
    expect(reduceLink("https://example.com")).toBe("example.com");
  });

  it("returns just domain for URL with trailing slash only", () => {
    expect(reduceLink("https://example.com/")).toBe("example.com");
  });

  it("strips query string and fragment", () => {
    expect(reduceLink("https://example.com/path?q=1#frag")).toBe("example.com/path");
  });

  it("returns empty string for invalid URL", () => {
    expect(reduceLink("not-a-url")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildEmbedText — classification-output-driven embedding (new format)
// ---------------------------------------------------------------------------

describe("buildEmbedText (classification output)", () => {
  describe("line order", () => {
    it("produces recipientAddress, senderDomain, workflow, identity, subject, summary, labels lines in order", () => {
      const classification: ClassificationOutput = {
        workflow: "payments",
        workflowData: { workflow: "payments", paymentType: "invoice", vendor: "Stripe", amount: "29.99", currency: "USD" } as unknown as ClassificationOutput["workflowData"],
        tags: [],
        summary: "Your Stripe invoice for June is ready",
        labels: ["system:workflow:payments", "invoice"],
        actions: [],
      };
      const result = buildEmbedText("marketing.stripe.com", classification, "Invoice #1234");
      const lines = result.split("\n");
      expect(lines[0]).toBe("marketing.stripe.com");
      expect(lines[1]).toBe("payments");
      expect(lines[2]).toBe("Stripe Stripe Stripe");
      expect(lines[3]).toBe("Invoice #1234");
      expect(lines[4]).toBe("Your Stripe invoice for June is ready");
      expect(lines[5]).toBe("system:workflow:payments,invoice");
      expect(lines).toHaveLength(6);
    });
  });

  describe("senderDomain appears first", () => {
    it("first line is the senderDomain argument", () => {
      const classification: ClassificationOutput = {
        workflow: "auth",
        workflowData: { workflow: "auth", authType: "verification", service: "GitHub" },
        tags: [],
        summary: "GitHub verification code",
        labels: [],
        actions: [],
      };
      const result = buildEmbedText("github.com", classification);
      expect(result.split("\n")[0]).toBe("github.com");
    });
  });

  describe("labels line", () => {
    it("comma-joins labels with no spaces when populated", () => {
      const classification: ClassificationOutput = {
        workflow: "auth",
        workflowData: { workflow: "auth", authType: "verification", service: "Slack" },
        tags: [],
        summary: "Slack verification code",
        labels: ["action-needed", "system:workflow:auth"],
        actions: [],
      };
      const result = buildEmbedText("slack.com", classification);
      const lines = result.split("\n");
      // senderDomain, workflow, identity (Slack), summary, labels
      expect(lines[4]).toBe("action-needed,system:workflow:auth");
    });

    it("emits empty string for labels line when labels array is empty", () => {
      const classification: ClassificationOutput = {
        workflow: "package",
        workflowData: { workflow: "package", packageType: "shipping", retailer: "Amazon" },
        tags: [],
        summary: "Amazon package shipped",
        labels: [],
        actions: [],
      };
      const result = buildEmbedText("amazon.com", classification);
      const lines = result.split("\n");
      // senderDomain, workflow, identity (Amazon), summary, labels
      expect(lines[4]).toBe("");
    });
  });

  describe("identity fields", () => {
    it("includes only identity fields from workflowData repeated 3x", () => {
      const classification: ClassificationOutput = {
        workflow: "package",
        workflowData: { workflow: "package", packageType: "shipping", retailer: "Amazon", orderNumber: "111-222" },
        tags: [],
        summary: "Amazon package shipped",
        labels: [],
        actions: [],
      };
      const result = buildEmbedText("amazon.com", classification);
      const lines = result.split("\n");
      // retailer and orderNumber are identity; packageType is not
      expect(lines).toContain("Amazon 111-222 Amazon 111-222 Amazon 111-222");
      expect(result).not.toContain("shipping");
      expect(result).not.toContain("packageType");
    });

    it("excludes non-identity fields like expiresInMinutes", () => {
      const classification: ClassificationOutput = {
        workflow: "auth",
        workflowData: { workflow: "auth", authType: "verification", service: "Slack", expiresInMinutes: "10" },
        tags: [],
        summary: "Slack verification code expiring in 10 minutes",
        labels: [],
        actions: [],
      };
      const result = buildEmbedText("slack.com", classification);
      // service is identity — should appear; expiresInMinutes is not
      expect(result).toContain("Slack Slack Slack");
      expect(result).not.toContain("expiresInMinutes");
    });

    it("omits identity line entirely when workflow has no identity fields", () => {
      const classification: ClassificationOutput = {
        workflow: "conversation",
        workflowData: { workflow: "conversation", sentiment: "urgent", requiresReply: true },
        tags: [],
        summary: "Urgent message requiring reply",
        labels: [],
        actions: [],
      };
      const result = buildEmbedText("company.com", classification);
      const lines = result.split("\n");
      // No identity fields → senderDomain, workflow, summary, labels
      expect(lines[0]).toBe("company.com");
      expect(lines[1]).toBe("conversation");
      expect(lines[2]).toBe("Urgent message requiring reply");
      expect(lines[3]).toBe("");
      expect(lines).toHaveLength(4);
    });

    it("omits identity fields with null values", () => {
      const classification: ClassificationOutput = {
        workflow: "auth",
        workflowData: { workflow: "auth", authType: "verification", code: null as unknown as string, service: "GitHub" },
        tags: [],
        summary: "GitHub verification code",
        labels: [],
        actions: [],
      };
      const result = buildEmbedText("github.com", classification);
      const lines = result.split("\n");
      // service is identity (GitHub); code is NOT identity so irrelevant
      expect(lines).toContain("GitHub GitHub GitHub");
      expect(result).not.toContain("null");
    });
  });

  describe("tags excluded", () => {
    it("does not include tags in the output", () => {
      const classification: ClassificationOutput = {
        workflow: "content",
        workflowData: { workflow: "content", contentType: "newsletter", publisher: "TechCrunch" } as unknown as ClassificationOutput["workflowData"],
        tags: ["phishing"],
        summary: "TechCrunch daily newsletter",
        labels: ["newsletter"],
      actions: [],
      };
      const result = buildEmbedText("techcrunch.com", classification);
      expect(result).not.toContain("phishing");
      expect(result).not.toContain("tags");
    });
  });

  describe("determinism", () => {
    it("produces identical output for identical inputs", () => {
      const classification: ClassificationOutput = {
        workflow: "travel",
        workflowData: { workflow: "travel", travelType: "flight", carrier: "United", departureDate: "2025-03-15", flightNumber: "UA123" } as unknown as ClassificationOutput["workflowData"],
        tags: [],
        summary: "United flight UA123 on Mar 15",
        labels: ["travel"],
      actions: [],
      };
      const result1 = buildEmbedText("united.com", classification);
      const result2 = buildEmbedText("united.com", classification);
      expect(result1).toBe(result2);
    });
  });
});



import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { propertyRunner } from "../testing/property-runner.js";
import { buildEmbedText, reduceLink, type EmbedTextInput } from "./embed-text.js";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generates arbitrary non-empty strings without newlines (for header fields). */
const headerString = fc.string({ minLength: 1, maxLength: 100 }).filter((s) => !s.includes("\n"));

/**
 * Generates plain text that won't be altered by sanitization (no HTML, no URLs).
 * Uses a safe character set to avoid accidental HTML/URL patterns.
 */
const plainText = (opts: { minLength: number; maxLength: number }) =>
  fc.stringMatching(new RegExp(`^[a-zA-Z0-9 .,!?;:'"()\\-]{${opts.minLength},${opts.maxLength}}$`));

/** Generates arbitrary EmbedTextInput with optional fields randomly present/absent. */
const arbEmbedTextInput: fc.Arbitrary<EmbedTextInput> = fc
  .record({
    accountId: headerString,
    from: headerString,
    replyTo: headerString,
    returnPath: headerString,
    recipientAddress: headerString,
    subject: headerString,
    rawTextBody: fc.string({ minLength: 0, maxLength: 6000 }),
  }, { requiredKeys: ["accountId", "from", "recipientAddress", "subject", "rawTextBody"] }) as fc.Arbitrary<EmbedTextInput>;

// ---------------------------------------------------------------------------
// Property 1: Embed text is deterministic, bounded, and contains all input fields
// **Validates: Requirements 2.4, 2.5, 2.6, 2.7**
// ---------------------------------------------------------------------------

describe("Property 1: Embed text is deterministic, bounded, and contains all input fields", () => {
  it("buildEmbedText is pure — same input always produces same output", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbEmbedTextInput, async (input) => {
        const result1 = buildEmbedText(input);
        const result2 = buildEmbedText(input);
        return result1 === result2;
      }),
    );
  });

  it("body portion is at most 4000 characters", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbEmbedTextInput, async (input) => {
        const result = buildEmbedText(input);
        const lines = result.split("\n");

        // Count expected header lines
        let expectedHeaderCount = 4; // accountId, from, recipientAddress, subject
        if (input.replyTo) expectedHeaderCount++;
        if (input.returnPath) expectedHeaderCount++;

        // The body is everything after the header lines
        const bodyLine = lines.slice(expectedHeaderCount).join("\n");

        // The body should be at most 4000 characters
        return bodyLine.length <= 4000;
      }),
    );
  });

  it("when sanitized body > 4000, output follows first 3000 + last 1000 rule", async () => {
    // Generate inputs with long plain-text bodies guaranteed to exceed 4000 after sanitization.
    // Use a safe character set so sanitization only normalizes whitespace.
    const longBodyInput = fc.record({
      accountId: headerString,
      from: headerString,
      recipientAddress: headerString,
      subject: headerString,
      rawTextBody: plainText({ minLength: 4500, maxLength: 6000 }),
    }) as fc.Arbitrary<EmbedTextInput>;

    await propertyRunner.assert(
      fc.asyncProperty(longBodyInput, async (input) => {
        const result = buildEmbedText(input);
        const lines = result.split("\n");

        // 4 header lines (no replyTo/returnPath)
        const bodyLine = lines.slice(4).join("\n");

        // Replicate the sanitization logic for plain text (whitespace normalization only)
        const sanitized = input.rawTextBody.replace(/\s+/g, " ").trim();

        // If sanitization shrunk it to <= 4000, the body should be the full sanitized text
        if (sanitized.length <= 4000) {
          return bodyLine === sanitized;
        }

        // Otherwise body should be exactly 4000 chars following the 3000+1000 rule
        if (bodyLine.length !== 4000) return false;

        const expectedFirst3000 = sanitized.slice(0, 3000);
        const expectedLast1000 = sanitized.slice(-1000);

        return bodyLine.slice(0, 3000) === expectedFirst3000 && bodyLine.slice(-1000) === expectedLast1000;
      }),
    );
  });

  it("every present input field appears on its own line in the output", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbEmbedTextInput, async (input) => {
        const result = buildEmbedText(input);
        const lines = result.split("\n");

        // Required fields must always appear
        if (!lines.includes(input.accountId)) return false;
        if (!lines.includes(input.from)) return false;
        if (!lines.includes(input.recipientAddress)) return false;
        if (!lines.includes(input.subject)) return false;

        // Optional fields must appear when present
        if (input.replyTo && !lines.includes(input.replyTo)) return false;
        if (input.returnPath && !lines.includes(input.returnPath)) return false;

        return true;
      }),
    );
  });
});


// ---------------------------------------------------------------------------
// Property 2: Sanitization removes all structural HTML/CSS/image artifacts
// **Validates: Requirements 2.2**
// ---------------------------------------------------------------------------

describe("Property 2: Sanitization removes all structural HTML/CSS/image artifacts", () => {
  /**
   * Generator for HTML body content that includes structural artifacts:
   * - <style> blocks with CSS content
   * - HTML tags (div, span, p, a, etc.)
   * - <img> tags with src and alt attributes
   * - alt= attribute content
   */
  const arbHtmlBody: fc.Arbitrary<string> = fc.record({
    cssBlock: fc.string({ minLength: 0, maxLength: 200 }).map(
      (content) => `<style type="text/css">${content}</style>`
    ),
    imgTag: fc.record({
      src: fc.webUrl(),
      alt: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes('"')),
    }).map(({ src, alt }) => `<img src="${src}" alt="${alt}" />`),
    htmlContent: fc.string({ minLength: 1, maxLength: 200 }).map(
      (content) => `<div><p>${content}</p><span class="highlight">${content}</span></div>`
    ),
    plainContent: fc.string({ minLength: 1, maxLength: 200 }),
  }).map(({ cssBlock, imgTag, htmlContent, plainContent }) =>
    `${cssBlock}\n${htmlContent}\n${imgTag}\n${plainContent}`
  );

  /** Minimal valid EmbedTextInput with an HTML body. */
  const arbInputWithHtmlBody = (htmlBody: fc.Arbitrary<string>) =>
    fc.record({
      accountId: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes("\n")),
      from: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes("\n")),
      recipientAddress: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes("\n")),
      subject: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !s.includes("\n")),
      rawTextBody: htmlBody,
    }) as fc.Arbitrary<EmbedTextInput>;

  /**
   * Helper: extracts the body portion from buildEmbedText output.
   * The body is everything after the header lines (accountId, from, [replyTo], [returnPath], recipientAddress, subject).
   */
  function extractBody(input: EmbedTextInput): string {
    const result = buildEmbedText(input);
    const lines = result.split("\n");
    let headerCount = 4; // accountId, from, recipientAddress, subject
    if (input.replyTo) headerCount++;
    if (input.returnPath) headerCount++;
    return lines.slice(headerCount).join("\n");
  }

  it("output contains no <style> blocks", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbInputWithHtmlBody(arbHtmlBody), async (input) => {
        const body = extractBody(input);
        // No <style...>...</style> pattern should remain
        return !/<style[^>]*>[\s\S]*?<\/style>/i.test(body);
      }),
    );
  });

  it("output contains no HTML tags (no < followed by alpha character followed by >)", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbInputWithHtmlBody(arbHtmlBody), async (input) => {
        const body = extractBody(input);
        // No HTML tag pattern: < followed by alpha (or /) followed eventually by >
        return !/<\/?[a-zA-Z][^>]*>/i.test(body);
      }),
    );
  });

  it("output contains no <img> references", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbInputWithHtmlBody(arbHtmlBody), async (input) => {
        const body = extractBody(input);
        // No <img pattern at all
        return !/<img/i.test(body);
      }),
    );
  });

  it("output contains no alt= attribute content", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbInputWithHtmlBody(arbHtmlBody), async (input) => {
        const body = extractBody(input);
        // No alt= pattern (with or without quotes)
        return !/alt\s*=/i.test(body);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Links reduce to domain plus first path segment
// **Validates: Requirements 2.3**
// ---------------------------------------------------------------------------

describe("Property 3: Links reduce to domain plus first path segment", () => {
  /**
   * Generates arbitrary valid HTTP/HTTPS URLs with varying path depths,
   * query strings, and fragments.
   */
  // Exclude `.` and `..` which are normalized away by the URL parser
  const arbPathSegment = fc.stringMatching(/^[a-zA-Z0-9_~-]{1,20}$/).filter(s => s !== "." && s !== "..");

  const arbUrl = fc.record({
    scheme: fc.constantFrom("https://", "http://"),
    subdomain: fc.option(
      fc.stringMatching(/^[a-z]{2,8}$/).map(s => `${s}.`),
      { nil: "" },
    ),
    domain: fc.stringMatching(/^[a-z]{3,12}$/),
    tld: fc.constantFrom(".com", ".org", ".net", ".io", ".co.uk"),
    pathSegments: fc.array(arbPathSegment, { minLength: 0, maxLength: 5 }),
    queryString: fc.option(
      fc.array(
        fc.record({
          key: fc.stringMatching(/^[a-z]{1,8}$/),
          value: fc.stringMatching(/^[a-zA-Z0-9]{1,10}$/),
        }),
        { minLength: 1, maxLength: 3 },
      ).map(pairs => "?" + pairs.map(p => `${p.key}=${p.value}`).join("&")),
      { nil: "" },
    ),
    fragment: fc.option(
      fc.stringMatching(/^[a-z]{1,10}$/).map(f => `#${f}`),
      { nil: "" },
    ),
  }).map(({ scheme, subdomain, domain, tld, pathSegments, queryString, fragment }) => {
    const host = `${subdomain}${domain}${tld}`;
    const path = pathSegments.length > 0 ? "/" + pathSegments.join("/") : "";
    return {
      url: `${scheme}${host}${path}${queryString}${fragment}`,
      expectedHost: host,
      firstPathSegment: pathSegments[0] ?? null,
    };
  });

  it("reduceLink output contains no query string", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbUrl, async ({ url }) => {
        const result = reduceLink(url);
        return !result.includes("?");
      }),
    );
  });

  it("reduceLink output contains no fragment", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbUrl, async ({ url }) => {
        const result = reduceLink(url);
        return !result.includes("#");
      }),
    );
  });

  it("reduceLink output contains no path segments beyond the first", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbUrl, async ({ url, expectedHost, firstPathSegment }) => {
        const result = reduceLink(url);

        if (firstPathSegment === null) {
          // No path segments → result should be just the host
          return result === expectedHost;
        }

        // With path segments → result should be host/firstSegment only
        const expected = `${expectedHost}/${firstPathSegment}`;
        return result === expected;
      }),
    );
  });

  it("reduceLink output is exactly domain/firstPathSegment format", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbUrl, async ({ url, expectedHost, firstPathSegment }) => {
        const result = reduceLink(url);

        if (firstPathSegment === null) {
          return result === expectedHost;
        }
        return result === `${expectedHost}/${firstPathSegment}`;
      }),
    );
  });

  it("buildEmbedText with embedded URL produces output with no query/fragment/deep paths", async () => {
    await propertyRunner.assert(
      fc.asyncProperty(arbUrl, async ({ url, expectedHost, firstPathSegment }) => {
        const input: EmbedTextInput = {
          accountId: "acct-test",
          from: "sender@test.com",
          recipientAddress: "recipient@test.com",
          subject: "Test",
          rawTextBody: `Click here: ${url} for more info`,
        };

        const result = buildEmbedText(input);

        // The output should contain the reduced link
        if (firstPathSegment === null) {
          if (!result.includes(expectedHost)) return false;
        } else {
          if (!result.includes(`${expectedHost}/${firstPathSegment}`)) return false;
        }

        // The output should NOT contain the original URL scheme
        if (result.includes("https://") || result.includes("http://")) return false;

        // The output should NOT contain query strings or fragments from the URL
        if (url.includes("?")) {
          const queryPart = url.split("?")[1]?.split("#")[0];
          if (queryPart && result.includes(`?${queryPart}`)) return false;
        }
        if (url.includes("#")) {
          const fragPart = url.split("#")[1];
          if (fragPart && result.includes(`#${fragPart}`)) return false;
        }

        return true;
      }),
    );
  });
});

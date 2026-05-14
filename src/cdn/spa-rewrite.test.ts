import { describe, it, expect } from "vitest";
import fc from "fast-check";

// ---------------------------------------------------------------------------
// Extracted CloudFront Function logic (from deploy/cdn.tf)
// ${local.site_version} is replaced with the literal value "main/2026"
// ---------------------------------------------------------------------------

const MAIN_PREFIX = "/main/2026";

interface CfRequest {
  uri: string;
}

function handler(event: { request: CfRequest }): CfRequest {
  const request = event.request;
  const uri = request.uri;

  // Bare /pr with no trailing slash — pass through unchanged
  if (uri === "/pr") {
    return request;
  }

  // PR preview prefix — rewrite SPA routes to prefix-scoped index.html
  if (uri.startsWith("/pr/")) {
    const segments = uri.split("/");
    // segments: ['', 'pr', slug, ...rest]
    const slug = segments[2];

    if (!slug) {
      return request;
    }

    // Bare prefix: /pr/{slug} or /pr/{slug}/ — always rewrite regardless of dot in slug
    // segments for /pr/{slug} = ['', 'pr', slug] (length 3)
    // segments for /pr/{slug}/ = ['', 'pr', slug, ''] (length 4, last is empty)
    if (segments.length === 3 || (segments.length === 4 && segments[3] === "")) {
      request.uri = "/pr/" + slug + "/index.html";
      return request;
    }

    const lastSegment = segments[segments.length - 1];
    if (lastSegment.includes(".")) {
      return request;
    }

    request.uri = "/pr/" + slug + "/index.html";
    return request;
  }

  // Root-level requests: prepend site_version prefix
  const lastSeg = uri.substring(uri.lastIndexOf("/") + 1);
  if (!lastSeg.includes(".")) {
    request.uri = MAIN_PREFIX + "/index.html";
  } else {
    request.uri = MAIN_PREFIX + uri;
  }

  return request;
}

/** Helper: run the handler with a given URI and return the rewritten URI */
function rewrite(uri: string): string {
  return handler({ request: { uri } }).uri;
}

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe("CloudFront SPA rewrite function", () => {
  describe("Property 1: PR prefix deep-link routing", () => {
    /** Validates: Requirements 1.1, 1.3 */

    const slugArb = fc.stringMatching(/^[a-z0-9-]{1,63}$/);
    const routeSegmentArb = fc.stringMatching(/^[a-z0-9-]+$/);

    it("rewrites PR deep links without dot to /pr/{slug}/index.html", () => {
      fc.assert(
        fc.property(
          slugArb,
          fc.array(routeSegmentArb, { minLength: 1, maxLength: 5 }),
          (slug, segments) => {
            const uri = `/pr/${slug}/${segments.join("/")}`;
            expect(rewrite(uri)).toBe(`/pr/${slug}/index.html`);
          }
        ),
        { numRuns: 200 }
      );
    });

    it("passes through PR static files (dot in final segment) unchanged", () => {
      const fileNameArb = fc.stringMatching(/^[a-z0-9-]+\.[a-z]{2,4}$/);

      fc.assert(
        fc.property(
          slugArb,
          fc.array(routeSegmentArb, { minLength: 0, maxLength: 4 }),
          fileNameArb,
          (slug, middleSegments, fileName) => {
            const pathParts = [slug, ...middleSegments, fileName];
            const uri = `/pr/${pathParts.join("/")}`;
            expect(rewrite(uri)).toBe(uri);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  describe("Property 2: Root-level SPA routing", () => {
    /** Validates: Requirements 2.1, 2.2 */

    const pathSegment = fc.stringMatching(/^[a-z0-9-]{1,20}$/);

    const nonPrFirstSegment = pathSegment.filter((s) => s !== "pr");

    it("rewrites root SPA routes to /main/2026/index.html", () => {
      fc.assert(
        fc.property(
          nonPrFirstSegment,
          fc.array(pathSegment, { minLength: 0, maxLength: 4 }),
          (first, rest) => {
            const uri = "/" + [first, ...rest].join("/");
            expect(rewrite(uri)).toBe("/main/2026/index.html");
          },
        ),
        { numRuns: 100 },
      );
    });

    it("prepends /main/2026 to root static file URIs", () => {
      const fileExtension = fc.constantFrom(
        ".js",
        ".css",
        ".html",
        ".ico",
        ".json",
        ".txt",
        ".svg",
        ".woff2",
      );
      const fileName = fc
        .tuple(pathSegment, fileExtension)
        .map(([name, ext]) => name + ext);

      fc.assert(
        fc.property(
          nonPrFirstSegment,
          fc.array(pathSegment, { minLength: 0, maxLength: 3 }),
          fileName,
          (first, middle, file) => {
            const uri = "/" + [first, ...middle, file].join("/");
            expect(rewrite(uri)).toBe("/main/2026" + uri);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe("Property 3: Bare prefix rewrite regardless of slug content", () => {
    /** Validates: Requirements 1.2, 3.1 */

    const slugWithDotsArb = fc.stringMatching(/^[a-z0-9.-]{1,63}$/);

    it("rewrites /pr/{slug} (no trailing slash) to /pr/{slug}/index.html", () => {
      fc.assert(
        fc.property(slugWithDotsArb, (slug) => {
          const uri = `/pr/${slug}`;
          expect(rewrite(uri)).toBe(`/pr/${slug}/index.html`);
        }),
        { numRuns: 200 },
      );
    });

    it("rewrites /pr/{slug}/ (trailing slash) to /pr/{slug}/index.html", () => {
      fc.assert(
        fc.property(slugWithDotsArb, (slug) => {
          const uri = `/pr/${slug}/`;
          expect(rewrite(uri)).toBe(`/pr/${slug}/index.html`);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe("Edge cases", () => {
    /** Validates: Requirements 1.4, 3.2 */

    it("passes /pr/ through unchanged", () => {
      expect(rewrite("/pr/")).toBe("/pr/");
    });

    it("passes /pr through unchanged", () => {
      expect(rewrite("/pr")).toBe("/pr");
    });

    // Static test cases from design document — PR preview deep links
    it("rewrites /pr/my-branch/dashboard to /pr/my-branch/index.html", () => {
      expect(rewrite("/pr/my-branch/dashboard")).toBe("/pr/my-branch/index.html");
    });

    it("rewrites /pr/my-branch/settings/domains to /pr/my-branch/index.html", () => {
      expect(rewrite("/pr/my-branch/settings/domains")).toBe("/pr/my-branch/index.html");
    });

    // Static test cases — PR preview static files (pass through)
    it("passes /pr/my-branch/assets/index-abc123.js through unchanged", () => {
      expect(rewrite("/pr/my-branch/assets/index-abc123.js")).toBe("/pr/my-branch/assets/index-abc123.js");
    });

    it("passes /pr/my-branch/favicon.ico through unchanged", () => {
      expect(rewrite("/pr/my-branch/favicon.ico")).toBe("/pr/my-branch/favicon.ico");
    });

    // Static test cases — Root-level SPA routes
    it("rewrites / to /main/2026/index.html", () => {
      expect(rewrite("/")).toBe("/main/2026/index.html");
    });

    it("rewrites /dashboard to /main/2026/index.html", () => {
      expect(rewrite("/dashboard")).toBe("/main/2026/index.html");
    });

    // Static test cases — Root-level static files
    it("rewrites /favicon.ico to /main/2026/favicon.ico", () => {
      expect(rewrite("/favicon.ico")).toBe("/main/2026/favicon.ico");
    });

    it("rewrites /robots.txt to /main/2026/robots.txt", () => {
      expect(rewrite("/robots.txt")).toBe("/main/2026/robots.txt");
    });
  });
});

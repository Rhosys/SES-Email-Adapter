import { describe, it, expect } from "vitest";

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

    const lastSegment = segments[segments.length - 1]!;
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
// Tests
// ---------------------------------------------------------------------------

describe("CloudFront SPA rewrite function", () => {
  describe("PR prefix deep-link routing", () => {
    const deepLinkCases = [
      { scenario: "single route segment", uri: "/pr/my-branch/dashboard", expected: "/pr/my-branch/index.html" },
      { scenario: "nested route segments", uri: "/pr/my-branch/settings/domains", expected: "/pr/my-branch/index.html" },
      { scenario: "deeply nested route", uri: "/pr/feat-123/accounts/abc/rules/new", expected: "/pr/feat-123/index.html" },
    ];

    it.each(deepLinkCases)("rewrites PR deep link: $scenario", ({ uri, expected }) => {
      expect(rewrite(uri)).toBe(expected);
    });

    const staticFileCases = [
      { scenario: "JS asset in nested dir", uri: "/pr/my-branch/assets/index-abc123.js", expected: "/pr/my-branch/assets/index-abc123.js" },
      { scenario: "favicon at slug root", uri: "/pr/my-branch/favicon.ico", expected: "/pr/my-branch/favicon.ico" },
      { scenario: "CSS file", uri: "/pr/feat-99/styles/app.css", expected: "/pr/feat-99/styles/app.css" },
      { scenario: "woff2 font", uri: "/pr/fix-typo/fonts/inter.woff2", expected: "/pr/fix-typo/fonts/inter.woff2" },
    ];

    it.each(staticFileCases)("passes through PR static file: $scenario", ({ uri, expected }) => {
      expect(rewrite(uri)).toBe(expected);
    });
  });

  describe("Root-level SPA routing", () => {
    const spaRouteCases = [
      { scenario: "bare root", uri: "/", expected: "/main/2026/index.html" },
      { scenario: "single segment route", uri: "/dashboard", expected: "/main/2026/index.html" },
      { scenario: "nested route", uri: "/settings/domains", expected: "/main/2026/index.html" },
      { scenario: "deeply nested route", uri: "/accounts/abc/rules/new", expected: "/main/2026/index.html" },
    ];

    it.each(spaRouteCases)("rewrites root SPA route: $scenario", ({ uri, expected }) => {
      expect(rewrite(uri)).toBe(expected);
    });

    const rootStaticCases = [
      { scenario: "favicon.ico", uri: "/favicon.ico", expected: "/main/2026/favicon.ico" },
      { scenario: "robots.txt", uri: "/robots.txt", expected: "/main/2026/robots.txt" },
      { scenario: "JS bundle in assets/", uri: "/assets/index-abc123.js", expected: "/main/2026/assets/index-abc123.js" },
      { scenario: "CSS file", uri: "/assets/style.css", expected: "/main/2026/assets/style.css" },
      { scenario: "SVG icon", uri: "/icons/logo.svg", expected: "/main/2026/icons/logo.svg" },
    ];

    it.each(rootStaticCases)("prepends /main/2026 to root static file: $scenario", ({ uri, expected }) => {
      expect(rewrite(uri)).toBe(expected);
    });
  });

  describe("Bare prefix rewrite regardless of slug content", () => {
    const barePrefixCases = [
      { scenario: "simple slug, no trailing slash", uri: "/pr/my-branch", expected: "/pr/my-branch/index.html" },
      { scenario: "simple slug, trailing slash", uri: "/pr/my-branch/", expected: "/pr/my-branch/index.html" },
      { scenario: "slug with dots (looks like a file but is a slug)", uri: "/pr/v1.2.3", expected: "/pr/v1.2.3/index.html" },
      { scenario: "slug with dots, trailing slash", uri: "/pr/v1.2.3/", expected: "/pr/v1.2.3/index.html" },
      { scenario: "slug with hyphens and numbers", uri: "/pr/feat-123-fix", expected: "/pr/feat-123-fix/index.html" },
    ];

    it.each(barePrefixCases)("$scenario", ({ uri, expected }) => {
      expect(rewrite(uri)).toBe(expected);
    });
  });

  describe("Edge cases", () => {
    it("passes /pr/ through unchanged (empty slug)", () => {
      expect(rewrite("/pr/")).toBe("/pr/");
    });

    it("passes /pr through unchanged (bare prefix, no slash)", () => {
      expect(rewrite("/pr")).toBe("/pr");
    });
  });
});

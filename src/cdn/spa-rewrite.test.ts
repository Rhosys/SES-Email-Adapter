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

  // PR preview prefix — rewrite SPA routes to prefix-scoped index.html
  if (uri.startsWith("/pr/")) {
    const segments = uri.split("/");
    // segments: ['', 'pr', slug, ...rest]
    const slug = segments[2];

    if (!slug) {
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
    it.todo("rewrites PR deep links without dot to /pr/{slug}/index.html");
    it.todo("passes through PR static files (dot in final segment) unchanged");
  });

  describe("Property 2: Root-level SPA routing", () => {
    it.todo("rewrites root SPA routes to /main/2026/index.html");
    it.todo("prepends /main/2026 to root static file URIs");
  });

  describe("Property 3: Bare prefix rewrite regardless of slug content", () => {
    it.todo("rewrites /pr/{slug} and /pr/{slug}/ to /pr/{slug}/index.html");
  });

  describe("Edge cases", () => {
    it.todo("passes /pr/ and /pr through unchanged");
  });
});

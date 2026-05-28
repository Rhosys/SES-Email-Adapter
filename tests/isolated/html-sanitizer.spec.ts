import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "../../src/isolated/html-sanitizer.js";

describe("html-sanitizer", () => {
  describe("script removal", () => {
    it("strips inline script elements", () => {
      const input = `<div>Hello</div><script>alert('xss')</script><p>World</p>`;
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain("<script");
      expect(result.html).not.toContain("alert");
      expect(result.html).toContain("Hello");
      expect(result.html).toContain("World");
    });

    it("strips script elements with src attribute", () => {
      const input = `<p>Safe</p><script src="https://evil.com/xss.js"></script>`;
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain("<script");
      expect(result.html).not.toContain("evil.com");
      expect(result.html).toContain("Safe");
    });
  });

  describe("event handler removal", () => {
    it("strips onclick handler", () => {
      const input = `<div onclick="alert('xss')">Click me</div>`;
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain("onclick");
      expect(result.html).not.toContain("alert");
      expect(result.html).toContain("Click me");
    });

    it("strips onerror handler on img", () => {
      const input = `<img src="https://example.com/img.png" onerror="alert('xss')">`;
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain("onerror");
      expect(result.html).not.toContain("alert");
    });

    it("strips onload handler", () => {
      const input = `<body onload="stealCookies()"><p>Content</p></body>`;
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain("onload");
      expect(result.html).not.toContain("stealCookies");
      expect(result.html).toContain("Content");
    });

    it("strips onmouseover handler", () => {
      const input = `<a onmouseover="track()">Link</a>`;
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain("onmouseover");
      expect(result.html).toContain("Link");
    });
  });

  describe("CSS url() removal", () => {
    it("removes external HTTP url() from inline styles", () => {
      const input = `<div style="background: url('https://tracker.com/pixel.gif') no-repeat;">Content</div>`;
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain("tracker.com");
      expect(result.html).toContain("Content");
    });

    it("removes external HTTPS url() from inline styles", () => {
      const input = `<td style="background-image: url(https://evil.com/bg.png);">Cell</td>`;
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain("evil.com");
      expect(result.html).toContain("Cell");
    });

    it("removes external url() from style elements", () => {
      const input = `<style>.header { background: url('https://tracker.com/track.gif'); }</style><div class="header">Hi</div>`;
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain("tracker.com");
      expect(result.html).toContain("Hi");
    });
  });

  describe("hidden text removal", () => {
    it("removes elements with display:none", () => {
      const input = `<p>Visible</p><span style="display:none">Hidden tracking text</span>`;
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain("Hidden tracking text");
      expect(result.html).toContain("Visible");
    });

    it("removes elements with visibility:hidden", () => {
      const input = `<p>Visible</p><div style="visibility:hidden">Invisible</div>`;
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain("Invisible");
      expect(result.html).toContain("Visible");
    });

    it("removes elements with opacity:0", () => {
      const input = `<p>Visible</p><span style="opacity:0">Transparent text</span>`;
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain("Transparent text");
      expect(result.html).toContain("Visible");
    });

    it("removes elements with font-size:0", () => {
      const input = `<p>Visible</p><span style="font-size:0">Zero size text</span>`;
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain("Zero size text");
      expect(result.html).toContain("Visible");
    });

    it("removes zero-height overflow-hidden elements", () => {
      const input = `<p>Visible</p><div style="height:0;overflow:hidden">Collapsed</div>`;
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain("Collapsed");
      expect(result.html).toContain("Visible");
    });
  });

  describe("form removal", () => {
    it("strips form elements", () => {
      const input = `<form action="https://evil.com/steal"><input type="text"><button>Submit</button></form><p>Safe</p>`;
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain("<form");
      expect(result.html).not.toContain("evil.com");
      expect(result.html).toContain("Safe");
    });
  });
});

import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "../../src/isolated/html-sanitizer.js";
import { simpleParser } from "mailparser";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

    it("removes leaf elements with font-size:0", () => {
      const input = `<p>Visible</p><span style="font-size:0">Zero size text</span>`;
      const result = sanitizeHtml(input);
      expect(result.html).not.toContain("Zero size text");
      expect(result.html).toContain("Visible");
    });

    it("preserves font-size:0 container elements with children (MJML pattern)", () => {
      const input = `<td style="direction:ltr;font-size:0px;padding:20px 0;text-align:center;"><div class="mj-column-per-100" style="font-size:0px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;"><table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%"><tbody><tr><td style="vertical-align:top;padding-bottom:32px;"><p>Saved search content</p></td></tr></tbody></table></div></td>`;
      const result = sanitizeHtml(input);
      expect(result.html).toContain("Saved search content");
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

  describe("MJML email end-to-end (mailparser → sanitizeHtml)", () => {
    it("preserves Engel & Völkers property listing content through full pipeline", async () => {
      const fixturePath = resolve(import.meta.dirname, "fixtures/engel-voelkers-mjml.eml");
      const raw = readFileSync(fixturePath);
      const parsed = await simpleParser(raw);

      const htmlInput = typeof parsed.html === "string" ? parsed.html : "";
      const result = sanitizeHtml(htmlInput);

      // Primary content — property listing
      expect(result.html).toContain("Saved search");
      expect(result.html).toContain("New property");
      expect(result.html).toContain("Buy a home in Winterthur, Zurich");
      expect(result.html).toContain("Zell, Zurich, Switzerland");
      expect(result.html).toContain("Charming single-family home in a quiet, natural setting");
      expect(result.html).toContain("1,302,558 €");
      expect(result.html).toContain("4 rooms");
      expect(result.html).toContain("See details");
      expect(result.html).toContain("View all matching properties");

      // Secondary content — CTA and footer
      expect(result.html).toContain("Did not find the perfect properties?");
      expect(result.html).toContain("Manage saved searches");
      expect(result.html).toContain("Engel &amp; Völkers GmbH");
      expect(result.html).toContain("Imprint");
      expect(result.html).toContain("Privacy policy");
      expect(result.html).toContain("Unsubscribe");

      // Security — scripts and event handlers absent
      expect(result.html).not.toContain("<script");
      expect(result.html).not.toContain("onclick");
      expect(result.html).not.toContain("onerror");
    });
  });
});

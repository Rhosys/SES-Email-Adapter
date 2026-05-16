import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "./html-sanitizer.js";

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

  describe("external image extraction", () => {
    it("extracts HTTP image URLs", () => {
      const input = `<img src="http://example.com/image.png"><p>Text</p>`;
      const result = sanitizeHtml(input);
      expect(result.externalImageUrls).toEqual(["http://example.com/image.png"]);
    });

    it("extracts HTTPS image URLs", () => {
      const input = `<img src="https://cdn.example.com/photo.jpg">`;
      const result = sanitizeHtml(input);
      expect(result.externalImageUrls).toEqual(["https://cdn.example.com/photo.jpg"]);
    });

    it("extracts multiple external image URLs", () => {
      const input = `
        <img src="https://a.com/1.png">
        <img src="https://b.com/2.jpg">
        <img src="https://c.com/3.gif">
      `;
      const result = sanitizeHtml(input);
      expect(result.externalImageUrls).toEqual([
        "https://a.com/1.png",
        "https://b.com/2.jpg",
        "https://c.com/3.gif",
      ]);
    });

    it("excludes data: URIs from external image list", () => {
      const input = `<img src="data:image/png;base64,iVBORw0KGgo="><img src="https://real.com/img.png">`;
      const result = sanitizeHtml(input);
      expect(result.externalImageUrls).toEqual(["https://real.com/img.png"]);
    });

    it("excludes cid: references from external image list", () => {
      const input = `<img src="cid:image001@example.com"><img src="https://real.com/img.png">`;
      const result = sanitizeHtml(input);
      expect(result.externalImageUrls).toEqual(["https://real.com/img.png"]);
    });
  });

  describe("cid extraction", () => {
    it("extracts cid references from img src", () => {
      const input = `<img src="cid:image001@01D1234.ABCDEF">`;
      const result = sanitizeHtml(input);
      expect(result.cidReferences).toEqual(["image001@01D1234.ABCDEF"]);
    });

    it("extracts multiple cid references", () => {
      const input = `
        <img src="cid:logo@company.com">
        <img src="cid:banner@company.com">
      `;
      const result = sanitizeHtml(input);
      expect(result.cidReferences).toEqual(["logo@company.com", "banner@company.com"]);
    });

    it("does not include cid references in external image list", () => {
      const input = `<img src="cid:inline-image@msg">`;
      const result = sanitizeHtml(input);
      expect(result.externalImageUrls).toEqual([]);
      expect(result.cidReferences).toEqual(["inline-image@msg"]);
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

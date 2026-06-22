import { Window } from "happy-dom";
import DOMPurify from "dompurify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SanitizeResult {
  html: string;
}

// ---------------------------------------------------------------------------
// DOMPurify configuration
// ---------------------------------------------------------------------------

const FORBIDDEN_TAGS = ["script", "form", "object", "embed", "applet", "iframe"];
const FORBIDDEN_ATTRS = [
  "onerror", "onload", "onclick", "onmouseover", "onmouseout", "onmouseenter",
  "onmouseleave", "onfocus", "onblur", "onsubmit", "onreset", "onchange",
  "oninput", "onkeydown", "onkeyup", "onkeypress", "ondblclick", "oncontextmenu",
  "ondrag", "ondragend", "ondragenter", "ondragleave", "ondragover", "ondragstart",
  "ondrop", "onscroll", "onwheel", "oncopy", "oncut", "onpaste", "onanimationend",
  "onanimationiteration", "onanimationstart", "ontransitionend", "onpointerdown",
  "onpointerup", "onpointermove",
];

// ---------------------------------------------------------------------------
// CSS url() removal
// ---------------------------------------------------------------------------

/**
 * Removes CSS `url()` declarations that reference external HTTP(S) resources.
 * Preserves data: URIs and relative paths.
 */
function stripExternalCssUrls(css: string): string {
  return css.replace(/url\(\s*['"]?(https?:\/\/[^'")]+)['"]?\s*\)/gi, "url()");
}

// ---------------------------------------------------------------------------
// Hidden element removal
// ---------------------------------------------------------------------------

/**
 * Removes elements that are visually hidden via inline styles.
 * Targets: display:none, visibility:hidden, opacity:0, font-size:0 (leaf only), height:0/width:0
 *
 * font-size:0 is only treated as hidden when the element has no child elements.
 * MJML-based emails use font-size:0 on container elements (td, div) to prevent
 * inline-block gaps — children override with their own font-size. Removing
 * containers destroys legitimate content.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function removeHiddenElements(doc: any): void {
  const allElements = doc.querySelectorAll("[style]");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const el of allElements as Iterable<any>) {
    const style: string = el.getAttribute("style") ?? "";
    const lower = style.toLowerCase().replace(/\s/g, "");
    if (
      lower.includes("display:none") ||
      lower.includes("visibility:hidden") ||
      lower.includes("opacity:0") ||
      (lower.includes("font-size:0") && el.children.length === 0) ||
      (lower.includes("height:0") && lower.includes("overflow:hidden")) ||
      (lower.includes("width:0") && lower.includes("overflow:hidden"))
    ) {
      el.remove();
    }
  }
}

// ---------------------------------------------------------------------------
// Main sanitize function
// ---------------------------------------------------------------------------

export function sanitizeHtml(rawHtml: string): SanitizeResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const window = new Window() as any;
  const purify = DOMPurify(window);

  // Configure DOMPurify to strip dangerous elements
  const clean = purify.sanitize(rawHtml, {
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTRS,
    ALLOW_DATA_ATTR: false,
    WHOLE_DOCUMENT: false,
  });

  // Parse the sanitized HTML into a document for post-processing
  const doc = new Window({ url: "about:blank" }).document;
  doc.body.innerHTML = clean;

  // Remove hidden elements
  removeHiddenElements(doc);

  // Strip external CSS url() references from style attributes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const el of doc.querySelectorAll("[style]") as Iterable<any>) {
    const style: string = el.getAttribute("style") ?? "";
    if (/url\(/i.test(style)) {
      el.setAttribute("style", stripExternalCssUrls(style));
    }
  }

  // Strip external CSS url() references from <style> elements
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const styleEl of doc.querySelectorAll("style") as Iterable<any>) {
    if (styleEl.textContent && /url\(/i.test(styleEl.textContent)) {
      styleEl.textContent = stripExternalCssUrls(styleEl.textContent);
    }
  }

  const html: string = doc.body.innerHTML;

  return { html };
}

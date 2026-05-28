import { JSDOM } from "jsdom";
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
 * Targets: display:none, visibility:hidden, opacity:0, font-size:0, height:0/width:0
 */
function removeHiddenElements(doc: Document): void {
  const allElements = doc.querySelectorAll("[style]");
  for (const el of allElements) {
    const style = (el as HTMLElement).getAttribute("style") ?? "";
    const lower = style.toLowerCase().replace(/\s/g, "");
    if (
      lower.includes("display:none") ||
      lower.includes("visibility:hidden") ||
      lower.includes("opacity:0") ||
      lower.includes("font-size:0") ||
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
  const window = new JSDOM("").window;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const purify = DOMPurify(window as any);

  // Configure DOMPurify to strip dangerous elements
  const clean = purify.sanitize(rawHtml, {
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTRS,
    ALLOW_DATA_ATTR: false,
    WHOLE_DOCUMENT: false,
  });

  // Parse the sanitized HTML for further processing
  const dom = new JSDOM(clean);
  const doc = dom.window.document;

  // Remove hidden elements
  removeHiddenElements(doc);

  // Strip external CSS url() references from style attributes
  const styledElements = doc.querySelectorAll("[style]");
  for (const el of styledElements) {
    const style = (el as HTMLElement).getAttribute("style") ?? "";
    if (/url\(/i.test(style)) {
      (el as HTMLElement).setAttribute("style", stripExternalCssUrls(style));
    }
  }

  // Strip external CSS url() references from <style> elements
  const styleElements = doc.querySelectorAll("style");
  for (const styleEl of styleElements) {
    if (styleEl.textContent && /url\(/i.test(styleEl.textContent)) {
      styleEl.textContent = stripExternalCssUrls(styleEl.textContent);
    }
  }

  const html = doc.body.innerHTML;

  return { html };
}

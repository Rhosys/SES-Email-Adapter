// ---------------------------------------------------------------------------
// Markdown → HTML for outbound mail
//
// Every composer that authors an outbound body — the reply/compose box
// (DraftSignalCard.vue) and rule auto-reply templates (TemplatesView.vue) — is a plain
// <textarea> of Markdown; the UI's live preview runs it through `marked` client-side but
// only ever persists the raw Markdown as textBody. This is the server-side equivalent of
// that same preview, run once at send time so recipients get a rendered text/html part
// instead of literal "**bold**" asterisks. Same library, default options, no custom
// breaks/gfm config — deliberately matching what the user saw while composing.
//
// Generation only — the Markdown source is the account's own authenticated content (a
// draft/reply/template body they wrote), not untrusted third-party email content, so this
// stays outside the isolated content-sanitizer boundary (see
// docs/adr/011-content-sanitizer-security-boundary.md).
// ---------------------------------------------------------------------------

import { marked } from "marked";

/** Renders a Markdown body to HTML for the email's text/html part. */
export function renderMarkdownToHtml(markdown: string): string {
  return marked.parse(markdown, { async: false }) as string;
}

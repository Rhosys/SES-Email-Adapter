# ADR 007: Email Image Handling — Direct Loading with Tracker Stripping

## Status

Accepted

## Context

HTML email bodies contain `<img>` tags pointing to external servers. When the user's browser renders the email, it fetches those URLs. This creates two categories of images:

1. **Content images** — logos, product photos, newsletter graphics. The user wants to see these.
2. **Tracking pixels** — invisible 1×1 images whose sole purpose is to notify the sender that the email was opened, when, from what IP, and on what device.

The product needs emails to render perfectly (no broken images, no loading delays, no user action required). At the same time, tracking pixels should not fire — they exist to surveil the user, not to display content.

## Decision

**Direct loading for content images. Strip tracking pixels at ingestion time.**

When a signal is processed, the HTML body is sanitised before storage:
- Tracking pixels are identified by structural heuristics and removed from the DOM
- A `trackersBlocked` count is stored on the signal
- The sanitised HTML is what the frontend renders

Content images remain as-is. The user's browser loads them directly from the sender's server when viewing the email.

### Tracker detection heuristics

An `<img>` element is classified as a tracker if ANY of the following are true:

- `width` and `height` attributes are both ≤ 3 (e.g. `width="1" height="1"`)
- Inline style contains `display:none` or `visibility:hidden`
- URL path contains known tracker segments: `/open`, `/track`, `/pixel`, `/beacon`, `/wf/open`, `/t.gif`, `/o.gif`
- Element has no `alt` attribute AND computed dimensions ≤ 3×3

These heuristics catch the vast majority of email tracking pixels without requiring an external blocklist. An optional enhancement is to ship a snapshot of EasyPrivacy filter rules for domain-level matching.

### What the sender learns

| Data point | Before (no stripping) | After (with stripping) |
|---|---|---|
| User opened the email | Yes (tracker pixel fires) | No (pixel removed) |
| When they opened | Yes | No |
| How many times re-opened | Yes | No |
| User's IP address | Yes (via all image requests) | Only via content images the user actually sees |
| Device/OS | Yes | Only via content images |
| Email was delivered | Yes (SES confirms) | Yes (SES confirms — unchanged) |

### What the user experiences

Emails render instantly and completely. Logos, product images, and newsletter graphics all display. No "load images" button. No broken placeholders. No delay.

A badge on the signal card shows "N trackers blocked" — builds trust and differentiates from competitors.

## Consequences

- **Ingestion pipeline gains an HTML sanitisation step** — parse HTML, identify tracker images, remove them, store sanitised version. Adds ~10-50ms per signal.
- **False positives are possible** — a legitimate 1×1 spacer image used for layout could be stripped. In practice this is rare in modern email HTML (CSS handles spacing). If it becomes an issue, tighten heuristics.
- **Content images still make network requests to sender servers** — the sender can infer the email was viewed if they monitor access logs for content image URLs. This is an accepted tradeoff for perfect rendering UX.
- **No infrastructure cost** — no image storage, no CDN, no proxy service. The browser does the work.
- **EasyPrivacy list is optional** — heuristic detection works standalone. The list improves coverage but isn't required for v1.

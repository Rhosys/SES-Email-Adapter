# TODO

> Items are ordered by priority — #1 is next to do. Items covered by active specs (`.kiro/specs/`) are not listed here.

- [ ] **Move `updateGlobalReputation` into side-effects and make its save idempotent** — currently called inline in `processMessage` (multiple branches) and re-runs on every retry/reprocess, double-counting sender reputation. Move the reputation write into `processSideEffect` (derived from the persisted signal outcome) and make the save idempotent so retries can't inflate the counters.
- [ ] **Document all data stores exhaustively** — write ADR-style docs (like `docs/adr-stats-metrics.md`) for every data store: DynamoDB accounts table (partition key design, GSI patterns, single-table item types, TTL strategies), DynamoDB arcs table (arc/signal item layout, GSI2 threading index, grouping key lookups), Aurora Serverless (schema, RLS via `SET LOCAL`, pgvector embeddings, connection pooling via Data API), S3 buckets (email storage lifecycle, content extraction prefix layout, retention tagging, presigned URL patterns), and the processing DynamoDB table (global reputation tracking, sender fingerprints). For each: document the access patterns, key design decisions, known limitations, and cost profile.
- [ ] **Investigate: arc missing `retentionDuration`** — check if `resolveRetention()` was called during processing.
- [ ] **Outbound recipient validation (malicious user)** — prevent a malicious account owner from using the platform to spam arbitrary addresses. When a user composes/sends an email, validate that all To/CC/BCC recipient domains are either: (a) in the alias's approved senders list, or (b) domains the user has previously received email from (existing arc with that sender domain). If not, require explicit confirmation and rate-limit outbound to new domains.
- [ ] **Email forwarding loop detection and prevention** — forwarding rules can create infinite loops: if account A forwards to address X, and address X routes back into the same account (or another account that forwards back), signals will cycle forever. Two layers of protection needed: (1) **Setup-time**: when a user creates or edits a forwarding rule, check whether the rule's target address matches any domain registered to the same account — if it does, reject the rule with a clear error ("Forwarding to your own domain would create a loop"). Also check whether any existing rule already forwards *to* that same target from any label/alias that the new rule would also match. (2) **Runtime**: detect loops in-flight by inspecting the `References` / `X-Forwarded-To` / custom `X-SES-Loop` headers on inbound signals — if the message has already passed through this account or has been forwarded more than N times (e.g. 5), drop it with a non-retryable error and emit a `loop_detected` audit event.
- [ ] **Move grouping key to a DynamoDB GSI** — `fastFindArcByAlternativeLookupKey` currently does a Query on a separate `GKEY#` item. Convert this to a GSI on the arc item itself so the lookup is a direct GSI query rather than a separate pointer item that must be kept in sync. Eliminates the dual-write and the orphan cleanup problem when arcs are deleted.
- [ ] **Background domain verification via Step Functions** — when a user adds a new domain, kick off a Step Functions state machine that polls DNS records (MX, DKIM, SPF, DMARC) on a schedule (e.g. every 30s for 5 min, then every 5 min for 1 hour, then hourly for 72 hours). Transitions domain status through `pending` → `verifying` → `verified` (or `failed` after timeout). Eliminates the need for the user to manually click "re-check" and provides real-time progress via WebSocket push. The state machine should also handle re-verification when domain config changes.
- [ ] **Consider what happens when someone already has configured an alias** — do aliases need to be globally unique? Yes. Check on the backend using MX lookup (MX records are the source of truth).
- [ ] **Review when `TemplateFunction.lastError` is cleared** — need to define when it gets cleared: on next successful execution? On template save?
- [ ] **Audit OpenAPI spec for missing zod constraints** — investigate why `@hono/zod-openapi` isn't propagating `.min()/.max()` to the generated spec.
- [ ] **Define audit event response schema** — the `GET /accounts/:id/audit` endpoint returns `z.object({})` in the OpenAPI spec. Add a proper zod schema matching the response shape.
- [ ] **Promotions: extract expiry date and auto-archive when the offer lapses** — classifier extracts `workflowData.offerExpiry` (ISO-8601). Auto-archive only if purely promotional. If mixed content, set `offerExpiry` but do not auto-archive.
- [ ] **Auto-archive arcs on signal expiry (generic)** — any signal with a time-limited value (auth OTP `expiresInMinutes`, promo `offerExpiry`, password reset link) should auto-archive the arc when the expiry lapses, BUT only if the arc was not already active before this signal arrived. Logic: if the arc was archived/non-existent before the signal elevated or created it, auto-archive at expiry. If the arc was already active (user was interacting with it), do nothing — the user is engaged and manual control takes precedence. Applies to: `auth` (OTP/magic-link), `content` (promo codes with `expiryDate`), `payments` (time-limited offers). Computed from `signal.receivedAt + expiresInMinutes` or `expiryDate` directly. Scheduler or DynamoDB TTL-triggered cleanup.
- [ ] **Retry Send for failed outbound messages** — UI must expose a "Retry Send" action on `domain_misconfiguration` or `send_failed` signals. Transient failures auto-retry via SES Feedback SQS loop; permanent failures require user action.
- [ ] **AI-powered template auto-response** — extend templates with an optional `aiPrompt` field. When a signal matches a rule with `action: "auto_reply"` and the template has `aiPrompt` set, Bedrock generates a reply using the prompt as system instructions, the template body as structure/tone guide, and the inbound signal thread as context. The generated draft is either sent automatically (if the rule is configured for auto-send) or placed in the arc as a draft for user review. Template functions (`{{fn.*}}`) still execute — AI fills the unstructured parts, functions fill the deterministic parts. This also enables a "Draft a reply" button in arc detail that uses the account's default reply template + AI prompt to generate a contextual first draft.
- [ ] **Gate `retentionDuration` setting by billing plan + handle downgrades** — validate against current plan on PATCH. Coerce on downgrade.
- [ ] **Update forwarding verification email URL format** — land directly on Settings forwarding tab which auto-submits verification on mount.
- [ ] **Unify forwarding targets as a single resource (`/accounts/:id/targets`)** — replace the separate forwarding-addresses and webhook-URL concepts with a single `ForwardingTarget` resource. Types: `email` (validated via verification email, ID = the email address) and `webhook` (validated via HTTP 200 test request, ID = `uri-{generated-id}`). API: `GET/POST/DELETE /accounts/:id/targets`. POST starts validation (sends verification email or fires test request). Once verified, the target can be referenced in forwarding rules by its `forwardingTargetId`. Migrate existing verified forwarding addresses into the new resource. Reject rule saves that reference unverified or non-existent targets. Targets have a `status` field: `pending` → `verified` → can be `disabled` (on permanent bounce, system auto-disables). On bounce: iterate all account rules, find rules whose forward/webhook action references the failed target, disable the entire rule (set `status: "disabled"`). Targets cannot be deleted while any rule references them. Re-enabling a disabled target requires revalidation (re-sends verification email or re-fires test request) — cannot be re-enabled without proving it works.
- [ ] **Investigate: arc missing `retentionDuration`** — check if `resolveRetention()` was called during processing.
- [ ] **Calendar forwarding address verification** — verify the calendar forwarding address is reachable before storing it.
- [ ] **Image handling strategy for email signals** — define how images in email bodies are loaded, proxied, and cached for display.
- [ ] **Secure HTML email rendering** — define the sandboxing strategy for rendering untrusted HTML email bodies in the frontend.
- [ ] **Auto-block sender on unsubscribe** — persist `block_hidden` disposition for the sender eTLD+1 on the alias after unsubscribe succeeds.
- [ ] **Auto-handle vacation responder signals** — auto-archive + set urgency `silent` on vacation auto-replies detected via `Auto-Submitted: auto-replied` header.
- [ ] **Document error response codes in OpenAPI spec** — add `responses` entries for 400, 409, 412, and 422 to every route.
- [ ] **Billing endpoints** — Stripe integration: `GET /billing`, `POST /checkout-session`, `POST /portal-session`.
- [ ] **User attachment upload for outbound signals** — presigned S3 PUT URL + `attachmentId`. TTL-based cleanup for unreferenced uploads.
- [ ] **Review all locations where we might want to send emails to users** — define notification strategy before implementing.
  - [ ] **Team invite email via SES** — replace TRACK log with actual SES send.
- [ ] **Wire up onboarding follow-up emails via SES** — replace TRACK logs in `OnboardingTaskHandler` with SESv2 calls.
- [ ] **Confirmation workflow (split from auth)** — new `confirmation` workflow type. **Separate spec needed.**
- [ ] **Calendar invite signals: rich attendee display + calendar forwarding provenance** — dedicated calendar invite component in UI.
- [ ] **Calendar invites created by user's calendar directly** — secured mechanism without revealing sender.
- [ ] **WebSocket signal stream** — `/accounts/:id/signals/stream` endpoint. Authress token auth, `signal:created` events.
- [ ] **ClamAV attachment scanning on S3** — scan attachments for malware. Tag objects with `scan-status`.
- [ ] **JMAP support (RFC 8620 + RFC 8621)** — standards-compliant JMAP server. Separate API surface.
- [ ] **On-demand alias generation** — browser extension or API generates unique aliases per-service.
- [ ] **Snooze / remind me later** — hide an arc until a future time, then resurface it.
- [ ] **Calendar sync** — bidirectional calendar integration (CalDAV, Google Calendar, Outlook).
- [ ] **Webhook outbound** — user configures a URL; signals POST as JSON.
- [ ] **Become FedCM identity provider** — register as a FedCM provider so other apps can log in.
- [ ] **Submit to awesome-privacy-tools** — open a PR to add the project.
- [ ] **OTP auto-fill + Web Push service worker** — tracked in `extension/TODO.md`.
- [ ] **PGP / end-to-end encryption** — encrypt stored email content at rest with user-held keys.
- [ ] **Browser extension** — full extension for alias management, OTP auto-fill, signup detection.
- [ ] **Mobile app** — native mobile client.
- [ ] **Deploy Bedrock guardrail and re-enable in classifier** — create `aws_bedrock_guardrail` resource in infrastructure, uncomment in classifier.
- [ ] **Strip tracking pixels from HTML email bodies at ingestion** — ADR 007 heuristics. Remove tracker `<img>` elements at processing time.
- [ ] **Automatically seed sample arcs during onboarding for new users** — new accounts land in an empty inbox until the user's own test email arrives in Step 2. Auto-create a small set of system-generated example arcs (e.g. a sample `package`, `payments`, and `auth` arc with realistic `workflowData`) at account creation so the inbox UI, workflow cards, and smart action buttons aren't demoed against a blank state. Tag these arcs distinctly (e.g. `workflow: "test"` or a dedicated `sample`/`demo` flag) so they're clearly distinguishable from real mail and can be bulk-dismissed or auto-expired once the user has received their first real signal.

---

## Frontend Contract Comparison (2026-05-16)

Compared the frontend's expected API surface against the actual backend implementation.

### ✅ Exists and matches — frontend can use as-is

| Area | Endpoints | Notes |
|------|-----------|-------|
| Labels | GET/POST/PATCH/DELETE `/accounts/:id/labels` | Shapes match |
| Views | GET/POST/PATCH/DELETE `/accounts/:id/views` | Shapes match |
| Rules | GET/POST/PATCH/DELETE `/accounts/:id/rules` | Shapes match |
| Domains | GET/POST/PATCH `/accounts/:id/domains` | Backend also has GET /:id and DELETE |
| Forwarding addresses | GET/POST/DELETE `/accounts/:id/forwarding-addresses` | Backend also has verify endpoint |
| Team members | GET/POST/PATCH/DELETE `/accounts/:id/users` | Shapes match |
| Templates | GET/POST/PUT/DELETE `/accounts/:id/templates` | Backend supports PUT for full replace |
| Quarantine signals | GET `?status=quarantine_visible\|quarantine_hidden` | Works |
| Quarantine response | POST `/:signalId/quarantineResponse` | Backend will support `block_hidden`, `block_reject`, `report_violation` |
| Draft signals | PUT, POST send, DELETE on `/arcs/:arcId/signals/:id` | Works |
| Aliases | GET/POST/PATCH/DELETE `/accounts/:id/aliases` | Senders via sub-resource |
| Account GET/PATCH | `/accounts/:id` | Works |

### ❌ Backend TODOs (from contract comparison)

- [ ] **Billing endpoints** — `GET /accounts/:id/billing` → `BillingInfo`, `POST /accounts/:id/billing/checkout-session` → Stripe Checkout URL, `POST /accounts/:id/billing/portal-session` → Stripe Portal URL. Requires Stripe integration.
- [ ] **User attachment upload for outbound signals (replies/compose)** — drafts currently have `attachments: []` hardcoded; no upload endpoint exists. Needed: `POST /accounts/:accountId/attachments` → presigned S3 PUT URL + `attachmentId`; client uploads directly to S3; draft creation/update references `attachmentId` values; send logic fetches from S3. Also needs TTL-based cleanup for unreferenced uploads.
- [ ] **Document error response codes in OpenAPI spec** — add `responses` entries for 400, 409, 412, and 422 status codes to every API route definition (via `@hono/zod-openapi` route config). Each endpoint should declare which error codes it can return and under what conditions, so that `npm run openapi` produces a spec with full error documentation. Audit each handler for the error paths it actually uses, define shared zod schemas for error response bodies (e.g. `{ errorCode: string, message: string }`), and wire them into the route's `responses` map.

---

- [ ] **Become FedCM identity provider** — meaning other apps log in via our app. This means registering as a FedCM provider so other apps can log in.
- [ ] **Submit to awesome-privacy-tools** — open a PR at https://github.com/anondotli/awesome-privacy-tools/blob/main/CONTRIBUTING.md to add this project to the list. Follow the contributing guidelines before submitting.

---

## Security Badges & Certifications

Free, publicly-verifiable trust signals that competitors (ForwardEmail, Addy.io) display. All are automated scans — no manual audit required.

- [ ] **Qualys SSL Labs A+** — run https://www.ssllabs.com/ssltest/ against our domains. Requires: TLS 1.3, HSTS, strong cipher suites, no mixed content. Display badge on site.
- [ ] **Mozilla HTTP Observatory A+** — run https://observatory.mozilla.org/ against our site. Requires: CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, etc. Display badge on site.
- [ ] **Internet.nl Mail Test 100%** — run https://internet.nl/mail/ against our mail domain. Tests: STARTTLS, DANE/TLSA, DNSSEC, SPF, DKIM, DMARC, MTA-STS, TLS-RPT. Display badge on site.
- [ ] **Internet.nl Site Test 100%** — run https://internet.nl/site/ against our web domain. Tests: IPv6, DNSSEC, HTTPS (HSTS, TLS), security headers. Display badge on site.
- [ ] **Hardenize report** — run https://www.hardenize.com/ against our domain. Comprehensive TLS/DNS/email security report. Link from site footer.
- [ ] **MECSA (EU)** — run https://mecsa.jrc.ec.europa.eu/ against our mail domain. EU Joint Research Centre email security assessment. Tests: STARTTLS, x509, SPF, DKIM, DMARC, DANE.

### Prerequisites (DNS/infra work needed first)

- [ ] **DNSSEC** — sign our zones. Required for Internet.nl 100% and DANE.
- [ ] **DANE/TLSA records** — publish TLSA records for MX endpoints. Required for Internet.nl mail 100%.
- [ ] **MTA-STS** — publish `_mta-sts` TXT record + host `/.well-known/mta-sts.txt`. Already referenced in TODO but needed for badge scores.
- [ ] **TLS-RPT** — publish `_smtp._tls` TXT record to receive TLS failure reports.

---

## Extension Audit — Gaps vs. Backend Spec

### What the extension needs to fix

- [ ] **OTP auto-fill + Web Push service worker** — tracked in detail in `extension/TODO.md`.

---

## MARKETING PAGE CONTENT

Novel and differentiated features to highlight. Each item here represents something genuinely novel, privacy-respecting, or technically differentiated — not table-stakes inbox features. Use this list to brief copywriters and inform the marketing site's feature sections.

Built and Secured in Switzerland

---

### Privacy & Security — Switzerland

- **Swiss-hosted infrastructure** — all email data stored and processed in Switzerland, subject to Swiss data protection law (nFADP), one of the strongest privacy frameworks globally. No US cloud jurisdiction, no FISA/PRISM exposure.
- **No advertising, no data mining** — inbox contents are never used for profiling, ad targeting, or sold to third parties. The business model is subscriptions, not surveillance.
- **Zero-knowledge AI classification** — classification runs against email metadata and content, but the AI model (Bedrock/Claude) processes transiently and does not retain training data from user emails.
- **End-to-end audit log** — every action on every arc and signal is logged with before/after state. Users can export their full audit trail at any time. Transparency over opacity.

---

### JMAP Support

- **Industry-standard JMAP protocol** (RFC 8620 + RFC 8621) — connect any standards-compliant email client (Apple Mail on iOS/macOS, Thunderbird, Mimestream, etc.) directly to the inbox without a proprietary app. The inbox becomes a protocol-level platform, not a walled garden.
- **JMAP push** — real-time state change notifications over SSE/WebSocket. Client state always in sync without polling. Battery-efficient on mobile.
- **EmailSubmission/set** — outbound sending through JMAP, gated on Tier 2 sender setup. Unified send/receive over one protocol.

---

### Unlimited Aliases

- **Unlimited receive addresses** at any registered domain — `receipts@`, `newsletters@`, `orders@`, `anything@` — all routed to the same account with per-address filter configs. No per-alias charge. No artificial limits.
- **Automatic alias creation** — the system creates a per-address config the moment the first email arrives at a new address on a registered domain. No manual setup. The alias exists as soon as mail arrives.
- **Per-alias filter mode** — each alias has independent `filterMode`, `approvedSenders`, `spamScoreThreshold`, and `blockDisposition` settings. `newsletters@yourdomain.com` can be `allow_all`; `finance@yourdomain.com` can be `strict`. Full granularity.
- **Alias-level labelling** — rules can fire on `recipientAddress`, so emails to `receipts@` can auto-label `receipts`, emails to `orders@` auto-label `orders`. Inbox organisation emerges from how you hand out addresses.

---

### Auto-Unsubscribe

- **One-tap unsubscribe from any arc row** — unsubscribe link extracted from `List-Unsubscribe` and `List-Unsubscribe-Post` headers (RFC 2369/8058) and surfaced directly in the inbox UI. No digging through the email. No navigating to the sender's site.
- **POST-based unsubscribe** — where the sender supports `List-Unsubscribe-Post` (Gmail-compatible one-click standard), the inbox fires the POST server-side without opening a browser. Instant, no confirmation page, no re-marketing flow.
- **Post-unsubscribe auto-archive rule** — after unsubscribing, the arc is archived and a label `unsubscribed:{publisher}` is applied. A rule can be auto-created to archive future mail from that sender.
- **Unsubscribe audit** — account-level list of all unsubscriptions: publisher, date, method (POST vs link). Exportable. Useful for compliance and for verifying that unsubscribes actually took effect.

---

### DPA Complaint Filing

- **One-click report to Data Protection Authority** — when a sender ignores unsubscribe requests or continues emailing after being blocked, the user can escalate directly to the relevant national DPA from the arc detail UI. No Googling complaint forms, no drafting letters — the system handles it.
- **Jurisdiction-aware DPA routing** — built-in registry of EU/EEA DPAs plus UK ICO, Swiss FDPIC, and Norwegian/Icelandic authorities. The system determines the correct DPA based on the sender's jurisdiction (company country derived from domain/WHOIS) or the user's own country (for cross-border complaints under GDPR Art. 77).
- **Pre-filled complaint with evidence** — the complaint includes: original unsubscribe request date, `List-Unsubscribe` attempt proof, count and dates of emails received after unsubscribe, sender domain and company identification, and the user's account jurisdiction. All machine-generated from the arc's signal history.
- **Dual filing paths** — "File via web" deep-links to the DPA's online complaint portal (pre-filling where the form supports URL params). "File via email" generates a structured complaint email to the DPA's contact address, ready to send.
- **Complaint tracking** — each filed complaint is tracked per arc with status (filed → acknowledged → resolved). The user has a full audit trail of enforcement actions taken. Exportable for legal proceedings if needed.
- **Escalation ladder UX** — the UI presents a clear progression: unsubscribe → block → report to DPA. Each step is one tap. The nuclear option is always available but never accidental.

---

### Search

- **Full-text search across all arcs and signals** — subject, sender, body, AI summary, labels. Instant results with keyboard shortcut. No waiting for indexing — backed by DynamoDB + a dedicated search index built at signal ingestion time.
- **Semantic search** — "find emails about my AWS bill from last quarter" finds the right arc even if those words don't appear verbatim. Backed by the same embedding vectors used for arc matching. Optional (heavier query) but powerful for power users.
- **Filter-as-you-type** — chips for `workflow:`, `label:`, `from:`, `before:`, `after:`, `status:` compose into structured queries. The query language is learnable and scriptable for power users.
- **Saved searches** — any search query can be saved as a View. "All unpaid invoices" becomes a persistent sidebar item, auto-updating as new signals arrive.

---

### Signup & Registration Integration (Browser Extension)

- **Browser extension detects signup forms** — when the user registers for a new service in Chrome/Firefox/Safari, the extension offers a one-tap auto-generated alias: `stripe-{random}@yourdomain.com`. The alias is created server-side before the form is submitted, with a pre-configured filter rule to label incoming mail `service:stripe`.
- **Extension fills the alias into the email field** — no copy-paste. The user clicks the extension icon (or the inline icon in the email field), chooses an alias, and the form is filled. Captures the site domain for labelling.
- **Per-registration alias tracking** — the extension stores which alias was used for which site. In Settings → Email Addresses, the user sees `stripe-abc123@yourdomain.com — used at stripe.com — 4 emails received`. This is account-breach detection: if `stripe-abc123@` starts receiving phishing mail, the user knows Stripe's email list was compromised.
- **One-click alias blocking** — if an alias starts receiving spam or the user no longer wants mail from that service, they block the alias in one tap from Settings. All future mail to that alias is silently dropped — no unsubscribe dance, no email bounced back to the sender, just silence.

---

### Workflow Intelligence — OTP & Auth

- **In-app OTP banner (web + mobile)** — when a new auth signal arrives and the user already has the app open, a floating banner appears at the top of the screen — regardless of what view they're on — with the code pre-displayed and a copy button. No navigation to inbox required. The code is in the user's hand without a single tap on the email itself. The highest-friction moment in computing (copy a 6-digit code) becomes zero-friction.
- **Auto-copy OTP to clipboard (mobile)** — on Android, when a one-time code arrives via push notification, the code is copied to the clipboard automatically before the user even unlocks. A system toast confirms: "Code copied from GitHub." On iOS, tapping the notification copies the code instantly — one tap, not six. Opt-in setting: "Automatically copy one-time codes when they arrive." The fastest possible path from email to login.

---

### AI-Powered Replies (Template + Prompt)

- **"Draft a reply" with AI** — when a conversation or CRM email needs a response, one tap generates a first-person reply draft in the composer. The AI uses the account's reply template as a tone/structure guide and a custom prompt as system instructions. The user edits and sends. Not a canned response — a contextual, personalised draft that sounds like them.
- **Rule-triggered auto-replies with AI** — templates can include an `aiPrompt` field. When a rule matches and the template has a prompt, Bedrock generates the reply body using the template structure + the inbound thread as context. Deterministic fields (template functions) stay deterministic; AI fills the human parts. Auto-send or draft-for-review — user's choice per rule.

---

### Time-Aware Surfacing — "The right email at the right moment"

- **Knows when you need to act** — every signal is analysed for action deadlines: reply-needed conversations, invoice due dates, meeting RSVPs, expiring discount codes. The inbox surfaces them at the moment they become urgent — not when they arrived. An invoice due in 14 days doesn't interrupt Tuesday morning; it surfaces Wednesday of the due week.
- **Configurable resurfacing** — users control when action-needed arcs reappear: "Surface unpaid invoices 3 days before due", "Remind me about unanswered conversations after 48 hours", "Show boarding passes 2 hours before departure." Per-workflow defaults with per-arc overrides.
- **Meeting reminders + event QR codes at the door** — scheduling arcs with `startTime` automatically resurface with the joining link or venue QR code exactly when needed. A Zoom link surfaces 5 minutes before. A concert ticket QR surfaces when you arrive at the venue. The email you received 3 weeks ago becomes useful precisely when it matters.
- **Bills surface on payday, not arrival day** — invoice and subscription renewal arcs can be snoozed to a user-configured "bill review day" (e.g. 1st of the month). All payment arcs accumulate silently and surface together as a batch for review. One session, all bills handled.
- **Conversations that need a reply float back** — if a conversation is marked `requiresReply` and the user hasn't responded after a configurable delay, the arc silently re-elevates in the Default view. Not a notification. Not an alarm. Just gentle, persistent visibility until the user acts or dismisses.

---

### Package Intelligence — "Your deliveries, at a glance"

- **Delivery day awareness** — on days when one or more packages are `out_for_delivery`, a subtle banner appears at the top of the inbox: "2 packages arriving today: AirPods Pro, USB-C Cables." Tapping it filters to those arcs. A morning delivery briefing — not an alert, just ambient awareness of what's coming today.

---

### CRM — "Your inbox is your CRM"

- **TODO:** Define the CRM marketing story. The inbox automatically builds relationship context from email history — no manual data entry, no separate tool. Details TBD.

---

### Innovations — Pending Review

Items from the WORKFLOW_UX_SPEC "Where to innovate" sections. Evaluate for inclusion in marketing site.

#### Package
- [ ] **Spend tracking** — rolling 30-day spend aggregated by retailer in package view header: "You've spent €847 at Amazon this month."
- [ ] **One-tap return initiation** — deep-link return URL from `orderNumber` + retailer URL patterns. Start a return without navigating the retailer's site.

#### Travel
- [ ] **Boarding pass lock screen widget** — confirmation number / QR code persists as lock-screen notification on travel day. Never dig through apps at the gate.
- [ ] **Proactive gate/delay alerts** — airline sends a change email → interrupt-push regardless of preferences. Gate changed? You know before the board updates.
- [ ] **Multi-city trip linking** — flights + hotels with overlapping dates to the same destination grouped into a collapsible "London Jan 18–22" trip section.
- [ ] **Expense extraction post-trip** — one-tap export of all trip costs (flight/hotel/car) as CSV after the trip auto-archives.

#### Scheduling
- [ ] **Conflict detection** — new invite overlaps existing scheduling arc → inline warning: "Conflict: you already have Q2 Review at 2pm."
- [ ] **One-tap accept + add-to-calendar** — single tap: accept reply sent + .ics added to OS calendar + arc archived.
- [ ] **Location intelligence** — physical address → one-tap Directions. Video URL → one-tap Join. On the arc row, not buried in detail.
- [ ] **Smart decline suggestions** — when declining, suggest free time slots from existing scheduling arcs: "You're free Thursday 4–5pm — propose?"

#### Payments
- [ ] **Vendor spend aggregation** — monthly spend dashboard in Payments view: total + per-vendor breakdown. No spreadsheet, no bank login.
- [ ] **Overdue invoice escalation** — invoice passes `dueDate` by 3 days with no receipt → escalate + "Have you paid this?" prompt.
- [ ] **Subscription calendar** — all renewal arcs listed by upcoming date: "Adobe CC — Jan 30, €599 / AWS — Feb 1 / Notion — Feb 15, €96."
- [ ] **One-tap pay confirmation** — after clicking Pay now and returning, prompt: "Did you complete the payment?" → [Yes, paid] archives + labels.

#### Alert
- [ ] **Automated threat context enrichment** — IP on suspicious login → threat intel lookup. Risk score, country, report count displayed inline.
- [ ] **Security incident timeline** — multiple related security events linked visually: "Security incident — 3 events over 2 hours."
- [ ] **CI failure summary** — "Failing since: commit 4a3b2c1. Last passing: 7f8d2e4 at 2:15pm." Parsed from email bodies.
- [ ] **Security playbook** — "This wasn't me" → guided checklist: change password, review sessions, enable 2FA, revoke OAuth apps. Each tappable + trackable.

#### Content
- [ ] **Reading time estimate** — word count → "7 min read" on the arc row.
- [ ] **AI digest of newsletters** — weekly briefing across all unread newsletters: 12 issues → 6 sentences, each deep-linking to the source arc.

---

Everything the backend already knows that the UI needs to expose. Organised by screen/feature area.

---

### Inbox (Arc List)

The primary view. Arcs are the browsing unit — not individual emails.

- Each arc row shows: workflow icon, sender name/domain, AI-generated summary, urgency badge, last signal timestamp, label chips
- Urgency drives visual prominence: `critical` = red/bold, `high` = orange, `normal` = default, `low` = muted, `silent` arcs are never shown
- Arcs with `sentMessageIds` (user has replied) should show a "replied" indicator — these carry the `system:replied` label; the UI should visually distinguish them
- Arc status filter: REST-style `?status=active|archived|snoozed|deleted` query param (four statuses: `active`, `archived`, `snoozed`, `deleted`)
- Swipe/hover actions: archive, delete, label
- Inline "unread" state (client-side or via a future `Arc.readAt` field)
- Pagination via cursor (`lastEvaluatedKey`) — infinite scroll or Load More
- Empty states per view/filter with helpful copy
- `test` workflow arcs are visually distinct: flask/beaker icon, muted colour palette, a small "TEST" badge — clearly not real mail but still browsable; show in the main inbox under a collapsible "Tests" section rather than hiding them entirely

### Arc Detail (Signal Thread)

Drill-in from inbox. Shows all signals in the arc as a chronological thread.

- Thread header: workflow, sender eTLD+1, recipient address, arc urgency, current labels
- Each signal card shows: from, to, cc, subject, received timestamp, AI summary, spam score (if > 0.3, show warning indicator), body (text or HTML rendered in sandboxed iframe), attachments list
- `original:john@gmail.com` label (forwarded email detection) appears in the label chips alongside all other labels
- Workflow-specific structured data panels — each workflow has rich `workflowData` fields the UI should render as a card rather than raw JSON:
  - `package` → order number, tracking link, items list, estimated delivery, status
  - `payments` → amount, due date, invoice number, download link, payment type
  - `travel` → flight number, departure/arrival, confirmation code, boarding pass link
  - `auth` → OTP/magic link action button (copy code, open link), expiry countdown
  - `alert` → service, severity, requiresAction flag, error message snippet
  - `job` → company, role, stage (applied / interview / offer), action required flag
  - `healthcare` → appointment date, provider, action required flag
  - `crm` → sender company, role, deal value, urgency, requiresReply flag
  - `support` → ticket ID, service, priority, agent name, eventType status
  - `scheduling` → event title, start/end time, location, organizer, requiresResponse
- AI-suggested labels shown with one-click accept
- User can manually override workflow classification (dropdown)
- User can manually add/remove labels
- **Reply composer** — inline compose panel that slides up from the bottom of the arc detail:
  - **From** field: free-text input for the sender email address (local part), with **domain as a separate dropdown** populated from the user's registered Tier-2-complete domains. Typing in the local part + choosing a domain composes the full `from` address.
  - **Autocomplete**: as the user types the local part, suggest previously-used sender identities (full `local@domain` combos from `arc.sentMessageIds` history across the account), ordered **recommended first** (most recently used → most frequently used → everything else). Recommended entries are shown with a subtle "Recommended" chip.
  - Domain dropdown only shows domains with `senderSetupComplete: true`; domains with Tier 2 incomplete are shown greyed out with an inline "Set up sending →" link.
  - If the user has no Tier-2-complete domain, the From field is replaced with a banner: *"Set up sending to reply from your domain"* with a CTA to the domain sender setup wizard.
  - Standard To/Subject/Body fields below the From selector; To pre-filled with the signal sender, Subject pre-filled with `Re: {original subject}`.
  - Send button calls the reply API and adds the outbound message ID to `arc.sentMessageIds`.
- Signal status badge for blocked/quarantined signals within a thread
- For `test` workflow arcs: show a dedicated pong reply card in the thread below the original signal — displays the AI-generated reply that was auto-sent back to the sender, so the user can see what the system said. Include a playful framing: *"We replied →"* followed by the reply body.

### Quarantine / Blocked Inbox

Separate view for signals that were blocked before reaching an arc.

- Lists blocked and quarantined signals (GSI: `BLOCKED#{accountId}`)
- Shows block reason: `new_sender`, `spam`, `sender_mismatch`, `reputation`, `onboarding`
- For each signal:
  - **Quarantined** (blockDisposition = quarantine): user was notified; shown here for review
  - **Blocked** (blockDisposition = block): silently dropped; shown here for power users
- Actions: **Allow & Create Arc** (creates arc, auto-approves sender domain), **Dismiss** (confirm block)
- Spam score visible on each row
- Filter by block reason
- Bulk-allow by sender domain

### Views (Custom Tabs / Sidebar)

User-defined filtered lists of arcs. Like Gmail labels but with filter logic baked in.

- Sidebar or top tab bar showing all views in user-defined order (`View.position`)
- Each view has name, icon (emoji or icon set), color
- Active view highlights in nav
- Create/edit/delete views via settings (or inline via `+` button)
- Drag-to-reorder (calls `POST /views/reorder`)
- View config: workflow filter (single or all), label filters (must-have-all), sort field + direction
- Default views to seed on first login: All, Action Needed, Finance, Travel, Receipts (mapped to relevant workflows + labels)
- **System-level permanent nav items** — always present, cannot be deleted or renamed; user-created views sit below these:
  1. **Default** — the landing view when the app opens. **Fixed — not user-configurable for now.** Always shows: all `active` arcs excluding stale `auth` arcs (OTPs/magic links past validity, auto-archived by processor) and `notice` arcs. `test` arcs appear here. The structural exclusions define what Default *is* — allowing users to remove them creates edge cases where things vanish unexpectedly. Users who want a custom landing experience can create a view and position it first in their sidebar.
  2. **All** — every arc regardless of `status`, no filter and no exclusions. The escape hatch when Default is too narrow.
  3. **Quarantine** — blocked and quarantined signals that have not yet become arcs; separate from arc-based views because these signals predate arc creation.
  - No **Sent** view. Archived, Snoozed, and Deleted arcs are accessible via the `?status=` filter on All, not separate nav items.
- **`auth` arc auto-expiry**: processor or a scheduled job auto-archives `auth` arcs once the OTP/magic link validity window has passed (typically 10–30 min, extractable from `workflowData`). Keeps Default clean without requiring manual archiving of dead login requests.
- **Notifications always deep-link directly** to the specific arc or quarantined signal — notification payload must carry the arc ID or signal ID at fire time so the link resolves correctly even for pre-arc quarantined signals.

### Labels

Account-scoped tags. The main way users organise arcs beyond workflow grouping.

- Label management screen: name, color picker, icon picker
- **Label names are immutable** — the name is the identity (DynamoDB key). Users can change color and icon but cannot rename a label. To "rename", they must create a new label, re-assign arcs, and delete the old one. The UI should not offer a rename action.
- Labels appear as chips on arc rows and arc detail
- Click a label anywhere → filters inbox to that label (or opens the label's view if one exists)
- Quick-add label from arc detail (type to search existing, or create inline)
- Classifier auto-suggests labels on signal receipt — shown as ghost chips with accept/dismiss
- AI-suggested label examples: `action-needed`, `urgent`, `billing`, `renewal`, `read-later`
- Delete label: confirm dialog warns how many arcs will be affected

### Rules (Automation)

JSONLogic-based conditional automation. Runs on every new signal.

- Ordered rule list with drag-to-reorder (`POST /rules/reorder`)
- Each rule shows: name, condition summary, action list, enabled/disabled toggle
- Rule editor:
  - **Condition builder**: JSONLogic-based; should offer a visual builder (field + operator + value rows with AND/OR nesting) that compiles to JSONLogic, plus a raw JSON fallback for power users
  - Available condition fields (from signal context): `signal.workflow`, `signal.spamScore`, `signal.workflowData.*`, `signal.from`, `signal.subject`, `arc.labels`, `arc.status`, `arc.urgency`
  - **Actions** (multiple per rule, each individually enable/disable-able):
    - `assign_label` → label picker
    - `assign_workflow` → workflow picker
    - `archive` → no config
    - `delete` → no config
    - `forward` → verified forwarding address picker (shows pending addresses as disabled)
- Forward action auto-disables when target address hard-bounces — show a warning badge on the rule
- "Test against a signal" preview (dry-run a rule against a recent signal to confirm it would match)

### Search

Global full-text search on arc summaries + workflow.

- Search bar in top nav (keyboard shortcut)
- Results show arc rows identical to inbox (workflow icon, summary, sender, date, labels)
- Filter chips alongside results: by workflow, by label, by date range
- No results state with suggestion to check spelling or broaden filters

### Settings — Account

- Account name (editable)
- Deletion retention days (how long deleted arcs are kept before permanent removal; `Arc.TTL`)
- Notification email: address + frequency (`instant` / `hourly` / `daily`)
- Global filtering defaults:
  - `defaultFilterMode`: `strict` / `sender_match` / `notify_new` / `allow_all`
  - `newAddressHandling`: `auto_allow` / `block_until_approved`
  - `blockOnboardingEmails`: toggle
  - Per block-reason disposition: `block` (silent) vs `quarantine` (notify) — shown as a table with reason in rows and disposition in columns

### Settings — Email Addresses (Per-Address Config)

Each recipient address the user receives mail at can be configured independently.

- List all configured addresses with their filter mode
- Add new address (auto-populated when a new signal arrives)
- Per-address settings:
  - Filter mode override (inherits global default if not set)
  - Approved senders list (eTLD+1 domains, e.g. "amazon.com") — add/remove
  - Onboarding email handling override (block / quarantine / allow / inherit)
- Delete config (resets to global default)

### Settings — Domains

For users who receive mail via a custom domain routed through SES.

- List registered domains — each row shows: domain name, Tier 1 (receiving) status badge, Tier 2 (sending) status badge, last checked timestamp
- **Tier 1 status badges** (MX record):
  - `active` — MX verified, receiving email, green
  - `degraded` — MX missing or wrong, amber — email is not being received
  - `pending` — newly registered, awaiting first weekly check pass
- **Tier 2 status badges** (DKIM + SPF + DMARC):
  - `active` — all 3 records verified, can reply and forward, green
  - `degraded` — one or more records failing, amber
  - `not configured` — user hasn't gone through sender setup yet, grey with "Set up sending" CTA
- Register new domain: wizard always shows all 4 DNS records at once — MX clearly marked as required now, the 3 sender records clearly marked as recommended (same UX as onboarding Step 1)
- DNS record table after registration — two sections:
  - **Receiving** (1 record): domain MX → SES inbound endpoint
  - **Sending** (3 records, shown once Tier 2 is initiated): `mail._domainkey.{domain}` CNAME, `bounce.{domain}` MX, `bounce.{domain}` TXT SPF, `_dmarc.{domain}` CNAME
- Copy-to-clipboard button on every record value
- Per-record status indicator (green check / amber warning / red cross) from `failingRecords[]`
- **Degraded state**: inline warning banner showing exactly which record is wrong, its current (incorrect) value if resolvable, and the correct expected value
- **Re-check DNS button**: calls `POST /domains/:id/verify` on demand; spinner while running; shows updated per-record status inline within seconds — users should not have to wait for the weekly scheduled check after fixing a record
- **"Set up sending" prompt**: shown on domains with Tier 1 active but Tier 2 not configured; clicking opens the sender setup wizard inline
- **Reply/forward gate**: when a user attempts to reply or forward from a domain that has Tier 2 `not configured` or `degraded`, show a modal explaining the issue and linking to the domain's sender setup — do not silently fail
- Delete domain: confirm dialog warns that inbound email for this domain will stop routing; requires typing the domain name to confirm

### Settings — Forwarding Addresses

Addresses that can be used as targets in forward rules.

- List all forwarding addresses with status: `pending` (awaiting click) / `verified`
- Add address → triggers verification email immediately
- Resend verification for pending addresses
- Delete address (warns if used by active rules)
- Addresses used in rules that auto-disabled show a bounce warning

### Settings — Team / Users

Role-based access for multi-user accounts. Backed by Authress access records.

- List current users: avatar, name/email, role (`owner` / `admin` / `member` / `viewer`), joined date, last active
- Invite user: enter email address → Authress sends invite → user accepts → appears in list
- Change role inline (owner-only for owner promotion; admin can change member/viewer)
- Remove user: confirm dialog warning them they will immediately lose access
- Pending invites section (sent but not yet accepted) with resend / revoke options
- Role capabilities matrix shown as a comparison table in the UI:
  - `viewer`: read-only — browse arcs/signals, no mutations
  - `member`: manage labels, archive/delete arcs, apply rules manually
  - `admin`: create/edit rules, manage domains, forwarding addresses, aliases, notification settings
  - `owner`: invite/remove users, change roles, billing, delete account
- Account switch button: top-level UI affordance (avatar menu or sidebar) to switch between accounts the user belongs to, without logging out — calls Authress to list memberships, then re-authenticates scoped to the selected account

### Personal Profile

Per-user settings (not per-account). Backed entirely by `@authress/login` SDK.

- Display name and avatar (editable)
- Email addresses associated with the account — primary + any linked addresses
- **Linked logins**: connect/disconnect additional identity providers (Google, GitHub, Microsoft, Apple etc.) via `authressClient.linkIdentity()` — shows current linked providers with icons; user can add another or remove one (must keep at least one)
- **MFA setup**: via Authress MFA API — show current MFA status (enabled / not enabled); enroll TOTP authenticator app (QR code flow), SMS, or passkey; list enrolled factors with remove option; recovery codes download
- **Active sessions**: list of currently active sessions (device, browser, last seen, location); button to revoke individual sessions or "Sign out all other devices"
- **Danger zone**: delete personal account (removes user from all accounts they're a member of; separate from deleting the account itself)

### Account Management

Top-level account operations, separate from per-resource settings.

- Account name and slug (editable by owner/admin)
- Account avatar / logo upload
- Timezone and locale preference (affects digest timing, date formats)
- Data export: download all arcs + signals as JSON or CSV (async job, emailed when ready)
- **Delete account**: two-step confirmation (type account name); warns that all data is permanently deleted after the retention window; owner-only
- Danger zone section clearly separated at the bottom of the page

### Billing

Plan selection and subscription management.

- Current plan banner: plan name, billing cycle, next renewal date, cost
- Plan comparison table with feature matrix (e.g., number of domains, signal retention days, team members, rule count limit, AI classification included/excluded, support tier)
- Upgrade / downgrade CTA inline per plan column
- Payment method: show card last 4 + expiry; "Update payment method" button (Stripe or equivalent hosted flow)
- Billing history: table of past invoices (date, amount, status: paid/failed, download PDF link)
- Usage meters: signals processed this billing period, domains registered, team members, storage used — relevant if plan has limits
- Failed payment banner (prominent, dismissible only after resolution) with "Update payment method" CTA
- Cancellation flow: owner-only; ask reason (churn survey), offer downgrade to free tier as alternative, confirm with data-loss warning

### Audit Log

Every action taken by any user in the account is logged and browsable.

- **Backend requirement**: all write operations (arc mutations, rule changes, label changes, domain registration, user management, settings changes) must record `{ userId, action, resourceType, resourceId, timestamp, before, after }` — store in DynamoDB with a `AUDIT#` key prefix, GSI by timestamp for account-wide listing
- **UI**: table view of audit events, newest first
  - Columns: timestamp, user (name + avatar), action (human-readable: "Archived arc", "Created rule", "Invited user"), resource link (click → navigate to the resource)
  - Filter by user, action type, date range
  - Expandable row to see before/after diff for mutations
- Audit events to capture (at minimum):
  - Arc: archived, deleted, restored, label added/removed, workflow overridden, urgency overridden
  - Signal: unblocked/allowed, dismissed from quarantine
  - Rule: created, updated (condition or action changed), deleted, reordered, action disabled (bounce)
  - Label: created, color changed, deleted
  - Domain: registered, deleted
  - Forwarding address: added, verified, deleted
  - User: invited, role changed, removed
  - Account settings: any field changed
  - Billing: plan changed, payment method updated
- Retention: configurable (e.g., 90 days on free, 1 year on paid plans)
- Export: download audit log as CSV for compliance

### Support

- **Help button**: persistent in the bottom-left corner of the app (or `?` icon in nav); opens a support panel without leaving the current page
- **Support panel**:
  - Search knowledge base / docs (link out or embedded)
  - "Contact support" button → opens a pre-filled support request form
  - Links to status page and changelog
- **Support request form**:
  - Category dropdown: Billing, Technical, Account, Feedback, Other
  - Subject + description fields
  - Auto-attach: current account ID, user ID, browser/OS, relevant arc/signal ID if the user was on a detail page when they clicked Help
  - File attachment (screenshots)
  - Submit → creates a ticket in your support system (email, Intercom, Linear, etc.); user sees ticket reference number
- **Status page link**: separate public page (or third-party e.g. Statuspage.io) showing API / email processing uptime — linked from support panel and from any error states in the app

### Legal Pages

- **Terms of Use**: standard page at `/terms`; version + effective date in the header; user must accept on first login (modal with checkbox, acceptance timestamp stored on their profile)
- **Privacy Policy**: at `/privacy`; version + effective date; linked from Terms, footer, and signup flow
- **Cookie Policy**: at `/cookies` (or section within Privacy); listed alongside any analytics/tracking used
- Footer of the app (and marketing site) links to all three
- If Terms are updated, show a banner requiring re-acceptance before the user can continue using the app

### Notification Preferences

- Push notification tier per urgency level (interrupt / ambient / silent) — user can downgrade but not upgrade beyond system tier
- Option to silence specific workflows (e.g., "never push-notify for `newsletter`")
- Email digest: toggle on/off, set frequency, set delivery address
- Notification preview: "Here's what an interrupt notification looks like"

### Onboarding / First-Run

Progress bar at top spanning all steps. Every step is resumable — if the user closes the browser mid-flow, they land back at the incomplete step next time they open the app. Incomplete onboarding resurfaces as a non-blocking contextual banner (not a modal) pointing to the exact step remaining.

- **Step 1 — Register your domain**
  - Single input: domain name. No skip — a domain is required to receive email.
  - On submit, immediately show all 4 DNS records in a clean table (MX + DKIM CNAME + SPF TXT + DMARC CNAME) with copy-to-clipboard on each value. All records are shown upfront because DNS is easier to do in one sitting.
  - Clearly mark MX as required now; the 3 sender records as "recommended — do these now, or we'll remind you later"
  - Background DNS polling every 10 seconds with a live per-record status indicator (spinner → green check as each one propagates). Auto-advance once MX is verified; sender records can still be pending.
  - "My DNS is propagating, come back later" escape hatch — saves progress, sends a reminder email.

- **Step 2 — Send yourself an email** *(the aha moment)*
  - Full-screen immersive step. No clutter. Large, calm UI.
  - Headline: *"Let's make sure everything is working."*
  - Show the user's new address (e.g. `you@yourdomain.com`) in a large, prominent pill with a one-tap copy button.
  - Instruction: *"Open Gmail, Outlook, or any email app — and send an email to this address. We'll show it here the moment it arrives."*
  - Below: an animated waiting state — subtle pulse or breathing animation around an empty inbox card. Not a spinner, not a loading bar. Something that feels alive and calm. Copy: *"Waiting for your email…"*
  - The moment the signal arrives (real-time via WebSocket or long-poll): the animation resolves, the card fills in with the email — sender name, subject, the AI-generated summary, workflow classification, and urgency badge — all exactly as it will appear in their real inbox.
  - Celebration moment: brief confetti burst or a satisfying check animation. Copy: *"It works. Your first email just arrived."*
  - Let the user hover/read the card for a moment, then a CTA appears: *"Continue →"*
  - The incoming email and any further ad-hoc tests the user sends are classified as `workflow: "test"` — the system auto-replies with a Bedrock-generated pong that riffs on whatever the user wrote. During onboarding the pong reply is shown in the waiting screen itself as a second card appearing below the original, reinforcing that two-way communication is working.
  - Edge cases: if no email after 3 minutes, gently offer help ("Didn't arrive? Check your MX record or try sending again.") with a re-check button and a "send a test from us instead" fallback that fires a system-generated `workflow: "test"` signal so they can still experience the moment even if their personal email is slow.

- **Step 3 — Set up sending** (skippable with clear consequence)
  - Shown only if the 3 sender records weren't verified in Step 1.
  - Plain-language explanation: *"To reply to emails and forward them to other addresses, we need 3 more DNS records. This also stops your replies landing in spam."*
  - Show the 3 records with live status indicators — same UX as Step 1.
  - "Skip for now" link is visible but secondary. If skipped, a persistent amber banner appears in Settings → Domains with the remaining records.

- **Step 4 — Choose your filter mode**
  - Three options presented as cards with icons and plain-language descriptions (not `notify_new` / `strict` etc. — use human names like "Ask me about new senders" / "Strict — approved senders only" / "Open — let everything through")
  - Default pre-selected; user can change later in settings.

- **Step 5 — You're ready**
  - Summary of what was set up (domain, filter mode, sender setup status)
  - Single CTA: *"Go to my inbox →"* — lands on the arc list, where the email from Step 2 is already waiting

### Global UX Notes

- **Urgency colour system** used consistently everywhere: `critical` = red, `high` = amber, `normal` = no accent, `low` = grey, `silent` = never shown
- **Workflow icons**: each of the 20 workflows needs a distinct icon (e.g., shield for `auth`, receipt for `invoice`, plane for `travel`, flask/beaker for `test`)
- **Signal ID prefix** (`SES#`, `SYS#`, `USR#`) indicates origin — could show a subtle badge on signals that were system- or user-created vs inbound email
- **Spam score** should surface as a warning on signals > 0.3 and a strong warning > 0.7; never shown as a raw number to end users — use labels like "Likely spam" / "Possible spam"
- **Arc grouping key** is deterministic per workflow (e.g. all Amazon order updates for order #123 thread together) — UI should not expose the key but should make the threading feel natural, like iMessage threads
- **`notice` workflow** arcs are blocked by default (SR-03) — they never reach the arc inbox; if SR-03 is disabled by the user they will be silent urgency (`priority.ts`) with notification suppressed (SR-07)
- **RBAC**: hide destructive actions (delete domain, remove user, edit rules) from `viewer` and `member` roles

---

## UI IDEAS (To Vet)

Creative feature ideas not yet committed to. Separate from the confirmed list above.

---

### Smart Action Buttons

The classifier already extracts structured `workflowData`. Extend this to surface one-tap CTAs directly on the arc row and signal card, without opening the email:

- `auth` → **Copy OTP** button on the arc row (code + countdown timer inline); one tap copies to clipboard; auto-detected from `workflowData.code`
- `package` → **Track Package** deep-link button; tracking number already in `workflowData`
- `payments` → **Pay Now** link if `workflowData.managementUrl` is present; **Download** if `workflowData.downloadUrl` is present
- `travel` → **Add to Calendar** (generates `.ics`); **Check In** link if within 24h of departure
- `job` → **Stage tracker** inline (Applied → Phone Screen → Interview → Offer) — user updates stage, stored as a label or urgency override
- `scheduling` → **Accept / Decline** if `workflowData.requiresResponse` is true; **Add to Calendar**

### Snooze / Remind Me Later

Hide an arc until a future time, then resurface it as if newly arrived.

- Snooze options: later today, tomorrow, next week, pick a date
- Snoozed arcs disappear from inbox and reappear at the chosen time with a `snoozed` badge
- Snooze list accessible via sidebar (like Gmail's Snoozed label)
- For `travel` arcs: offer "remind me 24 hours before departure" auto-snooze using `workflowData.departureDate`
- For `subscription` arcs: offer "remind me 7 days before renewal" using `workflowData.renewalDate`

### "Waiting For" Smart List

An auto-generated view of arcs where you've sent a reply but haven't received a response yet.

- Powered by `arc.sentMessageIds` being non-empty + no new inbound signal after the last sent message
- Configurable timeout: show as "waiting" if no reply after N days (default 3)
- Escalates urgency visually as time passes (e.g., > 7 days → amber "overdue" badge)
- Dismiss individually ("no reply expected") or snooze

### Morning Briefing

A daily digest view (separate from the notification email) surfaced inside the app on first open of the day.

- "Good morning — here's what needs your attention today"
- Sections: Critical & High urgency arcs → Action-needed arcs → Upcoming travel/appointments → Renewals due soon
- Dismissible; shows once per day
- Could double as the email digest if the user prefers to read it in-app

### Email Analytics Dashboard

Charts and stats so users understand their email landscape.

- Signal volume over time (line chart, filterable by workflow)
- Top senders by volume (table + bar chart)
- Spam score distribution (histogram — useful for tuning filter aggressiveness)
- Blocked vs delivered ratio over time
- Workflow breakdown pie/donut chart
- Peak email hours heatmap (day of week × hour of day)
- Rule effectiveness: how many signals each rule matched this month

### Bulk Actions

Select multiple arcs in the inbox and act on them together.

- Checkbox appears on hover/swipe
- "Select all" applies to current view
- Bulk: archive, delete, add label, remove label, change workflow
- Confirmation for destructive bulk operations with count ("Archive 23 arcs?")

### Pinned Arcs

Pin important arcs to the top of the inbox (or a specific view) regardless of sort order.

- Pin icon on hover; pinned arcs shown in a collapsible "Pinned" section at the top
- Max 5–10 pins per view to avoid overuse
- Pins are per-user not per-account (stored client-side or as a personal preference)

### Arc Timeline / Calendar View

A secondary view mode (toggle alongside list) that plots arcs on a calendar.

- Relevant for `travel`, `scheduling`, `subscription`, `healthcare` workflows
- Events plotted using `workflowData` dates (departure, appointment, renewal, due date)
- Week and month views
- Click an event → opens the arc detail
- Integrates with device calendar via CalDAV or ICS export

### Contact / Sender Profiles

Auto-built profiles for each eTLD+1 sender domain the user receives mail from.

- Profile card: domain logo, first contact date, total signals, signal breakdown by workflow, spam score history, filter mode for this sender, approved/blocked status
- Timeline of all arcs from this sender
- Quick actions: block domain, approve domain, apply a rule scoped to this sender
- "Similar senders" suggestion (domains that send similar workflow types)

### Keyboard-First Navigation

Full keyboard shortcut system, surfaced via a command palette (⌘K / Ctrl+K).

- `j` / `k` to navigate arc list; `Enter` to open; `Esc` to close
- `e` to archive, `#` to delete, `l` to label, `s` to snooze
- `/` to focus search
- `?` to show keyboard shortcut cheat sheet
- Command palette: fuzzy-search all views, arcs, labels, settings pages, and actions

### Receipt & Expense Tracker

A sub-view within the `invoice` and `order` workflows for expense management.

- Aggregate all invoices and receipts into a spreadsheet-style list
- Columns: date, sender, amount, currency, category (user-assigned), status (paid/unpaid)
- CSV export (compatible with accounting tools)
- Monthly / annual spend totals
- Optional: flag invoices that need action (unpaid, overdue)

### Integrations Hub

An official integrations page listing outbound webhooks and third-party connections.

- **Webhook**: user provides a URL + secret; all new signals (or filtered subset) POST as JSON — useful for feeding into Zapier, Make, n8n, custom apps
- **Slack**: post a message to a Slack channel when a `critical` or `high` urgency arc arrives
- **Linear / Jira**: create an issue from a `developer` or `support` arc (one-click or via rule action)
- **Notion**: save an arc summary as a Notion page
- **Google / Outlook Calendar**: sync `scheduling` and `travel` arcs as calendar events
- Integration status (connected / disconnected / error) on each card

### AI Assistant / Natural Language Query

A chat interface for querying your inbox without navigating manually.

- "Show me all unpaid invoices from this month"
- "What's the status of my Amazon order?"
- "Do I have any flights next week?"
- "Archive everything from newsletters I haven't opened in 30 days"
- Answers by querying arcs/signals via the existing API, then presents results inline or navigates to a filtered view
- Powered by Claude; should cite the specific arcs it's referring to (linkable)

### Arc Sharing

Generate a shareable read-only link to a specific arc or signal.

- Useful for escalating to a teammate who isn't in the account, or sharing a receipt with an accountant
- Link expires after a configurable duration (24h, 7 days, never)
- Optional password protection
- Shared view is stripped of other account data; shows only the selected arc + signals

### Public Changelog

A `/changelog` page in the app (and marketing site) showing product updates.

- Each entry: version/date, title, short description, optional screenshot or GIF
- Users can subscribe to changelog notifications (email or in-app)
- Linked from the support panel and the app footer
- Helps with trust-building and reducing support volume for "what changed?"

### Onboarding Email Import

Allow users to bulk-import historical emails from Gmail or Outlook via OAuth, classify them, and seed their arcs.

- OAuth flow to grant read access to the user's existing inbox
- Import runs async (background job); shows progress bar
- Classifier runs on imported emails exactly as it does for live SES emails
- Resulting arcs are tagged `imported` so users can distinguish from live mail
- Useful for users who want to migrate away from Gmail and start with full context

### Accessibility & Personalisation

- Full keyboard navigation (already covered above) + screen reader support (ARIA labels on all interactive elements)
- High-contrast mode toggle (separate from OS dark mode)
- Font size preference (small / medium / large)
- Density toggle: compact list (more arcs visible) vs comfortable (more whitespace)
- Colour-blind safe palette option for urgency colours (not just red/amber/grey — add patterns or icons as secondary indicator)

---

## DEVELOPMENT STRATEGY

- [ ] **Update engineering process docs** — document the bug/test-failure investigation protocol: when a bug or failing test is found, first identify *holistically* why the failure happened in the first place (root cause, not just the symptom). Then scan the entire codebase for every similar pattern — even locations that have no failing test — and fix them proactively. If no tests are failing for a similar pattern, treat that absence as a red flag and investigate why the coverage gap exists: is the pattern untested, or is the test itself wrong?
- [ ] **Never subvert TypeScript types in tests** — test code must use valid, real values for every typed field (e.g. `Workflow`, `WorkflowData`, discriminated unions). Casts like `as never`, `as any`, or `as unknown as T` in test stubs hide real problems: they allow tests to compile while masking that the stub doesn't actually conform to the contract the production code expects. When a test stub is hard to construct, that difficulty is a signal — either the type needs a factory/builder helper, or the interface needs to be reconsidered. Use `satisfies T` to verify shape without widening, and use real discriminant values so the processor's switch/case and rule-engine branches exercise the correct code paths.
- [ ] **Always type HTTP response bodies against the actual schema in tests** — casting `res.json()` to `Record<string, unknown>` (or `any`) in integration tests is the same mistake as an untyped stub: it silently discards the type contract and forces bracket notation (`body['field']`) with manual redundant casts everywhere. TypeScript cannot catch field-name typos (`body['id']` vs `body['accountId']`) or schema renames. The rule: import the zod-inferred type from `src/api/schemas.ts` (e.g. `import type { Account } from '../../src/api/schemas.js'`) and cast the parsed body to that type (`as Account`). Dot notation then works naturally, the compiler enforces field names, and the test doubles as a compile-time contract between the test and the OpenAPI schema. Corollary: `Record<string, unknown>` is a legitimate escape hatch only at real type-erasure boundaries (raw AWS SDK responses, runtime type guards, AST walkers) — never for a JSON payload whose shape is already described by a schema we own.
- [ ] **Never wrap an error with the same error kind** — each abstraction layer should wrap errors from lower layers using its own error type. `dbError(e)` is correct at the database boundary when `e` is a raw SDK exception, string, or a different error kind. It is wrong when `e` is already a `DbError` — that produces `{kind:db_error, cause:{kind:db_error}}` which is redundant and obscures the real cause. The processor layer uses `processorError(e)` to wrap whatever the inner layers return (`DbError`, `InvalidResponseError`, thrown exceptions). The rule: when you catch or check an error, wrap it with the error type that belongs to the current abstraction layer, not the one that belongs to the layer below.
- [ ] **Complete `toApiSignal` for the signal list endpoint** — `GET /accounts/:id/arcs/:arcId/signals` currently returns raw DB items instead of going through `toApiSignal`. Two gaps block it: (1) `toApiSource` maps `"signal"` and `"email"` sources to `"system"`, losing the distinction — review `Api.SignalSource` for what is only absolutely required from the DB source values; (2) review`toApiCalendarData` for the drops `method`, `veventUid`, and other calendar fields the frontend depends on, what does the front end actually use, and why, and how is that different from what we return on both accounts. Remember to apply `toApiSignal` in the list endpoint so both arc-list and signal-list go through their respective transforms.

---

## PRODUCT STRATEGY

Competitive analysis vs. Addy.io, SimpleLogin, ForwardEmail, Firefox Relay, Mailbox.org, Mailfence, Mailvelope, Thexyz, and others.

---

### Missing Features (gaps vs. competitors)

**High priority:**
- [ ] **PGP / end-to-end encryption** — Addy.io (paid), SimpleLogin, ForwardEmail, Mailvelope, and Mailfence all offer this. Privacy-conscious users treat it as table stakes. If added, must be free (see pricing strategy below).
- [ ] **Browser extension** — Addy.io, SimpleLogin, Firefox Relay, and DuckDuckGo all have one. Alias generation at the point of signup is the core UX for alias-focused users; the extension is also a free acquisition channel.
- [ ] **Mobile app** — Essential for the auth/OTP quick-copy workflow. Addy.io, SimpleLogin, and Firefox Relay all have apps. Without one, the OTP copy feature (our #1 differentiator) is only usable at a desktop.

**Medium priority:**
- [ ] **On-demand alias generation** — Catch-all + custom domains covers this technically, but there's no UI shortcut for generating `random123@yourdomain.com` at a click. All alias services have this as their primary action.
- [ ] **Snooze / remind me later** — Already in UI IDEAS above. Differentiates from pure forwarders; HEY and Superhuman both do this.
- [ ] **Calendar sync** (travel + scheduling workflows) — Export `.ics` or sync via CalDAV for travel/scheduling arcs. Already in UI IDEAS above.

**Low priority:**
- [ ] **Webhook outbound** — Already in UI IDEAS above. Power users and devs want to pipe signals into Zapier, Make, or custom apps. ForwardEmail offers this.

---

### Unique Selling Props (what no competitor does)

These are genuine moats — most are already built, just not marketed.

1. **AI email intelligence, not just routing** — Every competitor is a dumb pipe: email in → forward or drop. We classify into 14 semantic workflow types, extract structured data (order numbers, flight details, OTP codes, invoice amounts), generate summaries, and calculate urgency. No competitor does this. This is the most defensible moat.

2. **Arc threading by semantic similarity** — Everyone else shows raw email lists. We thread semantically via pgvector — all Amazon order updates for order #123 group together even when sender addresses vary. Closer to what HEY attempted but backed by vector embeddings.

3. **Smart action extraction at inbox-list level** — `workflowData` structured fields already exist. The "Smart Action Buttons" (copy OTP from inbox row, track package without opening email) is a killer UX feature no privacy or alias service offers. OTP copy is the #1 use case for alias services and nobody does it well today.

4. **Configurable filtering with global sender reputation** — Cross-account global sender reputation is unique. No service aggregates reputation signals across all users to bootstrap trust for new accounts. This compounds over time — network effect on spam protection.

5. **JSONLogic rule engine with per-address config** — No alias or forwarding service has real automation. Conditional rules, per-address filter mode inheritance, spam threshold overrides — this is closer to enterprise email security tooling than consumer alias services.

6. **Multi-user team accounts with RBAC** — Every competitor is single-user. Owner/admin/member/viewer roles open B2B use cases no alias service serves: small teams routing domain mail through one account, shared inboxes for support@, alerts@, etc.

7. **AI test-email pong** — Delightful onboarding moment. Sets tone immediately and demonstrates AI capability before the user has seen a single real email.

**Recommended positioning:** *"The email inbox that understands your email — not just forwards it."* We are not an alias service and not a privacy relay — we are a new kind of inbox that happens to own your domain's email routing. Compete on "how much does your inbox understand about your life", not "how many aliases can I have".

Secondary B2B pitch: *"The shared inbox for your domain, with team roles and audit logs."* No alias service goes here.

---

### Pricing Strategy

**Core philosophy:** Charge for volume, power, and teams — not for privacy or basic utility. Give away the things that create lock-in and trust. Every competitor charges for custom domains, catch-all, and reply-from-alias. Offering these free wins acquisition and minimises churn simultaneously.

#### Free tier (permanently free, no time limit)

| Feature | Rationale |
|---|---|
| 1 custom domain | Addy.io and SimpleLogin charge for this. It's our clearest acquisition hook and the strongest lock-in mechanism. |
| Catch-all on that domain | Competitors charge for catch-all. Core to our model — must be free. |
| Reply from your domain (Tier 2 DNS) | Competitors charge for this. Giving it free locks in the domain. |
| 14-workflow AI classification | This is the product. Paywalling AI makes us just another dumb forwarder. |
| Arc threading + summaries | Same reason — the product, not an upsell. |
| JSONLogic rules (up to 5) | Enough to get hooked; limit creates upgrade pressure. |
| Labels (unlimited) | Zero marginal cost, high stickiness. |
| All filter modes + spam threshold tuning | Core safety feature — charging for spam protection is tone-deaf. |
| 1 verified forwarding address | Enough to be useful. |
| Push + email notifications | Core feature — no paywall. |
| 90-day arc retention | Sufficient for personal use. |
| 30-day audit log | Free tier gets some audit; longer is a paid signal. |
| PGP encryption (when built) | Privacy is a trust signal, not a premium feature. |
| Browser extension (when built) | Free acquisition channel — never monetize directly. |

#### Paid tier (~$6–8/mo or $60/yr)

Things competitors charge for that we include, plus things only we can offer:

| Feature | Why paid |
|---|---|
| Additional domains (up to 5) | Direct SES identity cost per domain. Competitors charge $3–9/mo for 1 extra domain. |
| Rules (unlimited, vs 5 free) | Power users need this; casual users don't. |
| Arc retention (2 years, vs 90 days) | Storage scales with retention. |
| 1-year audit log | Compliance expectation for power users. |
| Email analytics dashboard | High-value, low-urgency — good paid upsell moment. |
| Snooze / Waiting For | Power user productivity; drives "aha" upgrade moment. |
| Morning briefing digest | Personalization at scale. |
| Webhook outbound | Developer/power user; compute cost per webhook. |
| Smart action buttons (OTP copy etc.) | Premium UX polish; strong upgrade motivator. |
| Verified forwarding (5 addresses, vs 1 free) | Volume limit to motivate upgrades. |
| Priority support | Standard paid-tier expectation. |

#### Team / Business tier (~$15–20/mo for up to 10 users, then per-seat)

| Feature |
|---|
| Everything in Paid |
| Up to 10 domains |
| Unlimited team members (per-seat after 10) |
| Shared inbox views across team |
| Full audit log (unlimited retention, CSV export) |
| Integrations (Slack, Linear, webhooks) |
| Data export (async JSON/CSV) |
| SLA / uptime commitment |

#### Strategic freebies — things competitors charge for that we must NOT charge for

- **PGP encryption** — if built, free. Privacy is not a premium feature.
- **First custom domain** — our anti-churn mechanism.
- **Catch-all** — trivially cheap at SES scale; makes us unbeatable on acquisition.
- **AI classification** — paywalling this makes us just another forwarder.
- **Spam threshold tuning** — charging for spam protection is a trust-breaker.
- **Browser extension** — free acquisition channel.



- [ ] **Revalidate embed-text uses HTML body first, not text body** — The current `buildEmbedText` sanitizes `rawTextBody`. But users see the HTML body in the UI. If we classify/embed based on the text body but display the HTML body, a phishing email could have innocent text body content while the HTML body contains malicious links/content that the user actually sees. The embed text builder should prefer the HTML body (stripped of tags) as the source of truth for classification and embedding, falling back to text body only when HTML is absent. This is a security-critical change.

- [ ] **Image handling strategy for email signals** — Decide how to handle images in emails: (a) auto-download and cache images at signal creation time (privacy risk: sender knows you opened the email via tracking pixels), (b) proxy images through our server on-demand (hides user IP but still loads content), (c) block all remote images by default with a user toggle to load (safest, Gmail-style), (d) strip tracking pixels but allow content images. Also decide: should we store image thumbnails for the arc list preview? Should we scan images for phishing (fake login buttons, QR codes to malicious URLs)?

- [ ] **Secure HTML email rendering** — Email HTML is untrusted content from arbitrary senders. The UI must render it safely without allowing XSS, script injection, CSS exfiltration, or form submission attacks. Options: (a) sandboxed iframe with `srcdoc` + restrictive CSP (`sandbox` attribute, no `allow-scripts`, no `allow-same-origin`), (b) server-side sanitization that strips all scripts, event handlers, forms, and dangerous CSS (e.g. `background-image: url()` for tracking) before storing/serving the HTML, (c) both — sanitize on ingest and sandbox on render. Also consider: should we rewrite all URLs to go through a redirect warning page? Should we strip `target="_blank"` or force all links to open in a new tab with `rel="noopener noreferrer"`? Should we offer a "view original" escape hatch that opens the raw HTML in a fully isolated tab?

---

## Frontend-Blocking Backend Changes (2026-06-12)

These items are required by the frontend before certain UI features can ship.




- [ ] **Calendar forwarding address verification** — when `defaultCalendarInviteForwardingAddress` is set via `PATCH /accounts/:id`, should we verify that the email address is reachable before activating forwarding? Options: (1) send a verification email with a confirmation link (same as forwarding address verification), (2) require the address to already be in the verified forwarding addresses list, (3) no verification (trust the user). Also: should new accounts have a default value for this field, or is it always null until explicitly configured? Currently SR-26 fires `forwardCalendarInvite` whenever a calendar signal is detected — if the address is unset, the action silently does nothing. Decide: should we warn the user in the UI that calendar forwarding is inactive until they set an address?



- [ ] **Gate `retentionDuration` setting by billing plan + handle downgrades** — when a user sets `retentionDuration` via PATCH /accounts/:id, validate against their current plan using `isWithinPlanLimit()`. Reject with 403 if they request a tier above what their plan allows. Additionally: when a plan downgrades (webhook from billing provider or manual admin action), coerce any existing `retentionDuration` values that exceed the new plan's max tier down to the plan max. Existing signals already stored with longer retention keep their TTL (data already paid for) but new signals get the coerced default.


- [ ] **Update forwarding verification email URL format** — the verification email currently generates `${APP_BASE_URL}/accounts/${accountId}/forwarding-addresses/${address}/verify?token=${token}`. Change to `${APP_BASE_URL}/settings?tab=forwarding&verifyAddress=${address}&token=${token}&accountId=${accountId}` so it lands directly on the Settings forwarding tab which auto-submits verification on mount.
- [ ] **Webhook rule save validation** — reject webhook rule saves unless a test request to the configured URL returns HTTP 200. The frontend sends a test request directly from the browser; the backend should also validate on save to prevent broken webhooks from being persisted.


- [ ] **Investigate: arc missing `retentionDuration`** — `arc-1cB9BgS4h223NGheYYQAW9737` (workflow: events, recipientAddress: awsaianddatadach@vortex.link, createdAt: 2026-06-17) has no `retentionDuration` set. This means the processor path that assigns retention didn't fire or the account had no retention configured. Check: (1) Was `resolveRetention()` called during processing? (2) Was the account's `retentionDuration` set at time of processing? (3) Is the arc missing retention because it was created before retention logic was deployed, or is there a code path that skips it?

# TODO

## Infrastructure / Terraform

- [ ] **Create skill: API parameter design — no booleans, orthonormal basis** — document the rule that API and configuration parameters must never use booleans, and that the full parameter set must form an orthonormal basis. A boolean collapses a dimension to two states and can never be extended without a breaking change; replace with an enum whose values name the distinct states explicitly. Orthonormal basis means the property set as a whole must satisfy: (1) orthogonal — each parameter controls exactly one independent dimension; no two parameters may encode overlapping state (e.g. `active: boolean` alongside `status: "active"|"inactive"|"pending"` is non-orthogonal — they share the active/inactive dimension and allow contradictory combinations); (2) complete — the parameters together span the full configuration space with no valid state left unreachable. Violations to flag: a boolean property next to an enum that already encodes the same distinction; two properties whose combined value space contains contradictions (`a=true, b="disabled"`); a property whose meaning changes depending on another property's value (hidden coupling). This applies to REST API bodies, Terraform resource arguments, environment variables, and database parameter groups.

- [ ] **Global Terraform/IaC rule: always validate parameter values against the live API spec before committing** — never assume a parameter's type or allowed values from training data or docs for an older version. Before writing any parameter value, web-search the exact parameter name + engine version to confirm the current type (boolean, enum, integer, string) and allowed values. Alternatively, use SDK/CLI validation: `aws rds describe-engine-default-cluster-parameters --db-parameter-group-family <family>` returns the authoritative allowed-values list for every parameter. Engine major versions can change parameter types entirely (e.g. `log_connections` changed from boolean to enum in PostgreSQL 18) which breaks applies with `InvalidParameterValue`.

- [ ] **Global Terraform rule: always use `create_before_destroy` + `name_prefix` on replaceable resources** — any resource that may be force-replaced (parameter groups, security groups, IAM roles, ACM certs, etc.) must set `lifecycle { create_before_destroy = true }` and use `name_prefix` instead of `name`. Using a fixed `name` with `create_before_destroy` causes a duplicate-name conflict; `name_prefix` lets AWS append a unique suffix so the new resource can be created before the old one is deleted. Without this, OpenTofu deletes the old resource first, which fails when other resources (e.g. an RDS cluster) are still attached to it.

## Processing & Architecture

- [x] **Review Step Function catch handlers and logging** — fixed: handler now throws on err() so SFN retries fire; added Catch blocks to all Task states routing to a TaskFailed terminal; added CloudWatch log group at ERROR level; IAM role updated with logs delivery permissions.
- [x] **Audit multi-write endpoints for DB-last ordering (arch rule #28)** — review all API handlers that perform writes to multiple systems (SES, S3, SQS, external services) alongside a DynamoDB write. Ensure the DB write happens last in every case. Known endpoints to check: `POST /domains` (done), `POST /accounts` (creates account + starts SFN), `POST /signals/:id/send` (sends via SES then updates status), `POST /signals/:id/quarantineResponse`, forwarding address verification flow, RSVP send. For each: confirm external writes are idempotent, DB write is final.
- [ ] **WebSocket signal stream** — implement the `/accounts/:id/signals/stream` WebSocket endpoint. The frontend already connects and falls back to polling on failure. Once implemented: authenticate the WS handshake (Authress token in query param or first message), emit `signal:created` events, and let the onboarding flow react in real-time instead of 3s-interval polling.
- [x] **Auto-block "think before you click" warning emails from service providers** — classified as `notice:security_awareness`; SR-03 (`block_hidden`) fires on all `system:workflow:notice` signals. Added `security_awareness` to `NoticeData.noticeType` and the workflow registry; sharpened the `notice` description to explicitly name these; annotated `alert` to exclude mass-sent awareness campaigns.
- [ ] **Promotions: extract expiry date and auto-archive when the offer lapses** — promotional emails (workflow `promotions` or `newsletter` with `workflowData.offerExpiry`) often contain a deal or discount that is meaningless after the expiry date. The classifier should extract the latest explicit expiry or validity date from the email body and store it as `workflowData.offerExpiry` (ISO-8601). A scheduled job (or TTL-based trigger) should auto-archive the arc once `offerExpiry` has passed, so the inbox is not cluttered with expired coupons. The arc should be archived (not deleted) so the user can still find it in All if needed. If no expiry date can be extracted with high confidence, do not set the field — do not guess.
- [ ] **Email forwarding loop detection and prevention** — forwarding rules can create infinite loops: if account A forwards to address X, and address X routes back into the same account (or another account that forwards back), signals will cycle forever. Two layers of protection needed: (1) **Setup-time**: when a user creates or edits a forwarding rule, check whether the rule's target address matches any domain registered to the same account — if it does, reject the rule with a clear error ("Forwarding to your own domain would create a loop"). Also check whether any existing rule already forwards *to* that same target from any label/alias that the new rule would also match. (2) **Runtime**: detect loops in-flight by inspecting the `References` / `X-Forwarded-To` / custom `X-SES-Loop` headers on inbound signals — if the message has already passed through this account or has been forwarded more than N times (e.g. 5), drop it with a non-retryable error and emit a `loop_detected` audit event. The setup-time check is the primary guard; the runtime check is the safety net for cases that slip through (e.g. two accounts that each forward to the other).
- [x] **Validate outbound sender domain is owned by the account** — before sending any email (reply, forward, auto-reply, invite, onboarding), verify that the `from` address domain is a domain registered to that account. An account that somehow constructs a request with `from: attacker@victim.com` must be rejected, not forwarded through SES. Check at the outbound send boundary: look up the sending account's registered domains and assert the `from` domain appears in that list. Return a 403 / reject the SFN task with a non-retryable error if it doesn't match. This is separate from DKIM/DMARC (which is DNS-level) — this is an application-layer authorisation check.

- [ ] **Deploy Bedrock guardrail and re-enable in classifier** — create `aws_bedrock_guardrail` resource in `email-catcher/infrastructure`, output the ID and version, then uncomment `guardrailIdentifier`, `guardrailVersion`, and `trace: "ENABLED"` in `src/classifier/classifier.ts`. Update `GUARDRAIL_ID` and `GUARDRAIL_VERSION` constants with the real values.
- [ ] **Auto-block sender on unsubscribe** — when `POST /arcs/:arcId/unsubscribe` succeeds (arc archived), persist a sender disposition of `block_hidden` for the sender eTLD+1 on the alias that received the email (same mechanism as quarantine response `block_hidden`). This prevents new mail from the same sender from creating a new arc. Without this, unsubscribing archives the current arc but a new email from the same sender next week creates a fresh arc in the inbox. The sender disposition write should use `accountDb.saveSender(accountId, recipientAddress, senderETLD1, "block_hidden")` — identical to the quarantine block path.
- [ ] **Outbound recipient validation (malicious user)** — prevent a malicious account owner from using the platform to spam arbitrary addresses. When a user composes/sends an email, validate that all To/CC/BCC recipient domains are either: (a) in the alias's approved senders list, or (b) domains the user has previously received email from (existing arc with that sender domain). If not, require explicit confirmation and rate-limit outbound to new domains. This is separate from the auto-reply gate (which protects against malicious inbound senders) — this protects against malicious platform users.
- [ ] **Review all locations where we might want to send emails to users** — domain health alerts, quarantine notifications, etc. Define what the notification strategy actually is (Web Push? In-app? Email digest?) before implementing any of them. Currently all email sending to users is removed — only WebSocket push for auth OTPs remains.
  - [ ] **Team invite email via SES** — the invite endpoint currently logs TRACK at `invite.email_pending_implementation` with the invite URL. Replace with an actual SES send once email templates and sender identity are decided.
- [ ] **Wire up onboarding follow-up emails via SES** — the account creation Step Function currently logs TRACK at each stage with the composed email content. Once we decide what emails to send (welcome, onboarding nudges, trial expiry warnings), replace the TRACK logs in `OnboardingTaskHandler` with actual SESv2 `SendEmail` calls. Requires deciding: email templates, sender address, unsubscribe mechanism, and which milestones trigger which email.

- [ ] **ClamAV attachment scanning on S3** — scan email attachments for malware after saving to S3. Tag objects with `scan-status: clean|infected|pending`. Frontend only offers download for `clean` objects; `infected` get a warning badge and no download link. Use ClamAV Lambda layer or bucketAV. Definitions must auto-update.
- [ ] **JMAP support (RFC 8620 + RFC 8621)** — expose the inbox as a standards-compliant JMAP server so any JMAP client (Apple Mail, Thunderbird, Mimestream) can connect directly. Requires: JMAP Session resource at `/.well-known/jmap`, Core/echo, Email/get, Email/query, Email/changes, Mailbox/get, Thread/get. Push notifications via EventSource (RFC 8620 §7). Outbound sending via EmailSubmission/set gated on Tier 2 sender setup. This is a separate API surface from the Hono REST API — likely its own Lambda or a new route prefix.
- [ ] **Revalidate embed-text uses HTML body first, not text body** — The current `buildEmbedText` sanitizes `rawTextBody`. But users see the HTML body in the UI. If we classify/embed based on the text body but display the HTML body, a phishing email could have innocent text body content while the HTML body contains malicious links/content that the user actually sees. The embed text builder should prefer the HTML body (stripped of tags) as the source of truth for classification and embedding, falling back to text body only when HTML is absent. This is a security-critical change.
- [ ] **Strip tracking pixels from HTML email bodies at ingestion** — implement the tracker detection heuristics from ADR 007. Parse HTML body during signal processing, remove tracker `<img>` elements (1×1, hidden, known path patterns), store sanitised HTML and `trackersBlocked` count on the signal. Content images remain untouched — browser loads them directly.
- [ ] **Move grouping key to a DynamoDB GSI** — `fastFindArcByAlternativeLookupKey` currently does a Query on a separate `GKEY#` item. Convert this to a GSI on the arc item itself: store the grouping key as an attribute on the arc (e.g. `gsi2pk = ACCT#{accountId}`, `gsi2sk = GKEY#{groupingKey}`) so the lookup is a direct GSI query against the arc item rather than a separate pointer item that must be kept in sync. This eliminates the dual-write (arc + grouping key item) and the orphan cleanup problem when arcs are deleted. The grouping key is derived deterministically from `deriveGroupingKey(workflow, workflowData, recipientAddress, senderETLD1)` — only non-null for workflows with deterministic threading (auth, content, status, payments, alert, package w/ orderNumber, support w/ ticketId).
- [ ] **Auto-handle vacation responder signals** — when an inbound signal is classified as a vacation/out-of-office auto-reply (detected via `Auto-Submitted: auto-replied` header, `X-Auto-Response-Suppress`, or content heuristics like "I'm currently out of the office"), automatically archive the arc and set urgency to `silent`. These signals carry no actionable content — they just confirm the recipient is away. The user shouldn't need to manually dismiss them. Consider adding a system label `system:auto-reply:vacation` and a system rule that applies `archive` + `silent` disposition, similar to SR-25 for security alerts.
- [ ] **Confirmation workflow (split from auth)** — introduce a new `confirmation` workflow type for emails that contain an `actionUrl` requiring user consent (email verification, newsletter double-opt-in, account activation). Currently these are classified as `workflow: "auth"` but they are fundamentally different from OTP codes. The confirmation flow: (1) classifier assigns `workflow: "confirmation"` when the email has an actionUrl but no code, (2) the confirmation workflow handler pushes a yes/no question to the client via WebSocket: `{ type: "confirmation", signalId, service, subject }`, (3) if user approves, the backend navigates the link inside an isolated Puppeteer Lambda (per-tenant isolation), (4) if user rejects, arc urgency is set to `silent`. Key design decisions: the client never sees or handles the URL (security), the backend executes in a sandboxed environment (no CSRF risk), and the interaction is bidirectional (push question → receive answer → execute). Requires: new workflow in WORKFLOWS array, classifier update, bidirectional WebSocket protocol, Puppeteer Lambda infrastructure, per-tenant isolation. **Separate spec needed.**
- [ ] **Retry Send for failed outbound messages** — when an outbound message (RSVP, forward, auto-reply) fails to send due to domain misconfiguration or transient SES errors, the system creates a failure signal on the arc (`domain_misconfiguration` or `send_failed`). The UI must expose a "Retry Send" action on these signals so the user can retry after fixing the underlying issue (e.g. completing domain DKIM/SPF setup). Transient SES failures (throttling, temporary bounce) should auto-retry via the SES Feedback SQS loop without user intervention. Permanent failures (domain not configured) require user action + explicit retry.
- [ ] **Calendar invite signals: rich attendee display + calendar forwarding provenance** — signals have a `type` field that is currently empty except when the signal is a calendar invite (iCal/ICS attachment parsed into `workflowData`). When `signal.type === "calendar_invite"` (or equivalent), the arc signal list row and signal detail card should render a dedicated calendar invite component rather than the standard email card. The component must show: event title, date/time with timezone, location (with map link if a physical address), organizer name/address, and a full attendee list with each person's RSVP status (`accepted` / `declined` / `tentative` / `needs-action`/pending) — rendered as named avatar chips with a coloured status indicator. Also expose whether the signal triggered a calendar forwarding action and, if so, where it was forwarded: currently this is an email address (e.g. a Google Calendar import address), but the field should be modelled as a typed integration reference `{ type: "email" | "caldav" | "google_calendar" | "outlook", target: string }` so future calendar integrations slot in without a schema change. Show the forwarding destination as a human-readable badge (e.g. "Added to Google Calendar via wparad@gmail.com"). Backend may need to record the forwarding destination on the signal or arc if it is not already stored.
- [ ] **Calendar invites created by user's calendar directly**, should be some way to receive and pass along a secured mechanism for calendar invites witohut the receiver knowing who sent it.
- [ ] **Consider what happens when someone already has configured an alias** — do aliases need to be cglobally unique...Yes! We should absolutely check this on the backend using the MX lookup (rather than our DDB), because MX records are the source of truth. And then also update the todo-ui to include both the MX check on the front-end as well as handling an error from the MX lookup or the backend on an already in use alias.
- [ ] **Review when `TemplateFunction.lastError` is cleared** — the API returns `lastError` on template functions when execution fails. Need to define when it gets cleared: on next successful execution? On template save? Currently persists indefinitely which may confuse users who already fixed the function. The frontend now displays this field — ensure the lifecycle is correct.
- [x] **Change spamScoreThreshold to 1–10 integer scale** — switched from 0–1 float to 1–10 integer on both Alias and AccountFilteringConfig. Processor divides by 10 internally when comparing to classifier output. Default is 9.
- [ ] **Audit OpenAPI spec for missing zod constraints** — the published OpenAPI spec at `/.well-known/api-catalog` does not include `min`/`max` constraints on `spamScoreThreshold` even though zod enforces them. Investigate why `@hono/zod-openapi` isn't propagating `.min()/.max()` to the generated spec. Audit all request schemas for missing constraints (enums, string lengths, numeric bounds, regex patterns) that exist in zod but are absent from the OpenAPI output. Once fixed, verify the frontend respects all published constraints (input validation, form limits). This is a trust issue — if the spec says "number" with no bounds, consumers can't build correct UIs without reading source code.
- [ ] **Define audit event response schema** — the `GET /accounts/:id/audit` endpoint returns `z.object({})` in the OpenAPI spec (undocumented contract). Add a proper zod schema matching the response shape (`{ events: AuditEvent[], pagination }`) with an `AuditEvent` schema declaring `eventId`, `accountId`, `userId`, `action`, `resourceType`, `resourceId`, `timestamp`, `before?`, `after?`. The frontend already consumes this endpoint and assumes a specific shape — the spec must formally commit to it.

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
| Quarantine response | POST `/:signalId/quarantineResponse` | Backend will support `block_hidden`, `block_reject`, `violate_report` |
| Draft signals | PUT, POST send, DELETE on `/arcs/:arcId/signals/:id` | Works |
| Aliases | GET/POST/PATCH/DELETE `/accounts/:id/aliases` | Senders via sub-resource |
| Account GET/PATCH | `/accounts/:id` | Works |

### ❌ Backend TODOs (from contract comparison)

- [ ] **Billing endpoints** — `GET /accounts/:id/billing` → `BillingInfo`, `POST /accounts/:id/billing/checkout-session` → Stripe Checkout URL, `POST /accounts/:id/billing/portal-session` → Stripe Portal URL. Requires Stripe integration.
- [x] **Migrate all routes to `app.openapi()` with `createRoute()` + zod schemas** — completed; only the trivial `GET /` redirect remains as a plain route.
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

- [x] **Include `senderAddress`, `recipientAddress`, and `subject` on Arc list responses** — denormalized onto the Arc DynamoDB item from each inbound signal; exposed as optional fields on the API Arc schema.

- [x] **Return user profile data on team member list** — `GET /accounts/:id/users` now resolves `name`, `email`, `picture` from Authress `GET /v1/users/:userId` in parallel and merges into the response.

- [x] **Include system rules in GET /accounts/:id/rules response** — the frontend Rules tab needs to display system rules (SR-01 through SR-26) as read-only cards that the user can enable/disable but not edit or delete. Currently `listRules` only returns user-created rules for the account. Include the system rules (from `SYSTEM_RULES` constant in `processor.ts`) in the response with a `system: true` boolean field on each rule object. User rules get `system: false`. The frontend will render system rules in a separate "System Rules" section with toggle-only UI (no edit/delete actions). The `PATCH /accounts/:id/rules/:ruleId` endpoint should accept status changes for system rules (storing the override per-account in DynamoDB) but reject any other field changes with a 403.

- [ ] **Calendar forwarding address verification** — when `defaultCalendarInviteForwardingAddress` is set via `PATCH /accounts/:id`, should we verify that the email address is reachable before activating forwarding? Options: (1) send a verification email with a confirmation link (same as forwarding address verification), (2) require the address to already be in the verified forwarding addresses list, (3) no verification (trust the user). Also: should new accounts have a default value for this field, or is it always null until explicitly configured? Currently SR-26 fires `forwardCalendarInvite` whenever a calendar signal is detected — if the address is unset, the action silently does nothing. Decide: should we warn the user in the UI that calendar forwarding is inactive until they set an address?

- [ ] **Remove `disabled` field from RuleAction** — the frontend no longer supports enable/disable per-action. If an action exists on a rule, it is always active. Remove `disabled?: boolean` from the `RuleAction` type, strip it from stored data on read, and reject it on write (or silently ignore it). The frontend has already removed the toggle UI.

- [ ] **Remove `disabled` field from RuleAction** — the frontend never needs per-action enable/disable. If an action exists on a rule, it is enabled. Remove the `disabled?: boolean` field from the `RuleAction` type in the API schema and database. Simplifies both the API contract and the rule evaluation logic in the processor.

- [x] **Remove `newAddressHandling` — use `defaultUnknownSenderPolicy` for new addresses too** — the `newAddressHandling` field (`auto_allow` | `block_until_approved`) on `AccountFilteringConfig` is redundant with `defaultUnknownSenderPolicy`. When no alias exists (first email to a new address), the processor should use `defaultUnknownSenderPolicy` directly instead of the separate two-value enum. In the processor (line ~1057): replace the `newAddressHandling === "block_until_approved" ? "quarantine_visible" : "allow_all"` branch with `accountCtx.filtering?.defaultUnknownSenderPolicy ?? "allow_all"`. Then deprecate `newAddressHandling` from the API schema, types, and DB. Keep the API field accepting the value silently (don't break existing clients) but ignore it in processing.

- [ ] **Domain DELETE cascade** — when `DELETE /accounts/:id/domains/:domainId` is called, ensure the backend also deletes all aliases on that domain, removes associated sender entries, and cleans up SES domain identity. The frontend assumes cascade-delete behavior. Also permanently block incoming emails for deleted domains (reject at SES receipt rule level or via a deny-list check in the processor).

- [ ] **Remove `deletionRetentionDays` — unify on `retentionDuration` (ISO 8601)** — the `deletionRetentionDays: number` field on `Account` is a legacy integer that duplicates what `retentionDuration` (ISO 8601 enum) already handles. The processor uses `retentionDays` for DynamoDB TTL calculation but `retentionDuration` for everything else — these are incoherent. Replace: (1) Remove `deletionRetentionDays` from Account type, DB schema, update method, and API request schema. (2) Use `retentionDuration` → `durationToSeconds()` for TTL calculation in the processor (already exists). (3) Remove `getAccountRetentionDays()`. (4) Update `ProcessorAccountContext` to drop `retentionDays`. (5) The `retentionDuration` on the Account controls the default — it's already wired via `resolveRetention()`. The TTL paths just need to use it.

- [ ] **Gate `retentionDuration` setting by billing plan + handle downgrades** — when a user sets `retentionDuration` via PATCH /accounts/:id, validate against their current plan using `isWithinPlanLimit()`. Reject with 403 if they request a tier above what their plan allows. Additionally: when a plan downgrades (webhook from billing provider or manual admin action), coerce any existing `retentionDuration` values that exceed the new plan's max tier down to the plan max. Existing signals already stored with longer retention keep their TTL (data already paid for) but new signals get the coerced default.

- [ ] **Redesign stats storage for time-series** — the current `incrementStats` only stores running totals (allowed/blocked/quarantined) as atomic counters on the account item. The frontend stats widget and stats view need daily granularity (last 365 days) and monthly rollups (before that). Redesign: (1) Write a daily counter item per account per day on each signal processed (`pk: ACCT#${accountId}#STATS`, `sk: DAY#2026-06-17`, with `allowed`, `blocked`, `quarantined` as ADD counters). (2) The `GET /accounts/:id/stats` endpoint queries the last 365 daily items + computes monthly aggregates for older data (or pre-aggregates monthly items via a scheduled job). (3) Return DTO: `{ totals: { allowed, blocked, quarantined }, daily: [{ date, allowed, blocked, quarantined }], monthly: [{ month, allowed, blocked, quarantined }] }`. (4) Migrate the existing running-total counters to seed the first daily item or keep them as a fast-path for the totals field.

- [ ] **Update forwarding verification email URL format** — the verification email currently generates `${APP_BASE_URL}/accounts/${accountId}/forwarding-addresses/${address}/verify?token=${token}`. Change to `${APP_BASE_URL}/settings?tab=forwarding&verifyAddress=${address}&token=${token}&accountId=${accountId}` so it lands directly on the Settings forwarding tab which auto-submits verification on mount.
- [ ] **Webhook rule save validation** — reject webhook rule saves unless a test request to the configured URL returns HTTP 200. The frontend sends a test request directly from the browser; the backend should also validate on save to prevent broken webhooks from being persisted.

- [ ] **Default `retentionDuration` for new accounts is P3M** — when creating a new account, set `retentionDuration: "P3M"` (3 months). The current code sets `deletionRetentionDays: 0` which is meaningless. After the legacy field removal, the account creation path should set the ISO 8601 default.

- [ ] **Investigate: arc missing `retentionDuration`** — `arc-1cB9BgS4h223NGheYYQAW9737` (workflow: events, recipientAddress: awsaianddatadach@vortex.link, createdAt: 2026-06-17) has no `retentionDuration` set. This means the processor path that assigns retention didn't fire or the account had no retention configured. Check: (1) Was `resolveRetention()` called during processing? (2) Was the account's `retentionDuration` set at time of processing? (3) Is the arc missing retention because it was created before retention logic was deployed, or is there a code path that skips it?

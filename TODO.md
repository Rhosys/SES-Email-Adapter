# TODO

- [ ] Detect forwarded emails and auto-tag with a label `original:john@gmail.com`, where `john@gmail.com` is the original recipient address the email was sent to before being forwarded into the system. Use `X-Forwarded-To`, `X-Original-To`, or `Resent-To` headers to extract the address. **Validation required**: add a test asserting that the `original:*` label is correctly attached to the signal/arc and that the address is extracted accurately from the header.
- [ ] **`"test"` workflow** — add to `WORKFLOWS` in `src/types/index.ts` and handle throughout the stack:
  - **Detection** (either condition is sufficient):
    1. The `signal.from` domain matches any domain registered to the account (user sending from their own domain, e.g. `me@mydomain.com` → account has `mydomain.com` registered)
    2. The `signal.from` address matches any user's email address on the account (user sending from their personal Gmail, Outlook, etc. while being a member of the account)
  - Detection runs in `processor.ts` post-classification as an override — if either condition matches, force `workflow: "test"` regardless of what the classifier assigned
  - **Base urgency**: `"high"` — the user is actively waiting for confirmation that their setup works; they need immediate feedback. This means interrupt-tier push notifications and top-of-inbox placement. Add this case to `baseUrgency()` in `priority.ts`. (`"critical"` could be argued but `"high"` is the right call — it gets the same interrupt push without sitting in the same tier as fraud alerts and password resets.)
  - **Auto-reply (the pong)**: after classification resolves to `"test"`, call Bedrock (Claude) with the email subject + body and ask it to write a short, funny, playful reply that riffs on whatever the user actually wrote — not a generic "pong" but something that reacts to the content. This is a post-classification side effect in the processor, similar to how the notifier fires today.
    - **Reply sender address** — conditional on whether the recipient's domain has completed Tier 2 sender setup:
      - If `domain.senderSetupComplete === true`: send from `signal.to` (the user's own domain address, e.g. `me@yourdomain.com`) — looks polished, proves their sending setup works end-to-end
      - If `domain.senderSetupComplete === false`: fall back to the system `NOTIFICATION_FROM` address (our own domain) — still sends a reply, just not from their domain yet; include a note in the reply body that they can complete sender setup to reply from their own address
    - Bedrock prompt shape: *"A user just sent a test email to check their inbox setup. Read their email and write a short, witty, warm reply that plays on whatever they wrote. Keep it under 3 sentences. Sign off as the system."*
    - Add the outbound message ID to `arc.sentMessageIds` so the arc correctly reflects that a reply was sent
  - **`TestData` interface**: minimal — `{ triggeredBy: "user" | "system" }` to distinguish user-sent tests from system-generated onboarding signals
  - **Classifier prompt**: add a `### test` section explaining the workflow and giving examples so the classifier can also detect obvious test emails independently (e.g. subject "test", body "testing 123") — the processor override handles the from-address logic, the classifier handles content-based detection
  - **Onboarding integration**: the system-generated fallback signal (fired if the user's email is slow during onboarding Step 2) is created as `workflow: "test"`, `TestData.triggeredBy: "system"`. A real email sent by the user during onboarding also classifies as `"test"` via the from-address logic and also gets the pong reply — the onboarding UI treats arrival of any `"test"` signal as success, regardless of which path triggered it.
- [ ] **Spam score threshold must be user-configurable, not hardcoded** — currently `isSpam = classification.spamScore >= 0.9` is hardcoded in `processor.ts`. This belongs in filter config so users can tune it:
  - Add `spamScoreThreshold: number` (0–1, default `0.9`) to the account-level filter config alongside the existing `filterMode` and `blockDisposition` settings
  - Add `spamScoreThreshold` to the per-address `EmailAddressConfig` as an optional override — same inheritance pattern as `filterMode` and `blockDisposition`: if set on the address, use it; otherwise fall through to the account default. All three filtering knobs (`filterMode`, `blockDisposition`, `spamScoreThreshold`) follow the same account → per-address override chain.
  - `blockDisposition.spam` already controls what happens when the threshold is crossed (block vs quarantine) — that pairing is correct, the threshold just needs to move out of the code and into config
  - Surface in UI: account-level in Settings → Account → Filtering; per-address in Settings → Email Addresses as an optional override (show "Using account default: 0.9" when not overridden, with an "Override" button to set a custom value)
- [ ] **FedCM (Federated Credential Management)** — add FedCM as a supported login method via `@authress/login`. FedCM is the browser-native credential management API (replacing third-party cookie-based federation). Authress supports it; we need to wire it up in the login flow so Chrome/Edge users can sign in with their saved Google/GitHub credentials without a redirect. Track it as an auth improvement item once the Authress integration is solid.
- [ ] **Block phishing-warning and terms-update emails by default** — these two classes of email are almost universally unwanted noise. No user toggle — just block them:
  1. **Phishing-warning notices** ("Beware of phishing — we will never ask for your password") — bulk security awareness emails sent by banks and SaaS services. Already classified as `notice` workflow. Block silently by default.
  2. **Terms-of-service / privacy-policy updates** — already classified as `notice` workflow. Currently silently auto-archived; upgrade to **block** (silent drop, not quarantine). Set `blockDisposition.notice: "block"` in the default account filtering config.
  - **Classifier prompt**: add examples under the `### notice` section distinguishing "bank phishing warning" from "actual phishing email" — the former is `notice`, the latter is e.g. `auth` with high spamScore. This prevents mis-classification.
- [ ] Add `DELETE /domains/:id` endpoint and handler — remove SES email identity if it exists, delete domain record from DynamoDB; inbound mail for that domain will stop routing to SES naturally
- [ ] **Two-tier domain setup model** — receiving and sending are separate concerns:
  - **Tier 1 — Receiving** (required to start): customer adds one MX record pointing their domain at the SES inbound endpoint. This is all that's needed to receive email into arcs. Domain is usable immediately after MX propagates.
  - **Tier 2 — Sending** (required only to reply or forward): DKIM CNAME + SPF TXT on bounce subdomain + DMARC CNAME. These are the 3 records that CNAME to our shared sending infrastructure (set up in `infra/ses.tf`). Prompted at the moment the user first tries to reply or forward, not before.
  - Onboarding walks through **both tiers** regardless — it's easier to do all DNS at once and there's no reason to defer it. But only Tier 1 is a hard gate; Tier 2 is strongly recommended and skippable with a reminder.
  - Domain model needs: `receivingSetupComplete: boolean`, `senderSetupComplete: boolean`, and per-record status rather than a single status field
  - API — domain endpoints always return all 4 DNS records (MX + DKIM CNAME + SPF TXT + DMARC CNAME) regardless of which tier has been completed; the UI uses the per-record verification status to decide what to emphasise, not which records to show. No split endpoint.
  - Reply and forward rule actions must gate on `senderSetupComplete`; if false, surface a modal prompting Tier 2 setup before proceeding
  - Update `infra/ses.tf` docs/comments to clarify that the BYODKIM terminus, bounce subdomain, and DMARC records are *our* infrastructure — customer Tier 2 CNAMEs point to ours
- [ ] **Domain health monitoring** — weekly proactive DNS check across all accounts and domains:
  - **Primary detection — scheduled DNS resolution**: SES only gives positive signals for identities we've registered; if a customer removes their MX record, email silently stops arriving and SES never tells us. The only reliable detection is us actively resolving DNS. EventBridge weekly rule → Lambda → scan all accounts → all registered domains per account → DNS-resolve each record that belongs to the setup tier the customer has completed → notify if degraded. **Do not write health status back to DynamoDB** — health is computed live, not cached, to avoid stale state discrepancies.
  - **Secondary detection — SES bounce/complaint feedback**: `feedback-processor.ts` already consumes SNS feedback events. If hard-bounce rate exceeds 5% in a rolling window for a given domain, trigger an on-demand DNS health check for that domain. Not a substitute for the weekly scan but catches real-world delivery failures between scheduled runs.
  - **SES reputation SNS event**: listen for `AmazonSesAccountReputationNotification` — if SES suspends a sending identity, notify all `owner` and `admin` users immediately.
  - **On degradation**: email and in-app notify all `owner` and `admin` users with domain name, which records are failing, and correct expected values. Do not halt inbound processing immediately — SES may still route for a period.
  - **On-demand re-check**: `POST /domains/:id/verify` runs a live DNS check immediately — powers the UI "Re-check DNS" button. The domain GET endpoint also resolves DNS on demand to return current per-record status: `{ name, type, value, currentValue?, status: "verified"|"failing"|"pending" }`. No stale cache, no stored health fields needed.

---

## UI APP

Everything the backend already knows that the UI needs to expose. Organised by screen/feature area.

---

### Inbox (Arc List)

The primary view. Arcs are the browsing unit — not individual emails.

- Each arc row shows: workflow icon, sender name/domain, AI-generated summary, urgency badge, last signal timestamp, label chips
- Urgency drives visual prominence: `critical` = red/bold, `high` = orange, `normal` = default, `low` = muted, `silent` arcs are never shown
- Arcs with `sentMessageIds` (user has replied) should show a "replied" indicator — the backend already promotes urgency to `high` on these, the UI should also visually distinguish them
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
- `original:john@gmail.com` label (forwarded email detection) should be surfaced prominently on the signal card, not buried in the label chip row
- Workflow-specific structured data panels — each workflow has rich `workflowData` fields the UI should render as a card rather than raw JSON:
  - `order` → order number, tracking link, items list, estimated delivery, status
  - `invoice` → amount, due date, invoice number, download link
  - `travel` → flight number, departure/arrival, confirmation code, boarding pass link
  - `auth` → OTP/magic link action button (copy code, open link), expiry countdown
  - `financial` → amount, account last 4, transaction date, `isSuspicious` flag (bank has explicitly flagged unusual/unauthorized activity — renders as a red "Fraud alert" banner on the card; drives `critical` urgency)
  - `job` → company, role, stage (applied / interview / offer), action required flag
  - `subscription` → service name, renewal date, payment failed flag, action CTA
  - `healthcare` → appointment date, provider, action required flag
  - `developer` → service, severity, requiresAction flag, error message snippet
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
  - `admin`: create/edit rules, manage domains, forwarding addresses, email configs, notification settings
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
  - Label: created, renamed, color changed, deleted
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
- **`notice` workflow** arcs are `silent` urgency and auto-archived — they should not appear in the main inbox; accessible via Archive view only
- **RBAC**: hide destructive actions (delete domain, remove user, edit rules) from `viewer` and `member` roles

---

## UI IDEAS (To Vet)

Creative feature ideas not yet committed to. Separate from the confirmed list above.

---

### Smart Action Buttons

The classifier already extracts structured `workflowData`. Extend this to surface one-tap CTAs directly on the arc row and signal card, without opening the email:

- `auth` → **Copy OTP** button on the arc row (code + countdown timer inline); one tap copies to clipboard; auto-detected from `workflowData.code`
- `order` → **Track Package** deep-link button; carrier + tracking number already in `workflowData`
- `invoice` → **Pay Now** link if `workflowData.paymentUrl` is present
- `travel` → **Add to Calendar** (generates `.ics`); **Check In** link if within 24h of departure
- `job` → **Stage tracker** inline (Applied → Phone Screen → Interview → Offer) — user updates stage, stored as a label or urgency override
- `subscription` → **Renew** or **Cancel** deep-link if `workflowData.manageUrl` is present

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

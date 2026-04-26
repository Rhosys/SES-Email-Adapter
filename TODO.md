# TODO

- [ ] Detect forwarded emails and auto-tag with the full source email address (e.g. `original:john@gmail.com`), where `john@gmail.com` is the original recipient address the email was sent to before being forwarded into the system. Use `X-Forwarded-To`, `X-Original-To`, or `Resent-To` headers to extract the address.
- [ ] API must return full DNS record list when user registers a domain (4 branded CNAMEs)
- [ ] Add `"set_urgency"` as a `RuleActionType` and `Arc.urgencyOverride` for user-configurable urgency overrides (deferred)

---

## UI APP

Everything the backend already knows that the UI needs to expose. Organised by screen/feature area.

---

### Inbox (Arc List)

The primary view. Arcs are the browsing unit — not individual emails.

- Each arc row shows: workflow icon, sender name/domain, AI-generated summary, urgency badge, last signal timestamp, label chips
- Urgency drives visual prominence: `critical` = red/bold, `high` = orange, `normal` = default, `low` = muted, `silent` arcs are never shown
- Arcs with `sentMessageIds` (user has replied) should show a "replied" indicator — the backend already promotes urgency to `high` on these, the UI should also visually distinguish them
- Arc status filter tabs: **Active** / **Archived** / **Deleted** (maps to `Arc.status`)
- Swipe/hover actions: archive, delete, label
- Inline "unread" state (client-side or via a future `Arc.readAt` field)
- Pagination via cursor (`lastEvaluatedKey`) — infinite scroll or Load More
- Empty states per view/filter with helpful copy

### Arc Detail (Signal Thread)

Drill-in from inbox. Shows all signals in the arc as a chronological thread.

- Thread header: workflow, sender eTLD+1, recipient address, arc urgency, current labels
- Each signal card shows: from, to, cc, subject, received timestamp, AI summary, spam score (if > 0.3, show warning indicator), body (text or HTML rendered in sandboxed iframe), attachments list
- `original:john@gmail.com` label (forwarded email detection) should be surfaced prominently on the signal card, not buried in label chips
- Workflow-specific structured data panels — each workflow has rich `workflowData` fields the UI should render as a card rather than raw JSON:
  - `order` → order number, tracking link, items list, estimated delivery, status
  - `invoice` → amount, due date, invoice number, download link
  - `travel` → flight number, departure/arrival, confirmation code, boarding pass link
  - `auth` → OTP/magic link action button (copy code, open link), expiry countdown
  - `financial` → amount, account last 4, transaction date, fraud alert flag
  - `job` → company, role, stage (applied / interview / offer), action required flag
  - `subscription` → service name, renewal date, payment failed flag, action CTA
  - `healthcare` → appointment date, provider, action required flag
  - `developer` → service, severity, requiresAction flag, error message snippet
- AI-suggested labels shown with one-click accept
- User can manually override workflow classification (dropdown)
- User can manually add/remove labels
- "Reply" action (composes outbound email, adds to `sentMessageIds`)
- Signal status badge for blocked/quarantined signals within a thread

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

- List registered domains with status (active / pending DNS verification)
- Register new domain (enters domain name)
- After registration, show the **4 DNS records** to add:
  1. `mail._domainkey.{domain}` CNAME → DKIM verification
  2. `bounce.{domain}` MX → SES bounce handling
  3. `bounce.{domain}` TXT → SPF record
  4. `_dmarc.{domain}` CNAME → DMARC policy
- Copy-to-clipboard buttons for each record value
- DNS verification status polling (check marks as records propagate)
- Delete domain

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

- Step 1: Register your domain (or skip if using a system address)
- Step 2: Add DNS records (copy-paste with status polling)
- Step 3: Choose default filter mode
- Step 4: Create your first view or label
- Progress indicator; can resume later

### Global UX Notes

- **Urgency colour system** used consistently everywhere: `critical` = red, `high` = amber, `normal` = no accent, `low` = grey, `silent` = never shown
- **Workflow icons**: each of the 19 workflows needs a distinct icon (e.g., shield for `auth`, receipt for `invoice`, plane for `travel`)
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

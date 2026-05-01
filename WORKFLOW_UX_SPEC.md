# Workflow UX Spec

Implementation instructions for the app UI repo. One workflow per section.
Exhaustive. Treat this as the source of truth for how each email type looks, behaves, and innovates.

---

## auth

### What this workflow is

OTPs, magic links, password resets, 2FA codes, email verification links. The user received this because they (or someone else) triggered an authentication action somewhere. The email contains either a short code to type in or a link to click. It expires — usually in 5–30 minutes.

The defining characteristic: **time is the enemy.** Every design decision in this workflow should serve one goal — get the code or link into the user's hands before it expires, with zero friction.

### Data shape

```ts
interface AuthData {
  workflow: "auth";
  authType: "otp" | "password_reset" | "magic_link" | "verification" | "two_factor" | "other";
  code?: string;           // extracted OTP/code, e.g. "482931"
  expiresInMinutes?: number;
  service: string;         // e.g. "GitHub", "Stripe", "Google"
  actionUrl?: string;      // the link to click (magic links, password resets)
}
```

### Urgency

Always `critical`. Push priority: `interrupt`. No exceptions — auth emails always warrant a popup notification. Even if the user explicitly downgraded their push preference, `critical` is the floor (UI may allow silencing non-critical workflows but not critical ones).

---

### Arc list row

**Layout:** Single-row card. No multi-line summary. Everything the user needs fits in the row itself.

**Left:** Shield icon (filled, not outline). Use a distinct colour from all other workflow icons — deep blue or indigo works well. Do not use red for the icon itself; red is reserved for the urgency badge. The icon should feel secure/official, not alarming.

**Centre:**
- **Service name** in bold: "GitHub", "Stripe", "Google". Derived from `service`.
- **Auth type label** in muted text below: "One-time code", "Password reset link", "Magic link", "Verification link", "Two-factor code". Map from `authType`:
  - `otp` → "One-time code"
  - `two_factor` → "Two-factor code"
  - `password_reset` → "Password reset link"
  - `magic_link` → "Magic link"
  - `verification` → "Verification link"
  - `other` → "Authentication email"

**Right side — primary action block.** This is the most important part of the row. Do not hide these actions behind a click-to-open. Surface them directly:

1. **If `code` is present (OTP/2FA):**
   - Display the code in a monospace pill: `[ 482 931 ]` — space in the middle if 6 digits, for readability.
   - Below the code: a **live countdown timer** if `expiresInMinutes` is set. Format:
     - > 5 min: green, shows "Expires in 12m"
     - 2–5 min: amber, shows "Expires in 3m 42s" (switches to seconds once under 5 min)
     - < 2 min: red pulsing, shows "Expires in 58s"
     - Expired: grey static, shows "Expired" — arc immediately auto-archives on expiry (see below)
   - **Copy button** adjacent to the code pill. Icon: clipboard. No label text needed. On click: copies `code` to clipboard, shows a brief "Copied!" tooltip (1.5s), then auto-dismisses. Do NOT navigate away or open anything.

2. **If `actionUrl` is present and no `code` (magic link, password reset):**
   - Single CTA button: **"Open link"** (or "Reset password" for `password_reset`, "Verify email" for `verification`).
   - Countdown timer below button, same rules as above.
   - Opens in new tab. After click, mark the arc as read (client-side state).

3. **If both `code` and `actionUrl` are present:**
   - Show the code pill + copy button as primary.
   - Below it, a small secondary text link: "Or open link →" — less prominent, same new-tab behaviour.

4. **If neither `code` nor `actionUrl` exists:**
   - Fall back to the standard arc row format with urgency badge. No special action block.

**Urgency badge:** Red "!" or "CRITICAL" chip — always present for auth arcs. Position: top-right of the row.

**Timestamps:** "Just now", "2m ago", "14m ago" — relative, auto-refreshing every 30 seconds.

**Unread indicator:** Bold sender text + left accent bar (2px red stripe on the left edge of the card).

---

### Arc detail (signal thread)

The detail view is less critical than the row for auth — by the time the user taps in, they probably already copied the code. But it should still be clean.

**Thread header:**
- Service name + auth type in large text.
- Countdown timer (same visual rules as row) pinned to the top of the header. If expired, show "This code has expired" in a red banner spanning the full width.
- Copy button or Open link button — same as row, but larger and more prominent.

**Signal card (the email body):**
- Render HTML in a sandboxed iframe as normal.
- If the body contains the OTP code as a visible number, do NOT try to highlight or extract it again from the rendered HTML — the extracted `code` from `workflowData` is authoritative. Rendering the body is fine but secondary.

**No reply button.** Auth arcs do not support reply. The reply composer must not appear for this workflow. There is nothing to reply to.

**No archive suggestion.** The system auto-archives; the user should not feel obligated to do anything.

---

### Auto-archive on expiry

When `expiresInMinutes` is known, the arc auto-archives at `signal.receivedAt + expiresInMinutes`. This is computed by the processor (scheduled job or TTL) — but the UI must also handle it gracefully:

- If the user has the arc open when it expires: replace the action block with a grey "This code has expired" state. Do not close the view. Do not navigate away. Just update in place.
- If the arc is in the list when it expires: the countdown hits zero, shows "Expired" in grey, then the row fades out and disappears from the Default view within 2–3 seconds (smooth transition, not a jarring jump). It remains accessible in Archive.
- If the user has notifications enabled and the arc expires unread: no additional notification is sent for expiry — the original interrupt notification was the only one. Do not spam.

---

### Notification behaviour

When a new `auth` signal arrives:
- **Push:** Interrupt-tier. Notification title: `{service}` (e.g. "GitHub"). Notification body: the code if present ("Your code: 482 931"), or "Tap to open your reset link." Deep-links directly to the arc.
- **Email digest:** Auth arcs are never included in digests. They expire; a digest is useless.
- **In-app banner:** If the app is open, show a top-of-screen banner (non-blocking) with the code and a copy button. The banner auto-dismisses after 30 seconds or when the code is copied.

---

### Default view behaviour

Auth arcs appear at the **very top** of the Default view, above all other arcs, regardless of sort order. They are the highest-urgency item in the inbox — they should always be immediately visible. Once expired, they drop out of Default into Archive automatically.

If multiple auth arcs are active simultaneously (user is logging into two services at once), each appears as a separate row. Do not merge them — merging auth arcs is dangerous. Each OTP is for a specific session.

---

### Where to innovate

**In-app OTP banner:** When a new auth signal arrives and the user already has the app open, show a floating banner at the top of the screen — regardless of what view they're on — with the code pre-displayed and a copy button. The user should not have to navigate to their inbox to get the code. This is the single highest-ROI UX improvement for this workflow: OTP in hand without any navigation.

**Auto-copy with permission:** If the user has granted clipboard write access and the app is in the foreground, offer an opt-in setting: "Automatically copy one-time codes to clipboard when they arrive." With this on, the code is copied the moment the signal is processed. A toast confirms: "Code copied from GitHub." This is the fastest possible path from email to code.

**Smart expiry snooze:** When a password reset link arrives and the user doesn't click it within 30 minutes, surface a gentle prompt: "Your GitHub password reset link may be expiring soon. Resend it?" with a direct link to GitHub's "forgot password" page (if extractable from the email). This is speculative — the link may still be valid — but it reduces the friction of the common failure mode (user gets distracted, link expires, has to redo the flow).

**Repeated failed auth detection:** If three or more `auth` arcs arrive from the same `service` within 10 minutes without any of them being interacted with (code not copied, link not clicked), surface a warning: "You've received multiple login codes from GitHub. Did you request these?" with a CTA to the service's security page. This is a useful security signal — either the user is in a login loop or someone else is requesting codes.

---

## conversation

### What this workflow is

Human-to-human email. A real person wrote this, by hand, to the user. It is not a notification, not a receipt, not a system alert — it is correspondence. The user may need to read it, think, and reply. Or they may glance and file it. The defining characteristic is that the sender expects a human response, or at minimum a human to have read it.

This is the closest analogue to iMessage or a DM. The inbox should treat it accordingly: thread-first, reply-first, conversation-centric. The email body matters more here than in any other workflow — this is the one case where reading the full text is often necessary.

### Data shape

```ts
interface ConversationData {
  workflow: "conversation";
  senderName?: string;
  isReply: boolean;          // true if this is a reply to a prior message
  threadLength?: number;     // total signals in the arc so far
  sentiment: "positive" | "neutral" | "negative" | "urgent";
  requiresReply: boolean;
}
```

### Urgency

Derived from `sentiment` and `requiresReply`:
- `requiresReply: true` + `sentiment: "urgent"` → `high`
- `requiresReply: true` + `sentiment: "negative"` → `high`
- `requiresReply: true` + any other sentiment → `normal`
- `requiresReply: false` → `normal` (or `low` if `sentiment: "positive"` and not a reply chain)

If the arc has `sentMessageIds` (user has replied before), the priority calculator promotes urgency to at least `high` regardless of sentiment — any established back-and-forth is worth immediate attention.

---

### Arc list row

**Left:** Chat bubble icon — filled bubbles to suggest dialogue, not monologue. Use a neutral colour (slate or graphite) — this is not an alarm, it is correspondence.

**Centre:**
- **Sender name** in bold. Use `senderName` from `workflowData` if present; otherwise `signal.from.name`; otherwise the email address local part. Never show the raw email address as the primary label — the name is what matters here.
- **Subject line** as the secondary line, muted text, truncated to one line.
- **AI summary** as the tertiary line — this is the most valuable piece. A one-sentence distillation of what the person actually wrote, e.g. "Asking about the Q3 contract renewal timeline and whether you're available for a call Friday." The summary must be specific, not generic ("You received an email from..."). Muted grey text.

**Right:**
- Timestamp: "2h ago", "Yesterday", "Mon" — relative, switching to day-of-week after 24h, then date after 7 days.
- If `requiresReply: true`: a small "Reply needed" chip in amber. Keep it subtle — a chip outline, not a filled badge. This signals intent without being loud.
- If `isReply: true` and this is a continuation of an existing thread: a reply-arrow indicator (↩) in the timestamp area.
- Thread depth indicator: if `threadLength > 1`, show a small "3 messages" count in muted text — similar to Gmail's thread count. Tapping the arc opens the full thread.

**Urgency badge:** Only show the urgency badge if `high` or above. `normal` conversation arcs should not carry a badge — it creates noise. The "Reply needed" chip is enough signal.

**Sentiment indicator (subtle):** Consider a 2px left border colour that reflects sentiment without being alarming:
- `urgent` → amber border
- `negative` → light red border
- `positive` → light green border
- `neutral` → no border / default grey

This is ambient information — it helps the user triage a list of conversations at a glance without requiring them to read summaries.

---

### Arc detail (signal thread)

**Thread header:**
- Sender name + email address.
- Thread subject.
- `requiresReply: true` → show a persistent "Reply needed" chip in the header, with a scroll-to-composer button.

**Signal cards:** Each signal in the arc rendered as a sequential message card — chronological, oldest first. Layout should feel like an email thread viewer (similar to Gmail's conversation view), not a list of unrelated emails.

Each card shows:
- From / To / CC in collapsed form ("From: Alice <alice@acme.com>") — expandable.
- Sent time (exact datetime on hover, relative by default).
- HTML body rendered in a sandboxed iframe. For `conversation`, the body is primary — do not collapse or truncate it by default. Users are here to read.
- If `spamScore > 0.3`: show a "Possible spam" indicator on the card — amber warning icon with tooltip "This message has a higher-than-normal spam score." Do not suppress the email, just flag it.

**Reply composer:**
Opens inline at the bottom of the thread, below all signal cards. It does not replace or overlay anything — it appends to the thread view.

- **From field:** Domain dropdown (Tier-2-complete domains only) + local part input. See reply composer spec in TODO for full behaviour.
- **To:** Pre-filled with `signal.from.address` (the person who wrote to us).
- **Subject:** Pre-filled with `Re: {original subject}`. User can edit.
- **Body:** Blank by default for `conversation`. Do NOT pre-fill with a quoted version of the incoming email — that is email client behaviour and creates noise. If the user wants to quote, they can copy-paste.
- **Send:** Calls the reply API. On success: new signal card appears in the thread (with a "Sent" indicator), composer collapses. `arc.sentMessageIds` is updated — this drives urgency promotion for future signals.

**No auto-archive on reply.** Conversations are ongoing; replying does not close them. The user archives manually when the conversation is done, or a rule can archive after N days of silence.

---

### Threading behaviour

Arc grouping for `conversation` is vector-similarity-based — the processor uses embedding similarity on sender identity and subject to decide whether a new signal extends an existing arc or starts a new one.

**Practical rules the UI must handle:**
- Multiple signals in one arc appear as a thread (chronological message list).
- `isReply: true` on a signal means it continues an existing thread — never display it as a standalone arc.
- If the classifier gets it wrong and two unrelated conversations end up in the same arc, the user can split them via a "Move to new arc" action (future feature, but design the arc detail to accommodate it — perhaps a context menu on individual signal cards).

---

### "Waiting for reply" state

When `arc.sentMessageIds` is non-empty (user has replied) and no new inbound signal has arrived after the last sent message:

- After **3 days**: show a subtle amber dot on the arc row — not a badge, not text, just a small indicator that time has passed without response. Tooltip: "No reply in 3 days."
- After **7 days**: amber dot becomes a "7d" chip. Still subtle. The user notices it in their normal flow.
- After **14 days**: chip reads "2w, no reply". At this point also add the arc to the auto-generated "Waiting For" smart list (see TODO for that feature spec).
- User can dismiss the indicator per-arc: "I don't expect a reply" — stores a `noReplyExpected: true` flag on the arc (client-side or server).

**Do not send push notifications for the waiting state.** The dot/chip is enough. This is ambient information, not an alert.

---

### Default view behaviour

`conversation` arcs appear in the default urgency-sorted order in Default view. No special pinning or elevation unless urgency is `high`. They should feel like normal inbox items — because they are.

`sentiment: "urgent"` arcs do get a subtle priority boost in the sort (within the same urgency tier, more-urgent sentiment sorts higher). The exact sort key: `urgency DESC, sentiment_score DESC, lastSignalAt DESC` where `sentiment_score` maps urgent=3, negative=2, neutral=1, positive=0.

---

### Notification behaviour

- **Push:** `high` urgency → interrupt tier. `normal` → ambient tier (badge only, no popup).
- **Digest:** Include all `conversation` arcs with `requiresReply: true` that the user has not replied to. Group under "Needs your reply" section of the digest.
- **In-app:** Standard unread indicator (bold text, left accent bar). No floating banner — conversations are not time-critical enough to interrupt the user mid-flow.

---

### Where to innovate

**AI reply drafts:** When `requiresReply: true`, offer a "Draft a reply" button in the arc detail. This calls Bedrock with the full email thread and returns a draft reply in the composer body. The draft is clearly marked as "AI draft — review before sending." The user edits, personalises, and sends. This is the highest-impact feature for this workflow — the reason people want an AI inbox is to reduce the cognitive load of replying to non-trivial emails.

The prompt shape: *"You are helping {userName} reply to this email thread. Write a first-person reply that is warm, professional, and directly answers any questions asked. Keep it concise. Do not start with 'I hope this email finds you well.' Here is the thread: {thread}"*

The draft should appear in the composer body, not as a separate UI element. The user should feel like they're editing their own draft, not accepting an AI suggestion.

**Smart reply chips (fast responses):** For short, simple emails where `requiresReply: true` and `threadLength === 1`, surface 2–3 one-tap reply options above the composer — similar to Gmail Smart Reply. Examples: "Sure, let's do it.", "I'll get back to you on this.", "Thanks, noted." These are for quick acknowledgements, not substantive replies. Never show smart chips for long threads or negative sentiment — they feel dismissive in context.

**Conversation health signal:** For arc threads with `threadLength > 5` and no `sentMessageIds` (user has been receiving but never replying), show a gentle note: "You've received 6 messages in this thread without replying." This surfaces conversations where the user may have intended to respond but never did. Non-blocking, dismissible.

---

## crm

### What this workflow is

Sales outreach, business proposals, client emails, follow-ups, contract discussions. The distinguishing feature: this is email sent by someone who has a commercial or professional interest in the user's response, and the user is in a decision-making or gatekeeping role. It could be a cold sales pitch, a proposal from a vendor, a follow-up from a client, or a contract to review.

Unlike `conversation`, where the relationship is peer-to-peer, `crm` emails carry an inherent asymmetry — the sender wants something. The user's primary decision is: engage, dismiss, or route to someone else. The inbox should make that three-way decision as fast as possible.

### Data shape

```ts
interface CrmData {
  workflow: "crm";
  crmType: "sales_outreach" | "follow_up" | "client_message" | "proposal" | "contract" | "support";
  senderCompany?: string;
  senderRole?: string;
  dealValue?: number;
  currency?: string;
  urgency: "low" | "medium" | "high";
  requiresReply: boolean;
}
```

### Urgency

Mapped from `CrmData.urgency` (note: this is the CRM-context urgency, separate from `ArcUrgency`):
- `crmType: "contract"` or `"proposal"` → arc urgency `high` (these need a decision)
- `urgency: "high"` → arc urgency `high`
- `urgency: "medium"` → arc urgency `normal`
- `urgency: "low"` → arc urgency `low`
- Cold `sales_outreach` with `urgency: "low"` and `requiresReply: false` → arc urgency `low`

The default for unsolicited outreach should be low unless the sender has previously corresponded (existing arc in `sentMessageIds`).

---

### Arc list row

**Left:** Briefcase icon — distinct from `job` (which uses a person+briefcase combination). Use a business-neutral colour: deep teal or slate blue. The icon should feel professional and intentional.

**Centre:**
- **Sender company** (`senderCompany`) in bold as the primary label. If absent, fall back to `signal.from.name`. Company > person name for CRM — the institution matters more than the individual in most commercial contexts.
- **Sender role** in muted text if present: "Head of Partnerships at Acme Corp". If both `senderCompany` and `senderRole` are present, show: "[Role] at [Company]".
- **AI summary** as the third line: one sentence describing what they want or are offering. E.g., "Proposing a 6-month infrastructure contract at $48k/year, asking for a call this week." Make it concrete and specific — this is what lets the user triage without opening the email.

**Right:**
- Timestamp (same relative format as `conversation`).
- If `dealValue` is present: a deal value chip — e.g., "$48,000" in a muted green chip. This is ambient information that helps the user decide how much attention to give before even reading the summary. Show currency alongside: "$48k USD".
- If `requiresReply: true`: "Reply needed" chip (same amber outline as `conversation`).
- Follow-up count: if this arc has received multiple signals from the same sender without a reply, show a small count: "4 follow-ups". This is a signal that the sender is persistent.

**Urgency badge:** Show for `high` only. `low` outreach arcs should not carry any badge — they are deliberately low-priority noise.

**Visual treatment for cold outreach:** `sales_outreach` + `urgency: "low"` + `requiresReply: false` arcs can be visually muted — slightly reduced opacity on the sender/subject text (85%), italic AI summary. This makes them identifiable as low-priority at a glance. Do not hide them entirely — the user may want to engage — just reduce their visual weight.

---

### Arc detail (signal thread)

**Thread header:**
- Company name prominently. Sender name + role below in smaller text.
- `crmType` label: "Sales outreach", "Follow-up", "Client message", "Proposal", "Contract", "Support request".
- Deal value chip if present.

**Signal cards:** Same structure as `conversation` — chronological, oldest first. For `crm`, the body is important when it's a proposal or contract; less so for cold outreach. Default: collapse body to first 3 lines with a "Show full email" expand control. This is the one workflow where collapsing by default is justified — cold outreach emails are often long and templated.

**Structured data panel:** For `proposal` and `contract` types, if `dealValue` + `currency` + `dueDate` are all present, render a compact info card above the email body:
```
Deal value:   $48,000 USD
Sender:       Jane Smith, Head of Partnerships at Acme Corp
Decision by:  [dueDate if present]
```
This gives the user the essential facts without reading the email.

**Action bar (below signal cards, above composer):**
Three quick actions — do not make the user scroll to a composer or menu:
1. **Reply** — opens inline composer (same as `conversation`).
2. **Dismiss** — archives the arc immediately. No confirmation dialog. Dismissing a sales email is a normal, expected action. If the user dismisses accidentally, the arc is in Archive and recoverable within the retention window.
3. **Not interested** — a variant of dismiss that also applies a label `declined` and optionally blocks future signals from this eTLD+1. Requires a single confirm: "Block all future emails from acme.com? [Block] [Just dismiss]". This is the CRM equivalent of "unsubscribe" for human outreach.

**Reply composer:** Same as `conversation` — inline, pre-filled To and Subject. For `crm`, optionally offer a quick tone selection above the body field: "Professional · Warm · Brief" — sets the AI draft tone if the user requests a draft.

---

### Threading behaviour

Groups by `senderCompany` (eTLD+1 of sender domain) + account. All emails from Acme Corp thread together, regardless of which person at Acme sent them, and regardless of subject. This is relationship-centric grouping — the company is the entity, not the individual.

Edge case: if `senderCompany` is absent and the sender is from a large shared domain (gmail.com, outlook.com), fall back to exact sender address + subject-based grouping. Grouping all Gmail users together would be catastrophic.

The UI must handle CRM arcs that contain many signals (a long sales cycle might have 10+ emails). The thread view should paginate: show the 3 most recent signals by default with "Show 7 earlier messages" expand.

---

### Follow-up tracking

This is the defining UX innovation for `crm`. Every time a new signal arrives from the same sender in an arc where `arc.sentMessageIds` is empty (user has not replied), the arc's follow-up count increments.

Display rules:
- 1 signal, no reply → no indicator (baseline)
- 2–3 signals, no reply → "2 follow-ups" / "3 follow-ups" chip on the arc row in muted text
- 4+ signals, no reply → chip turns amber: "4 follow-ups" — this is persistence that may warrant a decision
- 6+ signals, no reply → chip turns red: "6 follow-ups" — optionally surface a gentle in-app prompt: "Acme Corp has sent 6 emails. Would you like to dismiss this thread?" with one-tap dismiss.

The counter resets when the user replies. If the user replies and then receives more follow-ups, the counter starts fresh from that reply.

This feature makes the follow-up cadence visible without requiring the user to open each email. It is ambient CRM intelligence.

---

### Default view behaviour

`crm` arcs appear in Default view. Cold `sales_outreach` with `urgency: "low"` appears below all `normal` and `high` urgency items, near the bottom of the list. `proposal` and `contract` arcs with `high` urgency appear near the top.

Consider a dedicated "CRM" view in the user's default view set — pre-seeded on account creation, shows only `crm` workflow arcs, sorted by urgency then `lastSignalAt`. Users who receive heavy commercial email can keep this separate from their personal correspondence.

---

### Notification behaviour

- **Push:** `high` urgency (proposals, contracts) → interrupt. `normal` → ambient. `low` (cold outreach) → silent (no push at all). Cold sales emails should never interrupt — the user did not ask for them.
- **Digest:** Include `crm` arcs with `requiresReply: true` and urgency ≥ `normal`. Group under "Business emails needing attention."
- **Do not notify for follow-ups.** The follow-up counter is a UI affordance; it does not trigger new notifications. The original notification (if any) was enough.

---

### Where to innovate

**Persistent sender profiles:** Every company that appears in `crm` arcs builds an automatic sender profile: first contact date, total emails, follow-up count, whether the user has ever replied, whether the user has dismissed them. Show this as a small "Company profile" card in the arc detail sidebar. It gives the user context like "This is the third company this week pitching infrastructure services" or "You replied to Alice last October" — without requiring any manual CRM data entry.

**AI-generated decline:** When the user clicks "Not interested", offer one more step: "Send a polite decline?" with a draft reply: *"Thanks for reaching out — we're not looking at this right now, but I appreciate you thinking of us."* The user can send it with one tap or dismiss it. This closes the loop for the sender and reduces the guilt of ignoring follow-ups. Only offer this for `sales_outreach` and `proposal` — not for `client_message` or `contract` where a formal decline may have different implications.

**Deal pipeline view:** For users who receive many `proposal` and `contract` arcs, offer a Kanban-style pipeline view within the CRM view: columns for "Reviewing", "In discussion", "Decided". The user drags arcs between columns. Stage is stored as a label (`crm:reviewing`, `crm:discussing`, `crm:decided`). This turns the inbox into a lightweight deal tracker without requiring a separate CRM tool.

---

## package

### What this workflow is

Order confirmations, shipping notifications, out-for-delivery alerts, delivered confirmations, returns, and refunds. The user bought something and is now waiting for it to arrive — or dealing with the aftermath (return, refund, cancellation).

The defining characteristic: **status changes over time, not decisions.** Most package emails require no action. The user wants to know where their package is, not be interrupted about it. The inbox should surface package status passively and step aside.

The one exception: `out_for_delivery` — this is the moment where knowing matters, because the user can plan to be home, buzz a delivery person, or arrange a neighbour to accept. That moment warrants a push.

### Data shape

```ts
interface PackageData {
  workflow: "package";
  packageType: "confirmation" | "shipping" | "out_for_delivery" | "delivered" | "return" | "refund" | "cancellation";
  retailer: string;
  orderNumber?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  estimatedDelivery?: string;    // ISO date string
  items?: Array<{ name: string; quantity: number; price?: number }>;
  totalAmount?: number;
  currency?: string;
}
```

### Urgency

- `out_for_delivery` → `normal` (elevated from `low`, but does not warrant `high` — it is informational, not action-required)
- `return` or `refund` where money is involved → `normal`
- `cancellation` → `high` (unexpected; may require action to re-order or dispute)
- All other types → `low`

The one case to elevate further: if `estimatedDelivery` has passed and no `delivered` signal has arrived, the processor or a scheduled job should bump urgency to `normal` and add label `overdue-delivery`. The UI can also compute this client-side from the date if the backend hasn't done it yet.

---

### Arc list row

**Left:** Box/parcel icon. The icon should visually convey the current delivery status — not a static icon for all package states:
- `confirmation` → empty box outline
- `shipping` → box with a truck
- `out_for_delivery` → truck (no box) — most urgent visual state
- `delivered` → box with a checkmark, green tint
- `return` → box with a left-pointing arrow
- `refund` → dollar sign or coin returning
- `cancellation` → box with an X, muted/grey

This icon progression is the package lifecycle — the user learns to recognise it without reading anything.

**Centre:**
- **Retailer name** in bold: "Amazon", "ASOS", "Apple". Derived from `retailer`.
- **Status label** in muted text: "Out for delivery", "Delivered", "Shipped", "Return requested", "Refund issued", "Order cancelled", "Order confirmed". Map directly from `packageType` — this is the current state.
- **Delivery timeline chip** (below status): if `estimatedDelivery` is set, show:
  - Future: "Arrives Thu 15 Jan" (day + date)
  - Today: "Arriving today" in amber
  - Past + no delivered signal: "Expected yesterday" in amber (possible delivery issue)
  - `delivered` type received: replace with "Delivered Tue 14 Jan" in green

If `items` is present, show the first item name below the status: "iPhone 15 Pro + 2 more items". If only one item, show its name directly.

**Right:**
- Timestamp of last update.
- **Track button** — a small, secondary CTA on the arc row itself. Opens `trackingUrl` in a new tab. Label: "Track". Icon: right-pointing arrow. This is the primary action for most package arcs and should not require opening the detail view.
- If `totalAmount` is present: show the order total in muted text: "$249.99".

**No urgency badge** for `low` arcs (confirmation, shipping, delivered). `out_for_delivery` gets a subtle `normal` badge. `cancellation` gets a `high` badge in amber.

---

### Delivery status bar

This is the defining UI element for the `package` workflow. Above the AI summary on the arc row (or at the top of the arc detail), render a compact 5-step progress bar:

```
[●]————[●]————[ ]————[ ]————[ ]
 Ordered  Shipped  In transit  Out for delivery  Delivered
```

Active steps are filled/coloured. The current step pulses (subtle animation). Completed steps are solid. Future steps are hollow grey.

State mapping:
- `confirmation` → step 1 active (Ordered)
- `shipping` → step 2 active (Shipped)
- `out_for_delivery` → step 4 active (Out for delivery) — skip "In transit" if not explicitly signalled
- `delivered` → step 5 active, all steps green
- `return` → replace bar with a return-specific version: Delivered → Return requested → In transit → Refunded
- `cancellation` → show all steps greyed out with an X on the current step

This bar replaces the need to read the email at all for most users. They see the bar, understand the status, and move on.

---

### Arc detail (signal thread)

**Thread header:**
- Retailer name + order number (if present): "Amazon — Order #123-456-789"
- Delivery status bar (full-width, larger version of the row bar)
- Estimated delivery or delivered date

**Structured data panel (top of detail, above email body):**

```
Order:        #123-456-789
Retailer:     Amazon
Status:       Out for delivery
Arrives:      Today, Thu 15 Jan
Tracking:     1Z999AA10123456784  [Track →]
Items:        AirPods Pro (x1)  $249.99
              USB-C Cable (x2)  $19.99
Total:        $269.98 USD
```

This panel is rendered from `workflowData` fields — not extracted from the email HTML. It is always present when the data exists. The email body is below it (collapsed by default — the structured panel has already surfaced what matters).

**Actions in detail:**
- **Track package** → `trackingUrl` in new tab
- **View order** → retailer order URL if extractable (attempt from email body links — look for `amazon.com/orders/`, `myorders.`, etc.)
- **Start return** → retailer return URL if extractable
- **Archive** → one tap, no confirm. Delivered packages can be archived after the user views them.

---

### Threading behaviour

Groups by `orderNumber` + `retailer`. All signals for Amazon order #123-456-789 thread into one arc: confirmation → shipping → out for delivery → delivered → any returns. This creates a complete lifecycle view per order.

If `orderNumber` is absent: fall back to `retailer` + a 7-day sliding window from the confirmation email. This handles retailers that don't include order numbers in every update.

**Do not merge different orders from the same retailer.** Two Amazon orders placed the same week are two arcs. The grouping key must include `orderNumber`.

For `return` and `refund` signals: even if the return is for an order the user bought months ago, if `orderNumber` matches an existing arc, extend that arc. The full lifecycle should live in one place.

---

### Auto-archive on delivery

When a `delivered` signal arrives, the arc should be considered complete. The default behaviour:
- Mark the arc as read automatically.
- Do not archive immediately — give the user 48 hours to view it (they may want to confirm the delivery or start a return).
- After 48 hours without any user interaction, auto-archive. This keeps the inbox clear of delivered packages without requiring manual cleanup.
- If the user opens the arc or taps "Archive" before the 48-hour window, archive immediately.

The 48-hour auto-archive is a default that users can configure: "Archive delivered packages automatically: immediately / after 48h / never."

---

### Urgency spike on out-for-delivery

When `packageType: "out_for_delivery"` arrives, temporarily elevate the arc to the top of the Default view within its urgency tier — above other `normal` arcs — for the duration of that day. This is the one moment in the package lifecycle where knowing matters immediately. At midnight, the arc returns to normal sort order.

This is not an urgency change (it stays `normal`) — it is a sort boost within the tier, implemented as a tiebreaker in the sort key: `urgency DESC, is_out_for_delivery_today DESC, lastSignalAt DESC`.

---

### Notification behaviour

- **`confirmation`:** No push. This is acknowledgement, not actionable news.
- **`shipping`:** Ambient push (badge only) — "Your Amazon order has shipped."
- **`out_for_delivery`:** Interrupt push — "Your AirPods are out for delivery today." This is the one package state where interruption is justified — timing matters.
- **`delivered`:** Ambient push — "Your AirPods have been delivered."
- **`return` / `refund`:** Ambient push — "Your return has been received. Refund in 5–7 days."
- **`cancellation`:** Interrupt push — "Your Amazon order has been cancelled." This is unexpected and may require action.
- **Digest:** Include only open (undelivered) packages with `out_for_delivery` or `overdue-delivery` label. Delivered packages do not belong in the digest — they are resolved.

---

### Where to innovate

**Delivery day awareness:** On days when one or more packages are `out_for_delivery`, surface a subtle banner at the top of the inbox (not a notification, just an in-app UI element): "2 packages arriving today: AirPods Pro, USB-C Cables." Tapping it filters the inbox to those two arcs. This gives the user a morning briefing for packages without being an alert.

**Missed delivery detection:** If `estimatedDelivery` passes and no `delivered` signal arrives within 24 hours, add a `delayed-delivery` label and surface a "Check on your package" prompt in the arc detail with a direct link to the tracking URL. This is a common frustration — packages marked as delivered that weren't, or packages stuck in transit. The inbox catches it automatically.

**Spend tracking across package arcs:** Aggregate `totalAmount` across all `package` arcs in a rolling 30-day window, grouped by `retailer`. Surface as "You've spent $847 at Amazon this month" in a subtle annotation on the package view header — not in each arc, just as a view-level metric. This is the inbox becoming a passive expense tracker without requiring the user to do anything.

**One-tap return initiation:** For `delivered` arcs where the retailer supports deep-linked returns (Amazon, etc.), add a "Start return" button in the structured panel that constructs the return URL from `orderNumber` and `retailer`. The user should never have to navigate to the retailer's site, find the order, and click return — one tap from the arc detail.

---

## travel

### What this workflow is

Flight bookings, hotel reservations, car rentals, train tickets, cruise confirmations, activity bookings, itineraries, check-in reminders, and boarding passes. The user is going somewhere and this email is part of the logistics.

The defining characteristic: **the email's value is entirely time-anchored.** A boarding pass 3 weeks before departure is trivia. The same boarding pass 2 hours before the flight is critical. The inbox must understand this and surface travel information exactly when it matters — not when it arrives.

Travel arcs should feel like a companion that knows your itinerary and surfaces the right information at the right moment. Not an inbox. Not a notification centre. A travel assistant.

### Data shape

```ts
interface TravelData {
  workflow: "travel";
  travelType: "flight" | "hotel" | "car_rental" | "train" | "cruise" | "activity" | "itinerary" | "check_in_reminder" | "boarding_pass";
  provider: string;              // e.g. "United Airlines", "Marriott", "Hertz"
  confirmationNumber?: string;
  departureDate?: string;        // ISO datetime
  returnDate?: string;           // ISO datetime
  origin?: string;               // airport code or city
  destination?: string;          // airport code or city
  passengerName?: string;
  totalAmount?: number;
  currency?: string;
}
```

### Urgency

Base urgency is `normal`. The processor applies time-based urgency escalation via a scheduled job that runs periodically across all active travel arcs:

- More than 7 days before `departureDate` → `low`
- 2–7 days before → `normal`
- 24 hours before → `high`
- < 4 hours before → `critical` (for `flight`, `train` — not hotel/car)
- `check_in_reminder` or `boarding_pass` type → always `high`
- After `departureDate` passes → urgency drops to `low` (trip is over); arc auto-archives 72 hours after return if `returnDate` is set

The urgency escalation is computed dynamically — the backend job updates `arc.urgency` as time passes; the UI does not need to compute this, it reads current urgency from the arc. However, the UI should also compute a "time until departure" countdown and display it accurately regardless of when urgency was last recalculated.

---

### Arc list row

**Left:** Workflow-specific icon based on `travelType`:
- `flight` → airplane (angled upward for departure, angled downward for return/arrival leg)
- `hotel` → building/bed icon
- `car_rental` → car icon
- `train` → train icon
- `cruise` → ship icon
- `activity` → ticket/star icon
- `itinerary` → map/route icon
- `check_in_reminder` → phone-with-QR icon (implies digital check-in)
- `boarding_pass` → ticket icon with barcode

Icons should use a travel-specific colour: warm amber or teal. Not red (reserved for urgent), not grey (that is muted/status).

**Centre:**
- **Provider name** in bold: "United Airlines", "Marriott London", "Hertz".
- **Route or location** as secondary text: for flights/trains, "SFO → LHR"; for hotels, "London, UK"; for car rentals, "San Francisco Airport"; for activities, the activity name.
- **Departure time chip**: the most important piece of contextual information. Format:
  - > 7 days out: "Sat 18 Jan" (just the date)
  - 2–7 days out: "Sat 18 Jan, 14:30" (date + time)
  - 24 hours: "Tomorrow 14:30" in amber
  - Today: "Today 14:30" in amber with pulse animation
  - < 2 hours: "In 1h 45m" in red, bold — actively counting down
  - Departed: "Departed" in grey — replaced by return date if set

**Right:**
- Confirmation number as a copiable chip — a discreet monospace code. Tapping copies to clipboard with "Copied" toast. This is the single most-retrieved piece of information at an airport or hotel desk.
- Timestamp of the email (muted, small) — less important than the departure date.

**Urgency badge:** Show for `high` and above. Do not show for `low` (week+ away). The departure chip already conveys urgency visually.

---

### Auto-snooze

This is the most important behavioural innovation for travel. When a `travel` arc arrives (any `travelType`):

- If `departureDate` is more than 48 hours away, **automatically snooze the arc** until 24 hours before departure.
- The arc disappears from Default view.
- It reappears exactly 24 hours before `departureDate` with urgency `high` and a push notification.

The user sees no noise until the trip is actually relevant. The booking confirmation arrives, gets a push ("Flight to London confirmed — we'll remind you 24 hours before departure"), and then disappears until it matters.

**Snooze can be disabled per-arc:** A small "Snooze until day before" / "Keep in inbox" toggle on the arc row and in the detail view. Some users want to see upcoming travel in their inbox — give them control, but default to snooze.

**Itinerary arcs** (`travelType: "itinerary"`) are an exception: these are complex multi-leg documents the user may want to refer to for planning. Do not auto-snooze itinerary arcs — keep them visible and archive them when the user returns.

---

### Arc detail (signal thread)

**Thread header:**
- Large route display for flights: `SFO → LHR` in a prominent font. Hotel: city + property name. The header should feel like a travel card, not an email header.
- Departure countdown prominently placed: "Departs in 14h 22m" updating in real time when within 24 hours.

**Structured data panel:**

```
Flight:          United Airlines UA 901
Route:           SFO → LHR
Departure:       Sat 18 Jan, 14:30 PST  (Terminal 3, Gate G82)
Arrival:         Sun 19 Jan, 09:45 GMT
Confirmation:    XKRT49  [Copy]
Passenger:       Jane Smith
Total:           $1,249.00 USD
```

For hotels:
```
Hotel:           Marriott London Heathrow
Check-in:        Sun 19 Jan (after 3pm)
Check-out:       Wed 22 Jan (by 12pm)
Duration:        3 nights
Confirmation:    79284710  [Copy]
Total:           £487.00 GBP
```

The panel extracts from `workflowData` fields. Gate information is rarely in structured data — the email body may contain it, and the UI should attempt to surface it via a quick body parse if not in `workflowData`.

**Smart actions:**
- **Add to calendar** — generates a `.ics` file from `departureDate`, `returnDate`, `destination`, `provider`, `confirmationNumber`. One tap. For flights, creates two events: departure + return leg if `returnDate` is set.
- **Check in online** — deep-link to the airline/hotel check-in URL if extractable. For major airlines (United, Delta, BA, Southwest, etc.), the check-in URL can be constructed from `confirmationNumber` and known URL patterns. Store these patterns as a lookup table.
- **Open boarding pass** — for `boarding_pass` type, attempt to extract a Wallet-compatible PKPass URL or render the QR code inline within the arc detail. The user should be able to show the boarding pass directly from the arc without opening the airline app.

**Multiple signals in one arc:** A single trip often generates many emails — booking confirmation, payment receipt, check-in reminder, boarding pass. These all share a `confirmationNumber` and thread into one arc. The arc detail shows them chronologically. The structured panel is always generated from the most recent signal's data (which is the most complete/current).

---

### Threading behaviour

Groups by `confirmationNumber` + `provider`. All signals for United flight XKRT49 thread together: booking → payment receipt → check-in reminder → boarding pass → (post-trip) receipt or survey.

If `confirmationNumber` is absent: fall back to `provider` + `departureDate` within a ±2-hour window. This handles cases where the reminder email doesn't include the confirmation number.

**Multi-leg itineraries:** A single `itinerary` email often covers multiple flights. Each leg may subsequently generate separate check-in/boarding-pass signals with different confirmation numbers. The `itinerary` arc is the parent; subsequent leg signals should attempt to match back to the itinerary by date + origin/destination + provider before creating new arcs.

---

### Post-trip auto-archive

When `returnDate` (or `departureDate` for one-way travel) passes by 72 hours, auto-archive the arc. The trip is over; the booking details are no longer needed in the active inbox. The arc lives in Archive for the retention period (useful for expense reports, insurance, etc.).

If no `returnDate` is set and no new signal has arrived within 7 days of `departureDate`, treat the arc as post-trip and auto-archive.

Edge case: if the user never received a `delivered`-equivalent for travel (some trips generate no post-trip email), the 7-day rule handles cleanup automatically.

---

### Default view behaviour

Travel arcs behave differently from all others in Default view:

1. **Future trips (auto-snoozed):** Not visible until 24 hours before departure. Zero noise until they matter.
2. **Active/upcoming (within 24h):** Surfaced at the top of Default view, above all other same-urgency arcs. Within the `high` urgency tier, sort travel arcs above non-travel arcs.
3. **Day-of:** `check_in_reminder` and `boarding_pass` arcs are pinned to the very top of Default, above even `critical` arcs from other workflows — with one exception: `auth` arcs (you can't board a plane if you can't log in). On the day of travel, nothing is more important than getting to the gate.
4. **Post-trip:** Auto-archived, not visible in Default.

---

### Notification behaviour

- **Booking confirmation:** Ambient push — "Flight to London confirmed." No interruption needed; the booking is done.
- **24 hours before departure:** Interrupt push — "Your flight to London is tomorrow at 14:30." Deep-links to the arc. This is the snooze wakeup — the moment the arc re-enters the inbox.
- **Check-in opens (typically 24h before):** Ambient push — "Check-in is now open for your United flight." Include deep-link to the check-in URL if available.
- **< 4 hours before departure (flights/trains only):** Interrupt push — "Your flight departs in 3h 45m. Gate: G82." Include the gate if extractable.
- **Boarding pass received:** Interrupt push — "Your boarding pass for UA 901 is ready." High urgency; the user may be at the airport.
- **Post-trip:** No push. The arc auto-archives silently.

---

### Where to innovate

**Boarding pass in lock screen widget:** The boarding pass confirmation number (or QR code if extracted) should be surfaced as a lock screen widget or notification that persists on the day of travel. The user should never have to unlock their phone and navigate to the inbox to find their confirmation number at a hotel desk or gate. Build the notification payload to include the confirmation number in the persistent notification that day.

**Proactive gate and delay alerts:** When the airline/hotel sends an update email (gate change, flight delay, hotel room change), it arrives as a new signal in the travel arc. When this happens, send an interrupt push regardless of the user's general notification preferences — changes to travel plans are always worth interrupting. Label the signal `change-alert` so it renders with a distinct visual treatment in the arc thread (amber border on the signal card, "Update" badge).

**Multi-city trip linking:** When the user has flights and hotels with overlapping dates to the same destination, suggest linking them into a single trip view. E.g., "Your London hotel overlaps with your London flight — show them together as a Trip?" This is purely a UI grouping, not a data model change. Tap to create a `trip` label that groups related travel arcs in a collapsible "London Jan 18–22" section in Default view during the travel window.

**Expense extraction post-trip:** After the trip arc auto-archives, offer a one-tap "Add to expenses" action that extracts all `totalAmount` values across signals in the arc and creates an expense summary: dates, provider, amounts by category (flight/hotel/car). Exports as a CSV row or pushes to an integrated expense tool. This saves the user from digging through old emails at month-end.

---

## scheduling

### What this workflow is

Meeting invites, appointment confirmations, calendar event updates, reschedule requests, and cancellations. The sender wants a specific block of the user's time — either requesting it (`meeting_invite`), confirming it (`appointment`, `confirmation`), reminding the user of it (`reminder`), changing it (`reschedule`), or cancelling it (`cancellation`).

The defining characteristic: **there is exactly one decision to make** — does the time on the calendar match what the user wants? Accept, decline, or propose a different time. Everything else is noise. The UI should make that decision as easy as possible and then get out of the way.

### Data shape

```ts
interface SchedulingData {
  workflow: "scheduling";
  eventType: "meeting_invite" | "appointment" | "reminder" | "cancellation" | "reschedule" | "confirmation";
  title: string;              // event/meeting title
  startTime?: string;         // ISO datetime
  endTime?: string;           // ISO datetime
  location?: string;          // physical address or video URL (Zoom, Meet, etc.)
  organizer?: string;         // name or email of who sent the invite
  attendees?: string[];       // list of other attendees
  calendarUrl?: string;       // .ics download URL or CalDAV link
  requiresResponse: boolean;
}
```

### Urgency

- `meeting_invite` or `reschedule` + `requiresResponse: true` → `high`
- `reminder` with `startTime` < 24h → `high`
- `reminder` with `startTime` > 24h → `normal`
- `cancellation` → `normal` (the event is gone; no action needed, but the user should know)
- `confirmation` or `appointment` with `requiresResponse: false` → `normal`
- Any event with `startTime` < 1 hour → `high` regardless of type (bump all imminent events)

---

### Arc list row

**Left:** Calendar icon. Use a dynamic icon if technically feasible — showing the day number of `startTime` inside the calendar square (like Apple's native Calendar icon). E.g., if the meeting is on Thursday the 18th, the icon shows "18". This is extremely effective for scanning a list of scheduling arcs. If dynamic icons are not feasible, use a static calendar icon with a distinct colour per `eventType`:
- `meeting_invite` / `appointment` → blue
- `cancellation` → grey with X overlay
- `reminder` → amber (time-sensitive)
- `reschedule` → purple (change)
- `confirmation` → green checkmark overlay

**Centre:**
- **Event title** in bold: "Q3 Planning Meeting", "Dentist Appointment", "Coffee with Alice".
- **Time** as the secondary line: "Thu 18 Jan, 2:00–3:00pm" — always show both start and end time if `endTime` is present. Duration in parentheses helps users assess calendar impact: "(1 hour)".
- **Organizer** in muted text: "Invited by Alice Chen" or "Confirmed by Dr. Smith's office".
- **Location hint**: if `location` contains a video URL (Zoom, Google Meet, Teams, Around), show a video camera icon + "Video call". If physical, show a map pin + abbreviated location. This lets the user know whether they need to go somewhere.

**Right:**
- **Time until** chip: same countdown logic as travel — "in 3 days", "Tomorrow 2pm", "In 45m" (amber), counting down in real time within the hour.
- If `requiresResponse: true`: an "RSVP needed" chip in amber. More direct than "Reply needed" — scheduling has a clear response protocol (accept/decline).
- Attendee count: if `attendees` has > 0 entries, show a small "4 attendees" count in muted text.

**Urgency badge:** `high` for invites needing response. Suppress for confirmed events with no response needed — the time chip already conveys urgency.

---

### Arc detail (signal thread)

**Thread header — Event card:** Render the event as a visual card at the top of the detail, not as an email header. This card should look like a calendar event:

```
┌──────────────────────────────────────────────┐
│  📅  Q3 Planning Meeting                      │
│      Thu 18 Jan, 2:00–3:00pm (1 hour)        │
│      📍 Conference Room B / Zoom              │
│      👤 Invited by Alice Chen                 │
│      👥 4 attendees: Alice, Bob, Carol, +1    │
│                                              │
│  [Accept]    [Decline]    [Add to Calendar]  │
└──────────────────────────────────────────────┘
```

The event card is always rendered from `workflowData` regardless of whether the email body contains the same information. Below the card, the email body renders in the sandboxed iframe (often contains the full invite with agenda — useful for context).

**RSVP buttons (when `requiresResponse: true`):**
- **Accept** — if `calendarUrl` is a `.ics` or CalDAV link, download/add to calendar + mark arc as responded. If no URL, open the reply composer pre-filled with "Yes, I'll be there." The arc is then marked "responded" and urgency drops to `normal`.
- **Decline** — same: CalDAV decline or opens reply composer pre-filled with "Sorry, I won't be able to make it — do you have another time?" User can edit before sending.
- **Propose new time** — opens a light date/time picker inline. Sends a reply with the proposed time. Pre-fills: "I can't make 2pm on Thursday — would 4pm work instead?"

**Add to Calendar** (always visible regardless of `requiresResponse`):
- Downloads a `.ics` file containing `title`, `startTime`, `endTime`, `location`, `organizer`, `description` (from email body if extractable).
- On mobile: integrates with OS calendar API to add directly without file download.

**For `cancellation` events:**
- The event card renders in grey with a strikethrough on the title: `~~Q3 Planning Meeting~~`.
- Body text: "This event has been cancelled."
- Only action: "Remove from calendar" (attempts to delete the calendar event via `.ics` CANCEL method, or links to the calendar app).
- Auto-archive suggestion: "Event cancelled — archive this?" with one-tap archive. The user should not have to manually clean this up.

**For `reschedule` events:**
- Show two event cards stacked: old time (strikethrough, grey) → new time (current, highlighted).
- RSVP buttons for the new time.

---

### Threading behaviour

Groups by `title` + `organizer` + approximate date window (±7 days). This ensures:
- The original invite and the confirmation thread together.
- A reschedule (same title, same organizer) extends the existing arc rather than creating a new one.
- Weekly recurring meetings do NOT thread together — the ±7-day window prevents that. Each week's invite is a separate arc.

For calendar system-generated reminders (e.g., "This is a reminder for your meeting in 1 hour"): these often have slightly different subjects. The matcher should normalise by stripping "Reminder:", "Re:", "Fwd:" prefixes and matching on the core `title`.

---

### Auto-archive on event passage

When `startTime` passes:
- If the event was accepted (user responded): auto-archive 2 hours after `endTime`. The meeting is done; there is nothing to act on.
- If the event was declined or the arc has no response: auto-archive 2 hours after `startTime`. The window has passed.
- If the event was cancelled: auto-archive immediately when the cancellation signal arrives.
- If the user re-receives a reschedule for a past arc, create a new arc for the new time rather than resurfacing the old archived arc.

This auto-archive logic ensures the user never has to manually clean up past meetings.

---

### Default view behaviour

Scheduling arcs sort alongside other arcs by urgency + time. Within the `high` urgency tier, scheduling arcs with `requiresResponse: true` sort above those without — RSVP-needed events are more time-sensitive than confirmed events.

Consider a **Today** view (or "Today" section within Default view) that surfaces only arcs with `startTime` on the current calendar day, regardless of urgency tier. This is especially useful in the morning: "You have 3 events today — 9am standup, 2pm Q3 planning, 5pm dentist." The today section is collapsible and sits at the top of Default view when populated.

---

### Notification behaviour

- **`meeting_invite`:** Interrupt push if `requiresResponse: true` — "Alice invited you to Q3 Planning Meeting." Deep-links to the arc. If `requiresResponse: false`, ambient push.
- **`reminder`:** Interrupt push 1 hour before `startTime`, ambient push 1 day before. Use `startTime` to schedule these, not the email arrival time. The processor should schedule deferred notifications when a `reminder` type signal arrives.
- **`cancellation`:** Interrupt push — "Q3 Planning Meeting has been cancelled." Even though no action is needed, users need to know immediately so they can clear their calendar.
- **`reschedule`:** Interrupt push — "Q3 Planning Meeting has been rescheduled to Friday 3pm."
- **`confirmation`:** Ambient push — "Your dentist appointment is confirmed for Mon 20 Jan."
- **Digest:** Include all unanswered `meeting_invite` and `reschedule` arcs. Group under "Needs your response."

---

### Where to innovate

**Conflict detection:** When a new `meeting_invite` arrives, the inbox should check whether the user already has a scheduling arc with an overlapping `startTime`–`endTime` window. If a conflict is detected, surface it in the arc detail: "Conflict: You already have Q2 Review at 2:00–3:00pm on Thursday." This prevents double-booking without requiring the user to check their calendar manually. The check is done client-side against existing `scheduling` arcs — no calendar integration required.

**One-tap accept + add-to-calendar:** The most common response to a meeting invite is "accept." Make this a single tap that simultaneously (a) sends an acceptance reply, (b) adds the event to the OS calendar, and (c) archives the arc. The user should be able to fully process a meeting invite in one tap from the arc list row, without opening the detail view.

**Location intelligence:** When `location` is a physical address, offer a one-tap "Directions" link (opens in Maps app). When `location` is a video URL, offer one-tap join that opens the video conferencing app directly. These deep-links should be visible on the arc row itself (on hover/long-press) — not just in the detail view. Getting to the meeting should be zero friction.

**Smart decline suggestions:** When the user declines, offer to suggest alternative times based on their existing scheduling arc data. "You're free Thursday 4–5pm or Friday 10–11am — would you like to propose one of these?" This requires inspecting existing `scheduling` arc `startTime`/`endTime` pairs to find gaps. Simple to implement with the data already available; extremely useful in practice.

---

## payments

### What this workflow is

Everything involving money: invoices owed to someone, receipts for purchases already made, subscription renewals, failed payment alerts, plan changes, tax documents, wire transfers, refunds, and account statements. Money flows both ways — the user either owes money, has paid money, or is owed money back.

The defining characteristic: **there is often a concrete action and a deadline.** Invoices need to be paid. Subscriptions need to be renewed or cancelled. Failed payments need to be fixed. Tax documents need to be filed. The inbox must surface what is owed, when it is due, and how to pay — all without requiring the user to open the email.

Receipts and statements are the passive cases — already resolved, just need to be filed. The inbox should distinguish sharply between "action needed" (invoice, failed payment) and "already done" (receipt, statement) in its visual treatment.

### Data shape

```ts
interface PaymentsData {
  workflow: "payments";
  paymentType: "invoice" | "receipt" | "subscription_renewal" | "payment_failed" | "plan_changed" | "tax" | "wire_transfer" | "refund" | "statement" | "other";
  vendor: string;
  amount?: number;
  currency?: string;
  dueDate?: string;            // ISO date — when payment is due
  invoiceNumber?: string;
  accountLastFour?: string;   // last 4 digits of the card/account
  downloadUrl?: string;       // PDF download
  managementUrl?: string;     // vendor portal (Stripe, PayPal, etc.)
}
```

### Urgency

- `payment_failed` → `critical`. Always. Failed payments mean service disruption is imminent. This is the payments equivalent of a fraud alert.
- `invoice` + `dueDate` within 3 days → `high`
- `invoice` + `dueDate` within 7 days → `normal`
- `invoice` + `dueDate` > 7 days → `low`
- `invoice` with no `dueDate` → `normal` (unknown deadline = treat as moderate urgency)
- `subscription_renewal` within 7 days → `normal`
- `subscription_renewal` > 7 days → `low`
- `receipt` → `low` (already paid; no action needed)
- `statement` → `low` (informational)
- `refund` → `normal` (money coming back; user wants to know)
- `tax` → `normal` (not time-critical unless near a filing deadline)
- `plan_changed` → `normal`
- `wire_transfer` → `normal`

---

### Arc list row

**Left:** Icon varies by `paymentType` and direction:
- `invoice` → document with dollar sign (money owed out)
- `receipt` → receipt/checkmark (money already paid)
- `subscription_renewal` → circular arrows (recurring)
- `payment_failed` → warning triangle with dollar sign — red, high contrast
- `plan_changed` → gear/upgrade arrow
- `tax` → government/form icon
- `wire_transfer` → bank/arrows icon
- `refund` → dollar sign with left-pointing arrow (money coming back)
- `statement` → document stack

Colour coding:
- **Owed (invoice, subscription_renewal):** amber — attention needed
- **Paid/resolved (receipt, statement, refund):** green tint — calm, done
- **Failed (payment_failed):** red — critical
- **Informational (tax, plan_changed, wire_transfer):** neutral blue

**Centre:**
- **Vendor name** in bold: "Stripe", "AWS", "Adobe", "Xero".
- **Payment type label** in muted text: "Invoice", "Receipt", "Subscription renewal", "Payment failed", "Tax document", "Refund".
- **Amount** — the most important piece of information. Display prominently below the type label, larger than surrounding text: **$249.99 USD**. For invoices and renewals, format as "Due: $249.99". For receipts, "Paid: $249.99". For refunds, "Refund: $249.99" in green. Never show a raw number without currency and context.
- **Due date chip** for invoices and renewals:
  - > 7 days: "Due Jan 30" (muted)
  - 3–7 days: "Due in 5 days" (amber)
  - < 3 days: "Due in 2 days" (amber, bold)
  - Today: "Due today" (red, bold)
  - Overdue: "Overdue since Jan 15" (red, bold, with exclamation)

**Right:**
- Timestamp of the email.
- If `invoiceNumber` is present: show as a small copiable chip — "INV-2024-0091". Accounts payable processes often require invoice numbers; having it on the row saves the user from opening the email.
- If `downloadUrl` is present: a "Download" icon button (cloud/arrow) that triggers the PDF download without opening the arc detail.

**Urgency badge:** Always show for `payment_failed` (critical). Show for `high` invoices (< 3 days). Suppress for `low` receipts and statements — they should not carry any badge.

---

### Arc detail (signal thread)

**Thread header — Payment card:**

```
┌──────────────────────────────────────────────┐
│  AWS — Invoice                                │
│  Amount:      $1,847.23 USD                  │
│  Due:         Thu 30 Jan (in 5 days)         │
│  Invoice:     INV-2024-0091  [Copy]          │
│  Account:     Visa ····4821                  │
│                                              │
│  [Pay now]    [Download PDF]    [Manage]     │
└──────────────────────────────────────────────┘
```

For `receipt`:
```
┌──────────────────────────────────────────────┐
│  Stripe — Receipt                             │
│  Amount:      $149.00 USD  ✓ Paid            │
│  Date:        Tue 14 Jan                     │
│  Invoice:     INV-2024-0088  [Copy]          │
│  Account:     Visa ····4821                  │
│                                              │
│  [Download PDF]                              │
└──────────────────────────────────────────────┘
```

For `payment_failed` — full-width red banner at the top of the detail, above the payment card:

```
⚠️  Payment failed — action required
Your payment of $149.00 to Stripe failed on 14 Jan.
Service may be suspended if not resolved.
[Update payment method →]
```

**Actions:**
- **Pay now** — deep-link to `managementUrl`. Opens in new tab. After the user taps this, mark the arc with label `payment-attempted` (client-side state — we don't know if the payment succeeded, but we know the user tried).
- **Download PDF** — downloads from `downloadUrl` directly. No navigation.
- **Manage** — opens the vendor's subscription/account management portal (from `managementUrl`). Distinct from "Pay now" — manages the subscription, not the individual invoice.
- **Archive** — for `receipt` and `statement` types, make Archive the primary CTA. These are done; archive them.

**Payment history panel** (below the payment card, above the email body): For vendors with multiple payment arcs, show a compact payment history inline — the last 3 invoices from this vendor:

```
Stripe payment history (this account):
  Jan 2024    $149.00  ✓ Paid  [INV-2024-0088]
  Dec 2023    $149.00  ✓ Paid  [INV-2023-0071]
  Nov 2023    $149.00  ✓ Paid  [INV-2023-0054]
```

This is rendered from other `payments` arcs for the same vendor in the account's arc history. It builds trust and helps the user verify consistency (e.g., "Did the amount change?"). Only show this for vendors with ≥ 2 previous payments.

---

### Threading behaviour

Groups by `vendor` (eTLD+1) + `paymentType` category. All invoices from AWS thread together. All receipts from AWS thread together (separate arc from invoices). This separates "owed" from "paid" which have different visual treatments.

Exceptions:
- `payment_failed` for a specific invoice threads with the original `invoice` arc if the invoice number matches — they are the same debt.
- `refund` arcs may thread with the original `receipt` if within 30 days and same vendor.
- `subscription_renewal` arcs from the same vendor each get their own arc (they are monthly events, not a single thread). Group only the current period's renewal-related signals (payment failure, plan change) together.

**Do not merge invoices across vendors.** Stripe and AWS are always separate arcs.

---

### Auto-archive behaviour

- `receipt` → auto-archive after the user opens it once. Receipts are informational; once seen, they belong in Archive.
- `statement` → auto-archive 7 days after arrival. Statements are passive records.
- `invoice` → never auto-archive. Always requires explicit user action (pay or dismiss).
- `payment_failed` → never auto-archive until the user confirms it is resolved (either by clicking Pay or explicitly archiving).
- `refund` → auto-archive 3 days after arrival. The money is coming; nothing to do.
- `tax` → never auto-archive (user may need to refer back during filing period).

---

### Default view behaviour

- `payment_failed` → top of Default view within `critical` urgency tier. Always visible until resolved.
- Invoices with `dueDate` within 3 days → `high` tier, sorted by `dueDate` ascending (most urgent due date first within tier).
- All other payments → sorted by `urgency` tier then `lastSignalAt`.
- `receipt` and `statement` arcs with `low` urgency → appear near the bottom of Default; consider auto-archiving them before they even reach Default (since they require no action).

---

### Notification behaviour

- **`payment_failed`:** Interrupt push — "AWS payment failed — update your payment method." Deep-links to arc with the "Update payment method" CTA visible immediately. The push must include enough context to act: vendor name and amount.
- **Invoice due within 3 days:** Interrupt push — "Invoice from AWS ($1,847) due in 3 days."
- **Invoice due today:** Interrupt push — "AWS invoice due today: $1,847."
- **Invoice overdue (no payment signal received):** Interrupt push 24 hours after `dueDate` if arc is still open — "AWS invoice ($1,847) is overdue."
- **`subscription_renewal` < 7 days:** Ambient push — "Adobe CC renews in 5 days ($599/year)."
- **`receipt`:** Ambient push — "AWS charge of $1,847 processed." No interruption for confirmations.
- **`refund`:** Ambient push — "Refund of $49.99 from Stripe is on its way."
- **Digest:** Include all unpaid invoices sorted by due date. Group under "Upcoming payments."

---

### Where to innovate

**Vendor spend aggregation:** In the Payments view (a pre-seeded view showing only `payments` workflow arcs), show a monthly spend summary at the top: total across all vendors, with a breakdown. E.g.:

```
January 2024 — $3,291.22 spent
  AWS          $1,847.23
  Stripe fees    $149.00
  Adobe CC       $599.00
  Other          $696.00
```

This is computed from `receipt` arcs within the current month. No data entry. No spreadsheet. The inbox becomes a passive financial dashboard.

**Overdue invoice escalation:** If an `invoice` arc passes its `dueDate` by more than 3 days with no subsequent `receipt` signal (no confirmation of payment), escalate the arc to `critical` urgency and surface a "This invoice may be overdue — have you paid it?" prompt with two options: [Mark as paid] (adds `paid` label and archives) and [Pay now] (opens `managementUrl`). The "Mark as paid" path is important — the user may have paid via bank transfer and no email confirmation arrived.

**Subscription calendar:** All `subscription_renewal` arcs with a future `dueDate` can be visualised as a calendar of upcoming charges. This is the "how much am I spending on subscriptions?" question that every user has but no inbox answers today. Show it as a simple list ordered by upcoming renewal date: "Adobe CC — Jan 30, $599 / AWS — Feb 1, estimated / Notion — Feb 15, $96." Surfaces subscription creep before it becomes a surprise.

**One-tap pay confirmation:** After the user clicks "Pay now" and returns to the app, show a prompt: "Did you complete the payment?" with [Yes, paid] and [Not yet] options. If they confirm payment, the arc archives immediately and a `paid` label is applied. This creates a reliable "I've handled this" state without needing a webhook from the vendor — the user's confirmation is the signal.

---

## alert

### What this workflow is

Security events, fraud alerts, CI/CD failures, infrastructure incidents, deployment alerts, domain/certificate expiry warnings, and security scan results. These emails demand immediate attention because something has either gone wrong or is about to go wrong — a login from an unknown device, a fraudulent charge, a failing deployment, an expiring certificate.

The defining characteristic: **the clock is ticking and the cost of inaction is high.** A suspicious login that goes unacknowledged may mean an account is compromised. A CI failure that goes unaddressed blocks the team. A certificate expiry that goes unnoticed takes down a service. Every design decision in this workflow must serve one goal: get the user investigating as fast as possible.

`alert` is the highest-urgency non-`auth` workflow. Treat every `requiresAction: true` alert with the same seriousness as a fraud alert, because it might be one.

### Data shape

```ts
interface AlertData {
  workflow: "alert";
  alertType:
    | "suspicious_login" | "new_device" | "password_changed" | "breach_notice"
    | "api_key_exposed" | "account_locked" | "fraud_alert"
    | "ci_failure" | "deployment_failed" | "error_spike"
    | "domain_expiry" | "cert_expiry" | "security_scan"
    | "other";
  service: string;
  severity?: "info" | "warning" | "critical";
  requiresAction: boolean;
  actionUrl?: string;
  ipAddress?: string;
  location?: string;         // e.g. "Berlin, Germany"
  deviceName?: string;
  repository?: string;       // for CI/deployment alerts
  errorMessage?: string;     // for error spikes, CI failures
}
```

### Urgency

- `requiresAction: true` OR `severity: "critical"` → `critical`
- `severity: "warning"` OR `alertType` in [fraud_alert, api_key_exposed, account_locked, suspicious_login, breach_notice] → `critical` (these are always critical regardless of `requiresAction`)
- `severity: "warning"` for non-security alert types (domain_expiry, ci_failure) → `high`
- `severity: "info"` or `requiresAction: false` → `normal`

There is no `low` urgency for `alert`. If a signal is classified as `alert`, something happened that the system or classifier deemed noteworthy. Minimum urgency is `normal`.

---

### Arc list row

**Left:** Warning triangle icon for `critical`. Info circle for `warning`. Bell for `info`. The icon itself communicates severity before the user reads anything. Colour:
- `critical` → red (same as the urgency system, reinforced)
- `warning` → amber
- `info` → neutral blue

For `fraud_alert` specifically: use a distinct icon — a shield with a lightning bolt or an exclamation inside the shield. Fraud is not the same as a CI failure and should look different at a glance.

**Centre — alert types and their primary display:**

Security alerts (`suspicious_login`, `new_device`, `fraud_alert`, `api_key_exposed`, `account_locked`, `breach_notice`, `password_changed`):
- **Service name** in bold: "GitHub", "Stripe", "Google".
- **Alert summary** as secondary text — human readable, not the raw `alertType`:
  - `suspicious_login` → "Suspicious login detected"
  - `new_device` → "New device signed in" or "New device: {deviceName}"
  - `fraud_alert` → "Fraud alert — unusual activity"
  - `api_key_exposed` → "API key exposure detected"
  - `account_locked` → "Account locked — action required"
  - `breach_notice` → "Security breach notice"
  - `password_changed` → "Password changed"
- **Location + IP chip** when present: "Berlin, Germany (195.34.21.7)" — one line in muted text. This is the single most useful piece of information for evaluating a login alert. If it's Moscow at 3am and the user is in San Francisco, they know immediately.

Developer/infrastructure alerts (`ci_failure`, `deployment_failed`, `error_spike`):
- **Repository or service name** in bold: "rhosys/ses-email-adapter" or "Production API".
- **Alert type** in muted text: "CI failed", "Deployment failed", "Error spike detected".
- **Error snippet** in mono text: first 80 characters of `errorMessage` if present — e.g., `TypeError: Cannot read properties of undefined (reading 'length')`. This lets developers triage without opening the email.

Infrastructure/expiry alerts (`domain_expiry`, `cert_expiry`, `security_scan`):
- **Service name** in bold.
- **Alert type**: "Domain expires in 12 days", "SSL certificate expires in 7 days", "Security scan: 3 issues found".
- Time-to-expiry chip if extractable from `alertType` and signal data.

**Right:**
- Timestamp (relative, auto-updating).
- **Investigate button** — a CTA directly on the arc row for `requiresAction: true` alerts. Opens `actionUrl` in new tab. Label: "Investigate →". This is the single most important affordance — get the user to the investigation page in one tap from the list.
- Urgency badge: always show for `critical` and `high` (there should be no silent alerts).

---

### Fraud alert special treatment

`alertType: "fraud_alert"` gets the most aggressive visual treatment in the system:

- **Full-width red banner** spanning the arc row — not just an icon or badge, but the entire card background shifts to a light red tint.
- **Bold red "Fraud Alert" label** replacing the normal workflow label.
- Arc sorted to the absolute top of Default view, above all other arcs including `auth`.
- Push notification: interrupt tier, maximum urgency — this notification must fire even if the user has silenced all others (implement as a separate notification category: "Security" — iOS Critical Alerts, Android high-priority channel, cannot be silenced by Do Not Disturb).

Each `fraud_alert` is its own arc. **Never merge multiple fraud alerts** — each represents a distinct suspicious event. If three fraud alerts arrive from the same service within 10 minutes, there are three arcs, three notifications, three "Investigate" buttons.

---

### Arc detail (signal thread)

**Thread header:** Large-format alert panel at the top.

For security alerts:
```
┌──────────────────────────────────────────────┐
│  ⚠️  CRITICAL — Suspicious login              │
│                                              │
│  Service:     GitHub                         │
│  Device:      Unknown (Chrome on Windows)    │
│  Location:    Moscow, Russia                 │
│  IP:          91.108.4.1                     │
│  Time:        Today 03:42 UTC                │
│                                              │
│  [Secure my account →]   [This was me]      │
└──────────────────────────────────────────────┘
```

For developer alerts:
```
┌──────────────────────────────────────────────┐
│  ✕  CI Failure — rhosys/ses-email-adapter    │
│                                              │
│  Branch:      main                           │
│  Trigger:     Push by alice                  │
│  Duration:    2m 14s                         │
│  Error:       TypeError: Cannot read...      │
│                                              │
│  [View failed run →]                         │
└──────────────────────────────────────────────┘
```

**"This was me" / "This wasn't me" action:**
For `suspicious_login`, `new_device`, `password_changed` — show two resolution buttons:
- **"This was me"** — archives the arc and marks it `acknowledged`. No further action. The alert is resolved.
- **"This wasn't me"** — opens `actionUrl` (account security page) in new tab AND adds label `security:compromised` to the arc AND sends the user to the arc detail with an expanded help panel: "Steps to secure your account: 1. Change your password now. 2. Enable two-factor authentication. 3. Review connected apps." The arc stays open (not archived) until the user explicitly closes it after securing their account.

**For CI/deployment failures:**
- **"View failed run"** → `actionUrl` (CI dashboard).
- No "This was me/wasn't me" — developer alerts don't have an acknowledgement pattern, they have a resolution pattern. Show instead: "Mark as resolved" (archives arc when the developer has fixed the issue).

**Email body:** Below the structured panel. For security alerts, the email body often contains additional context (recent activity, list of sessions) — render in sandboxed iframe as normal. For CI failures, the body is usually just a log — render as-is.

---

### Repeated alert escalation

This is a critical safety feature. If multiple `alert` arcs from the same `service` arrive within a short window without any acknowledgement:

- **2 security alerts within 10 minutes:** Surface in-app banner: "2 security alerts from GitHub in the last 10 minutes." Push a second interrupt notification even if one was already sent.
- **3+ security alerts within 10 minutes:** Escalate with a top-of-screen persistent warning that does not dismiss until the user taps "Dismiss" or "Investigate": "Multiple security events detected on your GitHub account. We strongly recommend checking your account now." Include a direct link to GitHub's security activity page.
- **For CI failures:** No escalation — many CI failures in rapid succession are expected (multiple commits triggering failures). Apply a different pattern: collapse repeated CI failures from the same repo within a 5-minute window into a single arc with a count: "5 CI failures in the last 5 minutes on rhosys/ses-email-adapter" — do not create 5 separate arcs.

The distinction: security alert flooding is a red flag. CI failure flooding is normal developer behaviour.

---

### Threading behaviour

**Security alerts:** Each alert gets its own arc. Do not thread security alerts from the same service together — each is a distinct security event. Merging a suspicious login from Tuesday with another from Wednesday hides the pattern; they should be separate arcs so the user can see frequency.

**Exception:** `password_changed` following a `suspicious_login` from the same service — these clearly relate to the same incident and should thread together (the user saw the suspicious login and changed their password).

**CI/deployment alerts:** Group by `repository`. All CI failures on `rhosys/ses-email-adapter` thread together into one arc that shows the failure history. This is the opposite of security alerts — for CI, the pattern over time is useful, not alarming.

**Infra expiry alerts:** Group by `service` + `alertType`. All cert expiry warnings for the same domain thread into one arc (since there will typically be a series: 30-day, 14-day, 7-day, 1-day warnings).

---

### Default view behaviour

- `critical` alerts: pinned to the very top of Default view. Within `critical`, sort by arrival time descending — the most recent is the most relevant.
- `fraud_alert`: top of `critical` tier, above all other `critical` arcs.
- `high` alerts: normal `high` tier sort, above `normal`.
- `ci_failure` with `severity: "warning"`: respect the urgency tier (usually `high`) but do not pin. CI failures should not dominate the inbox — the developer will handle them through the CI dashboard, not the inbox.

After an alert is acknowledged (user clicks "This was me" or "Mark as resolved"), remove it from Default view immediately. Acknowledged alerts should not linger.

---

### Notification behaviour

- **`critical` security alerts (fraud_alert, suspicious_login, api_key_exposed, account_locked, breach_notice):** Interrupt push via iOS Critical Alerts / Android high-priority channel. These bypass Do Not Disturb. Cannot be silenced by the user's notification preferences for this workflow (security alerts must always reach the user). Notification body includes: service name, alert type, location/IP if available, and a link to the secure-account action.
- **`ci_failure` / `deployment_failed` / `error_spike`:** Interrupt push for `requiresAction: true`; ambient for `requiresAction: false`. CI failures interrupt because someone needs to fix them. Error spikes that are informational do not interrupt.
- **`domain_expiry` / `cert_expiry`:** Ambient push. These are future events, not active crises. The push gives visibility; the arc in the inbox is where the user acts.
- **Digest:** Include all unacknowledged `critical` alerts in the digest. Group under "Security alerts requiring attention." Include CI failures with `requiresAction: true`.

---

### Where to innovate

**Automated threat context enrichment:** When an `alert` arrives with `ipAddress`, make an automatic call to a threat intelligence API (AbuseIPDB, IPQualityScore, or similar) to enrich the context: "IP 91.108.4.1 has been reported for suspicious activity 234 times. Country: Russia. Risk score: 97/100." Display this enriched context in the alert panel in the arc detail. This transforms a raw IP address into an actionable risk assessment — the user immediately knows whether to panic or dismiss.

**Security incident timeline:** When multiple related security events arrive across a period of time (suspicious login → password changed → API key reset), link them in a visual timeline within the arc detail: "Security incident — 3 events over 2 hours." This tells a story of the incident's progression and gives the user a complete picture without navigating between separate arcs. Build this as a collapsible "Incident timeline" section in the arc detail for arcs that have received multiple `alert`-type signals.

**CI failure summary:** For development teams, when a CI failure arc receives its second signal (same repo, different commit), show a brief diff in the arc detail: "Failing since: commit 4a3b2c1 by Alice at 3:42pm. Last passing: commit 7f8d2e4 at 2:15pm." This is computed from the last two signals in the arc — no CI integration needed, just parsing the email bodies. It immediately narrows down which commit broke the build.

**One-tap "not me" → security playbook:** When the user taps "This wasn't me" on a suspicious login, do not just open a browser tab. Show a guided security playbook inline in the arc detail — a checklist with direct links to each step:
1. ✅ Change your password → [GitHub password settings link]
2. ✅ Review active sessions → [GitHub sessions link]
3. ✅ Enable 2FA → [GitHub 2FA link]
4. ✅ Revoke suspicious OAuth apps → [GitHub apps link]
5. ✅ Download account activity log → [GitHub log link]

The user taps each item to mark it done. The arc archives when all items are checked. This turns a panic-inducing security alert into a structured, manageable incident response — in the inbox.

---

## content

### What this workflow is

Newsletters, promotional emails, social digests, product updates, and announcements. The user subscribed to these (or at least consented to them at some point). They are passive, low-priority, read-when-you-have-time emails. They require no action unless the user wants to take one.

The defining characteristic: **they should not intrude.** A newsletter from a favourite writer is valuable — but not urgent. A promotional email with a 20%-off code might be worth a glance — but not worth interrupting anything. The inbox should keep `content` arcs visible and accessible without letting them drown out the things that actually matter.

The secondary challenge: **volume.** Users who subscribe to newsletters, product updates, and social digests can receive dozens per day. The inbox must handle this volume gracefully — grouping by publisher, surfacing what's worth reading, and making bulk-dismiss effortless.

### Data shape

```ts
interface ContentData {
  workflow: "content";
  contentType: "newsletter" | "promotion" | "social_digest" | "product_update" | "announcement";
  publisher: string;
  topics?: string[];
  discountCode?: string;
  discountAmount?: string;
  expiryDate?: string;       // for promotions with expiring offers
  unsubscribeUrl?: string;
}
```

### Urgency

Always `low`. No exceptions. Content arcs never interrupt. They never carry an urgency badge. They exist in the inbox as passive reading material and should feel that way.

The one exception: if `discountCode` is present and `expiryDate` is within 24 hours, bump urgency to `normal` and surface a "Expires today" chip. A discount code expiring tonight is the rare case where content warrants more than `low` visibility. It does not warrant `high` or interrupt push — just normal-tier placement and an ambient notification.

---

### Arc list row

**Visual treatment:** Content arcs are visually muted compared to all other workflows. Reduce font weight (regular, not bold) for publisher name. Reduce opacity slightly (90%) on the secondary text. No left accent bar. No urgency badge. The visual hierarchy should make it immediately apparent that these are lower-priority reads.

**Left:** Icon based on `contentType`:
- `newsletter` → newspaper/scroll icon
- `promotion` → tag/percent icon (with discount chip if `discountCode` present)
- `social_digest` → network/users icon
- `product_update` → package/version icon
- `announcement` → megaphone icon

Colour: neutral grey. Not the warm/vibrant colours used for action-required workflows. The grey communicates "when you have time."

**Centre:**
- **Publisher name** in regular (not bold) weight: "The Browser", "Stripe Press", "Substack".
- **Content type label** in muted text: "Newsletter", "Promotion", "Product update".
- **AI summary / headline**: for newsletters, the actual headline or summary of the main article — e.g., "Why large language models hallucinate and what to do about it." For promotions: "20% off everything — code SAVE20." For social digests: "3 new posts from people you follow." This summary drives the decision to read or skip.
- **Discount chip** (if `discountCode` present): a prominent chip showing the code + discount amount: "SAVE20 — 20% off". This is the most valuable piece of information in a promotional email. Surface it on the row so the user can copy it without opening the email.

**Right:**
- Timestamp.
- **Unsubscribe button** — a small secondary action on the row: "Unsub" with a minus icon. Tapping opens a single-step confirmation: "Unsubscribe from The Browser?" with [Confirm] and [Cancel]. On confirm: opens `unsubscribeUrl` in a new tab (the actual unsubscribe) AND archives the arc AND applies a label `unsubscribed:the-browser` so future arcs from this publisher can be auto-archived by a rule.
- **Topic chips** (if `topics` is present): small grey chips showing what the content is about: "AI", "Security", "Startups". Max 2 visible, rest collapsed. Helps the user decide whether to read without opening.

**No reply button.** Content arcs do not support reply from the inbox. Users who want to reply to a newsletter author do so via their email client — not via this inbox, which is a reader, not a mailer.

---

### Arc detail (signal thread)

Content arcs often have a single signal (one newsletter issue). The thread view should feel like a reading experience, not an email client.

**Thread header:**
- Publisher name + content type.
- AI-generated summary of the full issue: 2–3 sentences covering the main points. This is the "TL;DR" that lets the user decide in 10 seconds whether they want to read the full email.
- Topic chips.
- Discount code chip (if present): large, copiable. The code is the thing — make it the centrepiece.

**Signal cards:**
- Render HTML in a full-width sandboxed iframe. Remove the normal signal card chrome (from/to headers, spam score) — for content arcs, the email IS the content. Treat the iframe as the primary reading surface.
- Give the iframe maximum available height. Do not limit it to a scroll container within a scroll container — allow the full newsletter to render in natural document flow.
- Tracking pixel blocking: content emails often contain tracking pixels. The sandboxed iframe already prevents JavaScript execution; additionally, block image requests to known tracking domains (a maintained blocklist). Show a small "2 trackers blocked" indicator at the top of the iframe if any were blocked.

**Actions:**
- **Unsubscribe** — same as row, but shown as a full button. The primary action for content emails that the user decides isn't worth their time is to unsubscribe, not archive.
- **Archive** — secondary. For newsletters worth keeping but not needing to read right now.
- **Save to read later** — adds label `read-later` and moves arc to a "Read Later" view. This is the "I want to read this but not now" option.
- **Copy discount code** — if `discountCode` is present, a sticky button at the top of the detail view: "Copy code: SAVE20". This should be impossible to miss.

---

### Threading behaviour

Groups by `publisher` (eTLD+1 of sender domain). All issues of "The Browser" newsletter thread into one arc. The arc grows as new issues arrive — the thread shows the last N issues in reverse chronological order.

**Important:** Do not thread promotional emails from large e-commerce retailers (Amazon, ASOS, etc.) together with their order confirmation / shipping emails. `content` arcs for `amazon.com` must be entirely separate from `package` arcs for `amazon.com`. The grouping key must include `workflow` in addition to `publisher`.

Each week's newsletter is a separate signal in the arc — the user reads the latest one when they open the arc. Older issues are accessible by scrolling up in the thread. This is exactly analogous to an iMessage thread — the arc IS the publisher relationship, and each newsletter issue is a message in that thread.

**For promotions:** Each promotional email from the same retailer threads into one arc. The arc becomes a "deals from ASOS" arc. This is helpful for users who want to check if there are any active deals before purchasing — they can open one arc and see all recent promotions.

---

### Bulk management

Volume management is the defining UX challenge for `content`. The inbox must make it easy to deal with many content arcs at once:

**Swipe actions (mobile):**
- Swipe left → Archive (primary dismiss gesture)
- Swipe right → Unsubscribe (surface the most powerful action for content)

**Bulk select in content view:**
- Long-press (mobile) or checkbox on hover (desktop) to select multiple arcs.
- Bulk actions: Archive all selected / Unsubscribe all selected / Add label.
- "Select all content" bulk action: archive or unsubscribe all `content` arcs in one tap. This is the "inbox zero for newsletters" feature — many users want to periodically nuke all content arcs and start fresh.

**Auto-archive rules:**
- In Settings → Account → Filtering, offer: "Auto-archive content emails after: Never / 7 days / 14 days / 30 days of being unread." Default: off. This lets users keep a clean content view without manual effort.

---

### Default view behaviour

Content arcs appear at the bottom of Default view, below all other urgency tiers. Within the `low` urgency tier:
- Sort by `lastSignalAt` descending (most recent publisher email first).
- Cap the number of content arcs visible in Default view: show maximum 5 content arcs below the fold, with a "See all X content emails →" link that opens the full Content view. This prevents newsletters from burying important email in long sessions.

Consider a dedicated **Content** view pre-seeded in the user's default view set — showing only `content` workflow arcs, sorted by recency. Users who actively read newsletters can use this as their "reading" view. Users who don't care can ignore it.

---

### Notification behaviour

- **Standard content (`newsletter`, `social_digest`, `product_update`, `announcement`):** No push notification. No badge. No interruption. These appear in the inbox silently when the user next opens the app.
- **Promotion with `discountCode` and no expiry:** Ambient push only — "20% off at ASOS — code SAVE20." Badge only, no popup. Users who care about deals will appreciate the badge; those who don't won't be interrupted.
- **Promotion with `discountCode` + `expiryDate` within 24 hours:** Interrupt push — "Your ASOS discount code expires tonight: SAVE20 (20% off)." This is the rare case where a content email earns an interrupt. Keep it to truly expiring codes — not "ends soon" marketing language without a real date.
- **Digest:** Include a brief "Content you might have missed" section at the bottom of the digest — top 3 content arcs by publisher volume. This is optional and configurable; many users will turn it off.

---

### Where to innovate

**Reading time estimate:** For newsletter arcs, estimate the reading time from the email body word count and display it on the arc row: "7 min read." This helps the user decide whether to read now (when they have 7 minutes) or save for later. Simple to compute from HTML-stripped word count at ≈200 WPM average.

**AI digest of newsletters:** Weekly (or on user request), generate an AI-written briefing across all unread newsletters from the past 7 days: "This week in your newsletters: [The Browser] covered LLM hallucination and the future of AI-assisted development. [Stratechery] wrote about Apple's antitrust situation. [TLDR] surfaced 5 developer tools worth trying." Each item deep-links to the relevant arc. This is the "morning briefing" concept applied to content — the user can consume a week of newsletters in 2 minutes. Bedrock generates this; trigger it on user request ("Summarise my newsletters") or on a weekly schedule.

**Topic-based organisation:** When `topics` fields are populated, offer topic filtering in the Content view: buttons for each topic seen across all content arcs (AI, Security, Business, Design, etc.). Tapping "AI" filters to newsletters and product updates tagged with that topic. This turns the content view into a curated reading experience — the user reads by topic, not by publisher. Especially powerful when the user subscribes to many sources.

**Automatic discount code wallet:** When `discountCode` is extracted from any content arc, automatically add it to a "Discount codes" panel in the app (accessible from the main nav or as a widget on the home screen). The wallet shows all active codes: publisher, code, discount, expiry date. Expired codes are greyed out and removable. The user never has to search their inbox for a promo code before checking out — they check the wallet. This is genuinely useful and completely differentiated from any existing email client.

---

## status

### What this workflow is

Terms-of-service updates, privacy policy changes, service notices, welcome emails, government communications, account notifications, and other administrative messages. These emails exist because a company is legally required to send them, or because their onboarding flow requires a welcome sequence.

The defining characteristic: **the user almost never needs to do anything.** A ToS update email from Stripe is background noise. A welcome email from a new service is a formality. A government notice about a programme the user enrolled in last year is bureaucratic acknowledgement. These are `silent` urgency — they exist in the record but should not intrude on the user's inbox.

The exception: some government communications or legal notices DO require action (respond by [date], opt out by [date], etc.). The classifier must identify these and should route them appropriately — but within `status`, `requiresAction` (if present in `effectiveDate` context) should be interpreted as "this one is worth looking at."

**The system blocks phishing-warning and terms-update emails by default.** See filtering config. This means many `status` arcs never reach the inbox at all — they are silently dropped at the filter level. The arcs that do arrive in `status` are the ones that passed through (e.g., government notices, which are on the allow-list).

### Data shape

```ts
interface StatusData {
  workflow: "status";
  statusType: "terms_update" | "privacy_policy" | "service_notice" | "welcome" | "government" | "account_notification" | "other";
  provider: string;
  effectiveDate?: string;    // when the change takes effect
  referenceNumber?: string;  // for government communications
  documentUrl?: string;      // link to the full document
}
```

### Urgency

Always `silent`. No exceptions. Status arcs are never shown in Default view. They never trigger push notifications. They are auto-archived on arrival and accessible only via the Archive view.

The one case where a `status` arc should not be auto-archived immediately: `government` + `statusType` where the email has a reference number and an `effectiveDate` in the future. These may matter later (tax notices, regulatory communications). For these, set urgency to `low` (not `silent`) and place them in Archive but mark them with a `government` label for easy retrieval.

---

### Arc list row (Archive view only)

Status arcs do not appear in Default view or any non-Archive view. When the user navigates to Archive and encounters a `status` arc:

**Left:** Info circle icon. Colour: light grey — these are the quietest arcs in the system. For `government` type: a government building or official seal icon in neutral blue — distinct enough to spot in a list.

**Centre:**
- **Provider name** in regular (not bold) weight: "Stripe", "Apple", "HMRC".
- **Status type label**: "Terms of service update", "Privacy policy update", "Service notice", "Welcome", "Government notice", "Account notification".
- **Effective date chip** if `effectiveDate` is set: "Effective 1 Feb 2025". For past dates, show in grey; for future dates, show in muted amber.
- **Reference number** for government communications: shown as a small chip — "Ref: UTR/2024/001847". This is searchable and often needed when dealing with government agencies.

**Right:**
- Timestamp of the email.
- **View document** link if `documentUrl` is set — opens the full policy/document in a new tab. This is the only action most status arcs support.

**No urgency badge.** No reply button. No action block. These arcs are records, not tasks.

---

### Arc detail (signal thread)

Minimal. Status arcs should not have elaborate detail views.

**Thread header:**
- Provider + status type.
- Effective date if present.
- Reference number chip if present.
- **View document** button if `documentUrl` is set.

**Signal card:**
- Render HTML in a sandboxed iframe at full width.
- For `welcome` emails: these are often long branded onboarding sequences. Render as normal — the user may want to refer back to setup instructions.
- For `terms_update` / `privacy_policy`: the email body typically contains a summary of what changed. Render it. Below the iframe, show a "View full terms" link to `documentUrl`.

**No reply. No compose. No actions other than Archive.**

---

### Auto-archive behaviour

- `welcome` → archive immediately on arrival. No push, no inbox appearance.
- `terms_update` → archive immediately on arrival. (Most are also blocked at the filter level.)
- `privacy_policy` → archive immediately on arrival.
- `service_notice` → archive immediately.
- `account_notification` → archive immediately.
- `government` → archive immediately BUT:
  - Add label `government` automatically.
  - Set urgency to `low` (not `silent`) so it appears in Archive with visual distinction.
  - If `effectiveDate` is in the future, add label `date:{effectiveDate}` for easy temporal search.
  - If `referenceNumber` is present, add label `ref:{referenceNumber}` — government communications are often searched by reference number years later.
- `other` → archive immediately.

**No status arcs should remain in Default view under any circumstances.**

---

### Monthly quiet summary

Because status arcs are completely invisible to the user in normal inbox use, offer a monthly transparency notice in the app — not a push notification, not a digest email, just an in-app card that appears once per month on the Archive view:

> "Last month, 23 status emails were automatically archived:
> 8 terms-of-service updates, 6 welcome emails, 5 service notices, 4 government notices.
> [See them in Archive →]"

This gives users confidence that the system is working correctly and nothing important was silently dropped. The card is dismissible and does not repeat until the following month.

---

### Notification behaviour

- **No push notifications** for any `status` arc. Zero. Not even ambient.
- **No digest inclusion** for standard status types (`terms_update`, `privacy_policy`, `welcome`, `service_notice`, `account_notification`).
- **`government` type:** Include in the monthly digest summary only — not as individual items. The digest notes "4 government notices archived this month."

---

### Filtering context (important for implementation)

The default account filtering config sets `blockDisposition.notice: "block"` for the two most common `status` sub-types:

1. **Phishing-warning notices** — bulk security awareness emails sent by banks ("We will never ask for your password"). These classify as `status` with `statusType: "service_notice"`. Silently blocked by default.
2. **Terms-of-service / privacy policy updates** — classifies as `status` with `statusType: "terms_update"` or `"privacy_policy"`. Silently blocked by default.

This means the UI should never receive most `status` arcs at all. The ones that do arrive have bypassed the block (government notices, manual allow-list entries, notices that don't match the block patterns).

The classifier prompt must include examples that distinguish:
- "Bank phishing warning notice" (status, block) vs. "Actual phishing email impersonating a bank" (alert with high spamScore, do not block — flag and investigate)
- "ToS update from Stripe" (status, block by default) vs. "Stripe account suspended notice" (alert, requiresAction: true, do not block)

This distinction is critical. Misclassifying a real account suspension as a ToS update and silently blocking it would be a significant product failure.

---

### Where to innovate

**Government document filing cabinet:** All `government` arcs accumulate in a searchable "Government" label view in Archive. The UI should surface this as a distinct section in Archive (below the normal archive list): "Government communications — 12 documents." Clicking it filters to all `government`-labelled arcs. Within this view, show the reference number prominently on each row, and offer search by reference number. This turns what was a pile of government emails into a structured filing system — the user can find their tax notice from 2022 in seconds.

**Opt-in status email digest:** Some users actually want to track ToS updates across their services — privacy-conscious users, legal professionals, compliance teams. Offer an opt-in monthly digest: "Terms and policy changes this month: Stripe updated their ToS (effective Feb 1), Apple updated their privacy policy, Google updated their data retention policy." Links to each document. This is a power-user feature — off by default, surfaced in Settings → Notifications.

**Onboarding welcome suppression:** The system-generated `welcome` email sent during onboarding (`statusType: "welcome"`, `TestData.triggeredBy: "system"`) should be handled specially — it should never appear in the user's inbox at all, even in Archive. This is a system-internal event, not a real incoming email. Treat `source: "system"` signals with `workflow: "status"` as truly internal and exclude them from all views including Archive. The onboarding UI handles the onboarding flow; these signals are just implementation artifacts.

---

## healthcare

### What this workflow is

Appointment reminders and confirmations, test and lab results, prescription notifications, insurance updates, medical billing, referral letters, and patient portal messages. The user has an ongoing relationship with a healthcare provider and this email is part of managing that relationship.

The defining characteristic: **high personal stakes, time sensitivity varies widely.** A test result that indicates a serious diagnosis is urgent. A routine "your appointment is confirmed" is not. An appointment reminder 24 hours before is high-urgency. The same reminder 2 weeks before is background noise. The inbox must navigate this range without being either dismissive of serious health information or over-alarming about routine admin.

Healthcare data is the most personal data the inbox handles. Design decisions must reflect this — privacy in notification bodies, discreet visual treatment, no AI summaries that risk surfacing sensitive details publicly.

### Data shape

```ts
interface HealthcareData {
  workflow: "healthcare";
  eventType: "appointment_reminder" | "appointment_confirmation" | "test_results" | "prescription" | "insurance_update" | "billing" | "referral";
  provider?: string;
  appointmentDate?: string;    // ISO datetime
  location?: string;
  requiresAction: boolean;
  portalUrl?: string;
}
```

### Urgency

- `test_results` → `high` always. The user may have been waiting for these. They warrant immediate attention — not because they are necessarily bad news, but because they always represent something the user needs to know.
- `appointment_reminder` with `appointmentDate` < 24 hours → `high`
- `appointment_reminder` with `appointmentDate` < 7 days → `normal`
- `appointment_reminder` with `appointmentDate` > 7 days → `low`
- `appointment_confirmation` → `normal` (confirmation of a booking; no action needed, but worth seeing)
- `prescription` + `requiresAction: true` (e.g., need to pick up, needs renewal) → `high`
- `prescription` + `requiresAction: false` → `normal`
- `insurance_update` → `normal` (policy changes, new coverage info)
- `billing` → `normal` (medical billing is stressful — never downgrade to `low`)
- `referral` → `high` (referrals often require the user to take action to book a follow-up)

Dynamic urgency escalation (same pattern as `travel`): `appointment_reminder` arcs escalate as `appointmentDate` approaches. The processor runs a scheduled job to update urgency as dates close in. The UI should also compute "time until appointment" dynamically from the stored `appointmentDate`.

---

### Arc list row

**Left:** Healthcare-specific icons per `eventType`:
- `appointment_reminder` / `appointment_confirmation` → calendar with a cross/medical symbol
- `test_results` → lab flask or microscope
- `prescription` → pill/Rx icon
- `insurance_update` → shield with a person
- `billing` → medical bill/receipt icon (distinct from `payments` receipt — use a cross overlay)
- `referral` → person-to-person arrow with medical cross

Colour: calm blue-green (teal) — medical, trustworthy, not alarming. Never red for routine healthcare arcs; only amber for `high` urgency (imminent appointments, action-required prescriptions).

**Centre:**
- **Provider name** in regular weight: "Dr. Smith's Office", "St. Thomas Hospital", "Aetna".
- **Event type label**: "Appointment reminder", "Test results available", "Prescription ready", "Insurance update", "Medical bill", "Referral letter".
- **Appointment date chip** when `appointmentDate` is present — use the same time-until format as `travel` and `scheduling`:
  - "Mon 20 Jan, 9:30am" (> 24h)
  - "Tomorrow 9:30am" (amber)
  - "Today 9:30am" (red)
  - "Yesterday" (grey — appointment has passed)

**Privacy-first secondary text:** Do NOT show the AI-generated summary on the arc row for `test_results` or any arc where the summary might contain sensitive health information. Instead, show only the provider name and event type label. The user must open the arc to see the content. This is a deliberate privacy design: healthcare information should not be visible to anyone glancing at the user's screen without the user intending to share it.

For non-sensitive types (`appointment_reminder`, `appointment_confirmation`, `insurance_update`), showing the provider + date on the row is fine. No medical diagnosis or results data on the row.

**Right:**
- Timestamp.
- **Book appointment / Reschedule button** for `appointment_confirmation` if a rescheduling link is available.
- **View results button** for `test_results` — opens `portalUrl` directly. Make this available on the row. Test results waiting to be viewed are time-sensitive; the user should not have to open the arc detail to act.

---

### Arc detail (signal thread)

**Thread header — Healthcare event card:**

For `appointment_reminder`:
```
┌──────────────────────────────────────────────┐
│  🏥  Dr. Smith — Appointment Reminder         │
│                                              │
│  Date:        Mon 20 Jan, 9:30am            │
│  Location:    123 Medical Centre, London     │
│  Provider:    Dr. Sarah Smith                │
│                                              │
│  [Add to calendar]   [Get directions]        │
│  [Reschedule / Cancel →]                     │
└──────────────────────────────────────────────┘
```

For `test_results`:
```
┌──────────────────────────────────────────────┐
│  🔬  Test Results Available                   │
│                                              │
│  Provider:    St. Thomas Hospital            │
│  Available:   Results ready as of 14 Jan     │
│                                              │
│  [View results in patient portal →]          │
└──────────────────────────────────────────────┘
```

For `billing`:
```
┌──────────────────────────────────────────────┐
│  🏥  Medical Bill                             │
│                                              │
│  Provider:    St. Thomas Hospital            │
│  (Amounts shown in email body below)         │
│                                              │
│  [Manage / Pay →]   [Download]              │
└──────────────────────────────────────────────┘
```

Note: for `billing`, do NOT extract amounts into the structured panel — medical billing is sensitive and the amounts can be confusing or alarming without full context. Render the email body as the authoritative source for billing details.

**Privacy-protected notifications:** Push notification bodies for healthcare arcs must be generic:
- "Test results available from St. Thomas Hospital" — NOT "Your blood test results are available"
- "Appointment reminder from Dr. Smith" — NOT "Your psychiatry appointment is tomorrow"

The notification title must name the provider; the body must not name the service type beyond what's on the `eventType` label. Healthcare is a protected category — what doctor you see and for what reason is private.

**Email body rendering:** Render in sandboxed iframe at full width. For `test_results`, the body may contain the actual results (some portals send the results in the email). Render faithfully — the user needs to see what the email contains. The privacy protection is at the notification and row-summary level, not the detail view level (the user has explicitly navigated into the arc).

**Actions:**
- `appointment_reminder` / `appointment_confirmation` → Add to calendar, Get directions, Reschedule/Cancel via `portalUrl`.
- `test_results` → View in portal (opens `portalUrl`). No other actions.
- `prescription` → View in portal. No pharmacy deep-links for now (too variable).
- `insurance_update` → View in portal / Download PDF.
- `billing` → Pay / Manage via `portalUrl`.
- `referral` → the referral is a document the user may need to bring to their next appointment; offer "Save to files" (downloads the email as PDF) or "Add reminder to book follow-up" (creates a `scheduling` arc manually).

---

### Threading behaviour

Groups by `provider` + broad `eventType` category. Each category is a separate arc per provider:
- Dr. Smith → Appointments arc (all appointment reminders + confirmations)
- Dr. Smith → Test Results arc (all test results)
- Aetna → Insurance arc (all insurance updates)
- St. Thomas → Billing arc (all billing)

Do NOT merge test results with appointment reminders for the same provider — they are different types of communication that require different actions.

Each appointment reminder + its confirmation threads together (same appointment). Each test result is typically a single signal (the result is ready — the conversation ends there). Each referral is a single-signal arc.

**After the appointment passes:** auto-archive the appointment arc (reminder + confirmation). Do NOT auto-archive test results, billing, or referral arcs — these may need to be referenced.

---

### Auto-archive behaviour

- `appointment_reminder` / `appointment_confirmation` → auto-archive 4 hours after `appointmentDate` passes. The appointment is done. No action needed.
- `test_results` → never auto-archive. These are permanent health records — the user may want to find them years later.
- `prescription` → archive after 7 days (either it was picked up or the prescription has likely changed).
- `insurance_update` → archive after 30 days (policy changes are noted; the insurance portal is the source of truth).
- `billing` → never auto-archive until the user confirms payment (same logic as `payments` invoice).
- `referral` → archive after 14 days or when the user manually archives.

---

### Default view behaviour

Healthcare arcs appear in their urgency tier without special treatment in Default view. Within the `high` urgency tier, `test_results` and imminent appointments sort above non-healthcare `normal` arcs because of the personal stakes.

Consider a dedicated **Health** view pre-seeded in the user's default view set — showing only `healthcare` workflow arcs sorted by `appointmentDate` ascending (upcoming appointments first). This gives the user a quick "what's coming up medically" view without navigating their general inbox.

---

### Notification behaviour

- **`test_results`:** Interrupt push — "Test results available from St. Thomas Hospital. Tap to view." No content details in the notification body. Deep-links directly to the arc (which then links to the portal).
- **`appointment_reminder` < 24h:** Interrupt push — "Appointment with Dr. Smith tomorrow at 9:30am." This is time-critical.
- **`appointment_reminder` 7 days before:** Ambient push — "Appointment with Dr. Smith on Mon 20 Jan."
- **`referral`:** Interrupt push — "Referral letter received from Dr. Smith." High personal stakes; the user needs to know.
- **`prescription` + `requiresAction: true`:** Interrupt push — "Prescription notification from Dr. Smith — action may be required."
- **`billing`:** Ambient push — "Medical bill received from St. Thomas Hospital."
- **`insurance_update`:** Ambient push — "Insurance update from Aetna."
- **Digest:** Include `test_results` and upcoming appointments (< 7 days) under "Healthcare" section.

---

### Where to innovate

**Appointment calendar view:** All `healthcare` arcs with an `appointmentDate` should be surfaced in the calendar view (arc timeline/calendar concept in TODO). A calendar showing all upcoming medical appointments — doctor, dentist, physio, specialist — derived entirely from the inbox. No manual entry. "What do I have medically in February?" is answered in one view. This is the most immediately useful innovation for this workflow.

**Medical billing simplification:** Medical bills are notoriously confusing. When a `billing` arc arrives, offer an AI-powered "Explain this bill" button that passes the email body to Bedrock and returns a plain-English summary: "This is a bill for your consultation on 10 Jan. You owe $180 after insurance. Payment is due by 15 Feb." No medical diagnosis in the explanation — just the financial breakdown. This addresses a genuine user pain point (medical bills are often incomprehensible) without overstepping.

**Prescription reminder:** When a `prescription` arc arrives for a medication that appears in previous prescriptions (same provider + medication pattern in email body), offer a "Set a refill reminder" option. The user specifies when they expect to run out; the system creates a `scheduling` arc at that date: "Time to refill your prescription from Dr. Smith." This is a common forgetting pattern — patients run out of medication because they forget to order the refill.

**Health summary export:** On user request, generate a PDF export of all `healthcare` arcs in a given date range — provider, event type, date, and a note about outcome (from the email body summary). Useful for:
- Preparing for a specialist appointment ("here's my medical history as inferred from my inbox")
- Insurance claims ("here's the appointment history for this claim")
- Tax filing (medical expense deduction)
This is generated by AI from arc data, saved as a PDF, and downloaded. Not stored on the server.

---

## job

### What this workflow is

Job applications, recruiter outreach, interview requests, offer letters, and rejection notices. The user is either actively job-searching or is receiving unsolicited recruiter messages. Either way, these emails sit at an emotionally significant intersection — career decisions, compensation discussions, time-sensitive interview scheduling, and the occasional rejection.

The defining characteristic: **every signal has a known stage in a pipeline.** Application submitted → application under review → interview requested → interview scheduled → offer extended → offer accepted/rejected, or at any point → rejection. The inbox should make the pipeline state visible without requiring the user to track it in a spreadsheet.

Unlike `crm` (which is commercial), `job` is personal. The same external discipline (reply-or-dismiss, track the relationship) applies, but the emotional stakes are higher. The UX should be professional and supportive — clear pipeline visibility, action-first layout, and no aggressive follow-up tracking that adds anxiety to an already stressful process.

### Data shape

```ts
interface JobData {
  workflow: "job";
  jobType: "application_status" | "recruiter_outreach" | "interview_request" | "offer" | "rejection" | "job_posting";
  company?: string;
  role?: string;
  location?: string;
  salary?: string;
  interviewDate?: string;      // ISO datetime
  applicationStatus?: "submitted" | "reviewing" | "interview" | "offer" | "rejected";
  actionUrl?: string;          // application portal, interview booking link
}
```

### Urgency

- `interview_request` → `high`. An interview request needs a timely response — delays signal disinterest. The user should see this immediately.
- `offer` → `high`. Offer letters are time-sensitive decisions; they typically have an expiry.
- `application_status` with `applicationStatus: "reviewing"` → `normal`. The application is moving; no action needed, but worth knowing.
- `recruiter_outreach` → `normal`. Inbound interest — worth reading; no deadline.
- `rejection` → `normal`. Needs to be read and processed; no action needed, but worth knowing immediately.
- `job_posting` → `low`. A job listing — for review when the user has time.
- `application_status` with `applicationStatus: "submitted"` → `low`. Acknowledgement of submission — informational.

Dynamic urgency: if `interviewDate` is set and is within 24 hours, bump urgency to `high` regardless of `jobType`.

---

### Arc list row

**Left:** Career-specific icons per `jobType`:
- `application_status` → document with a checkmark
- `recruiter_outreach` → person with a speech bubble
- `interview_request` → calendar with a briefcase
- `offer` → envelope with a ribbon/star — this is the most important email in the job workflow; the icon should be distinct and memorable
- `rejection` → document with a muted X (grey, not red — rejections are data, not disasters)
- `job_posting` → magnifying glass over a document

Colour: professional purple or indigo. Not the business teal of `crm` or the slate of `conversation` — job is personal career, and deserves its own distinct visual identity.

**Centre:**
- **Company name** in bold: "Google", "Stripe", "Anthropic".
- **Role** in regular weight below company: "Senior Software Engineer", "Product Manager, Growth". If `role` is absent, use `jobType` label.
- **Stage tracker chip** — the most important UI element for this workflow. A single chip on the arc row showing the current `applicationStatus`:
  - `submitted` → "Applied" (grey chip)
  - `reviewing` → "In review" (blue chip)
  - `interview` → "Interviewing" (amber chip)
  - `offer` → "Offer received" (green chip, bold)
  - `rejected` → "Not selected" (grey chip, italic) — neutral language, not harsh

The stage chip replaces the normal urgency badge for this workflow. The pipeline stage IS the key information; the urgency badge is redundant alongside it.

**Right:**
- Timestamp.
- **Interview date chip** if `interviewDate` is set: "Interview: Thu 18 Jan" or "Interview: Today 2pm" (amber if today).
- **Salary chip** if `salary` is extracted: "$180k–$220k" or "£65k" — for `offer` and some `recruiter_outreach` emails. Salary visibility on the arc row is valuable for quick triage: is this worth the recruiter's time? Is this offer competitive?

---

### Application pipeline tracker (arc detail)

This is the defining UX element for the `job` workflow. At the top of the arc detail, above the email body, render a horizontal pipeline tracker:

```
Applied → In review → Interviewing → Offer → ✓ Accepted
[●]————————[●]——————————[ ]——————————[ ]————————[ ]
```

- Active stage is highlighted (bold, filled circle).
- Completed stages are solid green.
- Future stages are hollow grey.
- `rejected` terminates the pipeline with a grey "✕" marker at the current stage: `Applied → In review → ✕ Not selected`.

The user can **manually advance the stage** by tapping the next stage marker — useful when the automatic extraction from email lags or the offer was communicated verbally. The manual stage is stored as a label: `job:reviewing`, `job:interviewing`, `job:offer`. When a new signal arrives with a more advanced `applicationStatus`, the pipeline auto-advances and overrides the manual label.

**Also show:**
- Interview date (from `interviewDate`) with an "Add to calendar" button.
- Salary range (from `salary`) in a chip, if present.
- Application URL (`actionUrl`) as a "View application" link.

**Signal cards:** Each signal in the arc is a message in the job relationship — initial outreach, application acknowledgement, recruiter follow-up, interview confirmation, offer letter. Show them chronologically. For `job_posting` signals (a role listing the user may want to apply to), the email body IS the primary content; render it prominently.

---

### Offer letter special treatment

`jobType: "offer"` is the single most important email a job-seeker receives. The offer letter arc gets elevated treatment across the entire UI:

- **Arc row:** Green left border (instead of the normal teal). Green "Offer received" chip instead of the normal stage chip. Salary displayed prominently.
- **Arc detail:** The pipeline tracker shows `offer` stage highlighted in green. A prominent "Review and respond" section appears above the email body with the key terms extracted: company, role, salary, start date, expiry date (when the offer expires). An "Accept" and "Decline" button pair — tapping "Accept" opens the reply composer with a drafted acceptance; "Decline" opens the composer with a drafted professional decline.
- **Push notification:** Interrupt tier — "Offer received from Anthropic. Tap to view." Include company name in the notification. The salary should NOT appear in the notification body (push notifications appear on lock screens — compensation is private).

**Offer expiry tracking:** If an offer expiry date is mentioned in the email body (common: "Please respond by Friday 24 January"), extract it and show a countdown: "Offer expires in 3 days." When expired, show in grey: "Offer deadline passed." This is extracted via AI at classification time — add `offerExpiryDate` extraction to the classifier prompt for `offer`-type emails.

---

### Rejection special treatment

Rejections are a normal part of job searching, but they carry emotional weight. The inbox should handle them with care:

- **Arc row:** Grey left border. "Not selected" chip in italic muted grey. No urgency badge. The visual treatment communicates: this is complete, nothing to do, and it's okay.
- **Arc detail:** Pipeline tracker ends with a grey `✕` at the current stage. No action buttons (there is nothing to do). The email body renders in full — some rejections include useful feedback.
- **Auto-archive:** Do NOT auto-archive rejections. The user may want to look back at their rejection history. Let them archive manually.
- **Push notification:** Ambient, not interrupt — "Update on your application to Google." Do NOT say "rejection" in the notification body. The user deserves to open the arc and read it privately, not be told "rejected" in a lock-screen notification.

---

### Threading behaviour

Groups by `company` + `role`. All emails from Stripe about the "Senior Engineer, Payments" role thread into one arc — initial contact, application confirmation, interview scheduling, offer or rejection. This gives a complete history of each job relationship in one place.

If `role` is absent: fall back to `company` alone. This means multiple roles at the same company may merge — acceptable in most cases (the user can manually create separate arcs or apply labels if needed).

`recruiter_outreach` from the same company for different roles should NOT thread together. A recruiter reaching out about a Product Manager role and a separate Engineer role are two different conversations. If `role` data is available, use it to separate them.

---

### Auto-archive behaviour

- `job_posting` arcs (listings the user saved) → never auto-archive, but suggest archiving after 30 days: "This job posting is 30 days old — archive?"
- `application_status: "submitted"` → auto-archive 14 days after arrival if no new signal arrives (no news = application probably passed quietly).
- `rejection` → never auto-archive (see above).
- `offer` → never auto-archive until the user accepts or declines and explicitly archives.
- `interview_request` → auto-archive 24 hours after `interviewDate` passes (the interview is done).
- `recruiter_outreach` without response → auto-archive after 30 days.

---

### Default view behaviour

Job arcs appear in their urgency tier. Within `high`:
- `offer` arcs sort first — they are the most important.
- `interview_request` arcs sort second.

Consider a dedicated **Career** view pre-seeded on account creation — showing only `job` workflow arcs sorted by pipeline stage (most advanced stage first), then by `lastSignalAt`. This gives a "where am I in each application?" snapshot without navigating the general inbox. Users who are not actively job-searching can hide or delete this view.

---

### Notification behaviour

- **`interview_request`:** Interrupt push — "Interview requested by Stripe." Include role if present. Deep-links to arc.
- **`offer`:** Interrupt push — "Offer received from Anthropic — Senior Engineer." Include company and role. Deep-links to arc.
- **`rejection`:** Ambient push — "Update on your application to Google." Never say "rejected" in the notification.
- **`application_status`:** Ambient push — "Application update from Stripe."
- **`recruiter_outreach`:** Ambient push — "Recruiter message from Google." Do not interrupt for unsolicited outreach.
- **Interview reminder (< 24h before `interviewDate`):** Interrupt push — "Interview with Stripe in 2 hours." This is scheduled by the processor when `interviewDate` is set — similar to travel departure reminders.
- **Offer expiry (< 48h before expiry):** Interrupt push — "Your Anthropic offer expires in 2 days." Include company and days-remaining.
- **Digest:** Include all open job arcs (any stage before `rejected`) under "Job applications." List company + role + current stage + last update.

---

### Where to innovate

**Application analytics dashboard:** For users with many applications, surface a summary at the top of the Career view: "12 active applications — 2 interviews scheduled, 1 offer pending, 3 at review stage." This is computed from arc pipeline stages. Below it, a funnel view showing conversion rates: "12 applied → 5 reviewing → 2 interviews → 1 offer." Not fancy charting — just text counts. This is the job-search equivalent of a sales pipeline and is completely absent from every existing tool.

**Interview prep package:** When an `interview_request` arc arrives, offer a one-tap "Prepare for interview" button. This triggers a Bedrock call with: company name, role title, and any job description text available from the arc signals. The response is a structured interview prep brief:
- Company overview (what they do, recent news)
- Role expectations (from the job description)
- Likely interview focus areas (for the role type)
- 5 questions to prepare for
- 3 questions to ask the interviewer

Rendered as a collapsed panel in the arc detail — expandable. The user can refer to it before the interview without leaving the app. This is a genuine differentiator — turning an interview scheduling email into an interview preparation tool.

**Salary benchmarking:** When `salary` is present on a `recruiter_outreach` or `offer` arc, show a small "Is this competitive?" link. Tapping surfaces a note: "Median salary for Senior Software Engineer in London is £{range}." Sourced from a salary dataset (Glassdoor API, Levels.fyi, or static curated data by role+location). This helps the user evaluate offers without switching to another tab.

**Auto-thank-you for interviews:** After `interviewDate` passes, offer a prompt in the arc detail: "Send a thank-you note?" with a draft reply generated by Bedrock: "It was great meeting you and the team yesterday. I'm excited about the opportunity and look forward to next steps." The user edits and sends. This is a professional norm that many candidates neglect — the inbox can nudge and draft it without the user having to remember.

---

## support

### What this workflow is

Helpdesk ticket emails — confirmations that a ticket was opened, agent responses, status updates, resolution notices, and closure confirmations. The user submitted a support request to some service and is now tracking its progress through a ticket system.

The defining characteristic: **there is a ticket ID and a resolution state.** Every signal in a support arc belongs to one ticket. The arc is "done" when the ticket is resolved or closed. The user's primary concern is: has this been resolved? And if not, do I need to respond to keep it moving?

Support arcs exist at the intersection of `conversation` (there is an agent on the other end) and `payments` (there is often a ticket number and a tracked lifecycle). The inbox should handle them like a lightweight helpdesk inbox — ticket-centric, resolution-state aware, and free of noise from routine status updates.

### Data shape

```ts
interface SupportData {
  workflow: "support";
  eventType: "ticket_opened" | "ticket_updated" | "ticket_resolved" | "ticket_closed" | "awaiting_response" | "status_update";
  ticketId?: string;
  service: string;
  priority?: "low" | "normal" | "high" | "urgent";
  agentName?: string;
  responseUrl?: string;
}
```

### Urgency

Mapped from `priority` (the ticket's own priority level, set by the support system):
- `priority: "urgent"` → `critical`. This is rare but means something is actively broken and needs the user's attention now.
- `priority: "high"` → `high`
- `eventType: "awaiting_response"` → `high` (the support agent is waiting on the user; not responding stalls the ticket)
- `priority: "normal"` → `normal`
- `priority: "low"` → `low`
- `eventType: "ticket_opened"` → `low` (acknowledgement; no action needed)
- `eventType: "ticket_resolved"` or `"ticket_closed"` → `low` (confirmation; no action needed)
- If `priority` is absent: default to `normal`

---

### Arc list row

**Left:** Ticket/headset icon. A stylised headset works for the generic case; for developer-focused services (GitHub, Jira, Linear, Intercom), consider service-specific icons if the `service` field matches a known set. Use a neutral grey-blue — support is operational but not alarming.

**Centre:**
- **Service name** in bold: "GitHub Support", "AWS Support", "Stripe Help Center".
- **Ticket ID chip** — always shown when `ticketId` is present. Format: "#SUP-4821" or "#12839" depending on the service's numbering scheme. This is the single most important piece of identification information. Make it copiable (tap to copy) from the row — users on the phone with support often need the ticket number fast.
- **Status label** in muted text: "Ticket opened", "Agent replied", "Awaiting your response", "Resolved", "Closed". Map from `eventType`:
  - `ticket_opened` → "Ticket opened"
  - `ticket_updated` → "Agent replied" (if `agentName` is present: "Reply from {agentName}")
  - `awaiting_response` → "Awaiting your response" (amber text — this one needs action)
  - `ticket_resolved` → "Resolved" (green text)
  - `ticket_closed` → "Closed" (grey text)
  - `status_update` → "Status update"
- **AI summary** of the agent's last message (for `ticket_updated`, `awaiting_response`): "Agent asking for your server logs from the failing deployment on Jan 14." This surfaces what the user needs to do without opening the arc.

**Right:**
- Timestamp of last update.
- **"Reply" button** on the row for `awaiting_response` type — same as `auth`'s "Copy" button: a small action inline on the row that opens the reply composer in the detail view. Support tickets that need a response should not require more than 2 taps to reply.
- **Priority badge** if `priority: "urgent"` or `"high"`: show a priority chip ("Urgent", "High") instead of the normal urgency badge. The support system's priority label is more specific than the generic urgency system.

---

### Ticket status bar

Above the AI summary on the arc row (or at the top of the arc detail), render a 4-step status bar:

```
[●]——[●]——[ ]——[ ]
Open  In progress  Awaiting response  Resolved/Closed
```

State mapping:
- `ticket_opened` → "Open" step active
- `ticket_updated` → "In progress" step active
- `awaiting_response` → "Awaiting response" step active (amber)
- `ticket_resolved` / `ticket_closed` → "Resolved/Closed" step active (green, all steps filled)

This mirrors the delivery status bar from `package` — it turns a series of email updates into a visual lifecycle view.

---

### Arc detail (signal thread)

**Thread header — Ticket card:**

```
┌──────────────────────────────────────────────┐
│  🎧  GitHub Support — #GHI-00423             │
│                                              │
│  Service:     GitHub                         │
│  Priority:    High                           │
│  Status:      In progress (Agent replied)    │
│  Agent:       Sarah M.                       │
│                                              │
│  [Reply to ticket →]   [View in portal →]   │
└──────────────────────────────────────────────┘
```

Followed by the ticket status bar.

**Signal cards:** Each email in the support thread is rendered chronologically. Support ticket emails often follow a predictable template (ticket header, agent message, footer). The email body renders in full — the agent's response IS the content and the user needs to read it.

For `awaiting_response` signals specifically: render the user's last message (from `sentMessageIds` history if available) alongside the agent's follow-up question, so the user can see the full context without scrolling. This is analogous to the `conversation` thread view — it should feel like a two-way conversation, not a series of system notifications.

**Reply composer for support:** Opens inline. Special behaviour for support tickets:
- **To:** The support email address (from `signal.from.address` of the agent's email).
- **Subject:** The ticket reference in the subject, verbatim — support systems match threads by subject. Do NOT change the subject line. Pre-fill with the exact original subject: "Re: [Ticket #GHI-00423] API rate limits on free tier".
- **Body:** Quote the agent's last message, since most support systems require quoted context to keep threads coherent on their end. This is the one `workflow` where quoted reply bodies are correct behaviour.
- After sending: show "Reply sent to GitHub Support — ticket will update." The arc's `sentMessageIds` is updated.

**Resolution panel:** When `ticket_resolved` or `ticket_closed` arrives, show a green "Resolved" banner at the top of the arc detail:
- "Your ticket #GHI-00423 has been resolved."
- One-tap "Archive" button — resolved tickets should be archived immediately. Unlike `conversation` where archiving on reply is inappropriate, support tickets are done when resolved.
- Optional "Did this solve your issue?" satisfaction prompt — not from the inbox itself, but if the support email contains an inline feedback link, surface it prominently.

---

### Threading behaviour

Groups by `ticketId` when present — this is the authoritative threading key. All signals for ticket #GHI-00423 thread together regardless of subject variation, agent changes, or time elapsed. Support tickets have a canonical identifier; use it.

If `ticketId` is absent: fall back to `service` + subject-based matching (strip "Re:" and ticket-number prefixes, match on core subject). This handles services that don't include the ticket ID in every email.

**Multi-ticket handling:** If the user has multiple open tickets with the same service (e.g., two open GitHub support tickets), each gets its own arc. The `ticketId` is the discriminator. Never merge different tickets into one arc.

---

### Auto-archive on resolution

When `ticket_resolved` or `ticket_closed` arrives:
- Auto-archive 24 hours after the resolution signal arrives.
- If the user has already interacted with the arc (opened it, replied), auto-archive immediately when the resolution arrives.
- If the user re-opens the ticket later (a new `ticket_updated` signal arrives for the same `ticketId` after closure), create a new arc — the old one is archived and the new signal starts a fresh thread.

---

### Default view behaviour

Support arcs appear in their urgency tier. `awaiting_response` arcs with `high` urgency sit above other `normal` arcs within the tier — waiting on the user creates implicit deadline pressure.

Consider a dedicated **Support** view pre-seeded in the user's default view set — showing only `support` workflow arcs sorted by status (open/in-progress/awaiting-response first, resolved/closed last). This gives a "my open tickets" dashboard that mirrors what a real helpdesk user would want.

---

### Notification behaviour

- **`ticket_opened`:** Ambient push — "Support ticket opened with GitHub (#GHI-00423)." Confirmation, not action-required.
- **`ticket_updated` (agent replied):** Interrupt push if `priority: "urgent"` or `"high"`; ambient otherwise — "Reply from GitHub Support on ticket #GHI-00423." Include agent name if present.
- **`awaiting_response`:** Interrupt push — "GitHub Support is waiting for your response on ticket #GHI-00423." This one always warrants interrupt because it stalls the ticket.
- **`ticket_resolved`:** Ambient push — "Ticket #GHI-00423 has been resolved." Good news; no urgency.
- **`ticket_closed`:** No push (redundant with resolved, or already expected).
- **Digest:** Include all open tickets with `awaiting_response` status. Group under "Support tickets awaiting your reply."

---

### Where to innovate

**AI-powered reply drafts for support tickets:** When `awaiting_response` arrives and the agent is asking a question, offer a "Draft a reply" button in the arc detail. Pass the full ticket thread to Bedrock and generate a relevant response to the agent's question. For technical support (GitHub, AWS, Stripe), the draft should be a technical answer if the error message or context is available. For billing support, a factual description of the issue. The draft is clearly marked "AI draft — review before sending." This is high-value: support replies require reading through long threads and composing technical answers — AI can dramatically reduce that effort.

**Ticket SLA monitoring:** For `priority: "urgent"` and `"high"` tickets that have been in `ticket_opened` or `ticket_updated` state for more than 24 hours without an agent reply, show an escalation indicator in the arc detail: "No response in 24+ hours — this ticket may be outside SLA." Include a link to the service's support escalation path if known. This turns the inbox into a passive SLA watcher — the user doesn't have to remember to follow up on stalled tickets.

**Support history per service:** In the arc detail sidebar, show a compact history of the user's past tickets with this service: last 3 tickets, their status, and resolution time. "Your GitHub Support history: 3 tickets — avg. resolution 2.4 days." This gives context before the user replies — they can see if this type of issue was resolved quickly before or if it required escalation. Built from existing `support` arcs for the same service.

**Bulk ticket management:** For users with many open tickets (developers, SaaS power users), enable bulk actions in the Support view: select multiple resolved tickets and archive them all. "Archive all resolved" as a one-tap action at the top of the Support view. Resolved tickets pile up and need periodic cleanup — this makes it effortless.

---

## test

### What this workflow is

Emails sent by the account owner — or by the system on the account owner's behalf — to verify that the inbox setup is working correctly. The user just wired up SES, pointed their MX record at it, and sent themselves a test email to confirm delivery. This is the "aha moment" workflow.

There are two triggering paths, both resulting in `workflow: "test"`:

1. **User-sent test** (`TestData.triggeredBy: "user"`): the `signal.from` address matches a domain registered to the account (e.g., `me@mydomain.com` and `mydomain.com` is registered) OR matches any user's email address on the account. The processor overrides any classifier assignment with `workflow: "test"`. This fires during and after onboarding whenever the account owner sends to their own address.

2. **System-generated test** (`TestData.triggeredBy: "system"`): the processor creates a synthetic `SYS#`-prefixed signal during onboarding Step 2 if no real email arrives within 3 minutes. The onboarding UI treats arrival of any `test` arc — real or system-generated — as success.

The defining characteristic: **the user is actively watching for this.** They opened their phone's mail app or Gmail, sent an email to their new address, and are now standing in front of the inbox waiting for it to appear. The latency between send and receive is what they are measuring. This is the highest-attention moment in the entire onboarding funnel — every millisecond of perceived latency matters, and the experience when it arrives must be memorable.

Additionally, the system **always replies** to `test` arcs with a Bedrock-generated pong — a short, playful, witty reply that riffs on whatever the user actually wrote. This proves two-way communication is working, not just inbound.

### Data shape

```ts
interface TestData {
  workflow: "test";
  triggeredBy: "user" | "system";
}
```

### Urgency

Always `high`. The user is actively waiting. Push priority: `interrupt`. This maps to interrupt-tier push notifications — same as a meeting invite or interview request. The user needs to know the moment it arrives.

---

### Onboarding step 2 — the aha moment

The `test` arc's most important appearance is during onboarding Step 2. This is not a standard inbox view — it is a dedicated full-screen waiting experience. The inbox views this section of the spec as requirements for the **onboarding UI**, not the standard arc list.

**Layout:** Full-screen. No nav bar. No other arcs. Minimal UI. The entire screen is focused on one thing: the moment the email arrives.

**Waiting state (before the email arrives):**
- Large, calm headline at the top: "Let's make sure everything is working."
- Below it: the user's new address in a large monospace pill with a one-tap copy button. E.g., `you@yourdomain.com`. The copy button matters because the user needs to paste this address into their mail app.
- Below the address: a simple instruction in regular body text: "Open Gmail, Outlook, or any email app and send an email to this address. We'll show it here the moment it arrives."
- Below the instruction: the waiting animation. Not a spinner. Not a progress bar. Something alive and calm — a gentle pulsing ring or breathing glow around an empty inbox card. The animation says "I'm listening" without saying "I'm loading." Copy inside or below the animation: "Waiting for your email…"
- Bottom of screen: a muted secondary link — "Didn't arrive? Troubleshoot →" — pointing to a help article about MX propagation and SES setup. Do not display this link in the first 60 seconds; it adds anxiety before the user has had time to send the email.

**The moment the email arrives (real-time via WebSocket or long-poll):**

This is the product's first impression. It must be executed with care.

1. The waiting animation resolves — the pulse stops, the ring fills in with a satisfying completion animation (not a spinner stopping, but a completion: ring becomes a checkmark, or the empty card "fills in" with a smooth entrance).

2. The arc card appears in the centre of the screen, sliding up from below or fading in. The card shows exactly what the arc list row would show in the real inbox:
   - Flask/beaker icon on the left.
   - The sender name (the user's own name, from their Gmail "From" display name) in bold.
   - The subject line they wrote.
   - The AI-generated summary (if available within the processing latency window) — or just the subject if the summary isn't ready yet. Do NOT show a blank summary; fall back to subject.
   - A "TEST" badge on the card.
   - The timestamp: "Just now."

3. A brief celebration moment: one pass of confetti, or a satisfying chime sound (optional, respects system silent mode), or a simple green checkmark that pulses once. Do not over-animate. The moment should feel like a sigh of relief, not a party.

4. Below the card, copy appears: "It works. Your first email just arrived."

5. Two seconds later (give the user a moment to read), a second card slides up below the first. This is the pong reply:
   - The pong card has a distinct visual treatment: a slightly different background colour (muted teal tint), and a header line: "We replied →"
   - Below the header: the Bedrock-generated reply body. Short (≤3 sentences). Witty and warm — it riffs on whatever the user wrote, not a generic message.
   - Below the body: the sender address the pong was sent from — either `signal.to` (if `senderSetupComplete: true`) or the system `NOTIFICATION_FROM` address (if not). If the pong was sent from the system address, include a small inline note: "Sent from our address — complete sender setup to reply from your domain →".

6. After the user has had 3–4 seconds to read both cards, a CTA fades in below: **"Continue →"** — proceeds to Step 3 (sender setup) or Step 5 (you're ready), depending on whether sender records were already verified in Step 1.

**System-generated fallback (if no real email arrives in 3 minutes):**

The 3-minute timer is hidden from the user — do not show a countdown. After 3 minutes, quietly trigger the system fallback:
- The waiting animation transitions to a slightly different state: the pulsing slows. A gentle message appears: "Still waiting… If your email is taking longer than usual, we can send you one instead."
- A single CTA appears: "Send me a test email" — this triggers the `SYS#` signal creation server-side.
- The system signal arrives almost immediately (< 1 second, it is generated server-side). The onboarding experience plays out identically — same card, same pong, same celebration, same "It works." copy. The user cannot tell (and does not need to know) that this was system-generated.
- The system signal card shows sender: "System (onboarding)" with a muted visual treatment — it is visually distinct from a user-sent email but still confirms the plumbing works.

---

### Arc list row (post-onboarding)

After onboarding, the user may continue to send test emails (checking setup after DNS changes, testing a new email address, etc.). These appear in the regular inbox.

**Visual treatment:** Deliberately distinct from real mail. The user must never confuse a test arc with a real email.

- **Left:** Flask/beaker icon — the same as used in onboarding. Use a muted blue-grey colour. Not the warm/vibrant colours of action-required workflows.
- **Background tint:** Very subtle light teal or lavender wash on the arc card — not white like normal arcs. Visible but not jarring.
- **"TEST" badge:** A small pill badge reading "TEST" in monospace, positioned top-right of the arc card. Muted colour (grey outline, no fill). This is always present — no test arc should appear without it.
- **Centre:**
  - Sender name in regular (not bold) weight.
  - Subject line in muted text.
  - AI summary, if available. For test emails the user wrote themselves ("hey testing 123"), the summary will be sparse; this is fine.
- **Right:** Timestamp. No urgency badge (the TEST badge serves that function visually). No CTA on the row itself.

**Placement in Default view:** Test arcs appear in Default view, but in a **collapsible "Tests" section** at the bottom of the Default view — below all active real arcs, regardless of urgency. The section header reads "Tests (2)" with a collapse toggle. By default expanded. When collapsed, the section header remains as a reminder that test arcs exist.

Do not elevate test arcs above real mail in the Default view even though they are `high` urgency. The urgency drives push notification timing (so the user gets an interrupt when the test arrives), but it should not compete with real email for inbox prominence post-arrival. Once received, test arcs are informational, not action-required.

---

### Arc detail (signal thread)

**Thread header:**
- Flask icon + "Test email" label.
- `triggeredBy` indicator: "Sent by you" (user) or "Sent by system (onboarding)" (system).
- Timestamp of arrival.

**Signal card (the original test email):**
- Renders normally — from, to, subject, body in sandboxed iframe.
- If the body is trivial ("testing 123"), that is fine — the important content is the pong card below it.

**Pong reply card:** Always shown in the arc detail, directly below the original signal card. This is not a separate arc or a separate email — it is a visual representation of the outbound pong reply that was auto-sent.

The pong card layout:
```
┌──────────────────────────────────────────────┐
│  ← We replied                                │
│                                              │
│  From: you@yourdomain.com (or NOTIFICATION_FROM) │
│  To:   sender@gmail.com                      │
│  Sent: 14 Jan, 3:42pm                        │
│                                              │
│  [Pong reply body — the witty Bedrock reply] │
│                                              │
│  (If sent from system address:)              │
│  Sent from our address. Complete sender      │
│  setup to reply from your own domain →       │
└──────────────────────────────────────────────┘
```

The pong card has a distinct visual treatment: light teal background tint, "← We replied" header in small muted text. It should feel like an outbound message in a two-way conversation — the design mirrors how sent messages appear in iMessage (different colour, right-aligned or visually distinct).

**If the pong failed** (Bedrock error or SES send error): do not show the pong card at all. Instead, show a small muted notice below the original signal card: "Auto-reply could not be sent." Do not surface this as an error — it is a secondary feature and the test email itself was successfully received.

**No reply composer for test arcs.** The user cannot reply to their own test email via the inbox — that would create an infinite loop. The reply composer must not appear for `workflow: "test"`.

**No archive suggestion.** Test arcs are self-cleaning: auto-archive after 7 days (see below).

---

### Pong reply generation

The Bedrock call is made server-side by the processor immediately after the `test` workflow is detected. It is a post-classification side effect, analogous to how the notifier fires.

**Prompt shape:**
```
A user just sent a test email to check that their new inbox is working.
Read their email and write a short, witty, warm reply that plays on 
whatever they wrote. Keep it under 3 sentences. Do not be generic — 
react to the actual content. Sign off as "the system." 

Subject: {signal.subject}
Body: {signal.textBody}
```

**Sender address logic:**
- `domain.senderSetupComplete === true` → send pong from `signal.to` (the user's own domain address). This proves their sending setup works end-to-end.
- `domain.senderSetupComplete === false` → send pong from `NOTIFICATION_FROM` (the platform's own address). Still sends a reply; just not from the user's domain. Include a sentence in the pong body acknowledging this: "P.S. — I replied from our address since your sending setup isn't complete yet. Finish that and I'll reply from yours."

**`arc.sentMessageIds` update:** The pong message ID is added to `arc.sentMessageIds`. This is correct behaviour — a reply was sent on this arc, even though it was system-generated. The priority calculator will promote urgency on the next inbound signal, which is correct (if the user replies to their own pong, that's an active test loop that deserves attention).

---

### Threading behaviour

Each test email creates its own arc. Do not group test arcs together. The user may send five test emails over a week (during setup, after DNS changes, after adding a new address) — each is a distinct verification event, and merging them would obscure whether each individual test succeeded.

The grouping key for `test` is intentionally unique per signal: use `signal.id` as the grouping key, not a shared `senderETLD1` or subject hash.

---

### Auto-archive behaviour

Auto-archive `test` arcs after **7 days**. Tests that happened a week ago are historical; they do not belong in the active inbox. The arc is still accessible in Archive for the retention period.

If the user wants to keep a test arc (e.g., it contains useful setup confirmation information), they can pin it or label it before the 7-day window passes.

---

### Default view behaviour

Test arcs appear in the collapsible "Tests" section at the bottom of Default view. They do not mix with real mail. The "Tests" section:
- Header: "Tests (N)" where N is the count of active test arcs.
- Default state: expanded.
- Collapsed state: the header remains; arc rows are hidden.
- If N = 0: the section is hidden entirely — do not show an empty "Tests" section header.
- If the user has never sent a test email (no test arcs exist): the section never appears.

During onboarding Step 2 only, a test arc briefly appears at the top of the full-screen waiting view. After onboarding, it moves to the Tests section.

---

### Notification behaviour

- **Push:** Interrupt-tier — "Your test email arrived. Setup is working!" Deep-links to the arc (and during onboarding, deep-links back to Step 2 if the user had navigated away while waiting).
- **Notification body:** Include the subject line if it is short (≤ 40 characters): "Your test email 'hey testing!' arrived." If longer, truncate: "Your test email arrived."
- **Pong confirmation:** No separate notification when the pong is sent. The original arrival notification is sufficient. Do not send "We replied to your test email" — it creates notification noise around what is already a notification.
- **System-generated test:** Same push notification as user-generated — "Your test email arrived." The `triggeredBy: "system"` distinction is for the onboarding UI, not for the user.
- **Digest:** Do not include test arcs in the digest. They are ephemeral setup verification events — they do not belong in a regular summary.

---

### Where to innovate

**Live arrival latency display:** On the arc card in onboarding Step 2, show the end-to-end latency of the email arrival: "Arrived in 4.2 seconds." This is computed as `signal.receivedAt - signal.sentAt` (both available on the signal). It is a tiny detail that has outsized impact — users who see "4.2 seconds" feel confident about the product's performance. Users who see "47 seconds" understand their DNS is slow. Showing the number is a transparency gesture that also serves as implicit performance marketing.

**Test email history view:** In Settings → Domains, show a "Test history" section per domain: the last 5 test arcs, their timestamps, arrival latency, and whether the pong was sent successfully from the domain address. This gives developers and admins a quick health-check history without navigating the inbox. Especially useful after DNS changes — "did the test email after my SPF update arrive successfully?"

**Named test modes:** Power users (developers, email administrators) sometimes want to run specific test scenarios: test that spam filtering is working, test that a specific address routes correctly, test that forwarding rules fire. Offer a "Send a test" action in Settings → Email Addresses that allows the user to trigger a system-generated test signal for a specific recipient address. The test goes through the full pipeline (classification, filtering, priority, pong) and the result appears in the inbox. This makes the test workflow a genuine developer tool, not just an onboarding feature.

**Pong personalisation:** The Bedrock prompt for pong replies should include the account's display name so the pong feels personalised: "Sign off as 'the system' but address {userName} by name." A pong that says "Hey Alex, nice to hear from you — though I have to say, 'testing 123' is the least creative thing you could have written" is far more memorable than a generic reply. It sets the tone for the product: this is an inbox that has a personality, and that personality is warm and a little cheeky.

---


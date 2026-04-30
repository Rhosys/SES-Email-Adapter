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

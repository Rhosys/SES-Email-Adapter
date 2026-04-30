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

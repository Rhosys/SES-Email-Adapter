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

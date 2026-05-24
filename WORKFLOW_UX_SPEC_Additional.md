# Email Action Types — Master Reference

44 distinct action types across all major email clients.
Each entry includes a description and a concrete usage example to guide spec work.

---

## In-Email Interactive Actions
*The recipient takes an action without leaving the inbox — buttons, forms, or cards embedded in the email itself.*

---

### 1. One-Click Confirm
A button in the inbox list or email body that fires a confirmation signal to the sender's server. No browser navigation. Single-use.

**Example:**
A user registers on a SaaS platform. They receive a welcome email with a "Confirm your email" button visible directly in their Gmail inbox list — no need to open the email. Clicking it sends a POST to `https://app.example.com/confirm?token=abc123`. The account is activated instantly.

---

### 2. Approve / Reject
A two-option decision card embedded in the email. The card refreshes to show the updated state once a choice is made. Designed for multi-step business sign-off chains.

**Example:**
A manager receives an expense report submission. The email contains an embedded card showing the submitter's name, amount ($340), and category (Travel). Two buttons: **Approve** and **Reject**. Clicking Approve calls the expense system API, marks the report approved, and the card updates to show "Approved by you on May 21".

---

### 3. Vote / Poll
A multi-option selection embedded in the email. Responses are aggregated server-side. The card can display live results after the recipient votes.

**Example:**
A team lead sends a meeting scheduling email with an embedded poll: "Which time works for you?" showing three options (Mon 10am / Tue 2pm / Wed 9am). Each team member clicks their preference directly in the email. After voting, the card updates to show a live bar chart of responses.

---

### 4. RSVP
An inline accept / maybe / decline response to an event invitation. On acceptance, the event is automatically added to the recipient's calendar.

**Example:**
A user receives a conference invitation email. The email shows event details and three inline buttons: **Going**, **Maybe**, **Can't attend**. Clicking **Going** adds the event to their Google Calendar and sends an acceptance back to the organiser — without opening any other app or page.

---

### 5. Flight Check-In
A button surfaced from a booking confirmation email that initiates or completes online check-in for a flight. Fires directly to the airline's check-in endpoint.

**Example:**
24 hours before departure, a user receives a check-in reminder email from Lufthansa. Instead of navigating to the airline website, they see a **Check In** button directly in Gmail. Clicking it submits their check-in via the airline API and returns a boarding pass.

---

### 6. Save Offer / Coupon
A single-use button that saves a discount code or offer to the user's account. Once clicked, the button becomes inactive — preventing duplicate redemptions from email.

**Example:**
A retail brand sends a Black Friday email with a 20% off code. Instead of copying the code manually, the user sees a **Save to my account** button. Clicking it stores the code against their logged-in session, ready to apply at checkout. The button then shows "Saved".

---

### 7. Add to Queue / Playlist
A variant of Save for media: save a song, podcast, or video to a playback queue directly from a promotional or notification email.

**Example:**
Spotify sends a "New release from an artist you follow" email. The email contains a **Add to queue** button. Clicking it adds the album to the user's active Spotify queue without opening the app or website.

---

### 8. Rate & Review
An inline star rating widget and optional text field. The recipient submits a review without visiting the sender's website.

**Example:**
After a hotel stay, the guest receives a post-checkout email. The email body contains a 1–5 star selector and a text box. The guest selects 4 stars, writes "Great location, slow check-in", and clicks **Submit Review** — all within the email. The review posts to the hotel's review system.

---

### 9. Survey / Form
A fully functional form inside the email body — text inputs, dropdowns, date pickers, checkboxes. Responses submit to the sender's backend. The email can update after submission to show a confirmation state.

**Example:**
An HR team sends an annual engagement survey via email. The email contains a 6-question inline form with radio buttons and a text area. The employee fills it out and clicks **Submit** without visiting any external URL. The email body then transitions to a "Thank you, your response was recorded" state.

---

### 10. View Reservation / Booking
A one-click button that deep-links directly to the specific booking page — not the homepage — for a flight, hotel, or order.

**Example:**
A user receives a hotel confirmation email. Instead of searching their inbox for the booking reference and navigating to the hotel site, a **View booking** button takes them directly to `hotels.example.com/bookings/RES-4921` with their reservation pre-loaded.

---

### 11. Track Package
A one-click button that opens the carrier's tracking page for that specific shipment, pre-filled with the tracking number extracted from the email.

**Example:**
A user receives a dispatch notification from an online shop. The email shows a **Track your order** button. Clicking it opens DHL's tracking page at `dhl.com/track?id=1234567890` — no manual entry of the tracking number.

---

### 12. Password-Protected Delivery
The sender encrypts the message body. The recipient receives a link. They must enter a pre-shared password to decrypt and read the contents. Works to any email address.

**Example:**
A lawyer sends a client their signed contract. Rather than attaching a PDF, they send an encrypted email. The client receives a message: "You have a secure message from J. Smith. Click here to read it." They enter the password agreed on a phone call, and the contract displays in a secure web view.

---

## Informational Callouts
*The email client extracts structured data and surfaces it — no sender interaction required, no click needed from the recipient.*

---

### 13. Flight Highlights
The client reads structured data in the email and surfaces flight details — airline, flight number, departure/arrival airports, times — as chips or a card shown above the email body.

**Example:**
A user receives a flight confirmation from British Airways. Before they even open the email, Gmail shows a card beneath the subject line: "BA 256 · LHR → JFK · 22 May, 09:15 → 12:30". No interaction needed — the data is simply there.

---

### 14. Hotel Reservation Highlights
Extracts check-in date, check-out date, property name, and confirmation number from a booking email and surfaces them as a card.

**Example:**
A Booking.com confirmation lands in a user's inbox. Gmail shows a chip: "Marriott Edinburgh · Check-in 24 May · Check-out 27 May · Ref: BK-88231". The user sees all the information they need without opening the email.

---

### 15. Transportation Highlights (Bus / Train / Car Rental)
Same extraction as hotel/flight but for ground transport: departure point, arrival point, times, booking reference.

**Example:**
A user books a Eurostar train. The confirmation email is parsed and Gmail surfaces: "Eurostar · London St Pancras → Paris Gare du Nord · 25 May, 07:04 → 10:26 · Ref: EUR-3391".

---

### 16. Order Highlights
Extracts and surfaces order details — item image, cost, estimated delivery date — as chips above the email.

**Example:**
An Amazon order confirmation arrives. Without opening the email, the user sees: "[product image thumbnail] · £49.99 · Estimated delivery: 23 May".

---

### 17. Real-Time Shipment Status Badge
A live status indicator shown in the inbox that updates automatically as the package moves through carrier checkpoints — without re-opening the email.

**Example:**
A user ordered a laptop. The dispatch email has a real-time badge. On Monday it shows "In transit". By Wednesday it shows "Out for delivery". By 2pm it shows "Delivered". The user never re-opens the email — the inbox row itself reflects live carrier data.

---

### 18. Event Highlights
Surfaces event details — venue, date, time, seat number — as a card shown above the email body.

**Example:**
A user buys tickets to a concert via Ticketmaster. The confirmation email is parsed and Gmail shows: "The National · O2 Arena, London · 30 May, 19:30 · Seats: Block C, Row 12, Seat 4–5".

---

### 19. Verification Code Callout
The email client detects a one-time code (OTP, 2FA, confirmation PIN) and surfaces it prominently — as a chip, autofill suggestion, or callout — so the user does not have to search for it.

**Example:**
A user is logging into their bank on mobile. The 6-digit SMS-style code arrives by email instead. Before the user switches apps, iOS surfaces the code as a keyboard autofill suggestion: "From Mail: 847291". One tap fills the field.

---

### 20. Add to Calendar (Auto)
The client detects an event in any confirmation email and offers to add it to the calendar without any markup from the sender — parsing the natural language or common patterns.

**Example:**
A user receives a calendar invite in plain text: "Team offsite — Friday 6 June, 10am, Shoreditch Works, London." Apple Mail detects it and shows an "Add to Calendar" banner above the email body.

---

### 21. Boarding Pass / Wallet Import
The email client detects a boarding pass, event ticket, or loyalty card and offers to import it into the device's native wallet. Available passively — no sender markup required.

**Example:**
A user receives a Ryanair boarding pass as a `.pkpass` attachment. Apple Mail shows a banner: "Add to Apple Wallet". One tap and the boarding pass appears in Wallet, ready for the airport scanner — no app download needed.

---

### 22. Priority / Time-Sensitive Callout
The client identifies an email as time-sensitive and surfaces it at the top of the inbox with a visual flag, above all other unread mail.

**Example:**
A user receives a same-day dinner invitation at 8pm. At 5pm, Apple Mail moves it to the top of the inbox under a "Time Sensitive" label, above 40 other unread emails, so it is not missed.

---

## Sending Controls
*Actions the sender configures that affect how or when an email is delivered.*

---

### 23. Scheduled Send
Compose now, deliver at a specified future date and time.

**Example:**
A product manager writes a release announcement on Sunday evening but wants it to land in recipients' inboxes at 9am Monday. They write the email, click **Schedule send**, pick Monday 9:00am, and it sends automatically without them needing to be at their desk.

---

### 24. Undo Send
A configurable delay window after hitting Send, during which the message can be recalled before it leaves the server.

**Example:**
A user hits Send on an email and immediately notices they forgot to attach the file they referenced. They click **Undo** within the 10-second window. The email is cancelled and returned to Draft, allowing them to attach the file and resend.

---

### 25. Read Receipt
The sender is notified when the recipient opens the email, including the timestamp and in some implementations the device type.

**Example:**
A sales rep sends a proposal to a prospect on Tuesday. On Thursday at 11:42am they receive a notification: "Your email to alex@company.com was opened." They now know the prospect has read it and can time a follow-up call accordingly.

---

### 26. Follow-Up Reminder (No Reply)
If no reply is received within a set time, the email resurfaces at the top of the sender's inbox as a prompt to follow up. Triggered by absence of response, not a timer.

**Example:**
A freelancer sends an invoice and sets a 5-day follow-up reminder. If the client does not reply within 5 days, the invoice email reappears at the top of their inbox flagged "No reply — follow up?". They send a polite nudge.

---

### 27. Expiring / Self-Destructing Message
The sender sets a time window. After it expires, the message is automatically deleted or becomes unreadable.

**Example:**
An HR team sends interview feedback to a hiring panel. The email is set to expire in 48 hours to comply with GDPR data minimisation policy. After 48 hours, recipients see "This message has expired and is no longer available."

---

### 28. Encrypted External Delivery
Instead of sending plaintext to a non-encrypted recipient, the system sends a link to a secure web page where the message can be read inside an encrypted session. The email in transit never contains the plaintext.

**Example:**
A doctor emails test results to a patient who uses a standard Gmail account. Rather than the results appearing in plaintext, the patient receives: "Dr. Müller has sent you a secure message. Click here to read it." They authenticate with their date of birth and read the results in a secure browser session.

---

## Triage & Routing
*How the client automatically organises, surfaces, or filters incoming mail.*

---

### 29. Snooze / Defer
Remove an email from view until a chosen time, at which point it returns to the top of the inbox as if newly arrived.

**Example:**
A user receives an email about a conference registration deadline — but the deadline is in 3 weeks. They snooze it for 2 weeks 6 days. It disappears completely until then, keeping their inbox clean, and reappears the day before the deadline.

---

### 30. Sender Screening / Gating
The first time a new sender emails you, their message is held in a queue. You explicitly approve or block them before any mail from them reaches your inbox.

**Example:**
A freelancer uses HEY. A potential new client emails them for the first time. Rather than landing in the inbox, it hits the Screener queue. The freelancer sees: "First email from mark@acmecorp.com — let them in?" They approve, and all future emails from that sender go straight to the inbox.

---

### 31. Auto-Categorisation
Incoming emails are automatically sorted into named categories using ML — Primary, Transactions, Updates, Promotions — and each category is browsed separately.

**Example:**
A user's inbox no longer shows a single chronological list. Order confirmations from Amazon, shipping notices from FedEx, and bank statements all land in "Transactions". Newsletters land in "Updates". Only direct emails from real people land in "Primary". They process each category in a single focused session.

---

### 32. Pipeline / Stage Tracking
Email threads are moved through named custom stages. Gives email a lightweight kanban workflow layer for tracking multi-step processes.

**Example:**
A freelancer manages client projects via email. They create a Workflow with stages: **Brief received → Proposal sent → In negotiation → Contract signed → Active**. Each client thread sits at its current stage and can be dragged forward as things progress — no external project tool needed.

---

### 33. Auto-Filing Rules
Multi-condition if/then rules that automatically label, archive, forward, delete, or respond to emails based on sender, subject, headers, or body content.

**Example:**
A developer sets a rule: "If sender domain is `github.com` AND subject contains `[CI]` → skip inbox, apply label `CI`, mark as read." All GitHub CI notification emails are automatically filed and never clutter the inbox, but remain searchable.

---

### 34. Masked / Alias Address
Generate a unique throwaway email address per service or sender. All mail to that alias arrives in the real inbox, but the alias can be individually blocked or deleted without affecting the real address.

**Example:**
A user signs up to a new e-commerce site. Instead of giving their real address, they generate `shop-alias-7f3k@domain.com`. Three months later they start receiving spam. They delete that single alias — the spam stops, their real address is unaffected, and no other service is disrupted.

---

### 35. No-Read-Receipt / Tracking Pixel Block
The client silently blocks all tracking pixels in incoming emails, preventing senders from knowing if or when the email was opened.

**Example:**
A user enables Mail Privacy Protection in Apple Mail. Marketing emails from retailers fire tracking pixels, but Apple's proxy pre-loads all remote content before displaying the email. The sender's analytics show the email was "opened" when it was pre-fetched — the real open time and IP address are never exposed.

---

## Collaboration & Delegation
*Actions that involve multiple people coordinating around a shared email thread.*

---

### 36. Assign to Teammate
Mark an email thread as owned by a specific team member. The assignee sees it in their queue; others see it is handled. Prevents double replies.

**Example:**
A shared support@ inbox receives a complex billing dispute. The first responder assigns it to the billing specialist with a note: "Customer has been waiting 3 days, high priority." The thread disappears from the general queue and appears in the specialist's assigned view. No one else replies accidentally.

---

### 37. Internal Thread Comment
A private note attached to an email thread, visible only to the team — not the sender or recipient.

**Example:**
A sales team receives an angry email from a key client. Before replying, a team member adds an internal comment: "This is related to the outage last Tuesday — check ticket #8821 before responding." The eventual reply is informed without the client seeing the internal context.

---

### 38. Collaborative Draft
Multiple people edit the same draft reply simultaneously, like a shared document, before it is sent.

**Example:**
A startup receives a partnership proposal from a major retailer. The CEO, legal lead, and head of sales all need to sign off on the reply. Instead of forwarding the draft three times, all three edit a single shared draft in real time, each adding their section. When all are happy, one person hits Send.

---

### 39. Shared Inbox
A team-visible mailbox for role addresses (support@, sales@, info@). Members see ownership, assignment status, and internal comments — no forwarded alias chaos.

**Example:**
A five-person support team all have access to support@company.com. When a ticket arrives, it appears for everyone. One agent claims it, and it moves to their queue. Others see "Claimed by Priya". No one duplicates the response. Managers can see throughput per agent.

---

## Privacy & Security Workflows

---

### 40. Tracking Pixel Block
*(See entry 35 above — listed separately here as it applies to received mail rather than sent mail.)*

Already covered above under Triage & Routing.

---

## AI & Intelligence

---

### 41. Thread Summary
A collapsed plain-language summary of a long email thread, shown before or instead of reading the full chain. Reduces context-loading time.

**Example:**
A user returns from a week's holiday to find a 34-email thread about a product decision. Instead of reading every message, they click **Summarise**. The client returns: "The team debated between Option A (faster to ship) and Option B (more scalable). Option B was chosen. Next step: engineering kick-off on Monday." They are fully up to speed in 10 seconds.

---

### 42. AI Reply Draft
The client generates a full draft reply based on the email content and (in some implementations) the user's prior writing style. The user reviews, edits, and sends.

**Example:**
A consultant receives an email asking for their availability for a call next week. The client auto-generates: "Hi Sarah, thanks for reaching out — I have availability on Tuesday 27 May from 2pm–4pm or Thursday 29 May from 10am–12pm. Let me know what works for you." The consultant adjusts the times, hits Send. Total time: 8 seconds.

---

### 43. Priority Surfacing
The client identifies which emails are time-sensitive or high-importance using ML and surfaces them first — above all other unread mail, regardless of arrival time.

**Example:**
A user has 80 unread emails. Among them is a message from their biggest client with "Urgent: contract issue" in the subject. The client's AI puts this at the very top of the inbox, ahead of all 79 others. The user sees it the moment they open the app.

---

### 44. Smart Reply Suggestions
The client analyses the incoming email and surfaces 2–3 short suggested replies the user can send with a single tap — without composing anything.

**Example:**
A user receives a meeting request: "Can we move our call to Thursday?" Apple Mail shows three suggestion chips: **"Sure, Thursday works"** / **"Sorry, I'm not free Thursday"** / **"Let me check and get back to you"**. The user taps the first one. A reply is sent in one tap with no typing.

---

## Quick Reference Index

| # | Action | Type |
|---|---|---|
| 1 | One-Click Confirm | In-email interactive |
| 2 | Approve / Reject | In-email interactive |
| 3 | Vote / Poll | In-email interactive |
| 4 | RSVP | In-email interactive |
| 5 | Flight Check-In | In-email interactive |
| 6 | Save Offer / Coupon | In-email interactive |
| 7 | Add to Queue / Playlist | In-email interactive |
| 8 | Rate & Review | In-email interactive |
| 9 | Survey / Form | In-email interactive |
| 10 | View Reservation / Booking | In-email interactive |
| 11 | Track Package | In-email interactive |
| 12 | Password-Protected Delivery | In-email interactive |
| 13 | Flight Highlights | Informational callout |
| 14 | Hotel Reservation Highlights | Informational callout |
| 15 | Transportation Highlights | Informational callout |
| 16 | Order Highlights | Informational callout |
| 17 | Real-Time Shipment Status Badge | Informational callout |
| 18 | Event Highlights | Informational callout |
| 19 | Verification Code Callout | Informational callout |
| 20 | Add to Calendar (Auto) | Informational callout |
| 21 | Boarding Pass / Wallet Import | Informational callout |
| 22 | Priority / Time-Sensitive Callout | Informational callout |
| 23 | Scheduled Send | Sending control |
| 24 | Undo Send | Sending control |
| 25 | Read Receipt | Sending control |
| 26 | Follow-Up Reminder (No Reply) | Sending control |
| 27 | Expiring / Self-Destructing Message | Sending control |
| 28 | Encrypted External Delivery | Sending control |
| 29 | Snooze / Defer | Triage & routing |
| 30 | Sender Screening / Gating | Triage & routing |
| 31 | Auto-Categorisation | Triage & routing |
| 32 | Pipeline / Stage Tracking | Triage & routing |
| 33 | Auto-Filing Rules | Triage & routing |
| 34 | Masked / Alias Address | Triage & routing |
| 35 | Tracking Pixel Block | Triage & routing |
| 36 | Assign to Teammate | Collaboration |
| 37 | Internal Thread Comment | Collaboration |
| 38 | Collaborative Draft | Collaboration |
| 39 | Shared Inbox | Collaboration |
| 41 | Thread Summary | AI & intelligence |
| 42 | AI Reply Draft | AI & intelligence |
| 43 | Priority Surfacing | AI & intelligence |
| 44 | Smart Reply Suggestions | AI & intelligence |

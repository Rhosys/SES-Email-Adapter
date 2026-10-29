# Mimestream Feature Audit

Every feature Mimestream (macOS-native Gmail client, v1.10.x as of 2026-07) supports, for the purpose of cloning its design into our web UI + server.

**Sourcing:** compiled 2026-10-04 from Mimestream's help center, release notes, and blog (via search index — `mimestream.com` is blocked by this environment's egress proxy, so pages were not fetched directly) plus TidBITS release coverage. Items marked † come from secondary sources only. Before building any item, verify against the live help page.

Key sources: [Help / User Guide](https://mimestream.com/help/user-guide/) · [Release Notes](https://mimestream.com/releases) · [What's new in 1.0](https://mimestream.com/blog/whats-new-in-1.0) · [Blog](https://mimestream.com/blog) · [Roadmap](https://portal.productboard.com/mimestream/1-mimestream-roadmap)

---

## 1. Calendar

Requires the "Google Calendar" connected service. Google Calendar only — no Apple/iCloud, Outlook, or CalDAV.

| Feature | Detail | Since |
|---|---|---|
| Invitation banner | Banner at top of any invitation email with event details | 0.33 |
| Inline RSVP | Accept / Decline / Maybe without leaving the message | 0.33 |
| Day agenda | Banner shows the event's day with your existing events around it (conflict visibility) | 0.33 |
| Agenda filtering | Declined events hidden; "Maybe" events visually marked | 1.x |
| Attendee status | Accept/decline/maybe status next to each invitee | 0.36 |
| Multi-day events | Shown correctly in banner | 1.1.5 |
| Alias invites | Invitations sent to Gmail aliases resolve to the right calendar | 1.1.5 |
| Shared-calendar guard | RSVP buttons hidden for events in shared calendars | 0.x |
| Add non-invite events | Add events found in email (flight/train tickets, dinner reservations) to Calendar | 1.2 |

## 2. Accounts, Profiles & Unified Inbox

| Feature | Detail |
|---|---|
| Multiple Google accounts | Gmail + Google Workspace |
| Profiles | Group accounts (default: Personal, Work); custom name, color, icon |
| Profile switching | Separate window tab per profile, or inline switcher; keyboard shortcut |
| "All" profile | Optional unified view across all profiles (1.10) |
| Unified Inbox | All accounts in a profile unified by default; unified folders (Inbox, Starred, Drafts, Sent…); repeat shortcut cycles sub-folders |
| Account color badge | Per-account color dot on each message; default label color in sidebar |
| Account description / rename | Shown in sidebar; rename from context menu |
| Per-account categorized inbox | Gmail categories (Primary/Social/Promotions/Updates/Forums) per account |
| Notification schedule | Per-profile working hours; mute notifications outside them |
| macOS Focus Filters | Link profiles to Focus modes |
| Connected services | Granular opt-in per account: Gmail, Google Contacts, Google Calendar, Gmail Settings |
| Account email change | Handles Google account address changes (1.10.5) |
| Advanced Protection | Works with Google's Advanced Protection Program |

## 3. Triage & Organization

| Feature | Detail |
|---|---|
| Archive / Trash / Delete | Configurable Delete-key behavior (archive vs trash) |
| Labels | Full Gmail labels: apply multiple, create inline from Label or Move-To popover, nested |
| Move To | Popover + toolbar button + shortcuts |
| Label visibility | Show/hide label in sidebar and in message list |
| Favorites | Configurable Favorites section in sidebar (0.33) |
| Important label | Mark/unmark Important (0.33) |
| Category labels | Account-wide Category labels (0.33) |
| Star / Unread toggles | Standard |
| Snooze | Labs feature, **client-side only** (not synced to Gmail); natural-language date/time entry (⌥⌘S), context menu, toolbar |
| Server-side filters | Create/edit Gmail filters in-app; "Filter Messages Like These…" from context menu; run on Gmail servers |
| Vacation responder | Edit/enable Gmail vacation response; start/end dates; runs server-side |
| Message-list filter | Unread / Starred / Important / "In Inbox" (labels only); multiple = OR; per-folder saved settings (1.6); ⌥⌘L |
| Go to Folder… | Quick jump to any label/folder by name |
| Swipe actions | Trackpad left/right edge swipes; configurable (Unread/Star, Archive, Trash/Archive…); secondary actions (1.9) |
| Bulk selection | Multi-select operations |
| Conversations toggle | Group into conversations or show individual messages |
| Open in Gmail | Escape hatch for unsupported actions (e.g. block sender / report spam †) |
| Deep links | Copy private deep link to a message for use in other apps (1.3) |
| Send to Reminders | Share link to Reminders with subject as title (1.9) |
| Sharing extensions | "Send Link to" extensions (Reminders, Things, OmniFocus…) |

## 4. Search

| Feature | Detail |
|---|---|
| Full Gmail operator support | `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`, etc. |
| Tokenized search field | Suggestions become tokens: addresses, subjects, labels, attributes (starred/unread/important) |
| Attachment-type tokens | has attachment / presentation / document / spreadsheet / Google Drive link |
| Date suggestions | Date-range suggestions while typing (0.35) |
| Search scope | Toggle All Mail vs current folder |
| Shortcut | ⌥⌘F, or `/` in Gmail-shortcut mode |

## 5. Reading / Viewing

| Feature | Detail |
|---|---|
| Conversation view | Threaded; expand/collapse messages (⇧⌘E or `;`); order oldest→newest or newest→oldest |
| Reply selection | Click a message in thread, ⌘R replies to that one |
| Separate window | Double-click opens message in its own window |
| List style | Dense / Compact / Default / Expanded (0–2 preview lines, attachments) |
| Mailbox badges | Configurable count badges for Starred, Drafts, Spam |
| Unknown-sender display | Shows full address alongside name for unknown senders (1.10) |
| Contact cards | View contact card from address token; add to Contacts (0.35/0.36) |
| Profile photos | Synced from Google Contacts |
| Tracking prevention | Blocks pixels from 60+ tracking services (since 0.6.6), improved 1.10 |
| Remote images | Block by default; "Load Images" button |
| Attachments | Quick Look preview; multi-select drag-out; open location setting (internal vs Downloads, 1.2) |
| Text size | Adjustable |
| Dark mode | Including message bodies |
| Liquid Glass UI | macOS 26 design (1.8/1.9) |

## 6. Composing

| Feature | Detail |
|---|---|
| Rich text | Format bar (hidden by default, `Aa`): bold/italic/underline, size, color, lists |
| Markdown substitutions | `**bold**`, `_italic_`, `` `code` ``, dashed/numbered smart lists |
| Code blocks | Inline/code-block formatting |
| Emoji substitutions | Messages-style inline emoji replacement (0.35) |
| @mentions | `@First` / `+First` autocomplete; auto-adds to To; prioritizes thread participants |
| Templates | Snippets with subject + recipients; variables (`{{ recipient.first_name }}`), custom prompted fields (`{{ custom.quantity }}`); ⌘/; toolbar button |
| Signatures | Synced from Gmail + local signatures; multiple; default per new/reply; formatting bar; drag reorder (1.9) |
| Aliases (Send-As) | Synced from Gmail; selectable From; "Automatically select best account" default |
| Autocomplete | Google Contacts + Workspace Directory; matches across name/address parts; tuned scoring |
| Suggestion blocklist | Stop suggesting old addresses (1.3) |
| Undo Send | Configurable cancellation window (0.25) |
| Send & Archive | One-action send + archive thread |
| Reply quoting | Quote selection only, or whole message |
| Forward as attachment | 0.35 |
| Include original attachments on reply | 0.33 |
| Attachments | Drag-in, paperclip, File menu; reorder (0.35) |
| Insert image | From File, URL, Photos, or iPhone/iPad (Continuity Camera: photo, scan, sketch) |
| Label drafts | ⌘L in compose |
| Predictive text | macOS 14 inline completions (1.2) |
| Writing Tools | Apple Intelligence: proofread, rewrite, tone, ChatGPT compose (1.5) |
| Offline queueing | Compose/reply/label/archive offline; syncs on reconnect |
| Draft sync | Drafts synced with Gmail; sync-error UI |
| Share sheet target | Share files from Finder/other apps into a new message |
| **Not supported** | Schedule send (Gmail API limitation) |

## 7. Notifications

| Feature | Detail |
|---|---|
| Push notifications | Standard; "Private Push" near-instant push (Labs 1.9, default on macOS 26 in 1.10) |
| Dock unread badge | |
| Menu bar extra | Check unread without opening app |
| Per-profile schedule | Working hours / Focus integration |
| Notifications settings tab | Top-level (1.10) |

## 8. Keyboard & Input

| Feature | Detail |
|---|---|
| Shortcut sets | Mimestream default, Apple Mail, or Gmail scheme |
| Core shortcuts | ⌘N new, ⌘R reply, ⇧⌘R reply all, ⇧⌘F forward, ⌃⌘A archive, ⌘⌫ trash, ⌘L label, ⌥⌘F search |
| Navigation | Arrow keys between messages; ←/→ between panes; go-to Inbox/Starred/Drafts/Sent/Trash; switch profiles/windows |
| Smooth arrow-key scrolling | In conversation view (1.7) |
| Trackpad gestures | Swipe actions |

## 9. Privacy, Security & Platform

| Feature | Detail |
|---|---|
| Direct-to-Gmail API | No Mimestream mail servers; data stays on device |
| No analytics | No usage tracking |
| Private Push | Relay that delivers new-mail pushes without exposing content |
| Gmail API only | Not IMAP — labels, filters, categories map 1:1 |
| Offline cache | Adaptive cache management (1.10.5) |
| Platforms | macOS only. iOS/iPadOS and IMAP/Outlook on roadmap |
| Pricing | $4.99/mo or $49.99/yr, 14-day trial; group licensing |

## 10. Settings Surface (tabs)

General (conversations, text size, shortcut set, delete action, sounds, updates) · Accounts (description, color, services) · Profiles · Notifications · Sidebar & List (list style, swipe actions, badges) · Viewing (order, remote images, tracking) · Composing (default From, quoting, undo-send window) · Signatures · Templates · Advanced → Labs (snooze, Private Push).

---

## Gaps vs. the requested direction

Mimestream stops at Google Calendar. Requested scope goes further:

- **Multi-provider calendar read** for conflict/agenda display: Google Calendar API, Apple/iCloud (CalDAV), Microsoft Graph, generic CalDAV/ICS subscriptions.
- **RSVP to any provider**, not just Google — iTIP REPLY via email works universally; native API RSVP where connected.
- **Server-side snooze** (Mimestream's is client-only).
- **Schedule send** (Mimestream can't; we control the server).
- **In-app block/spam/unsubscribe** (Mimestream defers to Gmail web †).
- **Cross-platform** (web + mobile PWA) vs macOS-only.

## Next step

Map each row above against what SES-Email-Adapter / SES-Email-Adapter-UI already ship (e.g. `InlineCalendar.vue`, `CalendarEventCard.vue`, `incoming-calendar-rsvp-processor.ts`, `SnoozeMenu.vue`, templates, rules, external exchanges) to produce a have / partial / missing matrix.

# Requirements Document

## Introduction

Calendar invites arrive as `.ics` attachments on inbound emails. Currently, these emails are classified under the `scheduling` workflow, which conflates the email's *purpose* (job interview, doctor appointment, team meeting) with the *presence of a calendar attachment*. This feature removes the `scheduling` workflow entirely and introduces a cross-workflow calendar proxy layer: any signal with an `.ics` attachment gets its calendar data parsed and exposed regardless of workflow classification. The system forwards invites to the user's real calendar, captures user RSVP decisions, and sends masked replies back to the organizer — preserving the user's identity privacy.

Security relies on the existing sender approval flow as the primary gate: only signals from approved senders reach "active" status and trigger forwarding. Additional defenses handle malicious `.ics` payloads (memory exhaustion, VTIMEZONE bombs, CANCEL spoofing, URL injection, VALARM abuse, organizer spoofing, RSVP redirect attacks) that could slip through from a compromised approved sender.

When an inbound email contains an `.ics` attachment, the system creates two signals: the email signal (normal processing) and a calendar signal (derived, with `source: "signal"`). The calendar signal uses a composite `signalLookupId` keyed by organizer and VEVENT_UID, enabling O(1) event state lookup and building CANCEL validation into the key structure itself.

## Glossary

- **Signal**: An immutable record representing an inbound email event, stored in DynamoDB.
- **Arc**: A materialized aggregate of related signals (a conversation thread).
- **Workflow**: The classification of what kind of email a signal represents (e.g. job, healthcare, crm). Drives UX and actions.
- **ICS_Parser**: The component that detects `.ics` attachments on signals and parses them into structured calendar data.
- **CalendarData**: The structured object stored on a calendar signal containing all parsed iCal VEVENT properties.
- **Calendar_Signal**: A derived signal (source: "signal") created when an inbound email contains an `.ics` attachment. Keyed by organizer + VEVENT_UID for O(1) event state lookup.
- **Calendar_Forwarder**: The component that forwards calendar signals' `.ics` attachments to the user's configured real calendar email address.
- **RSVP_Composer**: The component that composes iCal REPLY messages (METHOD:REPLY) with the user's accept/decline decision, sent from the alias address.
- **Alias**: A recipient address on a custom domain routed into the system.
- **Organizer**: The ORGANIZER field value in an iCal VEVENT — the entity that sent the calendar invite.
- **VEVENT_UID**: The globally unique identifier for a calendar event, stable across updates and cancellations.
- **SEQUENCE**: The iCal SEQUENCE number indicating the revision of an event. Higher numbers supersede lower ones.
- **METHOD**: The iCal METHOD property (REQUEST, REPLY, CANCEL, COUNTER, etc.) indicating the intent of the calendar message.
- **Approved_Sender**: A sender whose eTLD+1 domain has an "allow" policy on the receiving alias.
- **Spam_Score_Threshold**: The per-alias or account-level threshold above which signals are treated as spam.
- **VALARM**: An iCal alarm component that can trigger client-side actions (display alerts, send emails, run programs). A known abuse vector.
- **VTIMEZONE**: An iCal timezone definition component. Attackers embed excessive VTIMEZONE data to cause parsing DoS.

## Requirements

### Requirement 1: Remove Scheduling Workflow

**User Story:** As a developer, I want the `scheduling` workflow removed from the system, so that calendar invites are classified under their natural workflow based on the sender's context rather than the presence of a calendar attachment.

#### Acceptance Criteria

1. THE WORKFLOWS array SHALL NOT contain the value "scheduling".
2. THE type system SHALL NOT export a `SchedulingData` interface.
3. THE WorkflowData union type SHALL NOT include `SchedulingData`.
4. THE SystemLabel type SHALL NOT include "system:workflow:scheduling".
5. WHEN the classifier processes an email containing a calendar invite, THE classifier SHALL assign the workflow based on the sender's context (e.g. "job" for a recruiter, "healthcare" for a medical provider, "crm" for a colleague).
6. THE classifier prompt SHALL NOT contain a "scheduling" workflow section.

### Requirement 2: Detect ICS Attachments

**User Story:** As a developer, I want the system to detect `.ics` attachments on any inbound signal regardless of workflow, so that calendar data extraction is decoupled from workflow classification.

#### Acceptance Criteria

1. WHEN a signal has one or more attachments with MIME type "text/calendar" or filename ending in ".ics", THE ICS_Parser SHALL identify the signal as containing calendar data.
2. WHEN a signal has multiple attachments identified as calendar invites (MIME type text/calendar, .ics extension, or containing METHOD:REQUEST or METHOD:CANCEL), THE ICS_Parser SHALL log a TRACK-level event with the signal ID and count of calendar attachments found.
3. WHEN a signal has multiple `.ics` attachments, THE ICS_Parser SHALL parse the first attachment with a METHOD property, falling back to the first `.ics` attachment if no METHOD is present.
4. THE ICS_Parser SHALL detect `.ics` attachments regardless of the signal's assigned workflow.
5. THE ICS_Parser SHALL parse only one CalendarData object per signal.

### Requirement 3: Create Calendar Signal from ICS Attachment

**User Story:** As a developer, I want a separate calendar signal created when an inbound email contains an `.ics` attachment, so that calendar event state is tracked independently with its own lookup key.

#### Acceptance Criteria

1. WHEN the ICS_Parser detects a valid `.ics` attachment on an email signal, THE system SHALL create a separate calendar signal with `source: "signal"`.
2. THE calendar signal SHALL use `signalLookupId` format `"cal-{organizerEmail}-{veventUid}"` as the DynamoDB PK component, with the signal's own ID as the SK.
3. THE calendar signal SHALL include a `linkedSignalId` field containing the ID of the originating email signal.
4. THE calendar signal SHALL be placed on the same arc as the originating email signal.
5. THE SIGNAL_SOURCES constant SHALL include the value "signal" for derived signals.
6. WHEN multiple calendar signals exist for the same organizer + VEVENT_UID (e.g. REQUEST followed by CANCEL), THE signals SHALL coexist under the same PK with distinct SKs.

### Requirement 4: Parse ICS into Structured CalendarData

**User Story:** As a developer, I want `.ics` attachments fully parsed into a structured CalendarData object on the calendar signal, so that the system can construct forwarding copies and the UI can render calendar cards.

#### Acceptance Criteria

1. WHEN a valid `.ics` attachment is detected, THE ICS_Parser SHALL extract all VEVENT properties into a CalendarData object, including: title (SUMMARY), description (DESCRIPTION), startTime (DTSTART as ISO 8601), endTime (DTEND as ISO 8601), location (LOCATION), url (URL), organizer (ORGANIZER as email address), attendees (list of ATTENDEE email addresses with PARTSTAT and CN), veventUid (UID), method (METHOD), sequence (SEQUENCE as integer), status (STATUS), transparency (TRANSP), created (CREATED), lastModified (LAST-MODIFIED), and any X-properties as a key-value map.
2. WHEN the `.ics` contains a RRULE property, THE ICS_Parser SHALL store the RRULE value as a `recurrenceRule` string field on CalendarData.
3. WHEN the `.ics` contains a RECURRENCE-ID property, THE ICS_Parser SHALL store it as a `recurrenceId` ISO 8601 string field on CalendarData, indicating this is an exception to a recurring event.
4. THE ICS_Parser SHALL strip all VALARM components from the parsed data and SHALL NOT store them on CalendarData or forward them to the user's real calendar.
5. THE ICS_Parser SHALL store the raw `.ics` content as an attachment on the calendar signal (S3 key reference).
6. THE ICS_Parser SHALL store the parsed CalendarData object as the primary data payload on the calendar signal.
7. THE CalendarData object stored on the calendar signal SHALL NOT exceed 100 KB when serialized to JSON.
8. THE ICS_Parser SHALL run during signal processing before the calendar signal is written to DynamoDB.

### Requirement 5: ICS Size and Complexity Limits

**User Story:** As a developer, I want the parser to enforce size and complexity limits on `.ics` files, so that malformed or weaponized attachments cannot exhaust memory or cause infinite loops.

#### Acceptance Criteria

1. WHEN an `.ics` attachment exceeds 1 MB in size, THE ICS_Parser SHALL reject the attachment, skip calendar signal creation, and log a warning with the signal ID and attachment size.
2. WHEN an `.ics` file contains more than 100 VTIMEZONE components, THE ICS_Parser SHALL reject the attachment, skip calendar signal creation, and log a warning indicating a suspected VTIMEZONE bomb.
3. WHEN an `.ics` file contains more than 100 ATTENDEE properties, THE ICS_Parser SHALL silently truncate the attendee list to 100.
4. IF the ICS_Parser encounters a malformed `.ics` that does not conform to RFC 5545 structure, THEN THE ICS_Parser SHALL log a warning with the parse error, skip calendar signal creation, and allow the email signal to proceed without calendar data.
5. THE ICS_Parser SHALL complete parsing within 5 seconds; IF parsing exceeds this duration, THEN THE ICS_Parser SHALL abort parsing, skip calendar signal creation, and log a timeout warning.
6. WHEN an `.ics` file contains nested VCALENDAR components or a nesting depth exceeding 5 levels, THE ICS_Parser SHALL reject the attachment, skip calendar signal creation, and log a warning indicating excessive nesting.

### Requirement 6: URL Validation and Sanitization

**User Story:** As a developer, I want all URLs extracted from iCal data validated and sanitized, so that malicious URIs cannot be stored or rendered to users.

#### Acceptance Criteria

1. WHEN the ICS_Parser extracts a URL from any iCal property (LOCATION, DESCRIPTION, URL, ORGANIZER mailto, ATTENDEE mailto), THE ICS_Parser SHALL validate the URI scheme.
2. THE ICS_Parser SHALL allow only `https:`, `http:`, and `mailto:` URI schemes in extracted URLs.
3. IF a URL uses a disallowed scheme (including `javascript:`, `data:`, `file:`, `vbscript:`, `ftp:`), THEN THE ICS_Parser SHALL replace the URL value with an empty string.
4. THE ICS_Parser SHALL validate that mailto: URIs contain a syntactically valid email address.
5. THE ICS_Parser SHALL validate that http/https URLs have a valid hostname (no IP address literals, no localhost, no private network ranges).

### Requirement 7: RSVP Routing Uses ORGANIZER Field

**User Story:** As a user, I want my RSVP responses sent to the ORGANIZER address defined in the iCal, so that replies reach the correct recipient per RFC 6047 (iMIP) regardless of which system sent the invite email.

#### Acceptance Criteria

1. THE RSVP_Composer SHALL send replies to the ORGANIZER mailto: address extracted from the `.ics` VEVENT, per RFC 6047 §2.3.
2. THE system SHALL NOT perform mismatch detection between the ORGANIZER field and the email From address.
3. THE CalendarData SHALL store the ORGANIZER field value for both routing and display purposes.

### Requirement 8: CANCEL Forwarding

**User Story:** As a user, I want cancellation emails forwarded to my real calendar using the same rules as invites, so that my calendar stays in sync without additional validation overhead.

#### Acceptance Criteria

1. WHEN a calendar signal has METHOD:CANCEL and the account has a `calendarForwardingAddress` configured, THE Calendar_Forwarder SHALL forward it to that address.
2. THE Calendar_Forwarder SHALL apply the same guards as REQUEST forwarding (signal must be active, spam score below threshold).
3. THE Calendar_Forwarder SHALL NOT perform any prior-REQUEST lookup or organizer validation for CANCEL signals.

### Requirement 9: Calendar Forwarding Configuration

**User Story:** As a user, I want to configure a real calendar email address on my account, so that calendar invites are automatically forwarded to my native calendar app.

#### Acceptance Criteria

1. THE Account interface SHALL include an optional `calendarForwardingAddress` field (string, email address).
2. WHEN a user sets `calendarForwardingAddress` via the account settings API, THE system SHALL validate that the address is a syntactically valid email address.
3. THE `calendarForwardingAddress` SHALL apply account-wide (all aliases on the account use the same forwarding target).

### Requirement 10: Calendar Forwarding via System Rule

**User Story:** As a user, I want calendar invites automatically forwarded to my real calendar via the existing rules engine, so that forwarding uses the same side-effect pipeline as other rule actions.

#### Acceptance Criteria

1. WHEN a calendar signal is created, THE system SHALL apply a `system:calendar` label to the originating email signal.
2. THE system SHALL include a system rule that matches signals with the `system:calendar` label and applies a `forwardCalendarInvite` rule action.
3. THE `forwardCalendarInvite` rule action SHALL embed the user's `calendarForwardingAddress` as the action value (resolved at rule evaluation time from the account configuration).
4. THE `forwardCalendarInvite` side-effect SHALL construct a new `.ics` from the parsed CalendarData — the original `.ics` is never forwarded directly.
5. THE constructed `.ics` SHALL preserve: SEQUENCE, DTSTART, DTEND, SUMMARY, LOCATION, DESCRIPTION, STATUS, and METHOD from CalendarData.
6. THE constructed `.ics` SHALL NOT include VALARM components.
7. THE Calendar_Forwarder SHALL forward all calendar signals regardless of METHOD (REQUEST, CANCEL, COUNTER, or any other valid iCal method) — no method filtering.
8. THE Calendar_Forwarder SHALL NOT guard against signal status or spam score — if the calendar signal exists, it has already passed all upstream filters.
9. THE Calendar_Forwarder SHALL include an `X-Numaeel-Calendar-Signal-Id` header on the forwarded email containing the calendar signal ID for traceability.

### Requirement 11: Two-UID-Space Proxy Model

**User Story:** As a developer, I want the system to maintain separate UID spaces for the user's calendar and the original organizer, so that the proxy can route RSVP responses without exposing the user's real identity.

#### Acceptance Criteria

1. THE constructed `.ics` forwarded to the user's real calendar SHALL use a proxy UID format: `{accountId}.{arcId}.{originalVeventUid}.{hmac}@{serviceDomain}`.
2. THE proxy UID SHALL be deterministic — the same account + arc + original VEVENT_UID always produces the same proxy UID, ensuring consistency across REQUEST, CANCEL, and RESCHEDULE for the same event.
3. WHEN composing a REPLY back to the original organizer, THE RSVP_Composer SHALL use the original VEVENT_UID (not the proxy UID).
4. THE calendar signal SHALL store both the original VEVENT_UID (from the inbound `.ics`) and the proxy UID (computed at forward time) in CalendarData.
5. THE `{serviceDomain}` value SHALL be read from configuration — never hardcoded.

### Requirement 12: Proxy ORGANIZER Address

**User Story:** As a user, I want my calendar app's RSVP responses routed back through the proxy, so that the organizer never sees my real calendar email address.

#### Acceptance Criteria

1. THE constructed `.ics` forwarded to the user's real calendar SHALL set the ORGANIZER property to `mailto:{arcId}@{accountId}.{serviceDomain}`.
2. WHEN the user's calendar app sends a METHOD:REPLY, it SHALL be directed to the ORGANIZER address (`{arcId}@{accountId}.{serviceDomain}`), which routes back to the system's inbound pipeline.
3. THE system SHALL configure a wildcard MX record on `*.{serviceDomain}` (or per-account subdomain MX) so that emails to `{arcId}@{accountId}.{serviceDomain}` are received by SES inbound.
4. THE ORGANIZER CN (display name) in the constructed `.ics` SHALL be set to the original organizer's display name from CalendarData, so the user's calendar shows the correct organizer name.

### Requirement 13: Inbound Calendar REPLY Routing

**User Story:** As a developer, I want inbound calendar REPLY emails routed directly to the calendar response handler, so that they bypass normal classification and are processed as RSVP responses.

#### Acceptance Criteria

1. WHEN an inbound email arrives at an address matching the pattern `{arcId}@{accountId}.{serviceDomain}`, THE system SHALL identify it as a calendar REPLY and route it to the calendar response handler.
2. THE calendar response handler SHALL validate the accountId and arcId by verifying the trailing checksum digits (last 3 characters are a SHA-256 hash prefix of the preceding characters). Invalid IDs SHALL be silently dropped.
3. IF an inbound email at the proxy address does not contain a valid `text/calendar` MIME part with METHOD:REPLY, THE system SHALL drop it and log a WARN with the signal ID and reason for rejection.
4. THE calendar response handler SHALL parse the `.ics` attachment to extract the proxy UID and the ATTENDEE PARTSTAT (ACCEPTED, DECLINED, TENTATIVE).
5. THE calendar response handler SHALL create a `calendar_response` signal (source: "user", type: "calendar_response") on the identified arc with the RSVP decision.
6. THE calendar response handler SHALL trigger the RSVP_Composer to send a masked REPLY to the original organizer using the original VEVENT_UID.

### Requirement 14: Inbound REPLY Validation via HMAC

**User Story:** As a developer, I want inbound calendar REPLY emails validated via HMAC before any database lookup, so that attackers cannot use the calendar proxy endpoint to probe or spam accounts.

#### Acceptance Criteria

1. THE system SHALL validate accountId and arcId format by verifying the trailing checksum digits (last 3 characters are a SHA-256 hash prefix of the preceding characters).
2. THE system SHALL validate the proxy UID in the inbound REPLY's `.ics` by verifying the HMAC-SHA256 suffix. The HMAC is computed over `{accountId}.{arcId}.{originalVeventUid}` using a dedicated 32-byte secret.
3. THE HMAC secret SHALL be a random 32-byte value, encrypted with the `alias/default` KMS key, committed as a `.kms` file in the backend repo, and decrypted once at Lambda cold start.
4. IF either the ID checksum or the UID HMAC fails validation, THE system SHALL drop the inbound email without creating any signal, sending any response, or performing any database lookup, and SHALL log a WARN with the failing validation type and the recipient address.
5. THE validation SHALL be pure computation — no I/O occurs until both checksum and HMAC pass.
6. THE HMAC suffix in the proxy UID SHALL be the first 16 characters of the base64url-encoded HMAC output (no padding).

### Requirement 15: Constructed ICS ATTENDEE Field

**User Story:** As a user, I want my real calendar email set as the ATTENDEE in forwarded invites, so that my calendar app recognizes the invite as addressed to me and shows accept/decline buttons.

#### Acceptance Criteria

1. THE constructed `.ics` forwarded to the user's real calendar SHALL set the ATTENDEE to the user's `calendarForwardingAddress` (the verified real calendar email).
2. THE ATTENDEE SHALL include `PARTSTAT=NEEDS-ACTION` and `RSVP=TRUE` so the calendar app presents accept/decline options.
3. THE `calendarForwardingAddress` SHALL be validated using the same verified forwarding address flow as regular forwarding addresses (verification email sent, user clicks confirmation link).

### Requirement 16: Post-Approval Calendar Forwarding

**User Story:** As a user, I want calendar invites forwarded to my real calendar when I approve a quarantined signal, so that approving a sender also delivers their pending invite.

#### Acceptance Criteria

1. WHEN a quarantined email signal that has a linked calendar signal is approved by the user (status changes to "active"), THE system SHALL trigger Calendar_Forwarder to forward the constructed `.ics` to the user's real calendar address.
2. THE post-approval forwarding SHALL use the same construction rules as Requirement 10 (proxy UID, proxy ORGANIZER, no VALARM, all methods forwarded).

### Requirement 12: Record User RSVP Decision

**User Story:** As a user, I want my accept/decline decision recorded as a signal on the arc, so that the UI can derive calendar event state from the signal history.

#### Acceptance Criteria

1. WHEN a user submits an RSVP decision (accept, decline, or tentative) via the API for a calendar signal, THE system SHALL first send the masked RSVP via RSVP_Composer, then create a `calendar_response` signal with `source: "user"` and `type: "calendar_response"` on the same arc.
2. THE calendar response signal's data payload SHALL contain: `decision` ("accepted" | "declined" | "tentative"), `respondedAt` (ISO 8601 timestamp), `veventUid` (copied from the calendar signal's CalendarData), and `linkedSignalId` (the ID of the calendar signal being responded to).
3. THE `calendar_response` value SHALL be added to SIGNAL_TYPES.
4. THE system SHALL NOT store a `calendarEventStatus` field on the calendar signal — event state is derived by the UI from the most recent `calendar_response` signal in the arc's history.
5. IF the RSVP_Composer fails to send, THE API SHALL return an error and SHALL NOT create the `calendar_response` signal — the system must not record a decision that was never delivered.

### Requirement 14: Send Masked RSVP to Organizer

**User Story:** As a user, I want my RSVP sent back to the organizer from my alias address, so that the organizer receives my response without learning my real email address.

#### Acceptance Criteria

1. WHEN a user submits an RSVP decision, THE RSVP_Composer SHALL compose an iCal REPLY (METHOD:REPLY) containing the user's decision (ACCEPTED, DECLINED, or TENTATIVE as PARTSTAT).
2. THE RSVP_Composer SHALL set the ATTENDEE in the REPLY to the alias address that received the original invite.
3. THE RSVP_Composer SHALL send the REPLY email from the alias address to the ORGANIZER mailto: address extracted from the calendar signal's CalendarData.
4. THE RSVP_Composer SHALL include the same VEVENT_UID and SEQUENCE as the original invite in the REPLY.
5. IF the alias domain does not have sender setup complete (DKIM + SPF) at RSVP send time, THE RSVP_Composer SHALL skip sending, create a system signal with `type: "domain_misconfiguration"` on the arc explaining that the RSVP cannot be delivered until domain setup is complete, and mark the `calendar_response` signal as `send_failed`.
6. WHEN a transient SES delivery failure is reported for an RSVP email (via SES Feedback SQS), THE system SHALL retry delivery using the same retry mechanism as other outbound messages.

### Requirement 17: Calendar UI Exposure

**User Story:** As a user, I want calendar signals to render as structured calendar cards in the arc thread, so that I can see event details and respond to invites directly from the interface.

#### Acceptance Criteria

1. WHEN an arc contains a calendar signal, THE API SHALL include the CalendarData object in the signal response payload for that calendar signal.
2. THE UI SHALL render the calendar card from the **calendar signal** (source: "signal"), not from the email signal.
3. THE API SHALL expose an RSVP endpoint that accepts a calendar signal ID and a decision (accept, decline, tentative).
4. WHEN a `calendar_response` signal exists on the same arc for the same VEVENT_UID, THE API SHALL include the most recent decision in the calendar signal response so the UI can show the current RSVP state.
5. THE CalendarData in the API response SHALL include the METHOD so the UI can distinguish REQUEST (show accept/decline) from CANCEL (show cancelled badge).
6. THE calendar signal SHALL appear in the arc's signal thread as a distinct card type, linked to the originating email signal via `linkedSignalId`.

### Requirement 18: Calendar Invite Invalid Signal

**User Story:** As a user, I want to be informed when a calendar invite in an email could not be processed, so that I understand why no calendar card appears despite the email containing an invite.

#### Acceptance Criteria

1. WHEN the ICS_Parser rejects a `.ics` attachment (oversized, VTIMEZONE bomb, excessive nesting, malformed structure), THE system SHALL create a system signal with `type: "calendar_invite_invalid"` on the same arc as the email signal.
2. THE `calendar_invite_invalid` signal's data payload SHALL contain: `reason` (string describing why the invite was rejected, e.g. "File exceeds 1 MB size limit", "Suspected VTIMEZONE bomb", "Malformed iCal structure"), and `linkedSignalId` (the ID of the originating email signal).
3. THE `calendar_invite_invalid` value SHALL be added to SIGNAL_TYPES.
4. THE UI SHALL render the `calendar_invite_invalid` signal as an informational card in the arc thread explaining that a calendar invite was detected but could not be processed.
5. THE system SHALL NOT create a `calendar_invite_invalid` signal for unexpected parser errors (crashes/exceptions) — those retry naturally via SQS and may succeed on subsequent attempts.

### Requirement 19: ICS Implementation Conformance Validation

**User Story:** As a developer, I want the ICS parser and REPLY composer validated against established iCalendar conformance test fixtures, so that the implementation is proven interoperable with real-world calendar clients.

#### Acceptance Criteria

1. THE ICS_Parser SHALL be validated against the ical.js (kewisch/ical.js) test fixture corpus, which contains real-world `.ics` samples covering RFC 5545 edge cases, recurrence rules, timezone handling, and malformed input.
2. THE RSVP_Composer output SHALL be validated by parsing the composed METHOD:REPLY `.ics` back through ical.js and asserting the resulting structure contains the correct VEVENT_UID, SEQUENCE, ATTENDEE with PARTSTAT, and METHOD.
3. THE test suite SHALL include real-world `.ics` samples from Google Calendar, Microsoft Outlook, and Apple Calendar to verify parsing interoperability with the three dominant calendar providers.
4. THE test suite SHALL include adversarial `.ics` samples testing the security limits defined in Requirement 5 (oversized files, VTIMEZONE bombs, excessive attendees, malformed structure, excessive nesting).
5. WHEN a new calendar-related bug is discovered in production, THE fix SHALL include a regression test using the actual `.ics` that triggered the bug, added to the conformance corpus.

### Requirement 20: Calendar Proxy Scenario Tests

**User Story:** As a developer, I want explicit end-to-end scenario tests for each calendar proxy flow, so that product business expectations are encoded as immutable test contracts.

#### Acceptance Criteria

1. THE test suite SHALL include named scenario tests for each of the following flows, with test names encoding the business expectation (e.g. "calendar invite from approved sender is forwarded to user's real calendar because the proxy must deliver all valid invites"):
   - Inbound REQUEST from approved sender → calendar signal created → `.ics` constructed and forwarded to calendarForwardingAddress
   - Inbound CANCEL for existing event → calendar signal created → constructed CANCEL forwarded to calendarForwardingAddress
   - Inbound RESCHEDULE (higher SEQUENCE) → calendar signal created → constructed update forwarded to calendarForwardingAddress
   - User RSVP via UI → calendar_response signal created → masked REPLY sent to original organizer with original UID
   - User's calendar app sends native REPLY → inbound at proxy ORGANIZER address → HMAC validated → calendar_response signal created → masked REPLY sent to original organizer
   - Inbound REPLY with invalid HMAC → silently dropped, no signal created
   - Inbound REPLY with invalid accountId checksum → silently dropped, no signal created
   - Quarantined email with `.ics` approved → calendar signal created → forwarded to calendarForwardingAddress
   - API returns CalendarData from the calendar signal (not the email signal) when listing arc signals
   - API returns most recent calendar_response decision alongside the calendar signal
2. EACH scenario test SHALL include a comment explaining WHY the expected behavior must never change (the product contract it enforces).
3. THE scenario tests SHALL use static, deterministic inputs with explicit expected outputs — no random generation.


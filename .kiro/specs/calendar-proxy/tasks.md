# Implementation Plan: Calendar Proxy

## Overview

Remove the `scheduling` workflow and introduce a cross-workflow calendar proxy layer. The implementation proceeds bottom-up: type system changes first, then pure functions (parser, UID builder, ICS builder), then orchestration (forwarder, RSVP composer, response handler), then API/rule integration, and finally conformance and scenario tests.

## Tasks

- [x] 1. Type system changes and scheduling workflow removal
  - [x] 1.1 Update type constants and remove scheduling workflow
    - Remove `"scheduling"` from `WORKFLOWS` array
    - Remove `SchedulingData` interface and its entry in `WorkflowData` union
    - Remove `"system:workflow:scheduling"` from `SystemLabel` type
    - Add `"signal"` to `SIGNAL_SOURCES`
    - Add `"calendar_event"`, `"calendar_response"`, `"calendar_invite_invalid"`, `"domain_misconfiguration"` to `SIGNAL_TYPES`
    - Add `"forwardCalendarInvite"` to `RULE_ACTION_TYPES`
    - Add `calendarForwardingAddress?: string` to `Account` interface
    - Add `"system:calendar"` to `SystemLabel` type
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.5, 10.1, 10.2, 9.1_

  - [x] 1.2 Add CalendarData and related signal data interfaces
    - Create `src/types/calendar.ts` with `CalendarEventData`, `CalendarAttendee`, `CalendarResponseData`, `CalendarInviteInvalidData`, `DomainMisconfigurationData` interfaces
    - Add calendar signal type guards (`isCalendarEventSignal`, `isCalendarResponseSignal`, etc.)
    - Update `AnySignal` union to include calendar signal types
    - Export from `src/types/index.ts`
    - _Requirements: 4.1, 4.2, 4.3, 12.2, 18.2_

  - [x] 1.3 Remove scheduling references from classifier prompt
    - Remove the scheduling workflow section from the classifier prompt template
    - Ensure classifier assigns workflow based on sender context, not calendar attachment presence
    - _Requirements: 1.5, 1.6_

- [x] 2. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. ICS Parser — pure functions
  - [x] 3.1 Implement `findCalendarAttachment` detection
    - Create `src/processor/calendar/ics-parser.ts`
    - Implement attachment detection by MIME type (`text/calendar`) or filename extension (`.ics`)
    - Implement multi-attachment priority: first with METHOD property, fallback to first `.ics`
    - Log TRACK when multiple calendar attachments found
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 3.2 Write unit tests for `findCalendarAttachment`
    - `it.each` table for MIME/extension detection (Property 1)
    - `it.each` table for multi-attachment priority selection (Property 2)
    - _Requirements: 2.1, 2.3_

  - [x] 3.3 Implement `parseIcs` with size/complexity limits and URL sanitization
    - Use `ical.js` (kewisch/ical.js) to parse `.ics` bytes into `CalendarData`
    - Enforce limits: 1 MB file size, 100 VTIMEZONE components, 100 ATTENDEEs (truncate), nesting depth 5, 5s timeout, 100 KB output
    - Strip all VALARM components
    - Validate URLs: allow only `https:`, `http:`, `mailto:` schemes; reject IP literals, localhost, private ranges for http/https; validate email syntax for mailto
    - Return `Result<IcsParseResult, IcsParseError>` using neverthrow
    - _Requirements: 4.1, 4.4, 4.7, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 3.4 Write unit tests for `parseIcs`
    - `it.each` table for VALARM stripping (Property 4)
    - `it.each` table for URL sanitization (Property 5)
    - Edge case tests at size/complexity boundaries
    - Malformed input rejection tests
    - _Requirements: 5.1, 5.2, 5.6, 6.1, 6.5_

- [x] 4. Proxy UID Builder — pure functions
  - [x] 4.1 Implement `buildProxyUid` and `validateProxyUid`
    - Create `src/processor/calendar/proxy-uid.ts`
    - `buildProxyUid`: construct `{accountId}.{arcId}.{originalVeventUid}.{hmac16}@{serviceDomain}` with HMAC-SHA256 truncated to 16 chars base64url (no padding)
    - `validateProxyUid`: decompose proxy UID, recompute HMAC, compare first 16 chars
    - Pure functions, no I/O
    - _Requirements: 11.1, 11.2, 11.5, 14.2, 14.5, 14.6_

  - [x] 4.2 Write unit tests for proxy UID builder
    - `it.each` table for construction format and determinism (Property 9)
    - `it.each` table for HMAC validation — valid, invalid, tampered (Property 12 partial)
    - _Requirements: 11.1, 14.2_

- [x] 5. ICS Builder — pure functions
  - [x] 5.1 Implement `buildForwardToUserIcs` and `buildReplyToOrganizerIcs`
    - Create `src/processor/calendar/ics-builder.ts`
    - `buildForwardToUserIcs`: construct `.ics` with proxy UID, proxy ORGANIZER (with CN), ATTENDEE as calendarForwardingAddress with PARTSTAT=NEEDS-ACTION;RSVP=TRUE, preserve SEQUENCE/DTSTART/DTEND/SUMMARY/LOCATION/DESCRIPTION/STATUS/METHOD, strip VALARM
    - `buildReplyToOrganizerIcs`: construct METHOD:REPLY with original VEVENT_UID (not proxy), ATTENDEE with PARTSTAT matching decision, ORGANIZER field
    - Use `ical.js` for iCal generation
    - _Requirements: 10.4, 10.5, 10.6, 11.3, 15.1, 15.2_

  - [x] 5.2 Write unit tests for ICS Builder
    - `it.each` table for field preservation in forward ICS (Property 7)
    - `it.each` table for PARTSTAT mapping in reply ICS (Property 14)
    - Verify REPLY uses original UID not proxy UID (Property 10)
    - Verify proxy ORGANIZER format and CN (Property 11)
    - _Requirements: 10.5, 11.3, 15.1_

- [x] 6. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Calendar Forwarder — side-effect worker
  - [x] 7.1 Implement `forwardCalendarInvite` side-effect handler
    - Create `src/processor/calendar/calendar-forwarder.ts`
    - Load HMAC secret (KMS-decrypted `.kms` file at cold start)
    - Build proxy UID via `buildProxyUid`
    - Build proxy ORGANIZER as `mailto:{arcId}@{accountId}.{serviceDomain}`
    - Construct `.ics` via `buildForwardToUserIcs`
    - Send email via SES with `X-Numaeel-Calendar-Signal-Id` header
    - No-op if `calendarForwardingAddress` is empty (log TRACK)
    - Forward all METHOD values without filtering
    - _Requirements: 10.3, 10.4, 10.7, 10.8, 10.9, 11.1, 12.1, 12.4_

  - [x] 7.2 Write unit tests for Calendar Forwarder
    - `it.each` table for all METHOD values forwarded (Property 8)
    - Verify `X-Numaeel-Calendar-Signal-Id` header inclusion
    - Verify no-op when calendarForwardingAddress missing
    - _Requirements: 10.7, 10.9_

  - [x] 7.3 Implement `signalLookupId` construction for calendar signals
    - Format: `cal-{organizerEmail}-{veventUid}`
    - Integrate into signal creation during processing
    - _Requirements: 3.2, 3.6_

  - [x] 7.4 Write unit tests for signalLookupId format
    - `it.each` table for deterministic key construction (Property 3)
    - _Requirements: 3.2_

- [x] 8. RSVP Composer
  - [x] 8.1 Implement `sendRsvp` function
    - Create `src/processor/calendar/rsvp-composer.ts`
    - Compose METHOD:REPLY via `buildReplyToOrganizerIcs` using original VEVENT_UID and SEQUENCE
    - Send FROM alias address TO ORGANIZER mailto: address (per RFC 6047)
    - ATTENDEE in REPLY = alias address with correct PARTSTAT
    - Return SES message ID on success
    - _Requirements: 7.1, 14.1, 14.2, 14.3, 14.4_

  - [x] 8.2 Write unit tests for RSVP Composer
    - `it.each` table for RSVP target = ORGANIZER address (Property 6)
    - Verify REPLY uses original UID not proxy (Property 10)
    - _Requirements: 7.1, 14.3_

- [x] 9. Calendar Response Handler — inbound REPLY routing
  - [x] 9.1 Implement `handleCalendarResponse` for native calendar REPLY
    - Create `src/processor/calendar/calendar-response-handler.ts`
    - Route inbound emails matching `{arcId}@{accountId}.{serviceDomain}` pattern
    - Validate accountId checksum (last 3 chars = SHA-256 prefix of preceding, base58-filtered)
    - Validate arcId checksum (same algorithm)
    - Parse `.ics` attachment, extract proxy UID
    - Validate proxy UID HMAC via `validateProxyUid`
    - On validation failure: silent drop + WARN log (no DB, no signal, no response)
    - On success: trigger RSVP_Composer, create `calendar_response` signal
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 14.1, 14.4, 14.5_

  - [x] 9.2 Write unit tests for Calendar Response Handler
    - `it.each` table for address pattern routing (Property 16)
    - `it.each` table for stateless validation gate — no I/O on failure (Property 12)
    - Happy path: valid REPLY → signal + masked REPLY sent
    - _Requirements: 13.1, 14.1, 14.4_

- [x] 10. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Signal processing integration
  - [x] 11.1 Integrate ICS_Parser into signal processor
    - In `src/processor/processor.ts`, after email signal creation, call `findCalendarAttachment` + `parseIcs`
    - On valid parse: create calendar signal (source: "signal", type: "calendar_event") on same arc with `linkedSignalId`
    - Store raw `.ics` as S3 attachment on calendar signal
    - Apply `system:calendar` label to originating email signal
    - On parse rejection: create `calendar_invite_invalid` signal with reason
    - On unexpected crash: do NOT create invalid signal, let SQS retry
    - _Requirements: 3.1, 3.3, 3.4, 4.5, 4.6, 4.8, 10.1, 18.1, 18.5_

  - [x] 11.2 Wire `forwardCalendarInvite` rule action into side-effect pipeline
    - Add system rule matching `system:calendar` label → `forwardCalendarInvite` action
    - Resolve `calendarForwardingAddress` from account config at rule evaluation time
    - Handle in `src/processor/sqs-dispatcher.ts` or side-effect worker
    - _Requirements: 10.2, 10.3_

  - [x] 11.3 Implement post-approval calendar forwarding
    - When quarantined signal with linked calendar signal is approved (status → "active"), trigger Calendar_Forwarder
    - Same construction rules as normal forwarding
    - _Requirements: 16.1, 16.2_

- [x] 12. API endpoints
  - [x] 12.1 Implement RSVP API endpoint
    - `POST /arcs/{arcId}/signals/{signalId}/rsvp` accepting `{ decision: "accepted" | "declined" | "tentative" }`
    - Send-first: call RSVP_Composer, then create `calendar_response` signal on success
    - On send failure: return error, do NOT create signal (Property 13)
    - On domain misconfiguration: create `domain_misconfiguration` signal, return 422
    - _Requirements: 12.1, 12.2, 12.4, 12.5, 14.5, 17.3_

  - [x] 12.2 Expose CalendarData in signal API responses
    - Include CalendarData on calendar signal responses
    - Include most recent `calendar_response` decision alongside calendar signal
    - Render calendar card from calendar signal (source: "signal"), not email signal
    - _Requirements: 17.1, 17.2, 17.4, 17.5, 17.6_

- [x] 13. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Conformance and scenario tests
  - [x] 14.1 Write ICS conformance tests with real-world fixtures
    - Parse real-world `.ics` samples from Google Calendar, Outlook, Apple Calendar
    - Validate against ical.js corpus for RFC 5545 edge cases
    - REPLY round-trip: compose → parse back through ical.js → assert structure
    - Adversarial samples: oversized, VTIMEZONE bombs, excessive nesting, malformed
    - _Requirements: 19.1, 19.2, 19.3, 19.4_

  - [x] 14.2 Write named scenario tests for calendar proxy flows
    - Each scenario: static inputs, explicit expected outputs, comment explaining WHY
    - Scenarios: REQUEST forwarded, CANCEL forwarded, RESCHEDULE forwarded, UI RSVP, native REPLY via proxy, invalid HMAC dropped, invalid checksum dropped, quarantine approval triggers forward, API returns CalendarData from calendar signal, API returns most recent decision
    - _Requirements: 20.1, 20.2, 20.3_

- [x] 15. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Tests use `it.each` tables with static deterministic inputs — no fast-check or random generation
- `ical.js` (kewisch/ical.js) is the single iCal library for both parsing and generation
- HMAC secret loaded from KMS-encrypted `.kms` file at cold start
- The `scheduling` workflow removal in task 1.1 will cause type errors across the codebase that must be resolved before proceeding

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["3.1", "4.1"] },
    { "id": 3, "tasks": ["3.2", "3.3", "4.2", "5.1"] },
    { "id": 4, "tasks": ["3.4", "5.2", "7.3"] },
    { "id": 5, "tasks": ["7.1", "7.4", "8.1"] },
    { "id": 6, "tasks": ["7.2", "8.2", "9.1"] },
    { "id": 7, "tasks": ["9.2", "11.1"] },
    { "id": 8, "tasks": ["11.2", "11.3", "12.1"] },
    { "id": 9, "tasks": ["12.2"] },
    { "id": 10, "tasks": ["14.1", "14.2"] }
  ]
}
```

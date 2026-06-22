# Requirements Document

## Introduction

Add deterministic arc matching via RFC 5322 `In-Reply-To` header lookup as a Tier 1.5 step in the email processor's arc matching pipeline. This sits between the existing grouping key lookup (Tier 1) and vector similarity search (Tier 2), eliminating expensive Bedrock embedding generation and Aurora pgvector queries for threaded conversations that carry RFC threading headers.

## Glossary

- **Processor**: The `EmailProcessor` class in `processor.ts` that orchestrates inbound email processing through classification, arc matching, rule evaluation, and signal persistence.
- **Arc**: A conversation thread — a materialized aggregate of related signals stored in DynamoDB.
- **Signal**: An immutable inbound event (email) stored in DynamoDB with a composite key on the signals table.
- **Signals_Table**: The DynamoDB table (`email-catcher-signals`) storing signals, arcs, and grouping key items.
- **RFC_Message_ID**: The globally unique identifier assigned to an email per RFC 5322 §3.6.4. Per the spec, the msg-id is the value *between* the angle brackets (e.g., `unique-id@domain.com`, not `<unique-id@domain.com>`). Stored without angle brackets.
- **In_Reply_To_Header**: The RFC 5322 `In-Reply-To` header field containing one or more RFC_Message_IDs (each enclosed in angle brackets, separated by CFWS) of the message(s) being replied to.
- **GSI2**: A new Global Secondary Index on the Signals_Table keyed by account-scoped RFC_Message_ID, enabling O(1) lookup of the signal (and its arcId) that originated a given Message-ID.
- **Grouping_Key**: An existing deterministic lookup key derived from workflow classification, used for machine-generated email patterns (auth, alerts, packages).
- **Similarity_Search**: The existing Aurora pgvector cosine similarity search used to match conversational emails to arcs.
- **Arc_Database**: The `ArcDatabase` class in `arc-database.ts` providing DynamoDB read/write operations for arcs and signals.

## Requirements

### Requirement 1: Store RFC Message-ID on inbound signals

**User Story:** As the system, I want to persist the RFC Message-ID from each inbound email as a GSI2 attribute on the signal item, so that future replies can locate the originating signal via index lookup.

#### Acceptance Criteria

1. WHEN an inbound email signal is saved to the Signals_Table, THE Processor SHALL write a `gsi2pk` attribute with the value `ACCT#{accountId}#MSGID#{msgId}` where `msgId` is extracted from the parsed MIME `message-id` header by stripping the enclosing angle brackets (e.g., `<abc@example.com>` → `abc@example.com`). If no angle brackets are present, the raw value is used as-is.
2. IF the inbound email does not contain a `message-id` header, or the extracted msg-id is empty or contains only whitespace, THEN THE Processor SHALL save the signal without a `gsi2pk` attribute.
3. IF the computed `gsi2pk` value exceeds 1024 characters, THE Processor SHALL truncate it to 1024 characters before writing. The same truncation SHALL be applied on the query side (R3) so that stored and queried keys always match.
4. WHEN the signal item is deleted (via TTL or explicit deletion), THE GSI2 entry SHALL be removed automatically by DynamoDB (projected from the base item).

### Requirement 2: Store constructed Message-ID on outbound signals

**User Story:** As the system, I want to persist the SES-constructed Message-ID from outbound emails as a GSI2 attribute on the signal item, so that inbound replies to user-sent messages can be threaded to the correct arc.

#### Acceptance Criteria

1. WHEN the draft-send-worker updates a signal's status to "sent" with a `sesMessageId`, THE Processor SHALL write a `gsi2pk` attribute with the value `ACCT#{accountId}#MSGID#{sesMessageId}@{SES_REGION}.amazonses.com` on the same signal item in a single DynamoDB update operation. SES overrides the `Message-ID` header on all outbound emails with the format `<{sesMessageId}@{region}.amazonses.com>` — the GSI key stores the msg-id content (without angle brackets) to match what will be extracted from recipients' `In-Reply-To` headers.
2. IF the outbound signal update does not include a `sesMessageId`, THEN THE Processor SHALL not write a `gsi2pk` attribute on the signal item.
3. THE `SES_REGION` value SHALL be sourced from the deployment environment configuration (same region the SESv2 client operates in).

### Requirement 3: In-Reply-To arc lookup

**User Story:** As the system, I want to query GSI2 using the `In-Reply-To` header from inbound emails, so that I can deterministically match replies to existing arcs without embedding generation or similarity search.

#### Acceptance Criteria

1. WHEN an inbound email has an `In-Reply-To` header and the grouping key lookup returned no match, THE Processor SHALL extract the first msg-id from the header (the content between the first `<` and `>` pair), construct the GSI2 key `ACCT#{accountId}#MSGID#{firstMsgId}`, and query GSI2.
2. WHEN the GSI2 query returns a signal item with an `arcId`, THE Processor SHALL use that `arcId` as the matched arc and skip embedding generation and Similarity_Search entirely.
3. WHEN the GSI2 query returns no result, THE Processor SHALL fall through to embedding generation and Similarity_Search (existing Tier 2 behavior).
4. IF the GSI2 query returns a signal item without an `arcId` (quarantined or blocked signal), THEN THE Processor SHALL treat the lookup as a miss and fall through to Similarity_Search.
5. WHEN the `In-Reply-To` header contains multiple msg-ids (per RFC 5322 §3.6.4: `1*msg-id`, each enclosed in angle brackets, separated by CFWS), THE Processor SHALL extract and use only the first msg-id (content of the first `<...>` pair).
6. WHEN the GSI2 lookup produces an arc match, THE Processor SHALL log the match method as `"inReplyTo"`.
7. IF the GSI2 query fails due to a transient error, THEN THE Processor SHALL treat the lookup as a miss and fall through to embedding generation and Similarity_Search rather than failing the record.

### Requirement 4: Parallel execution with priority-ordered selection

**User Story:** As the system, I want all three arc matching tiers to execute on every inbound signal, logging discrepancies between their results, and selecting the matched arc using the priority order Tier 1 → Tier 1.5 → Tier 2.

#### Acceptance Criteria

1. THE Processor SHALL execute all applicable tiers in parallel for every inbound signal: Tier 1 (grouping key), Tier 1.5 (In-Reply-To GSI2 lookup), and Tier 2 (embedding generation + similarity search).
2. WHEN multiple tiers produce a match, THE Processor SHALL select the arc from the highest-priority tier that returned a result (priority: Tier 1 > Tier 1.5 > Tier 2).
3. WHEN two or more tiers produce matches that disagree (different arcIds), THE Processor SHALL log a TRACK with code `"processor.arc_match_discrepancy"` including: the arcId from each tier that matched, the accountId, sesMessageId, and which tier was selected.
4. WHEN only one tier produces a match, THE Processor SHALL use that match without a discrepancy log.
5. WHEN no tier produces a match, THE Processor SHALL create a new arc (existing behavior).
6. THE Processor SHALL log the selected match method as one of: `"groupingKey"`, `"inReplyTo"`, `"similarity"`, or `"none"` (new arc created).
7. Tier 1 and Tier 1.5 MAY execute before Tier 2 completes (Tier 2 requires embedding generation which is slower), but the final selection SHALL wait for all tiers to resolve before proceeding.

### Requirement 5: GSI2 infrastructure on the signals table

**User Story:** As the system, I want a GSI on the signals table keyed by `gsi2pk`, so that In-Reply-To lookups execute as O(1) DynamoDB queries.

#### Acceptance Criteria

1. THE Signals_Table SHALL have a Global Secondary Index named `gsi2` with hash key `gsi2pk` (type String) and no range key.
2. THE GSI2 SHALL use `INCLUDE` projection with non-key attributes: `arcId`, `accountId`, `id`, `signalLookupId`, `source`, `status`, `type`.
3. THE GSI2 key format SHALL be `ACCT#{accountId}#MSGID#{msgId}` to scope lookups per tenant and prevent cross-account collisions from forged Message-IDs.

### Requirement 6: Account-scoped Message-ID isolation

**User Story:** As an account holder, I want Message-ID lookups scoped to my account, so that forged `In-Reply-To` headers from external senders cannot thread messages into another account's arcs.

#### Acceptance Criteria

1. THE Processor SHALL always include the `accountId` in the GSI2 key, preventing a signal from one account from matching a Message-ID stored by a different account.
2. WHEN processing an inbound email, THE Processor SHALL derive the `accountId` from the recipient address routing (SES-verified domain and alias mapping) before constructing the GSI2 query key.
3. THE Processor SHALL NOT use any value from the inbound email MIME headers (From, Sender, Reply-To, or any other header field) to determine the `accountId` used in the GSI2 query key.

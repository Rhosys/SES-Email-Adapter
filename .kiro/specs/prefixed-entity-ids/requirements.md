# Requirements Document

## Introduction

Replace bare `randomUUID()` calls across all entity types with prefixed, time-ordered, base58-encoded IDs. The new ID format uses UUIDv7 (time-ordered, RFC 9562) encoded to flickrBase58 via the `short-uuid` library, with 3 SHA-256 check characters appended, and a type prefix prepended. This gives IDs that are: shorter than UUIDs, time-sortable, type-identifiable at a glance, and protected against single-character transcription errors via the check suffix.

Signals get the same `sgn-` prefixed ID as their external-facing identity. The DynamoDB table PK for inbound signals retains the SES messageId (prefixed with `ses-`) for deduplication — this is an internal storage key, not the signal's public ID. All signal lookups except the inbound dedup check go through the GSI, keyed on the `sgn-` ID.

Domain retains the domain string as its ID. Account retains its existing `acc-` generation (to be migrated separately if desired).

## Glossary

- **UUIDv7**: A 128-bit UUID with a Unix timestamp in the most significant 48 bits, providing time-ordered uniqueness (RFC 9562).
- **flickrBase58**: The 58-character alphabet used by Flickr's short URLs: `123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ` (excludes `0`, `O`, `I`, `l` for readability).
- **short-uuid**: An npm library that translates standard UUIDs into shorter representations using custom alphabets.
- **Check characters**: 3 characters derived from SHA-256 of the base58 body, filtered to the same base58 alphabet, appended to detect transcription errors.
- **Entity prefix**: A short string identifying the entity type (e.g. `arc-`, `rule-`), prepended to the encoded ID.

## Requirements

### Requirement 1: ID Generation Utility

**User Story:** As a developer, I want a single shared utility for generating prefixed IDs, so that all entity types use a consistent format.

#### Acceptance Criteria

1. THE system SHALL provide a `generateId(prefix: string)` function exported from `src/utils/id.ts`.
2. THE function SHALL generate a UUIDv7 using the `uuid` package.
3. THE function SHALL encode the UUIDv7 to flickrBase58 using the `short-uuid` library's translator with the flickrBase58 alphabet.
4. THE function SHALL compute 3 check characters by taking the SHA-256 hash of the base58 string, filtering the hex output to only characters present in the flickrBase58 alphabet, and taking the first 3 characters.
5. THE function SHALL return `{prefix}{base58}{checkChars}` as the final ID string.
6. THE function SHALL produce IDs that are time-sortable (lexicographic sort of the base58 portion preserves chronological order).

### Requirement 2: Entity Prefixes

**User Story:** As a developer or operator, I want to identify the entity type from its ID alone, so that debugging and log analysis are faster.

#### Acceptance Criteria

1. Arc IDs SHALL use the prefix `arc-`.
2. View IDs SHALL use the prefix `view-`.
3. Rule IDs SHALL use the prefix `rule-`.
4. Label IDs SHALL use the label name itself as the identifier (same pattern as Domain, Alias, and Forwarding Address). The DynamoDB SK becomes `LABEL#{name}`. Label names are immutable — the API SHALL NOT allow renaming a label. Users who want a different name must create a new label, reassign arcs, and delete the old one.
5. Template IDs SHALL use the prefix `tpl-`.
6. Alias IDs SHALL use the email address itself as the identifier (same pattern as Domain and Forwarding Address). No generated ID needed.
7. Forwarding Address IDs SHALL use the email address itself as the identifier (same pattern as Domain). No generated ID needed.
8. Audit Event IDs SHALL use the prefix `aud-`.
9. Signal IDs SHALL use the prefix `sgn-`.

### Requirement 3: Migration of Existing ID Generation Sites

**User Story:** As a developer, I want all entity creation sites updated to use the new ID generator, so that new records use the prefixed format.

#### Acceptance Criteria

1. THE Arc creation in `src/api/app.ts` and `src/processor/processor.ts` SHALL use `generateId("arc-")` instead of `randomUUID()`.
2. THE View creation in `src/database/account-database.ts` SHALL use `generateId("view-")` instead of `randomUUID()`.
3. THE Rule creation in `src/database/account-database.ts` SHALL use `generateId("rule-")` instead of `randomUUID()`.
4. THE Label creation in `src/database/account-database.ts` SHALL use the label name as the key (`LABEL#{name}`). No generated ID needed. The `updateLabel` endpoint SHALL reject name changes (only color/icon are mutable).
5. THE Template creation in `src/api/app.ts` SHALL use `generateId("tpl-")` instead of `randomUUID()`.
6. THE Alias creation in `src/api/app.ts` and `src/processor/processor.ts` SHALL stop generating an `id` — the address string is the natural key (like Domain and Forwarding Address).
7. THE Forwarding Address creation in `src/api/app.ts` SHALL stop generating an `id` — the address string is the natural key (like Domain). The `id` field can be removed from `VerifiedForwardingAddress` or set to the address itself.
8. THE Audit Event creation in `src/database/audit-database.ts` SHALL use `generateId("aud-")` instead of `randomUUID()`.
9. THE Reindex Job ID in `src/jobs/reindex/reindex-dispatcher.ts` SHALL be replaced with `logger.invocationId` — the dispatching Lambda's invocation ID is the natural correlation key for all segments of a reindex run.
10. ALL Signal creation sites SHALL use `generateId("sgn-")` as the signal's `id` field — this is the external-facing ID returned by the API and used in the GSI SK.
11. Domain IDs (the domain string itself) SHALL NOT be changed.
12. Account IDs (`acc-` with existing generation) SHALL NOT be changed.
13. The forwarding address `token` field (used for email verification links) SHALL remain `randomUUID()` — it is a secret token, not a public identifier.
14. Logger container ID and invocation ID SHALL remain `randomUUID()` — they are internal correlation IDs, not entity identifiers.

### Requirement 4: Signal Table Key Strategy

**User Story:** As a developer, I want inbound signal deduplication to remain a single O(1) lookup by SES messageId, while the external signal ID uses the same prefixed format as all other entities.

#### Acceptance Criteria

1. THE DynamoDB table PK for inbound (SES) signals SHALL be `ACCT#{accountId}#SIG#ses-{sesMessageId}` — the `ses-` prefix makes it clear this is the SES-sourced storage key, not the signal's public ID.
2. THE DynamoDB table PK for user-created and system signals SHALL be `ACCT#{accountId}#SIG#{sgnId}` — using the `sgn-` prefixed ID directly.
3. THE signal's `id` field (stored as an attribute, returned by the API) SHALL always be a `sgn-` prefixed ID regardless of signal source.
4. THE Signal type SHALL have a `signalLookupId` field — this is the value used in the table PK (either `ses-{sesMessageId}` for inbound or the `sgn-` ID for user/system). It is the internal storage key.
5. THE Signal type SHALL have a `sesMessageId` field (present only on inbound signals) — this stores the raw SES message ID for reference and is used to construct the `signalLookupId`.
6. THE `getSignalByMessageId` function SHALL look up by `ses-{sesMessageId}` as the signalLookupId for dedup, then return the signal with its `sgn-` ID.
7. ALL signal lookups except the inbound dedup check SHALL go through the GSI, using the `sgn-` ID in the GSI SK.
8. THE GSI SK for signals SHALL be the `sgn-` ID itself (no `RECV#` prefix needed — UUIDv7 base58 already sorts chronologically).
9. Database methods that update or delete a signal by PK (updateSignalStatus, unblockSignal, updateSignal, updateSignalSendStatus, deleteSignal, addEmbeddingToCache) SHALL accept `signalLookupId` (the PK value) instead of `signalId`. Callers that already have the signal object pass `signal.signalLookupId`. Callers that only have the `sgn-` ID fetch the signal via GSI first to obtain the `signalLookupId`.
10. THE `hasSignals` function SHALL remain unchanged — it queries arcs (gsi1pk = `ACCT#{accountId}`) not signals directly.

### Requirement 5: Backward Compatibility

**User Story:** As an operator, I want existing records with old-format IDs to continue working, so that no data migration is required for non-signal entities.

#### Acceptance Criteria

1. THE system SHALL accept both old-format (bare UUID) and new-format (prefixed base58) IDs in all API path parameters and request bodies that reference entity IDs.
2. THE DynamoDB key structure for non-signal entities SHALL remain unchanged — the ID is stored as-is in the `sk` field (e.g. `VIEW#{id}`, `RULE#{id}`).
3. No data migration SHALL be required for non-signal entities — old records retain their UUID-format IDs indefinitely.
4. THE system SHALL NOT validate ID format on read paths — any string that matches the DynamoDB key is valid.
5. Existing signals with old `SES#`/`USR#`/`SYS#` format IDs SHALL be backfilled by a one-time scan job that adds a `sgn-` ID and updates the GSI SK. Until backfilled, old signals will not appear in GSI queries via the new key format.

### Requirement 6: GSI Tenant Isolation

**User Story:** As an operator, I want all GSI partition keys to include the accountId, so that tenant isolation is enforced at the data layer and no query can accidentally return signals from another account.

#### Acceptance Criteria

1. THE signal GSI PK for signals belonging to an arc SHALL be `ACCT#{accountId}#ARC#{arcId}`.
2. THE signal GSI PK for quarantined signals SHALL be `ACCT#{accountId}#QUARANTINED`.
3. THE signal GSI PK for blocked signals SHALL be `ACCT#{accountId}#BLOCKED`.
4. ALL GSI partition keys on the signals table SHALL include `accountId` — no cross-account query path SHALL exist.
5. Arc items in the same table are unaffected — they already use `gsi1pk = ACCT#{accountId}` with `gsi1sk = LASTACT#...`.
6. Existing signals with old GSI PK formats SHALL be backfilled by the same one-time scan job (Requirement 5.5).

### Requirement 7: Dependencies

**User Story:** As a developer, I want the minimum new dependencies added to support this feature.

#### Acceptance Criteria

1. THE `uuid` package (latest ESM-compatible version) SHALL be added as a production dependency for UUIDv7 generation.
2. THE `short-uuid` package SHALL be added as a production dependency for base58 encoding.
3. No other new dependencies SHALL be introduced for this feature.

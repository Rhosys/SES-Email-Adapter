# Implementation Plan: Rework Notifier

## Overview

Replace the existing `SesNotifier` with a unified `DeviceNotifier` that delivers real-time notifications via WebSocket (browser) and mobile push (FCM/APNs). All notification targets are stored as `DEVICE#` records in DynamoDB. Urgency drives channel selection and push priority. The SES email notification path is removed entirely.

## Tasks

- [x] 1. Define core types and interfaces
  - [x] 1.1 Create device types, Deliverer interface, and NotificationPayload
    - Create `src/notifier/types.ts` with: `DeviceType`, `Device`, `DeliveryResult`, `Deliverer`, `NotificationPayload`, `PushPriority`, `ArcUrgency` type (or import from existing), and `urgencyToPushPriority` mapping function
    - Export the updated `Notifier` interface with the new `notify(accountId, arc, signal, urgency)` signature
    - _Requirements: 4.1, 4.2, 5.1, 5.3_

  - [x] 1.2 Create DeviceStore interface and DynamoDB implementation
    - Create `src/notifier/device-store.ts` with `DeviceStore` interface (`listDevices`, `saveDevice`, `deleteDevice`, `countDevices`)
    - Implement `DynamoDeviceStore` class using `ACCT#{accountId}` / `DEVICE#{token}` key schema
    - Enforce mobile device limit (10) in `saveDevice` — reject with validation error if limit reached
    - Validate token non-empty and type in `{websocket, fcm, apns}` on save
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 6.7_

  - [x] 1.3 Write unit tests for DeviceStore
    - Test round-trip save/list preserves token and type (Property 7)
    - Test upsert idempotency — saving same token twice yields one record (Property 8)
    - Test mobile device count limit — 11th distinct mobile token rejected (Property 9)
    - Test validation rejects empty token and invalid type (Property 10)
    - Test websocket devices exempt from mobile limit
    - Use `it.each` with static labelled cases
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 6.7_

- [x] 2. Implement deliverers
  - [x] 2.1 Implement WsDeliverer
    - Create `src/notifier/ws-deliverer.ts` using `@aws-sdk/client-apigatewaymanagementapi` `PostToConnectionCommand`
    - Return `"stale"` on `GoneException` (410), `"failed"` on other errors, `"delivered"` on success
    - _Requirements: 2.1, 2.3, 2.5_

  - [x] 2.2 Write unit tests for WsDeliverer
    - Test successful delivery returns `"delivered"`
    - Test 410 GoneException returns `"stale"`
    - Test 5xx/timeout returns `"failed"` with reason
    - Mock `ApiGatewayManagementApiClient`
    - _Requirements: 2.3, 2.5_

  - [x] 2.3 Implement FcmClient (FCM HTTP v1 thin wrapper)
    - Create `src/notifier/fcm-client.ts` with `FcmClient` interface and `HttpFcmClient` implementation
    - Use `fetch` + Google Auth Library for OAuth2 service account token
    - Map FCM error codes to `FcmSendResult` union (`UNREGISTERED`, `QUOTA_EXCEEDED`, `UNAVAILABLE`, `INTERNAL`, `INVALID_ARGUMENT`)
    - _Requirements: 3.1, 3.4, 3.5_

  - [x] 2.4 Implement FcmDeliverer
    - Create `src/notifier/fcm-deliverer.ts` implementing `Deliverer`
    - Build FCM message with platform-specific priority/sound/badge based on `PushPriority`
    - `interrupt` → high priority, sound enabled, badge increment
    - `ambient` → normal priority, no sound, badge increment only
    - Return `"stale"` on UNREGISTERED, `"failed"` on other errors
    - _Requirements: 3.1, 3.2, 3.4, 3.5_

  - [x] 2.5 Write unit tests for FcmDeliverer
    - Test interrupt priority sets high priority, sound, badge (Property 5)
    - Test ambient priority sets normal priority, no sound, badge only (Property 5)
    - Test UNREGISTERED returns `"stale"`
    - Test UNAVAILABLE/INTERNAL returns `"failed"`
    - Mock `FcmClient` interface
    - Use `it.each` with static labelled cases for priority mapping
    - _Requirements: 3.2, 4.3, 4.4_

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement DeviceNotifier (core orchestrator)
  - [x] 4.1 Create DeviceNotifier class
    - Create `src/notifier/device-notifier.ts` implementing the `Notifier` interface
    - Constructor accepts `DeviceStore`, `Record<DeviceType, Deliverer>`, and `Logger`
    - `notify`: query devices → derive PushPriority → iterate devices (skip fcm/apns when silent) → dispatch to deliverer → delete stale → return Ok/Err
    - `notifyBlocked`: return `Ok(undefined)` (no-op)
    - Return `Ok` if at least one delivery succeeds or no devices exist; `Err` only on total failure
    - Default urgency to `"normal"` if not provided
    - _Requirements: 1.1, 1.3, 2.1, 2.4, 3.1, 4.2, 4.5, 4.6, 5.3, 5.4, 5.5_

  - [x] 4.2 Write unit tests for DeviceNotifier
    - Test channel selection by urgency — websocket always delivered, push skipped when silent (Property 1)
    - Test all devices attempted and partial failure returns Ok (Property 2)
    - Test all devices fail returns Err (Property 6)
    - Test stale devices are deleted (Property 4)
    - Test notification payload contains all required fields (Property 3)
    - Test empty device list returns Ok
    - Test no SES calls are made (Requirement 1.1)
    - Test default urgency is "normal" when not provided
    - Use `it.each` with static labelled cases for urgency→channel mapping
    - Mock DeviceStore and Deliverer interfaces
    - _Requirements: 1.1, 1.3, 2.1, 2.3, 2.4, 3.1, 3.4, 4.2, 4.3, 4.4, 4.5, 5.4, 5.5_

- [x] 5. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Wire DeviceNotifier into SignalProcessor
  - [x] 6.1 Update handler.ts WebSocket routes to write DEVICE# records
    - Change `$connect` to save a `DEVICE#` record with `type: "websocket"` and TTL via `DeviceStore.saveDevice`
    - Change `$disconnect` to delete the `DEVICE#` record via `DeviceStore.deleteDevice`
    - Remove calls to `accountDb.saveWsConnection` and `accountDb.deleteWsConnection`
    - _Requirements: 2.1_

  - [x] 6.2 Update Notifier interface in processor and wire DeviceNotifier
    - Update the `Notifier` interface in `src/processor/processor.ts` to add `urgency: ArcUrgency` parameter
    - Update all `notify` call sites in `SignalProcessor` to pass `arc.urgency ?? "normal"`
    - Replace `SesNotifier` instantiation in `handler.ts` with `DeviceNotifier` (inject `DynamoDeviceStore`, `WsDeliverer`, `FcmDeliverer`)
    - Remove the old `SesNotifier` class and its SES-related imports from `src/notifier/notifier.ts`
    - _Requirements: 1.1, 1.2, 5.1, 5.2_

  - [x] 6.3 Write integration tests for DeviceNotifier wiring
    - Test that processor invokes notifier with urgency parameter
    - Test that handler instantiates DeviceNotifier with correct dependencies
    - _Requirements: 5.1, 5.2_

- [x] 7. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- All tests use `it.each` with static labelled cases — no fast-check, no random generation
- Correctness properties from the design are implemented as parameterised `it.each` tables over the finite set of meaningfully different inputs
- The `SesForwarder`, `SesReplySender`, and verification mailer are unaffected by this rework

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "2.3"] },
    { "id": 2, "tasks": ["1.3", "2.2", "2.4"] },
    { "id": 3, "tasks": ["2.5", "4.1"] },
    { "id": 4, "tasks": ["4.2"] },
    { "id": 5, "tasks": ["6.1", "6.2"] },
    { "id": 6, "tasks": ["6.3"] }
  ]
}
```

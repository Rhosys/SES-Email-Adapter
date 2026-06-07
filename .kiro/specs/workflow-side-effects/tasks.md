# Implementation Plan: Workflow Side-Effects

## Overview

Implement a per-workflow side-effect dispatcher framework that runs inside `processSideEffect()` between notify and auto_draft. The first handler is `auth`, which pushes structured OTP payloads to connected WebSocket clients and archives the arc. Also adds system rule SR-25 for quarantining security alert auth signals.

## Tasks

- [x] 1. Create WorkflowHandler interface and HandlerRegistry
  - [x] 1.1 Create `src/workflow/types.ts` with the `WorkflowHandler` interface
    - Define `WorkflowHandler` interface with `readonly workflow: Workflow` and `execute(signal, arc, accountId): Promise<Result<void, DbError>>`
    - Import types from `../types/index.js` and `../errors.js`
    - _Requirements: 3.1, 3.2, 3.4_

  - [x] 1.2 Create `src/workflow/registry.ts` with the `HandlerRegistry` class
    - Constructor accepts `WorkflowHandler[]`, builds `Map<Workflow, WorkflowHandler>` from `handler.workflow` keys
    - `dispatch(signal, arc, accountId)` looks up handler by `arc.workflow`, returns `ok(undefined)` if none registered, otherwise delegates to `handler.execute()`
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.4_

  - [x] 1.3 Write unit tests for HandlerRegistry (`src/workflow/registry.spec.ts`)
    - Routes to correct handler for a registered workflow
    - Returns `ok()` when no handler registered
    - Propagates `err()` from handler
    - Passes signal, arc, and accountId to handler's execute method
    - _Requirements: 1.1, 1.2, 1.4, 1.5_

- [x] 2. Implement AuthWorkflowHandler
  - [x] 2.1 Create `src/workflow/auth-handler.ts` with `AuthWorkflowHandler` class and `OtpPayload` interface
    - Constructor injection: `DeviceStore`, `Deliverer`, `ArcDatabase`, `Logger`
    - `workflow = "auth" as const`
    - `execute`: early-return `ok()` if no `workflowData.code`; build OTP payload; deliver to all devices; archive arc; return `ok()` always
    - `buildOtpPayload`: constructs `{ type: "otp", signalId, code, authType, expiresInMinutes, originDomain, subject }`
    - `deliverToAll`: lists devices, delivers to each, deletes stale devices, logs failures
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9_

  - [x] 2.2 Write unit tests for AuthWorkflowHandler (`src/workflow/auth-handler.spec.ts`)
    - `it.each` table for OTP payload construction + fan-out (single device, multiple devices, subdomain sender, with expiresInMinutes)
    - `it.each` table for best-effort invariant (all delivered, all stale, all failed, mixed, listDevices fails)
    - Skips push when `workflowData.code` is undefined
    - Deletes stale device on `{ status: "stale" }` response
    - Archives arc after processing (`updateArc` called with `{ status: "archived" }`)
    - Logs warning when arc archive fails but still returns `ok()`
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6, 4.8, 4.9_

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Integrate dispatcher into processSideEffect and composition root
  - [x] 4.1 Add `HandlerRegistry` to `SignalProcessorOptions` and wire into `processSideEffect()`
    - Add `handlerRegistry: HandlerRegistry` to `SignalProcessorOptions` interface
    - Store as `private readonly handlerRegistry` in the constructor
    - Insert `dispatch()` call between notify and auto_draft blocks with trackPoints `"side_effect_workflow_start"` and `"side_effect_workflow_complete"`
    - If dispatch returns `err()`, set `criticalFailure`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 1.3, 1.4, 1.6_

  - [x] 4.2 Wire `AuthWorkflowHandler` and `HandlerRegistry` in `src/handler.ts` composition root
    - Construct `AuthWorkflowHandler` with `deviceStore`, `wsDeliverer` (the WebSocket deliverer instance), `arcDb`, `logger`
    - Construct `HandlerRegistry` with `[authHandler]`
    - Pass `handlerRegistry` to `SignalProcessor` constructor
    - _Requirements: 2.2, 5.1_

- [x] 5. Extend AuthData type and system labels for security_alert
  - [x] 5.1 Add `"security_alert"` to `AuthData.authType` union in `src/types/index.ts`
    - Extend the union: `"otp" | "password_reset" | "magic_link" | "verification" | "two_factor" | "security_alert" | "other"`
    - _Requirements: 6.1_

  - [x] 5.2 Add `"system:auth:security_alert"` to `SystemLabel` type and `assignSystemLabels()` in `src/processor/filter.ts`
    - Add `| "system:auth:security_alert"` to the `SystemLabel` union in `src/types/index.ts`
    - In `assignSystemLabels()`, emit `"system:auth:security_alert"` when `ctx.workflow === "auth"` and `ctx.workflowData.authType === "security_alert"`
    - _Requirements: 6.1, 6.2_

  - [x] 5.3 Add system rule SR-25 to `SYSTEM_RULES` in `src/processor/processor.ts`
    - Condition: `in_("system:auth:security_alert")`
    - Action: `[{ type: "quarantine_hidden" }]`
    - `priorityOrder: 5` (between SR-01/SR-05 block rules and SR-03 high-spam quarantine)
    - _Requirements: 6.2, 6.3_

  - [x] 5.4 Write unit tests for security_alert system label and SR-25 (`src/processor/filter.spec.ts` or existing test file)
    - `assignSystemLabels` produces `"system:auth:security_alert"` for auth signals with `authType: "security_alert"`
    - `assignSystemLabels` does NOT produce `"system:auth:security_alert"` for other authTypes (e.g. `"otp"`, `"magic_link"`)
    - SR-25 exists in `SYSTEM_RULES` with correct condition and action
    - _Requirements: 6.1, 6.2_

- [x] 6. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- No property-based testing — all tests use static deterministic inputs with `it.each` tables
- Each task references specific requirements for traceability
- Constructor injection throughout — no context bags
- The `HandlerRegistry` owns dispatch; no separate dispatcher function
- Auth handler is best-effort — always returns `ok()` regardless of delivery outcome
- `npm test` must pass after each task before committing
- Each task gets its own commit with `🟣` prefix

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "5.1"] },
    { "id": 1, "tasks": ["1.2", "5.2"] },
    { "id": 2, "tasks": ["1.3", "2.1", "5.3"] },
    { "id": 3, "tasks": ["2.2", "5.4"] },
    { "id": 4, "tasks": ["4.1"] },
    { "id": 5, "tasks": ["4.2"] }
  ]
}
```

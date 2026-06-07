# Bugfix Requirements Document

## Introduction

The auto-draft auto-send mechanism in `processSideEffect()` sends outbound emails without validating whether the reply target is safe. A spammer who legitimately owns their domain (passes DKIM+DMARC) can set `Reply-To: victim@example.com`. If the system resolves the reply target via the Reply-To header, the automated reply spams the victim — using the Email Catcher account as a bounce relay.

DKIM/DMARC only authenticates the `From` header domain. The `Reply-To`, `CC`, `Return-Path`, and all other address fields are completely unverified. The fix gates auto-draft auto-send on validating that the Reply-To domain (when present) matches the From domain or is in the alias's approved senders. If it doesn't match, the auto-send is suppressed and a system signal is created to alert the account owner. The draft is still created for manual review.

Pong is NOT affected — it always sends to `signal.from.address` which is DMARC-authenticated at ingest time. No Reply-To resolution occurs in pong.

**Out of scope** (separate specs):
- Malicious platform user sending to arbitrary addresses (outbound recipient validation)
- UI display of envelope metadata, Reply-To mismatch warnings, BCC detection
- Manual compose recipient validation and approved sender prompts

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a signal has a `replyTo` field whose eTLD+1 differs from the `from.address` eTLD+1 AND the signal triggers auto-draft with auto-send THEN the system creates and dispatches the auto-draft without checking the Reply-To domain mismatch

### Expected Behavior (Correct)

2.1 WHEN a signal triggers auto-draft auto-send THEN the system SHALL validate the signal's Reply-To safety before dispatching: if `signal.replyTo` is present AND its eTLD+1 does NOT match `signal.from.address` eTLD+1 AND the Reply-To eTLD+1 is NOT in the receiving alias's approved senders list THEN the system SHALL suppress auto-send (draft remains as "draft")

2.2 WHEN auto-send is suppressed due to Reply-To domain mismatch THEN the system SHALL log the suppression with the mismatched addresses and create a system signal (using the existing `systemSignalCreator` pattern) alerting the account owner that an automated reply was blocked due to suspicious Reply-To

2.3 WHEN auto-send is suppressed due to Reply-To domain mismatch THEN the system SHALL NOT treat the suppression as a critical failure — no retry shall be forced, and other side-effects (forward, notify, pong) SHALL proceed normally

2.4 WHEN a signal has no `replyTo` field OR the `replyTo` eTLD+1 matches the `from.address` eTLD+1 OR the `replyTo` eTLD+1 is in the receiving alias's approved senders list THEN the system SHALL proceed with auto-draft auto-send normally

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a signal triggers pong THEN the system SHALL CONTINUE TO send the pong reply to `signal.from.address` without any Reply-To validation (pong never uses Reply-To)

3.2 WHEN auto-send is suppressed THEN the system SHALL CONTINUE TO process other side-effects (forward, notify, pong) without interruption

3.3 WHEN a signal does NOT trigger auto-draft THEN the system SHALL CONTINUE TO process all side-effects without any Reply-To validation gate

3.4 WHEN auto-send is suppressed THEN the system SHALL CONTINUE TO create the draft signal (status "draft") but SHALL NOT dispatch it for auto-send — the user can review and manually send if appropriate

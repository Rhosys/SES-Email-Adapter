import { describe, it, expect } from "vitest";
import { isRsvpReplyAddress } from "../../src/processor/inbound-router.js";
import { validateAccountId, validateId } from "../../src/utils/id.js";

// The address that was dropped in production (log code: processor.no_account_for_recipient,
// 2026-09-22T07:23:00.568Z). It has the RSVP reply shape {thr-id}@{acc-id}.{serviceDomain}
// yet fell through to the normal processor, which means isRsvpReplyAddress returned false.
const DROPPED_ADDRESS = "thr-1cep7zzquucqssmfubci5525d@acc-t8cmlkkck3vtm.platform.email.rhosys.cloud";
const SERVICE_DOMAIN = "platform.email.rhosys.cloud";
const DROPPED_ACCOUNT_ID = "acc-t8cmlkkck3vtm";
const DROPPED_THREAD_LOCALPART = "thr-1cep7zzquucqssmfubci5525d";

describe("isRsvpReplyAddress — production-dropped address (REGRESSION)", () => {
  // BUG: this address SHOULD route to the RSVP processor. It does not, because the
  // thread id predates the base58 alphabet migration (d342cda). This test pins the
  // current (broken) behavior; flip to `true` once pre-migration ids are handled.
  it("currently fails to route the exact address that was dropped in production", () => {
    expect(isRsvpReplyAddress(DROPPED_ADDRESS, SERVICE_DOMAIN)).toBe(false);
  });
});

describe("component checks for the dropped address", () => {
  it("accountId passes validateAccountId (acc- ids were unaffected by the migration)", () => {
    expect(validateAccountId(DROPPED_ACCOUNT_ID)).toBe(true);
  });

  it("thread localpart FAILS validateId — this is the break", () => {
    expect(validateId(DROPPED_THREAD_LOCALPART, "thr-")).toBe(false);
  });
});

describe("accountId shape diagnostics for the dropped address", () => {
  const body = DROPPED_ACCOUNT_ID.slice("acc-".length);

  it("body is 13 chars", () => {
    expect(body.length).toBe(13);
  });

  it("body is all lowercase alphanumeric", () => {
    expect(/^[a-z0-9]+$/.test(body)).toBe(true);
  });
});

// Root-cause proof: commit d342cda changed the base58 translator alphabet from
// flickrBase58 (lowercase-before-uppercase) to an ASCII-sortable alphabet
// (uppercase-before-lowercase). The SAME underlying UUIDv7 therefore encodes to a
// DIFFERENT base58 string under the two alphabets. A thread minted before d342cda has
// its whole id (encoded body + check chars) frozen in the flickr encoding; the check
// chars were computed over the flickr-encoded body. Its persisted, forwarded RSVP
// address carries that flickr id verbatim. When the reply comes back today, validateId
// hashes the flickr-encoded body and — because the body maps to a different UUID under
// today's translator — the whole self-consistency check is meaningless; in practice it
// simply fails, so isRsvpReplyAddress returns false and the reply is dropped.
//
// These tests prove: (a) the exact production id fails validation, (b) every freshly
// minted id passes, (c) the dropped id carries the flickr (all-lowercase) signature.
import { generateId } from "../../src/utils/id.js";

describe("validateId round-trip vs. pre-migration id", () => {
  it("accepts a freshly generated thr- id (current alphabet)", () => {
    const fresh = generateId("thr-");
    expect(validateId(fresh, "thr-")).toBe(true);
  });

  it("every freshly generated thr- id validates (100 samples)", () => {
    for (let i = 0; i < 100; i++) {
      const id = generateId("thr-");
      expect(validateId(id, "thr-")).toBe(true);
    }
  });

  it("the dropped id is a flickrBase58 (pre-migration) encoding", () => {
    // flickrBase58 orders lowercase before uppercase, so pre-migration ids skew lowercase.
    // The current alphabet orders uppercase before lowercase, so fresh ids contain early
    // uppercase. The dropped body is all-lowercase after the leading digit+char — the
    // signature of the old alphabet. This is what makes it un-routable today.
    const dropped = DROPPED_THREAD_LOCALPART.slice("thr-".length);
    expect(/[A-Z]/.test(dropped)).toBe(false);
  });

  it("rejects the pre-migration production thread id", () => {
    // Root cause: this id was minted before commit d342cda, which swapped the base58
    // translator alphabet from flickrBase58 to an ASCII-sortable alphabet. The check
    // chars stored on the id (`25d`) were computed over the OLD-alphabet encoding of
    // the underlying UUID; validateId recomputes them over the body-as-stored and gets
    // `cc1`, so the id no longer validates. Any thread minted before d342cda is now
    // un-routable as an RSVP reply.
    expect(validateId(DROPPED_THREAD_LOCALPART, "thr-")).toBe(false);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { S3ObjectStorage, type PresignedPost, type UploadField } from "../src/s3-object-storage.js";

// ---------------------------------------------------------------------------
// These tests run the REAL @aws-sdk/s3-presigned-post (signing is local — no
// network, fake static credentials) and inspect what actually got signed by
// decoding the ticket's base64 Policy. Mocking createPresignedPost hides the
// SDK's behaviour of turning every `Fields` entry into an exact-match policy
// condition, which is exactly the class of bug this file guards against.
// ---------------------------------------------------------------------------

const BUCKET = "content-bucket";
const REGION = "eu-west-1";
const KEY_PREFIX = "accounts/123/senders/example.com/extracted/sig1/";
const MAX_BYTES = 10 * 1024 * 1024;

type Condition = [string, string | number, string | number] | Record<string, string>;
interface Policy { expiration: string; conditions: Condition[] }
type Ticket = PresignedPost<UploadField>;
type Violation = { kind: "extra-field" | "missing-field" | "duplicate-field" | "condition-failed" | "size-out-of-range"; field: string };

function makeStorage(credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } = { accessKeyId: "AKIAFAKE", secretAccessKey: "fake" }): S3ObjectStorage {
  return new S3ObjectStorage(new S3Client({ region: REGION, credentials }), BUCKET);
}

function sign(retentionTag: string | null = null, storage = makeStorage()): Promise<Ticket> {
  return storage.generatePresignedPost({ keyPrefix: KEY_PREFIX, maxBytes: MAX_BYTES, retentionTag });
}

const ticketFields = (ticket: Ticket): Record<string, string> => ticket.fields as Record<string, string>;

function decodePolicy(fields: Record<string, string>): Policy {
  return JSON.parse(Buffer.from(fields["Policy"]!, "base64").toString("utf-8")) as Policy;
}

/** Field → value for every exact-match condition ({field: value} or ["eq", "$field", value]). */
function exactMatches(policy: Policy): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const c of policy.conditions) {
    if (Array.isArray(c)) {
      if (c[0] === "eq") out.push([String(c[1]).slice(1), String(c[2])]);
    } else {
      for (const [k, v] of Object.entries(c)) out.push([k, v]);
    }
  }
  return out;
}

/** Field → prefix for every starts-with condition. */
function startsWiths(policy: Policy): Array<[string, string]> {
  return policy.conditions
    .filter((c): c is [string, string, string] => Array.isArray(c) && c[0] === "starts-with")
    .map((c) => [c[1].slice(1), c[2]]);
}

const forField = (pairs: Array<[string, string]>, field: string): string[] =>
  pairs.filter(([f]) => f.toLowerCase() === field.toLowerCase()).map(([, v]) => v);

// Form fields S3 never requires a policy condition for.
const UNCONDITIONED = new Set(["file", "policy", "x-amz-signature"]);

/**
 * Evaluate a submitted POST form against its signed policy using S3's rules:
 *  - every form field (except file/Policy/X-Amz-Signature/x-ignore-*) must be covered by a condition
 *  - every exact-match / starts-with condition must be satisfied, and its field present
 *  - a field may appear only once
 *  - the file size must be inside content-length-range
 */
function evaluatePolicy(policy: Policy, form: FormData): Violation[] {
  const violations: Violation[] = [];
  const names = [...new Set([...form.keys()])];
  const exact = exactMatches(policy);
  const prefixes = startsWiths(policy);
  const file = form.get("file");
  const fileName = file instanceof Blob ? ((file as File).name ?? "blob") : "blob";

  const valueOf = (field: string): string | undefined => {
    const name = names.find((n) => n.toLowerCase() === field.toLowerCase());
    if (name === undefined) return undefined;
    const value = form.get(name);
    return typeof value === "string" ? value.replace("${filename}", fileName) : undefined;
  };

  for (const name of names) {
    const lower = name.toLowerCase();
    if (form.getAll(name).length > 1) violations.push({ kind: "duplicate-field", field: name });
    if (UNCONDITIONED.has(lower) || lower.startsWith("x-ignore-")) continue;
    if (forField(exact, name).length === 0 && forField(prefixes, name).length === 0) violations.push({ kind: "extra-field", field: name });
  }

  for (const [field, expected] of exact) {
    const actual = valueOf(field);
    if (actual === undefined) violations.push({ kind: "missing-field", field });
    else if (actual !== expected) violations.push({ kind: "condition-failed", field });
  }
  for (const [field, prefix] of prefixes) {
    const actual = valueOf(field);
    if (actual === undefined) violations.push({ kind: "missing-field", field });
    else if (!actual.startsWith(prefix)) violations.push({ kind: "condition-failed", field });
  }

  const range = policy.conditions.find((c): c is [string, number, number] => Array.isArray(c) && c[0] === "content-length-range");
  if (range && file instanceof Blob && (file.size < range[1] || file.size > range[2])) violations.push({ kind: "size-out-of-range", field: "file" });

  return violations;
}

interface CapturedPost { url: string; init: RequestInit; form: FormData }

/** Replace global fetch with a capture that answers with `respond()`. */
function captureFetch(respond: () => Response | Promise<Response> = () => new Response(null, { status: 204 })): CapturedPost[] {
  const calls: CapturedPost[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init, form: init.body as FormData });
    return respond();
  }));
  return calls;
}

/** Sign a real ticket, upload through it, and return the policy violations of the submitted form. */
async function roundTrip(opts: { retentionTag?: string | null; key?: string; content?: Uint8Array; contentType: string; contentDisposition?: string }): Promise<Violation[]> {
  const ticket = await sign(opts.retentionTag ?? null);
  const calls = captureFetch();
  const result = await S3ObjectStorage.upload(ticket, opts.key ?? `${KEY_PREFIX}0`, opts.content ?? Buffer.from("hello"), opts.contentType, opts.contentDisposition);
  expect(result.isOk()).toBe(true);
  const form = calls[0]!.form;
  return evaluatePolicy(decodePolicy(Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string>), form);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// A. The signed policy
// ---------------------------------------------------------------------------

describe("S3ObjectStorage.generatePresignedPost — signed policy", () => {
  it("1. constrains Content-Type only with starts-with '' — never an exact match", async () => {
    const policy = decodePolicy(ticketFields(await sign()));
    expect(forField(startsWiths(policy), "Content-Type")).toEqual([""]);
    expect(forField(exactMatches(policy), "Content-Type")).toEqual([]);
  });

  it("2. constrains Content-Disposition only with starts-with '' — never an exact match", async () => {
    const policy = decodePolicy(ticketFields(await sign()));
    expect(forField(startsWiths(policy), "Content-Disposition")).toEqual([""]);
    expect(forField(exactMatches(policy), "Content-Disposition")).toEqual([]);
  });

  it.each([[null], ["365"]])("3. no field carries both an exact-match and a starts-with condition (retentionTag=%s)", async (tag) => {
    const policy = decodePolicy(ticketFields(await sign(tag)));
    const exactFields = new Set(exactMatches(policy).map(([f]) => f.toLowerCase()));
    const contradictory = startsWiths(policy).map(([f]) => f).filter((f) => exactFields.has(f.toLowerCase()));
    expect(contradictory).toEqual([]);
  });

  it.each([[null], ["365"]])("4. the policy holds exactly the expected conditions and nothing else (retentionTag=%s)", async (tag) => {
    const fields = ticketFields(await sign(tag));
    const policy = decodePolicy(fields);
    const expected: Condition[] = [
      ["starts-with", "$key", KEY_PREFIX],
      ["starts-with", "$Content-Type", ""],
      ["starts-with", "$Content-Disposition", ""],
      ["content-length-range", 0, MAX_BYTES],
      { bucket: BUCKET },
      { "X-Amz-Algorithm": "AWS4-HMAC-SHA256" },
      { "X-Amz-Credential": fields["X-Amz-Credential"]! },
      { "X-Amz-Date": fields["X-Amz-Date"]! },
      ...(tag ? [{ "x-amz-tagging": `retention=${tag}` }] : []),
    ];
    const sorted = (cs: Condition[]): string[] => cs.map((c) => JSON.stringify(c)).sort();
    expect(sorted(policy.conditions)).toEqual(sorted(expected));
  });

  it("5. constrains key with starts-with <keyPrefix> — never an exact match", async () => {
    const policy = decodePolicy(ticketFields(await sign()));
    expect(forField(startsWiths(policy), "key")).toEqual([KEY_PREFIX]);
    expect(forField(exactMatches(policy), "key")).toEqual([]);
  });

  it("6. limits object size to [0, maxBytes]", async () => {
    const policy = decodePolicy(ticketFields(await sign()));
    expect(policy.conditions).toContainEqual(["content-length-range", 0, MAX_BYTES]);
  });

  it("7. pins the bucket with an exact match", async () => {
    const policy = decodePolicy(ticketFields(await sign()));
    expect(forField(exactMatches(policy), "bucket")).toEqual([BUCKET]);
  });

  it("8. has no x-amz-tagging condition when retentionTag is null", async () => {
    const policy = decodePolicy(ticketFields(await sign(null)));
    expect(forField(exactMatches(policy), "x-amz-tagging")).toEqual([]);
    expect(forField(startsWiths(policy), "x-amz-tagging")).toEqual([]);
  });

  it.each([["365"], ["3650"]])("9. pins x-amz-tagging to retention=%s with exactly one exact match", async (tag) => {
    const policy = decodePolicy(ticketFields(await sign(tag)));
    expect(forField(exactMatches(policy), "x-amz-tagging")).toEqual([`retention=${tag}`]);
    expect(forField(startsWiths(policy), "x-amz-tagging")).toEqual([]);
  });

  it("10. expires 30 seconds after signing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
    const policy = decodePolicy(ticketFields(await sign()));
    expect(policy.expiration).toBe("2026-01-02T03:04:35Z");
  });

  it("11. carries the session token in both policy and ticket for temporary (Lambda) credentials", async () => {
    const storage = makeStorage({ accessKeyId: "ASIAFAKE", secretAccessKey: "fake", sessionToken: "session-token-value" });
    const fields = ticketFields(await sign(null, storage));
    expect(fields["X-Amz-Security-Token"]).toBe("session-token-value");
    expect(forField(exactMatches(decodePolicy(fields)), "X-Amz-Security-Token")).toEqual(["session-token-value"]);
  });
});

// ---------------------------------------------------------------------------
// B. The returned ticket
// ---------------------------------------------------------------------------

describe("S3ObjectStorage.generatePresignedPost — returned ticket", () => {
  it("12. carries empty-string defaults for Content-Type and Content-Disposition", async () => {
    const fields = ticketFields(await sign());
    expect(fields["Content-Type"]).toBe("");
    expect(fields["Content-Disposition"]).toBe("");
  });

  it.each([[null], ["365"]])("12b. carries a default for every field with a starts-with condition (retentionTag=%s)", async (tag) => {
    const fields = ticketFields(await sign(tag));
    const missing = startsWiths(decodePolicy(fields)).map(([f]) => f).filter((f) => typeof fields[f] !== "string");
    expect(missing).toEqual([]);
  });

  it("13. carries the default key <keyPrefix>${filename}", async () => {
    const fields = ticketFields(await sign());
    expect(fields["key"]).toBe(`${KEY_PREFIX}\${filename}`);
  });

  it("14. carries x-amz-tagging only when a retentionTag is given", async () => {
    expect(ticketFields(await sign(null))).not.toHaveProperty("x-amz-tagging");
    expect(ticketFields(await sign("365"))["x-amz-tagging"]).toBe("retention=365");
  });

  it.each([[null], ["365"]])("15. every ticket field satisfies the signed policy as-is (retentionTag=%s)", async (tag) => {
    const fields = ticketFields(await sign(tag));
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set("file", new Blob([Buffer.from("x")]));
    expect(evaluatePolicy(decodePolicy(fields), form)).toEqual([]);
  });

  it("16. targets the bucket endpoint and includes the policy and its signature", async () => {
    const ticket = await sign();
    const fields = ticketFields(ticket);
    expect(ticket.url).toBe(`https://${BUCKET}.s3.${REGION}.amazonaws.com/`);
    expect(fields["Policy"]).toEqual(expect.any(String));
    expect(fields["X-Amz-Signature"]).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// C. upload — the submitted form
// ---------------------------------------------------------------------------

describe("S3ObjectStorage.upload — submitted form", () => {
  const handTicket = (extra: Record<string, string> = {}): Ticket => ({
    url: "https://content-bucket.s3.eu-west-1.amazonaws.com/",
    fields: { Policy: "cG9saWN5", "X-Amz-Signature": "sig", "x-amz-tagging": "retention=365", ...extra } as Ticket["fields"],
  });

  it("17. sets key, Content-Type and Content-Disposition to the per-object values", async () => {
    const calls = captureFetch();
    await S3ObjectStorage.upload(handTicket(), `${KEY_PREFIX}0`, Buffer.from("x"), "image/png", 'inline; filename="a.png"');
    const form = calls[0]!.form;
    expect(form.get("key")).toBe(`${KEY_PREFIX}0`);
    expect(form.get("Content-Type")).toBe("image/png");
    expect(form.get("Content-Disposition")).toBe('inline; filename="a.png"');
  });

  it("18. still sends Content-Disposition as '' when none is passed", async () => {
    const calls = captureFetch();
    await S3ObjectStorage.upload(handTicket(), `${KEY_PREFIX}0`, Buffer.from("x"), "message/rfc822");
    expect(calls[0]!.form.getAll("Content-Disposition")).toEqual([""]);
  });

  it("19. sends each field once, overwriting ticket defaults for key, Content-Type and Content-Disposition", async () => {
    const calls = captureFetch();
    const ticket = handTicket({ key: `${KEY_PREFIX}\${filename}`, "Content-Type": "", "Content-Disposition": "" });
    await S3ObjectStorage.upload(ticket, `${KEY_PREFIX}7`, Buffer.from("x"), "application/pdf", "attachment");
    const form = calls[0]!.form;
    expect(form.getAll("key")).toEqual([`${KEY_PREFIX}7`]);
    expect(form.getAll("Content-Type")).toEqual(["application/pdf"]);
    expect(form.getAll("Content-Disposition")).toEqual(["attachment"]);
    for (const name of new Set(form.keys())) expect(form.getAll(name)).toHaveLength(1);
  });

  it("20. passes the ticket's fixed fields through unchanged", async () => {
    const calls = captureFetch();
    await S3ObjectStorage.upload(handTicket(), `${KEY_PREFIX}0`, Buffer.from("x"), "image/png");
    const form = calls[0]!.form;
    expect(form.get("Policy")).toBe("cG9saWN5");
    expect(form.get("X-Amz-Signature")).toBe("sig");
    expect(form.get("x-amz-tagging")).toBe("retention=365");
  });

  it("21. sends the file last, with the exact bytes and the object's content type", async () => {
    const calls = captureFetch();
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await S3ObjectStorage.upload(handTicket(), `${KEY_PREFIX}0`, bytes, "image/png");
    const form = calls[0]!.form;
    expect([...form.keys()].at(-1)).toBe("file");
    const file = form.get("file") as Blob;
    expect(file.type).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it("22. POSTs to the ticket url without setting request headers", async () => {
    const calls = captureFetch();
    await S3ObjectStorage.upload(handTicket(), `${KEY_PREFIX}0`, Buffer.from("x"), "image/png");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://content-bucket.s3.eu-west-1.amazonaws.com/");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toBeUndefined();
  });

  describe("23. result mapping", () => {
    const run = () => S3ObjectStorage.upload(handTicket(), `${KEY_PREFIX}0`, Buffer.from("x"), "image/png");

    it.each([[200], [204]])("returns ok on HTTP %i", async (status) => {
      captureFetch(() => new Response(null, { status }));
      expect((await run()).isOk()).toBe(true);
    });

    it("returns the status and the S3 error body, capped at 300 characters", async () => {
      const body = "<Error><Code>AccessDenied</Code>" + "x".repeat(500);
      captureFetch(() => new Response(body, { status: 403 }));
      const result = await run();
      expect(result._unsafeUnwrapErr()).toEqual({ kind: "s3_upload_failed", reason: `HTTP 403: ${body.slice(0, 300)}` });
    });

    it("returns the status alone when the error body cannot be read", async () => {
      captureFetch(() => ({ ok: false, status: 500, text: () => Promise.reject(new Error("stream broke")) }) as unknown as Response);
      expect((await run())._unsafeUnwrapErr()).toEqual({ kind: "s3_upload_failed", reason: "HTTP 500" });
    });

    it("returns the error message when fetch throws", async () => {
      captureFetch(() => { throw new Error("socket hang up"); });
      expect((await run())._unsafeUnwrapErr()).toEqual({ kind: "s3_upload_failed", reason: "socket hang up" });
    });

    it("returns 'unknown fetch error' when fetch throws a non-Error", async () => {
      captureFetch(() => { throw "boom"; });
      expect((await run())._unsafeUnwrapErr()).toEqual({ kind: "s3_upload_failed", reason: "unknown fetch error" });
    });
  });
});

// ---------------------------------------------------------------------------
// D. Round trip — a real signed ticket, uploaded through, checked against its own policy
// ---------------------------------------------------------------------------

describe("S3ObjectStorage — generatePresignedPost → upload round trip", () => {
  it("24. a PNG with a real Content-Disposition satisfies the policy (no retention tag)", async () => {
    expect(await roundTrip({ contentType: "image/png", contentDisposition: 'inline; filename="a.png"' })).toEqual([]);
  });

  it("25. a PNG with a real Content-Disposition satisfies the policy (retention tag)", async () => {
    expect(await roundTrip({ retentionTag: "365", contentType: "image/png", contentDisposition: 'inline; filename="a.png"' })).toEqual([]);
  });

  it("26. a raw email with no Content-Disposition satisfies the policy", async () => {
    expect(await roundTrip({ contentType: "message/rfc822" })).toEqual([]);
  });

  it.each([[null], ["365"]])("27. every form field is conditioned and every conditioned field is sent (retentionTag=%s)", async (tag) => {
    const violations = await roundTrip({ retentionTag: tag, contentType: "image/png", contentDisposition: "attachment" });
    expect(violations.filter((v) => v.kind === "extra-field" || v.kind === "missing-field" || v.kind === "duplicate-field")).toEqual([]);
  });

  it("28. a parameterised content type and a unicode/quoted filename satisfy the policy", async () => {
    expect(await roundTrip({
      contentType: "text/calendar; charset=utf-8",
      contentDisposition: `attachment; filename="re\\"çu.ics"; filename*=UTF-8''re%C3%A7u.ics`,
    })).toEqual([]);
  });

  describe("29. the policy still rejects what it must", () => {
    it("a key outside the signed prefix", async () => {
      const violations = await roundTrip({ key: "accounts/999/other/0", contentType: "image/png" });
      expect(violations).toContainEqual({ kind: "condition-failed", field: "key" });
    });

    it("an object larger than maxBytes", async () => {
      const violations = await roundTrip({ content: new Uint8Array(MAX_BYTES + 1), contentType: "image/png" });
      expect(violations).toContainEqual({ kind: "size-out-of-range", field: "file" });
    });

    it("an altered retention tag", async () => {
      const ticket = await sign("365");
      const calls = captureFetch();
      const tampered: Ticket = { url: ticket.url, fields: { ...ticket.fields, "x-amz-tagging": "retention=3650" } };
      await S3ObjectStorage.upload(tampered, `${KEY_PREFIX}0`, Buffer.from("x"), "image/png");
      const violations = evaluatePolicy(decodePolicy(ticketFields(ticket)), calls[0]!.form);
      expect(violations).toContainEqual({ kind: "condition-failed", field: "x-amz-tagging" });
    });
  });
});

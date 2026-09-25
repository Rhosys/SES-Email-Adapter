import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok } from "neverthrow";
import type { Thread, Signal, Alias, InboundEmailSignalData } from "../../src/types/index.js";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import type { AuthService, AccessService } from "../../src/api/app.js";
import type { ThreadDatabase } from "../../src/database/thread-database.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { IncomingEmailProcessor, SYSTEM_RULES } from "../../src/processor/incoming-email-processor.js";
import { JsonLogicRuleEvaluator } from "../../src/processor/rule-evaluator.js";
import { CalendarForwarder } from "../../src/processor/calendar/calendar-forwarder.js";
import { BillingHandler } from "../../src/billing/billing-handler.js";
import { makeProcessingDbMock } from "../processor/_helpers.js";
import { makeHmacGeneratorFake } from "../helpers/hmac-generator-fake.js";
import type { EmailService } from "../../src/email/email-service.js";
import type { ClassificationOutput } from "../../src/classifier/classifier.js";

// cluster-registry must be mocked at module scope (vi.mock is hoisted) so the processor
// resolves a deterministic read cluster without touching real config.
vi.mock("../../src/embedding/cluster-registry.js", () => {
  const entry = Object.freeze({ registryId: "aurora-prod-titan-v2", clusterArn: "arn:x", secretArn: "arn:y", databaseName: "signals", modelId: "amazon.titan-embed-text-v2:0", dimensions: 1024, active: true });
  return { CLUSTER_REGISTRY: [entry], getActiveClusters: () => [entry], getRegistryById: (id: string) => (id === entry.registryId ? entry : null), getPrimaryThreadMatcherRegistry: () => entry };
});

// Thread/account DB doubles covering every method BOTH the quarantine handler and the real
// processor call. Fixed-return stubs (no state) — tests script per-call returns as needed.
function makeThreadDb() {
  return {
    // handler surface
    getSignalById: vi.fn().mockResolvedValue(ok(null)),
    updateSignalStatus: vi.fn().mockImplementation((_a, id, status) => Promise.resolve(ok({ id, status }))),
    unblockSignal: vi.fn().mockResolvedValue(ok(undefined)),
    createThread: vi.fn().mockResolvedValue(ok(undefined)),
    findThreadByGroupingKey: vi.fn().mockResolvedValue(ok(null)),
    listPreThreadSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    // shared
    getThread: vi.fn().mockResolvedValue(ok(null)),
    saveSignal: vi.fn().mockImplementation((s) => Promise.resolve(ok(s))),
    updateThread: vi.fn().mockResolvedValue(ok(makeThread())),
    // processor surface
    getSignalByMessageId: vi.fn().mockResolvedValue(ok(null)),
    updateSignalSendStatus: vi.fn().mockResolvedValue(ok(undefined)),
    listSignals: vi.fn().mockResolvedValue(ok({ items: [] })),
    findSignalByEmailMessageId: vi.fn().mockResolvedValue(ok(null)),
    saveThread: vi.fn().mockResolvedValue(ok(undefined)),
    setThreadTtlFallback: vi.fn().mockResolvedValue(ok(undefined)),
    listActiveThreads: vi.fn().mockResolvedValue(ok([])),
    getLinkedCalendarSignal: vi.fn().mockResolvedValue(ok(null)),
  };
}

function makeAccountDb() {
  return {
    getAccount: vi.fn().mockResolvedValue(ok({ retentionDuration: "P3M", filtering: null, billingPlan: "Paid" as const, onboarding: { completed: true }, createdAt: "2024-01-01T00:00:00Z" })),
    getAliasByGlobalAddress: vi.fn().mockResolvedValue(ok(ALIAS_CONFIG)),
    getAlias: vi.fn().mockResolvedValue(ok(ALIAS_CONFIG)),
    getDomainOwner: vi.fn().mockResolvedValue(ok({ accountId: TEST_ACCOUNT_ID, domain: "example.com", status: "active", receivingSetupComplete: true, senderSetupComplete: true, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z" })),
    getSender: vi.fn().mockResolvedValue(ok(null)),
    saveSender: vi.fn().mockResolvedValue(ok(undefined)),
    saveAlias: vi.fn().mockResolvedValue(ok(ALIAS_CONFIG)),
    ensureAlias: vi.fn().mockResolvedValue(ok({ alias: ALIAS_CONFIG, created: false })),
    listEnabledRules: vi.fn().mockResolvedValue(ok(SYSTEM_RULES)),
    getTemplate: vi.fn().mockResolvedValue(ok(null)),
    getDomainByName: vi.fn().mockResolvedValue(ok(null)),
    listDomains: vi.fn().mockResolvedValue(ok([])),
    listLabels: vi.fn().mockResolvedValue(ok([])),
    updateAccount: vi.fn().mockResolvedValue(ok(undefined)),
    incrementStatMetric: vi.fn().mockResolvedValue(ok(undefined)),
    annotateRuleError: vi.fn().mockResolvedValue(ok(undefined)),
    annotateTemplateError: vi.fn().mockResolvedValue(ok(undefined)),
    upsertSystemRuleOverride: vi.fn().mockResolvedValue(ok(undefined)),
  };
}

// ---------------------------------------------------------------------------
// Quarantine response — the unit under test is the HTTP handler AND the real
// IncomingEmailProcessor wired together (approval delegates to the processor's
// reprocessSignal). Everything the processor touches (DBs, sanitizer, classifier,
// embeddings, Aurora, SES/notifier, content store) is a standard vi.fn() mock —
// no stateful stores. Assertions are on the observable boundary calls the real
// processor makes, so a regression in either the handler or the processor's
// approval path surfaces here.
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acct-test-001";
const A = `/accounts/${TEST_ACCOUNT_ID}`;
const ALIAS = "user@example.com";
const SENDER = "sender@acme.com";
const SENDER_ETLD1 = "acme.com";

const ALIAS_CONFIG: Alias = {
  id: ALIAS, accountId: TEST_ACCOUNT_ID, aliasAddress: ALIAS, domain: "example.com", aliasName: "user",
  unknownSenderPolicy: "quarantine_visible", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
};

const CLASSIFICATION: ClassificationOutput = {
  workflow: "conversation",
  workflowData: { workflow: "conversation", sentiment: "neutral", requiresReply: false },
  tags: [], summary: "A test email.", labels: [], actions: [],
};

function makeAuth(): AuthService {
  return { verify: vi.fn().mockReturnValue(Promise.resolve(ok({ userId: "user-1" }))) };
}
function makeAccess(): AccessService {
  return {
    listUsers: vi.fn().mockResolvedValue(ok([])), getUserProfile: vi.fn().mockResolvedValue(ok({})),
    listAccountsForUser: vi.fn().mockResolvedValue(ok([])), addUser: vi.fn().mockResolvedValue(ok(undefined)),
    updateUserRole: vi.fn().mockResolvedValue(ok(undefined)), removeUser: vi.fn().mockResolvedValue(ok(undefined)),
    checkAccess: vi.fn().mockResolvedValue(undefined), createInvite: vi.fn().mockResolvedValue(ok({ inviteId: "inv" })),
    getLinkedIdentity: vi.fn().mockResolvedValue(ok({ connectionUserId: "g" })),
  } as unknown as AccessService;
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "arc-001", accountId: TEST_ACCOUNT_ID, workflow: "conversation", labels: [], status: "active",
    summary: "A test arc.", lastSignalAt: "2024-01-15T10:00:00Z", createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z", sender: { address: SENDER }, recipientAddress: ALIAS, subject: "Test email",
    ...overrides,
  };
}

function makeQuarantinedSignal(overrides: Partial<Omit<Signal, "data">> & { data?: Partial<InboundEmailSignalData> } = {}): Signal {
  const { data: dataOverrides, ...base } = overrides;
  const id = base.id ?? "SES#msg-primary";
  return {
    id, signalLookupId: id, accountId: TEST_ACCOUNT_ID, source: "email" as const, type: "email",
    status: "quarantine_visible", createdAt: "2024-01-15T10:00:00Z", ...base,
    data: {
      receivedAt: "2024-01-15T10:00:00Z", from: { address: SENDER, name: "Sender" }, to: [{ address: ALIAS }], cc: [],
      subject: "Test email", attachments: [], headers: {}, recipientAddress: ALIAS, workflow: "conversation",
      workflowData: { workflow: "conversation", isReply: false, sentiment: "neutral", requiresReply: false },
      tags: [], summary: "A test signal.", s3Key: `emails/${id}`,
      matchedRules: [{ ruleId: "SR-00", actions: [{ type: "quarantine_visible" }], labelsAdded: [], statusChange: "quarantine_visible", text: `Sender ${SENDER_ETLD1} is not in approved senders` }],
      ...dataOverrides,
    },
  } as Signal;
}

function makeParsedMime(overrides: Record<string, unknown> = {}) {
  return {
    from: { address: SENDER, name: "Sender" }, to: [{ address: ALIAS }], cc: [], subject: "Test email",
    textBody: "Hello", htmlBody: "<p>Hello</p>", attachments: [], headers: { "authentication-results": "spf=pass dkim=pass" },
    sentAt: "2024-01-15T09:00:00Z", ...overrides,
  };
}

async function req(app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, {
    method, headers: { "Content-Type": "application/json", Authorization: "Bearer valid" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
}

describe("Quarantine response — handler + real processor", () => {
  let threadDb: ReturnType<typeof makeThreadDb>;
  let accountDb: ReturnType<typeof makeAccountDb>;
  let processingDb: ReturnType<typeof makeProcessingDbMock>;
  let contentSanitizer: { invoke: ReturnType<typeof vi.fn> };
  let classifier: { classify: ReturnType<typeof vi.fn> };
  let embeddingGenerator: { generateForModel: ReturnType<typeof vi.fn>; generateForSecondaryClusters: ReturnType<typeof vi.fn> };
  let auroraWriter: { upsertEmbedding: ReturnType<typeof vi.fn>; findMatch: ReturnType<typeof vi.fn> };
  let threadMatcher: { findMatch: ReturnType<typeof vi.fn>; upsertEmbedding: ReturnType<typeof vi.fn>; deleteEmbeddingsForThread: ReturnType<typeof vi.fn> };
  let notifier: { notify: ReturnType<typeof vi.fn> };
  let sqsDispatcher: { sendMessage: ReturnType<typeof vi.fn> };
  let contentStore: { getContent: ReturnType<typeof vi.fn>; saveRawEmail: ReturnType<typeof vi.fn>; saveIcsContentAsCalendar: ReturnType<typeof vi.fn>; createReadUrl: ReturnType<typeof vi.fn>; createContentUploadTicket: ReturnType<typeof vi.fn>; getRawEmailUrl: ReturnType<typeof vi.fn> };
  let processor: IncomingEmailProcessor;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    threadDb = makeThreadDb();
    accountDb = makeAccountDb();
    processingDb = makeProcessingDbMock();

    contentSanitizer = { invoke: vi.fn().mockResolvedValue(ok({ success: true as const, parsed: makeParsedMime(), urlMapping: {} })) };
    classifier = { classify: vi.fn().mockResolvedValue(ok({ ...CLASSIFICATION })) };
    embeddingGenerator = {
      generateForModel: vi.fn().mockResolvedValue(ok({ modelId: "amazon.titan-embed-text-v2:0", vector: new Array(1024).fill(0.1), dimensions: 1024 })),
      generateForSecondaryClusters: vi.fn().mockResolvedValue([]),
    };
    auroraWriter = { upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)), findMatch: vi.fn().mockResolvedValue(ok(null)) };
    threadMatcher = { findMatch: vi.fn().mockResolvedValue(ok(null)), upsertEmbedding: vi.fn().mockResolvedValue(ok(undefined)), deleteEmbeddingsForThread: vi.fn().mockResolvedValue(ok(undefined)) };
    notifier = { notify: vi.fn().mockResolvedValue(ok(undefined)) };
    sqsDispatcher = { sendMessage: vi.fn().mockResolvedValue(ok(undefined)) };
    contentStore = {
      getContent: vi.fn().mockResolvedValue(new Uint8Array()), saveRawEmail: vi.fn().mockResolvedValue(undefined),
      saveIcsContentAsCalendar: vi.fn().mockResolvedValue(undefined), createReadUrl: vi.fn().mockResolvedValue("https://signed"),
      createContentUploadTicket: vi.fn().mockResolvedValue({ url: "https://post", fields: {} }), getRawEmailUrl: vi.fn().mockResolvedValue("https://signed"),
    };

    processor = new IncomingEmailProcessor({
      threadDb: threadDb as unknown as ThreadDatabase,
      accountDb: accountDb as unknown as AccountDatabase,
      processingDb,
      resourceDb: { saveResource: async () => ok(undefined) } as never,
      contentSanitizer: contentSanitizer as never,
      userCodeExecutor: { invoke: vi.fn(), validateAst: vi.fn(), validateAstBatch: vi.fn() } as never,
      classifier: classifier as never,
      embeddingGenerator: embeddingGenerator as never,
      auroraWriter: auroraWriter as never,
      threadMatcher: threadMatcher as never,
      ruleEvaluator: new JsonLogicRuleEvaluator(createMockLogger(), { invoke: vi.fn(), validateAst: vi.fn(), validateAstBatch: vi.fn() } as never, { annotateRuleError: vi.fn().mockResolvedValue(ok(undefined)) } as never),
      logger: createMockLogger(),
      notifier: notifier as never,
      forwardingService: { forward: vi.fn().mockResolvedValue(ok(undefined)), sendVerification: vi.fn().mockResolvedValue(ok(undefined)) } as never,
      retentionService: { applyPlanRetention: vi.fn().mockResolvedValue({ s3Key: "retained/test.eml" }) } as never,
      replySender: { sendReply: vi.fn().mockResolvedValue(ok({ messageId: "reply" })) } as never,
      sqsDispatcher: sqsDispatcher as never,
      draftSendDispatcher: { dispatch: async () => ok(undefined) } as never,
      billingHandler: new BillingHandler(),
      handlerRegistry: { dispatch: vi.fn().mockResolvedValue(ok(undefined)) } as never,
      calendarForwarder: new CalendarForwarder({ emailService: { send: vi.fn().mockResolvedValue(ok({ messageId: "cal" })), sendRaw: vi.fn().mockResolvedValue(ok({ messageId: "cal" })) } as unknown as EmailService, serviceDomain: "platform.email.rhosys.cloud", hmac: makeHmacGeneratorFake() }),
      schedulerClient: { createFollowup: vi.fn().mockResolvedValue(ok(undefined)), deleteFollowup: vi.fn().mockResolvedValue(ok(undefined)) } as never,
      emailContentStore: contentStore as never,
      contentStore: contentStore as never,
      accessService: { listUsers: vi.fn().mockResolvedValue(ok([])), getUserProfile: vi.fn().mockResolvedValue(ok({})) },
      platformTenantName: "test-platform",
    });

    app = createApp(makeAppDeps({
      threadDb: threadDb as unknown as ThreadDatabase,
      accountDb: accountDb as unknown as AccountDatabase,
      auth: makeAuth(),
      access: makeAccess(),
      logger: createMockLogger(),
      signalReprocessor: processor,
      contentCdnBaseUrl: "https://cdn.test",
    }));
  });

  afterEach(() => vi.restoreAllMocks());

  // ── BASELINE: reject / dismiss (unchanged behavior, no processor involvement) ──

  it("reject → moves the signal to blocked and records the sender block disposition", async () => {
    vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(makeQuarantinedSignal()));

    const res = await req(app, "POST", `${A}/signals/SES%23msg-primary/quarantineResponse`, { status: "block_reject" });

    expect(res.status).toBe(200);
    expect(threadDb.updateSignalStatus).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "SES#msg-primary", "block_reject");
    expect(accountDb.saveSender).toHaveBeenCalledWith(TEST_ACCOUNT_ID, ALIAS, SENDER_ETLD1, "block_reject");
  });

  it("dismiss → blocks the signal, records no sender opinion", async () => {
    vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(makeQuarantinedSignal()));

    const res = await req(app, "POST", `${A}/signals/SES%23msg-primary/quarantineResponse`, { status: "dismiss" });

    expect(res.status).toBe(200);
    expect(accountDb.saveSender).not.toHaveBeenCalled();
    const saved = vi.mocked(threadDb.saveSignal).mock.calls.map(c => c[0] as Signal);
    expect(saved.some(s => s.status === "block_hidden")).toBe(true);
  });

  // ── ALLOW (approve) — observable outcome of the full approve path ──

  it("approve → the signal ends up active on a thread and the sender allow is recorded", async () => {
    const quarantined = makeQuarantinedSignal();
    // The handler's initial load resolves the quarantined signal via getSignalById.
    vi.mocked(threadDb.getSignalById).mockResolvedValue(ok(quarantined));
    // reprocess reads by message id twice: the entry load sees the still-quarantined signal (no
    // thread), then the post-reprocess re-fetch returns it re-homed and active on a thread.
    vi.mocked(threadDb.getSignalByMessageId)
      .mockResolvedValueOnce(ok(quarantined))
      .mockResolvedValue(ok({ ...quarantined, status: "active", threadId: "arc-001" } as Signal));
    // The handler fetches the landed thread for the response.
    vi.mocked(threadDb.getThread).mockResolvedValue(ok(makeThread({ id: "arc-001" })));

    const res = await req(app, "POST", `${A}/signals/SES%23msg-primary/quarantineResponse`, { status: "active" });

    expect(res.status).toBe(200);
    const body = await res.json() as { thread: { threadId: string }; signal: { status: string } };
    expect(body.signal.status).toBe("active");
    expect(body.thread.threadId).toBeTruthy();
    expect(accountDb.saveSender).toHaveBeenCalledWith(TEST_ACCOUNT_ID, ALIAS, SENDER_ETLD1, "allow");
    // The alias is an ingest invariant — approval records the sender decision, never the alias.
    expect(accountDb.saveAlias).not.toHaveBeenCalled();
  });

  it("approve → returns 404 for an unknown signal", async () => {
    const res = await req(app, "POST", `${A}/signals/nope/quarantineResponse`, { status: "active" });
    expect(res.status).toBe(404);
  });

  it("approve → returns 400 when the signal is already active", async () => {
    vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(makeQuarantinedSignal({ status: "active" })));
    const res = await req(app, "POST", `${A}/signals/SES%23msg-primary/quarantineResponse`, { status: "active" });
    expect(res.status).toBe(400);
  });

  // ── CASCADE — the new behavior layered on top of the validated baseline ──

  describe("cascade to sibling quarantined signals", () => {
    // Wire the processor's reprocess reads so BOTH primary and any sibling replay to completion.
    // getSignalByMessageId keys off the signalLookupId so each reprocess resolves its own signal;
    // getSignalById still backs the handler's initial per-signal load.
    function wireReprocessReads(signals: Signal[]) {
      const byId = new Map(signals.map(s => [s.id, s]));
      vi.mocked(threadDb.getSignalById).mockImplementation((_a, id) => Promise.resolve(ok(byId.get(id) ?? null)));
      vi.mocked(threadDb.getSignalByMessageId).mockImplementation((_a, lookupId) => {
        const s = byId.get(lookupId);
        return Promise.resolve(ok(s ? { ...s, status: "active", threadId: "arc-001" } as Signal : null));
      });
      vi.mocked(threadDb.getThread).mockResolvedValue(ok(makeThread({ id: "arc-001" })));
      // The cascade writes saveSender(allow) before reprocessing; the processor then re-reads
      // getSender during replay and must see the sender as trusted so the signal comes out active
      // (not re-quarantined). Reflect that written disposition for the approved sender's domain.
      vi.mocked(accountDb.getSender).mockImplementation((_a, _alias, senderDomain) =>
        Promise.resolve(ok(senderDomain === SENDER_ETLD1
          ? { accountId: TEST_ACCOUNT_ID, aliasAddress: ALIAS, domain: "example.com", aliasName: "user", senderDomain: SENDER_ETLD1, policy: "allow" as const, addedAt: "2024-01-01T00:00:00Z" }
          : null)));
    }

    it("approve → reprocesses the primary plus every matching quarantine_visible sibling, each with skipNotify", async () => {
      const primary = makeQuarantinedSignal({ id: "SES#msg-primary" });
      const sibA = makeQuarantinedSignal({ id: "SES#msg-sib-a" });
      const sibB = makeQuarantinedSignal({ id: "SES#msg-sib-b" });
      wireReprocessReads([primary, sibA, sibB]);
      vi.mocked(threadDb.listPreThreadSignals).mockResolvedValue(ok({ items: [primary, sibA, sibB] }));

      const res = await req(app, "POST", `${A}/signals/SES%23msg-primary/quarantineResponse`, { status: "active" });

      expect(res.status).toBe(200);
      // The real processor dispatched side-effects for all three, each carrying skipNotify.
      expect(sqsDispatcher.sendMessage).toHaveBeenCalledTimes(3);
      for (const call of sqsDispatcher.sendMessage.mock.calls) {
        expect((call[0] as { skipNotify?: boolean }).skipNotify).toBe(true);
      }
      // Sender allow written exactly once (config keyed by alias+sender, not per signal).
      expect(accountDb.saveSender).toHaveBeenCalledTimes(1);
    });

    it("approve → a sibling reprocess failure does not fail the request and does not halt the cascade", async () => {
      const primary = makeQuarantinedSignal({ id: "SES#msg-primary" });
      const sibA = makeQuarantinedSignal({ id: "SES#msg-sib-a" });
      const sibB = makeQuarantinedSignal({ id: "SES#msg-sib-b" });
      wireReprocessReads([primary, sibA, sibB]);
      vi.mocked(threadDb.listPreThreadSignals).mockResolvedValue(ok({ items: [primary, sibA, sibB] }));
      // Make sibling A's replay blow up inside the processor (S3 fetch throws).
      vi.mocked(contentStore.getContent).mockImplementation((key: string) => {
        if (key.includes("sib-a")) return Promise.reject(new Error("s3 down"));
        return Promise.resolve(new Uint8Array());
      });

      const res = await req(app, "POST", `${A}/signals/SES%23msg-primary/quarantineResponse`, { status: "active" });

      expect(res.status).toBe(200);
      // primary + sibA (failed) + sibB (still attempted) → 3 reprocess attempts, sibB dispatched.
      const dispatchedSignalIds = sqsDispatcher.sendMessage.mock.calls.map(c => (c[0] as { signal: Signal }).signal.signalLookupId);
      expect(dispatchedSignalIds).toContain("SES#msg-sib-b");
    });

    const filterCases = [
      { name: "different alias → skipped", overrides: { data: { recipientAddress: "other@example.com" } }, cascaded: false },
      { name: "different sender domain → skipped", overrides: { data: { from: { address: "x@evil.net" } } }, cascaded: false },
      { name: "quarantine_hidden → skipped", overrides: { status: "quarantine_hidden" as const }, cascaded: false },
      { name: "same alias + same sender → cascaded", overrides: {}, cascaded: true },
    ];

    it.each(filterCases)("approve → sibling filter: $name", async ({ overrides, cascaded }) => {
      const primary = makeQuarantinedSignal({ id: "SES#msg-primary" });
      const candidate = makeQuarantinedSignal({ id: "SES#msg-candidate", ...overrides });
      wireReprocessReads([primary, candidate]);
      vi.mocked(threadDb.listPreThreadSignals).mockResolvedValue(ok({ items: [primary, candidate] }));

      const res = await req(app, "POST", `${A}/signals/SES%23msg-primary/quarantineResponse`, { status: "active" });

      expect(res.status).toBe(200);
      const dispatchedIds = sqsDispatcher.sendMessage.mock.calls.map(c => (c[0] as { signal: Signal }).signal.signalLookupId);
      expect(dispatchedIds.includes("SES#msg-candidate")).toBe(cascaded);
    });

    it("reject → blocks the primary + matching siblings, saves the sender disposition once, no reprocess", async () => {
      const primary = makeQuarantinedSignal({ id: "SES#msg-primary" });
      const sibA = makeQuarantinedSignal({ id: "SES#msg-sib-a" });
      vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(primary));
      vi.mocked(threadDb.listPreThreadSignals).mockResolvedValue(ok({ items: [primary, sibA] }));

      const res = await req(app, "POST", `${A}/signals/SES%23msg-primary/quarantineResponse`, { status: "block_reject" });

      expect(res.status).toBe(200);
      expect(sqsDispatcher.sendMessage).not.toHaveBeenCalled();
      expect(accountDb.saveSender).toHaveBeenCalledTimes(1);
      const blockedIds = threadDb.updateSignalStatus.mock.calls.map(c => c[1]);
      expect(blockedIds).toContain("SES#msg-primary");
      expect(blockedIds).toContain("SES#msg-sib-a");
    });

    it("dismiss → dismisses the primary + matching siblings, no sender disposition, no reprocess", async () => {
      const primary = makeQuarantinedSignal({ id: "SES#msg-primary" });
      const sibA = makeQuarantinedSignal({ id: "SES#msg-sib-a" });
      vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(primary));
      vi.mocked(threadDb.listPreThreadSignals).mockResolvedValue(ok({ items: [primary, sibA] }));

      const res = await req(app, "POST", `${A}/signals/SES%23msg-primary/quarantineResponse`, { status: "dismiss" });

      expect(res.status).toBe(200);
      expect(sqsDispatcher.sendMessage).not.toHaveBeenCalled();
      expect(accountDb.saveSender).not.toHaveBeenCalled();
      const dismissed = threadDb.saveSignal.mock.calls.map(c => c[0] as Signal).filter(s => s.status === "block_hidden");
      expect(dismissed.length).toBe(2);
    });
  });
});

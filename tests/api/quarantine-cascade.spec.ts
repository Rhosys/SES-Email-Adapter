import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err } from "neverthrow";
import type { Thread, Signal, Alias, InboundEmailSignalData } from "../../src/types/index.js";
import { createApp } from "../../src/api/app.js";
import { makeAppDeps } from "../helpers/app-deps.js";
import type { AuthService, AccessService } from "../../src/api/app.js";
import type { ThreadDatabase } from "../../src/database/thread-database.js";
import type { AccountDatabase } from "../../src/database/account-database.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import type { MockLogger } from "../helpers/mock-logger.js";
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

function codes(logger: MockLogger, method?: string): unknown[] {
  return logger.calls.filter(c => !method || c.method === method).map(c => c.context?.code);
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
  let apiLogger: MockLogger;
  let processorLogger: MockLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    threadDb = makeThreadDb();
    accountDb = makeAccountDb();
    processingDb = makeProcessingDbMock();
    apiLogger = createMockLogger();
    processorLogger = createMockLogger();

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
      logger: processorLogger,
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
      logger: apiLogger,
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

  // ── EDGE CASES — stateful store so assertions see what the REAL processor wrote ──

  describe("edge cases", () => {
    // A tiny in-memory signal/thread store behind the vi.fn() doubles. Unlike wireReprocessReads,
    // getSignalByMessageId returns whatever the processor actually saved, so a replay that
    // re-quarantines or blocks the signal is visible to the handler exactly as in production.
    function wireStore(signals: Signal[]) {
      const store = new Map<string, Signal>(signals.map(sg => [sg.signalLookupId, sg]));
      const threads = new Map<string, Thread>();
      const isQuarantine = (sg: Signal) => sg.status === "quarantine_visible" || sg.status === "quarantine_hidden";
      vi.mocked(threadDb.getSignalById).mockImplementation((_a, id, partition) => {
        const found = [...store.values()].find(sg => sg.id === id && (
          partition === "QUARANTINED" ? !sg.threadId && isQuarantine(sg)
            : partition === "BLOCKED" ? !sg.threadId && !isQuarantine(sg)
              : sg.threadId === partition));
        return Promise.resolve(ok(found ?? null));
      });
      vi.mocked(threadDb.saveSignal).mockImplementation((sg: Signal) => { store.set(sg.signalLookupId, sg); return Promise.resolve(ok(undefined)); });
      vi.mocked(threadDb.getSignalByMessageId).mockImplementation((_a, lookupId) => Promise.resolve(ok(store.get(lookupId) ?? null)));
      vi.mocked(threadDb.listPreThreadSignals).mockImplementation(() => Promise.resolve(ok({ items: [...store.values()].filter(sg => !sg.threadId && isQuarantine(sg)) })));
      vi.mocked(threadDb.saveThread).mockImplementation((t: Thread) => { threads.set(t.id, t); return Promise.resolve(ok(undefined)); });
      vi.mocked(threadDb.getThread).mockImplementation((_a, id) => Promise.resolve(ok(threads.get(id) ?? null)));
      return { store, threads };
    }

    const post = (status: string, id = "SES%23msg-primary") => req(app, "POST", `${A}/signals/${id}/quarantineResponse`, { status });

    // ── approve: the replay must honor the user's decision over rules / policy ──

    const overrideCases: Array<{ name: string; classification: ClassificationOutput; extraRules?: unknown[] }> = [
      {
        name: "SR-02 onboarding-with-action (quarantine_visible)",
        classification: { workflow: "onboarding", workflowData: { workflow: "onboarding", onboardingType: "verification", service: "acme" }, tags: [], summary: "Verify", labels: [], actions: [{ url: "https://acme.com/verify", text: "Verify" }] } as unknown as ClassificationOutput,
      },
      {
        name: "SR-03 onboarding (quarantine_hidden)",
        classification: { workflow: "onboarding", workflowData: { workflow: "onboarding", onboardingType: "welcome", service: "acme" }, tags: [], summary: "Welcome", labels: [], actions: [] } as unknown as ClassificationOutput,
      },
      {
        name: "SR-05 security alert (quarantine_hidden)",
        classification: { workflow: "auth", workflowData: { workflow: "auth", authType: "security_alert", service: "acme" }, tags: [], summary: "Alert", labels: [], actions: [] } as ClassificationOutput,
      },
      {
        name: "SR-04 notice (block_hidden) after a reclassification",
        classification: { workflow: "notice", workflowData: { workflow: "notice", noticeType: "other", provider: "acme" }, tags: [], summary: "Notice", labels: [], actions: [] } as unknown as ClassificationOutput,
      },
      {
        name: "a user quarantine rule",
        classification: CLASSIFICATION,
        extraRules: [{ id: "user-q", accountId: TEST_ACCOUNT_ID, name: "Quarantine everything", condition: JSON.stringify(true), actions: [{ type: "quarantine_visible" }], status: "enabled", priorityOrder: 5000, createdAt: "", updatedAt: "" }],
      },
    ];

    it.each(overrideCases)("approve → lands on a thread despite $name", async ({ classification, extraRules }) => {
      const { store, threads } = wireStore([makeQuarantinedSignal()]);
      classifier.classify.mockResolvedValue(ok(classification));
      if (extraRules) accountDb.listEnabledRules.mockResolvedValue(ok([...SYSTEM_RULES, ...extraRules]));

      const res = await post("active");

      expect(res.status).toBe(200);
      const saved = store.get("SES#msg-primary")!;
      expect(saved.threadId).toBeTruthy();
      expect(threads.has(saved.threadId!)).toBe(true);
      const body = await res.json() as { thread: { threadId: string }; signal: { signalId: string; status: string } };
      expect(body.thread.threadId).toBe(saved.threadId);
      expect(body.signal.signalId).toBe("SES#msg-primary");
      expect(codes(processorLogger)).toContain("processor.user_approved_override");
    });

    it("approve → lands on a thread even when the sender allow is not yet readable (stale getSender)", async () => {
      const { store } = wireStore([makeQuarantinedSignal()]);
      // Default getSender mock returns null: the replay sees an unknown sender under a quarantine policy.
      const res = await post("active");
      expect(res.status).toBe(200);
      expect(store.get("SES#msg-primary")!.threadId).toBeTruthy();
    });

    it("approve → the signal id survives the replay (reprocess in place, no duplicate id)", async () => {
      const { store } = wireStore([makeQuarantinedSignal({ id: "SES#msg-primary" })]);
      await post("active");
      expect(store.size).toBe(1);
      expect(store.get("SES#msg-primary")!.id).toBe("SES#msg-primary");
    });

    it("approve → a quarantine_hidden primary can be approved", async () => {
      const { store } = wireStore([makeQuarantinedSignal({ status: "quarantine_hidden" })]);
      const res = await post("active");
      expect(res.status).toBe(200);
      expect(store.get("SES#msg-primary")!.threadId).toBeTruthy();
    });

    it("approve → never touches the QUARANTINED pseudo-thread (no embedding delete, TTL write, list or recency repair)", async () => {
      wireStore([makeQuarantinedSignal()]);
      await post("active");
      expect(threadMatcher.deleteEmbeddingsForThread).not.toHaveBeenCalled();
      expect(threadDb.setThreadTtlFallback).not.toHaveBeenCalled();
      expect(threadDb.listSignals.mock.calls.some(c => c[1] === "QUARANTINED")).toBe(false);
      expect(threadDb.getThread.mock.calls.some(c => c[1] === "QUARANTINED")).toBe(false);
    });

    it("approve → a quarantined signal found only via the BLOCKED lookup is still approved onto a thread", async () => {
      const blocked = makeQuarantinedSignal();
      const { store } = wireStore([blocked]);
      vi.mocked(threadDb.getSignalById).mockImplementation((_a, id, partition) =>
        Promise.resolve(ok(partition === "BLOCKED" && id === blocked.id ? blocked : null)));

      const res = await post("active");

      expect(res.status).toBe(200);
      expect(threadDb.getSignalById.mock.calls.map(c => c[2])).toEqual(["QUARANTINED", "BLOCKED"]);
      expect(store.get(blocked.signalLookupId)!.threadId).toBeTruthy();
    });

    it("approve → 500 and no replay when saving the sender approval fails", async () => {
      wireStore([makeQuarantinedSignal()]);
      accountDb.saveSender.mockResolvedValueOnce(err(new Error("ddb down")) as never);
      const res = await post("active");
      expect(res.status).toBe(500);
      expect(contentSanitizer.invoke).not.toHaveBeenCalled();
      expect(codes(apiLogger, "error")).toContain("api.quarantine_response.save_sender_failed");
    });

    it("approve → 500 when the primary replay fails, and siblings are not touched", async () => {
      wireStore([makeQuarantinedSignal({ id: "SES#msg-primary" }), makeQuarantinedSignal({ id: "SES#msg-sib-a" })]);
      contentSanitizer.invoke.mockResolvedValue(err({ kind: "invalid_response", message: "sanitizer down" }) as never);
      const res = await post("active");
      expect(res.status).toBe(500);
      expect(contentSanitizer.invoke).toHaveBeenCalledTimes(1);
      expect(threadDb.listPreThreadSignals).not.toHaveBeenCalled();
      expect(codes(apiLogger, "error")).toContain("api.quarantine_response.reprocess_primary_failed");
    });

    it("approve → 500 when the primary's stored record has no s3Key", async () => {
      wireStore([makeQuarantinedSignal({ data: { s3Key: "" } })]);
      const res = await post("active");
      expect(res.status).toBe(500);
      expect(codes(apiLogger, "error")).toContain("api.quarantine_response.reprocess_primary_failed");
    });

    it("approve → 500 when the landed thread cannot be loaded (error or missing)", async () => {
      wireStore([makeQuarantinedSignal()]);
      vi.mocked(threadDb.getThread).mockResolvedValue(err(new Error("ddb down")) as never);
      expect((await post("active")).status).toBe(500);

      wireStore([makeQuarantinedSignal()]);
      vi.mocked(threadDb.getThread).mockResolvedValue(ok(null));
      expect((await post("active")).status).toBe(500);
      expect(codes(apiLogger, "error").filter(c => c === "api.quarantine_response.get_thread_failed").length).toBe(2);
    });

    it("approve → 500 (not a silent success) when the reprocessor returns a signal with no thread", async () => {
      const stubApp = createApp(makeAppDeps({
        threadDb: threadDb as unknown as ThreadDatabase, accountDb: accountDb as unknown as AccountDatabase,
        auth: makeAuth(), access: makeAccess(), logger: apiLogger, contentCdnBaseUrl: "https://cdn.test",
        signalReprocessor: { reprocessSignal: vi.fn().mockResolvedValue(ok(makeQuarantinedSignal())) },
      }));
      vi.mocked(threadDb.getSignalById).mockResolvedValue(ok(makeQuarantinedSignal()));
      const res = await req(stubApp, "POST", `${A}/signals/SES%23msg-primary/quarantineResponse`, { status: "active" });
      expect(res.status).toBe(500);
      expect(codes(apiLogger, "error")).toContain("api.quarantine_response.reprocess_no_thread");
    });

    // ── approve: sibling enumeration ──

    it("approve → a sibling list failure still approves the primary and is logged", async () => {
      const { store } = wireStore([makeQuarantinedSignal({ id: "SES#msg-primary" }), makeQuarantinedSignal({ id: "SES#msg-sib-a" })]);
      vi.mocked(threadDb.listPreThreadSignals).mockResolvedValue(err(new Error("ddb down")) as never);
      const res = await post("active");
      expect(res.status).toBe(200);
      expect(store.get("SES#msg-primary")!.threadId).toBeTruthy();
      expect(store.get("SES#msg-sib-a")!.threadId).toBeFalsy();
      expect(codes(apiLogger, "warn")).toContain("api.quarantine_response.sibling_list_failed");
    });

    it("approve → walks every page of the quarantine partition, not just the first", async () => {
      const primary = makeQuarantinedSignal({ id: "SES#msg-primary" });
      const other = makeQuarantinedSignal({ id: "SES#msg-other", data: { from: { address: "x@other.net" } } });
      const oldSibling = makeQuarantinedSignal({ id: "SES#msg-old-sib" });
      const { store } = wireStore([primary, other, oldSibling]);
      vi.mocked(threadDb.listPreThreadSignals)
        .mockResolvedValueOnce(ok({ items: [other], nextCursor: "page-2" }))
        .mockResolvedValueOnce(ok({ items: [oldSibling] }));

      const res = await post("active");

      expect(res.status).toBe(200);
      expect(threadDb.listPreThreadSignals.mock.calls[1]![2]).toMatchObject({ cursor: "page-2" });
      expect(store.get("SES#msg-old-sib")!.threadId).toBeTruthy();
      expect(store.get("SES#msg-other")!.threadId).toBeFalsy();
    });

    it("approve → stops at the page cap and logs the truncation", async () => {
      wireStore([makeQuarantinedSignal()]);
      vi.mocked(threadDb.listPreThreadSignals).mockResolvedValue(ok({ items: [], nextCursor: "more" }));
      const res = await post("active");
      expect(res.status).toBe(200);
      expect(threadDb.listPreThreadSignals).toHaveBeenCalledTimes(20);
      expect(codes(apiLogger, "warn")).toContain("api.quarantine_response.sibling_list_truncated");
    });

    it("approve → a sender subdomain shares the eTLD+1 and is cascaded", async () => {
      const { store } = wireStore([makeQuarantinedSignal({ id: "SES#msg-primary" }), makeQuarantinedSignal({ id: "SES#msg-sub", data: { from: { address: "noreply@mail.acme.com" } } })]);
      await post("active");
      expect(store.get("SES#msg-sub")!.threadId).toBeTruthy();
    });

    it("approve → the primary is replayed exactly once even though it is listed in its own partition", async () => {
      wireStore([makeQuarantinedSignal({ id: "SES#msg-primary" })]);
      vi.mocked(threadDb.listPreThreadSignals).mockResolvedValue(ok({ items: [makeQuarantinedSignal({ id: "SES#msg-primary" })] }));
      await post("active");
      expect(contentSanitizer.invoke).toHaveBeenCalledTimes(1);
    });

    it("approve → a sibling replay that lands nowhere is logged, not swallowed", async () => {
      const reprocessSignal = vi.fn()
        .mockResolvedValueOnce(ok({ ...makeQuarantinedSignal(), status: "active", threadId: "arc-001" }))
        .mockResolvedValueOnce(ok(makeQuarantinedSignal({ id: "SES#msg-sib-a" })));
      const stubApp = createApp(makeAppDeps({
        threadDb: threadDb as unknown as ThreadDatabase, accountDb: accountDb as unknown as AccountDatabase,
        auth: makeAuth(), access: makeAccess(), logger: apiLogger, contentCdnBaseUrl: "https://cdn.test",
        signalReprocessor: { reprocessSignal },
      }));
      vi.mocked(threadDb.getSignalById).mockResolvedValue(ok(makeQuarantinedSignal()));
      vi.mocked(threadDb.listPreThreadSignals).mockResolvedValue(ok({ items: [makeQuarantinedSignal({ id: "SES#msg-sib-a" })] }));
      vi.mocked(threadDb.getThread).mockResolvedValue(ok(makeThread()));

      const res = await req(stubApp, "POST", `${A}/signals/SES%23msg-primary/quarantineResponse`, { status: "active" });

      expect(res.status).toBe(200);
      expect(reprocessSignal).toHaveBeenNthCalledWith(1, TEST_ACCOUNT_ID, "SES#msg-primary", { skipNotify: true, userApproved: true });
      expect(reprocessSignal).toHaveBeenNthCalledWith(2, TEST_ACCOUNT_ID, "SES#msg-sib-a", { skipNotify: true, userApproved: true });
      expect(codes(apiLogger, "warn")).toContain("api.quarantine_response.reprocess_sibling_no_thread");
    });

    // ── reject / block ──

    it.each(["block_hidden", "block_reject", "report_violation"] as const)("%s → blocks the primary and records that disposition", async (status) => {
      vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(makeQuarantinedSignal()));
      const res = await post(status);
      expect(res.status).toBe(200);
      expect(threadDb.updateSignalStatus).toHaveBeenCalledWith(TEST_ACCOUNT_ID, "SES#msg-primary", status);
      expect(accountDb.saveSender).toHaveBeenCalledWith(TEST_ACCOUNT_ID, ALIAS, SENDER_ETLD1, status);
    });

    it("reject → 500 and no sender disposition when blocking the primary fails", async () => {
      vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(makeQuarantinedSignal()));
      vi.mocked(threadDb.updateSignalStatus).mockResolvedValueOnce(err(new Error("ddb down")) as never);
      const res = await post("block_reject");
      expect(res.status).toBe(500);
      expect(accountDb.saveSender).not.toHaveBeenCalled();
      expect(codes(apiLogger, "error")).toContain("api.quarantine_response.block_failed");
    });

    it("reject → 500 and no sibling cascade when saving the sender disposition fails", async () => {
      vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(makeQuarantinedSignal()));
      accountDb.saveSender.mockResolvedValueOnce(err(new Error("ddb down")) as never);
      const res = await post("block_reject");
      expect(res.status).toBe(500);
      expect(threadDb.listPreThreadSignals).not.toHaveBeenCalled();
    });

    it("reject → a sibling block failure is logged and the cascade continues", async () => {
      vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(makeQuarantinedSignal()));
      vi.mocked(threadDb.listPreThreadSignals).mockResolvedValue(ok({ items: [makeQuarantinedSignal({ id: "SES#msg-sib-a" }), makeQuarantinedSignal({ id: "SES#msg-sib-b" })] }));
      vi.mocked(threadDb.updateSignalStatus)
        .mockImplementationOnce((_a, id, st) => Promise.resolve(ok({ id, status: st } as never)))
        .mockResolvedValueOnce(err(new Error("ddb down")) as never);
      const res = await post("block_reject");
      expect(res.status).toBe(200);
      expect(threadDb.updateSignalStatus.mock.calls.map(c => c[1])).toEqual(["SES#msg-primary", "SES#msg-sib-a", "SES#msg-sib-b"]);
      expect(codes(apiLogger, "warn")).toContain("api.quarantine_response.sibling_block_failed");
    });

    // ── dismiss ──

    it("dismiss → 500 when saving the primary fails, and no sibling is dismissed", async () => {
      vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(makeQuarantinedSignal()));
      vi.mocked(threadDb.saveSignal).mockResolvedValueOnce(err(new Error("ddb down")) as never);
      const res = await post("dismiss");
      expect(res.status).toBe(500);
      expect(threadDb.listPreThreadSignals).not.toHaveBeenCalled();
    });

    it("dismiss → a sibling save failure is logged and the cascade continues", async () => {
      vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(makeQuarantinedSignal()));
      vi.mocked(threadDb.listPreThreadSignals).mockResolvedValue(ok({ items: [makeQuarantinedSignal({ id: "SES#msg-sib-a" }), makeQuarantinedSignal({ id: "SES#msg-sib-b" })] }));
      vi.mocked(threadDb.saveSignal)
        .mockResolvedValueOnce(ok(undefined) as never)
        .mockResolvedValueOnce(err(new Error("ddb down")) as never)
        .mockResolvedValueOnce(ok(undefined) as never);
      const res = await post("dismiss");
      expect(res.status).toBe(200);
      expect(threadDb.saveSignal).toHaveBeenCalledTimes(3);
      expect(codes(apiLogger, "warn")).toContain("api.quarantine_response.sibling_dismiss_failed");
    });

    it("dismiss → folds the original SR-00 reason into the dismiss trace; without one, uses the plain text", async () => {
      vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(makeQuarantinedSignal()));
      const body = await (await post("dismiss")).json() as Signal;
      expect(body.status).toBe("block_hidden");
      expect(body.data.matchedRules!.at(-1)!.text).toBe(`Sender ${SENDER_ETLD1} is not in approved senders — dismissed by user from quarantine`);

      vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(makeQuarantinedSignal({ data: { matchedRules: [] } })));
      const bare = await (await post("dismiss")).json() as Signal;
      expect(bare.data.matchedRules!.at(-1)!.text).toBe("Dismissed by user from quarantine");
    });

    // ── request validation / lookup ──

    it("500 when the QUARANTINED lookup errors; 500 when the BLOCKED fallback lookup errors", async () => {
      vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(err(new Error("ddb down")) as never);
      expect((await post("active")).status).toBe(500);

      vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(null)).mockResolvedValueOnce(err(new Error("ddb down")) as never);
      expect((await post("active")).status).toBe(500);
      expect(codes(apiLogger, "error").filter(c => c === "api.quarantine_response.get_signal_failed").length).toBe(2);
    });

    it.each(["active", "block_hidden", "block_reject", "dismiss"] as const)("400 when a %s decision targets a non-quarantined signal", async (status) => {
      vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(null)).mockResolvedValueOnce(ok(makeQuarantinedSignal({ status: "block_hidden" })));
      const res = await post(status);
      expect(res.status).toBe(400);
      expect(accountDb.saveSender).not.toHaveBeenCalled();
    });

    it("400 when the quarantined signal is not an email signal", async () => {
      vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok({ ...makeQuarantinedSignal(), type: "calendar_event" } as unknown as Signal));
      const res = await post("active");
      expect(res.status).toBe(400);
      expect(accountDb.saveSender).not.toHaveBeenCalled();
    });

    it("400 when the quarantined email signal carries outbound (non-inbound) data", async () => {
      const q = makeQuarantinedSignal();
      const { workflow: _w, ...outboundData } = q.data as InboundEmailSignalData;
      vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok({ ...q, data: outboundData } as unknown as Signal));
      const res = await post("active");
      expect(res.status).toBe(400);
    });

    it("400 for an unknown decision status, with no writes", async () => {
      vi.mocked(threadDb.getSignalById).mockResolvedValueOnce(ok(makeQuarantinedSignal()));
      const res = await post("approve_everything");
      expect(res.status).toBe(400);
      expect(accountDb.saveSender).not.toHaveBeenCalled();
      expect(threadDb.saveSignal).not.toHaveBeenCalled();
    });
  });

  // ── Processor reprocess — userApproved is scoped to the approval path ──

  describe("reprocessSignal without userApproved", () => {
    it("still honors a quarantine rule (the override is opt-in)", async () => {
      const q = makeQuarantinedSignal();
      const store = new Map<string, Signal>([[q.signalLookupId, q]]);
      vi.mocked(threadDb.getSignalById).mockResolvedValue(ok(q));
      vi.mocked(threadDb.saveSignal).mockImplementation((sg: Signal) => { store.set(sg.signalLookupId, sg); return Promise.resolve(ok(undefined)); });
      vi.mocked(threadDb.getSignalByMessageId).mockImplementation((_a, id) => Promise.resolve(ok(store.get(id) ?? null)));
      classifier.classify.mockResolvedValue(ok({ workflow: "onboarding", workflowData: { workflow: "onboarding", onboardingType: "welcome", service: "acme" }, tags: [], summary: "", labels: [], actions: [] }));

      const result = await processor.reprocessSignal(TEST_ACCOUNT_ID, q.signalLookupId);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().status).toBe("quarantine_hidden");
      expect(result._unsafeUnwrap().threadId).toBeNull();
    });

    it("logs (does not drop) a source-thread list failure before reprocess", async () => {
      vi.mocked(threadDb.getSignalById).mockResolvedValue(ok({ ...makeQuarantinedSignal(), status: "active", threadId: "arc-001" } as Signal));
      vi.mocked(threadDb.listSignals).mockResolvedValue(err(new Error("ddb down")) as never);
      vi.mocked(threadDb.getSignalByMessageId).mockResolvedValue(ok({ ...makeQuarantinedSignal(), status: "active", threadId: "arc-001" } as Signal));

      await processor.reprocessSignal(TEST_ACCOUNT_ID, "SES#msg-primary");

      expect(codes(processorLogger, "warn")).toContain("processor.reprocess.pre_list_failed");
    });
  });
});

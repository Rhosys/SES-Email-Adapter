import { describe, it, expect } from "vitest";
import {
  TAG_PREFIX,
  TAG_TYPE,
  TAG_ACCOUNT_ID,
  TAG_SIGNAL_ID,
  TAG_THREAD_ID,
  buildOutboundTags,
  type OutboundType,
  type TagContext,
} from "../../src/email/ses-tags.js";

describe("ses-tags", () => {
  describe("TAG_PREFIX constant", () => {
    it("equals 'X-Numaeel-'", () => {
      expect(TAG_PREFIX).toBe("X-Numaeel-");
    });
  });

  describe("buildOutboundTags", () => {
    it.each([
      {
        label: "reply with no context → only Type tag",
        type: "reply" as OutboundType,
        context: undefined,
        expected: [{ Name: TAG_TYPE, Value: "reply" }],
      },
      {
        label: "forward with accountId → Type + AccountId",
        type: "forward" as OutboundType,
        context: { accountId: "acc-1" },
        expected: [
          { Name: TAG_TYPE, Value: "forward" },
          { Name: TAG_ACCOUNT_ID, Value: "acc-1" },
        ],
      },
      {
        label: "reply with all three IDs → four tags",
        type: "reply" as OutboundType,
        context: { accountId: "a", signalId: "s", threadId: "r" },
        expected: [
          { Name: TAG_TYPE, Value: "reply" },
          { Name: TAG_ACCOUNT_ID, Value: "a" },
          { Name: TAG_SIGNAL_ID, Value: "s" },
          { Name: TAG_THREAD_ID, Value: "r" },
        ],
      },
      {
        label: "empty signalId → SignalId tag absent",
        type: "reply" as OutboundType,
        context: { signalId: "" },
        expected: [{ Name: TAG_TYPE, Value: "reply" }],
      },
      {
        label: "undefined threadId → ThreadId tag absent",
        type: "reply" as OutboundType,
        context: {} as TagContext,
        expected: [{ Name: TAG_TYPE, Value: "reply" }],
      },
    ])("$label", ({ type, context, expected }) => {
      expect(buildOutboundTags(type, context)).toEqual(expected);
    });
  });

  describe("Property 1: every tag name starts with TAG_PREFIX", () => {
    const types: OutboundType[] = ["reply", "forward", "draft-send"];
    const contexts: Array<{ label: string; ctx: TagContext | undefined }> = [
      { label: "no context", ctx: undefined },
      { label: "all IDs present", ctx: { accountId: "a", signalId: "s", threadId: "r" } },
      { label: "only accountId", ctx: { accountId: "x" } },
    ];

    it.each(
      types.flatMap((type) =>
        contexts.map(({ label, ctx }) => ({
          label: `${type} × ${label}`,
          type,
          ctx,
        })),
      ),
    )("$label", ({ type, ctx }) => {
      const tags = buildOutboundTags(type, ctx);
      for (const tag of tags) {
        expect(tag.Name).toMatch(new RegExp(`^${TAG_PREFIX}`));
      }
    });
  });

  describe("Property 2: non-empty IDs produce corresponding tags", () => {
    it.each([
      { label: "accountId present → TAG_ACCOUNT_ID tag", field: "accountId" as const, tagName: TAG_ACCOUNT_ID, value: "acc-123" },
      { label: "signalId present → TAG_SIGNAL_ID tag", field: "signalId" as const, tagName: TAG_SIGNAL_ID, value: "sig-456" },
      { label: "threadId present → TAG_THREAD_ID tag", field: "threadId" as const, tagName: TAG_THREAD_ID, value: "arc-789" },
    ])("$label", ({ field, tagName, value }) => {
      const context: TagContext = { [field]: value };
      const tags = buildOutboundTags("reply", context);
      const match = tags.find((t) => t.Name === tagName);
      expect(match).toBeDefined();
      expect(match!.Value).toBe(value);
    });
  });

  describe("Property 3: empty/undefined IDs omit tags", () => {
    it.each([
      { label: "accountId empty → TAG_ACCOUNT_ID absent", field: "accountId" as const, tagName: TAG_ACCOUNT_ID, value: "" as string | undefined },
      { label: "accountId undefined → TAG_ACCOUNT_ID absent", field: "accountId" as const, tagName: TAG_ACCOUNT_ID, value: undefined as string | undefined },
      { label: "signalId empty → TAG_SIGNAL_ID absent", field: "signalId" as const, tagName: TAG_SIGNAL_ID, value: "" as string | undefined },
      { label: "signalId undefined → TAG_SIGNAL_ID absent", field: "signalId" as const, tagName: TAG_SIGNAL_ID, value: undefined as string | undefined },
      { label: "threadId empty → TAG_THREAD_ID absent", field: "threadId" as const, tagName: TAG_THREAD_ID, value: "" as string | undefined },
      { label: "threadId undefined → TAG_THREAD_ID absent", field: "threadId" as const, tagName: TAG_THREAD_ID, value: undefined as string | undefined },
    ])("$label", ({ field, tagName, value }) => {
      const context = value === undefined ? {} : { [field]: value };
      const tags = buildOutboundTags("reply", context);
      const match = tags.find((t) => t.Name === tagName);
      expect(match).toBeUndefined();
    });
  });
});

import { describe, it, expect } from "vitest"
import {
  sanitizeTagName,
  sanitizeTagValue,
  buildEmailTags,
  type EmailTagSet,
} from "../../src/email/tag-sanitizer.js"

describe("tag-sanitizer", () => {
  describe("sanitizeTagValue", () => {
    it.each([
      { label: "alphanumeric + hyphens + underscores pass through", input: "abc-123_XYZ", expected: "abc-123_XYZ" },
      { label: "dots, spaces, and special chars stripped", input: "hello.world foo@bar!", expected: "helloworldfoobar" },
      { label: "empty string stays empty", input: "", expected: "" },
      { label: "truncates to 255 after stripping", input: "a".repeat(300), expected: "a".repeat(255) },
    ])("$label", ({ input, expected }) => {
      expect(sanitizeTagValue(input)).toBe(expected)
    })
  })

  describe("sanitizeTagName", () => {
    it.each([
      { label: "hyphens and letters preserved", input: "X-Numaeel-AccountId", expected: "X-Numaeel-AccountId" },
      { label: "colons and slashes stripped", input: "ns:tag/name", expected: "nstagname" },
      { label: "truncates to 255", input: "N".repeat(300), expected: "N".repeat(255) },
    ])("$label", ({ input, expected }) => {
      expect(sanitizeTagName(input)).toBe(expected)
    })
  })

  describe("buildEmailTags", () => {
    const input: EmailTagSet = {
      accountId: "acct_abc123",
      fullDate: "2026-06-21",
      invocationId: "inv-789",
      triggerId: "digest-acct_abc123-2026-06-21",
    }

    it("returns four tags with sanitized names", () => {
      const tags = buildEmailTags(input)
      expect(tags.map((t) => t.Name)).toEqual([
        "X-Numaeel-AccountId",
        "X-Numaeel-FullDate",
        "X-Numaeel-InvocationId",
        "X-Numaeel-TriggerId",
      ])
    })

    it("sanitizes values — strips chars outside [a-zA-Z0-9_-]", () => {
      const tags = buildEmailTags({ ...input, accountId: "acct_abc@123" })
      const tag = tags.find((t) => t.Name === "X-Numaeel-AccountId")
      expect(tag!.Value).toBe("acct_abc123")
    })

    it("preserves hyphens in values", () => {
      const tags = buildEmailTags(input)
      const fullDateTag = tags.find((t) => t.Name === "X-Numaeel-FullDate")
      expect(fullDateTag!.Value).toBe("2026-06-21")
    })
  })
})

import { describe, it, expect } from "vitest"
import { buildUnsubscribeHeaders } from "../../src/email/unsubscribe-headers.js"

describe("unsubscribe-headers", () => {
  describe("buildUnsubscribeHeaders", () => {
    it("returns List-Unsubscribe with correct URL format", () => {
      const headers = buildUnsubscribeHeaders("acct_123", "api.numaeel.com", "eyJ.token.sig")

      const unsub = headers.find((h) => h.Name === "List-Unsubscribe")
      expect(unsub).toBeDefined()
      expect(unsub!.Value).toBe("<https://api.numaeel.com/accounts/acct_123/unsubscribe?code=eyJ.token.sig>")
    })

    it("returns List-Unsubscribe-Post with One-Click value", () => {
      const headers = buildUnsubscribeHeaders("acct_123", "api.numaeel.com", "eyJ.token.sig")

      const post = headers.find((h) => h.Name === "List-Unsubscribe-Post")
      expect(post).toBeDefined()
      expect(post!.Value).toBe("List-Unsubscribe=One-Click")
    })

    it("returns exactly two headers", () => {
      const headers = buildUnsubscribeHeaders("acct_xyz", "api.example.com", "jwt123")
      expect(headers).toHaveLength(2)
    })

    it("embeds accountId and jwt into the URL correctly", () => {
      const headers = buildUnsubscribeHeaders("acct_special-chars", "my-api.domain.io", "a.b.c")

      const unsub = headers.find((h) => h.Name === "List-Unsubscribe")!
      expect(unsub.Value).toContain("/accounts/acct_special-chars/unsubscribe")
      expect(unsub.Value).toContain("?code=a.b.c")
      expect(unsub.Value.startsWith("<https://my-api.domain.io/")).toBe(true)
      expect(unsub.Value.endsWith(">")).toBe(true)
    })
  })
})

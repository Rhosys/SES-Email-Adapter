import { describe, it, expect } from "vitest";
import { formatAddress, formatAddressList, splitAddressList, extractAddress, addressDomain } from "../../src/email/address.js";

describe("formatAddress", () => {
  it("returns the bare address when there is no name", () => {
    expect(formatAddress({ address: "jane@example.com" })).toBe("jane@example.com");
  });

  it("treats an empty or whitespace-only name as no name", () => {
    expect(formatAddress({ address: "jane@example.com", name: "" })).toBe("jane@example.com");
    expect(formatAddress({ address: "jane@example.com", name: "   " })).toBe("jane@example.com");
  });

  it("leaves a plain-word name unquoted", () => {
    expect(formatAddress({ address: "jane@example.com", name: "Jane Doe" })).toBe("Jane Doe <jane@example.com>");
  });

  it("quotes a name containing a comma", () => {
    expect(formatAddress({ address: "jane@example.com", name: "Doe, Jane" })).toBe('"Doe, Jane" <jane@example.com>');
  });

  it("quotes and escapes a name containing a double quote", () => {
    expect(formatAddress({ address: "jane@example.com", name: 'Jane "JD" Doe' })).toBe('"Jane \\"JD\\" Doe" <jane@example.com>');
  });

  it("quotes and escapes a name containing a backslash", () => {
    expect(formatAddress({ address: "jane@example.com", name: "Jane\\Doe" })).toBe('"Jane\\\\Doe" <jane@example.com>');
  });

  it("RFC 2047-encodes a non-ASCII name instead of quoting it", () => {
    const result = formatAddress({ address: "jorg@example.com", name: "Jörg Müller" });
    expect(result).toBe(`=?UTF-8?B?${Buffer.from("Jörg Müller", "utf8").toString("base64")}?= <jorg@example.com>`);
  });

  it("strips CR/LF from the name — header-injection defense", () => {
    const result = formatAddress({ address: "jane@example.com", name: "Jane\r\nBcc: attacker@evil.com" });
    expect(result).not.toMatch(/[\r\n]/);
    expect(result).toBe('"Jane Bcc: attacker@evil.com" <jane@example.com>');
  });

  it("trims surrounding whitespace on both address and name", () => {
    expect(formatAddress({ address: "  jane@example.com  ", name: "  Jane Doe  " })).toBe("Jane Doe <jane@example.com>");
  });
});

describe("formatAddressList", () => {
  it("joins multiple addresses with a comma and space", () => {
    expect(formatAddressList([{ address: "a@x.com" }, { address: "b@x.com", name: "Bob" }])).toBe("a@x.com, Bob <b@x.com>");
  });

  it("returns an empty string for an empty list", () => {
    expect(formatAddressList([])).toBe("");
  });

  it("returns a single formatted address unchanged for a one-element list", () => {
    expect(formatAddressList([{ address: "a@x.com", name: "Ada" }])).toBe("Ada <a@x.com>");
  });
});

describe("splitAddressList", () => {
  it("splits a simple comma-separated list", () => {
    expect(splitAddressList("a@x.com, b@x.com, c@x.com")).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
  });

  it("does not split a comma inside a quoted display name", () => {
    expect(splitAddressList('"Doe, Jane" <jane@x.com>, bob@y.com')).toEqual(['"Doe, Jane" <jane@x.com>', "bob@y.com"]);
  });

  it("handles multiple quoted names each containing a comma", () => {
    expect(splitAddressList('"Doe, Jane" <jane@x.com>, "Smith, Bob" <bob@y.com>')).toEqual([
      '"Doe, Jane" <jane@x.com>',
      '"Smith, Bob" <bob@y.com>',
    ]);
  });

  it("treats an escaped quote inside a quoted name as part of the name, not a close-quote", () => {
    const input = '"Jane \\"JD\\", Doe" <jane@x.com>, bob@y.com';
    expect(splitAddressList(input)).toEqual(['"Jane \\"JD\\", Doe" <jane@x.com>', "bob@y.com"]);
  });

  it("trims whitespace around each entry", () => {
    expect(splitAddressList("  a@x.com  ,   b@x.com  ")).toEqual(["a@x.com", "b@x.com"]);
  });

  it("returns a single-element array for a list with no commas", () => {
    expect(splitAddressList("a@x.com")).toEqual(["a@x.com"]);
  });

  it("drops a trailing empty entry from a trailing comma", () => {
    expect(splitAddressList("a@x.com, b@x.com,")).toEqual(["a@x.com", "b@x.com"]);
  });
});

describe("extractAddress", () => {
  it("returns a bare address unchanged apart from trim/lowercase", () => {
    expect(extractAddress("  Jane@Example.com  ")).toBe("jane@example.com");
  });

  it("pulls the addr-spec out of a decorated mailbox string", () => {
    expect(extractAddress('"Ada Lovelace" <User@Gmail.com>')).toBe("user@gmail.com");
  });

  it("is not confused by a comma inside the display name", () => {
    expect(extractAddress('"Doe, Jane" <jane@example.com>')).toBe("jane@example.com");
  });

  it("handles an unquoted display name", () => {
    expect(extractAddress("Jane Doe <jane@example.com>")).toBe("jane@example.com");
  });
});

describe("addressDomain", () => {
  it("returns the domain of a bare address", () => {
    expect(addressDomain("jane@example.com")).toBe("example.com");
  });

  it("returns the domain of a decorated address, ignoring the display name", () => {
    expect(addressDomain('"Support Team" <billing@example.com>')).toBe("example.com");
  });

  it("is not confused by a comma inside the display name", () => {
    expect(addressDomain('"Doe, Jane" <jane@example.com>')).toBe("example.com");
  });

  it("lowercases the domain", () => {
    expect(addressDomain("jane@EXAMPLE.COM")).toBe("example.com");
  });
});

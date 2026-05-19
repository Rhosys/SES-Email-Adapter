import { describe, it, expect } from "vitest";
import { validateWebhookConfig, parseWebhookConfig } from "../../src/api/validate-webhook-config.js";

describe("validateWebhookConfig", () => {
  it.each([
    { label: "missing value", value: undefined, expected: "webhook action requires a value field" },
    { label: "invalid JSON", value: "not json", expected: "must be valid JSON" },
    { label: "not an object (array)", value: "[1,2]", expected: "must be a JSON object" },
    { label: "missing url", value: '{"foo":"bar"}', expected: "must contain a non-empty 'url' field" },
    { label: "empty url", value: '{"url":""}', expected: "must contain a non-empty 'url' field" },
    { label: "ftp protocol", value: '{"url":"ftp://x.com/hook"}', expected: "must use http or https" },
    { label: "valid https", value: '{"url":"https://example.com/hook"}', expected: null },
    { label: "valid http", value: '{"url":"http://localhost:3000/hook"}', expected: null },
  ])("$label", ({ value, expected }) => {
    const result = validateWebhookConfig(value);
    if (expected === null) {
      expect(result).toBeNull();
    } else {
      expect(result).toContain(expected);
    }
  });
});

describe("parseWebhookConfig", () => {
  it("returns ok with parsed config for valid input", () => {
    const result = parseWebhookConfig('{"url":"https://example.com/hook"}');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ url: "https://example.com/hook" });
    }
  });

  it("returns err with error message for invalid input", () => {
    const result = parseWebhookConfig(undefined);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toContain("webhook action requires a value field");
    }
  });
});

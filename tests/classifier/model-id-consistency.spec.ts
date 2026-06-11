import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLASSIFICATION_MODEL_ID } from "../../src/classifier/classifier.js";

describe("Classifier model ID consistency", () => {
  it("matches the model ID declared in deploy/bedrock.tf", () => {
    const tfPath = resolve(import.meta.dirname, "../../deploy/bedrock.tf");
    const tfContent = readFileSync(tfPath, "utf-8");

    // Extract: classification_model_id = "qwen.qwen3-32b-v1:0"
    const match = tfContent.match(/classification_model_id\s*=\s*"([^"]+)"/);
    expect(match).not.toBeNull();

    const tfModelId = match![1];
    expect(CLASSIFICATION_MODEL_ID).toBe(tfModelId);
  });
});

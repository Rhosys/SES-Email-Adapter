import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("mustache", () => ({
  default: { render: vi.fn() },
}));

import { readFile } from "node:fs/promises";
import Mustache from "mustache";
import { renderTemplate } from "../../src/email/template-renderer.js";

const mockReadFile = vi.mocked(readFile);
const mockRender = vi.mocked(Mustache.render);

describe("renderTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the correct file path based on template name", async () => {
    mockReadFile.mockResolvedValue("<h1>{{title}}</h1>");
    mockRender.mockReturnValue("<h1>Hello</h1>");

    await renderTemplate("digest", { title: "Hello" });

    const expectedPath = path.join(process.cwd(), "email-templates", "digest.html");
    expect(mockReadFile).toHaveBeenCalledWith(expectedPath, "utf-8");
  });

  it("passes html and data to Mustache.render and returns result", async () => {
    const html = "<p>Hi {{name}}</p>";
    const data = { name: "Warren" };
    mockReadFile.mockResolvedValue(html);
    mockRender.mockReturnValue("<p>Hi Warren</p>");

    const result = await renderTemplate("welcome", data);

    expect(mockRender).toHaveBeenCalledWith(html, expect.objectContaining(data));
    expect(result).toBe("<p>Hi Warren</p>");
  });

  it("propagates readFile errors for missing templates", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT: no such file"));

    await expect(renderTemplate("missing", {})).rejects.toThrow("ENOENT: no such file");
  });
});

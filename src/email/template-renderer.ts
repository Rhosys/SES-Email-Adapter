import Mustache from "mustache";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEmailTheme } from "./email-theme.js";

// Lambda extracts to /var/task — templates land at /var/task/email-templates/
const TEMPLATES_DIR = path.join(process.cwd(), "email-templates");

export async function renderTemplate(name: string, data: Record<string, unknown>): Promise<string> {
  const html = await readFile(path.join(TEMPLATES_DIR, `${name}.html`), "utf-8");
  const theme = getEmailTheme();
  return Mustache.render(html, { ...data, theme });
}

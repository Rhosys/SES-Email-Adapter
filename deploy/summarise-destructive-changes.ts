import { readFile, appendFile } from "node:fs/promises";

const REASON_LABELS: Record<string, string> = {
  replace_because_tainted:              "Resource was tainted (forced replacement)",
  replace_because_cannot_update:        "Immutable attribute changed (forced replacement)",
  delete_because_no_resource_config:    "Removed from configuration",
  delete_because_wrong_repetition_type: "Repetition type changed (count ↔ for_each)",
};

function extractBlock(planText: string, address: string): string {
  const lines = planText.split("\n");
  let start: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`# ${address}`)) { start = i; break; }
  }
  if (start === null) return "(diff not available)";
  const result: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && /\s+#\s+\S/.test(lines[i])) break;
    if (lines[i].startsWith("Plan:")) break;
    result.push(lines[i]);
  }
  return result.join("\n").trim();
}

const planJson = JSON.parse(await readFile("deploy/plan.json", "utf-8"));
const planText = await readFile("/tmp/plan_text.txt", "utf-8");
const summaryFile = process.env["GITHUB_STEP_SUMMARY"]!;

for (const rc of planJson.resource_changes ?? []) {
  if (!(rc.change.actions as string[]).includes("delete")) continue;

  const address: string      = rc.address;
  const actions: string[]    = rc.change.actions;
  const rawReason: string    = rc.change.action_reason ?? "none";
  const reason               = REASON_LABELS[rawReason] ?? (rawReason !== "none" ? rawReason : "");
  const actionLabel          = actions.map(a => a[0].toUpperCase() + a.slice(1)).join(" → ");
  const diff                 = extractBlock(planText, address);

  let summaryLine = `<strong>${actionLabel}: <code>${address}</code></strong>`;
  if (reason) summaryLine += ` — ${reason}`;

  await appendFile(
    summaryFile,
    `<details>\n<summary>${summaryLine}</summary>\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n</details>\n\n`,
  );
}

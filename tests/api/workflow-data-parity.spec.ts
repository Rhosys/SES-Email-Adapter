import { describe, it, expect } from "vitest";
import { z } from "zod";
import { WorkflowData } from "../../src/api/schemas.js";
import { WORKFLOWS } from "../../src/types/index.js";

// ---------------------------------------------------------------------------
// Guards the zod WorkflowData discriminated union against the backend Workflow
// set. This is the parity that was silently broken: `events` and `onboarding`
// were valid Workflow values with TypeScript interfaces, but had no zod member,
// so their signal data was neither validated nor present in the OpenAPI spec.
// Any new workflow added to the registry (→ WORKFLOWS) must also get a zod
// member here, or this test fails.
// ---------------------------------------------------------------------------

/** The workflow discriminant literal of every member in the zod WorkflowData union. */
function zodUnionWorkflows(): string[] {
  return WorkflowData.options.map((member) => {
    const shape = (member as z.ZodObject<z.ZodRawShape>).shape;
    const workflowLiteral = shape.workflow as z.ZodLiteral<string>;
    return workflowLiteral.value;
  });
}

describe("WorkflowData zod union ↔ Workflow parity", () => {
  it("has a zod member for every workflow in WORKFLOWS", () => {
    const zodWorkflows = new Set(zodUnionWorkflows());
    const missing = WORKFLOWS.filter((w) => !zodWorkflows.has(w));
    expect(missing, "Workflows in WORKFLOWS with no zod WorkflowData member").toEqual([]);
  });

  it("has no zod member for a workflow absent from WORKFLOWS", () => {
    const workflowSet = new Set<string>(WORKFLOWS);
    const extra = zodUnionWorkflows().filter((w) => !workflowSet.has(w));
    expect(extra, "zod WorkflowData members with no matching Workflow value").toEqual([]);
  });

  it("has no duplicate workflow discriminants in the zod union", () => {
    const all = zodUnionWorkflows();
    expect(all.length, "duplicate workflow literal in WorkflowData union").toBe(new Set(all).size);
  });
});

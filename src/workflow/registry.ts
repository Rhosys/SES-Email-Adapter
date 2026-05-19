import type { Result } from "neverthrow";
import { ok } from "../errors.js";
import type { DbError } from "../errors.js";
import type { Signal, Arc, Workflow } from "../types/index.js";
import type { WorkflowHandler } from "./types.js";

export class HandlerRegistry {
  private readonly handlers: Map<Workflow, WorkflowHandler>;

  constructor(handlers: WorkflowHandler[]) {
    this.handlers = new Map(handlers.map(h => [h.workflow, h]));
  }

  async dispatch(signal: Signal, arc: Arc, accountId: string): Promise<Result<void, DbError>> {
    const handler = this.handlers.get(arc.workflow);
    if (!handler) return ok(undefined);
    return handler.execute(signal, arc, accountId);
  }
}

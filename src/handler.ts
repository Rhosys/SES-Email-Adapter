import { CompositeRoot } from "./composite-root.js";
import { createHandler } from "./create-handler.js";

// Lambda entry point. All wiring lives in CompositeRoot; all dispatch logic in create-handler.ts.
export const handler = createHandler(new CompositeRoot());

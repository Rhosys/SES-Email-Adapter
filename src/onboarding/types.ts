export interface StepFunctionTaskEvent {
  context: {
    Execution: {
      Id: string;
      Input: { accountId: string; email: string };
      Name: string;
    };
    StateMachine: {
      Id: string;
      Name: string;
    };
    State: {
      Name: string;
      EnteredTime: string;
    };
  };
}

export function isStepFunctionTaskEvent(event: unknown): event is StepFunctionTaskEvent {
  const e = event as Record<string, unknown>;
  return typeof e === "object" && e !== null && typeof e.context === "object" && e.context !== null
    && "StateMachine" in (e.context as Record<string, unknown>);
}

export const PROMPT_COMMAND_STATES = [
  "received",
  "dispatching",
  "delivered",
  "queued",
  "started",
  "rejected",
  "cancelled",
  "delivery_unknown",
  "reconciled_delivered",
  "reconciled_failed",
] as const;

export type PromptCommandState = typeof PROMPT_COMMAND_STATES[number];

export const AGENT_TASK_STATES = [
  "created",
  "running",
  "needs_input",
  "verifying",
  "completed",
  "failed",
  "cancelled",
  "budget_exceeded",
] as const;

export type AgentTaskState = typeof AGENT_TASK_STATES[number];

export interface PromptCommandReceipt {
  accepted: true;
  replayed: boolean;
  task: {
    id: string;
    state: AgentTaskState;
  };
  command: {
    id: string;
    state: PromptCommandState;
    receivedAt: string;
    updatedAt: string;
  };
}

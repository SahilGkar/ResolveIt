import type { AgentRunState } from './run-state.js';

export type AgentEventType =
  | 'observation-started'
  | 'observation-completed'
  | 'analysis-completed'
  | 'plan-created'
  | 'approval-requested'
  | 'approval-granted'
  | 'approval-denied'
  | 'action-started'
  | 'action-completed'
  | 'action-failed'
  | 'verification-started'
  | 'verification-completed'
  | 'replanning'
  | 'resolved'
  | 'failed';

export interface AgentEvent {
  readonly seq: number;
  readonly type: AgentEventType;
  readonly runId: string;
  readonly timestamp: Date;
  readonly state: AgentRunState;
  readonly data?: Readonly<Record<string, unknown>>;
}

export type AgentEventCallback = (event: AgentEvent) => void;

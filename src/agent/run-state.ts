import type { AgentLifecycleStage } from '../core/interfaces.js';

export type AgentRunState =
  | 'idle'
  | 'observing'
  | 'analyzing'
  | 'planning'
  | 'awaiting-approval'
  | 'acting'
  | 'verifying'
  | 'resolved'
  | 'replanning'
  | 'failed';

export const AGENT_RUN_STATES: ReadonlyArray<AgentRunState> = [
  'idle',
  'observing',
  'analyzing',
  'planning',
  'awaiting-approval',
  'acting',
  'verifying',
  'resolved',
  'replanning',
  'failed',
] as const;

export const AGENT_RUN_TRANSITIONS: Readonly<Record<AgentRunState, ReadonlyArray<AgentRunState>>> = {
  idle: ['observing'],
  observing: ['analyzing', 'failed'],
  analyzing: ['planning', 'resolved', 'failed'],
  planning: ['awaiting-approval', 'failed'],
  'awaiting-approval': ['acting', 'failed'],
  acting: ['verifying', 'failed'],
  verifying: ['resolved', 'replanning', 'failed'],
  resolved: [],
  replanning: ['analyzing', 'failed'],
  failed: [],
} as const;

export function canTransitionRunState(from: AgentRunState, to: AgentRunState): boolean {
  return AGENT_RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertRunTransition(from: AgentRunState, to: AgentRunState): void {
  if (!canTransitionRunState(from, to)) {
    throw new Error(`Invalid agent run transition from ${from} to ${to}`);
  }
}

export function isTerminalRunState(state: AgentRunState): boolean {
  return state === 'resolved' || state === 'failed';
}

export function toLifecycleStage(state: AgentRunState): AgentLifecycleStage {
  switch (state) {
    case 'idle':
    case 'observing':
      return 'observe';
    case 'analyzing':
      return 'analyze';
    case 'planning':
      return 'plan';
    case 'awaiting-approval':
      return 'request-approval';
    case 'acting':
      return 'act';
    case 'verifying':
      return 'verify';
    case 'resolved':
      return 'resolved';
    case 'replanning':
      return 're-plan';
    case 'failed':
      return 'failed';
  }
}

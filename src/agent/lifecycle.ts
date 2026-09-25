import { Agent, AgentState, AgentLifecycleStage, AgentEvidence, DiagnosisResult, PlanContext, RepairPlan, VerificationResult, ApprovalResult, Workspace } from '../core/interfaces.js';

export const AGENT_LIFECYCLE_STAGES: ReadonlyArray<AgentLifecycleStage> = [
  'observe',
  'analyze',
  'plan',
  'request-approval',
  'act',
  'verify',
  'resolved',
  're-plan',
  'failed',
] as const;

export const LIFECYCLE_TRANSITIONS: Readonly<Record<AgentLifecycleStage, ReadonlyArray<AgentLifecycleStage>>> = {
  observe: ['analyze', 'failed'],
  analyze: ['plan', 'failed'],
  plan: ['request-approval', 'failed'],
  'request-approval': ['act', 'failed'],
  act: ['verify', 'failed'],
  verify: ['resolved', 're-plan', 'failed'],
  resolved: [],
  're-plan': ['analyze', 'failed'],
  failed: [],
};

export function canTransition(from: AgentLifecycleStage, to: AgentLifecycleStage): boolean {
  return LIFECYCLE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function createInitialAgentState(workspaceId: string): AgentState {
  return {
    stage: 'observe',
    workspaceId,
    evidence: {
      workspace: {} as Workspace,
      diagnostics: [],
      environmentSnapshots: [],
    },
    verificationResults: [],
    startedAt: new Date(),
    updatedAt: new Date(),
  };
}

export function updateAgentState(state: AgentState, updates: Partial<AgentState>): AgentState {
  return {
    ...state,
    ...updates,
    updatedAt: new Date(),
  };
}

export function transitionAgentState(state: AgentState, newStage: AgentLifecycleStage): AgentState {
  if (!canTransition(state.stage, newStage)) {
    throw new Error(`Invalid transition from ${state.stage} to ${newStage}`);
  }
  return updateAgentState(state, { stage: newStage });
}

export interface AgentEngine {
  createAgent(id: string, name: string): Agent;
  getAgent(id: string): Agent | undefined;
  removeAgent(id: string): boolean;
  listAgents(): ReadonlyArray<Agent>;
}

export class SimpleAgentEngine implements AgentEngine {
  private agents: Map<string, Agent> = new Map();

  createAgent(id: string, name: string): Agent {
    if (this.agents.has(id)) {
      throw new Error(`Agent with id ${id} already exists`);
    }
    // Note: In practice, concrete agent implementations would be created here
    // For Phase 0, we just track agent metadata
    throw new Error('Concrete agent creation not implemented in Phase 0');
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  removeAgent(id: string): boolean {
    return this.agents.delete(id);
  }

  listAgents(): ReadonlyArray<Agent> {
    return Array.from(this.agents.values());
  }
}
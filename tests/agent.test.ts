import { describe, it, expect } from 'vitest';
import {
  AGENT_LIFECYCLE_STAGES,
  LIFECYCLE_TRANSITIONS,
  canTransition,
  createInitialAgentState,
  updateAgentState,
  transitionAgentState,
  SimpleAgentEngine,
} from '../src/agent/lifecycle.js';
import { Workspace, AgentEvidence, DiagnosisResult, PlanContext, RepairPlan, VerificationResult, ApprovalResult } from '../src/core/interfaces.js';

describe('agent/lifecycle', () => {
  it('should have all lifecycle stages', () => {
    expect(AGENT_LIFECYCLE_STAGES).toEqual([
      'observe',
      'analyze',
      'plan',
      'request-approval',
      'act',
      'verify',
      'resolved',
      're-plan',
      'failed',
    ]);
  });

  it('should have valid transitions', () => {
    expect(LIFECYCLE_TRANSITIONS.observe).toContain('analyze');
    expect(LIFECYCLE_TRANSITIONS.analyze).toContain('plan');
    expect(LIFECYCLE_TRANSITIONS.plan).toContain('request-approval');
    expect(LIFECYCLE_TRANSITIONS['request-approval']).toContain('act');
    expect(LIFECYCLE_TRANSITIONS.act).toContain('verify');
    expect(LIFECYCLE_TRANSITIONS.verify).toContain('resolved');
    expect(LIFECYCLE_TRANSITIONS.verify).toContain('re-plan');
    expect(LIFECYCLE_TRANSITIONS['re-plan']).toContain('analyze');
  });

  it('should allow valid transitions', () => {
    expect(canTransition('observe', 'analyze')).toBe(true);
    expect(canTransition('analyze', 'plan')).toBe(true);
    expect(canTransition('plan', 'request-approval')).toBe(true);
    expect(canTransition('request-approval', 'act')).toBe(true);
    expect(canTransition('act', 'verify')).toBe(true);
    expect(canTransition('verify', 'resolved')).toBe(true);
    expect(canTransition('verify', 're-plan')).toBe(true);
    expect(canTransition('re-plan', 'analyze')).toBe(true);
  });

  it('should reject invalid transitions', () => {
    expect(canTransition('observe', 'plan')).toBe(false);
    expect(canTransition('analyze', 'act')).toBe(false);
    expect(canTransition('resolved', 'observe')).toBe(false);
    expect(canTransition('failed', 'analyze')).toBe(false);
  });

  it('should create initial agent state', () => {
    const state = createInitialAgentState('ws-1');
    expect(state.stage).toBe('observe');
    expect(state.workspaceId).toBe('ws-1');
    expect(state.verificationResults).toEqual([]);
    expect(state.startedAt).toBeInstanceOf(Date);
    expect(state.updatedAt).toBeInstanceOf(Date);
  });

  it('should update agent state', () => {
    const state = createInitialAgentState('ws-1');
    const updated = updateAgentState(state, { stage: 'analyze' });
    expect(updated.stage).toBe('analyze');
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(state.updatedAt.getTime());
  });

  it('should transition agent state', () => {
    const state = createInitialAgentState('ws-1');
    const transitioned = transitionAgentState(state, 'analyze');
    expect(transitioned.stage).toBe('analyze');
  });

  it('should throw on invalid transition', () => {
    const state = createInitialAgentState('ws-1');
    expect(() => transitionAgentState(state, 'plan')).toThrow('Invalid transition');
  });

  it('should create SimpleAgentEngine', () => {
    const engine = new SimpleAgentEngine();
    expect(engine.listAgents()).toHaveLength(0);
  });

  it('should manage agents', () => {
    const engine = new SimpleAgentEngine();
    expect(engine.listAgents()).toHaveLength(0);
    expect(engine.getAgent('agent-1')).toBeUndefined();
    expect(engine.removeAgent('agent-1')).toBe(false);
  });

  it('should throw on createAgent (not implemented in Phase 0)', () => {
    const engine = new SimpleAgentEngine();
    expect(() => engine.createAgent('agent-1', 'Test Agent')).toThrow('not implemented in Phase 0');
  });
});
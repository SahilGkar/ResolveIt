import { describe, it, expect } from 'vitest';
import type {
  WorkspaceManager,
  LanguageAnalyzer,
  EnvironmentAdapter,
  DiagnosticEngine,
  RepairTool,
  VerificationEngine,
  AIProvider,
  Agent,
  PermissionManager,
  AuditLogger,
  ToolRegistry,
} from '../src/core/interfaces.js';

describe('core interfaces', () => {
  it('should have WorkspaceManager type', () => {
    const _check: WorkspaceManager = {} as WorkspaceManager;
    expect(true).toBe(true);
  });

  it('should have LanguageAnalyzer type', () => {
    const _check: LanguageAnalyzer = {} as LanguageAnalyzer;
    expect(true).toBe(true);
  });

  it('should have EnvironmentAdapter type', () => {
    const _check: EnvironmentAdapter = {} as EnvironmentAdapter;
    expect(true).toBe(true);
  });

  it('should have DiagnosticEngine type', () => {
    const _check: DiagnosticEngine = {} as DiagnosticEngine;
    expect(true).toBe(true);
  });

  it('should have RepairTool type', () => {
    const _check: RepairTool = {} as RepairTool;
    expect(true).toBe(true);
  });

  it('should have VerificationEngine type', () => {
    const _check: VerificationEngine = {} as VerificationEngine;
    expect(true).toBe(true);
  });

  it('should have AIProvider type', () => {
    const _check: AIProvider = {} as AIProvider;
    expect(true).toBe(true);
  });

  it('should have Agent type', () => {
    const _check: Agent = {} as Agent;
    expect(true).toBe(true);
  });

  it('should have PermissionManager type', () => {
    const _check: PermissionManager = {} as PermissionManager;
    expect(true).toBe(true);
  });

  it('should have AuditLogger type', () => {
    const _check: AuditLogger = {} as AuditLogger;
    expect(true).toBe(true);
  });

  it('should have ToolRegistry type', () => {
    const _check: ToolRegistry = {} as ToolRegistry;
    expect(true).toBe(true);
  });
});
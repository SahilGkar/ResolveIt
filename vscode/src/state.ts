import type {
  AgentEvent,
  Diagnostic,
  EnvironmentInfo,
  ParsedRequirements,
} from '../../src/index.js';

export interface LastRunSummary {
  readonly status: string;
  readonly timestamp: Date;
  readonly summary: string;
}

export interface LastVerification {
  readonly resolved: ReadonlyArray<string>;
  readonly remaining: ReadonlyArray<string>;
  readonly timestamp: Date;
}

export interface AIStatusState {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly available: boolean;
}

const MAX_EVENTS = 200;

export class ExtensionState {
  private diagnostics: Diagnostic[] = [];
  private environmentInfo?: EnvironmentInfo;
  private requirements: ParsedRequirements[] = [];
  private projectName?: string;
  private aiStatus?: AIStatusState;
  private lastRun?: LastRunSummary;
  private lastVerification?: LastVerification;
  private events: AgentEvent[] = [];
  private revision = 0;

  getRevision(): number {
    return this.revision;
  }

  setDiagnostics(diagnostics: ReadonlyArray<Diagnostic>): void {
    this.diagnostics = [...diagnostics];
    this.revision += 1;
  }

  getDiagnostics(): ReadonlyArray<Diagnostic> {
    return this.diagnostics;
  }

  getDiagnosticById(id: string): Diagnostic | undefined {
    return this.diagnostics.find((diagnostic) => diagnostic.id === id);
  }

  blockingCount(): number {
    return this.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error' || diagnostic.severity === 'critical'
    ).length;
  }

  setEnvironment(environment: EnvironmentInfo): void {
    this.environmentInfo = environment;
    this.revision += 1;
  }

  getEnvironment(): EnvironmentInfo | undefined {
    return this.environmentInfo;
  }

  setRequirements(requirements: ReadonlyArray<ParsedRequirements>): void {
    this.requirements = [...requirements];
    this.revision += 1;
  }

  getRequirements(): ReadonlyArray<ParsedRequirements> {
    return this.requirements;
  }

  setProjectName(name: string): void {
    this.projectName = name;
    this.revision += 1;
  }

  getProjectName(): string | undefined {
    return this.projectName;
  }

  setAIStatus(status: AIStatusState): void {
    this.aiStatus = status;
    this.revision += 1;
  }

  getAIStatus(): AIStatusState | undefined {
    return this.aiStatus;
  }

  setLastRun(run: LastRunSummary): void {
    this.lastRun = run;
    this.revision += 1;
  }

  getLastRun(): LastRunSummary | undefined {
    return this.lastRun;
  }

  setLastVerification(verification: LastVerification): void {
    this.lastVerification = verification;
    this.revision += 1;
  }

  getLastVerification(): LastVerification | undefined {
    return this.lastVerification;
  }

  appendEvent(event: AgentEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }

  getEvents(): ReadonlyArray<AgentEvent> {
    return this.events;
  }

  clearRunHistory(): void {
    this.events = [];
    this.revision += 1;
  }
}

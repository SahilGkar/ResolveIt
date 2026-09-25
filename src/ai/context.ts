import type {
  AIPlanningContext,
  AIPreviousAttempt,
  AIToolDescriptor,
  Diagnostic,
} from '../core/models.js';
import { CreateFileTool } from '../repair/tools/create-file.js';
import { ModifyFileTool } from '../repair/tools/modify-file.js';
import { InstallDependencyTool } from '../repair/tools/install-dependency.js';
import { CreatePythonVenvTool } from '../repair/tools/create-python-venv.js';
import type { AgentAnalysis, AgentObservation } from '../agent/index.js';
import type { VerificationReport } from '../agent/index.js';

export const TOOL_PARAMETER_ALLOWLIST: Readonly<Record<string, ReadonlyArray<string>>> = {
  'create-file': ['path', 'content'],
  'modify-file': ['path', 'find', 'replace'],
  'install-dependency': ['ecosystem', 'package', 'version', 'developmentOnly'],
  'create-python-venv': ['path', 'pythonExecutable'],
};

const ACTION_TYPE_TO_TOOL: Readonly<Record<string, string>> = {
  'create-environment': 'create-file',
  'update-manifest': 'modify-file',
  'modify-configuration': 'modify-file',
  'install-dependency': 'install-dependency',
};

export function describeAvailableTools(): ReadonlyArray<AIToolDescriptor> {
  const tools = [new CreateFileTool(), new ModifyFileTool(), new InstallDependencyTool(), new CreatePythonVenvTool()];
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    allowedParameters: TOOL_PARAMETER_ALLOWLIST[tool.name] ?? [],
    permissionLevel: tool.permissionLevel,
  }));
}

export function toolNameForActionType(actionType: string): string | undefined {
  const tools = [new CreateFileTool(), new ModifyFileTool(), new InstallDependencyTool(), new CreatePythonVenvTool()];
  for (const tool of tools) {
    if (tool.name === actionType) {
      return tool.name;
    }
    if ((tool.supportedActionTypes as ReadonlyArray<string>).includes(actionType)) {
      return tool.name;
    }
  }
  return ACTION_TYPE_TO_TOOL[actionType];
}

export interface AIContextInput {
  readonly observation: AgentObservation;
  readonly analysis: AgentAnalysis;
  readonly workspaceRoot: string;
  readonly failedFingerprints?: ReadonlySet<string>;
  readonly previousAttempts?: ReadonlyArray<AIPreviousAttempt>;
  readonly lastReport?: VerificationReport;
}

function diagnosticEvidence(diagnostic: Diagnostic): { expected?: unknown; actual?: unknown } {
  let expected: unknown;
  let actual: unknown;
  for (const item of diagnostic.evidence) {
    if (item.expected !== undefined && expected === undefined) {
      expected = item.expected;
    }
    if (item.actual !== undefined && actual === undefined) {
      actual = item.actual;
    }
  }
  return { expected, actual };
}

export function buildAIPlanningContext(input: AIContextInput): AIPlanningContext {
  const { observation, analysis } = input;
  const projects = observation.workspace.projects.map((project) => ({
    name: project.name,
    type: project.type,
  }));
  const languages = [...new Set(observation.workspace.languages.map((language) => language.name))];

  return {
    workspaceSummary: {
      rootPath: observation.workspace.rootPath,
      projectCount: observation.workspace.projects.length,
      projects,
      languages,
    },
    environmentSummary: {
      runtimes: observation.environment.runtimes.map((runtime) => ({
        name: runtime.name,
        version: runtime.version ?? 'unknown',
        available: runtime.available,
      })),
      tools: observation.environment.devTools.map((tool) => ({
        name: tool.name,
        version: tool.version ?? 'unknown',
        available: tool.available,
      })),
      dockerAvailable: observation.environment.containers.docker.available,
      dockerRunning: observation.environment.containers.dockerRunning,
    },
    requirements: observation.requirements.flatMap((parsed) =>
      parsed.requirements.map((requirement) => ({
        ecosystem: requirement.ecosystem,
        type: requirement.type,
        name: requirement.name,
        ...(requirement.versionConstraint === undefined
          ? {}
          : { versionConstraint: requirement.versionConstraint }),
        sourceFile: requirement.sourceFile,
      }))
    ),
    diagnostics: analysis.blockingDiagnostics.map((diagnostic) => {
      const { expected, actual } = diagnosticEvidence(diagnostic);
      return {
        code: diagnostic.code,
        category: diagnostic.category,
        severity: diagnostic.severity,
        title: diagnostic.title,
        message: diagnostic.message,
        ...(expected === undefined ? {} : { expected }),
        ...(actual === undefined ? {} : { actual }),
        affectedFiles: diagnostic.affectedFiles ? [...diagnostic.affectedFiles] : [],
      };
    }),
    availableTools: describeAvailableTools(),
    constraints: {
      maxRiskLevel: 'project-modification',
      allowedActions: ['install-dependency', 'create-environment', 'modify-configuration', 'update-manifest'],
      systemModificationRequiresApproval: true,
    },
    previousAttempts: input.previousAttempts
      ? [...input.previousAttempts]
      : [...(input.failedFingerprints ?? [])].map((fingerprint) => ({
          actionFingerprint: fingerprint,
          actionType: 'unknown',
          success: false,
        })),
    ...(input.lastReport === undefined
      ? {}
      : {
          verification: {
            success: input.lastReport.success,
            summary: input.lastReport.summary,
            remainingDiagnostics: [...input.lastReport.remainingDiagnostics],
          },
        }),
  };
}

import { Command } from 'commander';
import { version } from '../version.js';
import { scanWorkspace } from '../scanners/index.js';
import { scanEnvironment, environmentInfoToJSON, formatEnvironmentSummary } from '../environment/index.js';
import { scanRequirements, reqInfoToJSON, formatRequirementsSummary } from '../requirements/index.js';
import { diagnose, formatDiagnosticsSummary, diagnosticsToJSON } from '../diagnostics/index.js';
import type { RepairExecutionOptions } from '../repair/index.js';
import { createRepairExecutor, createRepairPlanner } from '../repair/index.js';
import { createAgentRunner, createAIPlanner } from '../agent/index.js';
import type { AgentRunResult } from '../agent/index.js';
import { createAIProviderFromConfig, resolveAIConfig, sanitizeAIConfig } from '../ai/index.js';
import type { AIConfig } from '../ai/index.js';
import type { Workspace, Language, ProjectMarker, RepairPlan, RepairAction } from '../core/models.js';

export const program = new Command();

program
  .name('resolveit')
  .description('Language-agnostic IDE-integrated project environment diagnosis and resolution system')
  .version(version)
  .helpOption('-h, --help', 'Display help for command')
  .exitOverride();

program
  .command('version')
  .description('Display version information')
  .action(() => {
    console.log(`ResolveIt v${version}`);
  });

program
  .command('help')
  .description('Display help')
  .action(() => {
    program.help();
  });

program
  .command('scan <workspace>')
  .description('Scan a workspace and display project information')
  .option('-j, --json', 'Output as JSON')
  .option('-d, --max-depth <number>', 'Maximum directory depth', '50')
  .option('-f, --max-files <number>', 'Maximum files to scan', '100000')
  .action(async (workspace: string, options: { json: boolean; maxDepth: string; maxFiles: string }) => {
    try {
      const result = await scanWorkspace(workspace, {
        maxDepth: parseInt(options.maxDepth, 10),
        maxFiles: parseInt(options.maxFiles, 10),
      });
      
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printSummary(result);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('environment')
  .description('Inspect the current development environment')
  .option('-j, --json', 'Output as JSON')
  .option('-t, --timeout <number>', 'Timeout in milliseconds', '30000')
  .action(async (options: { json: boolean; timeout: string }) => {
    try {
      const result = await scanEnvironment({ timeout: parseInt(options.timeout, 10) });
      
      if (options.json) {
        console.log(environmentInfoToJSON(result));
      } else {
        console.log(formatEnvironmentSummary(result));
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('requirements')
  .description('Inspect project requirements and dependencies')
  .option('-j, --json', 'Output as JSON')
  .option('-t, --timeout <number>', 'Timeout in milliseconds', '60000')
  .option('-p, --path <path>', 'Workspace path', '.')
  .action(async (options: { json: boolean; timeout: string; path: string }) => {
    try {
      const result = await scanRequirements(options.path, { timeout: parseInt(options.timeout, 10) });
      
      if (options.json) {
        console.log(reqInfoToJSON(result));
      } else {
        console.log(formatRequirementsSummary(result));
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

program
  .command('diagnose')
  .description('Run diagnostic engine on workspace')
  .option('-j, --json', 'Output as JSON')
  .option('-t, --timeout <number>', 'Timeout in milliseconds', '60000')
  .option('-p, --path <path>', 'Workspace path', '.')
  .action(async (options: { json: boolean; timeout: string; path: string }) => {
    try {
      const result = await diagnose({ workspaceRoot: options.path, timeout: parseInt(options.timeout, 10) });
      
      if (options.json) {
        console.log(diagnosticsToJSON(result));
      } else {
        console.log(formatDiagnosticsSummary(result));
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

function printSummary(ws: Workspace): void {
  console.log(`Workspace: ${ws.rootPath}`);
  console.log(`Projects found: ${ws.projects.length}`);
  console.log(`Files scanned: ${ws.allFiles.length}`);
  console.log(`Directories: ${ws.allDirectories.length}`);
  console.log(`Languages: ${ws.languages.map((l: Language) => l.name).join(', ') || 'none'}`);
  console.log(`Project markers: ${ws.projectMarkers.length}`);
  console.log(`Config files: ${ws.configFiles.length}`);
  console.log(`Repo indicators: ${ws.repoIndicators.length}`);
  
  if (ws.errors.length > 0) {
    console.log(`\nErrors (${ws.errors.length}):`);
    for (const error of ws.errors.slice(0, 10)) {
      console.log(`  ${error.path}: ${error.error}`);
    }
    if (ws.errors.length > 10) {
      console.log(`  ... and ${ws.errors.length - 10} more`);
    }
  }
  
  for (const project of ws.projects) {
    console.log(`\nProject: ${project.name} (${project.type})`);
    console.log(`  Root: ${project.projectRoot}`);
    console.log(`  Source files: ${project.sourceFiles.length}`);
    console.log(`  Test files: ${project.testFiles.length}`);
    console.log(`  Config files: ${project.configFiles.length}`);
    console.log(`  Doc files: ${project.documentationFiles.length}`);
    if (project.markers.length > 0) {
      console.log(`  Markers: ${project.markers.map((m: ProjectMarker) => m.type).join(', ')}`);
    }
    if (project.manifest.path) {
      console.log(`  Manifest: ${project.manifest.path} (${project.manifest.format})`);
    }
  }
}

export function runCli(args: string[] = process.argv.slice(2)): void {
  try {
    program.parse(args, { from: 'user' });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err.code === 'commander.help' || err.code === 'commander.version')) {
      return;
    }
    throw err;
  }

  if (!args.length) {
    program.help();
  }
}

function printRepairPlan(plan: RepairPlan): void {
  console.log(`Repair Plan: ${plan.name}`);
  console.log(`ID: ${plan.id}`);
  console.log(`Description: ${plan.description}`);
  console.log(`Actions: ${plan.actions.length}`);
  console.log(`Requires Approval: ${plan.requiresApproval}`);
  console.log(`Estimated Duration: ${plan.estimatedDuration}ms`);
  console.log('');
  
  for (const action of plan.actions) {
    console.log(`  Action: ${action.id}`);
    console.log(`    Type: ${action.type}`);
    console.log(`    Description: ${action.description}`);
    console.log(`    Permission Level: ${action.permissionLevel}`);
    console.log(`    Risk Level: ${action.riskLevel}`);
    console.log(`    Reversible: ${action.reversible}`);
    console.log(`    Requires Elevation: ${action.requiresElevation}`);
    if (action.affectedFiles && action.affectedFiles.length > 0) {
      console.log(`    Affected Files: ${action.affectedFiles.join(', ')}`);
    }
    console.log(`    Parameters: ${JSON.stringify(action.parameters, null, 2)}`);
    console.log('');
  }
}

async function executeRepair(
  workspaceRoot: string,
  options: { dryRun: boolean; json: boolean; approve?: string }
): Promise<void> {
  const diagnostics = await diagnose({ workspaceRoot, timeout: 60000 });
  
  if (diagnostics.length === 0) {
    console.log('No diagnostics found. Nothing to repair.');
    return;
  }

  const planner = createRepairPlanner();
  const context = {
    workspace: await scanWorkspace(workspaceRoot, { maxDepth: 50, maxFiles: 100000 }),
    diagnosis: {
      id: `diag-${Date.now()}`,
      summary: `Found ${diagnostics.length} diagnostics`,
      rootCauses: [],
      confidence: 1,
      timestamp: new Date(),
    },
    constraints: {
      maxRiskLevel: 'system-modification' as const,
      allowedActions: ['install-dependency', 'update-manifest', 'create-environment', 'modify-configuration', 'run-script', 'install-tool', 'upgrade-runtime', 'apply-patch', 'set-variable', 'custom'] as const,
      requireApproval: true,
    },
  };
  
  const plan = await planner.createPlan(diagnostics, context);
  const validation = planner.validatePlan(plan);
  
  if (!validation.valid) {
    console.error('Plan validation failed:', validation.errors.join(', '));
    process.exit(1);
  }

  if (options.dryRun || options.json) {
    if (options.json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      printRepairPlan(plan);
    }
    
    if (options.dryRun) {
      console.log('\nDRY RUN - No actions will be executed');
    }
    return;
  }

  const executor = createRepairExecutor(workspaceRoot);
  
  const approvalCallback = (action: RepairAction): Promise<'allowed' | 'requires-approval' | 'denied'> => {
    if (options.approve && options.approve === action.id) {
      return Promise.resolve('allowed');
    }
    console.log(`\nAction requires approval:`);
    console.log(`  ID: ${action.id}`);
    console.log(`  Type: ${action.type}`);
    console.log(`  Description: ${action.description}`);
    console.log(`  Permission: ${action.permissionLevel}`);
    console.log(`  Risk: ${action.riskLevel}`);
    console.log(`  Affected Files: ${action.affectedFiles?.join(', ') || 'none'}`);
    console.log(`\nTo approve this action, run: resolveit repair --approve ${action.id}`);
    return Promise.resolve('requires-approval');
  };

  const execOptions: RepairExecutionOptions = {
    dryRun: false,
    workspaceRoot,
    approvalCallback,
  };

  const result = await executor.executePlan(plan, execOptions);
  
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nRepair Execution Complete`);
    console.log(`Success: ${result.success}`);
    console.log(`Actions: ${result.results.length}`);
    for (const { action, result: actionResult } of result.results) {
      console.log(`  ${action.id}: ${actionResult.success ? 'SUCCESS' : 'FAILED'} ${actionResult.error ? `- ${actionResult.error}` : ''}`);
    }
  }
  
  if (!result.success) {
    process.exit(1);
  }
}

program
  .command('repair')
  .description('Execute repair actions for workspace diagnostics')
  .option('-j, --json', 'Output as JSON')
  .option('-d, --dry-run', 'Show what would be done without executing')
  .option('-p, --path <path>', 'Workspace path', '.')
  .option('--approve <action-id>', 'Approve a specific action by ID')
  .action(async (options: { json: boolean; dryRun: boolean; path: string; approve?: string }) => {
    try {
      await executeRepair(options.path, options);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

function printAgentResult(result: AgentRunResult): void {
  console.log(`Agent Run: ${result.runId}`);
  console.log(`Status: ${result.status}`);
  if (result.reason) {
    console.log(`Reason: ${result.reason}`);
  }
  console.log(`Iterations: ${result.iterations}`);
  if (result.remainingDiagnostics.length > 0) {
    console.log(`Remaining diagnostics: ${result.remainingDiagnostics.length}`);
  }
  if (result.manualActions.length > 0) {
    console.log(`Manual actions required:`);
    for (const manual of result.manualActions) {
      console.log(`  - ${manual.description} (${manual.reason})`);
    }
  }
  for (const report of result.verificationReports) {
    console.log(`Verification: ${report.success ? 'SUCCESS' : 'FAILED'} - ${report.summary}`);
  }
}

async function executeAgentRun(
  workspaceRoot: string,
  options: { dryRun: boolean; json: boolean; approve?: string; ai?: string; aiModel?: string; aiBaseUrl?: string }
): Promise<void> {
  const aiConfig: AIConfig = resolveAIConfig({
    ...(options.ai === undefined ? {} : { provider: options.ai as AIConfig['provider'] }),
    ...(options.aiModel === undefined ? {} : { model: options.aiModel }),
    ...(options.aiBaseUrl === undefined ? {} : { baseUrl: options.aiBaseUrl }),
  });
  const aiProvider = createAIProviderFromConfig(aiConfig);
  const aiPlanner = createAIPlanner(aiProvider, {
    onFallback: (reason, details) => {
      if (!options.json) {
        console.log(`AI planning fallback (${reason})${details ? `: ${details}` : ''}`);
      }
    },
  });
  const runner = createAgentRunner({ plan: aiPlanner });

  const approvalCallback = (plan: RepairPlan, _manual: ReadonlyArray<{ description: string }>): Promise<ReadonlyArray<string>> => {
    const approved: string[] = [];
    for (const action of plan.actions) {
      if (options.approve && options.approve === action.id) {
        approved.push(action.id);
        continue;
      }
      console.log(`\nAction requires approval:`);
      console.log(`  ID: ${action.id}`);
      console.log(`  Type: ${action.type}`);
      console.log(`  Description: ${action.description}`);
      console.log(`  Permission: ${action.permissionLevel}`);
      console.log(`\nTo approve this action, run: resolveit run --approve ${action.id}`);
    }
    return Promise.resolve(approved);
  };

  const { result } = await runner.run({
    workspaceRoot,
    dryRun: options.dryRun,
    approvalCallback,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printAgentResult(result);
  }

  if (options.dryRun) {
    console.log('\nDRY RUN - No actions were executed');
    return;
  }

  if (result.status !== 'resolved') {
    process.exit(1);
  }
}

program
  .command('run')
  .description('Run the deterministic agent lifecycle (observe, analyze, plan, approve, act, verify)')
  .option('-j, --json', 'Output as JSON')
  .option('-d, --dry-run', 'Observe, analyze and plan without executing')
  .option('-p, --path <path>', 'Workspace path', '.')
  .option('--approve <action-id>', 'Approve a specific action by ID')
  .option('--ai <provider>', 'AI provider: none, local, or external (default: none)')
  .option('--ai-model <model>', 'AI model name (local or external provider)')
  .option('--ai-base-url <url>', 'AI provider base URL (local or external provider)')
  .action(
    async (options: {
      json: boolean;
      dryRun: boolean;
      path: string;
      approve?: string;
      ai?: string;
      aiModel?: string;
      aiBaseUrl?: string;
    }) => {
      try {
        await executeAgentRun(options.path, options);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }
  );

async function showAIStatus(json: boolean): Promise<void> {
  const config = resolveAIConfig();
  const provider = createAIProviderFromConfig(config);
  const sanitized = sanitizeAIConfig(config);
  let available = false;
  try {
    available = await provider.isAvailable();
  } catch {
    available = false;
  }
  const status = {
    provider: sanitized.provider,
    name: provider.name,
    model: sanitized.model ?? '(not configured)',
    baseUrl: sanitized.baseUrl ?? '(not configured)',
    apiKeyConfigured: sanitized.apiKeyConfigured,
    timeoutMs: sanitized.timeoutMs,
    available,
  };
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log('ResolveIt AI Provider');
  console.log(`  Provider: ${status.provider} (${status.name})`);
  console.log(`  Model: ${status.model}`);
  console.log(`  Base URL: ${status.baseUrl}`);
  console.log(`  API key configured: ${status.apiKeyConfigured ? 'yes' : 'no'}`);
  console.log(`  Timeout: ${status.timeoutMs}ms`);
  console.log(`  Available: ${status.available ? 'yes' : 'no'}`);
}

program
  .command('ai')
  .description('Show AI provider configuration and availability (never prints secrets)')
  .option('-j, --json', 'Output as JSON')
  .action(async (options: { json: boolean }) => {
    try {
      await showAIStatus(options.json);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

if (require.main === module) {
  runCli();
}
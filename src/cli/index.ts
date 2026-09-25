import { Command } from 'commander';
import { version } from '../version.js';
import { scanWorkspace } from '../scanners/index.js';
import { scanEnvironment, environmentInfoToJSON, formatEnvironmentSummary } from '../environment/index.js';
import { scanRequirements, reqInfoToJSON, formatRequirementsSummary } from '../requirements/index.js';
import type { Workspace, Language, ProjectMarker } from '../core/models.js';

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

if (require.main === module) {
  runCli();
}
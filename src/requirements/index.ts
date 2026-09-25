import type { ProjectRequirement, ParsedRequirements } from '../core/models.js';
import type { RequirementParser, RequirementManager as IRequirementManager } from '../core/interfaces.js';
import {
  PythonRequirementParser,
  NodeRequirementParser,
  MavenRequirementParser,
  GradleRequirementParser,
  RustRequirementParser,
  GoRequirementParser,
  CMakeRequirementParser,
  MakefileRequirementParser,
  DockerfileRequirementParser,
  DockerComposeRequirementParser,
  RubyRequirementParser,
  PHPRequirementParser,
  DotNetRequirementParser,
} from './parsers/index.js';
import { promises as fs } from 'fs';
import { resolve } from 'path';

export interface RequirementScannerOptions {
  readonly timeout?: number;
}

export class RequirementManagerImpl implements IRequirementManager {
  private parsers: Map<string, RequirementParser> = new Map();
  private workspaceRoot: string = '';

  constructor() {
    this.registerDefaultParsers();
  }

  private registerDefaultParsers(): void {
    this.registerParser(new PythonRequirementParser());
    this.registerParser(new NodeRequirementParser());
    this.registerParser(new MavenRequirementParser());
    this.registerParser(new GradleRequirementParser());
    this.registerParser(new RustRequirementParser());
    this.registerParser(new GoRequirementParser());
    this.registerParser(new CMakeRequirementParser());
    this.registerParser(new MakefileRequirementParser());
    this.registerParser(new DockerfileRequirementParser());
    this.registerParser(new DockerComposeRequirementParser());
    this.registerParser(new RubyRequirementParser());
    this.registerParser(new PHPRequirementParser());
    this.registerParser(new DotNetRequirementParser());
  }

  registerParser(parser: RequirementParser): void {
    for (const format of parser.supportedFormats) {
      this.parsers.set(format.toLowerCase(), parser);
    }
  }

  async discoverRequirements(workspaceRoot: string): Promise<ReadonlyArray<ParsedRequirements>> {
    this.workspaceRoot = workspaceRoot;
    const allResults: ParsedRequirements[] = [];

    const files = await this.findRelevantFiles(workspaceRoot);

    for (const filePath of files) {
      const parser = this.getParserForFile(filePath);
      if (parser) {
        try {
          const fullPath = resolve(workspaceRoot, filePath);
          const content = await fs.readFile(fullPath, 'utf-8');
          const result = parser.parse(filePath, content);
          if (result.requirements.length > 0 || result.parseErrors.length > 0) {
            allResults.push(result);
          }
        } catch (err) {
          allResults.push({
            projectId: 'unknown',
            sourceFiles: [filePath],
            requirements: [],
            parseErrors: [{
              sourceFile: filePath,
              error: `Failed to read or parse file: ${err instanceof Error ? err.message : String(err)}`,
              code: 'READ_ERROR',
              severity: 'error',
            }],
          });
        }
      }
    }

    return allResults;
  }

  private async findRelevantFiles(rootPath: string): Promise<string[]> {
    const files: string[] = [];
    const supportedExtensions = new Set<string>();

    for (const parser of this.parsers.values()) {
      for (const format of parser.supportedFormats) {
        if (!format.includes('*')) {
          supportedExtensions.add(format.toLowerCase());
        }
      }
    }

    const manifestNames = [
      'package.json', 'requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg',
      'pom.xml', 'build.gradle', 'build.gradle.kts', 'Cargo.toml',
      'go.mod', 'CMakeLists.txt', 'Makefile', 'makefile', 'GNUmakefile',
      'Dockerfile', 'dockerfile', 'Containerfile', 'containerfile',
      'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
      'Gemfile', 'composer.json', 'Directory.Build.props',
      'Directory.Build.targets', 'nuget.config', 'gemspec', 'composer.lock',
    ];

    async function scanDir(dir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = resolve(dir, entry.name);
          const relativePath = fullPath.slice(rootPath.length + 1);

          if (entry.isDirectory()) {
            if (!['.git', 'node_modules', 'dist', 'build', 'target', 'out', '.venv', 'venv', '__pycache__', '.cache'].includes(entry.name)) {
              await scanDir(fullPath);
            }
          } else if (entry.isFile()) {
            const name = entry.name.toLowerCase();
            if (manifestNames.some(m => m.toLowerCase() === name || (m.startsWith('*') && name.endsWith(m.slice(1))))) {
              files.push(relativePath);
            }
          }
        }
      } catch (err) {
        // Ignore directory read errors
      }
    }

    await scanDir(rootPath);
    return files;
  }

  private getParserForFile(filePath: string): RequirementParser | undefined {
    const name = filePath.toLowerCase();
    for (const parser of this.parsers.values()) {
      if (parser.canParse(name)) return parser;
    }
    return undefined;
  }

  getRequirements(_projectId: string): ReadonlyArray<ProjectRequirement> {
    return [];
  }
}

export function createRequirementManager(): IRequirementManager {
  return new RequirementManagerImpl();
}

export async function scanRequirements(workspaceRoot: string, _options: RequirementScannerOptions = {}): Promise<ReadonlyArray<ParsedRequirements>> {
  const manager = new RequirementManagerImpl();
  return manager.discoverRequirements(workspaceRoot);
}

export function createMockRequirementManager(_responses: Map<string, string>): IRequirementManager {
  return {
    discoverRequirements(): Promise<ReadonlyArray<ParsedRequirements>> {
      return Promise.resolve([]);
    },
    getRequirements(): ReadonlyArray<ProjectRequirement> {
      return [];
    },
    registerParser(): void {},
  };
}

export { parseVersionConstraint, normalizeConstraint, VersionConstraint } from './version-constraints.js';

export function reqInfoToJSON(results: ReadonlyArray<ParsedRequirements>): string {
  const output = {
    totalFiles: results.length,
    totalRequirements: results.reduce((sum, r) => sum + r.requirements.length, 0),
    totalErrors: results.reduce((sum, r) => sum + r.parseErrors.length, 0),
    results: results.map(r => ({
      sourceFiles: r.sourceFiles,
      requirements: r.requirements.map(req => ({
        id: req.id,
        ecosystem: req.ecosystem,
        type: req.type,
        name: req.name,
        versionConstraint: req.versionConstraint,
        rawConstraint: req.rawConstraint,
        sourceFile: req.sourceFile,
        sourceSection: req.sourceSection,
        optional: req.optional,
        developmentOnly: req.developmentOnly,
        metadata: req.metadata,
      })),
      parseErrors: r.parseErrors,
    })),
  };

  return JSON.stringify(output, null, 2);
}

export function formatRequirementsSummary(results: ReadonlyArray<ParsedRequirements>): string {
  const lines: string[] = [];
  lines.push('ResolveIt Requirements');
  lines.push('');

  let totalReqs = 0;
  let totalErrors = 0;

  for (const result of results) {
    totalReqs += result.requirements.length;
    totalErrors += result.parseErrors.length;
  }

  const byEcosystem = new Map<string, ProjectRequirement[]>();
  for (const result of results) {
    for (const req of result.requirements) {
      const existing = byEcosystem.get(req.ecosystem) || [];
      byEcosystem.set(req.ecosystem, [...existing, req]);
    }
  }

  const runtimeReqs = new Map<string, ProjectRequirement[]>();
  const packageDeps = new Map<string, ProjectRequirement[]>();
  const toolReqs = new Map<string, ProjectRequirement[]>();
  const containerReqs = new Map<string, ProjectRequirement[]>();

  for (const [eco, reqs] of byEcosystem) {
    for (const req of reqs) {
      switch (req.type) {
        case 'runtime-version':
        case 'language-version': {
          const r = runtimeReqs.get(eco) || [];
          runtimeReqs.set(eco, [...r, req]);
          break;
        }
        case 'package-dependency':
        case 'package-manager': {
          const p = packageDeps.get(eco) || [];
          packageDeps.set(eco, [...p, req]);
          break;
        }
        case 'toolchain':
        case 'build-tool':
        case 'system-tool': {
          const t = toolReqs.get(eco) || [];
          toolReqs.set(eco, [...t, req]);
          break;
        }
        case 'container-image': {
          const c = containerReqs.get(eco) || [];
          containerReqs.set(eco, [...c, req]);
          break;
        }
        default: {
          const o = toolReqs.get(eco) || [];
          toolReqs.set(eco, [...o, req]);
        }
      }
    }
  }

  if (runtimeReqs.size > 0) {
    lines.push('Runtime Requirements');
    for (const [, reqs] of runtimeReqs) {
      for (const req of reqs) {
        const version = req.versionConstraint ? ` ${req.versionConstraint}` : '';
        const opt = req.optional ? ' (optional)' : '';
        const dev = req.developmentOnly ? ' (dev)' : '';
        lines.push(`  ${req.name}${version}${opt}${dev}`);
      }
      lines.push('');
    }
  }

  if (packageDeps.size > 0) {
    lines.push('Dependencies');
    for (const [, reqs] of packageDeps) {
      for (const req of reqs) {
        const version = req.versionConstraint ? ` ${req.versionConstraint}` : '';
        const opt = req.optional ? ' (optional)' : '';
        const dev = req.developmentOnly ? ' (dev)' : '';
        lines.push(`  ${req.name}${version}${opt}${dev}`);
      }
      lines.push('');
    }
  }

  if (toolReqs.size > 0) {
    lines.push('Build / Tool Requirements');
    for (const [, reqs] of toolReqs) {
      for (const req of reqs) {
        const version = req.versionConstraint ? ` ${req.versionConstraint}` : '';
        const opt = req.optional ? ' (optional)' : '';
        lines.push(`  ${req.name}${version}${opt}`);
      }
      lines.push('');
    }
  }

  if (containerReqs.size > 0) {
    lines.push('Container Requirements');
    for (const [, reqs] of containerReqs) {
      for (const req of reqs) {
        const version = req.versionConstraint ? ` ${req.versionConstraint}` : '';
        lines.push(`  ${req.name}${version}`);
      }
      lines.push('');
    }
  }

  lines.push('Summary');
  lines.push(`  Total requirements: ${totalReqs}`);
  lines.push(`  Parse errors: ${totalErrors}`);

  return lines.join('\n');
}
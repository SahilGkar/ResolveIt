import type { ProjectRequirement, ParsedRequirements } from '../core/models.js';
import type { RequirementParser, RequirementManager as IRequirementManager } from '../core/interfaces.js';
import {
  PythonRequirementParser,
  NodeRequirementParser,
  NodeLockfileParser,
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
import { MesonRequirementParser, ConanRequirementParser, VcpkgRequirementParser } from './parsers/native.js';
import { assignProject, isManifestFile, normalizeRelativePath, requirementIdentity } from './projects.js';
import { isEnvFile } from '../safety/secrets.js';
import { SECURITY_LIMITS } from '../safety/limits.js';
import { promises as fs } from 'fs';
import { resolve, basename } from 'path';

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
    this.registerParser(new NodeLockfileParser());
    this.registerParser(new MavenRequirementParser());
    this.registerParser(new GradleRequirementParser());
    this.registerParser(new RustRequirementParser());
    this.registerParser(new GoRequirementParser());
    this.registerParser(new CMakeRequirementParser());
    this.registerParser(new MakefileRequirementParser());
    this.registerParser(new MesonRequirementParser());
    this.registerParser(new ConanRequirementParser());
    this.registerParser(new VcpkgRequirementParser());
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
    files.sort();
    const boundedFiles = files.slice(0, SECURITY_LIMITS.maxRequirementFiles);
    const markerDirs = this.markerDirectories(boundedFiles);
    const contentCache = new Map<string, string>();

    for (const filePath of boundedFiles) {
      if (isEnvFile(basename(filePath))) {
        continue;
      }
      const parser = this.getParserForFile(filePath);
      if (parser) {
        try {
          const fullPath = resolve(workspaceRoot, filePath);
          let content = contentCache.get(fullPath);
          if (content === undefined) {
            const stats = await fs.stat(fullPath);
            if (!stats.isFile() || stats.size > SECURITY_LIMITS.maxRequirementFileBytes) {
              allResults.push({
                projectId: 'unknown',
                sourceFiles: [filePath],
                requirements: [],
                parseErrors: [{
                  sourceFile: filePath,
                  error: `Skipped file exceeding size limit (${SECURITY_LIMITS.maxRequirementFileBytes} bytes)`,
                  code: 'FILE_TOO_LARGE',
                  severity: 'warning',
                }],
              });
              continue;
            }
            content = await fs.readFile(fullPath, 'utf-8');
            contentCache.set(fullPath, content);
          }
          const parsed = parser.parse(filePath, content);
          const requirements = this.deduplicate(parsed.requirements);
          if (requirements.length > 0 || parsed.parseErrors.length > 0) {
            const { projectId, projectRoot } = assignProject(filePath, markerDirs);
            allResults.push({
              projectId,
              projectRoot,
              sourceFiles: parsed.sourceFiles,
              requirements,
              parseErrors: parsed.parseErrors,
            });
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

    allResults.sort((a, b) => (a.sourceFiles[0] ?? '').localeCompare(b.sourceFiles[0] ?? ''));
    return allResults;
  }

  private deduplicate(requirements: ReadonlyArray<ProjectRequirement>): ProjectRequirement[] {
    const seen = new Set<string>();
    const unique: ProjectRequirement[] = [];
    for (const requirement of requirements) {
      const key = requirementIdentity(requirement);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(requirement);
      }
    }
    return unique;
  }

  private markerDirectories(files: ReadonlyArray<string>): string[] {
    const dirs = new Set<string>();
    for (const file of files) {
      const normalized = normalizeRelativePath(file);
      const index = normalized.lastIndexOf('/');
      dirs.add(index <= 0 ? '.' : normalized.slice(0, index));
    }
    return [...dirs];
  }

  private async findRelevantFiles(rootPath: string): Promise<string[]> {
    const files: string[] = [];
    const absoluteRoot = resolve(rootPath);

    const manifestNames = [
      'package.json', 'package-lock.json', 'npm-shrinkwrap.json',
      'yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'bun.lock',
      'requirements.txt', 'requirements-*.txt', 'requirements/*.txt',
      'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'Pipfile.lock',
      'poetry.lock', 'uv.lock',
      'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
      'settings.gradle.kts', 'gradle.properties', 'gradle-wrapper.properties',
      'maven-wrapper.properties', 'libs.versions.toml',
      'Cargo.toml', 'Cargo.lock',
      'go.mod', 'go.work',
      'CMakeLists.txt', 'Makefile', 'makefile', 'GNUmakefile',
      'meson.build', 'conanfile.txt', 'conanfile.py', 'conan.lock', 'vcpkg.json',
      'Dockerfile', 'dockerfile', 'Containerfile', 'containerfile', '*.dockerfile',
      'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
      'Gemfile', 'Gemfile.lock', '*.gemspec',
      'composer.json', 'composer.lock',
      '*.csproj', '*.fsproj', '*.vbproj', '*.sln', '*.slnx',
      'packages.config', 'global.json', 'Directory.Packages.props',
      'Directory.Build.props', 'Directory.Build.targets', 'nuget.config',
    ];

    async function scanDir(dir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = resolve(dir, entry.name);
          const relativePath = fullPath.slice(absoluteRoot.length + 1);

          if (entry.isDirectory()) {
            if (!['.git', 'node_modules', 'dist', 'build', 'target', 'out', '.venv', 'venv', '__pycache__', '.cache'].includes(entry.name)) {
              await scanDir(fullPath);
            }
          } else if (entry.isFile()) {
            const entryRelative = normalizeRelativePath(relativePath);
            const relativePosix = entryRelative;
            const baseName = relativePosix.split('/').pop() ?? '';
            if (
              manifestNames.some(
                (pattern) =>
                  isManifestFile(baseName, [pattern]) || isManifestFile(relativePosix, [pattern])
              )
            ) {
              files.push(entryRelative);
            }
          }
        }
      } catch (err) {
        // Ignore directory read errors
      }
    }

    await scanDir(absoluteRoot);
    return files;
  }

  private getParserForFile(filePath: string): RequirementParser | undefined {
    const name = filePath.toLowerCase();
    const baseName = name.split('/').pop() ?? name;
    for (const parser of this.parsers.values()) {
      if (parser.canParse(baseName)) return parser;
    }
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
      projectId: r.projectId,
      projectRoot: r.projectRoot,
      sourceFiles: r.sourceFiles,
      requirements: r.requirements.map(req => ({
        id: req.id,
        ecosystem: req.ecosystem,
        type: req.type,
        name: req.name,
        versionConstraint: req.versionConstraint,
        rawConstraint: req.rawConstraint,
        resolvedVersion: req.resolvedVersion,
        origin: req.origin,
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
import type { ProjectMarker, ProjectMarkerType, ConfigFile, ConfigFileType, RepoIndicator, RepoIndicatorType } from '../core/models.js';

export interface ProjectMarkerDefinition {
  readonly type: ProjectMarkerType;
  readonly patterns: ReadonlyArray<string>;
  readonly format: string;
}

export const PROJECT_MARKER_DEFINITIONS: ReadonlyArray<ProjectMarkerDefinition> = [
  { type: 'package-json', patterns: ['package.json'], format: 'JSON' },
  { type: 'requirements-txt', patterns: ['requirements.txt', 'requirements-*.txt', 'requirements/*.txt'], format: 'text' },
  { type: 'pyproject-toml', patterns: ['pyproject.toml'], format: 'TOML' },
  { type: 'setup-py', patterns: ['setup.py'], format: 'Python' },
  { type: 'setup-cfg', patterns: ['setup.cfg'], format: 'INI' },
  { type: 'pom-xml', patterns: ['pom.xml'], format: 'XML' },
  { type: 'build-gradle', patterns: ['build.gradle', 'build.gradle.kts'], format: 'Gradle' },
  { type: 'cargo-toml', patterns: ['Cargo.toml'], format: 'TOML' },
  { type: 'go-mod', patterns: ['go.mod'], format: 'Go module' },
  { type: 'cmake-lists', patterns: ['CMakeLists.txt'], format: 'CMake' },
  { type: 'makefile', patterns: ['Makefile', 'makefile', 'GNUmakefile'], format: 'Make' },
  { type: 'dockerfile', patterns: ['Dockerfile', 'dockerfile', 'Containerfile', 'containerfile', '*.dockerfile'], format: 'Dockerfile' },
  { type: 'docker-compose', patterns: ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'], format: 'YAML' },
  { type: 'tsconfig-json', patterns: ['tsconfig.json', 'tsconfig.*.json'], format: 'JSON' },
  { type: 'sln', patterns: ['*.sln'], format: 'Visual Studio Solution' },
  { type: 'csproj', patterns: ['*.csproj'], format: 'XML' },
  { type: 'gemfile', patterns: ['Gemfile'], format: 'Ruby' },
  { type: 'composer-json', patterns: ['composer.json'], format: 'JSON' },
  { type: 'pubspec-yaml', patterns: ['pubspec.yaml'], format: 'YAML' },
  { type: 'package-swift', patterns: ['Package.swift'], format: 'Swift' },
];

export interface ConfigFileDefinition {
  readonly type: ConfigFileType;
  readonly patterns: ReadonlyArray<string>;
  readonly format: string;
}

export const CONFIG_FILE_DEFINITIONS: ReadonlyArray<ConfigFileDefinition> = [
  { type: 'gitignore', patterns: ['.gitignore', '.gitignore_global', '.git/info/exclude'], format: 'text' },
  { type: 'env', patterns: ['.env', '.env.local', '.env.*.local'], format: 'dotenv' },
  { type: 'env-example', patterns: ['.env.example', '.env.sample', '.env.template'], format: 'dotenv' },
  { type: 'readme', patterns: ['README', 'README.*', 'readme.*', 'Readme.*'], format: 'Markdown/text' },
  { type: 'license', patterns: ['LICENSE', 'LICENSE.*', 'license.*', 'COPYING', 'COPYING.*'], format: 'text' },
  { type: 'editorconfig', patterns: ['.editorconfig'], format: 'INI' },
  { type: 'prettierrc', patterns: ['.prettierrc', '.prettierrc.*', 'prettier.config.*'], format: 'JSON/JS/TOML/YAML' },
  { type: 'eslintrc', patterns: ['.eslintrc', '.eslintrc.*', 'eslint.config.*'], format: 'JSON/JS/YAML' },
  { type: 'tsconfig', patterns: ['tsconfig.json', 'tsconfig.*.json'], format: 'JSON' },
  { type: 'babelrc', patterns: ['.babelrc', '.babelrc.*', 'babel.config.*'], format: 'JSON/JS' },
  { type: 'webpack-config', patterns: ['webpack.config.*', 'webpack.*.config.*'], format: 'JS/TS' },
  { type: 'vite-config', patterns: ['vite.config.*'], format: 'JS/TS' },
  { type: 'jest-config', patterns: ['jest.config.*', 'jest.*.config.*'], format: 'JS/TS/JSON' },
  { type: 'pytest-ini', patterns: ['pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg'], format: 'INI/TOML' },
  { type: 'tox-ini', patterns: ['tox.ini'], format: 'INI' },
  { type: 'mypy-ini', patterns: ['mypy.ini', '.mypy.ini', 'pyproject.toml'], format: 'INI/TOML' },
  { type: 'ci-config', patterns: ['.github/workflows/*.yml', '.github/workflows/*.yaml', '.gitlab-ci.yml', 'Jenkinsfile', 'circle.yml', '.circleci/config.yml', '.travis.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml'], format: 'YAML' },
];

export interface RepoIndicatorDefinition {
  readonly type: RepoIndicatorType;
  readonly patterns: ReadonlyArray<string>;
  readonly isDir?: boolean;
}

export const REPO_INDICATOR_DEFINITIONS: ReadonlyArray<RepoIndicatorDefinition> = [
  { type: 'git', patterns: ['.git'], isDir: true },
  { type: 'gitignore', patterns: ['.gitignore'] },
  { type: 'github-workflows', patterns: ['.github/workflows'], isDir: true },
  { type: 'gitlab-ci', patterns: ['.gitlab-ci.yml', '.gitlab-ci.yaml'] },
  { type: 'jenkinsfile', patterns: ['Jenkinsfile'] },
  { type: 'circleci', patterns: ['.circleci'], isDir: true },
  { type: 'travis', patterns: ['.travis.yml', '.travis.yaml'] },
  { type: 'azure-pipelines', patterns: ['azure-pipelines.yml', 'azure-pipelines.yaml'] },
];

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function matchesPattern(path: string, pattern: string): boolean {
  const lowerPath = normalizePath(path).toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  
  if (lowerPattern.includes('*')) {
    const regexPattern = lowerPattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*');
    return new RegExp(`^${regexPattern}$`).test(lowerPath);
  }
  
  return lowerPath === lowerPattern;
}

function matchesAnyPattern(path: string, patterns: ReadonlyArray<string>): boolean {
  return patterns.some(pattern => matchesPattern(path, pattern));
}

export function detectProjectMarkers(filePath: string, relativePath: string): ProjectMarker | null {
  const fileName = relativePath.split(/[/\\]/).pop() || '';
  
  for (const def of PROJECT_MARKER_DEFINITIONS) {
    if (matchesAnyPattern(fileName, def.patterns)) {
      return {
        type: def.type,
        path: relativePath,
        format: def.format,
      };
    }
  }
  
  return null;
}

export function detectConfigFiles(filePath: string, relativePath: string): ConfigFile | null {
  const fileName = relativePath.split(/[/\\]/).pop() || '';
  
  for (const def of CONFIG_FILE_DEFINITIONS) {
    if (matchesAnyPattern(fileName, def.patterns)) {
      return {
        type: def.type,
        path: relativePath,
        format: def.format,
      };
    }
  }
  
  return null;
}

export function detectRepoIndicators(filePath: string, relativePath: string): RepoIndicator | null {
  const normalizedPath = normalizePath(relativePath);
  const parts = normalizedPath.split('/');
  
  for (const def of REPO_INDICATOR_DEFINITIONS) {
    if (def.isDir) {
      // Check if any directory in the path matches
      if (parts.some(part => matchesAnyPattern(part, def.patterns))) {
        return {
          type: def.type,
          path: relativePath,
        };
      }
      // Also check if the full path starts with the pattern (for nested dirs)
      if (matchesAnyPattern(normalizedPath, def.patterns.map(p => p + '/**'))) {
        return {
          type: def.type,
          path: relativePath,
        };
      }
    } else {
      // Check file name
      const fileName = parts[parts.length - 1] || '';
      if (matchesAnyPattern(fileName, def.patterns)) {
        return {
          type: def.type,
          path: relativePath,
        };
      }
    }
  }
  
  return null;
}

// Special function to detect repo indicators at the root level (e.g., .git directory)
export function detectRootRepoIndicators(_rootPath: string): RepoIndicator[] {
  const indicators: RepoIndicator[] = [];
  
  // This function should be called separately to check for directories like .git
  // that are excluded from normal file scanning
  
  return indicators;
}
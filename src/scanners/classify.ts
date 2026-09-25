import type { SourceClassification } from '../core/models.js';

export const TEST_PATTERNS: ReadonlyArray<string> = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/test/**/*.*',
  '**/tests/**/*.*',
  '**/__tests__/**/*.*',
  '**/__mocks__/**/*.*',
  '**/test_*.py',
  '**/*_test.py',
  '**/test*.py',
  '**/*Test.java',
  '**/*Tests.java',
  '**/*TestCase.java',
  '**/Test*.cs',
  '**/*Tests.cs',
  '**/*_test.go',
  '**/test_*.rs',
  '**/*_test.rb',
  '**/spec/**/*_spec.rb',
  '**/*_test.php',
  '**/tests/**/*Test.php',
  '**/*Test.kt',
  '**/*Tests.kt',
  '**/*Test.swift',
  '**/*Tests.swift',
];

export const CONFIG_PATTERNS: ReadonlyArray<string> = [
  '**/*.config.*',
  '**/*.conf.*',
  '**/*.ini',
  '**/*.cfg',
  '**/*.toml',
  '**/*.yaml',
  '**/*.yml',
  '**/.eslintrc*',
  '**/.prettierrc*',
  '**/.babelrc*',
  '**/tsconfig*.json',
  '**/webpack.config.*',
  '**/vite.config.*',
  '**/jest.config.*',
  '**/pyproject.toml',
  '**/pytest.ini',
  '**/tox.ini',
  '**/mypy.ini',
  '**/.editorconfig',
  '**/docker-compose*.yml',
  '**/docker-compose*.yaml',
  '**/Dockerfile*',
  '**/Makefile*',
  '**/CMakeLists.txt',
  '**/Cargo.toml',
  '**/go.mod',
  '**/pom.xml',
  '**/build.gradle*',
  '**/settings.gradle*',
  '**/package.json',
  '**/composer.json',
  '**/Gemfile*',
  '**/pubspec.yaml',
  '**/Package.swift',
];

export const DOC_PATTERNS: ReadonlyArray<string> = [
  'README*',
  'CHANGELOG*',
  'CONTRIBUTING*',
  'LICENSE*',
  'COPYING*',
  'AUTHORS*',
  '**/*.md',
  '**/*.markdown',
  '**/*.rst',
  '**/*.txt',
  '**/docs/**/*.*',
  '**/doc/**/*.*',
  '**/documentation/**/*.*',
];

export const GENERATED_PATTERNS: ReadonlyArray<string> = [
  '**/*.min.js',
  '**/*.min.css',
  '**/*.d.ts',
  '**/*.map',
  '**/dist/**/*.*',
  '**/build/**/*.*',
  '**/target/**/*.*',
  '**/out/**/*.*',
  '**/coverage/**/*.*',
  '**/.cache/**/*.*',
  '**/__pycache__/**/*.*',
  '**/*.pyc',
  '**/*.pyo',
  '**/node_modules/**/*.*',
  '**/vendor/**/*.*',
  '**/.next/**/*.*',
  '**/.nuxt/**/*.*',
  '**/.output/**/*.*',
  '**/bin/**/*.*',
  '**/obj/**/*.*',
];

export const IGNORED_DIRS: ReadonlyArray<string> = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  'out',
  'coverage',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.env',
  'vendor',
  '.next',
  '.nuxt',
  '.output',
  'bin',
  'obj',
  'packages',
  '.gradle',
  '.idea',
  '.vscode',
  '.vs',
];

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function matchesPattern(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizePath(filePath);
  const regexPattern = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${regexPattern}$`).test(normalizedPath);
}

function matchesAnyPattern(filePath: string, patterns: ReadonlyArray<string>): boolean {
  return patterns.some(pattern => matchesPattern(filePath, pattern));
}

function isInIgnoredDir(filePath: string): boolean {
  const normalizedPath = normalizePath(filePath);
  const parts = normalizedPath.split('/');
  return parts.some(part => IGNORED_DIRS.includes(part));
}

export function classifySourceFile(relativePath: string): SourceClassification {
  if (isInIgnoredDir(relativePath)) {
    return 'ignored';
  }
  
  if (matchesAnyPattern(relativePath, GENERATED_PATTERNS)) {
    return 'generated';
  }
  
  if (matchesAnyPattern(relativePath, TEST_PATTERNS)) {
    return 'test';
  }
  
  if (matchesAnyPattern(relativePath, CONFIG_PATTERNS)) {
    return 'configuration';
  }
  
  if (matchesAnyPattern(relativePath, DOC_PATTERNS)) {
    return 'documentation';
  }
  
  const ext = relativePath.substring(relativePath.lastIndexOf('.')).toLowerCase();
  const sourceExtensions = [
    '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
    '.py', '.pyw', '.pyi',
    '.java', '.kt', '.scala', '.groovy',
    '.c', '.cpp', '.cxx', '.cc', '.h', '.hpp', '.hxx',
    '.cs', '.fs', '.vb',
    '.go', '.rs', '.rb', '.php',
    '.swift', '.dart', '.m', '.mm',
    '.r', '.R', '.lua', '.pl', '.pm',
    '.sh', '.bash', '.zsh', '.fish', '.ps1',
    '.html', '.htm', '.vue', '.svelte', '.astro',
    '.css', '.scss', '.sass', '.less', '.styl',
    '.sql', '.graphql', '.gql',
    '.ex', '.exs', '.erl', '.hrl',
    '.ml', '.mli', '.re', '.rei',
    '.clj', '.cljs', '.cljc', '.edn',
    '.nim', '.v', '.vh', '.vhd', '.vhdl',
    '.proto', '.tf', '.tfvars',
  ];
  
  if (sourceExtensions.includes(ext)) {
    return 'source';
  }
  
  return 'unknown';
}
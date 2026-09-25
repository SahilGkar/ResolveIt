import { promises as fs } from 'fs';
import { resolve, relative, basename, dirname, extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  Workspace,
  Project,
  SourceFile,
  DirectoryInfo,
  ProjectMarker,
  ConfigFile,
  RepoIndicator,
  ScanError,
  Language,
  Manifest,
  ManifestFormat,
} from '../core/models.js';
import { detectLanguage } from './language.js';
import { detectProjectMarkers, detectConfigFiles, detectRepoIndicators } from './markers.js';
import { classifySourceFile, IGNORED_DIRS } from './classify.js';

export interface ScannerOptions {
  readonly maxDepth?: number;
  readonly maxFiles?: number;
  readonly followSymlinks?: boolean;
  readonly excludedDirs?: ReadonlyArray<string>;
}

const DEFAULT_OPTIONS: Required<ScannerOptions> = {
  maxDepth: 50,
  maxFiles: 100000,
  followSymlinks: false,
  excludedDirs: IGNORED_DIRS,
};

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function isExcludedPath(relativePath: string, excludedDirs: ReadonlyArray<string>): boolean {
  const normalizedPath = normalizePath(relativePath);
  const parts = normalizedPath.split('/');
  return parts.some(part => excludedDirs.includes(part));
}

function isPathInProject(relativePath: string, projectRelRoot: string): boolean {
  if (projectRelRoot === '.' || projectRelRoot === '') {
    return true;
  }
  return relativePath === projectRelRoot || relativePath.startsWith(projectRelRoot + '/');
}

async function detectRootRepoIndicatorsSync(rootPath: string): Promise<RepoIndicator[]> {
  const indicators: RepoIndicator[] = [];
  
  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name === '.git') {
        indicators.push({
          type: 'git',
          path: '.git',
        });
        break;
      }
    }
  } catch {
    // Ignore errors
  }
  
  return indicators;
}

export async function scanWorkspace(rootPath: string, options: ScannerOptions = {}): Promise<Workspace> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const absoluteRoot = resolve(rootPath);
  
  try {
    await fs.access(absoluteRoot);
  } catch {
    throw new Error(`Workspace not found: ${rootPath}`);
  }
  
  const stat = await fs.stat(absoluteRoot);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${rootPath}`);
  }
  
  // Detect root-level repo indicators (e.g., .git directory)
  const rootRepoIndicators = await detectRootRepoIndicatorsSync(absoluteRoot);
  
  const allFiles: SourceFile[] = [];
  const allDirectories: DirectoryInfo[] = [];
  const projectMarkers: ProjectMarker[] = [];
  const configFiles: ConfigFile[] = [];
  const repoIndicators: RepoIndicator[] = [...rootRepoIndicators];
  const errors: ScanError[] = [];
  
  let fileCount = 0;
  
  async function scanDirectory(currentPath: string, depth: number): Promise<void> {
    if (depth > opts.maxDepth) {
      return;
    }
    
    if (fileCount >= opts.maxFiles) {
      return;
    }
    
    const relativeDir = normalizePath(relative(absoluteRoot, currentPath));
    if (relativeDir !== '' && isExcludedPath(relativeDir, opts.excludedDirs)) {
      return;
    }
    
    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      
      let subdirCount = 0;
      let dirFileCount = 0;
      
      for (const entry of entries) {
        if (fileCount >= opts.maxFiles) break;
        
        const entryPath = resolve(currentPath, entry.name);
        const entryRelative = normalizePath(relative(absoluteRoot, entryPath));
        
        if (entry.isDirectory()) {
          if (opts.excludedDirs.includes(entry.name) || isExcludedPath(entryRelative, opts.excludedDirs)) {
            continue;
          }
          subdirCount++;
          await scanDirectory(entryPath, depth + 1);
        } else if (entry.isFile()) {
          try {
            const stats = await fs.stat(entryPath);
            dirFileCount++;
            fileCount++;
            
            const classification = classifySourceFile(entryRelative);
            const language = detectLanguage(entryRelative);
            
            const sourceFile: SourceFile = {
              relativePath: entryRelative,
              name: basename(entryRelative),
              extension: extname(entryRelative).toLowerCase(),
              size: stats.size,
              language,
              classification,
            };
            
            allFiles.push(sourceFile);
            
            const marker = detectProjectMarkers(entryPath, entryRelative);
            if (marker) {
              projectMarkers.push(marker);
            }
            
            const config = detectConfigFiles(entryPath, entryRelative);
            if (config) {
              configFiles.push(config);
            }
            
            const repo = detectRepoIndicators(entryPath, entryRelative);
            if (repo) {
              repoIndicators.push(repo);
            }
          } catch (err) {
            errors.push({
              path: entryRelative,
              error: err instanceof Error ? err.message : String(err),
              code: 'FILE_READ_ERROR',
            });
          }
        }
      }
      
      if (relativeDir !== '' || depth === 0) {
        allDirectories.push({
          relativePath: relativeDir || '.',
          name: basename(currentPath) || basename(absoluteRoot),
          fileCount: dirFileCount,
          subdirectoryCount: subdirCount,
        });
      }
    } catch (err) {
      const relativeDir = normalizePath(relative(absoluteRoot, currentPath));
      errors.push({
        path: relativeDir || '.',
        error: err instanceof Error ? err.message : String(err),
        code: 'DIR_READ_ERROR',
      });
    }
  }
  
  await scanDirectory(absoluteRoot, 0);
  
  const uniqueMarkers = projectMarkers.filter(
    (marker, index, self) => index === self.findIndex(m => m.path === marker.path)
  );
  
  const uniqueConfigFiles = configFiles.filter(
    (config, index, self) => index === self.findIndex(c => c.path === config.path)
  );
  
  const uniqueRepoIndicators = repoIndicators.filter(
    (repo, index, self) => index === self.findIndex(r => r.path === repo.path)
  );
  
  const languages = detectLanguageDetails(allFiles);
  
  const projects = identifyProjects(absoluteRoot, allFiles, uniqueMarkers, uniqueConfigFiles, languages);
  
  return {
    id: uuidv4(),
    rootPath: absoluteRoot,
    projects,
    environments: [],
    allFiles,
    allDirectories,
    languages,
    projectMarkers: uniqueMarkers,
    configFiles: uniqueConfigFiles,
    repoIndicators: uniqueRepoIndicators,
    errors,
  };
}

function detectLanguageDetails(files: ReadonlyArray<SourceFile>): Language[] {
  const langIds = new Set<string>();
  for (const file of files) {
    if (file.language) {
      langIds.add(file.language);
    }
  }
  
  return Array.from(langIds).map(id => ({
    id,
    name: getLanguageName(id),
    ecosystems: [],
  }));
}

function getLanguageName(id: string): string {
  const langMap: Record<string, string> = {
    python: 'Python',
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    java: 'Java',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    go: 'Go',
    rust: 'Rust',
    ruby: 'Ruby',
    php: 'PHP',
    kotlin: 'Kotlin',
    swift: 'Swift',
    dart: 'Dart',
    r: 'R',
    lua: 'Lua',
    shell: 'Shell',
    html: 'HTML',
    css: 'CSS',
    sql: 'SQL',
    json: 'JSON',
    yaml: 'YAML',
    toml: 'TOML',
    xml: 'XML',
    markdown: 'Markdown',
    dockerfile: 'Dockerfile',
    makefile: 'Makefile',
    cmake: 'CMake',
    gradle: 'Gradle',
    maven: 'Maven',
  };
  return langMap[id] || id;
}

function identifyProjects(
  rootPath: string,
  files: ReadonlyArray<SourceFile>,
  markers: ReadonlyArray<ProjectMarker>,
  configFiles: ReadonlyArray<ConfigFile>,
  languages: ReadonlyArray<Language>
): Project[] {
  const projects: Project[] = [];
  const projectRoots = new Set<string>();
  
  for (const marker of markers) {
    const markerDir = dirname(marker.path);
    const normalizedMarkerDir = normalizePath(markerDir);
    const projectRoot = normalizedMarkerDir === '.' ? rootPath : resolve(rootPath, normalizedMarkerDir);
    projectRoots.add(projectRoot);
  }
  
  if (projectRoots.size === 0) {
    projectRoots.add(rootPath);
  }
  
  for (const projectRoot of projectRoots) {
    const projectRelRoot = normalizePath(relative(rootPath, projectRoot));
    const projectFiles = files.filter(f => isPathInProject(f.relativePath, projectRelRoot));
    
    const projectMarkers = markers.filter(m => isPathInProject(m.path, projectRelRoot));
    
    const projectConfigFiles = configFiles.filter(c => isPathInProject(c.path, projectRelRoot));
    
    const sourceFiles = projectFiles.filter(f => f.classification === 'source');
    const testFiles = projectFiles.filter(f => f.classification === 'test');
    const docFiles = projectFiles.filter(f => f.classification === 'documentation');
    const otherFiles = projectFiles.filter(f => 
      f.classification === 'unknown' || f.classification === 'generated' || f.classification === 'ignored'
    );
    
    const projectType = determineProjectType(projectMarkers);
    const manifest = findManifest(projectRoot, projectFiles);
    
    projects.push({
      id: uuidv4(),
      name: basename(projectRoot),
      rootPath: projectRoot,
      type: projectType,
      manifest,
      dependencies: [],
      languages,
      projectRoot: projectRelRoot || '.',
      markers: projectMarkers,
      configFiles: projectConfigFiles,
      sourceFiles,
      testFiles,
      documentationFiles: docFiles,
      otherFiles,
    });
  }
  
  return projects;
}

function determineProjectType(markers: ReadonlyArray<ProjectMarker>): Project['type'] {
  const markerTypes = new Set(markers.map(m => m.type));
  
  if (markerTypes.has('package-json')) return 'npm';
  if (markerTypes.has('pyproject-toml') || markerTypes.has('requirements-txt') || markerTypes.has('setup-py')) return 'pip';
  if (markerTypes.has('pom-xml')) return 'maven';
  if (markerTypes.has('build-gradle')) return 'gradle';
  if (markerTypes.has('cargo-toml')) return 'cargo';
  if (markerTypes.has('go-mod')) return 'go-mod';
  if (markerTypes.has('cmake-lists') || markerTypes.has('makefile')) return 'cmake';
  if (markerTypes.has('sln') || markerTypes.has('csproj')) return 'msbuild';
  if (markerTypes.has('gemfile')) return 'bundler';
  if (markerTypes.has('composer-json')) return 'composer';
  if (markerTypes.has('pubspec-yaml')) return 'pub';
  if (markerTypes.has('package-swift')) return 'swiftpm';
  
  return 'unknown';
}

function findManifest(projectRoot: string, files: ReadonlyArray<SourceFile>): Manifest {
  const manifestFiles = files.filter(f => 
    f.name === 'package.json' || 
    f.name === 'pyproject.toml' || 
    f.name === 'requirements.txt' ||
    f.name === 'pom.xml' ||
    f.name === 'build.gradle' ||
    f.name === 'Cargo.toml' ||
    f.name === 'go.mod' ||
    f.name === 'CMakeLists.txt' ||
    f.name.endsWith('.csproj') ||
    f.name === 'Gemfile' ||
    f.name === 'composer.json' ||
    f.name === 'pubspec.yaml' ||
    f.name === 'Package.swift'
  );
  
  if (manifestFiles.length > 0) {
    const mf = manifestFiles[0]!;
    return {
      path: mf.relativePath,
      format: getManifestFormat(mf.name),
      content: {},
    };
  }
  
  return {
    path: '',
    format: 'unknown',
    content: {},
  };
}

function getManifestFormat(fileName: string): ManifestFormat {
  const formatMap: Record<string, ManifestFormat> = {
    'package.json': 'package.json',
    'pyproject.toml': 'pyproject.toml',
    'requirements.txt': 'requirements.txt',
    'pom.xml': 'pom.xml',
    'build.gradle': 'build.gradle',
    'Cargo.toml': 'Cargo.toml',
    'go.mod': 'go.mod',
    'CMakeLists.txt': 'CMakeLists.txt',
    'Gemfile': 'Gemfile',
    'composer.json': 'composer.json',
    'pubspec.yaml': 'pubspec.yaml',
    'Package.swift': 'Package.swift',
  };
  return formatMap[fileName] || 'unknown';
}
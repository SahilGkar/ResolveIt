export interface Project {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly type: ProjectType;
  readonly manifest: Manifest;
  readonly dependencies: ReadonlyArray<Dependency>;
  readonly languages: ReadonlyArray<Language>;
  readonly projectRoot: string;
  readonly markers: ReadonlyArray<ProjectMarker>;
  readonly configFiles: ReadonlyArray<ConfigFile>;
  readonly sourceFiles: ReadonlyArray<SourceFile>;
  readonly testFiles: ReadonlyArray<SourceFile>;
  readonly documentationFiles: ReadonlyArray<SourceFile>;
  readonly otherFiles: ReadonlyArray<SourceFile>;
}

export type ProjectType =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'pip'
  | 'poetry'
  | 'maven'
  | 'gradle'
  | 'go-mod'
  | 'cargo'
  | 'cmake'
  | 'msbuild'
  | 'bundler'
  | 'composer'
  | 'pub'
  | 'swiftpm'
  | 'unknown';

export interface Manifest {
  readonly path: string;
  readonly format: ManifestFormat;
  readonly content: Readonly<Record<string, unknown>>;
}

export type ManifestFormat =
  | 'package.json'
  | 'pyproject.toml'
  | 'requirements.txt'
  | 'pom.xml'
  | 'build.gradle'
  | 'go.mod'
  | 'Cargo.toml'
  | 'CMakeLists.txt'
  | '*.csproj'
  | 'Gemfile'
  | 'composer.json'
  | 'pubspec.yaml'
  | 'Package.swift'
  | 'unknown';

export interface Dependency {
  readonly name: string;
  readonly version: string;
  readonly source: DependencySource;
  readonly scope?: DependencyScope;
  readonly optional: boolean;
}

export type DependencySource =
  | 'registry'
  | 'git'
  | 'local'
  | 'workspace'
  | 'url'
  | 'unknown';

export type DependencyScope =
  | 'production'
  | 'development'
  | 'peer'
  | 'optional'
  | 'system'
  | 'provided'
  | 'test'
  | 'runtime';

export interface Language {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly ecosystems: ReadonlyArray<Ecosystem>;
}

export interface Ecosystem {
  readonly id: string;
  readonly name: string;
  readonly packageManagers: ReadonlyArray<PackageManager>;
}

export interface PackageManager {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly commands: ReadonlyArray<string>;
}

export interface Workspace {
  readonly id: string;
  readonly rootPath: string;
  readonly projects: ReadonlyArray<Project>;
  readonly environments: ReadonlyArray<Environment>;
  readonly allFiles: ReadonlyArray<SourceFile>;
  readonly allDirectories: ReadonlyArray<DirectoryInfo>;
  readonly languages: ReadonlyArray<Language>;
  readonly projectMarkers: ReadonlyArray<ProjectMarker>;
  readonly configFiles: ReadonlyArray<ConfigFile>;
  readonly repoIndicators: ReadonlyArray<RepoIndicator>;
  readonly errors: ReadonlyArray<ScanError>;
}

export interface Environment {
  readonly id: string;
  readonly name: string;
  readonly type: EnvironmentType;
  readonly runtime: Runtime;
  readonly tools: ReadonlyArray<Tool>;
  readonly variables: Readonly<Record<string, string>>;
}

export type EnvironmentType =
  | 'local'
  | 'container'
  | 'remote'
  | 'ci'
  | 'virtual'
  | 'unknown';

export interface Runtime {
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface Tool {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly capabilities: ReadonlyArray<ToolCapability>;
}

export type ToolCapability =
  | 'build'
  | 'test'
  | 'lint'
  | 'format'
  | 'install'
  | 'publish'
  | 'run'
  | 'diagnose';

export interface Requirement {
  readonly id: string;
  readonly type: RequirementType;
  readonly specifier: string;
  readonly satisfied: boolean;
  readonly details?: string;
}

export type RequirementType =
  | 'runtime-version'
  | 'tool-version'
  | 'dependency-version'
  | 'environment-variable'
  | 'system-package'
  | 'permission'
  | 'custom';

export interface Diagnostic {
  readonly id: string;
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly category: DiagnosticCategory;
  readonly title: string;
  readonly message: string;
  readonly evidence: ReadonlyArray<DiagnosticEvidence>;
  readonly affectedFiles?: ReadonlyArray<string>;
  readonly requirement?: ProjectRequirement;
  readonly actualValue?: unknown;
  readonly expectedValue?: unknown;
  readonly remediationCandidates?: ReadonlyArray<RemediationCandidate>;
  readonly location?: DiagnosticLocation;
  readonly source: DiagnosticSource;
  readonly timestamp: Date;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint' | 'critical';

export type DiagnosticCategory =
  | 'runtime'
  | 'dependency'
  | 'toolchain'
  | 'build'
  | 'container'
  | 'configuration'
  | 'project'
  | 'environment'
  | 'unknown';

export interface DiagnosticEvidence {
  readonly source: 'project' | 'environment' | 'requirement' | 'computed';
  readonly description: string;
  readonly key?: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly file?: string;
  readonly section?: string;
}

export interface RemediationCandidate {
  readonly id: string;
  readonly type: RepairActionType;
  readonly description: string;
  readonly confidence: number;
  readonly riskLevel: RiskLevel;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DiagnosticLocation {
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

export type DiagnosticSource =
  | 'project-scanner'
  | 'environment-intelligence'
  | 'language-analyzer'
  | 'dependency-resolver'
  | 'tool-registry'
  | 'ai-agent'
  | 'verification-engine'
  | 'custom';

export interface RepairAction {
  readonly id: string;
  readonly type: RepairActionType;
  readonly description: string;
  readonly target: RepairTarget;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly riskLevel: RiskLevel;
  readonly prerequisites: ReadonlyArray<string>;
  readonly rollback?: RollbackAction;
}

export type RepairActionType =
  | 'install-dependency'
  | 'update-manifest'
  | 'create-environment'
  | 'modify-configuration'
  | 'run-script'
  | 'install-tool'
  | 'upgrade-runtime'
  | 'set-variable'
  | 'apply-patch'
  | 'custom';

export interface RepairTarget {
  readonly projectId?: string;
  readonly environmentId?: string;
  readonly filePath?: string;
  readonly toolId?: string;
}

export type RiskLevel = 'read-only' | 'project-modification' | 'system-modification';

export interface RollbackAction {
  readonly type: RepairActionType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RepairPlan {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly actions: ReadonlyArray<RepairAction>;
  readonly estimatedDuration?: number;
  readonly requiresApproval: boolean;
}

export interface VerificationResult {
  readonly repairPlanId: string;
  readonly actionId: string;
  readonly success: boolean;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly timestamp: Date;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type AgentLifecycleStage =
  | 'observe'
  | 'analyze'
  | 'plan'
  | 'request-approval'
  | 'act'
  | 'verify'
  | 'resolved'
  | 're-plan'
  | 'failed';

export interface AgentState {
  readonly stage: AgentLifecycleStage;
  readonly workspaceId: string;
  readonly currentPlanId?: string;
  readonly currentActionId?: string;
  readonly evidence: AgentEvidence;
  readonly diagnosis?: DiagnosisResult;
  readonly plan?: RepairPlan;
  readonly verificationResults: ReadonlyArray<VerificationResult>;
  readonly error?: string;
  readonly startedAt: Date;
  readonly updatedAt: Date;
}

export interface AgentEvidence {
  readonly workspace: Workspace;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly environmentSnapshots: ReadonlyArray<EnvironmentSnapshot>;
}

export interface EnvironmentSnapshot {
  readonly environmentId: string;
  readonly timestamp: Date;
  readonly runtime: Runtime;
  readonly tools: ReadonlyArray<Tool>;
  readonly variables: Readonly<Record<string, string>>;
}

export interface DiagnosisResult {
  readonly id: string;
  readonly summary: string;
  readonly rootCauses: ReadonlyArray<RootCause>;
  readonly confidence: number;
  readonly timestamp: Date;
}

export interface RootCause {
  readonly id: string;
  readonly description: string;
  readonly affectedComponents: ReadonlyArray<string>;
  readonly suggestedActions: ReadonlyArray<string>;
  readonly confidence: number;
}

export interface PlanContext {
  readonly workspace: Workspace;
  readonly diagnosis: DiagnosisResult;
  readonly constraints: PlanConstraints;
}

export interface PlanConstraints {
  readonly maxRiskLevel: RiskLevel;
  readonly allowedActions: ReadonlyArray<RepairActionType>;
  readonly maxDuration?: number;
  readonly requireApproval: boolean;
}

export interface SourceFile {
  readonly relativePath: string;
  readonly name: string;
  readonly extension: string;
  readonly size: number;
  readonly language?: string;
  readonly classification: SourceClassification;
}

export type SourceClassification =
  | 'source'
  | 'test'
  | 'configuration'
  | 'documentation'
  | 'generated'
  | 'ignored'
  | 'unknown';

export interface DirectoryInfo {
  readonly relativePath: string;
  readonly name: string;
  readonly fileCount: number;
  readonly subdirectoryCount: number;
}

export interface ProjectMarker {
  readonly type: ProjectMarkerType;
  readonly path: string;
  readonly format: string;
}

export type ProjectMarkerType =
  | 'package-json'
  | 'requirements-txt'
  | 'pyproject-toml'
  | 'setup-py'
  | 'setup-cfg'
  | 'pom-xml'
  | 'build-gradle'
  | 'cargo-toml'
  | 'go-mod'
  | 'cmake-lists'
  | 'makefile'
  | 'dockerfile'
  | 'docker-compose'
  | 'tsconfig-json'
  | 'sln'
  | 'csproj'
  | 'gemfile'
  | 'composer-json'
  | 'pubspec-yaml'
  | 'package-swift'
  | 'unknown';

export interface ConfigFile {
  readonly type: ConfigFileType;
  readonly path: string;
  readonly format: string;
}

export type ConfigFileType =
  | 'gitignore'
  | 'env'
  | 'env-example'
  | 'readme'
  | 'license'
  | 'editorconfig'
  | 'prettierrc'
  | 'eslintrc'
  | 'tsconfig'
  | 'babelrc'
  | 'webpack-config'
  | 'vite-config'
  | 'jest-config'
  | 'pytest-ini'
  | 'tox-ini'
  | 'mypy-ini'
  | 'ci-config'
  | 'unknown';

export interface RepoIndicator {
  readonly type: RepoIndicatorType;
  readonly path: string;
}

export type RepoIndicatorType =
  | 'git'
  | 'gitignore'
  | 'github-workflows'
  | 'gitlab-ci'
  | 'jenkinsfile'
  | 'circleci'
  | 'travis'
  | 'azure-pipelines'
  | 'unknown';

export interface ScanError {
  readonly path: string;
  readonly error: string;
  readonly code: string;
}

export interface ToolInstallation {
  readonly name: string;
  readonly command: string;
  readonly version?: string;
  readonly path?: string;
  readonly available: boolean;
  readonly source?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface EnvironmentInfo {
  readonly os: OSInfo;
  readonly runtimes: ReadonlyArray<ToolInstallation>;
  readonly devTools: ReadonlyArray<ToolInstallation>;
  readonly packageManagers: ReadonlyArray<ToolInstallation>;
  readonly containers: ContainerInfo;
  readonly environmentVariables: Readonly<Record<string, string>>;
  readonly scannedAt: Date;
}

export interface OSInfo {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly hostname: string;
  readonly release?: string;
  readonly version?: string;
  readonly type?: string;
  readonly shell?: string;
}

export interface ContainerInfo {
  readonly docker: ToolInstallation;
  readonly dockerCompose: ToolInstallation;
  readonly dockerRunning: boolean;
  readonly dockerInfo?: Readonly<Record<string, unknown>>;
}

// Phase 3: Requirement & Dependency Intelligence types
export interface ProjectRequirement {
  readonly id: string;
  readonly ecosystem: string;
  readonly type: ProjectRequirementType;
  readonly name: string;
  readonly versionConstraint?: string;
  readonly rawConstraint?: string;
  readonly sourceFile: string;
  readonly sourceSection?: string;
  readonly optional?: boolean;
  readonly developmentOnly?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ProjectRequirementType =
  | 'runtime-version'
  | 'language-version'
  | 'package-dependency'
  | 'package-manager'
  | 'toolchain'
  | 'container-image'
  | 'system-tool'
  | 'build-tool'
  | 'custom';

export interface ParsedRequirements {
  readonly projectId: string;
  readonly sourceFiles: ReadonlyArray<string>;
  readonly requirements: ReadonlyArray<ProjectRequirement>;
  readonly parseErrors: ReadonlyArray<RequirementParseError>;
}

export interface RequirementParseError {
  readonly sourceFile: string;
  readonly error: string;
  readonly code: string;
  readonly severity: 'error' | 'warning';
}

export interface VersionConstraint {
  readonly operator: VersionOperator;
  readonly version: string;
  readonly raw: string;
}

export type VersionOperator =
  | '=='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | '~'
  | '~='
  | '^'
  | '*'
  | 'none';

export interface DependencyManifest {
  readonly path: string;
  readonly format: ManifestFormat;
  readonly content: Readonly<Record<string, unknown>>;
  readonly parsedDependencies: ReadonlyArray<ParsedDependency>;
  readonly parseErrors: ReadonlyArray<RequirementParseError>;
}

export interface ParsedDependency {
  readonly name: string;
  readonly versionConstraint: string;
  readonly rawConstraint: string;
  readonly scope?: DependencyScope;
  readonly optional: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeRequirement {
  readonly language: string;
  readonly versionConstraint: string;
  readonly rawConstraint: string;
  readonly sourceFile: string;
  readonly sourceSection?: string;
}

export interface ToolchainRequirement {
  readonly tool: string;
  readonly versionConstraint?: string;
  readonly rawConstraint?: string;
  readonly sourceFile: string;
  readonly sourceSection?: string;
}

export interface ContainerRequirement {
  readonly image: string;
  readonly tag?: string;
  readonly sourceFile: string;
  readonly sourceSection?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
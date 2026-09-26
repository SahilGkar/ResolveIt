# ResolveIt Architecture

## System Overview

```
VS Code Extension
        │
        ▼
ResolveIt Core
        │
        ├── Workspace Manager
        ├── Project Scanner
        ├── Environment Intelligence
        ├── Diagnostic Engine
        ├── Repair Engine
        ├── Verification Engine
        ├── Safety / Permission Layer
        └── Audit Logger
                │
                ├── Language / Ecosystem Analyzers
                ├── Environment Adapters
                └── Tool Registry
                        
Agent Engine
        │
        └── AI Provider Abstraction
              ├── No AI
              ├── Local AI
              └── External AI
```

## Architectural Principles

1. **Deterministic Core** — The core must work without AI. All deterministic diagnostics, repairs, and verifications must function independently of any AI provider.

2. **Optional AI Layer** — AI is an optional reasoning/planning layer. The system must be fully functional with "No AI" provider.

3. **Language Agnostic** — The core contains no language-specific logic. Language/ecosystem-specific behavior is implemented through pluggable analyzers and adapters.

3. **Pluggable Analyzers/Adapters** — Language/ecosystem-specific behavior must use pluggable analyzers/adapters. Adding a new ecosystem (Python, JavaScript/TypeScript, Java, Go, Rust, C/C++, C#, Ruby, PHP, Kotlin, Swift, etc.) must not require modifying the core architecture.

4. **No Unrestricted AI Access** — The AI must never receive unrestricted shell access. All AI interactions must go through controlled, audited interfaces.

5. **Controlled Modifications** — All modifications must go through controlled tools. No direct file system or shell access for AI.

6. **Safety by Default** — Project/system-changing actions require user approval according to the safety policy. Three action levels with escalating approval requirements.

7. **Verification Required** — Every repair must be followed by verification. The system must confirm that repairs achieved their intended effect.

8. **Re-planning on Failure** — Failed verification must support agent re-planning. The agent can observe the failure, analyze, and create a new plan.

9. **Extension as UI Layer** — The VS Code extension is a UI/integration layer, not the entire application. Core logic resides in the ResolveIt Core.

10. **Replaceable AI Providers** — AI providers must be replaceable. The architecture supports No AI, Local AI, and External AI providers through a common abstraction.

11. **No Provider Lock-in** — The core must not depend on Ollama, OpenAI, Gemini, Claude, or any specific AI provider.

## Core Components

### Workspace Manager
Manages workspace state, project discovery, and cross-project relationships.

### Project Scanner
Discovers and analyzes projects within the workspace. Identifies project types, manifests, and configurations.

### Environment Intelligence
Gathers and maintains environment state: installed tools, runtimes, package managers, system configuration.

### Diagnostic Engine
Runs deterministic diagnostics against projects and environments. Produces structured diagnostic results.

### Repair Engine
Executes approved repair actions. Coordinates with permission layer for user approval.

Phase 5 implementation (`src/repair/`):
- `RepairPlannerImpl` — builds a `RepairPlan` from diagnostic `remediationCandidates`,
  honoring `PlanContext.constraints` (`allowedActions`, `maxRiskLevel`). Every planned
  action carries `workspaceRoot` in its parameters, scoped from `context.workspace.rootPath`,
  so tools never guess the workspace. `validatePlan` rejects actions missing `id`/`type`.
- `RepairToolRegistryImpl` — only registered `RepairTool`s may execute. `findToolForAction`
  selects among tools supporting the action type and prefers the first tool whose
  `validate(action)` passes, falling back to the first candidate. There is no
  unrestricted `execute(command: string)` repair API.
- `BaseRepairTool` — shared contract (`validate`/`execute`) plus hardened path helpers:
  `resolveWorkspaceRoot` (explicit `parameters.workspaceRoot`, else `action.target.filePath`;
  fails with a structured validation error when neither is present — never silently
  falls back to `process.cwd()`), `validateWorkspacePath` (rejects `..` segments and any
  resolved path outside the workspace using `path.relative` with drive-letter/UNC handling
  instead of string-prefix checks), and `writeFile` (creates parent dirs via `dirname`).
- `CreateFileTool` (`project-modification`) — creates files with validated content inside
  the workspace. `ModifyFileTool` (`project-modification`) — deterministic single
  first-occurrence text replacement; fails when the search text is absent; dry-run returns
  before touching the filesystem.
- `InstallDependencyTool` (`project-modification`) — package installation commands are
  constructed internally from validated structured parameters (`ECOSYSTEM_COMMANDS` for
  npm/pip/cargo/go/composer/bundler). Package names and versions are allowlist-validated
  (rejects shell metacharacters, whitespace, flag injection such as `--save-dev` as a
  package name, and path traversal); arbitrary shell command strings are never accepted.
- `CreatePythonVenvTool` (`project-modification`) — runs `<python> -m venv <path>` with the
  interpreter restricted to an allowlist (`python`, `python3[.x]`, `py`, `python.exe`) and
  the target path confined to the workspace.
- `RepairExecutor` — per-plan execution: permission check (via `approvalCallback` or
  `PermissionManager`), pre-execution audit entry (`pending`/`failure`), tool lookup,
  tool validation, snapshot of `affectedFiles` (skipped in dry-run), tool execution, and
  post-execution audit entry (`success`/`failure`). Actions without `allowed` approval
  never execute. Snapshot/audit managers are scoped to the `executePlan` workspace root.
- `SnapshotManager` — persists per-action file snapshots under `.resolveit/snapshots` and
  restores them on rollback; missing/corrupt snapshots report failure (`false`) instead
  of throwing.
- `AuditLoggerImpl` — appends JSONL audit entries per day under `.resolveit/audit`.
  All logged parameters pass through `sanitizeParameters`, which redacts sensitive keys
  (password, secret, token, apiKey, authorization, privateKey, credentials, including
  nested objects) so secrets are never written to logs.

### Verification Engine
Verifies that repairs achieved their intended effect. Runs post-repair diagnostics.

### Safety / Permission Layer
Enforces safety policy. Manages approval flows for three action levels:
- **Read-only**: Inspect files, environment, tools, dependencies, run safe diagnostics
- **Project modification**: Install dependencies, modify manifests, create environments, update configuration
- **System-level modification**: Install system software, modify system configuration, require administrator privileges

Phase 5 implementation (`src/safety/permission.ts`, enforced in `src/repair/index.ts`):
- `getActionRiskLevel` maps each `RepairActionType` to a `RiskLevel`; unknown types default
  to `read-only`.
- `checkPermission` returns `allowed` for read-only (when `autoApproveReadOnly`), and
  `requires-approval` for project/system modifications under the default policy. System
  modifications can additionally be `denied` by policy and are never executed silently.
- `PermissionManagerImpl` caches per-action decisions, supports `recordDecision` overrides
  and policy updates, and `requestApproval` returns an `ApprovalResult` distinguishing
  auto-approved, denied-by-policy, and requires-user-approval outcomes.
- The executor runs a tool only when the decision is exactly `allowed`. Dry-run mode
  short-circuits before any filesystem or process side effect (no file writes, no snapshot
  writes for the action, no spawned installs), and denied actions produce a `failure` audit
  record without executing.
- CLI (`resolveit repair`): `--dry-run`/`--json` only print the plan; without `--approve <action-id>`
  each action is presented for approval and skipped unless explicitly approved.

### Audit Logger
Records all actions, decisions, and outcomes for traceability and debugging.
See Repair Engine above for the Phase 5 `AuditLoggerImpl` (JSONL records for
pending/success/failure outcomes with secret redaction).

### Language / Ecosystem Analyzers
Pluggable analyzers for specific languages/ecosystems. Implement language-specific diagnostic and repair logic.

### Environment Adapters
Pluggable adapters for different environments (local, container, remote, CI/CD).

### Tool Registry
Registry of known tools, their capabilities, and how to invoke them.

## Agent Engine

### AI Provider Abstraction
Common interface for AI providers supporting:
- Receiving structured project/environment/diagnostic evidence
- Generating diagnosis/reasoning results
- Generating repair plans

Providers:
- **No AI** — Deterministic fallback, no AI calls
- **Local AI** — Locally running models (future)
- **External AI** — API-based providers (future)

## Agent Lifecycle

```
OBSERVE
   ↓
ANALYZE
   ↓
PLAN
   ↓
REQUEST USER APPROVAL
   ↓
ACT
   ↓
VERIFY
   ↓
RESOLVED
   or
RE-PLAN
```

### Lifecycle Stages

1. **OBSERVE** — Gather project, environment, and diagnostic evidence
2. **ANALYZE** — Process evidence, identify root causes
3. **PLAN** — Create repair plan with specific actions
4. **REQUEST USER APPROVAL** — Present plan to user for approval (per safety policy)
5. **ACT** — Execute approved actions through repair engine
6. **VERIFY** — Run verification to confirm repair success
7. **RESOLVED** — Issue resolved, record outcome
8. **RE-PLAN** — If verification fails, return to ANALYZE with new evidence

## Data Models

Core data models (defined in `src/core/models.ts`):
- `Project` — Project metadata, type, manifest, dependencies
- `Workspace` — Workspace containing multiple projects
- `Language/Ecosystem` — Language identification and capabilities
- `Environment` — Runtime, tools, package managers, system info
- `Requirement` — Version constraints, compatibility rules
- `Dependency` — Package dependencies with versions and sources
- `Diagnostic` — Structured diagnostic result with severity, location, message
- `RepairAction` — Single atomic repair operation
- `RepairPlan` — Ordered sequence of repair actions
- `VerificationResult` — Result of post-repair verification
- `AgentState` — Current state in agent lifecycle

## Safety Architecture

### Action Levels

| Level | Examples | Approval |
|-------|----------|----------|
| Read-only | Inspect files, environment, tools, dependencies, run safe diagnostics | Implicit |
| Project modification | Install dependencies, modify manifests, create environments, update configuration | Explicit user approval |
| System-level modification | Install system software, modify system configuration, require admin privileges | Explicit user approval + confirmation |

Higher-risk actions require explicit user approval. The permission layer enforces this at the API boundary.

## AI Provider Interface

```typescript
interface AIProvider {
  readonly type: 'none' | 'local' | 'external';
  readonly name: string;
  
  diagnose(evidence: AgentEvidence): Promise<DiagnosisResult>;
  planRepair(diagnosis: DiagnosisResult, context: PlanContext): Promise<RepairPlan>;
}
```

No implementation of specific providers (Ollama, OpenAI, etc.) in Phase 0. The interface exists to allow future implementation.

## Extension Points

1. **Language Analyzers** — Implement `LanguageAnalyzer` interface
2. **Environment Adapters** — Implement `EnvironmentAdapter` interface  
3. **Tool Registry Entries** — Register tools with capabilities
4. **AI Providers** — Implement `AIProvider` interface
5. **Repair Tools** — Implement `RepairTool` interface
6. **Verification Rules** — Implement `VerificationRule` interface

## Non-Goals (Phase 0)

- Diagnostic engine implementation
- AI agent implementation
- Language analyzers
- VS Code extension
- Docker/database/web UI
- Any autonomous behavior

## Phase 12 Status (Implemented): Final Integration & Release Validation

Phase 12 added no new subsystem. It validated the composed product, fixed the
integration defects found, and left the repository shippable:

- **Release matrix** (`tests/fixtures/integration/`, `tests/integration-release.test.ts`):
  healthy fixtures for Node/Python/Go/Rust/Java/C++ (zero blocking
  diagnostics under a controlled environment, deterministic planner proposes
  nothing), broken fixtures (runtime mismatch → blocking error with evidence
  and a manual remediation path; malformed manifest → parse-error diagnostic;
  privileged/socket Compose → critical diagnostic-only findings; secret project
  → no leakage into requirements, diagnostics, or audit), multi-project and
  nested fixtures (boundaries, requirement ownership, no double counting,
  stable ordering).
- **Truthfulness**: denied → not performed/not resolved; failed validation →
  recorded failure; approved + verified → resolved; approved but persisting →
  verification failure, never false success. Covered with real planner,
  executor, and verifier components.
- **Determinism**: repeated runs are byte-identical after normalizing
  ephemeral ids/timestamps (absolute workspace roots are test-harness paths,
  not product nondeterminism). Ephemeral `Date.now()` parser/diagnostic ids
  were deliberately kept: they never feed correlation, caching, or UI state.
- **Failure injection**: AI timeout/unavailable/malformed/hostile transport
  (mocked fetch for both local and external providers) → deterministic
  fallback, never bypass; throwing repair tool → recorded failure plus audit
  entry (executor now guards `tool.execute` — the one robustness fix of this
  phase); vanished workspace → failed with a useful error; concurrent runs
  stay independent (distinct runIds).
- **Agent loop**: illegal transitions rejected, max iterations enforced,
  failed-action fingerprints prevent repeat planning, events ordered.
- **Release fixes**: `package.json` entry points corrected (`main`,
  `bin.resolveit`, and the `cli` script pointed at non-existent
  `dist/cli.js`; the real entry is `dist/cli/index.js`), so the published
  binary actually launches.
- **Validation performed**: full core + extension suites green, CLI
  walkthrough (scan/environment/requirements/diagnose/run/repair/ai, human
  and JSON, missing-workspace error path, secret-project leak check), real
  VSIX packaging with `vsce` (manifest + readme + 393 KiB bundle only) plus
  install/list/uninstall round-trip against VS Code 1.138.0. Interactive GUI
  operation was not performed (no display automation available); the
  headless suite (73 tests incl. lifecycle, concurrency, approval, error
  taxonomy, packaging parity) plus the bundle activation smoke test is the
  strongest available substitute. Manual validation was performed on Windows;
  Linux/macOS rest on unit coverage.

## Phase 11 Status (Implemented): Security, Docker & Audit Hardening

Phase 11 makes ResolveIt conservative, auditable, and difficult to misuse. It
adds no generic command execution, no privilege escalation, and no autonomous
security scanner; every control protects a concrete boundary:

```text
Untrusted project
      ↓
Static analysis (never executes project-controlled code)
      ↓
Structured evidence (summaries, secrets redacted, .env never read)
      ↓
AI reasoning (optional; output is untrusted data)
      ↓
Validated action (tool allowlist, parameter allowlist, path checks)
      ↓
Permission boundary (PermissionManager; AI cannot approve or escalate)
      ↓
Allowlisted repair tool (structured args, safe command runner)
      ↓
Audit (sanitized, correlated by runId/actionId)
      ↓
Verification
```

### Threat model

- **T1 — Malicious project.** Analysis is read-only and static: the scanner
  never follows symlinks (`src/scanners/scanner.ts`), `setup.py` is never
  executed, manifests over 1 MiB are skipped with a warning, and at most 500
  manifest files are parsed per run. Repair tools resolve every write target
  through canonical containment plus symlink resolution and fail closed.
- **T2 — Malicious or compromised AI output.** `validateAIPlan`
  (`src/ai/validation.ts`) enforces: known tools only, parameter allowlist,
  privilege/command-field rejection (including `spawn`), relative in-workspace
  paths only for path parameters, per-parameter and total size caps, nesting
  depth cap with circular-payload rejection, at most 16 actions per plan, and
  tool-owned permission levels. `parseAIPlanningResponse` rejects responses
  over 256 KiB and action lists over 32 entries. The planning prompt states
  that project content is untrusted data, never instructions.
- **T3 — Malicious repair parameters.** `checkWorkspaceContainment`
  (`src/safety/paths.ts`) decodes percent-encoded traversal (multi-round),
  rejects NUL/control characters, UNC paths, and out-of-workspace drive
  roots, and uses `path.relative` segment checks instead of string prefixes.
  Package names/versions reject shell metacharacters, leading dashes (flag
  injection), whitespace, and traversal; the Python interpreter is restricted
  to an allowlist pattern. The safe command runner re-validates executable
  (bare allowlisted name only), arguments (no shell metacharacters), and
  working directory (inside the allowed root).
- **T4 — Sensitive information.** `src/safety/secrets.ts` provides
  key-based sanitization, bearer/Basic/API-key/private-key text redaction,
  environment-variable scrubbing, and `.env` detection. `.env` files are never
  parsed as requirements; the AI context carries summaries only with evidence
  truncated and redacted; audit records, repair errors, child-process output,
  agent run snapshots, and VS Code logs pass through redaction. Redaction is
  defense-in-depth, not a perfect secret detector.
- **T5 — Docker risk.** `dockerSecurityDiagnosticRule`
  (`src/diagnostics/rules/docker-security.ts`) performs diagnostic-only static
  analysis of Dockerfiles and Compose files: privileged mode (critical),
  Docker socket mounts (critical), host filesystem mounts (error/warning),
  host networking and host PID/IPC (error), dangerous capabilities
  (error), unpinned images (warning, framed as posture, never malicious), and
  broad build contexts (warning). Findings extend the existing `Diagnostic`
  model with file/line evidence and manual remediation guidance; they carry
  no remediation candidates, so no repair tool can auto-apply them. Docker is
  never started, and images are never built, during diagnostics.

### Filesystem boundary

Lexical containment (`checkWorkspaceContainment`) plus execution-time symlink
verification (`verifyNoSymlinkEscape`): the nearest existing ancestor of the
target is resolved with `realpath` and must remain inside the workspace's
real path. Any inspection failure refuses the write. Behavior is documented
as fail-closed; symlink handling does not vary by OS beyond what
`lstat`/`realpath` report.

### AI trust boundary

Project content is evidence, not authority. AI output can only name
registered tools with allowlisted parameters; workspace roots are overwritten
with the run root; permission levels come from the tool, never the model.
Deterministic tool validation and `PermissionManager` re-check every
AI-proposed action before execution, and the agent falls back to
deterministic planning when AI output is fully rejected
(`src/agent/ai-planner.ts`).

### Command execution policy

Two runners (`src/environment/command-runner.ts`): the generic
`createCommandRunner` runs only ResolveIt-authored detection probes with
fixed arguments (never project- or AI-controlled strings). All repair-time
execution uses `createSafeCommandRunner` with a per-tool executable
allowlist, structured pre-validated arguments, working-directory containment,
a scrubbed environment (safe keys only plus explicit extras), enforced
timeouts (capped at 120 s), 256 KiB output caps, and secret redaction on all
captured output. On Windows the shell is enabled only for allowlisted
executables whose arguments have already passed metacharacter rejection.

### Audit model

`AuditLoggerImpl` (`src/repair/index.ts`) appends sanitized JSONL entries and
implements a deterministic file-backed `query`: filter by action/run/
workspace/time, stable timestamp ordering, bounded results (default 200),
malformed records skipped. Entries correlate
`runId → plan → action → approval → execution → verification` using
collision-resistant `randomUUID`-based identifiers (`src/safety/ids.ts`;
replaces the previous `Date.now()` IDs for audit/repair correlation).
Requirement/parser IDs remain ephemeral scan-local labels and are not
used for correlation. Never logged: API keys, bearer tokens, full `.env`,
secret environment variables, unnecessary file contents, or raw sensitive
prompts.

### Important limits (`src/safety/limits.ts`)

Paths 1024 chars; repair content 256 KiB; find/replace 64 KiB each; AI
response 256 KiB / 16 actions / 16 KiB per parameter set / depth 5; audit
query 200 results / 5 MiB scanned; command output 256 KiB / timeout 120 s;
requirement files 1 MiB / 500 files; Dockerfile analysis 512 KiB / 50
findings; AI context 100 diagnostics / 500 requirements with 2000-char
evidence. Limits are generous enough for normal projects; oversized inputs
degrade to explicit warnings or manual actions, never silent truncation of
security decisions.

## Phase 10 Status (Implemented): Multi-Ecosystem Hardening

### Project detection and multi-project model

Manifest discovery (`RequirementManagerImpl.findRelevantFiles`) matches basenames
and relative paths against an extended pattern list (lockfiles, `go.work`,
`meson.build`, `conanfile.*`, `vcpkg.json`, `*.gemspec`, `composer.lock`,
`global.json`, `packages.config`, `Directory.Packages.props`,
`libs.versions.toml`, wrapper properties, `compose.*`, …) with shared
case-insensitive wildcard matching (`src/requirements/projects.ts`).

Each discovered manifest is attributed to the nearest ancestor manifest directory
(`assignProject`); nested projects keep their own `projectId`/`projectRoot` and
files are never double-counted. Results are sorted by source file and deduplicated
within each file, so repeated scans produce identical output. The scanner's
workspace/project listing is unchanged; attribution lives in the requirement layer.

### Ecosystem analyzer registry

One parser class per format family, registered by filename (`RequirementParser`
interface unchanged): Python (requirements/PEP 621/poetry/setup.cfg/static
setup.py/Pipfile/locks), Node (manifest + npm/yarn/pnpm/bun lockfiles + volta
pins), Maven (properties resolution, managed-scope exclusion, parent, wrapper),
Gradle (toolchain DSL, version catalog, wrapper, duplicate elimination, dynamic
markers), Go (`go.mod` blocks/indirect/replace/exclude, `go.work`), Rust
(hyphenated names, workspace inheritance without invented versions, members,
`Cargo.lock`), CMake (`find_package` versions/components, standards, languages),
Meson/Conan/vcpkg, Ruby (Gemfile/groups/gemspec/`Gemfile.lock`), PHP
(`ext-*` system tools, dev sections, both lock sections), .NET
(multi-framework, SDK pins, central packages, solutions, legacy configs), Docker
(digests, platforms, registries with ports, build args, compose builds).
`setup.py` is never executed: dynamic declarations yield an explicit
`DYNAMIC_DECLARATION` warning.

### Normalized requirements and lockfiles

`ProjectRequirement` gains optional `resolvedVersion`, `origin`
(`direct`/`transitive`/`lockfile`), and `lockfileSource`; requested ranges stay in
`versionConstraint`. Lockfile/transitive entries are never proposed for direct
installation by the deterministic planner (manual guidance instead).
Version matching normalizes `v` prefixes, `===`, wildcards (`1.2.x`, `1.*`,
`1.+`), `||` unions, hyphen ranges, Maven `[a,b)` ranges, Gradle dynamic
markers, and PEP 440 compatible releases, with prefix semantics for bare partial
versions (`go 1.22` matches `1.22.x`). The matcher interface is unchanged.

### Deterministic diagnostics

Improved requirements flow through the existing engine untouched: runtime,
toolchain, container, dependency, build, and project rules plus an informational
cross-project rule that notes exact-version runtime divergence across projects
without inventing relationships. Identical requirements in nested projects keep
collapsing to one diagnostic via the existing dedup key.

## Phase 9 Status (Implemented): Extension ↔ Core Integration Hardening

The extension stays a thin client; Phase 9 hardens the orchestration boundary
without adding features or services:

```text
VS Code UI
    ↓  commands, views, dialogs, progress, status bar
Extension orchestration/state (`vscode/src`)
  workspace service, operation coordinator, run scopes, error taxonomy
    ↓  public Core API only (`src/index.ts`)
Core engine/safety/agent (authoritative for logic and security decisions)
```

- **Workspace lifecycle** (`vscode/src/workspace.ts`, `state.bindWorkspace`):
  centralized deterministic resolution (first folder wins), one-time multi-root
  notice per change, state stamped to and cleared on workspace switches/close,
  per-operation freshness guards discard results for roots that are no longer
  active. Folder-change and configuration-change listeners refresh state, views,
  status, and AI status.
- **Concurrency/cancellation** (`vscode/src/operations.ts`): per-workspace locks
  reject duplicate invocations with friendly messages (`run`/`repair` mutually
  exclusive); cooperative cancellation detaches the UI, reports cancellation
  (never success), discards late results, and always cleans up. Core operations
  are not abortable — documented, not faked.
- **Events** (`vscode/src/ui/events.ts`): per-run `RunEventScope` closes in
  `finally`; late/stale events from finished or superseded runs are ignored, so
  completed runs cannot update the UI and the status bar tracks the latest run.
- **Errors** (`vscode/src/errors.ts`): classified kinds (no/invalid workspace,
  config, AI unavailable, permission, repair/verification failure, busy,
  cancelled, unexpected) with actionable user messages and redacted channel logs.
- **Repair/verify reporting**: the UI separates Approved → Executed → Succeeded →
  Verified from Core results; verification failures warn instead of resolving.
- **Packaging**: `.vscodeignore` ships only manifest, bundle, and readme;
  `scripts/validate-package.mjs` checks command/view/config/activation parity,
  bundle freshness, and hygiene (`npm run validate-package`).
- **Tests**: `vscode/tests/integration.test.ts` covers lifecycle, concurrency,
  scopes, error taxonomy, repair stages, config/secrets, packaging parity, and a
  temporary-fixture diagnose→deny→verify flow. No VS Code instance required.

## Phase 8 Status (Implemented): VS Code Extension

The extension (`vscode/`) is a thin client over ResolveIt Core:

```text
VS Code Extension
  activation, commands, tree views, dialogs, progress, status bar, output channel
        │  direct TypeScript import, esbuild bundle (`vscode` external)
        ▼
ResolveIt Core (`src/index.ts`)
  Discovery · Environment · Requirements · Diagnostics · Repairs ·
  Verification · Agent · AI Providers
```

- **Manifest** (`vscode/package.json`): 7 commands (`resolveit.scan`, `resolveit.diagnose`,
  `resolveit.run`, `resolveit.environment`, `resolveit.requirements`, `resolveit.repair`,
  `resolveit.verify`), 4 Explorer views (project, diagnostics, environment, requirements),
  settings (`resolveit.ai.provider|model|baseUrl|timeout`, `resolveit.maxIterations`),
  activation on commands or common manifests. No marketplace publication.
- **Core integration** (`vscode/src/core.ts`): `CoreClient` thin wrappers over Core
  exports only — no duplicated engines. Agent runs reuse `AgentRunner` + AI planner;
  verification compares fresh diagnostics against previous ones via stable keys.
- **UI**: diagnostics tree grouped Critical/Errors/Warnings/Info with message,
  evidence, expected/actual, file open (`vscode.open`), and remediation display;
  environment/requirements trees render Phase 2/3 output; repair plans print to the
  `ResolveIt` output channel with per-action QuickPick approval (`Allow`/`Deny`);
  agent `onEvent` callbacks drive `withProgress` notifications and the status bar
  (`✓`, `⚠ n issues`, `⏳ activity`); AI status shows provider/model/URL/availability,
  never keys.
- **Safety preserved**: approvals are collected, not granted, by the UI; Core
  `PermissionManager`/`RepairExecutor` remain authoritative; secrets redacted from logs.
- **Tests**: `vscode/tests/` run under vitest with a mocked `vscode` API (alias),
  covering commands, workspace none/single/multi handling, core integration,
  diagnostic/severity mapping, approval, event→UI mapping, AI/config mapping, error
  handling — plus a bundle smoke test proving the packaged `dist/extension.js`
  activates. No VS Code instance required.
- **Build**: `cd vscode && npm install && npm run build` (typecheck + esbuild bundle);
  VS Code-only dependencies (`@types/vscode`, `esbuild`, `vitest`, `uuid` for the
  bundled core) stay inside `vscode/`.

## Phase 7 Status (Implemented): AI Provider Abstraction

> AI is optional. ResolveIt's deterministic core works without AI.

### Provider abstraction (`src/ai/`)

The Phase 0 `AIProvider` contract (`type`, `name`, `version`, `isAvailable`,
`diagnose`, `planRepair`) is preserved and extended with an optional
`generatePlan(context: AIPlanningContext): Promise<AIPlanningResult>` capability —
existing providers keep working without implementing it. Provider types remain
`none | local | external` (`AI_PROVIDER_TYPES`); the legacy `createAIProvider`
factory is unchanged, and `createAIProviderFromConfig` builds Phase 7 providers.

- **No AI** (`NoAIProvider`, `src/ai/providers.ts`) — no `generatePlan`, no network
  calls. The agent treats it as deterministic-only and logs an explicit fallback.
- **Local AI** (`LocalAIProvider`, `src/ai/providers/local.ts`) — Ollama-compatible
  `POST {baseUrl}/api/chat` (`stream: false`, `format: 'json'`), availability via
  `GET {baseUrl}/api/tags`. No model is hard-coded or downloaded; missing model
  configuration fails cleanly with `not-configured`.
- **External AI** (`ExternalAIProvider`, `src/ai/providers/external.ts`) —
  OpenAI-compatible `POST {baseUrl}/chat/completions` (`temperature: 0`,
  `response_format: json_object`), availability via `GET {baseUrl}/models`. No
  vendor is hard-coded; no API key is required to run the project.

HTTP uses the Node.js built-in `fetch` with `AbortController` timeouts
(`src/ai/http.ts`); the fetch implementation is injectable so tests never touch the
network. No vendor SDK dependencies were added.

### Provider configuration (`src/ai/config.ts`)

`AIConfig` (`provider`, `model`, `baseUrl`, `apiKey`, `timeoutMs`) resolves with
deterministic precedence: explicit/CLI overrides → `RESOLVEIT_AI_PROVIDER`,
`RESOLVEIT_AI_MODEL`, `RESOLVEIT_AI_BASE_URL`, `RESOLVEIT_AI_API_KEY`,
`RESOLVEIT_AI_TIMEOUT_MS` → safe defaults (`none`, 30s timeout,
`http://localhost:11434` for local). Unknown provider values coerce to `none`.
`sanitizeAIConfig` exposes only `apiKeyConfigured: boolean` — keys never appear in
status output, logs, or events.

### AI context boundary (`src/ai/context.ts`)

`buildAIPlanningContext` sends summaries only: workspace/project counts and names,
runtime/tool names and versions, requirement descriptors, blocking diagnostics with
expected/actual evidence, the tool allowlist, permission constraints, previous
attempt fingerprints, and the last verification summary. Environment variable values,
file contents, and `.env` data are never included.

### Structured output and validation

`buildPlanningPrompt` (`src/ai/prompt.ts`) states the safety boundary explicitly
("You are proposing actions. You are not executing actions. You cannot grant
yourself permission. Only registered ResolveIt RepairTools may execute actions.").
`parseAIPlanningResponse` (`src/ai/response.ts`) accepts JSON or fenced JSON and
schema-validates shape only. `validateAIPlan` (`src/ai/validation.ts`) enforces the
execution boundary:

```text
AI output → parse → schema → tool existence → parameter allowlist →
privilege/command-field rejection → RepairAction (tool-owned permission) →
tool.validate() → PermissionManager
```

Unknown tools, stray parameters, path traversal, bad package names, arbitrary
`command`/`shell`/`exec` fields, and `permissionLevel`/`approval` keys (escalation
attempts) are rejected. AI-supplied `workspaceRoot` values are overwritten with the
run root. The AI can never assign permission levels.

### Failure behavior and agent integration (`src/agent/ai-planner.ts`)

`createAIPlanner` adapts any `AIProvider` to the Phase 6 `PlannerFn`: unavailable,
timed-out, malformed, refused, rate-limited, or fully-rejected AI output falls back
to `DeterministicRepairPlanner` with an explicit logged reason; partial valid output
uses the valid subset (rejections recorded on the plan). Re-planning passes the new
verification summary and previous attempts to the model; Phase 6 fingerprint loop
prevention remains authoritative. AI never controls state transitions.

### Security boundaries

API keys travel only in the outbound `Authorization` header, never in prompts,
contexts, events, audit records, diagnostics, or error messages. The exposed tool
surface is name/description/allowed-parameters/permission-level only.

## Phase 6 Status (Implemented): Verification & Agent Loop

### Lifecycle

```text
idle
  → observing      (workspace/environment/requirement scan)
  → analyzing      (deterministic diagnostics; no blockers → resolved)
  → planning       (deterministic plan from blocking diagnostics)
  → awaiting-approval   (dry-run and manual plans stop here or after)
  → acting         (approved actions via Phase 5 RepairExecutor)
  → verifying      (re-observe, re-diagnose, targeted checks)
  → resolved | replanning | failed
replanning → analyzing → planning ...
```

### State machine (`src/agent/run-state.ts`)

Explicit `AgentRunState` model (`idle`, `observing`, `analyzing`, `planning`,
`awaiting-approval`, `acting`, `verifying`, `resolved`, `replanning`, `failed`) with a
guarded transition table (`AGENT_RUN_TRANSITIONS`, `assertRunTransition` rejects arbitrary
jumps). `toLifecycleStage` maps each run state onto the Phase 0 `AgentLifecycleStage`
(`src/agent/lifecycle.ts` is preserved unchanged).

### Observation (`src/agent/observation.ts`)

`observeWorkspace` reuses Phase 1–3 services (`scanWorkspace`, `scanEnvironment`,
`scanRequirements`) and returns a structured `AgentObservation`
(workspace, environment, requirements, timestamp). No scanner duplication.

### Analysis (`src/agent/analysis.ts`)

`analyzeObservation` runs the existing deterministic Diagnostic Engine over the
observation — no new diagnostic rules. Blocking diagnostics are `error`/`critical`
severity; a run with none resolves immediately. `diagnosticKey` provides stable,
re-runnable identity (category/code/requirement/file, never random ids).

### Planning (`src/agent/deterministic-planner.ts`)

`DeterministicRepairPlanner` maps blocking diagnostics to controlled actions, gated by
the real Phase 5 tool validators (an action is only planned if its tool accepts it):
- `package-dependency` with a supported ecosystem (node→npm, python→pip, rust→cargo,
  go→go, php→composer, ruby→bundler) → `install-dependency`
- `MISSING_REQUIRED_FILE` with a safe `{path, content}` payload → file creation
- `MISSING_PYTHON_VENV` with a safe `{path}` payload → venv creation
- `CONFIG_VALUE_MISMATCH` with a safe `{path, find, replace}` payload → file modification
- runtime/toolchain/build/container diagnostics → system-level manual action
- anything unknown → project-level manual action (`manual_action_required` semantics)

Planning never executes anything. Duplicate candidates are deduplicated.

### Approval boundary (`src/agent/runner.ts`)

The runner stops at `awaiting-approval` before executing. Dry runs terminate there.
Otherwise an approval callback supplies approved action ids (default: deny all).
Read-only actions auto-approved by policy may proceed; project/system modifications
require explicit approval through the Phase 5 `PermissionManager` — the agent never
approves its own plan. Zero approvals with executable actions fails as
`approval-denied`; executable-free plans with manual actions finish as
`manual-action-required` with an explanation.

### Action execution

The runner uses the existing Phase 5 `RepairExecutor` (no second execution mechanism),
records per-action success/failure/denial, audit data, and snapshot information, and
stores sanitized copies (see below).

### Verification (`src/agent/verifier.ts`)

`VerificationEngineImpl` implements the Phase 0 `VerificationEngine` interface
(`verify`, `registerVerificationRule`) and adds `verifyPlan`:
- Diagnostic re-run: compares blocking diagnostic keys before/after (resolved vs
  persisting vs new regressions).
- Targeted checks (filesystem only, no shell): created file exists with expected
  content, modified file contains the replacement, venv directory exists, installer
  outcome recorded with its no-inventory limitation stated.
- Custom `VerificationRule`s run per action and AND into the result.
Success requires zero remaining blocking diagnostics and zero failed targeted checks —
exit codes alone never imply success.

### Re-planning and loop prevention

Failed verification re-observes and re-analyzes (new evidence feeds the next plan),
up to `maxIterations` (default 3, `DEFAULT_MAX_ITERATIONS`), then `failed` with the
verification summary. `actionFingerprint` (stable hash of type/target/parameters,
excluding workspace root) tracks failed actions per run; the planner skips
already-failed fingerprints so identical unsuccessful actions are never repeated.

### Run context and events

`AgentRunContext` tracks run id, workspace, state, observations, analyses, plans,
approvals, executed actions, verification reports, failed fingerprints, iteration
count, timestamps, and the event trail. Stored observations/analyses/plans use
`sanitizeParameters` (environment variable values and remediation payloads redacted);
`.env` contents are never read. Structured `AgentEvent`s
(`observation-started`, …, `plan-created`, `approval-requested/granted/denied`,
`action-started/completed/failed`, `verification-started/completed`, `replanning`,
`resolved`, `failed`) are emitted via callback for future UI integration.

### CLI

`resolveit run [-p <path>] [--dry-run] [--json] [--approve <action-id>]` runs the
deterministic lifecycle without AI. Dry run observes, analyzes, plans, shows required
permissions, and stops before modifications. Normal execution still requires explicit
`--approve` per action id.

## Phase 5 Status (Implemented)

- Repair tool registry with validating-tool selection (`src/repair/registry.ts`)
- Four project-modification repair tools: file creation, file modification,
  dependency installation (npm/pip/cargo/go/composer/bundler), Python venv creation
- Permission manager with read-only / project-modification / system-modification levels
- Repair executor with approval gating, dry-run, snapshots, and audit logging
- Audit secret redaction via `sanitizeParameters`
- CLI: `resolveit repair [--dry-run] [--json] [-p <path>] [--approve <action-id>]`
- Regression tests: `tests/repair-tools.test.ts`, `tests/repair-extended.test.ts`,
  `tests/diagnostics.test.ts`

## Deferred / Known Limitations

- Real dependency installs and venv creation spawn subprocesses (`shell: true` on Windows
  for `.cmd` shims); inputs are allowlist-validated but execution still depends on host tools.
- Snapshots cover file content only (no manifest/dependency-state rollback).
- `AuditLoggerImpl.query` is a stub returning no results.
- The deterministic agent loop retries up to `maxIterations` (default 3); beyond that,
  unresolved runs fail with an explanation rather than retrying indefinitely.
- Requirement parsing is static: dynamic `setup.py` logic, Gradle Kotlin/Groovy
  expressions, and arbitrary CMake code degrade to explicit warnings rather than
  invented versions. There is no universal semantic version solver; `go.sum`
  integrity files and binary `bun.lockb` files are recognized but not parsed.
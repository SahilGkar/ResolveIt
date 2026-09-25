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
- The executor has no retry/re-plan loop; failed verification re-planning belongs to Phase 6.
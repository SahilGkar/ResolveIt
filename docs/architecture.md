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
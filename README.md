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

Phase 7: AI Provider Abstraction (current)

Deterministic core (Phases 1–6) works fully without AI. AI planning is optional.

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

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build

# CLI
npx resolveit --help
npx resolveit --version
```
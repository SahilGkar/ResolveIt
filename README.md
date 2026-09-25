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

Phase 0: Architecture & Project Foundation (current)

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
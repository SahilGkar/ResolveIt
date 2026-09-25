# AGENTS.md — ResolveIt Development Rules

## Purpose
This file contains persistent development rules for all OpenCode sessions working on ResolveIt.

## Core Principles

1. **Phase Discipline** — Never implement features from future phases. Complete the current phase fully before moving on.
2. **No External Dependencies** — No API keys, no Ollama, no LLM integration, no external API calls in Phase 0.
3. **Interfaces First** — Define contracts before implementations. Use TypeScript interfaces for all core components.
4. **Language Agnostic** — Core must not contain language-specific logic. Use pluggable analyzers/adapters.
5. **Safety by Default** — All modifications go through permission layer. Higher-risk actions require explicit approval.
6. **Verification Required** — Every repair must be followed by verification. Failed verification enables re-planning.
7. **Clean Code** — No unnecessary comments. Follow existing code conventions. Minimal, maintainable implementations.
8. **Test First** — Tests verify contracts exist and imports work. Keep tests small and deterministic.

## Forbidden in Phase 0

- ❌ Diagnostic engine implementation
- ❌ AI agent implementation
- ❌ Language analyzers
- ❌ Repair system
- ❌ VS Code extension
- ❌ Package installation logic
- ❌ Docker/database/web UI
- ❌ Any autonomous behavior

## Required in Phase 0

- ✅ Repository initialization
- ✅ Architecture documentation
- ✅ Core interfaces/contracts
- ✅ Foundational data models
- ✅ AI provider abstraction (interface only)
- ✅ Safety architecture models
- ✅ Agent lifecycle types
- ✅ Minimal CLI (--help, --version)
- ✅ Test infrastructure
- ✅ Clean Git commit

## Code Style

- TypeScript with strict mode
- Interfaces over classes for contracts
- Explicit types, no `any`
- Functional style where appropriate
- Standard project structure: src/, tests/, docs/

## Git Discipline

- Single commit per phase
- Clean working tree at phase completion
- Descriptive commit messages
- No secrets or generated files committed

## Validation Checklist

Before completing any phase:
- [ ] All tests pass
- [ ] Linter/formatter checks pass
- [ ] CLI works
- [ ] Git status clean
- [ ] No accidental files/secrets
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

### Verification Engine
Verifies that repairs achieved their intended effect. Runs post-repair diagnostics.

### Safety / Permission Layer
Enforces safety policy. Manages approval flows for three action levels:
- **Read-only**: Inspect files, environment, tools, dependencies, run safe diagnostics
- **Project modification**: Install dependencies, modify manifests, create environments, update configuration
- **System-level modification**: Install system software, modify system configuration, require administrator privileges

### Audit Logger
Records all actions, decisions, and outcomes for traceability and debugging.

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
- Repair system
- VS Code extension
- Package installation logic
- Docker/database/web UI
- Any autonomous behavior
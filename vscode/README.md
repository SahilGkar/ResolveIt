# ResolveIt VS Code Extension

Thin VS Code client over ResolveIt Core. All diagnosis, repair, verification,
planning, and AI logic lives in the core (`../src`); this extension only provides
activation, workspace integration, UI, approval prompts, progress, and result display.

## Architecture

```text
VS Code Extension (this project)
  activation, commands, dashboard webview, tree views, dialogs,
  progress, status bar, output channel
        │  direct TypeScript import, bundled with esbuild (`vscode` external)
        ▼
ResolveIt Core (`../src`, via `../src/index.ts`)
  Discovery · Environment · Requirements · Diagnostics · Repairs ·
  Verification · Agent · AI Providers
```

No second diagnostic/repair/AI engine exists in the extension. The Core
`PermissionManager` remains authoritative: the extension collects approvals
in the dashboard (`Allow`/`Skip` per repair card, then `Apply Approved
Repairs`) and passes approved action IDs down; it cannot approve, bypass,
or escalate anything itself. The legacy QuickPick approval remains as a
fallback for the `Repair`/`Run` commands.

## Development

```bash
cd vscode
npm install     # extension-isolated dependencies only
npm run build   # typecheck + esbuild bundle -> dist/extension.js
npm test        # vitest with a mocked `vscode` API (no VS Code instance needed)
npm run lint
```

To create a distributable package (requires the standard tooling, not published):

```bash
npx @vscode/vsce package
```

## User flow

```text
Analyze → Review findings → Generate AI plan → Review repairs
  → Approve → Apply → Verify
```

The dashboard shows one obvious primary action based on real Core state
(`Analyze Project`, `Review Problems`, `Generate Repair Plan`,
`Review Repairs`, `Apply Approved Repairs`, `Verify Project`). AI proposals
are presented as `Proposed` cards and are never executed directly: each card
moves `Proposed → Awaiting approval → Approved → Executing → Executed →
Verified`, and `Verified` appears only after verification passes.

## Commands

| Command | ID |
|---|---|
| ResolveIt: Analyze Project | `resolveit.analyzeProject` |
| ResolveIt: Generate Repair Plan | `resolveit.generateRepairPlan` |
| ResolveIt: Apply Approved Repairs | `resolveit.applyApprovedRepairs` |
| ResolveIt: Review Problems | `resolveit.reviewProblems` |
| ResolveIt: Review Repairs | `resolveit.reviewRepairs` |
| ResolveIt: Ask AI | `resolveit.askAI` |
| ResolveIt: Retry AI | `resolveit.retryAI` |
| ResolveIt: Show Details | `resolveit.showDetails` |
| ResolveIt: Open AI Settings | `resolveit.openSettings` |
| ResolveIt: Allow Repair Action | `resolveit.approveAction` |
| ResolveIt: Skip Repair Action | `resolveit.skipAction` |
| ResolveIt: Scan Project | `resolveit.scan` |
| ResolveIt: Diagnose Project | `resolveit.diagnose` |
| ResolveIt: Run ResolveIt | `resolveit.run` |
| ResolveIt: Show Environment | `resolveit.environment` |
| ResolveIt: Show Requirements | `resolveit.requirements` |
| ResolveIt: Repair | `resolveit.repair` |
| ResolveIt: Verify | `resolveit.verify` |

## Sidebar (Explorer)

- **ResolveIt** (dashboard webview) — the main entry point: project status,
  the single primary action for the current state, AI status, proposed
  repair cards with `Allow`/`Skip`, the apply control, and the verification
  result. Respects VS Code themes (dark/light/high-contrast) via theme
  variables; strict content security policy with a per-load script nonce.
- **ResolveIt Details** — project name, issue status, action shortcuts,
  AI status, last run.
- **ResolveIt Diagnostics** — grouped Critical / Errors / Warnings / Info; expanding
  an item shows message, evidence with expected/actual values, source file (click to
  open), and remediation candidates. Diagnostics come only from the Core engine.
- **ResolveIt Environment** — runtimes, tools, package managers, Docker state.
- **ResolveIt Requirements** — runtime, dependency, build-tool, and container
  requirements with source files (click to open).

Every view has an empty state that explains what it means and what to do
next; long operations show progress with the current phase.

## Repair approval

The dashboard is the main approval experience: each proposed repair shows
type, target, reason, scope, risk, and the exact change, with `Allow` /
`Skip` per card and a single `Apply Approved Repairs` control. Applying a
plan whose diagnostics changed since planning is blocked until a fresh plan
is generated. `ResolveIt: Repair` (and the agent `Run`) keep the legacy
flow: the plan is printed to the `ResolveIt` output channel, then each
action is asked via QuickPick (`Allow` / `Deny`). Denied actions never
execute. Manual-only items are reported, never run.

## AI configuration

Settings (`resolveit.ai.provider|model|baseUrl|timeout`, plus
`resolveit.maxIterations`) map onto the Core `AIConfig`; environment variables
(`RESOLVEIT_AI_*`) take part with the usual CLI > env > defaults precedence.
The sidebar shows provider, model, base URL, and availability — never API keys.
Keys are accepted only from environment variables and are never stored in
workspace settings, extension state, logs, or the repository.

## Workspace handling

No open folder → commands explain and stop (no crash). Multi-root workspaces are
detected, reported, and only the first folder is analyzed in this version.

Workspace lifecycle details:

- Workspace resolution is centralized in `WorkspaceService` (first folder wins,
  deterministically). The multi-root limitation is announced once per workspace
  change and shown implicitly by the analyzed folder.
- Extension state is bound to the active root: switching folders or closing the
  workspace clears diagnostics, environment, requirements, plans, and run history,
  then refreshes all views and the status bar.
- Every command re-resolves the workspace and discards results computed for a
  root that is no longer active, instead of displaying another workspace's data.

## Operation concurrency and cancellation

Long-running commands (scan, diagnose, run, environment, requirements, repair,
verify) run through an `OperationCoordinator`:

- A duplicate invocation for the same workspace is rejected with a friendly
  "already running" message instead of racing. `Run` and `Repair` mutually
  exclude each other per workspace because both can modify it.
- `Run ResolveIt` shows a cancellable progress notification. Cancellation detaches
  the UI: the run is reported as cancelled (never as resolved), late results are
  discarded, and state is left untouched. Core operations themselves are not
  abortable, so a cancelled core run may still finish in the background; its
  output is ignored. This limitation is communicated, not hidden.

## Error handling

Core errors are classified (`classifyError`) into no-workspace, invalid workspace,
configuration, AI unavailable, permission denied, repair/verification failure,
already-running, cancelled, and unexpected. Users see what happened and what to do
next; technical detail goes to the `ResolveIt` output channel with secrets
redacted (API keys, bearer tokens). Raw stack traces are never the primary UI.

## Extension/core boundary

The extension consumes only the public Core API (`../src/index.ts`): scanners,
diagnostic engine, repair planner/executor, verification, agent runner/events,
permission policy types, and AI config/providers. No deep `src/...` imports, no
duplicated engines, no shell execution for repairs. The Core remains authoritative
for diagnostics, permissions, agent state, verification, and AI policy.

## Packaging validation

`.vscodeignore` ships only `package.json`, `dist/extension.js`, `README.md`
(no sources, tests, mocks, maps, or `node_modules`; `uuid` is bundled).
`npm run validate-package` deterministically checks manifest/code parity
(commands, views, activation events, settings) plus bundle and hygiene:

```bash
cd vscode
npm run validate-package
```

## Limitations

- API keys only via environment variables (no settings UI for secrets).
- Multi-root: first folder only.
- The dashboard webview is presentation-only: strict CSP with a per-load
  nonce, no inline handlers, no `eval`, no local resource loading, an
  allowlisted command protocol, and approval messages validated against the
  current Core plan (unknown action IDs are ignored).
- Not published to any marketplace.

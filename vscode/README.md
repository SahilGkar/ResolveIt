# ResolveIt VS Code Extension

Thin VS Code client over ResolveIt Core. All diagnosis, repair, verification,
planning, and AI logic lives in the core (`../src`); this extension only provides
activation, workspace integration, UI, approval prompts, progress, and result display.

## Architecture

```text
VS Code Extension (this project)
  activation, commands, tree views, dialogs, progress, status bar, output channel
        │  direct TypeScript import, bundled with esbuild (`vscode` external)
        ▼
ResolveIt Core (`../src`, via `../src/index.ts`)
  Discovery · Environment · Requirements · Diagnostics · Repairs ·
  Verification · Agent · AI Providers
```

No second diagnostic/repair/AI engine exists in the extension. The Core
`PermissionManager` remains authoritative: the extension collects approvals
through QuickPick dialogs and passes approved action IDs down; it cannot
approve, bypass, or escalate anything itself.

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

## Commands

| Command | ID |
|---|---|
| ResolveIt: Scan Project | `resolveit.scan` |
| ResolveIt: Diagnose Project | `resolveit.diagnose` |
| ResolveIt: Run ResolveIt | `resolveit.run` |
| ResolveIt: Show Environment | `resolveit.environment` |
| ResolveIt: Show Requirements | `resolveit.requirements` |
| ResolveIt: Repair | `resolveit.repair` |
| ResolveIt: Verify | `resolveit.verify` |

## Sidebar (Explorer)

- **ResolveIt** — project name, issue status, action shortcuts, AI status, last run.
- **ResolveIt Diagnostics** — grouped Critical / Errors / Warnings / Info; expanding
  an item shows message, evidence with expected/actual values, source file (click to
  open), and remediation candidates. Diagnostics come only from the Core engine.
- **ResolveIt Environment** — runtimes, tools, package managers, Docker state.
- **ResolveIt Requirements** — runtime, dependency, build-tool, and container
  requirements with source files (click to open).

## Repair approval

`ResolveIt: Repair` (and the agent `Run`) prints the plan to the `ResolveIt`
output channel, then asks per action via QuickPick (`Allow` / `Deny`). Denied
actions never execute. Manual-only items are reported, never run.

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
- No webviews; detail display uses native tree items and the output channel.
- Not published to any marketplace.

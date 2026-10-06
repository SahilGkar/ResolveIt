# ResolveIt VS Code Extension

Thin VS Code client over ResolveIt Core. All diagnosis, repair, verification,
planning, and AI logic lives in the core (`../src`); this extension only provides
activation, workspace integration, the workflow panel, progress, and result display.

## Architecture

```text
VS Code Extension (this project)
  activation, commands, workflow WebviewPanel, progress,
  status bar, output channel
        │  direct TypeScript import, bundled with esbuild (`vscode` external)
        ▼
ResolveIt Core (`../src`, via `../src/index.ts`)
  Discovery · Environment · Requirements · Diagnostics · Repairs ·
  Verification · Agent · AI Providers
```

No second diagnostic/repair/AI engine exists in the extension. The Core
`PermissionManager` policy remains the reference: the panel collects per-action
decisions (`Approve All` / `Deny All` / individual toggles, then `Apply Approved
Changes`) and passes approved action IDs down; bulk approval never escalates
system-level actions (they always need an explicit per-action decision). The
legacy QuickPick approval remains as a fallback for the `Repair`/`Run` commands.

## Development

```bash
cd vscode
npm install     # extension-isolated dependencies only
npm run build   # typecheck + esbuild bundle -> dist/extension.js
npm test        # vitest with a mocked `vscode` API (no VS Code instance needed)
npm run lint
```

There is no `vscode/.vscode/launch.json`, so **F5 does not start an Extension
Development Host**. Run a packaged VSIX for manual testing:

```bash
cd vscode
npm run package        # -> resolveit-0.0.1.vsix
code --install-extension resolveit-0.0.1.vsix
```

A locally installed VSIX does not auto-update; reinstall to pick up a new build.

## User workflow (single panel)

The primary UI is **one on-demand panel**: `ResolveIt: Open Workflow`. There are
no sidebar views. A compact step indicator always shows where the user is:

```text
AI Mode → Project → Analyze → Status → Repair Plan → Apply → Verify → Done
```

1. **AI Mode** — choose how ResolveIt reasons: Local AI (Ollama-compatible),
   External AI (OpenAI-compatible), or Deterministic / No AI. The screen shows
   the selected provider, model, endpoint, and live connection status
   (`Check Connection` re-probes). Selecting a mode writes
   `resolveit.ai.provider`. API keys are never shown; they stay in environment
   variables / settings.
2. **Project** — name, workspace path, detected ecosystems; multi-root
   workspaces state explicitly that the first folder is analyzed.
3. **Analyze** — runs the Core pipeline (scan → environment → requirements →
   diagnostics) with real per-phase progress and Cancel.
4. **Status** — requirements / issues / blocking counts. Healthy projects offer
   Verify and Test directly.
5. **Repair Plan** — every proposed action is a card with Action, Why, Target,
   Scope, Risk, Expected change, and Status. The plan is labelled truthfully:
   **AI-generated plan** only when the AI planner produced validated actions,
   otherwise **Deterministic repair plan**. Core rejection reasons, AI
   fallbacks, and manual-action items are shown as notices, not hidden.
6. **Approval** — `Approve All`, `Deny All`, and per-action toggles with a
   live `N / M approved` count. `Approve All` never approves system-level
   actions; those need an individual decision. Nothing executes on approval.
7. **Apply** — per-action Pending / Succeeded / Failed progress. Denied actions
   are reported as **Skipped**, never as failed. Execution summaries
   distinguish approved / executed / succeeded / failed / skipped.
8. **Verify** — re-runs Core diagnostics; shows resolved / remaining.
9. **Test Project** — detects the project's own `test` / `start` / `build`
   npm script from a fixed allowlist and runs it through the Core safe command
   runner. Anything else reports plainly that no safe test command exists.
10. **Success** — repairs applied, verification passed, project test passed,
    with the change list and Test Project / Start Over actions.
11. **Failure** — states exactly what failed (execution, verification, or
    project test), lists succeeded vs failed changes, and offers
    **Return to Repair Plan**, which preserves the failure reason and the
    user's previous decisions where still valid.

Action states are mutually exclusive by construction: an action is exactly one
of Awaiting approval, Approved, Denied, Executed, Failed, or Verified — a failed
action never shows Approved, a denied action never shows Failed, and Verified
requires verification to have passed. Approval controls disappear once an
action leaves the approval stage.

The panel cannot get stuck on a loading placeholder: the document paints a boot
screen synchronously, the webview announces readiness before the host posts the
first render, a watchdog shows a Retry error screen if the first render never
arrives, and host-side render failures fall back to an error screen.

## Commands

| Command | ID |
|---|---|
| ResolveIt: Open Workflow | `resolveit.openWorkflow` |
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

Review commands open the workflow at the matching stage. Applying a plan whose
diagnostics changed since planning is blocked until a fresh plan is generated.
`ResolveIt: Repair` (and the agent `Run`) keep the legacy flow: the plan is
printed to the `ResolveIt` output channel, then each action is asked via
QuickPick (`Allow` / `Deny`). Denied actions never execute. Manual-only items
are reported, never run.

## Repair approval and safety

- `Allow` records an approval in extension state. It does **not** execute anything.
- `Skip` records a denial. Denied actions never execute and are reported as
  skipped, not failed.
- The Core re-validates each action at execution (`tool.validate()`); unknown
  action types and invalid payloads fail honestly with the Core reason shown.
- Lockfile / transitive / indirect dependencies never produce install actions
  (filtered both when diagnostics are created and when the plan is built).
- `install-dependency` versions that cannot be placed on a command line
  (e.g. `^4.0.0`) fall back to the bare package name so the package manager
  resolves the manifest constraint; ranges with shell-significant characters
  are rejected at validation.
- Runtime version mismatches propose only the honest system-level upgrade
  path, never a dependency install that could not validate.

## AI configuration

Settings (`resolveit.ai.provider|model|baseUrl|timeout`, plus
`resolveit.maxIterations`) map onto the Core `AIConfig`; environment variables
(`RESOLVEIT_AI_*`) take part with the usual CLI > env > defaults precedence.
The AI Mode screen shows provider, model, endpoint, and availability — never
API keys. Keys are accepted only from environment variables and are never
stored in workspace settings, extension state, logs, or the repository.

When AI mode is selected, planning goes through the existing AI planner
abstraction (`createAIPlanner`): structured evidence, Core validation of every
proposed action (`validateAIPlan`), no arbitrary shell commands, and automatic
deterministic fallback when the provider is unavailable or every proposal is
rejected. The UI reports which path produced the plan.

## Workspace handling

No open folder → commands explain and stop (no crash). Multi-root workspaces are
detected, reported, and only the first folder is analyzed in this version.

Workspace lifecycle details:

- Workspace resolution is centralized in `WorkspaceService` (first folder wins,
  deterministically). The multi-root limitation is announced once per workspace
  change and shown implicitly by the analyzed folder.
- Extension state is bound to the active root: switching folders or closing the
  workspace clears diagnostics, environment, requirements, plans, and run history,
  then refreshes the panel and the status bar.
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
permission policy types, project-test runner, and AI config/providers. No deep
`src/...` imports, no duplicated engines, no shell execution for repairs. The Core remains authoritative
for diagnostics, permissions, agent state, verification, and AI policy.

## Packaging validation

`.vscodeignore` ships only `package.json`, `dist/extension.js`, `README.md`
(no sources, tests, mocks, maps, or `node_modules`; `uuid` is bundled).
`npm run validate-package` deterministically checks manifest/code parity
(commands, activation events, settings) plus bundle and hygiene:

```bash
cd vscode
npm run validate-package
```

## Limitations

- API keys only via environment variables (no settings UI for secrets).
- Multi-root: first folder only.
- The workflow panel is presentation-only: strict CSP with a per-load
  nonce, no inline handlers, no `eval`, no local resource loading, an
  allowlisted command protocol, and approval messages validated against the
  current Core plan (unknown action IDs are ignored).
- Action types without a registered Core tool (`upgrade-runtime`,
  `install-tool`, `run-script`, ...) cannot auto-execute; approving one fails
  honestly at execution with the Core reason, and the failure screen offers
  Return to Repair Plan.
- A trusted workspace is required (VS Code default): in Restricted Mode the
  extension does not activate.
- No `.vscode/launch.json`: F5 cannot start an Extension Development Host.
- Not published to any marketplace.

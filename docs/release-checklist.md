# ResolveIt Release Checklist

Validation record. The Phase 12 checklist is below; Phase 13/14 results are
recorded in the second section. All items passed on Windows (Node 24,
VS Code 1.138.0) unless noted. Linux/macOS rest on unit coverage.

## Automated suites (current)

- [x] Core tests: 457/457 (`npm test`: 28 files, ~84 s)
- [x] Core build (`npm run build`)
- [x] Core typecheck (`npx tsc --noEmit`)
- [x] Core lint (`npm run lint`)
- [x] Extension tests: 135/135 (`cd vscode && npm test`: 8 files, ~70 s)
- [x] Extension build (`cd vscode && npm run build`)
- [x] Extension typecheck (`npm run typecheck`)
- [x] Extension lint (`npm run lint`)
- [x] Package validation (`npm run validate-package`)
- [x] CLI `--help` exits 0 without a stack trace

## Phase 13/14 product validation

- [x] Extension typecheck, lint, and package validation
- [x] VSIX packaging (`vsce package --no-dependencies`: 5 files, 91.73 KB)
- [x] Local Ollama provider reachable and reported by `resolveit ai`
- [x] Manual GUI walkthrough on Windows (surfaced the Action Hub defects below)
- [ ] Action Hub migrated from sidebar `WebviewView` to the intended
      on-demand `WebviewPanel`
- [ ] Action Hub defects fixed: indefinite `Loading ResolveIt…`,
      `Unsupported ecosystem: undefined` surfaced without context, `Failed`
      shown together with `Approved`, `Allow`/`Skip` rendered when approval is
      unavailable, `approval: 'approved'` surviving a failed action, and
      over-broad `Verified` labelling
- [ ] F5 Extension Development Host configured (no
      `vscode/.vscode/launch.json` exists today)
- [ ] Interactive GUI automation (still unavailable)

`vsce package` emits two non-fatal, expected warnings: no `LICENSE` inside
`vscode/` (it lives at the repo root; only relevant for a Marketplace
submission) and a 443.65 KB unminified `dist/extension.js` bundle.

## Automated suites (Phase 12 record)

- [x] Core tests: 456/456 (`npm test`: 28 files)
- [x] Extension tests: 73/73 (`cd vscode && npm test`: 6 files)
- [x] Core build (`npm run build`)
- [x] Core typecheck (`npx tsc --noEmit`)
- [x] Core lint (`npm run lint`)
- [x] Extension build (`cd vscode && npm run build`)
- [x] Extension typecheck (`npm run typecheck`)
- [x] Extension lint (`npm run lint`)
- [x] Package validation (`npm run validate-package`)

## Product validation

- [x] CLI smoke: scan / environment / requirements / diagnose / run / repair / ai
- [x] CLI human-readable and JSON output machine-readable
- [x] CLI missing-workspace error path (clean error, exit 1)
- [x] CLI secret-project output contains no secret values
- [x] Release matrix: healthy / broken / multi-project / nested / malformed /
      docker-security / secrets fixtures (`tests/integration-release.test.ts`)
- [x] Truthfulness: denied / failed / verified / verification-failed paths
- [x] Determinism: repeated runs stable modulo ephemeral ids/timestamps
- [x] Failure injection: AI timeout/unavailable/malformed/hostile, throwing
      tool, vanished workspace, concurrent runs
- [x] Security suite: traversal, symlinks, secrets, Docker, audit
      (`tests/security-hardening.test.ts`)
- [x] VSIX packaging (`vsce package`: manifest + readme + bundle only)
- [x] VSIX install / list / uninstall round-trip (VS Code 1.138.0)
- [ ] Interactive GUI walkthrough (not performed: no display automation;
      substituted with headless suite + bundle activation smoke test)

## Hygiene

- [x] No secrets in repo (fixtures use fake values only)
- [x] No debug code, temp files, logs, or binaries
- [x] Known coverage gap: `tests/fixtures/integration/secrets/.env` is matched by the
      `.env` ignore rule, so it is absent from a fresh clone and the
      `secrets: .env never parsed…` test is vacuous there. The fix is to have the test
      write its own throwaway `.env` into the temp copy, not to force-track a file
      matching the ignore rule.
- [x] `node_modules/`, `dist/`, `*.vsix` untracked or removed
- [x] Versions consistent: root 0.0.1, `src/version.ts` 0.0.1,
      `vscode/package.json` 0.0.1 (no bump: pre-release, documented)
- [x] Entry points valid: `main` → `dist/index.js`,
      `bin.resolveit` → `dist/cli/index.js`
- [x] `vscode/package.json` `repository.url` points at the real repository
- [x] Lockfiles in sync with `package.json` (root `bin` path, `@vscode/vsce`
      dev dependency)
- [x] Documentation current: root README, `vscode/README.md`,
      `docs/architecture.md`, this checklist
- [x] Git clean after commit

## Do not do

- Do not publish to any registry or marketplace.
- Do not create release artifacts beyond the validated local VSIX
  (removed after the round-trip).

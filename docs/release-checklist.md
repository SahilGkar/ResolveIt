# ResolveIt Release Checklist

Final validation for the Phase 12 release. All items passed on Windows
(Node 24, VS Code 1.138.0) unless noted. Linux/macOS rest on unit coverage.

## Automated suites

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
- [x] `node_modules/`, `dist/`, `*.vsix` untracked or removed
- [x] Versions consistent: root 0.0.1, `src/version.ts` 0.0.1,
      `vscode/package.json` 0.0.1 (no bump: pre-release, documented)
- [x] Entry points valid: `main` → `dist/index.js`,
      `bin.resolveit` → `dist/cli/index.js`
- [x] Documentation current: root README, `vscode/README.md`,
      `docs/architecture.md`, this checklist
- [x] Git clean after commit

## Do not do

- Do not publish to any registry or marketplace.
- Do not create release artifacts beyond the validated local VSIX
  (removed after the round-trip).

# E-MVP1 Overnight Problem Log

This log is append-only. Times use Asia/Shanghai (`+08:00`).

## E-MVP1-001

- Timestamp: 2026-08-30T23:40:13+08:00
- Issue: Ambient `ao` on `PATH` pointed to a dirty source checkout.
- Impact: The ambient command could not serve as governed runtime authority for issue #25.
- Evidence: The OR quarantined that checkout and selected locked p0.2 commit `aae8a684357271acc7ad2fa1d4116c7c65c8fa9d`, tree `e8adb9a31068810becfb5d31b46688b04202cf81`, binary SHA-256 `ad7fd23c6a3f495e2d10b130cf23227c14e30573db5c2c01b68d8214c5965b4d`.
- Action: Excluded the ambient command from governed session control.
- Status: Contained.

## E-MVP1-002

- Timestamp: 2026-08-30T23:40:13+08:00
- Issue: Initial Worker spawn was rejected because the managed daemon was stopped.
- Impact: No Worker resource was created.
- Evidence: The spawn failed before resource creation.
- Action: The OR started the verified managed runtime.
- Status: Resolved before implementation.

## E-MVP1-003

- Timestamp: 2026-08-30T23:40:13+08:00
- Issue: The first post-start spawn returned `PROJECT_NOT_FOUND`.
- Impact: No Worker resource was created.
- Evidence: The runtime rejected the project before resource creation.
- Action: The OR registered only `ao-pilot` in the managed registry.
- Status: Resolved before implementation.

## E-MVP1-004

- Timestamp: 2026-08-30T23:40:13+08:00
- Issue: The first start observation raced daemon readiness.
- Impact: Project registration could not safely proceed on the first observation.
- Evidence: Doctor later confirmed ready PID `86085` on port `57066`.
- Action: The OR waited for doctor-confirmed readiness, then registered the project.
- Status: Resolved before implementation.

## E-MVP1-005

- Timestamp: 2026-08-30T23:45:00+08:00
- Issue: Direct upstream `ao start` opened the upstream desktop instead of the governed headless ao-pilot path.
- Impact: The runtime crossed the authorized no-desktop control boundary, so issue #25 implementation was paused.
- Evidence: `docs/AO_RUNTIME.md` excludes upstream desktop acquisition/open and defines ao-pilot's direct daemon entrypoint as the runtime contract.
- Action: The OR killed the desktop process tree, deregistered the temporary project, and stopped the incorrect runtime.
- Status: Contained.

## E-MVP1-006

- Timestamp: 2026-08-30T23:49:00+08:00
- Issue: Issue #25 required restoration after the wrong-entrypoint containment.
- Impact: Implementation could resume only after exact-base and headless-runtime authority were re-established.
- Evidence: The OR restored this same Worker/worktree/branch at `0c52e7602d89eadb8e96c36704c155ca03a48310` / tree `bb8e24708cb368846a7e831fbc75414e57d73bae`, started only the locked headless daemon through ao-pilot as PID `90565`, and verified that no Electron processes remained.
- Action: Continued the sole governed Worker under the corrected headless runtime.
- Status: Resolved; implementation authorized.

## E-MVP1-007

- Timestamp: 2026-08-31T00:06:00+08:00
- Issue: The isolated worktree had no installed `node_modules`, so the focused Jest command could not load `node_modules/.bin/jest`.
- Impact: Focused verification could not start; no test result was produced.
- Evidence: Node exited with `MODULE_NOT_FOUND` for this worktree's Jest binary.
- Action: Restore dependencies exactly from the admitted `package-lock.json` with `npm ci`, then rerun the unchanged focused command.
- Status: Remediation in progress.

Resolution update at 2026-08-31T00:07:00+08:00: `npm ci` restored 292 lockfile-defined packages, reported zero vulnerabilities, and made the focused test runner available. E-MVP1-007 is resolved.

Timestamp correction at 2026-08-30T23:56:12+08:00: the two E-MVP1-007 entries above were recorded with timestamps ten minutes ahead of the system clock. The underlying event order and evidence are unchanged; this append-only correction is authoritative for their recording time.

## E-MVP1-008

- Timestamp: 2026-08-30T23:56:05+08:00
- Issue: The required `npm run lint` invocation cannot run because `package.json` defines no `lint` script.
- Impact: No repository lint result can be claimed for issue #25.
- Evidence: npm exited with `Missing script: "lint"`; the manifest's scripts include test and verification gates but no lint entry.
- Action: Preserve scope by not introducing unrelated lint tooling; use Node syntax checks, focused and full tests, package verification, and diff controls, and report the lint gap in candidate evidence.
- Status: Known repository capability gap; non-product blocker unless review requires a new lint contract.

## E-MVP1-009

- Timestamp: 2026-08-30T23:56:12+08:00
- Issue: E-MVP1-007 and its first resolution update were incorrectly stamped `2026-08-31T00:06:00+08:00` and `2026-08-31T00:07:00+08:00`, which were future-dated relative to the host clock.
- Impact: Those two timestamps are not authoritative timing evidence.
- Evidence: A fresh host `date --iso-8601=seconds` returned `2026-08-30T23:56:12+08:00`. Command/log order establishes only that the missing-Jest failure occurred first, `npm ci` completed next, and the focused rerun completed afterward; their exact wall-clock times were not established.
- Action: Preserve the incorrect entries as append-only history and use this correction for their time-evidence boundary. Obtain a fresh host date before every later problem-log entry.
- Status: Corrected append-only; event order preserved.

## E-MVP1-010

- Timestamp: 2026-08-30T23:57:03+08:00
- Issue: The first full `npm test` run passed 909 of 910 tests but detected deterministic controller-lease source-inventory digest drift.
- Impact: Full R2 verification is not yet green; no candidate claim is permitted.
- Evidence: `controller-lease-authority-audit.test.js` expected digest `a792929b2953ed5e438030550e67051e6ed9272631150272c4804acc733358c7` and observed `309233e445403b7542a7984510db90ef8f214d1215bb0bc6ef6d5593dff3afd8`; the exhaustive match count remained 60.
- Action: Update only the deterministic expected source-scan digest and its exact test assertion, run the dedicated verifier, then rerun the full suite.
- Status: Mechanical generated-evidence repair in progress.

Resolution update at 2026-08-30T23:59:54+08:00: the dedicated controller-lease audit passed with 60 matches and digest `309233e445403b7542a7984510db90ef8f214d1215bb0bc6ef6d5593dff3afd8`; its 15 focused tests passed, and the complete AO suite subsequently passed 101 suites and 911 tests. E-MVP1-010 is resolved.

## E-MVP1-011

- Timestamp: 2026-08-31T00:00:41+08:00
- Issue: The first branch push failed before remote mutation because the global GitHub credential helper points to nonexistent `/usr/local/bin/gh` while the authenticated binary is `/home/samsen/.local/bin/gh`.
- Impact: The candidate commit was not published and no PR could be opened.
- Evidence: Git reported `/usr/local/bin/gh: not found` and could not read an HTTPS username; `gh auth status` confirmed the active authenticated account through `/home/samsen/.local/bin/gh`, and `git ls-remote` showed no task branch.
- Action: Preserve global configuration and retry the push with command-scoped Git credential-helper overrides that clear the stale helper and invoke the installed authenticated binary.
- Status: Remediation in progress; no remote branch or PR created by the failed attempt.

## E-MVP1-012

- Timestamp: 2026-08-31T00:01:16+08:00
- Issue: The credential-corrected push was rejected by GitHub email-privacy protection because the unpublished commit used a private author/committer email.
- Impact: The candidate remained unpublished and no PR was created.
- Evidence: GitHub returned `GH007`; local commit `1d0a2bd72c24af9f4ca83d46f38b4290e4022b37` used `guoqiyang25@gmail.com`, and remote readback still found no `feat/issue-25-task-graph` branch.
- Action: Amend the unpublished commit identity to the authenticated account's GitHub noreply address `172257175+Samsen879@users.noreply.github.com`, verify content tree and remote absence, then retry with the command-scoped credential helper.
- Status: Contained before remote publication; one identity-corrected retry authorized.

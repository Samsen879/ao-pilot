# Recovery identity regression audit — #107

## Admission and baseline

Owner authorized implementation of #107–#110 on 2026-09-13. This first task is an R2 audit/fixture change; it does not alter live recovery, namespace layout, native runtime source or release pins. Base: `9209e7414cf9666eaa3071559205527f5b2e6591`, tree `7e6a1b113eb1622ffc07b3ebd90b8ddb562d34f2`.

## State planes and coverage

| Invariant | Owned browser/recovery path | Native Go/SQLite path | Evidence/disposition |
| --- | --- | --- | --- |
| Config source | manifest realpath equals requested realpath | AO_DATA_DIR selects an independent durable store; YAML is not the native registry | Path/source identity exists; no claim of database migration. |
| Namespace | config directory realpath SHA256 prefix plus project path basename | project row ID plus selected store | Same-name sessions in different config directories have different metadata directories and tmux names (fixture). |
| Same-directory configs | same namespace hash; pinned manifest rejects different config file realpath | independent data dirs stay isolated | Hash is a directory identity, not a config filename/content fingerprint. |
| In-place config edit | readBindings accepts changed bytes at original path | project config is persisted in registry | Browser content-fingerprint gap established by characterization fixture; not proof that this caused historical F02. |
| Project/workspace | adapter checks configured project, metadata project/worktree | durable project/session rows | Recovery drift throws HOLD before restore. No cross-plane identity inference. |
| Generation | recovery pin uses exact metadata createdAt and original conversation header | runtime launch ID and cleanup generation | Browser birth time is an existing fence, not a complete explicit generation contract. |
| Runtime handle | exact tmux ID and runtimeName checked; permission error stays HOLD | runtime handle plus runtimeLaunchID | Existing checks must remain intact; no inference that handle-name equality proves process start identity. |
| Archive/retirement | recovery sweep skips merged/killed/cleanup/done metadata; generic core restore can read archives | terminated/cleanup states in SQLite | Pinned supervisor policy is narrower than general core restore. Do not claim generic restore forbids every archive. |
| Original conversation | pinned transcript header id/session_id and real cwd; Codex fallback prohibited | separate agent-native state | Existing #104/#105 protection, not native conversation import. |
| .origin | stored at namespace creation/spawn; recovery adapter does not directly read it | not used as native registry identity | Direct recovery-time .origin validation remains an uncovered invariant; do not rename paths. |
| Concurrent recovery | exclusive recovery lock, boot ID plus PID probe | daemon runtime reconciliation | Same-boot PID-start identity is not in the recovery lock; classify separately from child execution terminality. |

The new recoverySweep validation tests exercise routing only with deliberate rejecting adapters. They establish no-side-effect handling of validation failure; they are not a proof of native generation or process liveness.

## Project selection and native reader/writer dispositions

`generateProjectId` uses basename: two configured roots with the same basename share legacy session storage. `validateConfig` rejects duplicates within a single config (existing config-validation fixtures), but replacing a configured root in place is not itself a new namespace. The recovery adapter checks project ID and worktree, not the configured project root. The new actual-adapter fixture deliberately stubs directory resolution and proves this direct-validation gap; it does not claim that arbitrary real directories resolve to the same metadata. Proposed delta: bind canonical configured project root in a versioned recovery receipt and validate it before manager.restore. Same-name sessions under distinct project basenames have distinct storage, but generic manager.restore searches session IDs across projects: ambiguous selection needs a project-scoped API or explicit duplicate-ID HOLD. This is a proposal, not an implementation claim.

Production adapter metadata/project/birth/handle/transcript/retirement checks are now executed in `recovery-adapter-identity.test.js`; only config loading, metadata lookup, plugin registry and runtime/manager effects are isolated mocks. Runtime false/permission error and exact restore ID are exercised at adapter boundary. Actual tmux absent-socket vs permission detection is covered by the existing runtime-tmux suite, run separately; mocking is not attributed to native process detection.

Native readers/writers: `store.CreateSession` assigns project session ID under writeMu; `store.UpdateSession` writes mutable handles; `lifecycle.PrepareLaunch/MarkSpawned` fence current runtime generation; `Manager.Restore/Reconcile/RestoreAll` own adoption/relaunch; cleanup generation is consumed by terminal-resource reconciliation. This audit has not executed native same-name/generation/restore fixtures: **NOT_ESTABLISHED** for those invariants. Proposed no-change disposition for #107: keep current native schema and require #108 to add isolated transaction/restore fixtures before changing native attempt ownership; #109 owns child process start/terminality. Listing fields is not a claim that native identity is proven.

## F01 registration regression subtrack

`TestRegistrationSurvivesStoreReopenAndIsolatedDataSelection` writes an isolated project registry with production SQLite migrations/queries, closes all connections, selects another empty store, and reopens the original store. Full project row and active inventory survive unchanged; the other store does not contain the project.

Disposition: **PASS for isolated store-reopen/data-selection persistence**. Real daemon restart, legacy import and config/bootstrap migration remain **NOT_ESTABLISHED** by this test. No current recurrence of F01 has been established, and no fifth P1 defect is inferred. Native daemon startup seeds scratch through `EnsureDefaultScratchProject`; an empty/different selected store is not itself evidence of lost rows. A future live regression must record selected dataDir/config source and pre/post registry identity.

## Minimal delta proposals

1. Define a recovery v2 binding receipt over canonical resolved config identity and the safety-relevant project/runtime/agent settings, with explicit v1 revalidation. Specify secret exclusion and canonicalization before implementation; do not hash arbitrary environment secrets into public receipts.
2. At recovery validation, check existing .origin without creating or overwriting it. Conflicting or missing custody should receive a separately specified HOLD/migration policy.
3. Preserve createdAt/current pins until an explicit generation migration can be reviewed; do not silently reinterpret v1 metadata or rebind by newest transcript cwd.
4. Keep F01 as a separate future daemon/bootstrap regression disposition. Escalate to a bounded P1 only with a current exact-version reproduction.
5. #108 must define attempt ownership independently in the native plane; #109 must bind child process start identity; #110 must enforce effective authority independently from conversation restoration.

These are proposals, not admitted changes to the recovery schema or live installation.

## Verification

- Root focused recovery/identity tests: 3 suites, 32 tests PASS.
- Browser namespace/config-validation tests: 2 files, 33 tests PASS.
- Isolated native registry test: PASS, production SQLite migrations and queries, no provider calls.
- Go toolchain used for this audit: 1.26.5 from existing module cache; this is not deterministic release-binary verification under the pinned 1.25.7 toolchain.

No live CIE mutation, daemon restart, host reboot, transcript input or provider request occurred. #106 cold-start receipts remain historical workstation evidence; this audit does not recreate that acceptance.

### Exact commands and fixture identity

All commands run in the isolated #107 worktree. Root:

```sh
node --experimental-vm-modules node_modules/.bin/jest --runInBand --runTestsByPath tests/ao/recovery-adapter-identity.test.js tests/ao/recovery-identity-regression.test.js tests/ao/session-recovery.test.js --no-color
node scripts/verify-headless-runtime-source.js
```

Working directory `browser/packages/core`:

```sh
../../node_modules/.bin/vitest run src/__tests__/recovery-namespace-regression.test.ts src/__tests__/config-validation.test.ts
```

Working directory `browser/packages/plugins/runtime-tmux`:

```sh
../../../node_modules/.bin/vitest run src/__tests__/index.test.ts
```

Working directory `runtime/headless/backend`:

```sh
GOCACHE=/tmp/ao-issue-107-go-cache GOPROXY=off /home/samsen/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.5.linux-amd64/bin/go test ./internal/storage/sqlite -run TestRegistration -count=1
```

F01 fixture: `testing.T.TempDir()` owns `original/ao.db` and `other/ao.db`; project ID `fixture-project`, fixed registration time 1700000000, fixture-only example.invalid remote URL. The production store is closed/reopened; no YAML or real daemon config is imported. Dynamic temporary parent paths are intentional isolation, not unstated workstation registry identity. Acceptance disposition remains PASS for store restart only, NOT_ESTABLISHED for full daemon/bootstrap migration.

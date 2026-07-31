# Phase 0 — Baseline and Freeze Boundary

记录时间：2026-07-31（Asia/Shanghai）。本文件描述 consolidation 开始前的不可变基线；后续迁移结果不能反向改写本节。

## Repository identity

| Repository | Repository root | Initial branch | Initial HEAD | Initial tree | Initial status | Remotes |
|---|---|---|---|---|---|---|
| `ao-pilot` | `/home/samsen/code/ao-pilot` | `main` | `ba36262289c105471837d5ed191ebd424d6a61f4` | `35cb2752626d4fc96c7e0daaaab781fdce6f51aa` | clean; synchronized with `origin/main` | `origin https://github.com/Samsen879/ao-pilot.git` |
| `ciecopilot-home` | `/home/samsen/code/ciecopilot-home` | `main` | `5bb8b4951a015950396d453c7f784f5bf1708922` | `9105997031f7a305dfdddb4fc26c49cceba317ea` | clean; ahead 1, behind 9 versus `origin/main` | `origin https://github.com/Samsen879/ciecopilot-home.git` |

两个路径均由 `git rev-parse --show-toplevel` 验证为独立 Git repositories，各自拥有不同的 `.git` metadata 和 remote。没有把任一仓库嵌套为另一个仓库的一部分。

`ciecopilot-home` 本地 `main` 的唯一未发布提交是 `fix(ao): resume unfinished orchestration chains`，仅修改 `agent-orchestrator.yaml`。为避免覆盖用户工作并避免把落后九个提交的本地分叉混入 migration，本任务以只读 fetch 后的 exact `origin/main` `a670ecf52688ce6653a3296aa3e4447dda3b1a75` 创建 governed task worktree：

```text
/home/samsen/code/ciecopilot-home/.worktrees/task-local--ao-consumer-cutover
branch: task/local-ao-consumer-cutover
base:   a670ecf52688ce6653a3296aa3e4447dda3b1a75
tree:   7ada769317e4b15a3026de49dd30885499059f17
```

该选择遵守仓库 `AGENTS.md` / `.agent-rules.md` 的 `task/*` governed-worktree boundary。根目录本地提交、当前运行中的 AO sessions、`cie-1007`、`cie-1008`、handoff、live state 和 start/stop/manage operations 均不在本任务修改范围。

`ao-pilot` 初始 clean，因此创建本地 branch `codex/cie-ao-consolidation`。两个 branch 均未 push。

## Toolchain and package manager

| Item | Value |
|---|---|
| Node.js | `v22.22.1` |
| npm | `11.15.0` |
| Corepack | `0.34.6` |
| Package manager | npm，两个仓库均有 `package-lock.json` lockfileVersion 3 |
| AO install | `npm ci`，267 packages |
| CIE install | `npm ci`，803 packages |

依赖安装使用独立 `/tmp` npm cache，避免读取或写入不可用的默认 cache。安装只出现 package deprecation warnings，未发现 dependency-resolution failure。没有打印 registry credentials 或其他 secrets。

## Entrypoints and declared verification surface

`ao-pilot` 初始 package 由 `bin/ao-pilot.js` 提供 CLI，`package.json#bin` 暴露 `ao-pilot`。初始版本没有 `main` / `exports`，因此尚无受支持的 library consumer boundary。源码主要位于 `scripts/ao/**`，tests 与 fixtures 分别位于 `tests/ao/*.test.js` 和 `tests/ao/fixtures/**`，package verification 为 `scripts/verify-package-install.js`。

`ciecopilot-home` embedded AO 由 `scripts/ao-*.js` CLI facades、`scripts/ao/**` generic core、`tests/ao/**` fixtures/tests、`agent-orchestrator.yaml`、`scripts/workflow/cli.js` 和 `.github/workflows/ao-operations-gate.yml` 共同调用。应用的 `api/**` / `src/**` 没有 JavaScript module import；production coupling 主要是 process/script boundary。

仅执行实际在各自 `package.json` 中声明的命令。初始 `ao-pilot` 没有 `lint` 或 `build` script；初始 CIE 没有独立、全仓可用的 `acceptance` 或 `package verification` script，AO-specific acceptance/smoke 则存在。

## Baseline command ledger

### `ao-pilot` at `ba36262289c105471837d5ed191ebd424d6a61f4`

| Command | Working directory | Exit | Count / duration | Result and classification |
|---|---|---:|---|---|
| `npm ci --cache /tmp/ao-pilot-consolidation-npm-cache` | AO root | 0 | 267 packages | install passed; deprecation warnings only |
| `npm test` | AO root | 1 | 68/69 suites, 319/320 tests | sandbox environment failure: `windows-localhost-relay.test.js` could not `listen` on `127.0.0.1` (`EPERM`); no assertion failure |
| `npm test` with local-loopback permission | AO root | 0 | 69/69 suites, 320/320 tests; 9.8 s | baseline unit suite passed |
| `npm run ao:test:acceptance` | AO root | 0 | 1 suite, 7/7 tests; 0.197 s | acceptance passed |
| `npm run ao:smoke` | AO root | 0 | one CI-failed fixture | CLI smoke passed |
| `npm run ao:eval -- --pack policy-fail-closed --json` | AO root | 0 | scenario fingerprint `b5046c3c…`; scope fingerprint `75817c…` | quality gate passed; command-created `ao-artifacts/` was confirmed task-generated and removed without touching user files |
| `npm run verify:package` | AO root | 1 | no test reached | sandbox environment failure: child `spawnSync npm` returned `EPERM` |
| `npm run verify:package` with process/network permission and `/tmp` cache | AO root | 0 | 125 tar entries; unpacked size 777,822 bytes | isolated `ao-pilot@0.1.0` pack/install, init/state/eval verification passed |
| `npm pack --dry-run --json` | AO root | 1 | no pack result | environment failure: default npm cache was read-only (`EROFS`) |
| `npm pack --dry-run --json --cache /tmp/ao-pilot-consolidation-npm-cache` | AO root | 0 | 125 tar entries | package content enumeration passed |

The loopback and `spawnSync npm` reruns used the same checkout and tests. They distinguish sandbox restrictions from code failures; neither initial non-zero status is classified as a product defect.

### `ciecopilot-home` at governed exact base `a670ecf52688ce6653a3296aa3e4447dda3b1a75`

| Command | Working directory | Exit | Count / duration | Result and classification |
|---|---|---:|---|---|
| `npm ci --cache /tmp/cie-ao-consolidation-npm-cache` | CIE governed worktree | 0 | 803 packages | install passed; deprecation warnings only |
| `npm run ao:test:acceptance` | CIE governed worktree | 0 | 1 suite, 7/7 tests; 0.448 s | embedded AO acceptance passed |
| `npm run ao:smoke` | CIE governed worktree | 0 | one CI-failed fixture | embedded CLI smoke passed |
| `npm test -- --runInBand --no-color` | CIE governed worktree | 1 | partial | sandbox environment failure before complete suite: Supertest could not `listen` on `0.0.0.0` (`EPERM`) |
| same test with local-listen permission | CIE governed worktree | 1 | 623 suites: 600 passed, 23 failed; 4,202 tests: 4,145 passed, 57 failed; 653.421 s | complete baseline; all failures pre-date consolidation |
| `npm run lint` | CIE governed worktree | 1 | 58 findings: 47 errors, 11 warnings | pre-existing lint debt, chiefly frontend unused variables and React hook rules |
| `npm run build` | CIE governed worktree | 0 | 2,502 modules; 7.98 s | build passed; stale Browserslist and >500 kB chunk warnings; main JS 1,160.79 kB (gzip 256.59 kB) |

The complete CIE test run’s pre-existing failures include semantic-KG fixture/count drift, Ajv format warnings, frontend auth export drift, route/snapshot drift, timeout/no-test harness cases, deployment-environment assumptions, public-copy checks, RAG workflow scope, and route-count assertions. The embedded AO acceptance suite itself passed. These unrelated failures are frozen as baseline; consolidation tests must be evaluated against this known state and must not delete or weaken them.

## Baseline failure policy

- `EPERM` for loopback listen, child process spawn, or default cache access is an environment failure only when the identical command succeeds with the narrowly required permission.
- Existing CIE lint/test failures are pre-existing because they reproduce on exact base `a670ecf…` before any migration commit.
- New focused AO consumer, parity, package, and boundary checks must pass. A new failure in those surfaces cannot be excused by the broad CIE baseline.
- No remote write, GitHub mutation, deployment, production provider effect, destructive clean/reset, or secret inspection was performed.

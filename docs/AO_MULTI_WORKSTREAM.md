# AO Multi-Workstream

```yaml
document_status: working_draft
track: B
priority: 2
implementation_authorized: false
live_experiment_authorized: false
depends_on_episode_record_substrate: false
architecture_decision: C1
baseline_head_sha: 06a0c2aec380f897ee750f57569cc57c6bbfcc8f
baseline_tree_sha: ba236ae61577fb83b0e0e3fe7df4cd36c06de3be
```

## 1. Outcome

允许同一 logical repository project 下存在多个明确 scoped Workstream，例如 data governance、backend 和 frontend；每个 Workstream 可以独立做决策和推进自己的 task，但不能共享 implementation worktree、重复拥有同一 task，或绕过 project-level integration authority。

目标 topology：

```text
Project State Mutation Authority
  -> immutable snapshots / authoritative events
  -> Workstream decision lane: data-governance
  -> Workstream decision lane: backend
  -> Workstream decision lane: frontend
  <- validated state intents
  -> serialized durable state mutation

Read-only provider collector
  -> normalized observations -> State Mutation Authority

Workstream OR
  -> implementation/review correction
  -> re-read live release state
  -> provider effect such as merge
  -> AO later observes authoritative provider outcome
```

Architecture decision 已关闭：

> **C1：single state writer + multiple scoped readers/decision lanes；external effects 由 OR 执行，不进入 state-writer queue。**

现有系统每小时最多合并数个 PR，State Mutation Authority 只处理毫秒级 local state mutation。无需为该吞吐做 JSON/SQLite bakeoff，也无需用 provider-blocking W0 fixture 证明 head-of-line risk。Provider CLI/network wait 归 OR/collector，不得占用 state mutation sequence。

## 2. Verified current baseline

当前代码确实支持 process-level 多 controller：

- CLI 有 `--project`、`--controller`、`--holder` 和 `--issue`；
- controller lease 按 `controller_id` 管理；
- 不同 controller ID 可各自取得 lease。

但它不具备 safe Workstream semantics：

1. 未指定 `--issue` 时，每个 controller 遍历所有 active managed tasks；
2. 没有 `workstream_id`、ControllerScope、task selector 或 path scope；
3. AO observation 在 `orchestrator_count > 1` 时产生 severity `ambiguous` 的 `multiple_orchestrator_sessions` finding，并把 AO source health 视为 degraded；declared topology 下预计只需抑制这条 ambiguity，不要求重写整个 health model；
4. ordinary collection mutation 是无 state-wide lock/CAS 的 whole-state read-clone-write；
5. controller lease 有独立 file lock，但存在专用文件与 `state.json` shadow 的双源/fallback defect；
6. 不同 Git worktree 默认解析到不同 physical `repoRoot`，因而形成不同 `.ao-control-plane`，没有 shared project authority；
7. 每个 controller 独立 polling provider，存在重复读取和 observation-time skew；
8. controller ID 不能替代 worktree、Git index 和 branch isolation。

因此当前最多能做“隔离 projectId 的 shadow experiment”，不能宣称一个 project 内正式 Multi-Workstream。

## 3. Safety invariants

任何实现方案都必须满足：

1. 每个 active task 只有一个 active Workstream ownership；
2. 每个 concurrent writer 有独立 governed task worktree；
3. Workstream controller 不能扩大自己的 Task/Action/Workspace scope；
4. shared surface change 必须经过 integration gate；
5. durable mutation 不能 lost update；
6. OR external effect 具有 durable grant、exact live preflight 和 provider outcome observation；
7. event replay 不重复产生 state mutation、release judgment 或 OR effect request；
8. undeclared multiple orchestrators 继续 fail closed；
9. serial authority/custody chain 不因 Multi-Workstream 自动并行；
10. `metadata` 不能成为 first-class ownership 字段的旁路。

### 3.1 Unattended-first gate semantics

正常 Workstream 运行不等待人类逐项批准。Project bootstrap 时预先绑定：

```text
autonomy_policy_ref
or_effect_authorization_grant_refs
risk_budget_ref
escalation_policy_ref
rollback_policy_ref
```

Scope 内的 task assignment、implementation、independent verification、correction、merge、retry 和 bounded recovery 可自动推进。Merge 等 provider effect 由 OR 在 exact-scope、versioned preauthorization 下无人值守执行；AO 只产出 judgment 并观察 provider outcome，不代理 effect。

只有以下事件进入 human escalation：

- 请求扩大 repository/Workstream/path/effect/credential/budget authority；
- authoritative evidence 冲突且 deterministic policy 无法裁决；
- ambiguous irreversible effect 无法通过 live reconciliation 确认；
- destructive external data mutation 缺少预授权或可恢复证明；
- security、legal 或跨 project global policy boundary。

Escalation 只暂停 affected task/lane；其他无依赖 Workstream 继续运行。Timeout 保持 fail closed，不自动批准。

## 4. Selected C1 architecture

### 4.1 Model

```text
Read-only Provider Collector
  -> normalized observation proposal

Project State Mutation Authority
  owns:
    durable state writes
    lease/ownership transitions
    event append
    state-intent validation

Workstream lane / OR
  reads:
    immutable snapshot
    routed events
    exact ControllerScope
  submits:
    state intent + evidence refs
  executes outside AO state writer:
    implementation/review/merge/closeout effects under OR grant

State Intent Queue
  validates:
    idempotency key
    snapshot revision
    ControllerScope
    task ownership
    path/shared-surface gate
```

只有 State Mutation Authority 修改 authoritative control-plane state。Provider collector 只读；OR 的 Git/GitHub effect 不进入 state-writer queue。AO 对 merge 的 authority 是之后读取到的 GitHub outcome，而不是 AO 自己生成的 effect receipt。

### 4.2 Why C1 is final

- 实际系统已稳定完成至少上百个 issue 和数十条 parent chain；
- 每小时最多合并数个 PR，ordinary state mutation 不是 throughput bottleneck；
- external provider wait 由 OR/collector 承担，不会形成 state-writer head-of-line blocking；
- single writer 直接消除 ordinary whole-state concurrent writer 的 lost-update topology；
- current file-based backend 可以先保留，不需要先迁移 SQLite。

因此不再比较 locked/sharded JSON 与 SQLite，也不设置 architecture-selection W0。未来只有 measured state query/constraint/throughput failure 才能重开 storage decision。

### 4.3 Remaining engineering risks

- state-intent durability、ordering、idempotency 和 poison-intent recovery；
- stale snapshot intent 必须 reject/rebase，不能 silent apply；
- coordinator absence 时 lanes 安全停摆，不能 fallback 到 multi-writer；
- coordinator 冷启动后恢复 pending state intents 和 exact ownership；
- provider/CLI 调用缺少 timeout 是 tail risk，可在触碰相关代码时顺手补齐，但不是 C1 prerequisite。

## 5. Required C1 regression contract

这些 fixtures 验证实现安全，不再用于选择 storage architecture：

1. two Workstreams submit state intents from the same snapshot；
2. competing ownership intents for one task；
3. overlapping path/shared-surface claims；
4. duplicate/replayed observation or state intent；
5. stale intent after dependency/version advance；
6. poison intent and queue recovery；
7. worktree-local reader resolves shared logical project identity；
8. migration/restart preserves exact active ownership；
9. coordinator absence fails closed；cold start resumes durable state intents without duplicate mutation。

Provider-blocking and post-provider-success crash fixtures do not belong to the State Mutation Authority because OR owns provider effects. OR merge safety is covered separately by its grant、live exact-head/review preflight and post-merge GitHub observation。

## 6. Workstream contracts

### 6.1 Project

```yaml
project_id: 9709kg
repository_identity: null
default_branch: main
state_authority_ref: project-coordinator:9709kg
```

`repository_identity` 必须独立于 physical worktree path。Worktree-local process 通过 explicit project config 定位 authority，不能把自己的 `.ao-control-plane` 当全局 state。

### 6.2 Workstream

```yaml
schema_version: ao.workstream.v1alpha1
workstream_id: data-governance
project_id: 9709kg
status: active
or_actor_ref: or:data-governance
or_authorization_grant_ref: grant:data-governance-delivery:v1
controller_scope_ref: scope:data-governance:v1
task_selector_ref: selector:data-governance:v1
workspace_namespace: data-governance
branch_prefix: ao/data-governance/
skill_bundle_refs:
  - 9709kg/data-governance
path_scope_ref: path-scope:data-governance:v1
```

### 6.3 ControllerScope

```yaml
controller_id: or-data-governance
project_id: 9709kg
workstream_id: data-governance
allowed_task_selector_ref: selector:data-governance:v1
allowed_judgment_scope: workstream
provider_effect_scope: none
allowed_workspace_namespace: data-governance
observation_route_ref: route:data-governance:v1
```

`--issue` 只能进一步收窄 scope，不能扩大 scope 或建立 ownership。

### 6.4 ManagedTask migration

`workstream_id` 必须成为 versioned first-class field 或独立 binding record。不得从以下位置读取 authority：

```text
managed_task.metadata.workstream_id
metadata.controller_scope
metadata.path_scope
metadata.parent_task_id
```

Migration/lint 必须把 reserved metadata keys 识别为 invalid/unsupported，防止临时写法变成 shadow contract。

### 6.5 TaskSpec migration

当前 `TaskSpec v1alpha1` 强制 `human_gates` 非空；空数组产生 blocker finding，`createTaskSpecRecord` 会把 record `state` 设为 `invalid`。这会把 human gate 声明写进每条 valid task contract。vNext 必须允许 zero human escalation trigger，并新增：

```yaml
autonomy_policy_ref: autonomy.workstream-delivery.v1
escalation_policy_ref: escalation.project-default.v1
or_authorization_grant_ref: grant:workstream-delivery:v1
human_escalation_triggers: []
```

Legacy `human_gates` 只能迁移为 exception trigger；不能继续解释成 unattended lifecycle 的必经阶段。

Migration 不得原地重解释历史记录：保留 immutable v1 TaskSpec 和当时的 `state`，另建 vNext record/revalidation receipt。Active task 需要显式 migration binding；空 `human_escalation_triggers` 使 vNext valid，但不能静默把历史 invalid/valid state 翻转。

## 7. Workspace and integration

### 7.1 One worktree per concurrent writer

Workstream 是调度 namespace，不是共享写目录。若一个 Workstream 内并行两个 child，它们也必须使用不同 task worktree。

```text
baseline/integration worktree
data-governance/task-123 worktree
data-governance/task-124 worktree
backend/task-155 worktree
```

每个 binding 包含 exact base、branch、task、owner、status 和 required `closeout_receipt_ref`。Active binding 可暂时为明确的 pending receipt；进入 terminal/GC-eligible state 前必须绑定已验证 receipt。

GC 只能在 task terminal、ownership/lease 已释放、无 live session、Git state 与 receipt 一致且 integration refs 已保存后执行。GC 先标记 registry record，再执行 bounded `git worktree remove/prune`，最后记录结果；失败保留 registry evidence，不得静默遗忘 stale worktree。

### 7.2 Path claims

Expected write set 只做 early conflict detection：

```yaml
claim_id: path-claim:task-123:1
task_id: task-123
workstream_id: data-governance
claim_kind: exclusive
patterns:
  - data/9709/**
  - schemas/knowledge-graph/**
```

Claim kinds：

- `exclusive`；
- `shared_surface`；
- `read_only`；
- `generated_output`。

Final gate 必须比较 actual Git diff/artifact manifest。未申报 write 是 scope drift；glob 无法覆盖 rename、symlink 或 external side effect。

### 7.3 Dependencies and shared surfaces

Schema、API contract、database migration、DTO、import pipeline 和 validator 可声明为 shared surface。

```text
task touches shared surface
  -> integration owner assigned
  -> dependent Workstream review
  -> compatibility fixture/eval
  -> exact version accepted
```

Dependency 未满足时，下游可以做无关 task 或使用显式 temporary fixture；不能猜测最终 contract。

### 7.4 Serial exceptions

Multi-Workstream 只并行独立 lane。已有要求 one governed worktree、one principal PR、exact-head review、exact-main replay、successor not started 的 authority/custody chain 继续 strict serial。

Parallelism permission 必须来自 dependency/surface model，不能从“系统支持多个 Workstream”推断。

## 8. Observation routing

按 C1：

```text
Read-only Provider Collector
  -> append-only normalized events
  -> State Mutation Authority
  -> Workstream read cursors
  -> decision lanes
  -> state intents / release judgments
  -> State Mutation Authority

Workstream OR
  -> provider effects under OR grant
  -> Provider
  -> read-only collector observes outcome
```

Requirements：

- provider observation 具有 source/collector timestamps；
- event 有 stable dedupe key；
- Workstream cursor 是消费状态，不复制 event authority；
- unknown/cross-lane event 进入 unassigned/supervisor queue；
- same event + same decision version 不产生重复 state intent 或 release judgment；
- collector outage 不允许 lane 将 stale snapshot 当 current；
- OR provider wait 不占用 State Mutation Authority mutation sequence；
- AO observation 记录 provider outcome，不能把 OR 自报 success 当 merge authority。

## 9. Phased evidence plan

### W1: Scope contracts

- Project/Workstream/ControllerScope；
- task binding and reserved metadata rejection；
- declared multi-orchestrator observation topology；
- undeclared topology remains degraded。

### W2: State Mutation Authority

- P0-C lease single-authority safety repair complete；
- durable state-intent protocol and revision；
- one authoritative writer；
- run §5 state regression contract；
- cold-start recovery and fail-closed coordinator absence；
- no provider effect dispatch。

### W3: Workspace, conflict and observation integration

- logical repository identity；
- governed task worktree binding；
- path/artifact claims；
- shared-surface/dependency/integration gates；
- read-only global collection/event routing；
- bounded shadow-mode integration。

### W4: Live shadow pilot

Only after versioned bootstrap authorization：

- two low-risk independent Workstreams；
- shadow only；
- no new provider write attributable to the shadow pilot；
- fixed duration and rollback；
- pre-bound integration authority；human only for unresolved escalation；
- compare against single-controller baseline。

### W5: Assist consideration

Only if shadow pilot proves：

- zero ownership ambiguity；
- zero lost update；
- zero duplicate state intent/release judgment；
- all path conflicts surfaced before integration；
- bounded automatic recovery from coordinator restart；
- escalation rate and recovery load lower than isolated-project workaround。

既有 single-Workstream system 已能无人值守完成 issue chain。Track B 的 autonomy criterion 是不引入新的 routine human wait；它不是用来重新证明 OR 可以自动 merge。

## 10. Falsifiable success criteria

| Claim | Failure evidence |
|---|---|
| scoped controllers do not steal tasks | any intent for task outside ControllerScope |
| single writer prevents lost update | any accepted intent absent from durable state without explicit rejection |
| replay is safe | duplicate state mutation or release judgment from identical event/intent key |
| workspace isolation is real | two active write owners for one worktree/index |
| conflicts move earlier | overlapping actual writes first discovered only at merge |
| unaffected lanes continue | one lane escalation/OR provider stall blocks an unrelated state/decision lane |
| coordinator is operationally cheaper | escalation/recovery load exceeds isolated-project baseline |
| declared topology is healthy | declared OR incorrectly degraded or undeclared OR accepted |

Primary Workstream metrics：

```text
unattended_workstream_terminal_rate
new_routine_human_intervention_count == 0
escalation_rate by trigger
escalation-blocked lane duration
unaffected-lane continuation rate
cold_start_recovery_duration
```

State-intent latency、throughput、queue depth、controller count 和 polling reduction 是 secondary metrics；只有 measured failure 才能重开 storage architecture。

## 11. Documentation and knowledge boundary

Multi-Workstream 不依赖 Episode Record Track 发布。若两者都存在，可扩展为 child → Workstream → Project report hierarchy；这属于 integration enhancement，不是 W1–W2 前置。

Workstream Skill scoping 也不进入 initial Multi-Workstream release。第一版可使用 explicit static refs；automatic retrieval/promotion 受 Episode Track 的 finding-volume gate 约束。

## 12. Open decisions before implementation

1. State Mutation Authority 是现有 controller 的新 mode、独立 daemon，还是 Project Supervisor process？
2. State-intent queue 第一版使用 append-only file 还是 local IPC backed by existing file state？
3. Workstream task selector 以 explicit binding 为主，还是 labels 仅作为 proposal source？
4. Logical repository identity 和 shared state endpoint 如何配置？
5. Integration authority 是指定 Workstream、independent verifier，还是 per-surface policy binding？
6. 哪两个 low-risk Workstream 适合作为 future shadow pilot？

## 13. Non-goals

- 允许多个 writer 共用 physical worktree；
- 在当前 shared `projectId + repoRoot` 直接多开 continuous controller；
- 以 SQLite migration 代替 concurrency semantics；
- 让 AO State Mutation Authority 执行 merge/provider write；
- 重新接通 `auto_merge_ready_pr` executor；
- 自动并行 strict-serial authority chain；
- 自动 Skill/policy promotion；
- 未经授权的 live experiment、merge 或 provider write。

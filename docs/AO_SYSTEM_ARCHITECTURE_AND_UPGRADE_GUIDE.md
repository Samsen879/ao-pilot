# AO 系统全景、现有能力与升级蓝图

```yaml
document_status: working_draft
audience: non_senior_technical
document_purpose: explain_current_and_target_architecture
implementation_authorized: false
last_updated: 2026-08-01
baseline_head_sha: 06a0c2aec380f897ee750f57569cc57c6bbfcc8f
baseline_tree_sha: ba236ae61577fb83b0e0e3fe7df4cd36c06de3be
source_documents:
  - AO_ARCHITECTURE.md
  - AO_DOCUMENTATION_TRAJECTORY_KNOWLEDGE_SUBSTRATE.md
  - AO_EPISODE_RECORD_SUBSTRATE.md
  - AO_MULTI_WORKSTREAM.md
```

> **2026-08-02 P0 superseding notice:** the `implementation_authorized: false`
> field describes this earlier design snapshot; the Owner later authorized the
> bounded P0 runtime portability recovery in issue #55. More importantly, prior
> operational success on the old workstation does not prove fresh-clone
> portability. `ao-pilot@0.2.0` is package-portable; P0-R04/P0-R05 add the
> locked external runtime and deterministic managed bootstrap, but lifecycle
> and self-hosting remain unproven. The authoritative correction is
> [P0-R01](runtime-portability/P0-R01_INCIDENT_BASELINE.md), and the original
> #12–#54 chain is blocked until P0-R08 closes.

> 这是一份面向非资深技术人员的系统说明书。它不替代底层 contract，也不授权开始实施。它的任务是用一套连贯的语言说明：AO 原来是什么、已经能做什么、真实项目中如何运行、为什么仍要升级，以及升级完成后整个系统会变成什么样。

## 1. 先用一句话理解 AO

AO 可以理解为 AI 编程团队的“项目调度与事实控制系统”。

它不是某一个写代码的 AI，也不是 GitHub、CI 或 Git 本身。它位于这些系统之间，持续回答几个关键问题：

- 现在有哪些任务正在进行？
- 每个任务由谁负责？
- Agent 说自己完成了，GitHub 上真的完成了吗？
- PR 当前的 HEAD、CI、review 和 merge 状态是什么？
- 某个 worker 停止后，另一个 worker 能否继续？
- 当前应该继续、等待、修复、重试，还是升级为异常处理？
- 一条长 issue chain 最后到底交付了什么？

如果把一个软件项目比作机场：

- Worker 是驾驶飞机的人；
- Independent Reviewer 是安全检查人员；
- OR（Orchestrator）是负责整条航线推进的值班负责人；
- GitHub 是外部航班与落地记录；
- AO control plane 是塔台、运行台账和异常恢复系统。

AO 的核心价值不是“替 Agent 写更多代码”，而是让无人值守推进仍然具备：

```text
可观察
可恢复
可审计
可复核
可继续
可控地自动化
```

## 2. 阅读这份文档时要区分四种状态

为了避免把“已有能力”和“计划能力”混在一起，本文使用四类标签。

| 标签 | 含义 |
|---|---|
| 当前已实现 | `ao-pilot` 当前代码和 CLI 已提供 |
| 当前运行实践 | 在 `ciecopilot-home` 等 consuming repository 中已经稳定使用，但不一定全部由 `ao-pilot` 代码强制执行 |
| 本轮目标能力 | 已在冻结设计中确定，应由升级实现 |
| 后续条件能力 | 只有前置数据或 evaluation gate 达标后才启动 |

最重要的边界是：

> 旧工作站上的系统已经稳定完成过至少上百个 issue 和数十条 parent issue chain；这证明既有环境中的运行实践，不证明 fresh clone 可恢复同一 runtime。本轮必须先通过 P0-R01–P0-R08 建立 operational portability 与新工作站 self-hosting，之后才允许启动原升级链。

## 3. AO 不是一个单体程序，而是三层系统

AO 的完整运行环境可以分为三层。

```text
┌─────────────────────────────────────────────────────┐
│ 1. Agent Runtime                                    │
│ agent-orchestrator / sessions / tmux / model tools │
│ 负责启动、承载和连接实际 Agent                       │
└──────────────────────────┬──────────────────────────┘
                           │ observations / session state
┌──────────────────────────▼──────────────────────────┐
│ 2. ao-pilot Control Plane                           │
│ task state / reconcile / lifecycle / policy /      │
│ review / handoff / checkpoint / metrics / audit    │
│ 负责判断、记录、恢复和控制                           │
└──────────────────────────┬──────────────────────────┘
                           │ task / PR / evidence contracts
┌──────────────────────────▼──────────────────────────┐
│ 3. Consuming Repository                             │
│ issues / worktrees / code / tests / CI / PR / docs │
│ 例如 ciecopilot-home                                 │
│ 负责承载真正的产品实现                               │
└─────────────────────────────────────────────────────┘
```

### 3.1 Agent Runtime 做什么

Agent Runtime 负责：

- 启动 OR、Worker、Reviewer 等 Agent session；
- 提供 terminal、tool 和模型运行环境；
- 传递消息和 handoff；
- 保存运行中的 session 信息；
- 让多个 Agent 可以协作。

它不等于 `ao-pilot`。`ao-pilot` 是围绕 runtime 建立的 control plane。

### 3.2 ao-pilot 做什么

`ao-pilot` 负责：

- 保存 task、owner、PR、review、checkpoint 等 durable state；
- 读取 AO runtime 与 GitHub observation；
- 比较内部状态和外部事实；
- 判断是否存在 stale、orphaned、blocked 或 ambiguous；
- 生成 lifecycle judgment；
- 执行 policy gate；
- 记录 audit、metrics 和 evaluation 结果；
- 为中断后的恢复与交接提供依据。

### 3.3 Consuming Repository 做什么

真正的业务代码、测试、数据、domain policy 和 PR 都属于 consuming repository。

`ao-pilot` 必须保持通用，不能把 9709KG 的具体数据治理规则、题目语义或产品逻辑硬编码进公共 control plane。Domain-specific knowledge 应由 consuming repository 通过配置、validator、Skill 或 policy 提供。

## 4. 系统中的主要角色

### 4.1 Human / Project Owner

Human 的主要职责不是逐个 PR 点击批准，而是在开始时给出清晰的 authorization envelope：

- 允许推进哪个 repository；
- 允许推进哪些 issue 或 parent chain；
- 哪些 effect 可以无人值守执行；
- 哪些路径或数据不可修改；
- 何时必须停下来请求新的 authority。

正常运行中，human interaction 应是 exception，而不是每一步的固定 gate。

### 4.2 OR / Orchestrator

OR 是一条工作流的负责人。当前真实运行中，OR 会：

- 读取 parent issue 和 child issue 顺序；
- 启动 Worker 与 Independent Reviewer；
- 跟踪 review blocker；
- 让 Worker 或自己完成修复；
- 在 fresh independent review PASS 后推进 merge；
- 完成 closeout、cleanup 和下一 child 的启动；
- 在遇到真正 authority conflict 时暂停。

本轮冻结设计明确：

> AO 是 judgment/control-state layer；OR 是 effect layer。

也就是说，AO 告诉 OR“现在的事实和判断是什么”，OR 执行 implementation、push、merge 和 closeout 等真实 effect。

### 4.3 Worker / Implementer

Worker 在一个明确 task scope 内工作：

- 使用指定 worktree 和 branch；
- 修改允许的文件；
- 运行验证；
- 创建或更新 principal PR；
- 根据 review blocker 修复；
- 不自行扩大任务范围。

### 4.4 Independent Reviewer

Independent Reviewer 不应只是重复 Worker 的自我判断。它负责：

- 绑定 exact PR HEAD；
- 读取 diff、测试、证据和产品约束；
- 给出 `BLOCKED`、`PASS` 或需要升级的 verdict；
- 明确列出 blocking findings；
- HEAD drift 后重新 review，而不是复用旧 PASS。

### 4.5 Recorder

Recorder 是本轮升级要正式引入的 capability。第一版不是一个自由写作的“文书 Agent”，而是 deterministic generator：

- 从 authenticated evidence 生成 Completion Record；
- 计算输入与输出 hash；
- 不编造 merge、review、CI 或 SHA；
- 不读取完整聊天记录来猜测事实；
- 不修改 source code。

Child Completion Record 和 Parent Final Report 是不同 job type，但可以共用 Recorder capability。

## 5. 当前 AO 的核心运行循环

当前 `ao-pilot` 的主流程是：

```text
Observe
  ↓
Ingest
  ↓
Reconcile
  ↓
Diagnose / Lifecycle
  ↓
Decide / Policy
  ↓
Record or Assist
  ↓
Checkpoint / Metrics / Audit
```

下面用普通语言解释每一步。

### 5.1 Observe：看见现在发生了什么

AO 会读取两类主要来源：

1. Agent runtime：有哪些 OR/Worker session、谁还活着、谁可能 stale；
2. GitHub：PR、HEAD、review、review comment、CI、mergeability 和 merge state。

Observation 是“某个时间点看到的外部状态”，不是最终结论。

### 5.2 Ingest：把外部信息变成统一事件

不同 provider 的字段和格式不一样。Event ingest 会把它们转成 AO 能稳定处理的 observation 和 delivery event，例如：

- PR 被创建；
- HEAD 发生变化；
- check 通过或失败；
- review comment 出现；
- review verdict 改变；
- PR 被合并。

### 5.3 Reconcile：比较“内部记忆”和“外部事实”

Reconciliation 是 AO 最重要的能力之一。

它会比较：

- AO 认为谁在负责；
- runtime 中谁实际还存在；
- PR 当前绑定哪条 branch；
- GitHub 当前 HEAD 是什么；
- review 和 CI 是否仍然对应当前 HEAD；
- 本地状态与外部状态是否出现 drift。

例如：

- AO 认为 Worker 还在，但 session 已不存在：可能 stale；
- PR 还开着，但没有有效 owner：可能 orphaned；
- reviewer PASS 对应旧 HEAD：不能继续使用；
- CI 红色但实际 job 未进入诊断步骤：应区分 infrastructure failure 和 code failure。

### 5.4 Diagnose / Lifecycle：给状态命名

AO 会把复杂事实归纳成容易处理的状态，例如：

- `healthy`：来源一致，没有明显异常；
- `blocked`：有明确 blocker；
- `pending`：正在等待正常事件；
- `stale`：信息或 owner 过期；
- `orphaned`：仍有工作或 PR，但没有有效 owner；
- `ambiguous`：证据互相矛盾，无法安全判断；
- release ready：当前证据满足进入 release 流程的条件。

### 5.5 Decide / Policy：决定下一步能不能做

AO 不应看到一个状态就直接执行。Policy layer 会检查：

- 当前 controller mode；
- TaskSpec 是否有效；
- runtime preflight 是否 clean；
- action 是否在 allowlist；
- 是否有 owner、PR 和 exact scope；
- 是否触及不可逆 effect；
- 是否存在 override 或 credential risk。

### 5.6 Record / Assist：记录判断或做有限动作

当前 controller 有三种主要模式：

| 模式 | 观察 | 生成判断/建议 | 执行允许动作 |
|---|:---:|:---:|:---:|
| `observe` | 是 | 有限 | 否 |
| `shadow` | 是 | 是 | 否 |
| `assist` | 是 | 是 | 是，受 policy 限制 |

State contract 还保留 `off`，表示 controller 已配置但不进入运行循环；上表列的是实际启动 controller 时使用的三种运行模式。

公开代码中存在 action proposal/executor，但 consuming repository 的真实 merge topology 已冻结为：

```text
AO 产生 release_ready judgment
OR 重新读取 live HEAD / review / checks
OR 执行 merge
AO 再从 GitHub 观察 merge outcome
```

因此，公开代码中的 `auto_merge_ready_pr` 不属于目标生产路径，应 deprecated 或移除。Legacy `notify_human_ready` 也应迁移为更准确的 `release_ready`。

### 5.7 Persist：把状态保存下来

AO 不只输出一段文字。它把关键状态保存到 file-based control plane 中，默认位于：

```text
.ao-control-plane/<project_id>/
├── schema.json
├── state.json
├── controller-leases.json
└── audit-log.jsonl
```

当前 state schema 最新 migration version 是 10。

## 6. 当前已经具备的功能

### 6.1 Task 管理

当前可以：

- enroll/adopt 一个 issue-backed task；
- resume 暂停任务；
- unmanage 或 retire 任务；
- 保存 branch、worktree、issue 和 metadata；
- 维护 `active / paused / retired` 生命周期。

### 6.2 Ownership 与 Controller Lease

系统能记录：

- 哪个 session 拥有哪个 task；
- ownership lease 是否 active、released 或 expired；
- 哪个 controller holder 当前持有 controller lease；
- heartbeat、stale recovery 和 shutdown 状态。

### 6.3 PR、CI 和 Review Reconciliation

系统能：

- 把 task 与 PR 绑定；
- 读取 GitHub PR/head/check/review 状态；
- 识别 review pending、changes requested、approved；
- 识别 merge conflict、unknown mergeability 和 CI 状态；
- 发现 AO 与 GitHub 的 branch/owner disagreement。

### 6.4 Doctor 与 Lifecycle

`doctor` 用来发现“哪里不健康”，`lifecycle` 用来判断“当前处于什么推进阶段”。

它们可以发现：

- stale worker；
- multiple candidate workers；
- orphan open PR；
- ambiguous ownership；
- failed observation source；
- review/CI/mergeability blocker；
- release readiness ambiguity。

### 6.5 Review Protocol

当前 state model 已有 `review_records`，支持：

```text
open
claimed
passed
changes_required
escalated
cancelled
```

并有 review freeze 和 target HEAD 的概念。它表达的是“这一 verdict 只对某个确切版本有效”。

### 6.6 Handoff 与 Recovery

AO 已有：

- handoff request；
- successor claim；
- accept/reject/expire；
- handoff transfer；
- checkpoint；
- continuity reasoning。

它们解决的问题是：一个 Worker 停止后，新 Worker 不应只靠聊天上下文猜测该从哪里继续。

### 6.7 Policy、Override 与 Credential Provenance

AO 能保存 policy decision，并将 decision 与 input fingerprint、policy version 和 finding 关联。

Override 是受控的人工干预记录，不应被当作绕过系统的快捷键。Credential provenance 用于判断某个 provider credential 是否来自可信来源。

### 6.8 Metrics、Evaluation 与 Scorecard

AO evaluation 是 deterministic fixture replay，不是模型智力 benchmark。

它支持：

- scenario pack；
- 多次 replay；
- stable fingerprint；
- run metrics；
- intervention/failure taxonomy；
- scorecard；
- named baseline compare；
- scope drift fail-closed。

### 6.9 Repo Knowledge 与 Runtime Preflight

AO 可以读取 repository knowledge，并从项目配置中识别 setup、verify、build command。Runtime preflight 用于确认当前 runtime/provider contract 是否可以安全进入 assist path。

### 6.10 Audit

重要 mutation 会产生 audit entry。这样未来可以回答：

- 谁在什么时间改变了什么记录；
- 为什么做这个变化；
- 当时依据什么；
- 某次恢复或 override 是否留下了记录。

### 6.11 CLI 与 Operator 入口

当前公共 package 已提供一组按职责拆分的命令。非资深读者不需要记住所有参数，只需理解它们不是同一个“大开关”：

| 命令 | 主要用途 |
|---|---|
| `controller` | 持续执行 observe、reconcile、decision 和 assist loop |
| `doctor` | 检查 owner、worktree、PR、provider 等健康问题 |
| `reconcile` | 比较 AO state、runtime 与 GitHub live state |
| `lifecycle` | 判断 task/PR 当前推进阶段和 release posture |
| `manage` | enroll、resume、pause 或 retire managed task |
| `review` | 创建、认领和提交 exact-head review record |
| `handoff` | 发起、认领、接受或拒绝任务交接 |
| `state` | 查看 durable control-plane snapshot |
| `metrics` | 查看 controller run 与 execution attempt 指标 |
| `eval` | 运行 deterministic scenario replay 和 scorecard |
| `override` | 写入受审计的 exception/override record |
| `knowledge` | 检查 repository knowledge contract |
| `init` | 初始化 repository-local AO 配置 |

这些命令共同操作同一套 contract。未来增加 Workstream 后，应扩展现有入口的 scope，而不是再造一套互不兼容的“多 AO 命令”。

## 7. 当前 durable state 中保存了什么

为方便理解，可以把现有 collection 分成五组。

### 7.1 Task 与 Repository

```text
managed_tasks
pr_bindings
task_specs
runtime_preflights
repo_knowledge
```

### 7.2 Ownership 与 Control

```text
ownership_leases
controller_leases
controller_modes
overrides
credential_provenances
```

### 7.3 Observation 与 Decision

```text
observations
delivery_events
controller_cursors
policy_decisions
actions
```

### 7.4 Review 与 Recovery

```text
review_records
checkpoints
handoff_requests
handoff_claims
handoff_decisions
handoff_transfers
```

### 7.5 Measurement

```text
controller_run_metrics
execution_attempt_metrics
```

这些 collection 使 AO 比单纯的 terminal transcript 更容易查询和恢复，但它们还不能完整表达 parent-child issue graph、Completion Record、Workstream、path claim 或跨 Workstream integration gate。

## 8. 当前在真实项目中如何完成一条 issue chain

以已经长期运行的 single-Workstream 模式为例：

```text
Human 在开始时给出 parent chain 与无人值守授权
  ↓
OR 选择当前 child issue
  ↓
Worker 在 governed worktree 中实现
  ↓
Worker push 并建立 principal PR
  ↓
Independent Reviewer 对 exact HEAD 审阅
  ├─ BLOCKED → OR/Worker 修复 → 新 HEAD → fresh review
  └─ PASS
       ↓
OR 重新读取 live HEAD / review / checks
       ↓
OR merge
       ↓
AO / GitHub observation 确认外部结果
       ↓
closeout / cleanup / next child
```

这套模式已经能稳定通宵运行。PR 通常不是一次通过，而是经过多轮 blocker、correction 和 fresh review 后才 merge。

这说明当前系统的基本问题不是“能不能自动推进”，而是：

- 历史 blocker 没有形成统一语料；
- child 完成后没有标准 Completion Record；
- parent chain 结束后缺少自动 Final Report；
- 同类错误仍可能在未来 review 中重复出现；
- 一个 logical project 还不能正式、安全地运行多个 Workstream OR。

## 9. 当前架构的优势

### 9.1 它已经验证了无人值守可行

真实运行规模至少包括上百个 issue 和数十条 parent chain。系统能够长时间连续推进，不依赖人逐个 PR 点击。

### 9.2 它重视 exact evidence

当前实践已经强调：

- review 绑定 exact HEAD；
- PASS 不自动等于 merge 已发生；
- GitHub live state 优先于 stale label；
- CI infrastructure failure 不等于 code failure；
- cleanup 必须有 exact scope。

### 9.3 它具备恢复基础

Lease、handoff、checkpoint、audit 和 GitHub reconciliation 使任务中断后仍有恢复依据。

### 9.4 它有 deterministic evaluation

控制逻辑可以通过 fixture 和 replay 验证，不需要每次都调用模型判断系统是否正确。

## 10. 当前架构的主要限制

### 10.1 Episode 没有标准结束记录

Child issue 完成后的事实分散在：

- PR diff；
- review body/comment；
- CI logs；
- terminal transcript；
- AO state；
- issue comments。

后来的 Agent 必须重新拼图。

### 10.2 历史经验没有结构化

Reviewer 找出的 blocker 很有价值，但当前主要留在 GitHub 评论中。系统无法直接回答：

- 哪类 blocker 最常见？
- 同类问题出现过几次？
- 哪些问题本可在 Worker preflight 阶段发现？
- 哪些应该变成 validator？
- 哪些只是一次性的 local correction？

### 10.3 Report、Lesson 与 Skill 容易混淆

如果简单把所有总结写进一份 Markdown，会产生：

- 历史事实和未来规则混在一起；
- 一次 reviewer 意见被过度推广；
- context 越来越长；
- 新旧规则冲突；
- 规则不能单独 version、eval 或 rollback。

### 10.4 当前 state persistence 不适合多个 writer

普通 collection mutation 使用 whole-state read-clone-write。多个 controller 同时写同一个 `state.json` 可能 lost update。

Controller lease 虽有独立文件和 lock，但当前还存在 lease authority 双源问题：canonical lease 文件被 overlay 到内存 state，而完整 state 又可能把 shadow copy 写回 `state.json`。这是独立 safety repair。

### 10.5 当前 project model 假设一个顶层 OR

当前 observation 对 `orchestrator_count > 1` 产生 ambiguity/degraded health；task 也没有正式 `workstream_id`。因此不能仅靠启动两个 controller ID 就安全地同时推进 data governance 和 backend。

### 10.6 Human Gate 命名与实际无人值守模式不一致

当前 `TaskSpec v1alpha1` 强制 `human_gates` 非空；`human_gate` disposition 还混入 provider failure、missing assessment 和真正 authority ambiguity。

这会把“需要重试”和“需要扩大授权”混在一起。

### 10.7 当前 release action vocabulary 与真实 topology 不一致

公开代码默认 `notify_human_ready`，同时保留一个实际不被 consuming workflow 使用的 `auto_merge_ready_pr` executor。

真实拓扑是 OR merge。继续保留错误命名和未使用 executor，会让未来维护者误以为安全保证发生在 AO executor 中。

## 11. 本轮升级的目标

本轮升级不是泛泛的“Self-Evolution System”。更准确的目标分成两条独立 Track。

### Track A：Episode Record、Trajectory 与 Knowledge Substrate

它回答：

> 一次工作真实发生了什么？哪些 blocker 被修复？未来如何避免重复？

### Track B：Multi-Workstream AO

它回答：

> 同一个 repository project 中，如何让 data governance、backend、frontend 等方向安全并行？

两条 Track 可以共享一些 contract vocabulary，但不互相阻塞发布。

## 12. 升级后的总体架构

```text
Human Bootstrap Authorization
  │
  ▼
Project Supervisor / State Mutation Authority
  ├─ durable project state
  ├─ Workstream registry
  ├─ task ownership / dependency / path claim
  ├─ event routing
  └─ integration gate
  │
  ├───────────────┬────────────────┬────────────────┐
  ▼               ▼                ▼                ▼
Data Governance   Backend          Frontend         Other Workstream
OR                OR               OR               OR
  │               │                │                │
Worker/Reviewer   Worker/Reviewer  Worker/Reviewer  Worker/Reviewer
  │               │                │                │
isolated          isolated         isolated         isolated
worktrees         worktrees        worktrees        worktrees
  └───────────────┴────────────────┴────────────────┘
                  │
                  ▼
       Shared Surface / Integration Gates
                  │
                  ▼
       GitHub provider outcome authority
                  │
                  ▼
       Completion Records / Final Reports
                  │
                  ▼
       Blocker Inventory / Lesson Candidates
                  │
                  ▼
       Validator / Skill / Policy proposals
```

## 13. 目标边界：AO 判断，OR 执行

升级后最重要的边界是：

```text
AO = observe + reconcile + judge + persist control state
OR = implement + correct + push + merge + closeout
GitHub = authoritative external outcome
```

### 13.1 `release_ready`

AO 的 release judgment 应命名为 `release_ready`。它表示：

- 当前证据满足 release 前置条件；
- OR 可以进入自己的 exact-live preflight；
- 它不表示 merge 已经发生；
- 它也不表示需要人点击。

### 13.2 OR Authorization Grant

Human 在启动时给 OR 一个 durable、versioned grant，例如：

```yaml
grant_id: grant:repo-delivery:v1
grantee_actor_ref: or:repo-delivery
repository: Samsen879/ciecopilot-home
allowed_effects:
  - push_scoped_branch
  - open_or_update_pr
  - merge_after_fresh_independent_pass
expires_at: null
```

OR merge 前必须：

1. 重新读取 live PR HEAD；
2. 确认 live HEAD 等于 reviewed HEAD；
3. 检查 fresh independent verdict；
4. 检查 unresolved review thread 和必要 checks；
5. drift 时回到 review，不 merge。

### 13.3 新的判断分类

Legacy `human_gate` 应拆成：

| Judgment | 含义 | 默认行为 |
|---|---|---|
| `release_ready` | 可以进入 OR release preflight | OR 继续 |
| `retry_required` | provider/source 暂时失败 | 自动 backoff/retry |
| `refresh_required` | 缺少或过期 observation | 重新采集 |
| `escalation_required` | 真正 authority ambiguity | 只暂停 affected scope |

## 14. Track A：从“完成了”升级为“留下可恢复事实”

### 14.1 第一步一定是 Blocker Harvest

冻结完成后，第一个 implementation task 是 P0-A。

Frozen scope：

```text
repository: Samsen879/ciecopilot-home
PR selector:
  merged_at >= 2026-07-01T00:00:00Z
  merged_at <  2026-08-01T00:00:00Z
freeze-review observed count: 371 PRs
```

Harvester 会保存：

- PR metadata；
- formal reviews；
- inline review comments；
- conversation comments；
- reviewed commit；
- merged commit；
- raw response bytes/hash；
- endpoint、pagination 和 harvester version。

### 14.2 为什么不能只看 GitHub account 或 review state

冻结抽样已经证明：

- OR 和 independent reviewer 可能都显示为 `Samsen879`；
- independent BLOCKED/PASS review 的 GitHub state 可以都是 `COMMENTED`；
- reviewer role 和 verdict 需要从稳定的正文协议识别；
- `commit_id` 必须与正文中的 reviewed HEAD 一致。

因此 blocker classification 使用：

```text
body protocol marker
+ exact reviewed HEAD
+ review/comment references
+ fresh correction/review chain
```

而不是只看：

```text
user.login
review state
comment timing
```

### 14.3 Blocker Record

每一个 merge-blocking finding 会形成一条结构化记录，核心包括：

- PR 和 reviewed HEAD；
- reviewer role basis；
- BLOCKED verdict 与原文 evidence；
- severity/category/root cause；
- correction HEAD；
- fresh PASS evidence；
- resolved/unresolved/superseded/rejected；
- finding fingerprint；
- first detectable stage。

`first_detectable_stage` 使用冻结的固定取值，避免不同 implementer 自造分类：

```text
task_intake
worker_implementation
worker_preflight
ci
independent_review
integration
post_merge
not_established
```

### 14.4 Review Round Baseline

Harvest 会建立：

```text
review_rounds_to_merge
blocking_rounds_to_merge
correction_rounds_to_merge
blockers_per_blocking_round
first_pass_independent_review_rate
first_review_to_merge_duration
```

这些指标用于判断未来系统是否真的变强。

只有“报告生成得更多”不能证明 improvement。更有意义的问题是：

> 同类 blocker 是否从 independent review 前移到了 Worker preflight？

### 14.5 Child Completion Record

每个 terminal child task 生成 child-scoped record：

```text
child-completion:<child-task-id>
```

它至少说明：

- 原目标；
- 最终 scope；
- issue、PR、base/head/merge SHA；
- delivery status；
- verification evidence；
- review/blocking/correction rounds；
- release judgment；
- GitHub merge observation；
- unresolved items；
- artifact hash 和 generator version。

第一版完全 deterministic，不调用模型生成 narrative。若 authenticated structured source 已经有 Important Decisions、Deviations 或 Lesson Candidates，可以机械转录并保留 evidence refs。

### 14.6 Parent Final Report

Parent chain 完成后生成 Final Report。它不是简单拼接 child Markdown，而是：

- 汇总 issue graph；
- 标明 child 之间的依赖；
- 去除重复；
- 区分最终方案和被放弃方案；
- 说明 cross-child design decision；
- 给出最终 repository state；
- 列出 remaining risk 与 resume guide。

## 15. Report、Lesson、Skill 永远分开

### 15.1 Report

回答：

> 这一次实际发生了什么？

按 issue/time 归档，属于 episodic memory。

### 15.2 Lesson Candidate

回答：

> 从这一次事件中，可能学到什么？

它必须带：

- source episodes；
- recurring evidence；
- applicable scope；
- exceptions；
- proposed destination；
- confidence；
- promotion status。

Lesson Candidate 不是规则。

### 15.3 Canonical Skill / Policy / Validator

回答：

> 未来应该怎么做？

只有经过 evidence review、eval、promotion 和 rollback design 的内容，才能进入 canonical layer。

### 15.4 为什么 Validator 优先

能被机器验证的 invariant，优先转成 validator/test，例如：

- required field 缺失；
- schema version 错误；
- source ID 不在 allowlist；
- duplicate key；
- artifact count 与 manifest 不一致；
- path scope 越界。

Markdown 只能提醒；validator 可以真正阻止错误进入下一阶段。

## 16. Knowledge Architecture

目标 knowledge system 分四层。

### Layer 1：Raw Evidence

```text
GitHub raw reviews/comments
CI logs
diffs
tool receipts
terminal transcript
provider observations
```

用于 audit，默认不全部进入模型 context。

### Layer 2：Episode Records

```text
Child Completion Record
Parent Final Report
review-round baseline
trajectory summary
```

用于恢复和理解过去。

### Layer 3：Lesson Candidates

从多个 episode 中提取，但尚未成为规范。

### Layer 4：Canonical Knowledge

```text
Skills
Policies
Validators
Tests
Prompt versions
```

用于改变未来行为。

### 16.1 Knowledge Track 启动门槛

P0-A 完成后，按固定门槛判断：

```text
normalized independent-review blockers >= 50
independent episodes >= 10
recurring patterns >= 3
each recurring pattern appears in >= 3 episodes
first-detectable-stage baseline exists
```

达到门槛只代表可以启动 Knowledge Track proposal，不代表自动 promotion。

## 17. Track B：Multi-Workstream AO

### 17.1 为什么需要 Workstream

大型 repository 往往同时推进：

- data governance；
- backend；
- frontend；
- content pipeline；
- testing/quality；
- infrastructure。

如果全部排队给一个 OR：

- context 会越来越长；
- 一个方向 blocked 会拖慢其他方向；
- OR 在多个 domain 间频繁切换；
- 不相关 Skill 和 evidence 会污染 context；
- repository 无法充分利用并行能力。

### 17.2 Workstream 是什么

Workstream 是一个有明确边界的长期推进方向，例如：

```yaml
workstream_id: data-governance
project_id: 9709kg
or_actor_ref: or:data-governance
branch_prefix: ao/data-governance/
path_scope_ref: path-scope:data-governance:v1
task_selector_ref: selector:data-governance:v1
```

每个 task 必须有唯一 Workstream ownership。Controller ID 或 `--issue` 不能替代正式 ownership。

## 18. C1：Single State Writer

目标系统不让多个 controller 直接重写同一个 `state.json`。

已冻结的 C1 架构是：

```text
multiple Workstream readers / decision lanes
            ↓ state intents
single Project State Mutation Authority
            ↓ serialized state mutations
durable project state
```

External effect 不进入这个 writer：

```text
OR → Git/GitHub effect
AO read-only collector → provider outcome observation
```

### 18.1 为什么不先上 SQLite

真实吞吐每小时最多合并数个 PR，state mutation 是毫秒级工作。当前问题不是数据库吞吐，而是 writer ownership。

所以第一版：

- 保留 file-based backend；
- 只允许一个 authoritative writer；
- 多个 Workstream 提交 state intent；
- stale intent reject/rebase；
- coordinator 不在时 fail closed；
- cold start 后恢复 pending intents。

只有出现 measured query、constraint 或 throughput failure，才重新评估 SQLite。

## 19. Workspace Isolation

同一个 logical repository 可以有多个 Workstream，但不能让多个 writer 共用同一个 physical working tree。

```text
repo-main/
.ao/worktrees/data-governance/task-123/
.ao/worktrees/backend/task-155/
.ao/worktrees/frontend/task-201/
```

每个 task worktree binding 包含：

- task；
- Workstream；
- owner；
- branch；
- exact base；
- status；
- closeout receipt。

GC 只有在 task terminal、ownership released、无 live session、Git state 与 receipt 一致后才能执行。

## 20. Path Claim、Shared Surface 与 Dependency

### 20.1 Path Claim

Task 开始前声明 expected write set：

```yaml
task_id: task-123
workstream_id: data-governance
claim_kind: exclusive
patterns:
  - data/9709/**
  - schemas/knowledge-graph/**
```

Claim 用于提前发现冲突；最终仍要比较 actual Git diff。

### 20.2 Shared Surface

以下内容经常跨 Workstream：

- JSON/DB schema；
- API contract；
- migration；
- DTO；
- import pipeline；
- validator；
- generated artifact contract。

修改 shared surface 时必须触发 integration gate。

### 20.3 Dependency

例如：

```text
backend task-155
depends_on
data-governance task-126
```

依赖未满足时，Backend OR 可以做其他无关 task，但不能猜最终 schema。

## 21. Project Supervisor

Project Supervisor 不是另一个到处写代码的大型 Agent。它主要是 deterministic coordination capability：

- 创建/停用 Workstream；
- 绑定 task ownership；
- 检查 path conflict；
- 维护跨 Workstream dependency；
- 路由 observation/event；
- 安排 integration order；
- 只暂停真正受影响的 lane。

它不负责：

- 直接实现所有 task；
- 替代 Workstream Reviewer；
- 在多个 worktree 中同时改代码；
- 自己批准自己的 Skill proposal。

## 22. 升级后的端到端例子

假设同时推进 data governance 和 backend。

### 22.1 项目启动

Human 一次性给出：

- repository scope；
- 两个 Workstream；
- OR grants；
- allowed effect；
- path/shared-surface policy；
- risk/rollback/escalation policy。

### 22.2 并行推进

```text
Data Governance OR             Backend OR
  ↓                              ↓
task-123                       task-155
  ↓                              ↓
isolated worktree              isolated worktree
  ↓                              ↓
Worker implementation          Worker implementation
  ↓                              ↓
Independent review             Independent review
```

### 22.3 发现 shared schema 冲突

如果两个 task 都触及同一个 schema：

```text
path claim overlap
  ↓
shared_surface gate
  ↓
dependency / integration owner
  ↓
先接受 schema version
  ↓
Backend compatibility review
```

### 22.4 Merge 与记录

每个 lane：

1. AO 产生 `release_ready`；
2. 对应 OR 做 live exact-head preflight；
3. OR merge；
4. GitHub observation 确认 outcome；
5. Recorder 生成 Completion Record；
6. Workstream/Parent 结束后生成 Final Report。

## 23. 当前与目标能力对照

| 领域 | 当前 | 升级后 |
|---|---|---|
| 基本无人值守推进 | 已稳定运行 | 保持，不回退 |
| Task ownership | task/lease，偏 single OR | Workstream-scoped unique ownership |
| 并行 workspace | Worker 可有 worktree | 每个 concurrent writer 强制独立 worktree |
| 顶层 OR | project 默认假设一个 | 每个 Workstream 一个 OR |
| State writer | whole-state ordinary writes | C1 single authoritative writer |
| GitHub collection | controller 各自 polling | shared read-only collector + routed events |
| Merge actor | OR 实际执行 | 正式固化为 OR effect |
| Release vocabulary | `notify_human_ready` 等 legacy 名称 | `release_ready / retry / refresh / escalation` |
| Child 完成记录 | 不统一 | deterministic Completion Record |
| Parent 报告 | 依赖人工整理 | evidence-backed Final Report |
| Review blocker | 留在 PR comments | committed blocker inventory |
| Improvement metric | process metrics 为主 | review/blocking/correction rounds |
| Knowledge | repo knowledge bootstrap | episode → lesson → skill/policy/validator |
| Context loading | 固定/偏全局 | domain/workstream scoped retrieval（后续阶段） |
| Human gate | 名称和触发混合 | exception-only authority escalation |
| SQLite | 未使用 | 不作为前置；measured failure 后再评估 |

## 24. TaskSpec 的目标变化

当前 TaskSpec 主要包含：

```text
problem_type
acceptance_contract
runtime_ref
policy_ref
human_gates
```

而且 `human_gates` 必须非空。

目标 TaskSpec 应支持：

```yaml
task_family: null
domain_refs: []
artifact_types: []
skill_refs: []
knowledge_scope: null
expected_validators: []
autonomy_policy_ref: null
escalation_policy_ref: null
or_authorization_grant_ref: null
human_escalation_triggers: []
```

Legacy record 不能被原地重新解释。v1 record 保持 immutable，vNext 通过 migration/revalidation receipt 建立新语义。

## 25. Human Escalation 的正确位置

正常情况不找人：

- task assignment；
- implementation；
- ordinary review correction；
- test/validator；
- exact-scope merge；
- retry/recovery；
- Completion Record；
- bounded repository-local improvement。

只有以下情况请求 human：

- 扩大 repository、path、credential 或 effect scope；
- authoritative evidence 冲突且 policy 无法裁决；
- 不可逆 external effect outcome 无法确认；
- destructive data mutation 没有预授权；
- security、legal、budget 或 global policy boundary。

Escalation 只暂停 affected lane。其他无依赖 Workstream 继续运行。

## 26. 实施顺序

### Step 0：冻结文档

先冻结设计、scope 和 authority。冻结不等于实施授权。

### Step 1：P0-A Blocker Harvest

这是冻结后第一项 implementation：

1. 枚举 371 个 July merged PR；
2. 保存 raw GitHub snapshots 与 hashes；
3. 解析 independent exact-head BLOCKED/PASS protocol；
4. 建立 blocker inventory；
5. 建立 review-round baseline；
6. 判断 Knowledge Track gate。

### Step 2：并行基础修复

- P0-B trajectory truthfulness audit；
- P0-C lease single-authority repair；
- P0-D 从 consolidation fixture 反推 schema；
- P0-E judgment/effect vocabulary migration。

P0-C 不阻塞 harvest，但必须在 shared-state Multi-Workstream rollout 前完成。

### Step 3：Episode Record v1

- `task_relations`；
- `completion_records`；
- deterministic generator；
- schema/hash self-check；
- consolidation golden backfill；
- stop-to-measure。

### Step 4：Knowledge Gate

根据 P0-A 的真实 blocker/episode/pattern 数量决定：

- 达标：起草 Knowledge Track implementation/eval；
- 未达标：保持 Lesson Candidate ledger，优先做 deterministic Validator proposal。

### Step 5：Multi-Workstream

```text
W1 Scope contracts
W2 State Mutation Authority
W3 Workspace/conflict/observation integration
W4 Live shadow pilot
W5 Assist consideration
```

## 27. 如何判断升级是否成功

### 27.1 Episode Record 正确性

- issue/PR/SHA/tree reproduction 100%；
- invented fact 0；
- missing evidence 被误报为 PASS 的次数 0；
- identical inputs 产生 stable digest；
- out-of-scope write 0。

### 27.2 真正的 Improvement

- blocking rounds to merge 下降；
- blockers per round 下降；
- first-pass independent review rate 上升；
- 同类 blocker 从 review 前移到 worker preflight；
- post-merge defect/revert 不上升；
- review coverage 不降低。

### 27.3 Multi-Workstream Safety

- controller 不领取 scope 外 task；
- lost update 0；
- duplicate state mutation/release judgment 0；
- 两个 active writer 不共享一个 worktree；
- path conflict 在 merge 前被发现；
- 一个 lane escalation 不阻塞无关 lane；
- 新增 routine human intervention 为 0。

## 28. 关键 Fail-Closed 规则

升级后仍然坚持：

- missing evidence 不等于 PASS；
- review PASS 不等于 merged；
- old HEAD PASS 不适用于 new HEAD；
- CI 没跑到诊断阶段，不等于代码失败；
- provider success 自报不等于 provider outcome；
- unknown remote effect 不自动 retry；
- metadata 不得成为 first-class authority 的旁路；
- Workstream 支持并行，不等于所有 chain 自动并行；
- timeout 不等于 human approval；
- Lesson Candidate 不等于 Canonical Skill。

## 29. 哪些事情明确不做

当前升级不做：

- 让多个 Agent 同时修改同一个 physical worktree；
- 让多个 controller 直接并发重写同一 state file；
- 为了“更高级”而立即迁移 SQLite；
- 把 merge effect 绕回 AO executor；
- 把所有 raw transcript 提交 Git；
- 第一次出现一个 blocker 就自动升级成 Skill；
- 让 Agent 自己提出规则、自己验证、自己宣布生效；
- 立即做 self-modifying controller code；
- 用一份不断膨胀的 `knowledge.md` 保存全部历史和规则。

## 30. 常见问题

### 30.1 AO 已经能通宵运行，为什么还要升级？

因为“能连续完成任务”和“能系统性复用经验、并行多个 domain、自动生成可恢复记录”是不同能力。当前稳定性是升级的基础，不是升级没有必要的证明。

### 30.2 为什么第一步不是 Multi-Workstream？

因为历史 blocker 已经存在，而且采集成本可控。Harvest 能立刻告诉我们哪些问题重复、是否达到 Knowledge Track 门槛，并建立未来 improvement baseline。

### 30.3 为什么不是先写很多 Skill？

因为没有 inventory 时，Skill 很容易来自少数印象。先采集真实 blocker，再决定哪些模式值得 promotion。

### 30.4 为什么不用 AI 自动写 Completion Record？

第一版需要先证明事实准确和 replay stable。机械事实可以由 deterministic generator 完成；模型 narrative 会增加不必要的不确定性。

### 30.5 为什么 OR merge，而不是 AO merge？

OR 已经掌握 task context，并在真实运行中稳定执行 merge。AO 再重新读取上下文并代理 effect 会增加噪声。安全纪律应落在 OR 的 live exact-head preflight，merge outcome 由 GitHub observation 确认。

### 30.6 Single Writer 会不会太慢？

当前每小时只合并数个 PR，state write 是毫秒级。真正耗时的是实现、review、测试和 provider I/O，不是 control-plane state mutation。

### 30.7 Multi-Workstream 会不会破坏严格串行 chain？

不会。只有明确独立的 Workstream 才并行。带 authority/custody dependency 的 chain 继续 strict serial。

### 30.8 Human 是否完全消失？

不会。Human 从 routine approval 中退出，但仍然拥有 bootstrap authority 和异常扩权决定。

## 31. 面向非资深技术人员的最终心智模型

当前 AO 已经像一个可以独立值夜班的项目负责人：它能安排人、看 PR、等 review、修复问题并继续下一项。

本轮升级要给它补上三类基础设施：

1. **档案系统**：每个 child 和 parent chain 都留下准确、可恢复的记录；
2. **经验系统**：把历史 blocker 变成可验证的 Lesson、Validator 和 Skill，而不是堆 Markdown；
3. **多车道系统**：同一个 repository 可以让 data governance、backend 等 Workstream 安全并行。

最终目标不是让 AO“说自己更聪明”，而是让外部证据证明：

```text
更少的重复 blocker
更早的错误发现
更清楚的恢复信息
更安全的并行推进
更少的 routine human intervention
```

## 32. 权威文档关系

本文是解释性总览。实现时仍以以下冻结设计为 authority：

- [AO System Upgrade Alignment Index](./AO_DOCUMENTATION_TRAJECTORY_KNOWLEDGE_SUBSTRATE.md)
- [AO Episode Record Substrate](./AO_EPISODE_RECORD_SUBSTRATE.md)
- [AO Multi-Workstream](./AO_MULTI_WORKSTREAM.md)
- [AO Architecture](./AO_ARCHITECTURE.md)
- [AO Configuration](./AO_CONFIGURATION.md)
- [AO Evaluation](./AO_EVALUATION.md)

若本文与底层 contract 发生冲突，应先修正文档冲突，不得让 implementer 自行选择更宽的解释。

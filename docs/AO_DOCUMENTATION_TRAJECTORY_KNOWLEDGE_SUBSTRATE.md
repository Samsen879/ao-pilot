# AO System Upgrade Alignment Index

```yaml
document_status: working_draft
input_batches_received: 7
implementation_authorized: false
worker_delegation_authorized: false
last_updated: 2026-08-01
local_state_observed_at: 2026-08-01
current_state_baseline:
  branch: codex/cie-ao-consolidation
  head_sha: 06a0c2aec380f897ee750f57569cc57c6bbfcc8f
  tree_sha: ba236ae61577fb83b0e0e3fe7df4cd36c06de3be
operator_reported_operational_baseline:
  completed_issue_count: "100+"
  parent_issue_chain_count: dozens
  review_evidence_authority: github_pr_reviews_and_comments
  merge_actor: OR
frozen_harvest_scope:
  repository: Samsen879/ciecopilot-home
  selector: "merged_at >= 2026-07-01T00:00:00Z && merged_at < 2026-08-01T00:00:00Z"
  observed_pr_count_at_freeze_review: 371
```

> 本文件是 AO 系统升级的对齐索引，不再承载一份 49-item research program。两条技术轨道拥有独立 scope、gate、验收和放行决定；任何一条都不能以另一条尚未完成为理由无限等待。

## 1. Delivery decision

如果当前只能推进一件事，优先推进：

> **Track A P0-A：从 consuming repository 的 GitHub PR review/comment 历史采集独立 reviewer 曾经给出的 merge-blocking findings，并建立 committed blocker inventory 与 review-round baseline。**

Operator 已确认 AO 稳定无人值守完成过至少上百个 issue 和数十条 parent chain，且 PR 通常经过多轮独立 review/correction 后由 OR 合并。P0-A 的主要“矿”不是所有评论，而是 independent reviewer 明确阻止 merge、随后要求 correction/re-review 的 blocker；它们只在 GitHub PR review/comment history 中、尚未结构化。Harvest scope 已冻结为 `Samsen879/ciecopilot-home` 中 2026 年 7 月按 GitHub UTC `merged_at` 计的全部 PR；冻结抽样时共 371 个。P0-A 会直接决定 Knowledge Track 是否已经达到启动门槛。

两份 active design：

| Track | Document | Priority | Release gate |
|---|---|---:|---|
| A | [AO_EPISODE_RECORD_SUBSTRATE.md](./AO_EPISODE_RECORD_SUBSTRATE.md) | 1 | 先完成 independent-review blocker harvest；再以 inventory 决定 Knowledge Track 和 backfill 排期 |
| B | [AO_MULTI_WORKSTREAM.md](./AO_MULTI_WORKSTREAM.md) | 2 | C1 已定；不再做 storage candidate bakeoff |

面向非资深技术人员的解释性入口是 [AO_SYSTEM_ARCHITECTURE_AND_UPGRADE_GUIDE.md](./AO_SYSTEM_ARCHITECTURE_AND_UPGRADE_GUIDE.md)。它负责说明现有系统、真实运行方式与目标蓝图，不替代本索引或两条 Track 的底层 contract。

## 2. Why the program was split

Episode Record 与 Multi-Workstream 只共享少量 generic vocabulary，例如 task relation、artifact ref 和 evidence digest；它们不共享 delivery gate：

| Dimension | Episode Record | Multi-Workstream |
|---|---|---|
| Primary concern | historical truth and recoverability | scoped concurrency and integration |
| Main changes | additive contract + deterministic generator | controller topology + workspace/state coordination |
| Hot-path risk | low | high |
| Storage requirement | current single-writer use is sufficient | must resolve concurrent intent/state semantics |
| Can ship alone | yes | yes, after its own evidence gate |

因此两条轨道可以复用 contract primitives，但不能合成一个 release train。

## 3. Verified corrections from review

### 3.1 Baseline and evidence volume

当前 checkout 的 `.ao-control-plane/my-project/` 不能作为业务 finding corpus：

- `.ao-control-plane/` 被 `.gitignore` 排除，future reviewer 无法复核其中的瞬时状态；
- `my-project` 是 controller CLI 的默认 project id；
- 该目录只代表 `ao-pilot` checkout 的本地 scratch state，不代表 9709KG/CIE-Copilot consuming repository 的真实运行历史。

因此当前可审计 blocker 总量仍是 **unknown**，但 operator-reported execution scale 表明它很可能不小。不能用 scratch state 的零值证明 `< 50`，也不能继续据此宣布 Knowledge Track deferred。Track A 的 P0-A 必须针对明确命名的 consuming repository，从 GitHub reviews/comments 采集并提交 `ao.independent-review-block-inventory.v1alpha1`、raw snapshot manifest 和 per-PR blocking-review-round baseline；Knowledge Track 的 go/defer decision 在 inventory 之后做。

`docs/consolidation/cie-embedded-ao/` 是现成的人工 episode fixture：

- `consolidation-manifest.json` 保存 schema、initial/final HEAD/tree、verdict 和 baseline；
- `00-baseline.md` 至 `06-cutover-report.md` 保存分阶段 trajectory；
- `FINAL_CONSOLIDATION_REPORT.md` 保存最终因果叙事和 exact evidence；
- `04-migration-log.md` 保存第一次 independent review rejection 和至少八类 finding theme。

### 3.2 Lease authority defect

当前 lease persistence 有两个副本和一条静默 fallback：

1. `controller-leases.json` 是带专用 lock 的 intended authority；
2. `readSnapshot()` 将其 overlay 到内存 state；
3. ordinary `persistState()` 又会把含 overlay 的完整 state 写入 `state.json`；
4. 专用 lease 文件缺失或不是 array 时，`readControllerLeaseRecords()` 返回 `null`；
5. `sortRepositoryStateCollections(..., { controllerLeases: null })` 保留 `state.json` 中的 stale shadow。

这可能在文件丢失、部分恢复或 migration 后复活陈旧 lease。修复会改变所有读取 `snapshot.state.controller_leases` 的 caller 语义，是独立 safety repair，不是 Track A read-only baseline 的前置；但它必须在 Track B shared-state rollout 和任何 shared-project concurrency 试验之前完成。

### 3.3 Role and generation model

不先发布九到十个名义角色。第一阶段只保留三个 capability class：

```text
Implementer
Independent Verifier
Recorder
```

`Recorder` 是 capability，不是多个不同 persona。Child record、chain finalization 和后续 curation 是 job type。

Completion Record v1 不调用模型生成 narrative。若 authenticated structured source 已经包含 Important Decisions、Deviations 或 Lesson Candidates 字段，generator 可以机械转录并保留 evidence refs；自由叙事生成只有在纯 deterministic golden backfill 通过并形成独立 proposal 后才能开启。

### 3.4 Unattended-first authorization

AO 的 normal path 不能等待 runtime human interaction。需要严格区分：

- **bootstrap authorization**：人在启动项目前定义 repository、Workstream、effect、预算、promotion 和 rollback envelope；
- **runtime human interaction**：运行中临时等待人批准某个 action。

无人值守 AO/OR 可以依赖稳定、versioned bootstrap authorization，但 routine delivery、review correction、verification、merge 和 bounded promotion 不应逐项等待 human click。

| Tier | Default execution | Examples |
|---|---|---|
| A0 — deterministic internal | autonomous | observe、record、preflight、retry、recovery、artifact generation |
| A1 — pre-authorized delivery | autonomous | AO 产出 release-ready judgment；OR 执行 scoped implementation、review correction、exact-head merge 和 closeout |
| A2 — bounded adaptation | autonomous under eval/canary/rollback budget | repository-local Validator/Skill promotion |
| E — authority escalation | pause affected lane only | scope expansion、unknown irreversible effect、credential/legal/budget boundary、unresolved authority conflict |

Human interaction 是 exception path。触发时：

- affected lane 进入 `escalation_pending` 并保存 checkpoint/evidence；
- 不执行有歧义或越权 action；
- 其他无依赖 lane 继续运行；
- timeout 不等于批准；
- human response 必须成为 exact-scope、expiring、audited authorization record。

### 3.5 Operational independence

Routine independence 来自 verifier/evidence boundary，不来自等待项目所有者：

- 不同 session，必要时不同 model；
- verifier 不把 implementer 的结论性自评作为 authority；
- adversarial verification prompt；
- exact evidence、deterministic checks、shadow/canary 和 rollback 优先于 persona 声明。

在单人组织中，runtime human escalation 提供 authority expansion，不提供组织级 independent review。

### 3.6 TaskSpec incompatibility

当前 `TaskSpec v1alpha1` 要求 `human_gates` 必填且非空；空数组会使 TaskSpec invalid。这与 unattended-first normal path 不一致。

vNext proposal：

```yaml
autonomy_policy_ref: autonomy.repo-delivery.v1
escalation_policy_ref: escalation.default.v1
or_authorization_grant_ref: grant:repo-delivery:v1
human_escalation_triggers: []
```

`human_escalation_triggers` 可以为空。Legacy `human_gates` 应迁移为 exception triggers，不再解释为每条 task 都必须经过的人类审批阶段。

### 3.7 Authorization and escalation records

Bootstrap policy 不能只是一句 prompt。它需要生成 durable、versioned grant：

```yaml
schema_version: ao.authorization-grant.v1alpha1
grant_id: grant:repo-delivery:1
grantee_actor_ref: or:repo-delivery
authority_scope:
  project_id: null
  workstream_ids: []
  path_scope_refs: []
allowed_effects: []
risk_budget_ref: null
valid_from: null
expires_at: null
issued_by: project_owner
policy_ref: null
```

该 grant 的 merge/effect 执行主体是 OR，不是 AO action executor。AO 在 grant scope 内产出 `release_ready` judgment；OR 在独立 reviewer 已通过、live HEAD 与 reviewed HEAD 一致时执行 merge，不需要人逐 PR 点击。Durable grant 必须引用启动时的人类授权、policy、repository/task scope、allowed effects、expiry 和 rollback boundary。

Legacy `human_gate` lifecycle disposition 应在 vNext 拆分：authority ambiguity 才生成 `escalation_required` 和 durable escalation record；source/provider failure 进入 `retry_required`，missing assessment 进入 `refresh_required`。Notification 只是告知，不等于 approval。

### 3.8 Operational merge boundary

当前 HEAD 实现了 `auto_merge_ready_pr` 的 exact-head authorization/execution，但实际稳定运行的 topology 不使用它：

- lifecycle 默认 `releaseReadyAction` 是 `notify_human_ready`；
- event ingest 只把 `releaseReadyAction` 暴露为可选参数；
- controller loop 调用 ingest 时没有传入该参数；
- controller CLI 也没有相应 policy/grant binding；
- 实际由 OR 在独立 reviewer 通过后直接合并 PR，AO 之后通过 GitHub observation 记录事实。

正式边界确定为：

```text
AO = judgment layer: observe -> reconcile -> release_ready / retry / escalation_required
OR = effect layer: implement -> correct -> re-read live HEAD/review -> merge -> closeout
GitHub = external outcome authority observed after the effect
```

不把 merge 收回 AO executor。Legacy `notify_human_ready` 应迁移为无 human-in-the-loop 暗示的 `release_ready` judgment；`auto_merge_ready_pr` 对该 topology 是 non-goal，应 deprecated/removed，不能继续作为看似存在的 safety guarantee。Exact-head discipline 应落在 OR merge protocol：review verdict 绑定 reviewed HEAD，OR merge 前重新读取 live HEAD 并拒绝 drift。

当前 `human_gate` 还混入了两类 infrastructure condition：`source_failure` 和 `missing_pr_assessment`。它们应进入 A0 retry/backoff/recovery，而不是 authority escalation；`review_escalated`、`doctor_ambiguous` 和 unresolved release ambiguity 才属于 E。Track A 的 trajectory audit 必须验证 disposition-to-intervention mapping。

### 3.9 Multi-Workstream architecture decision

用户已选择 **C1**，并以真实吞吐关闭 storage bakeoff：

```text
single state writer
+ multiple scoped readers/decision lanes
+ durable state intents
+ OR-owned external effects
```

实际吞吐约每小时合并数个 PR，state mutation 是毫秒级工作，head-of-line blocking 不构成 architecture decision blocker。Provider merge 不进入 State Mutation Authority；OR 直接执行，AO collector 只读 GitHub 事实。无需用 W0/provider-blocking fixture 再证明 C1，也不比较 locked JSON 与 SQLite。Coordinator 不可用时安全停摆，重启后从 durable state intents 恢复；不建设 multi-writer fallback 或 standby/failover。

### 3.10 Existing improvement baseline

Operator 报告每个 PR 通常要经过多轮 independent review/correction 才 merge。P0-A 将从 GitHub 固化 blocking chain：

```text
review_rounds_to_merge
blocking_rounds_to_merge
correction_rounds_to_merge
blockers_per_blocking_round
first_pass_independent_review_rate
first_review_to_merge_duration
```

这组指标衡量未来 Validator/Skill 是否把问题从 reviewer 前移到 worker preflight。Generator correctness metrics 只证明文档系统准确，不能替代 improvement metric。轮数下降还必须同时满足 post-merge defect/revert 不增加、review independence/coverage 不降低，避免通过少审来“优化”。

## 4. Review disposition

| Review point | Disposition |
|---|---|
| Split documentation and Multi-Workstream programs | accepted |
| Correct the false inference that AO lacked production history | accepted; operator reports 100+ issues and dozens of chains |
| Treat GitHub PR reviews/comments as current review evidence authority | accepted; P0-A becomes a blocker-first harvest |
| P0-A target repository | frozen: `Samsen879/ciecopilot-home` |
| P0-A scope | frozen: all 371 PRs merged during GitHub UTC July 2026 at freeze review |
| Distinguish independent reviewer by GitHub login | rejected; OR and reviewer can share `Samsen879` |
| Require `CHANGES_REQUESTED` for a blocker | rejected; sampled protocol uses `COMMENTED` plus deterministic BLOCKED/PASS body markers |
| Use review rounds to merge as improvement baseline | accepted with review-coverage and post-merge guardrails |
| Promote metrics baseline to Prerequisite 0 | accepted |
| Prove finding volume before building classifier | accepted; P0-A is now highest priority and expects a possibly sufficient corpus |
| Evaluate single-writer/multiple-reader model | closed by operational scale; C1 selected without storage bakeoff |
| Lease double-source safety defect | confirmed; independent safety repair before shared state rollout |
| Reduce role count and enforce capability primitive first | accepted |
| Deterministic generator before Scribe agent | accepted |
| Derive schema from consolidation fixture | accepted |
| Make completion identity child-scoped | accepted |
| Add `generator_ref` and input digest | accepted |
| Reject `workstream_id` in free-form metadata | accepted |
| Move prerequisite lane before Phase 1 | accepted |
| Treat human gate as routine promotion/release step | rejected; unattended normal path must be autonomous |
| Wire current auto-merge executor into production | rejected; AO judges, OR merges |
| Keep `notify_human_ready` as canonical judgment name | rejected; migrate to `release_ready` |
| Keep unused `auto_merge_ready_pr` as an implied safety guarantee | rejected; deprecate/remove for this topology |
| Treat provider outage/missing PR assessment as human authority gate | rejected; classify as A0 recovery |
| Allow model-generated narrative in Completion Record v1 | rejected; authenticated structured fields may be mechanically transcribed |
| Require routine Independent Verifier to repeat generator self-check | rejected; oracle independence begins at golden-fixture comparison |
| Couple lease repair to Track A baseline exit | rejected; separate safety repair before shared-state rollout |
| Multi-Workstream Candidate C shape | C1 selected: state-only writer; OR owns external effects |
| Declare SQLite as required | rejected; C1 keeps current file backend until measured failure |

## 5. Knowledge Track decision gate

Skill registry、automatic lesson classifier、prompt optimization、policy optimization 和 graph adaptation 不属于 P0-A 本身。它们是否继续 deferred 现在是 **open decision**，由 committed GitHub inventory 决定。

P0-A 完成后按预先固定门槛判断：

```text
normalized independent-review blockers >= 50
independent episodes >= 10
recurring patterns >= 3
each recurring pattern appears in >= 3 episodes
first-detectable-stage baseline exists
```

`50` 是预先固定的 engineering gate，不声称统计显著性。若 inventory 达标，Knowledge Track 可以立即进入独立 proposal/eval 设计；达标不等于自动 promotion。若未达标，则维护 Lesson Candidate ledger，并优先生成 deterministic Validator proposal；不建设 classifier/promotion factory，也不阻塞正常 delivery。

低于门槛时由 policy budget 限制 non-urgent procedural proposal 的生成频率；是否有人阅读 periodic report 不影响 AO 继续推进。Safety-critical 且可 deterministic validation 的 contract defect 走普通 engineering repair lane，不等待 Skill promotion。

## 6. Current authorization boundary

- 只允许继续修改上述设计文档。
- 不实施 lease repair、schema、generator、queue 或 Workstream runtime。
- 不运行 live Multi-AO experiment。
- 不启动或委派 Codex worker。
- 后续输入分别进入对应 track；cross-track decision 记录在本索引。

# AO Episode Record Substrate

```yaml
document_status: working_draft
track: A
priority: 1
implementation_authorized: false
depends_on_multi_workstream: false
baseline_head_sha: 06a0c2aec380f897ee750f57569cc57c6bbfcc8f
baseline_tree_sha: ba236ae61577fb83b0e0e3fe7df4cd36c06de3be
local_state_observed_at: 2026-08-01
harvest_repository: Samsen879/ciecopilot-home
harvest_merged_at_start: 2026-07-01T00:00:00Z
harvest_merged_at_end_exclusive: 2026-08-01T00:00:00Z
harvest_pr_count_observed_at_freeze_review: 371
```

## 1. Outcome

为每个 terminal child task 生成 evidence-backed、可 hash、可 replay 的 Completion Record，并在一条 task chain 结束后生成 Final Report。

在 generator implementation 之前，第一优先级是从 consuming repository 的 GitHub PR history 固化 **independent-review blocker corpus**。Operator 已报告 AO/OR 稳定完成至少上百个 issue、数十条 parent chain，block/review evidence 只存在于 PR review/comment history；P0-A 负责把“reviewer 阻止 merge → OR 修复 → fresh review”转成可审计数据。

第一版只证明：

1. repository/CI/review/audit evidence 能被确定性收集；
2. 缺失或矛盾 evidence 会 fail closed；
3. 新 Agent 不读取完整 terminal transcript 也能恢复 final state；
4. generator 不编造 SHA、verification、finding 或 outcome；
5. consolidation historical chain 可以被 backfill 成 canonical fixture。

第一版不建设 Skill registry、automatic Lesson classifier、prompt/policy optimizer、graph adaptation 或 Multi-Workstream runtime。

## 2. Falsifiable thesis

Track A 的 thesis 不是“生成了更多 Markdown”，而是：

> 给定同一组 authenticated inputs，generator 能稳定地产出同一机械事实；给定缺失或矛盾 inputs，它拒绝宣称 completion。

Primary acceptance metrics：

| Metric | Required result |
|---|---|
| exact issue/PR/SHA/tree reproduction | 100% against golden fixture |
| invented fact count | 0 |
| missing evidence falsely reported as passed | 0 |
| mechanical output replay digest | stable under identical normalized inputs |
| out-of-scope file writes | 0 |
| source-vs-generated mismatch | 0 unresolved |

Process coverage、generation count 和 pass rate 只作为 secondary observability，不构成 usefulness proof。

Generator metrics 只证明 Episode Record substrate 准确。系统是否真的变强，用既有 GitHub 历史建立另一组 outcome baseline：

| Outcome metric | Baseline source | Desired future movement |
|---|---|---|
| review rounds to merge | ordered independent review submissions per PR | decrease |
| blocking rounds to merge | blocker round followed by a new reviewed HEAD | decrease |
| correction rounds to merge | blocking round followed by a correction HEAD and fresh review | decrease |
| blockers per blocking round | normalized merge-blocking findings | decrease without weaker review coverage |
| first-pass independent-review rate | first reviewed HEAD receives PASS | increase |
| first-review-to-merge duration | GitHub timestamps | decrease |

这些指标必须带 guardrail：post-merge defect/revert 不增加、reviewer independence 和 finding coverage 不降低、review verdict 继续绑定 exact HEAD。否则“减少 review 轮数”可能只是少审或弱审。

“同类 finding 是否从 review 前移到 preflight”仍是后续 validator usefulness thesis；P0-A 以 review rounds/finding stages 建立 baseline。

## 3. Existing golden fixture

第一份 fixture 不从空白 schema 构造，而从以下真实 artifact 反推：

```text
docs/consolidation/cie-embedded-ao/
├── consolidation-manifest.json
├── 00-baseline.md
├── 01-inventory.md
├── 02-classification.md
├── 03-target-boundary.md
├── 04-migration-log.md
├── 05-parity-report.md
├── 06-cutover-report.md
└── FINAL_CONSOLIDATION_REPORT.md
```

Fixture 已包含：

- initial、implementation 和 final HEAD/tree；
- baseline status 和环境；
- canonical decisions；
- migration sequence；
- independent review rejection/corrections；
- verification classification；
- limitations、rollback 和 final verdict。

`consolidation-manifest.json` 是 structured oracle，Markdown 是 human-readable oracle。Generator output 必须同时与两者对照，不能只做文本相似度比较。

## 4. Phase 0 — Prerequisites

Phase 0 包含一个 Track A read-only prerequisite lane，以及可并行的 lease safety repair 和 judgment/effect vocabulary migration。三者不互相伪造依赖。

### 4.1 P0-A: Independent-review blocker harvest and baseline

对 **`Samsen879/ciecopilot-home`** 做一次 GitHub harvest。Scope 是 GitHub UTC `merged_at >= 2026-07-01T00:00:00Z && merged_at < 2026-08-01T00:00:00Z` 的全部 PR；冻结审阅时 Search API 返回 371 个。不得使用 ignored 的 `.ao-control-plane/my-project` scratch state 代表该运行历史；durable AO state 当前不是 review evidence authority。

Authoritative inputs 至少覆盖：

```text
GET /repos/{owner}/{repo}/pulls/{pr}/reviews
GET /repos/{owner}/{repo}/pulls/{pr}/comments
GET /repos/{owner}/{repo}/issues/{pr}/comments   # only when review evidence was posted as conversation comment
PR metadata / commits / reviewed head / merged head
```

Harvester 先按上述 immutable `merged_at` window 分页枚举 PR，并把 exact PR number list、query、page order 和 response hash 固化为 scope manifest；不依赖 parent-chain metadata，也不靠当前 open PR list 猜历史全集。Raw snapshot 可以保留所有 review material，但 normalized primary corpus 只收集 independent reviewer 的 merge blockers：

- blocker 所属 PR、GitHub source login、review-role protocol basis、optional session evidence 和 reviewed HEAD；
- explicit blocking verdict/state/reason；
- blocker text、category/severity/root cause；
- first detectable stage；
- correction commit/HEAD 和 fresh verification/PASS evidence；
- blocker first observed、resolved/obsolete/rejected state；
- recurring pattern frequency；
- source episode count；
- per-PR review/blocking/correction round count and timestamps；
- review submission/comment 与 `commit_id`/reviewed HEAD 的绑定质量。

Classification 必须是 tri-state：

```text
blocking
non_blocking
unknown
```

只有明确的 `CHANGES_REQUESTED`、`BLOCK`/`FAIL`/`not approved` verdict，或 repository review protocol 中等价的 machine-readable blocker 才进入 `blocking`。不能仅凭“comment 之后出现了新 commit”推断它是 blocker。Optional suggestion、style note、bot notification、CI infrastructure failure 和普通讨论保留在 raw snapshot，但不进入 blocker count；语义不明确时标记 `unknown`。

#### Frozen feasibility sample for reviewer identity and verdict

2026-08-01 冻结审阅抽样确认：

- PR `#1782` 有三次 formal review submission，正文分别以 `BLOCKED — independent exact-head...` 或 `BLOCKED — fresh independent exact-head...` 开头，随后有 `PASS — fresh independent exact-head review`；每次都有 GitHub `commit_id`，但 review `state` 全是 `COMMENTED`；
- 上述 BLOCKED/PASS 和 OR repair comment 的 `user.login` 都是 `Samsen879`，所以 GitHub account 不能证明 session role；
- PR `#1780` 还存在 `chatgpt-codex-connector[bot]` 的 inline P1/P2 suggestions，说明 bot account 可识别，但 suggestion 不自动等于 independent-review blocker。

因此 B-2/B-3 的 frozen rule 是：

1. `user.login` 只保存为 source identity，不用它判定 OR/reviewer role；
2. `state === CHANGES_REQUESTED` 可作为 blocker evidence，但不是必要条件；
3. independent-review role/verdict 由 versioned body protocol marker 识别，例如正文同时包含 `BLOCKED` 或 `PASS`、`independent exact-head` 和 reviewed HEAD；
4. GitHub `commit_id` 必须与正文声明的 reviewed HEAD 一致，否则分类为 `unknown`；
5. connector bot P1/P2 comments 单独保存为 `automated_inline_suggestion`；除非被 explicit independent BLOCKED review 引用，否则不计入 primary blocker corpus。

Normalized blocker record 至少包含：

```yaml
schema_version: ao.independent-review-block.v1alpha1
block_id: block:<repository>:pr-<number>:review-<id>:finding-<ordinal>
parent_chain_ref: null
pr_number: null
reviewer_actor_ref: null
github_actor_login: null
review_role_basis: null
review_session_ref: null
review_ref: null
comment_refs: []
review_round_id: null
reviewed_head_sha: null
classification: blocking
blocking_basis: null
severity: null
category: null
summary: null
observed_stage: independent_review
first_detectable_stage: null
finding_fingerprint: null
correction_head_sha: null
resolution_review_ref: null
resolution_verdict: null
status: unresolved
evidence_refs: []
```

`status` 只允许 `unresolved | resolved | superseded | rejected`。`resolved` 必须有 correction HEAD 和 fresh independent review evidence；merge 本身不能反推 blocker 已解决。

`first_detectable_stage` 的 frozen value domain：

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

它表示根据 blocker evidence 判断的最早可发现阶段，不是实际发现阶段；实际阶段单独记录在 `observed_stage`。无法可靠前推时必须使用 `not_established`，不能为满足 gate 猜测。

当前可确认的只有 consolidation migration log 记录了至少八类 review finding theme；全量 normalized blocker 数仍为 **unknown**，直到 consuming-repository inventory 被提交并通过 source/classification-coverage review。

输出三类 committed artifact：

```text
ao.github-review-snapshot-manifest.v1alpha1
  target_repository_identity: Samsen879/ciecopilot-home
  selector: merged_at >= 2026-07-01T00:00:00Z && merged_at < 2026-08-01T00:00:00Z
  exact_pr_numbers
  enumerated_pr_count
  endpoint_page_refs_and_sha256
  harvester_version

ao.independent-review-block-inventory.v1alpha1
  source_snapshot_manifest_ref
  blocker_count
  unknown_classification_count
  episode_count
  pattern_count
  first_detectable_stage_counts
  source_coverage

ao.review-round-baseline.v1alpha1
  source_snapshot_manifest_ref
  per_pr_rounds
  review_round_distribution
  blocking_round_distribution
  correction_round_distribution
  first_pass_review_rate
  head_binding_coverage
```

GitHub review/comment 可编辑，harvest 必须保存 paginated raw response bytes 或 content-addressed raw artifact，并记录 endpoint、parameters、fetch time、page order、ETag（如有）、SHA-256、PR/head/merge refs 和 harvester version。Committed manifest 指向这些 immutable snapshots；未来 normalization 不能直接重新查询 live GitHub 后覆盖原 baseline。

Round v1 定义：一个 independent review submission 及其关联 review comments、`commit_id` 和 verdict 构成一轮；其中包含至少一个 `blocking` finding 的是 blocking round。Blocking round 后出现 correction HEAD 并再次 fresh review，计为一次 correction round。无法绑定 review submission/HEAD 的 conversation comment 保留为 evidence，但标记 `head_binding: not_established`，不得强行计入 exact-head blocking round。

Inventory 出来后再执行 Knowledge Track gate：达到固定门槛则允许进入独立 proposal/eval；未达到才 deferred。P0-A 不以“证明语料不足”为目标。

### 4.2 P0-B: Trajectory truthfulness audit

验证所有会进入 Completion Record 的 action/outcome vocabulary：

- AO judgment 与 OR external effect 分离；
- `release_ready` 只证明 AO judgment，不宣称 merge 已发生；
- OR merge 由 versioned OR grant 授权，并在 merge 前 re-read live HEAD/review；
- GitHub post-merge observation 是 external outcome authority，不能由 OR/AO 自报 receipt 替代；
- code failure、runner failure、queued、cancelled-before-diagnostics 和 not-run 不混写；
- review verdict 绑定 exact target HEAD；
- merge/integration evidence 不从 PASS 推断。
- lifecycle disposition 与 intervention taxonomy 对齐：provider/source outage 和 `missing_pr_assessment` 是 A0 retry/backoff/recovery，不是 authority escalation；`review_escalated`、`doctor_ambiguous` 和 unresolved release ambiguity 才进入 E。

已有 AO effect receipt implementation 是 vocabulary audit input，但它不在实际 OR merge path 上，不能作为 merge truth 或免检证明。

Current-to-target mapping：

| Current trigger/basis | Current disposition | Target judgment | Receiver behavior |
|---|---|---|---|
| release ready / `notify_human_ready` | notification action | `release_ready` | OR re-reads live HEAD/review and merges under grant |
| `review_escalated` | `human_gate` | `escalation_required` | pause affected scope |
| `source_failure` | `human_gate` | `retry_required` | bounded retry/backoff/recovery |
| `missing_pr_assessment` | `human_gate` | `refresh_required` | refresh/retry/backoff |
| `doctor_ambiguous` | `human_gate` | `escalation_required` | pause affected scope |
| `releaseStatus === ambiguous` | `human_gate` | `escalation_required` | pause affected scope |

### 4.3 P0-C: Controller lease single authority — separate safety repair

P0-C 与 P0-A/P0-B/P0-D 并行，使用独立 safety PR；它不阻塞 Track A 的 read-only inventory、schema derivation 或 deterministic backfill。它必须在 Track B shared-state rollout 或任何 shared-project concurrency work 之前完成。

Required contract：

1. exactly one canonical lease authority；
2. `state.json` 不得持久化或复活 controller lease shadow；
3. canonical lease file 缺失、malformed 或 mixed-version 时 fail closed；
4. recovery 必须显式、audited，不能 silent fallback；
5. ordinary collection upsert 不得刷新或覆盖 lease；
6. tests 覆盖 missing file、invalid JSON/shape、stale shadow、partial recovery 和 concurrent heartbeat。

移除 shadow 不是局部 write-path patch：`readSnapshot()` 当前会把 canonical lease overlay 到 `snapshot.state.controller_leases`，多个 controller/state/debt caller 依赖这一 read shape。实施前必须列出 caller inventory，定义兼容 snapshot projection 或显式 breaking migration，并验证所有 read paths。本文只规定 safety outcome；具体 migration/repair design 需独立 implementation review。

### 4.4 P0-D: Derive the artifact schema

从 consolidation fixture 建立 field coverage ledger：

| Source fact | Candidate field | Required? | Deterministic source |
|---|---|---:|---|
| issue/task identity | `child_task_id` | yes | TaskSpec/managed task |
| parent relation | `parent_task_refs[]` | no | task relations |
| reviewed implementation | `head_sha` | conditional | review/PR evidence |
| integrated result | `merge_sha` | conditional | provider evidence |
| output generator | `generator_ref` | yes | generator manifest |
| normalized inputs | `generation_inputs_digest` | yes | input manifest |
| output bytes | `content_sha256` | yes | generated artifact |
| limitations | `unresolved_items[]` | yes, may be empty | evidence synthesis |

Fields unsupported by fixture or clear future use should not enter v1alpha1.

### 4.5 P0-E: Formalize the AO judgment / OR effect boundary

当前实际运行已经无人值守闭环，但 merge 不经过 AO action executor：AO 判断 ready，OR 直接合并，AO 再从 GitHub 观察结果。Required contract：

1. 将 legacy `notify_human_ready` 重命名/迁移为 judgment `release_ready`；它不等待 human，也不声称 effect 已发生；
2. OR 的 versioned authorization grant 记录“独立 reviewer 通过后允许自动 merge”的 repository/task/effect scope；
3. OR merge 前 re-read live PR HEAD、review verdict/threads 和必要 checks，确认 live HEAD 等于 reviewed HEAD；drift 时回到 review，不合并；
4. merge 后以 GitHub observation 作为 authoritative outcome，记录 merge SHA/state；
5. AO 的 `auto_merge_ready_pr` executor 不接入该 topology，标记 deprecated/removed；不能让未使用代码暗示生产 safety guarantee；
6. provider outage、missing assessment 进入 bounded retry/backoff，不伪装成人类授权问题；
7. `human_gate` 拆成 `escalation_required`、`retry_required` 和 `refresh_required`。

P0-E 是 vocabulary/authority migration，不是把 merge effect 绕回 AO。P0-A 可在其实现前独立 harvest 历史事实。

### 4.6 Phase 0 gates

立即可执行的下一项只有 P0-A harvest；不等待 P0-C/P0-E implementation。

Track A Phase 1 may start only when：

- consuming-repository independent-review blocker inventory 已 committed，并报告 target/source/classification coverage limits；
- trajectory vocabulary audit has no unresolved false-success path；
- consolidation field coverage ledger is complete；
- AO judgment / OR effect contract 已冻结；
- no Skill/classifier work has been smuggled into scope。

Independent shared gates：

- P0-C complete before Track B shared-state rollout/shared-project concurrency；
- P0-E vocabulary migration 不得中断既有 OR unattended delivery；
- P0-C、P0-E implementation 不阻塞 P0-A/P0-B/P0-D 的 read-only baseline work。

## 5. Phase 1 — Minimal contracts

### 5.1 Collections

Initial additive collections：

```text
task_relations
completion_records
```

Do not add `documentation_jobs`、`documentation_reviews`、`report_artifacts` collections until the generator proves a separate durable lifecycle is necessary. Artifact body can initially be addressed through `completion_records.artifact`.

### 5.2 Task relation

Parent/child 和 dependency 是不同 edge kind：

```yaml
schema_version: ao.task-relation.v1alpha1
relation_id: relation:<source-task-id>:<kind>:<target-task-id>
source_task_id: task-120
target_task_id: task-123
relation_kind: parent_of
status: active
created_at: null
retired_at: null
```

Multi-parent 如被允许，由多条 relation 表达，不进入 Completion Record identity。

### 5.3 Completion Record identity

Identity 必须 child-scoped：

```text
child-completion:<child-task-id>
```

不能使用 `<parent>:<child>` 作为 identity。Parent 是可变 relation，使用 `parent_task_refs[]` 表达。

### 5.4 Completion Record manifest

```yaml
schema_version: ao.child-completion.v1alpha1
record_id: child-completion:task-123
child_task_id: task-123
parent_task_refs:
  - task-120
issue_number: 123
pr_number: 88
delivery_status: integrated
base_sha: null
head_sha: null
merge_sha: null
task_spec_ref: null
autonomy_policy_ref: null
or_authorization_grant_ref: null
release_judgment_ref: null
review_refs: []
verification_refs: []
escalation_refs: []
evidence_refs: []
review_round_summary:
  review_round_count: null
  blocking_round_count: null
  correction_round_count: null
  blocker_count: null
  first_pass: null
  head_binding_coverage: null
merge_observation_ref: null
generator_ref: ao.episode-generator@0.1.0
generation_inputs:
  manifest_uri: null
  manifest_sha256: null
generation_inputs_digest: null
artifact:
  uri: null
  media_type: text/markdown
  content_sha256: null
  byte_length: null
generated_at: null
unresolved_items: []
```

Rules：

- `delivery_status` v1 只允许 `review_passed | integrated | abandoned`；consumer-specific state 必须先映射到该 enum 或拒绝生成；
- `merge_sha` 可为 `null`；不能因 review PASS 推断 merge；
- `release_judgment_ref` 只记录 AO judgment；`delivery_status: integrated` 和 `merge_sha` 必须来自 GitHub observation；
- `or_authorization_grant_ref` 标识 effect authority，不能错误指向 AO executor authorization；
- review/blocking round 和 blocker fields 必须来自 committed GitHub snapshot；无法绑定 HEAD 或 blocking verdict 时显式降低 coverage，不推断；
- exact refs 缺失时保留 `null` 并产生 blocker/finding；
- `generation_inputs_digest` 覆盖 canonical ordered input manifest，不只覆盖 URI；
- timestamps 不进入 replay-stable body digest，或必须通过 canonical normalization；
- record update 必须保留 prior artifact lineage。

### 5.5 Reserved metadata keys

未来 first-class 字段不得借 `ManagedTask.metadata` 旁路。至少 reserve 并拒绝：

```text
workstream_id
parent_task_id
parent_task_refs
task_relations
documentation_status
completion_record_id
```

Migration 前，lint/policy 遇到这些 metadata keys 必须产出结构化 finding，并 fail closed 或明确标为 unsupported—not silently interpret them as authority。Finding 至少记录 offending key、task、source artifact 和建议 migration destination，方便 backfill 形成可审计清单。

## 6. Phase 2 — Deterministic generator

### 6.1 Generation split

机械事实由 code 生成：

- objective/spec refs；
- final file/module changes；
- Git diff/stat；
- issue、PR、base/head/merge SHA；
- CI/check/review status；
- verification commands and receipts；
- independent-review blockers and corrections；
- review/blocking/correction rounds、reviewed HEAD binding 和 first-pass status；
- raw GitHub snapshot refs/hashes and normalization coverage；
- audit-derived event timeline；
- final artifact/state refs；
- unresolved/missing evidence findings。

Completion Record v1 **不调用模型生成 narrative**。Important Decisions、Deviations 和 Lesson Candidates section 可以存在，但只能机械转录 authenticated structured source 中已经存在的字段/引用；没有结构化证据就省略或标为 `not established`。

Narrative generation 是 Phase 3 之后的独立 proposal，不能混入 v1 replay、成本或 usefulness 结论。

### 6.2 Capability primitive

先实现一个 primitive，再派生 job type：

```text
RecorderCapability
read: authenticated evidence envelope
write: one bound artifact path
forbidden: source/runtime config/canonical knowledge
gate: actual Git diff matches write allowlist
```

Initial capability classes：

| Capability | Responsibility |
|---|---|
| Implementer | bound source/task changes |
| Independent Verifier | Phase 3 将 generator output 与独立 hand-written oracle 比对；future narrative 开启后校验叙事 claim |
| Recorder | deterministic artifact generation and self-check |

Child Recorder 和 Chain Finalizer 是同一 capability 的不同 input/output schema，不是独立 authority persona。

### 6.3 Canonical generation

Generator 必须定义：

- input ordering；
- JSON canonicalization；
- newline/encoding；
- timestamp normalization；
- missing/null representation；
- stable section order；
- generator version；
- output digest calculation。

同一 normalized input manifest + generator version 必须产生相同 content digest。v1 没有 narrative digest。

### 6.4 Unattended acceptance loop

Completion Record 的 normal path 不需要 human approval：

```text
terminal evidence observed
  -> deterministic generation
  -> deterministic self-check + schema/hash/evidence validation
  -> pass: record accepted
  -> correctable input/generation finding: Recorder regenerates
  -> unresolved authority contradiction: escalation_pending
```

重复运行同一 generator 不称为 independent verification。Routine acceptance 依赖 self-check；真正的 independence 在 Phase 3 来自预先存在的 hand-written consolidation fixture/oracle。Human escalation 只处理 authoritative sources 互相矛盾、请求扩大 scope 或需要新的 authorization envelope。

## 7. Phase 3 — Backfill and stop-to-measure

### 7.1 Golden backfill

将 `cie-embedded-ao` chain 映射为：

- task relation fixture；
- one or more child/phase completion manifests；
- deterministic chain final report；
- known independent-review blocker inventory；
- explicit limitations and rollback refs。

### 7.2 Comparison

比较 generator 与手工 artifact：

- exact structured facts；
- missing facts；
- evidence coverage；
- false positive completion；
- per-PR review/blocking/correction round exact reproduction；
- blocker classification、blocker count、round baseline distribution and head-binding coverage；
- generator wall-clock runtime；
- model token cost（v1 required result 为 `0`）；
- output size/context reduction。

### 7.3 Stop gate

Phase 3 完成后必须停止扩建并运行一次 versioned go/no-go evaluation。Independent Verifier 可以依据预先固定阈值自动给出结果；只有 evidence contradiction 或 threshold 变更请求才 escalation。

只有以下结果成立才继续推广到 future child issue：

- primary metrics 全部通过；
- generator 明显减少恢复所需人工读取量；
- measured generator runtime/maintenance cost 低于手工 completion record；
- trajectory false-success path 已闭合；
- no new authority ambiguity。

否则保留通过的最小 manifest primitive，放弃 narrative/role/lifecycle 扩展。P0-C 和 P0-E 使用各自 safety/migration gate，不由 golden backfill 的结果代替。

## 8. Knowledge Track decision after inventory

Knowledge Track 不再预先判定为 deferred。Operator-reported scale 是上百个 issue、数十条 parent chain，但 finding/episode/pattern 的 normalized 数量必须以 P0-A committed inventory 为准。

Skill/classifier proposal 的固定门槛：

```text
normalized independent-review blockers >= 50
independent episodes >= 10
recurring patterns >= 3
each recurring pattern appears in >= 3 episodes
first-detectable-stage baseline exists
```

若未达到门槛：

- 系统持续维护 machine-readable finding ledger 和 periodic report；
- policy budget 限制 non-urgent procedural proposal 频率；
- deterministic invariant 可直接进入 validator engineering proposal lane；
- procedural lesson 保持 candidate；
- 不建设 Skill registry、dedup classifier 或 Knowledge Curator fleet。

若门槛满足，允许立即起草独立 Knowledge Track implementation/eval plan；这不等于 findings 自动晋升。Repository-local promotion 仍应优先使用 autonomous A2 gate：independent verification、offline replay、shadow/canary、bounded risk budget 和 automatic rollback。只有扩大 repository/global authority、增加 credential/effect scope 或无法回滚时才请求 human escalation。

## 9. Open decisions before implementation

1. Golden fixture 映射为一个 chain record 还是多个 phase child records？
2. Artifact 默认进 Git、`.ao-control-plane` 还是 external store？
3. Historical consolidation finding 的 source coverage 能否精确回到 review comments，还是只能标记 report-derived？
4. `review_passed` terminal record 是否允许后续追加一个 `integrated` successor record，还是同 identity 做 lineage-preserving update？

## 10. Non-goals

- Multi-Workstream controller execution；
- SQLite migration；
- global event router；
- autonomous Skill promotion；
- self-modifying prompt/policy/controller；
- live provider write；
- historical transcript 全量入 Git。

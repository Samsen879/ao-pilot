# Readiness 与项目批量恢复（A2 / #125）

实际源码基线：`28b4fc767880b6529f38efa87d72a99f4e2007a9`，R2。

## Readiness 契约

`GET /healthz` 仍是进程活性。`GET /readyz` 返回已有身份字段，以及
`status`（starting / ready / degraded）、`ready`（boolean）、`reasons`
（`[{code,message}]`，稳定 code + 诊断文本）。只有 ready=true 且无 reason 为
HTTP 200；starting/degraded 均为 HTTP 503。安装器不得只检查 health 200。

boot admission 与健康依赖分开：

- 配置、DataDir/discovery ownership、打开 DB 等初始化失败：继续阻止启动。
- 首次恢复集合无法读取（`ErrRecoveryUnavailable`）：不启动周期 reaper，不开放
  REST；请求停止当前 daemon，让 supervisor 按已有策略重试。
- 个别会话恢复/回放/清理失败：继续其他项，完成 boot admission，但
  `session_reconcile_failed` 降级。错误聚合含失败会话，不把全部日志吞为成功。
- 同步 runtime/workload probe 或 lifecycle reduction 失败：
  `runtime_reconcile_failed` 降级。单次失败不终止后续 session 探测或周期循环。
- cold-start 限额、无可恢复对话、spawn HOLD/pending 属于保留现有工作且不自动启动
  的预期分类；不因为这些有意跳过而声称发生操作失败。

boot 完成后的 degraded 不关闭 REST，显式 restore、列表和诊断仍可使用。
启动错误反映完整 boot 快照，单项目恢复成功不能证明其他项目也已修复，因此不会
自动清除全局 boot 错误；重新成功启动会重算。以后依赖自检可通过共享
`Server.MarkDegraded(...ReadinessReason)` / `ClearDegraded(code)` 独立更新自己的
reason（A3 tmux 检查复用），不覆盖其他依赖。`MarkReady()` 只完成 boot admission。

Go `status` 能读经过 service/PID 归属验证的 readyz 503，报告 degraded 与原因；
`doctor` 将 degraded daemon 标为 FAIL，不能因它仍可提供恢复 API 而误报 PASS。

## NATIVE-F06 静态结论及顺序

原 `startLifecycle` 立即启动周期 reaper，而 session manager 首次 `Reconcile`
要在 HTTP 开始服务后才运行。reaper 可能先经 LCM 把失去 runtime 的 live session
改为 terminated；没有 shutdown marker 时，首次 Reconcile 随后就不再捕获其 WIP
并自动恢复。真实 SQLite + fake runtime 测试复现该交错。

现在 LCM、activity hooks 等先可用，周期 reaper 等待屏障：
`session Reconcile → 同步 runtime Reconcile → 放行周期 reaper → boot admission`。
取消时屏障等待者退出，shutdown 会 join；不依赖 timer 快慢避免竞态。

NATIVE-F07（terminated session 的辅助清理失败缺少持久重试资格）并不自然由这个
启动屏障解决，仍在 #125 单独延后；本 PR 不新增 cleanup obligation/schema。

## 显式批量恢复

原生 Go CLI：

```sh
ao session restore --project <project-id> --all --concurrency 4 --json
```

保留单会话 `ao session restore <id>`。`--all` 必须指定 project，不能同时给 id；
concurrency 为 1..16，默认 4。root Node `ao-pilot restore ...` 的最小代理由 B2
独占 `bin/ao-pilot.js` 路径接线；A2 不修改 Node Lane B 文件，也不把 browser
`ao-pilot session` 的旧语义替换为 Go CLI。

API：`POST /api/v1/sessions/restore`，body
`{"project":"<project-id>","concurrency":4}`。只接受一个 JSON object，拒绝未知字段。
这个路由专用预算 15 分钟，Go CLI 给 5 秒响应余量；其他 REST/CLI timeout 不变。
必须等待 boot admission，degraded 时仍可调用。

响应固定包含 `projectId` 与逐项 `results`：

```json
{"projectId":"fixture","results":[
  {"sessionId":"fixture-1","outcome":"restored","reason":"restored","restoreMode":"native"},
  {"sessionId":"fixture-2","outcome":"skipped_hold","reason":"spawn_hold_or_pending"},
  {"sessionId":"fixture-3","outcome":"failed","reason":"preserved_replay_pending"}
]}
```

所有 Orchestrator 恢复完成后，才启动 worker pool；每组并发数不超过 N。
每个恢复保留原 AO session ID/CID、workspace/branch、agent native conversation ID，
沿用已有 native resume 或 saved_prompt/fresh 分类，不新建会话身份。
显式选择项目的所有记录，terminated 无自动 marker 的记录也可按现有 metadata
恢复；缺 workspace/branch/对话等沿用现有 fail-closed guard，逐项失败，不虚构恢复。
未知项目且没有记录时是空结果；旧项目配置缺失但保留会话的既有兼容行为不变。

HOLD 的实际来源是 native `spawn_attempt_sessions` 绑定与本地 attempt journal：
绑定的 attempt 只有 committed 才允许恢复；HOLD、pending、丢失/读取失败均
`skipped_hold`，保持 custody，reason 不混淆为成功。这里不读取 Node recovery
manifest、不引入新的统一 HOLD 字段，也不把 `ActivityBlocked`（权限弹窗）泛化为
安装态 HOLD。恢复调用仍执行既有 spawn custody guard。

重复执行时，非 terminated session 只有 runtime 确认存活且没有待回放 preservedRef，
才返回 `restored / already_running`，不再 spawn；unknown/dead runtime 逐项失败，
需要协调后再恢复。单会话和批量恢复共用 in-flight resume guard，重叠调用不能
并发重拉同一 CID。

一次请求本身的成功（200）不代表全部会话恢复：逐项读取 outcome。任何 failed 使
Go CLI 退出码 1，仍先输出完整逐项结果；参数错误退出码 2。HOLD 跳过明确输出。

部分 replay 失败沿用 #135：保留 refs 和 session_worktrees 记录，可在保留工作目录
中诊断；即使 agent 已启动，该项仍报告 failed/preserved_replay_pending，重复执行
不伪装 already_running 成功。launch/上下文取消失败不删除 marker/ref，其他会话
继续产生各自结果。取消发生在 inventory 已捕获后时，未开始项也列 failed + 原因；
若连 inventory 都无法读取，则返回请求级错误而不捏造未知会话集合。断开的客户端
无法接收响应，但服务端仍保留恢复 custody。

## 验证与本地待验

云端测试仅临时 SQLite、fake runtime/agent、临时文件和假 HTTP transport；
不启动真实 AO、systemd、tmux 会话或业务 agent。覆盖：

- Reconcile 部分失败 → degraded；fatal enumeration 不放行；degraded 恢复 API 可用。
- reaper 旧交错资格丢失、修正顺序保留资格、屏障取消与 join。
- Orchestrator 两阶段、bounded concurrency、HOLD、terminated 无 marker、
  already_running 幂等、partial replay、取消、原 CID/native conversation。
- API 参数/JSON 与各 outcome、CLI JSON/退出码、Go status degraded。
- OpenAPI 从 Go 重新生成，契约一致检查。

本地待验：仅在独立 staging（DataDir/discovery/socket/ports/units/CLI config 都
独立），用 fake counter agent 做一次部分故障启动，读取 readyz 原因，执行批量
恢复并逐项核对 CID、PTY 输出和保留的 WIP。真实 systemd/cgroup/WSL2 验收仍是
A3/B2 staging 步骤。本 PR 不改 schema、runtime lock、tag 或生产安装。

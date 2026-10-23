# Native 消息结果与 ACK

发送结果区分“已观察到提交”“未确认”“被拒绝”和“worker 显式确认读取”。不是重投队列；超时、取消、重启、重复命令都不会自动再次注入正文。普通消息默认不要求 ACK；给既有 worker 派发/重定向任务使用 `--require-ack --json`。

```sh
ao message-contract --json
ao send --session project-2 --message "继续实现约定任务" --message-id task-42 --require-ack --ack-timeout 30s --json
# worker 读取末尾一行后，在原 session 环境执行：
ao-pilot ack task-42
```

`ao send` / `ao ack` 与 root `ao-pilot send` / `ao-pilot ack` 语法一致。root 的固定 runtime 代理由 Node lane 提供，不能回退到 browser legacy send。

| outcome | HTTP | CLI exit | 意义 |
| --- | --- | --- | --- |
| submitted_confirmed | 200 | 0 | native durable ActivityActive 时间新于注入前的基线；不表示已经阅读 |
| submitted_unconfirmed | 202 | 3 | 已尝试注入/提交，但安全确认预算耗尽或状态未知 |
| rejected | 409 | 4 | 被安全策略或 ID custody 拒绝；看 evidence.code |
| acknowledged | 200 | 0 | require_ack 消息由绑定目标 session 显式 ACK |
| ack_timeout | 504 | 5 | require_ack 等待届满或调用方取消，没有持久 ACK 证据 |

基础设施/协议错误 exit1，参数错误 exit2。业务非零结果在 `--json` 时仍输出 JSON；不能只看任意2xx、`res.ok` 或旧的 `ok:true`。

输入：`{message,message_id?,require_ack?,ack_timeout_ms?}`。结果顶层 `{message_id,outcome,evidence}`，evidence含 `code,signal,attempts,recorded_at`，ACK可带 `acknowledged_at`，ID冲突可带 `existing_outcome`。signal是 `none/activity_active/explicit_ack`。不返回或记录正文。message_id只允许1..128个字母、数字、下划线、短横线，可安全拼入指定ACK行；省略时生成UUID。显式ACK budget为1..60000毫秒，默认30000，普通消息不允许设置它。

新客户端先查询 `GET /api/v1/message-contract`（`ao.message-contract.v1`），再调用协议专用 `POST /api/v1/sessions/{sessionId}/messages`。握手后 daemon 被旧版替换时，新路由404，不会触发旧版宽松body解码的 `/send`。新daemon保留 `/send` alias供现有调用者；新CLI不使用alias。ACK为 `POST /api/v1/sessions/{sessionId}/messages/{messageId}/ack`，body `{}`。缺能力/未知契约不退旧接口、不向ambient CLI发送。

发送服务总预算90s，CLI95s，尊重更短父context。确认沿用至多3次guarded Enter、每轮2s；正文只注入一次。ACK等待在提交确认后开始，默认30s/最多60s；ACK写回服务10s、CLI15s。持久化取消后的收尾独立context最多2s。其他API、restore、terminal和status超时不变。

## 记录与竞态

migration44增加 `session_messages`。全库唯一messageID在任何pane副作用前原子占位，固定session、清洗后的调用方message UTF-8 SHA256、require_ack、结果/evidence、版本和时间。自动ACK行及copilot包装不计入caller hash。正文不会作为可重放payload保存。

同ID并发只一个winner能发送。重复发送已经acknowledged的ID，本次请求409 rejected / MESSAGE_ALREADY_ACKNOWLEDGED / exit4；原DB行仍acknowledged。不能把返回旧成功记录当成本次重发成功。其他重复ID也拒绝；跨session、不同正文hash或require_ack冲突不会修改原行。

同session不同ID仅注入与提交确认阶段串行，随后释放锁再等ACK。ACK不拿pane锁，早于waiter也不会丢；ACK到达后确认轮询停止追加Enter。每轮追加确认前记录尝试进度。attempts是guarded注入/Enter尝试数，包含被后续guard拒绝的尝试，不承诺实际按键数量。

CAS使acknowledged单调优先，迟到的提交失败/取消/timeout不能覆盖它。超时后同目标迟到ACK可更新为acknowledged，但不把先前返回的超时改写为当时成功。无消息、普通消息、未开始发送reservation、跨session ACK均拒绝。重复同目标ACK幂等返回已有ACK；重复send不幂等注入。

HOLD依据native spawn custody：已绑定attempt的非committed、缺失/不可读/损坏journal，或custody store未知，均零注入拒绝。不能把未知当“legacy未绑定”。ActivityBlocked是独立权限拒绝。guard在paste/Enter之间继续检查权限：`SESSION_DRAFT_PENDING`可表示完整文本已到pane而Enter未按，`SESSION_DRAFT_INCOMPLETE`可表示只有前缀到pane；都rejected，保留原draft、禁止自动Enter/重投。rejected不笼统承诺所有分支零副作用，只有注入前的HOLD/permission/ID/参数拒绝是零注入。

取消/重启留下的reservation/unknown记录只供审计，不自动恢复发送。record缺失、DB写入失败不能伪装成已记录成功。loopback ACK沿用同OS用户信任域；AO_SESSION_ID绑定防止误确认，不是多租户身份认证。

## Worker ACK 可执行入口与保留

native worker的PATH前置namespace私有 `ao-pilot` shim，脚本固定本session、canonical AO_DATA_DIR/AO_RUN_FILE和native helper。projectEnv无法覆盖。helper位于 `DataDir/message-cli/bin/<sha256>/ao`，来自启动该worker的同版本二进制，copy前后核对SHA、原子发布，每次shim执行前再次核对SHA。不是指向 `current`/旧release的链接；release GC删除原目录后仍可执行。数据目录权限限制和helper篡改失败均fail-closed。

helper与shim不参与release GC。本轮没有自动清理器：只允许在整个namespace退役、全部worker/daemon停止、没有存活/HOLD会话再引用、完成状态备份后，由operator显式删除该namespace的message-cli目录。不能仅因会话暂时terminated、release变旧或ACK已到就删除。恢复备份需包含这些helper及session/ACK记录。长会话期间保留，可能每个使用过的二进制digest占一份磁盘空间。

原 `ao hooks` 的PATH pin和语法保留；新增shim目录只提供ao-pilot，不shadow ao。旧hooks以及其他legacy消费者对旧release的全面GC pin不在A4范围，仍需单独追踪。Node managed browser wrapper提供相应保留helper；browser legacy require_ack拒绝且零注入，普通稳定能力不能冒称native confirmed/ACK。adapter继续只读。

## Schema 回退与本地待验

43→44前向迁移、重复open、原native CID/launch保留、跨连接唯一占位/CAS、pre44 migration-loader打开44并保留audit有临时SQLite fixture。最后一项仅验证相同Goose加载算法和旧migration集合，**不是已发布old artifact兼容证据**。真实old/new exact binary对schema44的读写兼容与staging new→old→new仍NOT_RUN。

不得在线Down migration、删除session_messages或把未ACK记录做重放队列。old artifact兼容unknown时，按批准设计停所有写者、取得两锁、备份/恢复DB与WAL/恢复元数据及helper，再恢复旧release；回退备份后的消息/ACK状态存在明确丢失窗口，外部效果不会撤销。若不可接受则HOLD并向前修复。

本地隔离staging还需用真实native worker执行附加的ACK行，验证跨升级/旧release GC后helper仍可用、同DataDir/discovery、错误namespace不能改另一session、old daemon新/messages零注入，以及真实old artifact schema回退。本次云端仅临时DB、fake transport/agent/executable fixture，无真实AO/systemd/生产数据。

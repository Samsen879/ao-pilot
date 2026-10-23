# 独立 tmux 生命周期（A3 / R3）

对应 #125 NATIVE-C02 / OPS-1023-01；按已批准
`docs/design/2026-10-install-convergence.md` P1 实施。本文和 Go 源码不安装 units、
不迁移/杀掉既有 server、不改变 KillMode。unit 模板、B2 root installer/CLI
接线分别由 B2 拥有，release/tag/runtime lock 不在本 PR。

## 必须显式绑定 managed namespace

Linux（含启用 systemd 的 WSL2）最低 **tmux 3.2**，同时需要 `-D` 与 `-N`。
必须完整提供以下三项（Runtime Options 也可显式注入同值）：

```text
AO_TMUX_SOCKET=<独占 named socket>
AO_TMUX_UNIT=<独立 tmux user unit.service>
AO_TMUX_TMPDIR=<稳定、绝对、私有的 socket 基目录>
```

缺失/格式无效直接 unknown/fail-closed，**不退到 tmux default socket、默认 unit
或系统临时目录**。daemon、独立 tmux unit、doctor、Dashboard/adapter 必须使用同一
namespace。子进程显式 `TMUX_TMPDIR=AO_TMUX_TMPDIR`、清空继承的 `TMUX`；staging
必须与生产不同。unit launcher 必须使用同值并最终 exec tmux，使 MainPID 是 server。

唯一启动入口：`ManagedServer.Ensure` 在 server **可证实不存在**时，有界执行
`systemctl --user start -- <configured-unit>`。不存在的 unit、权限错误、未知身份、
版本过旧不会 fallback 到裸 `start-server` / `new-session` / `tmux -D`。
并发 Ensure 合并为一次受限启动；等待串行 gate 与整个检查/启动/等待流程都受
context/deadline 约束。只有 Create/Restart 能请求该启动。

所有 runtime client 命令统一 `tmux -L <socket> -N ...`。即使检查后 server 退出，
`new-session` 也只能失败，不得在 daemon cgroup 中重新创建 server。Attach 不经过
普通 run 路径，因此 argv/PTY spawn 独立加同一 `-L/-N` 与环境，保留 UTF-8/RGB/size。
`runCommand("ps", ...)` 不误加 tmux 参数。

IsAlive/GetOutput、进程观察、pane PID 枚举不启动 server；Destroy 也不启动。
明确 server 缺失维持 IsAlive=false、Destroy 幂等成功；permission/identity unknown
返回错误，不能当作确定死亡。已确认旧 server 位于 daemon cgroup 时，可读观察
保留，Create/Restart/Send/Attach/Destroy 等修改路径失败关闭；失败的 Destroy
不会绕过拒绝继续 pkill pane 子进程。正常成功/缺 session 的既有 teardown 语义保留。

## 同源进程和 cgroup 诊断

`ManagedServer.Inspect` 完全只读。空 server PID 使用：

```text
tmux -L <socket> -N display-message -p '#{pid}'
```

该命令不依赖 session。已静态核对 tmux 3.2 的 `cmd-display-message.c`：target
使用 CMD_FIND_CANFAIL、client 使用 CMD_CLIENT_CANFAIL，global pid format 可在
无 session/client 的 server 上读取；实际空 server 测试仍列本地待验。

检查绑定：socket 报告的 server PID → `/proc/PID/stat` start-token →
`/proc/PID/cgroup` → configured unit 的 MainPID/ControlGroup/active/load 状态。
读取 daemon 的实际 PID cgroup；doctor 仅在 health/service/PID 归属验证通过后
使用 discovery 中的 daemon PID，不拿 doctor 自己的 cgroup 冒充 daemon。
检查末尾重读 PID/start-token、socket PID、unit identity 和 cgroups；变化为 unknown。

全部 v1/v2 hierarchy 的格式与 controller 集合必须完整对应；实际 ownership/kill
归属只比较 systemd 使用的 hierarchy：v1 的 `name=systemd` 或 v2 unified，并用它
绑定 unit ControlGroup。v1 的 cpu/memory 等资源 controller 可合法共享 `/` 或
`user.slice`，不能据此认定 server 属于 daemon。hybrid 同时出现 resource-only v2
与 v1 `name=systemd` 时，以后者作为 systemd ownership authority。
server 在这个 ownership hierarchy 中与 daemon 同组或为其后代才是 violation；
路径分量判断，不把 `runtime.service-other` 误认作 `runtime.service` 子组。
格式错误、不可读、层级不对应/缺失 systemd hierarchy、PID 复用、unit PID/group
不匹配均 unknown。不会仅检查 pane/worker cgroup 或进程父子关系。

Go doctor `--json` 的 `checks` 中新增：

```json
{"name":"tmux_cgroup","level":"PASS","details":{
  "status":"ok","server_pid":111,"server_start_token":"1000",
  "unit":"ao-pilot-staging-test-tmux.service","unit_main_pid":111,
  "unit_control_group":"/example/tmux.service",
  "server_control_group":"/example/tmux.service",
  "daemon_control_group":"/example/runtime.service"
}}
```

status 为 ok/violation/unknown，对应 PASS/FAIL/WARN；unknown 的 WARN 仍不能当作
安装验证 PASS，B2 严格要求 status=ok。可附 reason/message。完整 details 含本机 PID、
路径，只留私有回执，不直接上传到公开回执。tmux 版本未知/低于3.2单独 FAIL。

## daemon readiness 与效果边界

HTTP/REST boot admission 前同步执行只读自检，并每 5 秒重新检查，取消后 join。
违规 `tmux_cgroup_violation`、未知 `tmux_identity_unknown`、明确缺失
`tmux_unit_unavailable` 通过 A2 MarkDegraded 进入 readyz 503/ready=false。
运行时 Create/Restart 同步重新验证并阻止新 launch，不依赖周期采样的时机。
API 诊断仍可访问，unknown liveness 不消费死亡/恢复资格。

修复后只清除自己的三类 tmux reason，不清掉 session_reconcile_failed 等其它依赖。
独立 unit 自身崩溃仍可能丢 PTY；server 重启不是自动无损恢复。当前 Go 实现不改动
user unit 的依赖、KillMode、RefuseManualStop；B2 必须保留 daemon mixed、独立 unit
Wants/After 且无 BindsTo/PartOf 停止传播。

## 本地 staging 验证工具（云端 NOT_RUN）

`cmd/verify-tmux-staging` 是 Go-only **本地显式效果工具**，绝不由单元测试、构建或
installer 自动执行。它只接受 `ao-pilot-staging-<unique-id>` namespace，要求独立 root
的 `.ao-pilot-staging` marker 内容等于 namespace，隔离 data/discovery/tmux/home
目录、native binary 均在该 root 内。拒绝含空格 root、外部 symlink、生产 unit 名；
核对 effective ExecStart、实际 executable、显式 unit Environment 与进程 Environment
中的 DataDir/discovery/socket/unit/tmpdir 后，才允许改变 staging daemon。

先由本地维护者/B2 staging harness 准备独立 units，显式 Environment（不用外部
EnvironmentFiles），daemon ExecStart 是 `<root>/current/native/ao daemon`；unit 名为
`<namespace>-runtime.service`、`<namespace>-tmux.service`。不使用生产 repo/config/
credential/worktree。临时 Git repo 中的 fake agent 每秒写 `canary:<递增整数>`，
至少有两行；目标 CID 对应正常启动、带 RuntimeLaunchID 的 staging session。

```sh
# 仅构建不操作服务；CGO_ENABLED=0，Go1.25.7
cd runtime/headless/backend
CGO_ENABLED=0 go build -o /tmp/verify-tmux-staging ./cmd/verify-tmux-staging

# 以下仅在已经隔离、准备好的本地 staging 执行；输出属于私有回执。
umask 077
/tmp/verify-tmux-staging --execute-staging \
  --staging-root /path/to/isolated-staging \
  --namespace ao-pilot-staging-test123 \
  --canary-cid <existing-staging-cid> > private-tmux-lifecycle.jsonl
```

工具依次对指定 staging daemon 做 restart、stop+start、SIGKILL MainPID（使用 pidfd
绑定且重核 start-token，内核不支持则停止而不退化为裸 PID signal）；每次等待 daemon
重新 ready，核对：tmux PID/start-token 不变、完整 session 列表不变、数据库原 CID/
termination/runtime launch/handle/native conversation 全不变、PTY retained counter 连续
且继续递增、doctor tmux_cgroup PASS。证明 daemon 回来后 session 仍 running、未经过
restore；如果 launch identity 为空则拒绝冒充已证明。全程 DB 仅 OpenReadOnly，不迁移。
预算每阶段默认30s/最多2m，失败停止并保留 staging 现场，不顺手操作生产或回滚 DB。

额外本地待验：

1. 在明确隔离的旧生命周期 fixture 中，server 故意是 staging daemon cgroup 子进程，
   用同 namespace 的新 native doctor 读取应 FAIL；不要用旧 binary 无 namespace
   启动 default socket。方案 B 的旧终端中断只在隔离 staging 中模拟。
2. 按 B2 安装新独立 unit，启动无 session 的 `tmux -L <staging> -D`，doctor 应 PASS，
   上述 `display-message` PID 正常、server 无 dummy session 也持续存活。
3. 建 fake counter sessions 后运行工具三种 daemon 故障；旧 server 到新 unit 的首次
   方案 B 不属于无损重启承诺，不在线移动 cgroup。
4. 确认 unit RefuseManualStop 的维护逃生、linger/WSL2 重登录由 B2 runbook 单独执行。

## 云端证据与回退

云端仅 fake command runner、proc/unit/cgroup fixtures、临时本地测试文件；无真实
AO/tmux server/systemd 服务。覆盖 server 存在/缺失/错误 cgroup/版本/unknown、
配置缺失/invalid、并发 Ensure、取消/超时、检查后 server 消失、Attach 直通 argv、
Destroy 拒绝后无 reap 效果、doctor schema 与 readiness reason 隔离。
既有 pane send/guard 测试保留全部断言，只显式注入健康 server fixture 防止碰宿主服务。

本 PR 无 schema 变动、无 lock/tag/unit 变更；源码回退可 revert 此提交。安装态回退
仍按批准设计：保留独立 tmux unit、确认 old binary 的 socket/namespace 与 schema
兼容后才部署 previous；旧 binary 不支持 managed socket/-N 时不能直接换回并声称
无损。需在 staging 验证 old/new 组合或另约方案 B 中断，不能为回退杀生产 server、
改 mixed 为 process、删除 ownership locks。实际安装回退证据为本地待验，云端不伪称。

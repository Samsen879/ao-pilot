# AO Reliability：tmux 生命周期与统一安装设计（任务 D）

状态：**Owner 已于 2026-10-23 确认本设计，并授权按门禁分批合并源码 PR；实施遵守前置依赖，生产部署与 release 不在本次授权范围内。**

## 1. 范围、基线与 review

本文件是 #125 / #7 下 P1、P3 的 R3 design review 前置，只新增本文档。实际基线为 main `092227ab425e8293ce8ce2e6f6b23409c751330b`，tree `6cd987d8fb5aa893c905900ae4fa74fe61b0bb39`（2026-10-23 核对）。当前 runtime lock 为 `0.11.2-p0.4`，锁定 commit `43d37ef2a76e1949c8032c49c5e6197d98bf0b96`，不能代表上述源码已经安装。

本轮只支持 Linux（含启用 systemd 的 WSL2），不增加 Windows 原生 runtime 工作。保留 daemon `KillMode=mixed`。现存生产 tmux server 按方案 B 进行一次计划内中断，不在线迁移 cgroup。sparse cone 外物理文件保存并报告 `cone_drift`；Draft PR 继续拒绝，后续 A4 拆分 `PR_DRAFT` / `PR_MERGED` / `PR_CLOSED`。

依赖顺序：A1 合并后 A2；D 经 design review 确认且 A2 合并后 A3；D 确认且 B1 合并后 B2；A3、B2 合并后 A4。A3 只拥有 Go runtime 路径；所有 unit 模板由 B2/P3 拥有。跨 lane 路径变更必须先协调，不能各自复制模板。本文中的新路径为实施提案，实施前重新核对 live main。

遵守 Typed Review Policy v2：稳定候选及 focused preflight 后做 `candidate_review`；修正按 finding ID 做 `finding_verification`，扩展契约做 `semantic_delta_review`；R3 最终发布须有 exact-final-head `release_attestation`、回退证据及效果后的观察。设计通过不等于授权生产切换；云端不连接真实 AO、systemd 或生产数据。

- **拟改文件**：本 PR 仅本文；后续路径见各节。
- **验收**：文档覆盖 P1/P3/staging、各项文件归属和失败行为；review 状态明确；没有实现改动。
- **本地待验**：本文所有 systemd、真实 cgroup、WSL2 与安装态效果；本 PR 不声称执行。

## 2. P1：独立 tmux user unit

引入 `ao-pilot-tmux.service`，`Type=simple`，启动器最终 `exec tmux -L <socket> -D`，使用稳定的私有 WorkingDirectory、固定 tmux 配置与同一 socket 名。最低 **tmux 3.2**：该版同时具备全局 `-D`（前台 server）和 `-N`（client 禁止启动 server），也符合现有 Attach 的 `-T RGB` 要求；依据 [tmux 3.2 CHANGES](https://github.com/tmux/tmux/blob/3.2/CHANGES)。doctor 必须实际解析版本，不能只检查二进制存在。`-D` 保持无 session 时 server 存活；本地验证空 server 不退出，不用 dummy 业务 session 保活。

unit 的 ExecStart 统一指向 `current/bin/ao-pilot-tmux`，该 release 启动器校验 manifest 中外部 tmux binary 的路径及 SHA256 后 exec；用户配置不得包含创建 session / run-shell 等启动副作用。由 B2 提供仓库内受控配置。tmux server 的生命周期独立于 daemon，server、pane 及 worker 均在 tmux unit cgroup；daemon 停止仍清理其自己的残余进程。tmux unit 自身采用 `KillMode=control-group`，明确停 tmux 是有损维护动作。

推荐 `Restart=on-failure`，但 tmux server 自身崩溃仍会丢失 PTY；server 自动重启不等于 session 恢复成功，必须产生 degraded 原因，走 A2 显式恢复。daemon unit 仅添加 `Wants=ao-pilot-tmux.service`、`After=ao-pilot-tmux.service`，不使用 `BindsTo=` / `PartOf=` / 从 tmux 到 daemon 的停止传播。

建议默认 `RefuseManualStop=yes`，减少误停/误 restart。逃生：维护者先停止 daemon 和入口服务、保存 WIP 与快照，在本机私有维护回执中记录理由，备份 effective unit/drop-ins；仅在 `/run/systemd/user/ao-pilot-tmux.service.d/` 写带事务 owner 的临时 `RefuseManualStop=no`，daemon-reload 后执行明确的 tmux stop。维护完成必须删除自己创建的临时 drop-in、daemon-reload 并回读 `RefuseManualStop=yes`；不删除其他 owner 的文件。不以 kill server、改 `KillMode=process`、重启整个 user manager 绕过保护。安装完成态只允许下节规定的环境变量 override。方案 B 旧 unit 没有该保护，不需为旧 unit 加逃生 override。

- **拟改文件**：B2 新增 `templates/systemd/ao-pilot-tmux.service`、`ao-pilot-runtime.service` 及同目录入口 units、`templates/tmux/ao-pilot.conf`、release 内启动器源 `scripts/ao-tmux-server.js`；A3 修改 `runtime/headless/backend/internal/adapters/runtime/tmux/` 与 runtime wiring。
- **验收**：unit 无版本号；daemon 保持 mixed；无停止传播；空 server 存活；缺/过旧 tmux fail-closed；维护 override 在完成态不存在。
- **本地待验**：effective unit 与 cgroup、RefuseManualStop 的拒绝和逃生、空 server、user linger 与 WSL2 重登录。

## 3. P1：ensureServer 与所有 tmux 调用入口

基线源码中 `ensureServer()` 尚不存在。不能只在 daemon boot 调一次：server 可能在检查后消失。A3 引入可注入的 server manager，所有 client 命令都用统一 `-L <socket> -N`；`-N` 阻止检查与使用之间的竞态重新在 daemon cgroup 内创建 server。唯一启动入口为有界的 `systemctl --user start <configured-unit>`，不能 fallback 到 daemon 内执行 `start-server` / `tmux -D` / 裸 `new-session`。启动后等待 socket，读取 server PID/start-token/cgroup，核对 unit MainPID，再允许客户端操作。并发 start 使用 systemd 的幂等 job，检查必须有 deadline 和取消。

下表是基线 daemon 侧全部 tmux process 调用点，均位于 `runtime/headless/backend/internal/adapters/runtime/tmux/tmux.go`；命令参数生成器在相邻 `commands.go`。不是每个命令都能首次创建 server，但所有入口必须统一禁止隐式启动，避免漏掉将来组合命令。

| 文件内函数 | 当前命令 / 路径 | A3 处理 |
| --- | --- | --- |
| `Runtime.Create` | `newSessionArgs` → `new-session`；随后 status/mouse/window-size set-option | 先 ensureServer；所有命令 `-L/-N`；唯一已确认的业务创建入口 |
| `Runtime.Restart` | `respawnPaneArgs` → `respawn-pane` | ensureServer 验证同一 server；缺 session 不伪装成功 |
| `Runtime.verifyPaneWorkingDirectory` | `paneCurrentPathArgs` → `display-message` | 共用 server 检查与 `-L/-N` |
| `Runtime.Destroy` / `Runtime.paneSessionIDs` | `kill-session` / `list-panes` | 共用禁止启动的 client；server 确定不存在时保持原幂等清理语义，不为 destroy 启动空 server |
| `Runtime.IsAlive` | `has-session` | 不为只读探测启动 server；不存在返回 false，检查错误保持 unknown/error |
| `Runtime.IsSupervisedProcessAlive` | `display-message` 获取 pane PID，再调用 `ps` | tmux 部分共用 socket/禁止启动，`ps` 不走 ensureServer |
| `Runtime.SendMessage` → `Runtime.SendMessageGuarded` | `send-keys -l` 与 Enter | ensureServer 验证；继续保留 pane 写锁与 permission guard，禁止重贴消息 |
| `Runtime.Interrupt` | `send-keys C-c` | 共用 server 验证及 `-L/-N` |
| `Runtime.GetOutput` | `capture-pane` | 共用不启动的 client 探测 |
| `Runtime.Attach` → `Runtime.attachCommand` | `ptyexec.Spawn` 直接执行 `attach-session`，**绕过 run** | 独立加 ensureServer 与 `-L/-N`，保留 `-u -T RGB`、PTY sizing 和取消语义 |
| `Runtime.run` → `Runtime.runCommand` → `execRunner.Run` | 其余命令的集中执行链 | tmux argv 在集中入口绑定 socket/`-N`；`runCommand("ps",…)` 不误加参数；保持 timeout |

`runtimeselect.New`、`daemon.Run` 注入同一个实例的 socket/unit/server manager。session manager、LCM messenger、terminal manager 共用这个 runtime；不得各自拥有不受管的默认 socket。CLI doctor 的 `tmux -V` 只读版本检查不是 server 启动点。Browser `browser/packages/plugins/runtime-tmux/src/index.ts` 属于另一条 Node runtime 路径，B2 必须静态枚举并绑定同一安装配置，不能让 Dashboard/recovery adapter 另建默认 server；如需要语义改动，先登记范围与 lane，不由 A3 偷改。

- **拟改文件**：A3 `tmux.go`、`commands.go`、新增 `server_linux.go` / `server_test.go`，`runtimeselect/runtimeselect.go`、`daemon/daemon.go`、`internal/config/config.go`；必要接口在 `internal/ports/`；B2 Node/browser 对接另行登记。
- **验收**：server 存在/不存在/错误 cgroup/unknown identity/systemd 失败均有测试；命令矩阵和 Attach 无遗漏；竞态下绝不从 daemon 创建 server；保留 Destroy/IsAlive 的 absent 语义。
- **本地待验**：systemd 启动的 server 身份、消失重启竞态；云端只用假 runner / systemd inspector fixtures。

## 4. P1：cgroup 不变量与方案 B

不变量是 **tmux server 不在 daemon cgroup 内，也不在其任何子 cgroup 内**。不能只检查 pane、worker 或进程父子关系。解析 `/proc/<server>/cgroup` 与 `/proc/<daemon>/cgroup`，按 hierarchy/controller 对齐，采用路径分量边界判断；`runtime.service-other` 不能误认作 `runtime.service` 子组。支持 cgroup v2 及 Linux v1 fixture；不可读、空值、PID 复用或 hierarchy 无法对应时为 unknown，不按 PASS。server PID 要同时绑定 `/proc` start-token、systemd unit MainPID/ControlGroup 和 socket 响应，探测前后重读身份避免 PID 复用。

daemon 启动先自检，再 Reconcile；违反或 unknown 时通过 A2 的 readyz degraded 原因 `tmux_cgroup_violation` / `tmux_identity_unknown` / `tmux_unit_unavailable` 暴露，普通 ready 状态必须明确非 true。保留 health 活性；阻止 create/restart/restore 等新 spawn，保留诊断、HOLD、已有 session 的只读观察，不主动杀 tmux 或丢恢复记录。doctor 使用同一 Go 诊断接口；B2 Node doctor 聚合结构化结果，不复制第二套 cgroup 算法。运行期 ensureServer 每次验证，定期检查也能发现 drift。

方案 B 的生产顺序（仅维护窗口，在本机执行）：

1. preflight 导出原 CID 集合、session/worktree 元数据、WIP/cone_drift、旧 server 身份；保存完整数据库一致性备份，禁止新派发。
2. **停旧 daemon** 和入口，确认其进程退出、两把 ownership locks 可取得；接受旧 tmux 终端在这一步退出，不能承诺 canary 连续。
3. **安装新 units**，备份旧 unit/drop-ins，清理 ExecStart hotfix，校验 effective units。
4. **启动 tmux unit**，确认独立 cgroup、socket 与 empty server。
5. **启动 daemon**，确认 manifest、schema、ownership locks 与 readyz 原因；不以 readyz 200 代替恢复验收。
6. **批量恢复**：按 A2 `restore --project <p> --all --concurrency N`，Orchestrator 优先、保留原 CID，HOLD 跳过，逐项输出 restored/skipped_hold/failed；失败保留恢复记录和工作目录。

独立 unit 建立后的日常 daemon 升级不重启 tmux unit。staging 分别测 daemon restart、stop+start、只 kill daemon 主进程，要求 server PID/start-token 和 session 集合不变、canary 计数不中断、daemon 恢复后状态 running 且没有经过 restore。这是后续日常重启的验收，不是首次方案 B 的承诺。

- **拟改文件**：A3 `internal/adapters/runtime/tmux/server_linux.go`、`internal/daemon/daemon.go`、`internal/cli/doctor.go`；A2 `internal/httpd/server.go` / `apispec/openapi.yaml` 先提供 degraded；B2 集成 `scripts/ao-doctor.js`、`scripts/verify-install-staging.js`。
- **验收**：v1/v2/路径边界/PID 变化 fixture；violation/unknown degraded 且禁止新 spawn；三种 daemon 故障均保留 session；旧配置 doctor FAIL、新配置 PASS。
- **本地待验**：全部实际 cgroup、restart/stop/kill、计划中断与恢复演练；只可作用于隔离 staging。

## 5. P3：release.json 与 pack-once 构建

release ID 为 `<version>+<commit-sha>`；用完整 commit 防止缩写冲突。`release.json` 采用严格、版本化 schema（`additionalProperties:false`），至少包含：

- `schema_version: "ao.release.v1"`、`version`、`commit`、`tree`、`platform: {os:"linux",arch}`、`built_at`。
- `toolchain`：Go 精确 `1.25.x`（建议沿用锁的 1.25.7）、`CGO_ENABLED:"0"`、Node/npm、Git、tmux 的版本，以及外部 node/tmux executable SHA256。
- `database`：`schema_current`（当前为 43）、`schema_min_readable` / `schema_max_readable`，明确由兼容性测试产生，不能凭 migration Down 段推定可回退。
- `runtime_lock`：runtime_ref、lock 文件 SHA256、目标 runtime commit/tree；安装 manifest commit 和 lock 必须显式对齐或被 doctor 报 drift，不能静默从 p0.4 引导旧 binary。

候选在 canonical tag/lock promotion 之前验证：builder 生成固定路径
`release/runtime-pin.json`（`ao.release-runtime-pin.v1`），manifest 的
`runtime_lock.kind=candidate` 显式绑定该文件摘要、当前 commit/tree、版本、
release ID、平台与实际 daemon SHA256。原 `runtime/agent-orchestrator.lock.json`
保持原字节，仍按严格 annotated-tag schema 验证，并以 `source_lock_sha256`
作为构建输入绑定；它不再被误认作候选执行目标。安装与 doctor 共用同一判定：
pin/manifest/daemon component/磁盘 binary/原输入锁须全部一致，缺失、未知 kind、
跨 release/平台、源 commit 不符或任何摘要改变一律阻断。不带 kind 的旧 manifest
继续执行原有“binary 必须匹配 annotated-tag lock”判定。CLI 的候选 source
报告真实 commit/tree/version 与 `tag=null`，另列原输入锁身份，不能冒充已 promotion。
本规则不改变 legacy bootstrap 的 tag 校验、不提前打 tag 或改仓库 canonical lock；
L4 再把生产验证过的同一候选 commit/tree/binary 提升为 canonical annotated tag/lock。
- `components`：daemon、CLI、Dashboard、adapter 各自 entrypoint、SHA256、源 commit；多文件组件的 SHA256 为规范化清单的摘要。清单按相对路径字节排序，记录文件类型、mode、大小、文件 SHA256 或相对 symlink target；拒绝绝对/逃逸 symlink，确保 dist、assets、依赖都被绑定。
- `inputs`：git archive SHA256、根/browser lock SHA256、source-import identity、最终 npm tarball SHA256、unit 模板摘要；`artifacts` 列出所有 Linux 制品 digest。

从解析后的 immutable `<commit>` 执行 `git archive <commit>`，核对 `<commit>^{tree}`，在新私有构建目录解包；不从开发 worktree 拷贝源或 node_modules/dist。Go 用 `CGO_ENABLED=0`、`-trimpath`、固定工具链；根/browser `npm ci` 绑定各自锁，构建 Dashboard/adapter 后生成多文件 digest 清单。外部 adapter 若没有可重建源码，release fail-closed。

**只 npm pack 一次**，传同一 tarball 文件及 SHA256 给 package verifier、fresh-clone verifier、上传器和安装器。不能 verifier 内重新 pack、release workflow 再 pack。解包验证所有 package.json exports（含 authority/execution）和 CLI；对最终包内 runtime/browser/assets 做验收。manifest 不包含自己的摘要，不出现循环摘要；tarball 中 manifest 的 `npm_tarball_sha256` 应放在包外 release envelope 或签名索引中，内层只记录构建输入/组件摘要；外层 envelope 绑定内层 manifest SHA256 与 tarball SHA256。下载/安装时两者都校验。

- **拟改文件**：B2 新增 `schemas/ao.release.v1.schema.json`、`scripts/build-release.js`、`scripts/ao/lib/release-manifest.js`，修改 `.github/workflows/release.yml`、`scripts/verify-package-install.js`、`scripts/verify-fresh-clone.js`、`tests/ao/`；后续 release 步骤修改 lock。
- **验收**：工作树脏文件不进包；被测/上传/安装包 digest 相等；仅根 lock 变化、dist 字节漂移、漏 exports、平台非 Linux 均阻断；manifest schema 严格验证。
- **本地待验**：发布流水线实际产物与 staging 安装比对；此设计不发布 artifact。

## 6. P3：安装事务、锁与原子切换

安装根含 `releases/<version>+<sha>.partial`、最终 immutable release、`current`、`previous` 和私有事务回执。`.partial` owner 与输入摘要单独记录；只清理确定属于当前失败事务的 partial，同版本重试从已校验阶段继续或重建。最终目录存在时完整验证并幂等复用，绝不盲删 unknown/已提交目录。

安装锁与 daemon ownership locks 是不同锁域。Linux 安装锁使用内核排他 flock，文件句柄不继承，保留永久锁 inode；owner 记录 UID、boot ID、PID、start-token、随机 nonce、事务 ID。owner metadata 用于诊断/阶段恢复，不以年龄、health、token 不可读作为回收依据。unknown owner 停止；旧 writer 不能删除新 owner 的 partial、切换 current 或写成功回执。任何修改指针/units/回执前检查仍持有锁且 nonce 匹配；安装器退出时内核释放锁，不删除永久锁文件。

事务顺序：构建/解包到 `.partial` → 校验全部 digest/平台/兼容性 → fsync 文件和目录 → **同文件系统原子 rename** 到最终 release → 预备切换 journal（old/new、unit/drop-in 备份引用、DB backup、owner、阶段）→ 停止会重新加载代码的服务并 pin 旧 release → 以临时 symlink + rename 依次更新 previous/current → 启动目标服务 → verify/readback → durable `committed`。`current` 与 `previous` 两个 rename 不是一个原子操作，必须由锁与 fsync journal 恢复：current 是选择权威，previous 指向 journal 的 old；崩溃时按指针和阶段核验后继续/回退，不能猜测成功。

在提交前不得执行 old release GC。提交后 GC 失败只写 warning，保持新 current/服务与成功提交；不触发 catch-all rollback。GC 保留 current、previous、运行进程 pin 的 release、未完成事务/备份引用的 release；不能通过符号链接复用上一安装的 node_modules/dist，再回收其支持目录。与安装根跨文件系统时 preflight 拒绝原子切换，不退化为复制覆盖。

- **拟改文件**：B2 `scripts/ao/lib/release-installer.js`、`release-lock.js`、`scripts/ao-upgrade.js`、`bin/ao-pilot.js` 接线、`scripts/ao/lib/runtime-bootstrap.js` 迁移，及 `tests/ao/release-*.test.js`。
- **验收**：构建各阶段失败可同版重试；合法并发 owner 互斥；unknown/dead 不混淆；崩溃 journal 恢复；GC 失败不回滚；摘要不匹配不切换。
- **本地待验**：真实本地文件系统 rename/fsync/锁语义、服务启动失败后的恢复；云端故障注入只操作临时目录和假 service runner。

## 7. P3：统一入口、unit 与旧脚本

CLI 的固定外部入口链接到 `current/bin/ao-pilot.js`。daemon、Dashboard、adapter 各 unit 的 ExecStart 指向 `current/` 内入口，不含版本号；启动器只解析一次 current 到 immutable release，再执行/pin 该 release 内路径，避免 Node 延迟 import 跨代。unit 使用共同 namespace 环境、稳定 WorkingDirectory 和 owner-only config，路径转义由模板渲染器处理。运行期发布身份接口包含 commit/tree/component digest/release ID，结合 proc 实际 executable/cmdline/cwd 检查，不信任单一环境变量自报。

`server.mjs` 经 `git ls-files` 核对当前不在仓库，不能从本机安装目录复制未知字节冒充可重建制品。B2 先由 owner 提供 adapter 源码、许可及必要构建输入，以 `adapter/server.mjs`（或仓库惯例目录）纳入同一个 git commit、测试、manifest。缺少输入则阻断完整 release，登记 missing component，不上线一个声称全组件一致的包。已在仓库的 session-recovery 入口/adapter 继续保留，完成契约对齐后才可替代外部 adapter；不删除稳定恢复能力。

B2 将 `templates/systemd/` 作为唯一模板权威，涵盖 runtime、tmux、Dashboard、session-recovery 和纳入的 adapter。现有 unit/全部 drop-in 先备份到私有事务目录、记录 digest 与权限，再清理生成式/hotfix ExecStart override，daemon-reload 后回读 FragmentPath/DropInPaths/ExecStart。完成态最多一个只含 allowlist 环境变量的 override（如 `10-environment.conf`），不能包含 ExecStart、KillMode、依赖或 shell 命令；拒绝重复/未知关键环境赋值。旧运行态 inspector 当前拒绝任何 drop-in且假设 wrapper 有一个 daemon child，B2 必须同步迁移 `runtime-deployment.js` 的检查契约，不能先放宽再丢 provenance 防线。

| 现有入口 | B2 处理 |
| --- | --- |
| `scripts/deploy-session-recovery.js` | 保留命令兼容，改为统一 installer 的 profile；停止自行复制 release、复用旧 dist/依赖和修改 CLI |
| `scripts/deploy-original-dashboard.js` | 保留命令兼容，转统一构建/安装；去除独立最终目录构建和独立服务切换 |
| `scripts/install-dashboard-service.js` | 改为模板渲染/审查辅助入口；写 unit 必须进入安装事务，不再拥有第二套模板 |
| `scripts/ao/lib/runtime-bootstrap.js` | 保留锁定 runtime 的验证/下载兼容能力；安装/锁/提交由统一事务所有，legacy 模式显式标注并拒绝混装；旧 receipt/provenance 不静默废弃 |
| `scripts/ao/lib/dashboard-service.js`、`runtime-deployment.js`、`runtime-control.js` | 模板单一来源，current 身份解析及运行回读统一；existing fail-closed 绑定保留 |

- **拟改文件**：上述表格路径、`templates/systemd/`、`adapter/`（输入齐备才新增）、`README.md`、`docs/AO_RUNTIME.md`、`docs/AO_RELEASE.md`。
- **验收**：所有组件来自 current；单位内无版本号；hotfix 完整备份后移除；未知 override HOLD；无仓库 adapter 源则禁止完整 release；旧入口不丢能力。
- **本地待验**：旧多目录/多 drop-in 安装升级，实际加载路径及 CLI symlink 回读；README 平台声明为 Linux/WSL2，release 只产生 Linux x64/arm64 制品。

## 8. P3：doctor 与两层回执

统一 `ao-pilot doctor` 检查并逐项输出 PASS / FAIL / UNKNOWN；UNKNOWN 在 upgrade verify 中阻断成功。普通 doctor 的诊断不擅自修复、回收锁、启用 LAN 或 trusted-host。

| 检查 | 比对证据与失败行为 |
| --- | --- |
| 版本 drift | 运行 daemon/CLI/Dashboard/adapter 的实际 release/摘要 vs current/release.json/envelope vs runtime lock；分别列 source/lock/install/running，任何差异显式失败 |
| tmux cgroup | 第 4 节共享诊断；PID/start-token/unit/Socket 绑定，unknown 不视作安全 |
| linger | user manager 与 loginctl Linger；WSL2 systemd 状态，未开启则提示本地修复，不能自动变更 |
| listener / terminal WebSocket | 实际监听仅 loopback；无认证/错误 token/错误 Origin 应拒绝，有效授权能收到 fake canary PTY 字节；不只看 HTTP 101 |
| AO05-F08 tokenless 锁 | 枚举当前安装/控制层锁模式；缺 start-token/按年龄回收路径标为风险，保留 fail-closed；doctor 检出不等于在 B2 修复状态存储锁 |
| NATIVE-F08 LAN | 默认关闭，回读 listener 与配置；意外开启或无法核对阻断升级；B2 不宣称修复 STOPPING 链 |
| AO05-F07 trusted-host | 回读 opt-in 是否启用和 authority 状态；enabled 显示未解决 grant expiry 风险，需单独决策；不通过 doctor 隐式授予或延长权限 |
| daemon 两把锁 | 校验 DataDir `.daemon-owner.lock` 与 discovery `.daemon-discovery.lock` 的持有者为本实例；另一 helper 非阻塞获取应失败；不删除文件探测 |

日常升级保留既有 tmux server。其启动器可能来自上一 release，不能因此重启 server 来消除表面 drift：独立记录 `tmux_server_generation`，验证其实际 tmux executable digest 与新 manifest 的 toolchain 相容；不相容则升级 HOLD，另约计划中断。daemon/CLI/Dashboard/adapter 不适用此例外，必须全部匹配新 release。

私有完整回执留本机，mode 0600，含各服务 MainPID、进程 start-token、启动时间、实际 release 路径、socket/地址、DB/WIP/units 备份、全部检查证据，不能上传到 PR/issue/CI 公共 artifact。公开回执为固定 `ao.install-public-receipt.v1` schema，拒绝额外字段，**由 allowlist 投影生成**，不能递归脱敏后直接发布私有对象。字段限 `schema_version`、`release_id`、`commit`、`tree`、`manifest_sha256`、`platform`、`phase`、`result`、固定 check ID→status、枚举 failure_code、计数与 UTC 时间。不得含路径、PID、session 文本、CID、内部地址、自由错误消息、stack trace、环境变量或私有回执位置。注入敏感错误文本的测试也必须证明公开回执不泄漏。

- **拟改文件**：B2 `scripts/ao-doctor.js`、`scripts/ao/lib/install-doctor.js`、`release-receipt.js`、`schemas/ao.install-public-receipt.v1.schema.json`、`runtime-deployment.js`；Go cgroup/locks 诊断由 A3/API 提供。
- **验收**：每类 drift fixture 可检出；unknown 不变 PASS；公开 schema 严格且无路径/PID/地址；本机完整回读能追溯 manifest。
- **本地待验**：真实 listener/WebSocket、linger、两把 locks、进程加载 release；未提供这些证据不得声明安装验收完成。

## 9. Runbook：upgrade apply 的阶段与恢复

目标命令为 `ao-pilot upgrade apply --release <id>`；这是 B2 计划新增的接口，当前基线尚无此命令。日常更新与首次方案 B 共用 journal，但方案 B 标为有损维护窗口。

| 阶段 | 行为、成功证据与失败处理 |
| --- | --- |
| preflight | 校验 Linux、Go 1.25.x/CGO=0 构建证明、Git、tmux ≥3.2、磁盘、锁 owner、完整 envelope/manifest、schema 兼容性、adapter 输入；导出 CID 集合，冻结新派发，制作一致性 DB/WIP 备份；unknown/HOLD 不进入 switch |
| install | 在 owner partial 校验、完成所有组件、原子 rename；不动 current/运行服务，失败保留完整旧安装和可识别 partial |
| switch | 取得并持续持有安装锁；停入口及 daemon、确认退出/锁可获取；首次方案 B 按第 4 节；日常保留 tmux server；journal 与备份完成后切 current/previous，更新 units 和环境，再启服务 |
| verify | 严格要求 ready 且无 degraded 原因；按下列完整检查；失败保留回执与现场，根据第 10 节兼容性策略恢复，不宣告成功 |
| readback | 重新读取 current/previous、effective units、每服务 MainPID/启动时间/实际 release/digest，核对 manifest；身份在检查中变化则失败；持锁写 committed，再解冻派发，最后执行 GC |

verify 必须同时满足：前后期望 CID 集合相等（不只比较数量，HOLD/历史会话按 baseline 标记逐项保留）；日常更新 tmux server PID **与 start-token** 不变，首次方案 B 新 server 为预期身份；Dashboard 的授权 WebSocket 收到 fake agent 递增计数的 PTY 输出、未授权连接被拒；schema 版本在 manifest 支持区间且 SQLite `PRAGMA integrity_check` 为 `ok`；daemon 对两把 ownership locks 持有有效排他权；CLI/Dashboard/adapter/daemon 全匹配 manifest。HOLD 会话不强行恢复为 running；新增/丢失 CID、恢复 failed、未完成 spawn 协调均不能靠 readyz 200 掩盖。

每服务回读 `MainPID`、`ExecMainStartTimestampMonotonic`、active state、ControlGroup；原生 daemon 检查 `/proc/<pid>/exe` digest 与运行身份，Node 服务检查实际入口及 pin 的 release 内容 digest。启动后 PID/start-token 必须不同于需重启的旧组件；仅 `enable --now` 对 active 服务不足以证明加载新 release。readback 完成前入口保持冻结，避免验证期间产生新业务数据。

- **拟改文件**：B2 `scripts/ao-upgrade.js`、`scripts/ao/lib/release-installer.js`、`runtime-deployment.js`、`scripts/verify-fresh-clone.js`；A2 提供批量恢复 API/CLI。
- **验收**：fresh-clone 要求明确 ready=true、非 degraded；退出须有 owned PID/start-token 的实际终止与两锁可取得，health 查询失败不能写 leaked=false；失败阶段逐项可恢复且不丢记录。
- **本地待验**：staging 全流程一次、故障中断重入、日常更新与首次方案 B 分别验收。

## 10. 回退、schema 与 release promotion

本设计批准时源码最高 migration 为 **43**，`0043` 向 `session_worktrees` 添加 `recovery_activity_at`；锁定 p0.4 不能仅因版本较旧就认定可读/不可读。release 构建须在**DB 副本**测试候选 old binary 打开 schema 43、查询、关键恢复操作与不写坏数据；记录其精确 digest 和读写兼容区间。A4 若添加消息表，建议作为 migration **44**（以届时 main 的下一个序号为准），需前向迁移、重复启动及 old-reader fixture。不能在本设计预先认证尚未存在的迁移。

A4 实施补充：现新增 migration **44** `session_messages`，只保存消息ID、session、caller text SHA256、outcome/evidence、尝试次数和时间/内部CAS版本，不保存正文、不建持久意图队列。43→44、重复open、原CID/launch保留、跨连接占位/CAS有临时SQLite fixture；pre44 migration集合配合相同Goose loader读取44并保留记录的fixture不等于已发布old artifact验证。真实old/new exact binary的44读写兼容、staging回退仍为本地待验。线上回退绝不运行Down或删消息/ACK表，不能把pending记录变成自动重放；兼容unknown仍按下述一致性备份恢复，保留备份后ACK丢失窗口。

A4 新增worker ACK helper保留在 `DataDir/message-cli/bin/<sha256>/ao`，SHA验证后独立copy/原子发布，session私有ao-pilot shim固定该helper及同DataDir/discovery；每次执行检查SHA。长会话不依赖旧release路径，不被release GC清除。该目录本轮无自动清理，须等整个namespace退役、全部worker/daemon停止、无存活/HOLD会话引用且完成备份后，operator才可显式删除；不能因release过旧、暂时terminated或某条ACK已到而删。回退/恢复元数据备份应包含helper；原ao hooks稳定PATH能力保留，其既有旧release全面pin问题属于范围外。本地待验跨多次升级/GC后的实际worker ACK与精确old artifact回退。

- old binary 经验证可安全读取/写入当前 schema：停止所有旧/新写者并确认 ownership locks，pin `previous`，恢复旧 units/环境，重启 old，执行相同 verify/readback。不能仅切 symlink 而保留旧新进程混跑。
- 不兼容或 unknown：回退是 **previous release + 迁移前一致性 DB 备份**（包含所需 WAL/SHM 一致性处理、配置和恢复元数据）。不在线运行 Down migration，不强开旧程序。停止全部写者、按 backup manifest 恢复、校验 integrity，再启动 old 并回读。WIP/worktree 不随 DB 回滚盲目覆盖，逐项核对身份和 cone_drift。
- 数据丢失窗口明确为“迁移前备份完成时刻 → 回退时停止写者时刻”内的新会话状态、消息/ack 和控制元数据；窗口内外部效果不会被撤销。冻结派发可缩小窗口但不能宣称为零。若不可接受，保持 HOLD、用新版本向前修复，不能自动覆盖 DB。

A3/B2 PR 均不更新 runtime lock、不打 tag。所有 PR 合并、schema/回退验证和 exact-final-head release attestation 完成后，由独立 release 步骤从实际 main 创建 annotated runtime tag，再在后续 lock promotion commit 绑定 tag object/commit/tree 与 Linux 二进制 SHA256，避免 tag 指向的 commit 又包含自身对象造成循环。建议 schema 43 安装收敛发布用 `0.11.3-p0.1` / `ao-pilot-headless-runtime-v0.11.3-p0.1`；若 A4 引入 schema 44，建议 `0.12.0-p0.1` / 对应 annotated tag，明确有迁移与回退窗口。控制层 package 版本独立递增，不强行冒充 upstream `@aoagents/ao` 版本；最终命名在 release review 确认。

- **拟改文件**：实施时 `internal/storage/sqlite/migrations/`、migration 测试、release manifest builder；独立 promotion 修改 `runtime/agent-orchestrator.lock.json`、release 文档/ledger；A4 回填本节实际 schema。
- **验收**：old/new exact binary 对 schema 43/新增 schema 有读写兼容证据；unknown 强制备份回退；new→old→new 演练、丢失窗口记录完整；lock/tag/digest 不互相混称。
- **本地待验**：生产 DB 仅本机副本迁移，不接触 live DB；staging 回退演练与重新升级；生产切换另行授权。

## 11. Staging 隔离与本地待验步骤

隔离是前置约束，不能靠“使用不同项目名”代替。采用单独 namespace `<test-id>`，所有路径必须 canonical 化并与生产配置不等；使用临时仓库和 fake agent，不引用生产 worktree、生产 repo 配置、真实 token 或业务任务。

| 资源 | staging 绑定（示意值，非生产地址） |
| --- | --- |
| install / releases | 独立临时安装根；不得共享 current/previous/partial/安装锁 |
| DataDir | `<staging-root>/data`，`AO_DATA_DIR` 与 `AO_MANAGED_RUNTIME_DATA_DIR` 一致 |
| discovery | `<staging-root>/discovery/running.json`，整个 discovery **目录**独立；固定 browser/supervisor sockets 也由此隔离 |
| tmux | `-L ao-pilot-staging-<test-id>`；显式固定私有 `TMUX_TMPDIR` 和 unit 配置，拒绝默认 socket；受控配置不加载用户 `.tmux.conf` |
| listeners | loopback 上独占、preflight 确认空闲的 daemon/Dashboard/adapter 测试端口，配置/回执逐项绑定；不启 LAN |
| units | `ao-pilot-staging-<test-id>-{tmux,runtime,dashboard,session-recovery,adapter}.service`，依赖只引用相同 namespace |
| CLI | 测试专用 launcher pin staging `current`，导出上述 DataDir/RunFile、`AO_CONFIG_PATH`、独立 `AO_PILOT_RUNTIME_STORE`，显式 `--config <staging-config>`；不复用 shell 默认 ao-pilot、不解析生产 runtime-binding.json |
| project/worktree | `mktemp` 临时 Git repo 与 staging project；HOLD/terminated/Orchestrator fixture 均是假数据 |

建议 fake agent 为受控 shell loop，每秒写一行 `canary:<递增整数>`，同时把最大已输出序号记录到 staging 临时文件，便于区分 agent 重启与 WebSocket 重连。比较故障前后序列；仅输出文件递增不足以替代 WebSocket PTY 字节验收。

本地执行顺序：

1. 为 staging 生成配置和全部 units，运行隔离断言（realpath、unit 依赖、socket、端口、CLI binding）；任一与生产相同则立即拒绝。不读取生产密钥。
2. 从 archive 构建 release old/new，以临时 schema 43 DB 启动 staging fake sessions；baseline 保存 CID 集合、server identity、canary 字节和两把锁证据。
3. 在旧生命周期配置的 staging 复现 doctor cgroup FAIL，然后在 staging 方案 B 安装独立 unit，恢复原 CID，doctor PASS。
4. 新配置分别测试 daemon restart、stop+start、对**已绑定 PID/start-token 且属于 staging unit 的 daemon**发 SIGKILL；每次确认 server PID/start-token/session 集合不变、canary 连续、无 restore。
5. 完整执行 `ao-pilot upgrade apply --release <new-id>`；验证各服务实际加载、auth、schema、locks、回执，再做 new→old→new。
6. 注入构建失败、GC 失败、并发安装、错误 digest、身份 unknown、stale drop-in、运行版本 drift；验证 fail-closed 和可重试。敏感字符串注入日志但不得进入公开回执。
7. 生产 DB 只允许先由本地维护者做一致性副本，副本去掉 live discovery/authority/外部连接配置，在**不启动真实业务 agent**的独立迁移 harness 验证；绝不直接启动克隆生产 session，避免触碰生产 worktree。
8. 清理前逐个确认 resource owner 与 namespace，停止 staging services；删除自己生成的 staging 文件。禁止通配 stop tmux、清理所有 user units 或删除生产 locks。

- **拟改文件**：B2 `scripts/verify-install-staging.js`、`tests/ao/fixtures/install/`、相关 runbook；A3 提供 cgroup fixture 与只作用 staging 的 lifecycle 检查脚本。
- **验收**：全部资源 namespace 隔离可自动断言；fake sessions 与 DB 副本 harness 不触及生产；完整 upgrade 和 new→old→new 有私有回执；公开仅固定 schema。
- **本地待验**：本节全部真实服务操作，云端一律 NOT_RUN；云端仅写脚本、fixture 与文档。

## 12. #125 覆盖、验证状态与未决项

对基线的静态复核：`runtime-bootstrap.js:isLockOwnerAlive/acquireBootstrapLock` 将观察不到 start-token 的在世 owner 判为非活跃，且按路径回收；其 bootstrap 主流程在 committed 前执行 backup GC。两条 deploy 脚本在最终目录解包/构建且目录存在就拒绝；recovery 只按部分 browser 源比较却复用旧 node_modules/dist，`enable --now` 不保证重启 active 服务。`verify-package-install.js` 内部 pack 与 release.yml 末尾 pack 各一次；`verify-fresh-clone.js` 接受 health=ok 作为 ready，退出检查不证明 PID 退出却产生固定成功字段。故 R09 剩余项仍有局部源码依据；这不等于运行复现，也不推导历史 CI 实际泄漏或现有包实际错误。

| #125 ID | 设计吸收点 | 未来实施 / 验收 |
| --- | --- | --- |
| NATIVE-C02 / OPS-1023-01 | 第 2–4 节独立 tmux unit、禁止隐式启动、cgroup 不变量、方案 B | A3 Go + B2 templates；本地 lifecycle 故障验证 |
| R09-04 | 第 6 节安装 flock、owner/start-token/nonce、unknown HOLD、提交前 fence | B2 并发/旧 owner 交错故障注入 |
| R09-05 | 第 6 节 committed 后 GC，GC 错误不回滚 | B2 部分 GC 失败测试 |
| R09-06 | 第 7–9 节 current 全组件切换与 MainPID/start-time/loaded-release 回读 | B2 active/inactive 服务升级与本地验收 |
| R09-07 | 第 5 节 archive 输入、pack-once、全 exports、同摘要上传安装 | B2 final tarball consumer 验证 |
| R09-08 | 第 9 节严格 ready、退出/锁证明，unknown 不伪造成功 receipt | B2 fresh-clone gate fixture |
| R09-09 | 第 6 节 owner partial→校验→rename，同版失败重试 | B2 分阶段失败注入 |
| R09-10 | 第 5–7 节所有 lock/dist/node_modules 字节绑定、禁止跨 release 隐式复用 | B2 root lock-only / dist drift / GC 引用测试 |
| AO05-F07/F08、NATIVE-F08 | 第 8 节 doctor 暴露现存风险 | B2 只诊断；业务修复不在本设计实施范围 |

本 PR 验证：**PASS** 源码静态调用点核对、tmux 3.2 upstream flags 核对、文档要求对账与 `git diff --check`（最终提交前执行）；**NOT_RUN** Go/Node 产品测试（只有设计文档，无实现改动）；**NOT_RUN** CI、systemd/cgroup/WSL2、安装/迁移/回退与真实 WebSocket（云端边界）。所有未来验收仍是计划，不能以文档覆盖当成运行 PASS。

待 design review 确认：RefuseManualStop 维护逃生协议；manifest/envelope 双层 digest；adapter 源码/许可输入；schema 43/44 的 old-reader 兼容区间及最终 release 命名。确认前 A3/B2 不开工。范围外残留（AO05-F07/F08 的业务修复、LAN STOPPING、preview 进程身份与 cleanup obligation 等）继续在 #125 独立跟踪，不在文档 PR 顺手修复。

- **拟改文件**：本 PR 仅本文；后续实施必须逐任务独立 PR。
- **验收**：ID 一一对应，未知/延后/本地待验不混写为修复完成。
- **本地待验**：运行效果、schema 兼容性和发布 attestation；Owner 设计确认已完成；实施与发布验收仍待后续 PR。

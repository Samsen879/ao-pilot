# Sparse WIP preservation

适用任务 A1（R2），#125 / OPS-1023-02，源码基线
`092227ab425e8293ce8ce2e6f6b23409c751330b`。

保存从真实 index 的 `git status --porcelain=v2 -z --untracked-files=all
--no-renames` 取得显式路径集合。按 HEAD 与最终工作目录内容归一化：rename
拆为 D+A，staged 后恢复原内容与 staged 新增后删除均不产生虚假的变更。
冲突/不支持的记录 fail-closed，保留工作目录。保存前应停止该 worktree 的写入者。

临时 index 从 HEAD 初始化，只对显式路径执行 literal NUL pathspec 的
`git add --sparse --pathspec-from-file=- --pathspec-file-nul`，不使用 `-A`。
Git `--sparse` 要求至少 2.34，pathspec 文件选项要求至少 2.25；AO 现有
启动与 doctor 的最低要求为 **2.36.0**，已覆盖这两项，不降低既有要求。

发布 `refs/ao/preserved/<session-id>` 前，要求保存树与 HEAD 的
`git diff --no-renames --name-status -z` 恰好等于归一化变更集，并额外比对
各个 blob/mode。失败不发布新引用、不覆盖旧引用、不删除工作目录。
未物化且标有 skip-worktree 的路径不得被推断为删除。

保存回执在 preserved commit message 的第二段，固定结构：

```json
{"schema_version":"ao.wip-preserve.v1","cone_drift":["outside/file.txt"]}
```

`cone_drift` 是实际保存的 cone 外存在路径（包含修改的 tracked、新增文件与
symlink；删除不列入），按路径排序。它是本机私有回执，日志也会包含这些路径，
不得直接作为公开部署回执。没有新数据库表或迁移；StashUncommitted 仍返回原有 ref。
`.gitignore` 规则保持有效，不自动强加 ignored 文件。非 cone sparse 模式拒绝保存。

restore 沿用现有恢复策略：在 cherry-pick --no-commit 前，扩展较窄 cone
以物化保存涉及的目录，再回放。恢复结果是磁盘上的原字节（symlink 保留其 target），
不是只修改 index。容量不足、合并冲突或其他失败保留保存引用以供重试。

部署前可在本地运行只读清单脚本：

```sh
python3 runtime/headless/scripts/list-cone-drift.py /path/to/worktree > private-cone-backup.jsonl
```

脚本不 stage、不写文件、不刷新 index；JSONL 每行含相对 `path`、`sha256`、
`kind`。它列出 cone 外实际存在的所有普通文件/symlink，**包含 ignored 文件**，
适合在本机据此另做备份；它本身不复制文件。symlink 摘要针对 target 字节。
包含空格、非 ASCII、换行的路径用 JSON 转义。文件仍在变化时应先停写再生成清单。

验收：真实 Git fixture 覆盖 cone 内修改/新增/删除、cone 外新文件与已物化
tracked 修改、未物化 tracked、隐藏文件、空格/非 ASCII/换行/特殊 pathspec、
staged rename 与 staged/unstaged 抵消；save→新 worktree→较窄 cone restore
逐字节核对。确定性交错测试使 diff 或 blob 断言失败，确认旧引用和工作目录保留。

本地待验：在 staging 的 fake-agent 停写后生成私有清单、保存、恢复并按摘要核对。
不要对生产会话做故障注入。该 PR 不改变 systemd/tmux/安装流程，不更新 runtime lock。

Git mode 使用真实 status 中尊重配置的 mode；untracked executable 在
`core.fileMode=false` 下保存为 100644，`core.symlinks=false` 的 tracked
symlink 保留 120000。文件与目录互换分别记录原路径删除和新路径新增。
HEAD 探测错误只有在 symbolic HEAD 的目标 ref 可证实不存在时才允许 unborn；
其它 unknown 失败保留旧引用和目录。清单遇不可读目录/文件必须非零退出，
不能把已有部分输出视作完整清单。

附加定向检查：

```sh
CGO_ENABLED=0 go -C runtime/headless/backend test -count=1 ./internal/adapters/workspace/gitworktree ./internal/cli
PYTHONDONTWRITEBYTECODE=1 python3 runtime/headless/scripts/test_list_cone_drift.py
```

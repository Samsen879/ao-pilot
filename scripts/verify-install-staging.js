#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRelease, durableJson } from './ao/lib/release-manifest.js';
import { validateInstallConfiguration } from './ao/lib/release-systemd.js';
export function assertStagingIsolation(config, production) {
  validateInstallConfiguration(config);
  assertRelease(config.namespace.startsWith('ao-pilot-staging-') && config.namespace !== production.namespace, 'staging_namespace_collision');
  for (const field of ['installRoot', 'stateRoot', 'dataDir', 'discoveryDir', 'configPath', 'controlPlaneRoot', 'trustedHostDirectory', 'tmuxTmpdir']) {
    const stage = path.resolve(config[field]);
    for (const productionField of ['installRoot', 'stateRoot', 'dataDir', 'discoveryDir', 'configPath', 'tmuxTmpdir']) {
      if (!production[productionField]) continue;
      const live = path.resolve(production[productionField]);
      assertRelease(stage !== live && !stage.startsWith(`${live}/`) && !live.startsWith(`${stage}/`), 'staging_path_collision');
    }
  }
  assertRelease(config.tmuxSocket !== production.tmuxSocket && config.listenPorts.every((port) => !(production.listenPorts ?? []).includes(port)), 'staging_endpoint_collision');
  return true;
}
export function prepareStaging({ root, id, production, ports = [43001, 43000, 43002, 43003, 43004] }) {
  assertRelease(/^[a-z0-9-]+$/.test(id) && path.isAbsolute(root), 'invalid_staging_input');
  assertRelease(!fs.existsSync(root), 'staging_root_exists');
  const namespace = `ao-pilot-staging-${id}`;
  const config = { schema_version: 'ao.install-config.v1', namespace, installRoot: path.join(root, 'install'), stateRoot: path.join(root, 'state'),
    unitRoot: path.join(os.homedir(), '.config/systemd/user'), dataDir: path.join(root, 'state/data'), discoveryDir: path.join(root, 'state/discovery'),
    configPath: path.join(root, 'state/ao.yaml'), controlPlaneRoot: path.join(root, 'state/control'), trustedHostDirectory: path.join(root, 'state/trusted-host'),
    tmuxTmpdir: path.join(root, 'state/tmux'), tmuxSocket: namespace,
    daemonURL: `http://127.0.0.1:${ports[0]}`, terminalURL: `ws://127.0.0.1:${ports[2]}/ao-terminal-ws?sessionId=REPLACE_WITH_FAKE_SESSION_ID`,
    terminalOrigin: `http://127.0.0.1:${ports[2]}`, terminalTokenFile: path.join(root, 'state/staging-terminal-token'), terminalCanaryPrefix: 'canary:',
    listenPorts: ports, cliPath: path.join(root, 'bin/ao-pilot'), mode: 'first', releaseCatalog: {} };
  assertStagingIsolation(config, production);
  fs.mkdirSync(config.stateRoot, { recursive: true, mode: 0o700 });
  assertRelease(fs.realpathSync(root) === path.resolve(root), 'unsafe_install_root');
  for (const field of ['dataDir', 'discoveryDir', 'controlPlaneRoot', 'trustedHostDirectory', 'tmuxTmpdir']) fs.mkdirSync(config[field], { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'repository'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'fake-agent.sh'), '#!/bin/sh\nset -eu\nn=0\nwhile :; do n=$((n+1)); printf "canary:%s\\n" "$n"; printf "%s\\n" "$n" > "$AO_CANARY_FILE"; sleep 1; done\n', { mode: 0o700 });
  fs.writeFileSync(config.configPath, '# Staging only: fill with temporary project and fake agent, never a production worktree.\n', { mode: 0o600 });
  durableJson(path.join(root, 'install.json'), config);
  fs.writeFileSync(path.join(root, 'LOCAL-VALIDATION.md'), `# 本地 staging 待验\n\n仅操作 ${namespace}；先检查端口空闲、systemd/linger 与隔离路径。\n\n1. 初始化 repository/ 临时 Git 仓库。fake-agent.sh 使用 staging AO_CANARY_FILE。配置假 session 的终端 URL/token，不能复用生产项目。\n2. 从 archive 构建 old/new release；adapter 与 schema compatibility 输入必须齐备。把可信构建的 envelope SHA 登记进 install.json.releaseCatalog。\n3. 执行 upgrade apply --release <new-id> --install-config install.json；首次方案B接受计划内中断并按原CID恢复，之后mode=daily。\n4. 分别 restart、stop+start、仅对绑定PID/start-token的 staging daemon SIGKILL。要求tmux PID/start-token和CID集合不变、WebSocket PTY canary连续、无需restore。禁止通配kill/stop。\n5. new→old→new回退演练。不兼容schema必须previous+迁移前DB备份，记录备份完成到停止写者的数据丢失窗口；外部效果不会撤销。\n6. 生产DB仅由本地维护者先做一致性副本，在独立migration harness验证；不启动复制生产session，不连接生产worktree。\n7. 清理仅针对此namespace和自己生成的资源；私有完整回执保留本机，公开只用ao.install-public-receipt.v1字段。\n\n本文件是待执行步骤，不是运行PASS回执。\n`, { mode: 0o600 });
  return config;
}
export function runCli(argv) {
  if (argv.includes('--help')) { process.stdout.write('Usage: node scripts/verify-install-staging.js --prepare <new-root> --id <test-id> --production-descriptor <private-json>\nWrites a private staging plan; never starts or stops services.\n'); return 0; }
  const value = (flag) => argv[argv.indexOf(flag) + 1];
  try {
    assertRelease(argv.includes('--prepare') && argv.includes('--id') && argv.includes('--production-descriptor'), 'invalid_staging_input');
    prepareStaging({ root: path.resolve(value('--prepare')), id: value('--id'), production: JSON.parse(fs.readFileSync(value('--production-descriptor'), 'utf8')) });
    process.stdout.write('Staging plan prepared. Services, cgroup, migration and rollback remain NOT_RUN.\n'); return 0;
  } catch (error) { process.stderr.write(`${error.code ?? 'staging_prepare_failed'}\n`); return 2; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = runCli(process.argv.slice(2));

#!/usr/bin/python3
"""Owner entrypoint. --check-only runs the full installer preflight read-only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess


def sha(file):
    with Path(file).open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--receipt', type=Path, required=True)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--check-only', action='store_true')
    modes.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    assert not os.environ.get('TMUX') and not os.environ.get('TMUX_PANE'), 'Use an ordinary terminal'
    root = args.receipt.resolve()
    local = root / 'L2-production'
    build = json.loads((root / 'build-result.json').read_text())
    plan = json.loads((local / 'owner-environment.json').read_text())
    config = json.loads((local / 'install-config.json').read_text())
    assert build['status'] == 'PASS' and plan['release_id'] == build['release_id']
    bundle = Path(build['bundle'])
    assert sha(bundle / 'package.tgz') == build['npm_tarball_sha256']
    assert sha(bundle / 'release-envelope.json') == build['envelope_sha256']
    manifest = json.loads((bundle / 'payload/release.json').read_text())
    tools = plan['tools']
    missing = [name for name in ['node', 'flock', 'systemctl', 'sqlite3', 'loginctl', 'ss', 'tmux', 'git', 'python3', 'bwrap']
               if name not in tools or not Path(tools[name]).is_absolute() or not os.access(tools[name], os.X_OK)]
    if missing:
        print(json.dumps({'status': 'failed', 'code': 'install_required_tools_missing', 'missing': missing, 'production_mutated': False}))
        return 2
    assert Path(tools['node']).resolve() == Path(manifest['toolchain']['node_executable']).resolve()
    assert sha(tools['node']) == manifest['toolchain']['node_sha256']
    # No caller PATH, loader variables, shell init, or ambient API keys survive.
    env = {'HOME': plan['home'], 'USER': plan['user'], 'LOGNAME': plan['user'],
           'SHELL': tools.get('bash', '/bin/bash'), 'PATH': plan['PATH'],
           'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'TMPDIR': '/tmp',
           'XDG_RUNTIME_DIR': '/run/user/' + str(os.getuid()),
           'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/' + str(os.getuid()) + '/bus'}
    for name, value in plan.get('network_environment', {}).items():
        assert name in {'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy'}
        env[name] = value
    command = [tools['node'], str(bundle / 'payload/scripts/ao-upgrade.js'), 'preflight',
               '--release', build['release_id'], '--install-config', str(local / 'install-config.json'),
               '--adopt-legacy', '--prepared-config', str(local / 'production.yaml'),
               '--prepared-token', str(local / 'terminal-token')]
    # No writable bind, lock acquisition, receipt, journal, unit, or DB mutation.
    probe = subprocess.run([tools['bwrap'], '--die-with-parent', '--ro-bind', '/', '/',
                            '--dev', '/dev', '--proc', '/proc', '--chdir', str(root), '--', *command], env=env)
    if probe.returncode or args.check_only:
        return probe.returncode
    apply_script = local / 'owner-apply.py'
    assert sha(apply_script) == plan['apply_script_sha256'], 'Owner apply draft changed'
    return subprocess.run([tools['python3'], '-I', str(apply_script)], env=env).returncode


if __name__ == '__main__':
    raise SystemExit(main())

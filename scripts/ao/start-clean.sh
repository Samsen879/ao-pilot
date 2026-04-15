#!/usr/bin/env bash

set -euo pipefail

project="my-project"
orchestrator_session="${AO_ORCHESTRATOR_SESSION:-ao-orchestrator}"
dry_run=0
dashboard_flag="--no-dashboard"

usage() {
  cat <<'EOF'
Usage: bash scripts/ao/start-clean.sh [options]

Options:
  --project <project>         AO project id. Default: my-project
  --orchestrator <session>    Orchestrator session name. Default: ao-orchestrator
  --with-dashboard            Start AO with dashboard enabled
  --dry-run                   Print commands without executing them
  -h, --help                  Show this help message
EOF
}

run_cmd() {
  printf '+'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'

  if [[ "$dry_run" -eq 0 ]]; then
    "$@"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      shift
      project="${1:?missing value for --project}"
      ;;
    --orchestrator)
      shift
      orchestrator_session="${1:?missing value for --orchestrator}"
      ;;
    --with-dashboard)
      dashboard_flag=""
      ;;
    --dry-run)
      dry_run=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

workflow_sync_script=""
workflow_sync_candidates=(
  "$repo_root/scripts/workflow/baseline-sync.sh"
)
git_hooks_install_script=""
git_hooks_install_candidates=(
  "$repo_root/scripts/git-hooks/install.sh"
)
git_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
expected_hooks_dir="$git_common_dir/ao-hooks"
current_hooks_path="$(git config --get core.hooksPath || true)"

for candidate in "${workflow_sync_candidates[@]}"; do
  if [[ -x "$candidate" ]]; then
    workflow_sync_script="$candidate"
    break
  fi
done

for candidate in "${git_hooks_install_candidates[@]}"; do
  if [[ -x "$candidate" ]]; then
    git_hooks_install_script="$candidate"
    break
  fi
done

printf '+ ao stop %q --purge-session || true\n' "$project"
if [[ "$dry_run" -eq 0 ]]; then
  ao stop "$project" --purge-session || true
fi

if [[ "$dry_run" -eq 0 ]]; then
  echo "+ ao doctor --fix"
  if ! ao doctor --fix; then
    echo "+ ao update"
    ao update
    echo "+ ao doctor"
    ao doctor
  fi
else
  echo "+ ao doctor --fix"
  echo "+ ao update    # fallback if doctor --fix fails"
  echo "+ ao doctor    # re-check after update"
fi

if [[ -n "$git_hooks_install_script" ]]; then
  if [[ "$current_hooks_path" != "$expected_hooks_dir" || ! -d "$expected_hooks_dir" ]]; then
    run_cmd bash "$git_hooks_install_script"
  else
    echo "+ skip git hook install (already configured)"
  fi
else
  echo "+ skip git hook install (repo-local install script not present)"
fi

if [[ -n "$workflow_sync_script" ]]; then
  run_cmd bash "$workflow_sync_script"
else
  echo "+ skip workflow baseline sync (repo-local baseline sync script not present)"
fi

if [[ -n "$dashboard_flag" ]]; then
  run_cmd ao start "$project" "$dashboard_flag"
else
  run_cmd ao start "$project"
fi

run_cmd ao send "$orchestrator_session" --no-wait \
  "Reconcile live GitHub PR, CI, and review state for this project and continue the execution chain without waiting for human input."
run_cmd ao status -p "$project"

#!/usr/bin/env bash

set -euo pipefail

project="my-project"
dry_run=0

usage() {
  cat <<'EOF'
Usage: bash scripts/ao/start-clean.sh [options]

Options:
  --project <project>         AO project id. Default: my-project
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
pilot_command=(node "$repo_root/bin/ao-pilot.js")

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

printf '+ node %q stop --project %q || true\n' "$repo_root/bin/ao-pilot.js" "$project"
if [[ "$dry_run" -eq 0 ]]; then
  "${pilot_command[@]}" runtime-path
  "${pilot_command[@]}" stop --project "$project" || true
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

run_cmd "${pilot_command[@]}" start --project "$project"
run_cmd "${pilot_command[@]}" status --project "$project"

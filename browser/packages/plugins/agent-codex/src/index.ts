import {
  DEFAULT_READY_THRESHOLD_MS,
  shellEscape,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityState,
  type ActivityDetection,
  type CostEstimate,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@composio/ao-core";
import { execFile, execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { writeFile, mkdir, readFile, readdir, rename, stat, lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);
const MISSING_TMUX_SESSION_PATTERNS = [
  /can't find session/i,
  /session not found/i,
  /no such session/i,
];

function normalizePermissionMode(
  mode: string | undefined,
): "permissionless" | "default" | "auto-edit" | "suggest" | undefined {
  if (!mode) return undefined;
  if (mode === "skip") return "permissionless";
  if (
    mode === "permissionless" ||
    mode === "default" ||
    mode === "auto-edit" ||
    mode === "suggest"
  ) {
    return mode;
  }
  return undefined;
}

/** Shared bin directory for ao shell wrappers (prepended to PATH) */
const AO_BIN_DIR = join(homedir(), ".ao", "bin");
const DEFAULT_PATH = "/usr/bin:/bin";
const PREFERRED_GH_BIN_DIR = "/usr/local/bin";
const PREFERRED_GH_PATH = `${PREFERRED_GH_BIN_DIR}/gh`;

function buildAgentPath(basePath: string | undefined): string {
  const inherited = (basePath ?? DEFAULT_PATH).split(":").filter(Boolean);
  const ordered: string[] = [];
  const seen = new Set<string>();

  const add = (entry: string): void => {
    if (!entry || seen.has(entry)) return;
    ordered.push(entry);
    seen.add(entry);
  };

  // Ensure wrappers are always first, then prioritize /usr/local/bin so
  // wrapper-discovered `gh` resolves there before linuxbrew paths.
  add(AO_BIN_DIR);
  add(PREFERRED_GH_BIN_DIR);

  for (const entry of inherited) add(entry);

  return ordered.join(":");
}

function isLikelyCodexStatusFooter(line: string): boolean {
  if (!line.includes("·")) return false;

  const parts = line
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return false;

  const firstPart = parts[0] ?? "";
  const lastPart = parts[parts.length - 1] ?? "";
  const hasPath = /^(?:~\/|\/)/.test(lastPart);
  const hasBudget = /\b\d+%\s+left\b/i.test(line);
  const hasModel = /^(?:gpt|o\d|codex)[\w.+-]*(?:\s+(?:low|medium|high|xhigh))?/i.test(firstPart);

  return hasPath && (hasBudget || hasModel);
}

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "codex",
  slot: "agent" as const,
  description: "Agent plugin: OpenAI Codex CLI",
  version: "0.1.1",
  displayName: "OpenAI Codex",
};

function getErrorText(error: unknown): string {
  if (error instanceof Error) {
    const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
    return `${error.message}\n${stderr}`;
  }

  return String(error);
}

function isMissingTmuxSessionError(error: unknown): boolean {
  const errorText = getErrorText(error);
  return MISSING_TMUX_SESSION_PATTERNS.some((pattern) => pattern.test(errorText));
}

// =============================================================================
// Shell Wrappers (automatic metadata updates — like Claude Code's PostToolUse)
// =============================================================================

/**
 * Helper script sourced by both gh and git wrappers.
 * Provides update_ao_metadata() for writing key=value to the session file.
 */
/* eslint-disable no-useless-escape -- \$ escapes are intentional: bash scripts in JS template literals */
const AO_METADATA_HELPER = `#!/usr/bin/env bash
# ao-metadata-helper — shared by gh/git wrappers
# Provides: update_ao_metadata <key> <value>

update_ao_metadata() {
  local key="\$1" value="\$2"
  local ao_dir="\${AO_DATA_DIR:-}"
  local ao_session="\${AO_SESSION:-}"

  [[ -z "\$ao_dir" || -z "\$ao_session" ]] && return 0

  # Validate: session name must not contain path separators or traversal
  case "\$ao_session" in
    */* | *..*) return 0 ;;
  esac

  # Validate: ao_dir must be an absolute path under known ao directories or /tmp
  case "\$ao_dir" in
    "\$HOME"/.ao/* | "\$HOME"/.agent-orchestrator/* | /tmp/*) ;;
    *) return 0 ;;
  esac

  local metadata_file="\$ao_dir/\$ao_session"

  # Resolve and verify the file is still within ao_dir
  local real_dir real_ao_dir
  real_ao_dir="\$(cd "\$ao_dir" 2>/dev/null && pwd -P)" || return 0
  real_dir="\$(cd "\$(dirname "\$metadata_file")" 2>/dev/null && pwd -P)" || return 0
  [[ "\$real_dir" == "\$real_ao_dir"* ]] || return 0

  [[ -f "\$metadata_file" ]] || return 0

  local temp_file="\${metadata_file}.tmp.\$\$"

  # Strip newlines from value to prevent metadata line injection
  local clean_value="\$(printf '%s' "\$value" | tr -d '\\n')"

  # Escape sed metacharacters in value (& expands to matched text, | breaks delimiter)
  local escaped_value="\$(printf '%s' "\$clean_value" | sed 's/[&|\\\\]/\\\\&/g')"

  if grep -q "^\${key}=" "\$metadata_file" 2>/dev/null; then
    sed "s|^\${key}=.*|\${key}=\${escaped_value}|" "\$metadata_file" > "\$temp_file"
  else
    cp "\$metadata_file" "\$temp_file"
    printf '%s=%s\\n' "\$key" "\$clean_value" >> "\$temp_file"
  fi

  mv "\$temp_file" "\$metadata_file"
}
`;

/**
 * gh wrapper — intercepts `gh pr create` and `gh pr merge` to auto-update
 * session metadata. All other commands pass through transparently.
 */
const GH_WRAPPER = `#!/usr/bin/env bash
# ao gh wrapper — auto-updates session metadata on PR operations

# Find real gh by removing our wrapper directory from PATH
ao_bin_dir="\$(cd "\$(dirname "\$0")" && pwd)"
clean_path="\$(echo "\$PATH" | tr ':' '\\n' | grep -Fxv "\$ao_bin_dir" | grep . | tr '\\n' ':')"
clean_path="\${clean_path%:}"
real_gh=""

# Prefer explicit gh path when provided by AO environment.
# Guard against recursive self-reference to the wrapper in ~/.ao/bin.
if [[ -n "\${GH_PATH:-}" && -x "\$GH_PATH" ]]; then
  gh_dir="\$(cd "\$(dirname "\$GH_PATH")" 2>/dev/null && pwd)"
  if [[ "\$gh_dir" != "\$ao_bin_dir" ]]; then
    real_gh="\$GH_PATH"
  fi
fi

if [[ -z "\$real_gh" ]]; then
  real_gh="\$(PATH="\$clean_path" command -v gh 2>/dev/null)"
fi

if [[ -z "\$real_gh" ]]; then
  echo "ao-wrapper: gh not found in PATH" >&2
  exit 127
fi

# Source the metadata helper
source "\$ao_bin_dir/ao-metadata-helper.sh" 2>/dev/null || true

# Only capture output for commands we need to parse (pr/create, pr/merge).
# All other commands pass through transparently without stream merging.
case "\$1/\$2" in
  pr/create|pr/merge)
    tmpout="\$(mktemp)"
    trap 'rm -f "\$tmpout"' EXIT

    "\$real_gh" "\$@" 2>&1 | tee "\$tmpout"
    exit_code=\${PIPESTATUS[0]}

    if [[ \$exit_code -eq 0 ]]; then
      output="\$(cat "\$tmpout")"
      case "\$1/\$2" in
        pr/create)
          pr_url="\$(echo "\$output" | grep -Eo 'https://github\\.com/[^/]+/[^/]+/pull/[0-9]+' | head -1)"
          if [[ -n "\$pr_url" ]]; then
            update_ao_metadata pr "\$pr_url"
            update_ao_metadata status pr_open
          fi
          ;;
        pr/merge)
          update_ao_metadata status merged
          ;;
      esac
    fi

    exit \$exit_code
    ;;
  *)
    exec "\$real_gh" "\$@"
    ;;
esac
`;

/**
 * git wrapper — intercepts branch creation commands to auto-update metadata.
 * All other commands pass through transparently.
 */
const GIT_WRAPPER = `#!/usr/bin/env bash
# ao git wrapper — auto-updates session metadata on branch operations

# Find real git by removing our wrapper directory from PATH
ao_bin_dir="\$(cd "\$(dirname "\$0")" && pwd)"
clean_path="\$(echo "\$PATH" | tr ':' '\\n' | grep -Fxv "\$ao_bin_dir" | grep . | tr '\\n' ':')"
clean_path="\${clean_path%:}"
real_git="\$(PATH="\$clean_path" command -v git 2>/dev/null)"

if [[ -z "\$real_git" ]]; then
  echo "ao-wrapper: git not found in PATH" >&2
  exit 127
fi

# Source the metadata helper
source "\$ao_bin_dir/ao-metadata-helper.sh" 2>/dev/null || true

# Run real git
"\$real_git" "\$@"
exit_code=\$?

# Only update metadata on success
if [[ \$exit_code -eq 0 ]]; then
  case "\$1/\$2" in
    checkout/-b)
      update_ao_metadata branch "\$3"
      ;;
    switch/-c)
      update_ao_metadata branch "\$3"
      ;;
  esac
fi

exit \$exit_code
`;

// =============================================================================
// Workspace Setup
// =============================================================================

/**
 * Section appended to AGENTS.md as a secondary signal. The PATH-based wrappers
 * handle metadata updates automatically, but AGENTS.md reinforces the intent
 * and helps if the wrappers are bypassed.
 */
const AO_AGENTS_MD_SECTION = `
## Agent Orchestrator (ao) Session

You are running inside an Agent Orchestrator managed workspace.
Session metadata is updated automatically via shell wrappers.

If automatic updates fail, you can manually update metadata:
\`\`\`bash
~/.ao/bin/ao-metadata-helper.sh  # sourced automatically
# Then call: update_ao_metadata <key> <value>
\`\`\`
`;
/* eslint-enable no-useless-escape */

/**
 * Atomically write a file by writing to a temp file in the same directory,
 * then renaming. This prevents concurrent sessions from reading partially
 * written wrapper scripts.
 */
async function atomicWriteFile(filePath: string, content: string, mode: number): Promise<void> {
  const suffix = randomBytes(6).toString("hex");
  const tmpPath = `${filePath}.tmp.${suffix}`;
  await writeFile(tmpPath, content, { encoding: "utf-8", mode });
  await rename(tmpPath, filePath);
}

async function setupCodexWorkspace(workspacePath: string): Promise<void> {
  // 1. Write shared wrappers to ~/.ao/bin/
  await mkdir(AO_BIN_DIR, { recursive: true });

  await atomicWriteFile(join(AO_BIN_DIR, "ao-metadata-helper.sh"), AO_METADATA_HELPER, 0o755);

  // Only write wrappers if they don't exist or are outdated (check marker)
  const markerPath = join(AO_BIN_DIR, ".ao-version");
  const currentVersion = "0.1.1";
  let needsUpdate = true;
  try {
    const existing = await readFile(markerPath, "utf-8");
    if (existing.trim() === currentVersion) needsUpdate = false;
  } catch {
    // File doesn't exist — needs update
  }

  if (needsUpdate) {
    // Write wrappers atomically, then write the version marker last.
    // If we crash between wrapper writes and marker write, the next
    // invocation will redo the writes (safe: wrappers are idempotent).
    await atomicWriteFile(join(AO_BIN_DIR, "gh"), GH_WRAPPER, 0o755);
    await atomicWriteFile(join(AO_BIN_DIR, "git"), GIT_WRAPPER, 0o755);
    await atomicWriteFile(markerPath, currentVersion, 0o644);
  }

  // 2. Append ao section to AGENTS.md (create if missing, skip if already present)
  const agentsMdPath = join(workspacePath, "AGENTS.md");
  let existing = "";
  try {
    existing = await readFile(agentsMdPath, "utf-8");
  } catch {
    // File doesn't exist yet
  }

  if (!existing.includes("Agent Orchestrator (ao) Session")) {
    const content = existing
      ? existing.trimEnd() + "\n" + AO_AGENTS_MD_SECTION
      : AO_AGENTS_MD_SECTION.trimStart();
    await writeFile(agentsMdPath, content, "utf-8");
  }
}

// =============================================================================
// Codex Session JSONL Parsing (for getSessionInfo)
// =============================================================================

/** Codex session directory: ~/.codex/sessions/ */
const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");

/** Typed representation of a line in a Codex JSONL session file */
interface CodexJsonlLine {
  type?: string;
  cwd?: string;
  model?: string;
  // Thread ID from thread_started notifications
  threadId?: string;
  payload?: {
    cwd?: string;
    model?: string;
    threadId?: string;
    type?: string;
    info?: {
      total_token_usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
      last_token_usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };
  };
  // User message content (from user input events)
  content?: string;
  role?: string;
  // event_msg with token_count subtype
  msg?: {
    type?: string;
    input_tokens?: number;
    output_tokens?: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
  };
}

function getPayloadObject(entry: CodexJsonlLine): NonNullable<CodexJsonlLine["payload"]> | null {
  return entry.payload && typeof entry.payload === "object" ? entry.payload : null;
}

function getSessionWorkspaceCandidates(session: Session): string[] {
  const candidates = new Set<string>();
  if (typeof session.workspacePath === "string" && session.workspacePath) {
    candidates.add(session.workspacePath);
  }

  const handleWorkspacePath = session.runtimeHandle?.data?.["workspacePath"];
  if (typeof handleWorkspacePath === "string" && handleWorkspacePath) {
    candidates.add(handleWorkspacePath);
  }

  return [...candidates];
}

function getEntryWorkspacePath(entry: CodexJsonlLine): string | null {
  if (typeof entry.cwd === "string" && entry.cwd) return entry.cwd;
  const payload = getPayloadObject(entry);
  if (payload && typeof payload.cwd === "string" && payload.cwd) return payload.cwd;
  return null;
}

function getEntryModel(entry: CodexJsonlLine): string | null {
  if (typeof entry.model === "string" && entry.model) return entry.model;
  const payload = getPayloadObject(entry);
  if (payload && typeof payload.model === "string" && payload.model) return payload.model;
  return null;
}

function getEntryThreadId(entry: CodexJsonlLine): string | null {
  if (typeof entry.threadId === "string" && entry.threadId) return entry.threadId;
  const payload = getPayloadObject(entry);
  if (payload && typeof payload.threadId === "string" && payload.threadId) return payload.threadId;
  return null;
}

function getTokenCountUsage(
  entry: CodexJsonlLine,
): { inputTokens: number; outputTokens: number } | null {
  if (entry.msg?.type === "token_count") {
    return {
      inputTokens: entry.msg.input_tokens ?? 0,
      outputTokens: entry.msg.output_tokens ?? 0,
    };
  }

  const payload = getPayloadObject(entry);
  if (entry.type !== "event_msg" || payload?.type !== "token_count") return null;

  const usage = payload.info?.last_token_usage ?? payload.info?.total_token_usage;
  if (!usage) return null;

  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
}

/**
 * Collect all JSONL files under a directory, recursively.
 * Codex stores sessions in date-sharded directories:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Uses lstat (not stat) so symlinks to directories are never followed,
 * preventing infinite loops from symlink cycles. Max depth is capped at 4
 * (YYYY/MM/DD + 1 buffer) as an additional safety guard.
 */
const MAX_SESSION_SCAN_DEPTH = 4;
const SESSION_META_SCAN_CHUNK_BYTES = 4096;
const SESSION_META_SCAN_MAX_BYTES = 256 * 1024;
const SESSION_META_SCAN_MAX_LINES = 10;
const SESSION_INDEX_STAT_CONCURRENCY = 32;

async function collectJsonlFiles(dir: string, depth = 0, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  if (depth > MAX_SESSION_SCAN_DEPTH) return [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    const fullPath = join(dir, entry);
    if (entry.endsWith(".jsonl")) {
      results.push(fullPath);
    } else {
      // Recurse into subdirectories (YYYY/MM/DD structure).
      // Use lstat to avoid following symlinks that could create cycles.
      try {
        const s = await lstat(fullPath);
        if (s.isDirectory()) {
          const nested = await collectJsonlFiles(fullPath, depth + 1, signal);
          results.push(...nested);
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  }
  return results;
}

/**
 * Read the workspace path from the first session_meta entry. The result is
 * indexed by file path so later workspace lookups do not reopen this file.
 */
async function readSessionFileWorkspace(
  filePath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    signal?.throwIfAborted();
    const handle = await open(filePath, "r");
    let content = "";
    try {
      let position = 0;
      while (
        content.split("\n").length <= SESSION_META_SCAN_MAX_LINES &&
        position < SESSION_META_SCAN_MAX_BYTES
      ) {
        signal?.throwIfAborted();
        const remaining = SESSION_META_SCAN_MAX_BYTES - position;
        const chunkSize = Math.min(SESSION_META_SCAN_CHUNK_BYTES, remaining);
        const buffer = Buffer.allocUnsafe(chunkSize);
        const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
        if (bytesRead <= 0) {
          break;
        }
        content += buffer.subarray(0, bytesRead).toString("utf-8");
        position += bytesRead;
      }
    } finally {
      await handle.close();
    }
    const lines = content.split("\n").slice(0, SESSION_META_SCAN_MAX_LINES);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed) &&
          (parsed as CodexJsonlLine).type === "session_meta"
        ) {
          return getEntryWorkspacePath(parsed as CodexJsonlLine);
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // Unreadable file
  }
  return null;
}

/**
 * Find Codex session files whose `session_meta` cwd matches the given workspace path.
 * Recursively scans ~/.codex/sessions/ (date-sharded: YYYY/MM/DD/rollout-*.jsonl).
 * Returns the path to the most recently modified matching file, or null.
 */
interface RankedSessionFile {
  path: string;
  mtime: number;
}

async function buildRankedSessionFiles(signal?: AbortSignal): Promise<RankedSessionFile[]> {
  const jsonlFiles = await collectJsonlFiles(CODEX_SESSIONS_DIR, 0, signal);
  signal?.throwIfAborted();
  const rankedFiles: RankedSessionFile[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < jsonlFiles.length) {
      signal?.throwIfAborted();
      const filePath = jsonlFiles[cursor++];
      if (!filePath) continue;
      try {
        const s = await stat(filePath);
        rankedFiles.push({ path: filePath, mtime: s.mtimeMs });
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SESSION_INDEX_STAT_CONCURRENCY, jsonlFiles.length) }, () =>
      worker(),
    ),
  );
  return rankedFiles.sort((a, b) => b.mtime - a.mtime);
}

async function findCodexSessionFile(
  workspacePath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const rankedFiles = await getRankedSessionFiles(signal);

  for (const { path: filePath } of rankedFiles) {
    signal?.throwIfAborted();
    const indexedWorkspace = await getIndexedSessionWorkspace(filePath, signal);
    if (indexedWorkspace === workspacePath) {
      return filePath;
    }
  }

  return null;
}

/** Aggregated data extracted from a Codex session file via streaming */
interface CodexSessionData {
  model: string | null;
  threadId: string | null;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Stream a Codex JSONL session file line-by-line and aggregate the data
 * we need (model, threadId, token counts) without loading the entire file
 * into memory. This is critical because Codex rollout files can be 100 MB+.
 */
async function streamCodexSessionData(
  filePath: string,
  signal?: AbortSignal,
): Promise<CodexSessionData | null> {
  try {
    signal?.throwIfAborted();
    const data: CodexSessionData = { model: null, threadId: null, inputTokens: 0, outputTokens: 0 };
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8", signal }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      signal?.throwIfAborted();
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
        const entry = parsed as CodexJsonlLine;

        if (entry.type === "session_meta") {
          const model = getEntryModel(entry);
          if (model) {
            data.model = model;
          }
        }
        const threadId = getEntryThreadId(entry);
        if (threadId) {
          data.threadId = threadId;
        }
        const usage = getTokenCountUsage(entry);
        if (usage) {
          data.inputTokens += usage.inputTokens;
          data.outputTokens += usage.outputTokens;
        }
      } catch {
        // Skip malformed lines
      }
    }

    return data;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

// =============================================================================
// Binary Resolution
// =============================================================================

/**
 * Resolve the Codex CLI binary path.
 * Checks (in order): which, common fallback locations.
 * Returns "codex" as final fallback (let the shell resolve it at runtime).
 */
export async function resolveCodexBinary(): Promise<string> {
  // 1. Try `which codex`
  try {
    const { stdout } = await execFileAsync("which", ["codex"], { timeout: 10_000 });
    const resolved = stdout.trim();
    if (resolved) return resolved;
  } catch {
    // Not found via which
  }

  // 2. Check common locations (npm global, Homebrew, Cargo — Codex is now Rust-based)
  const home = homedir();
  const candidates = [
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
    join(home, ".cargo", "bin", "codex"),
    join(home, ".npm", "bin", "codex"),
  ];

  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Not found at this location
    }
  }

  // 3. Fallback: let the shell resolve it
  return "codex";
}

// =============================================================================
// Agent Implementation
// =============================================================================

/** Append approval-policy flags to a command parts array */
function appendApprovalFlags(parts: string[], permissions: string | undefined): void {
  const mode = normalizePermissionMode(permissions);
  if (mode === "permissionless") {
    parts.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (mode === "auto-edit") {
    parts.push("--ask-for-approval", "never");
  } else if (mode === "suggest") {
    parts.push("--ask-for-approval", "untrusted");
  }
}

/** Append model and reasoning flags to a command parts array */
function appendModelFlags(parts: string[], model: string | undefined): void {
  if (!model) return;
  parts.push("--model", shellEscape(model));

  // Auto-detect o-series models and enable reasoning via config override.
  // Codex does not have a --reasoning flag; reasoning is controlled via
  // the model_reasoning_effort config key.
  if (/^o[34]/i.test(model)) {
    parts.push("-c", "model_reasoning_effort=high");
  }
}

/** Disable Codex startup update checks/prompts in non-interactive sessions */
function appendNoUpdateCheckFlag(parts: string[]): void {
  parts.push("-c", "check_for_update_on_startup=false");
}

/** TTL for session file path cache (ms). Prevents redundant filesystem scans
 *  when getActivityState and getSessionInfo are called in the same refresh cycle. */
const SESSION_FILE_CACHE_TTL_MS = 30_000;
const SESSION_DATA_CACHE_TTL_MS = 5_000;

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Module-level session file cache shared across the agent instance lifetime.
 *  Keyed by workspace path, stores the resolved file path and an expiry timestamp. */
const sessionFileCache = new Map<string, { path: string | null; expiry: number }>();
const sessionFileLookups = new Map<string, Promise<string | null>>();
const sessionWorkspaceIndex = new Map<string, string | null>();
const sessionWorkspaceReads = new Map<string, Promise<string | null>>();
let rankedSessionFilesCache: { files: RankedSessionFile[]; expiry: number } | null = null;
let rankedSessionFilesBuild: Promise<RankedSessionFile[]> | null = null;
const sessionDataCache = new Map<string, { data: CodexSessionData | null; expiry: number }>();
const sessionDataReads = new Map<string, Promise<CodexSessionData | null>>();

async function getRankedSessionFiles(signal?: AbortSignal): Promise<RankedSessionFile[]> {
  if (rankedSessionFilesCache && Date.now() < rankedSessionFilesCache.expiry) {
    return rankedSessionFilesCache.files;
  }

  if (!rankedSessionFilesBuild) {
    rankedSessionFilesBuild = buildRankedSessionFiles()
      .then((files) => {
        rankedSessionFilesCache = {
          files,
          expiry: Date.now() + SESSION_FILE_CACHE_TTL_MS,
        };
        return files;
      })
      .finally(() => {
        rankedSessionFilesBuild = null;
      });
  }

  return awaitWithSignal(rankedSessionFilesBuild, signal);
}

async function getIndexedSessionWorkspace(
  filePath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (sessionWorkspaceIndex.has(filePath)) {
    return sessionWorkspaceIndex.get(filePath) ?? null;
  }

  let pending = sessionWorkspaceReads.get(filePath);
  if (!pending) {
    pending = readSessionFileWorkspace(filePath)
      .then((workspacePath) => {
        sessionWorkspaceIndex.set(filePath, workspacePath);
        return workspacePath;
      })
      .finally(() => {
        sessionWorkspaceReads.delete(filePath);
      });
    sessionWorkspaceReads.set(filePath, pending);
  }

  return awaitWithSignal(pending, signal);
}

async function getSessionDataCached(
  filePath: string,
  signal?: AbortSignal,
): Promise<CodexSessionData | null> {
  const cached = sessionDataCache.get(filePath);
  if (cached && Date.now() < cached.expiry) return cached.data;

  let pending = sessionDataReads.get(filePath);
  if (!pending) {
    pending = streamCodexSessionData(filePath)
      .then((data) => {
        sessionDataCache.set(filePath, {
          data,
          expiry: Date.now() + SESSION_DATA_CACHE_TTL_MS,
        });
        return data;
      })
      .finally(() => {
        sessionDataReads.delete(filePath);
      });
    sessionDataReads.set(filePath, pending);
  }

  return awaitWithSignal(pending, signal);
}

/** Find session file with caching to avoid double scans per refresh cycle */
async function findCodexSessionFileCached(
  workspacePath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const cached = sessionFileCache.get(workspacePath);
  if (cached && Date.now() < cached.expiry) {
    return cached.path;
  }

  let pending = sessionFileLookups.get(workspacePath);
  if (!pending) {
    pending = findCodexSessionFile(workspacePath)
      .then((result) => {
        sessionFileCache.set(workspacePath, {
          path: result,
          expiry: Date.now() + SESSION_FILE_CACHE_TTL_MS,
        });
        return result;
      })
      .finally(() => {
        sessionFileLookups.delete(workspacePath);
      });
    sessionFileLookups.set(workspacePath, pending);
  }

  return awaitWithSignal(pending, signal);
}

function createCodexAgent(): Agent {
  /** Cached resolved binary path (populated by init or first getLaunchCommand) */
  let resolvedBinary: string | null = null;
  /** Guard against concurrent resolveCodexBinary() calls */
  let resolvingBinary: Promise<string> | null = null;

  return {
    name: "codex",
    processName: "codex",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const binary = resolvedBinary ?? "codex";
      const parts: string[] = [shellEscape(binary)];
      appendNoUpdateCheckFlag(parts);

      appendApprovalFlags(parts, config.permissions);
      appendModelFlags(parts, config.model);

      if (config.systemPromptFile) {
        // Current Codex CLI applies developer_instructions, but ignores the
        // older file-based override for prompt injection.
        parts.push("-c", `developer_instructions="$(cat ${shellEscape(config.systemPromptFile)})"`);
      } else if (config.systemPrompt) {
        // Codex accepts inline developer instructions via config override
        parts.push("-c", `developer_instructions=${shellEscape(config.systemPrompt)}`);
      }

      if (config.prompt) {
        // Use `--` to end option parsing so prompts starting with `-` aren't
        // misinterpreted as flags.
        parts.push("--", shellEscape(config.prompt));
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["AO_SESSION_ID"] = config.sessionId;
      // NOTE: AO_PROJECT_ID is the caller's responsibility (spawn.ts sets it)
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      // Prepend ~/.ao/bin to PATH so our gh/git wrappers intercept commands.
      // The wrappers strip this directory from PATH before calling the real
      // binary, so there's no infinite recursion.
      env["PATH"] = buildAgentPath(process.env["PATH"]);
      env["GH_PATH"] = PREFERRED_GH_PATH;
      // Disable Codex's version check/update prompt for non-interactive AO sessions.
      env["CODEX_DISABLE_UPDATE_CHECK"] = "1";

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lines = terminalOutput
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      while (lines.length > 1 && isLikelyCodexStatusFooter(lines[lines.length - 1] ?? "")) {
        lines.pop();
      }
      const lastLine = lines[lines.length - 1]?.trim() ?? "";

      // If Codex is showing its input prompt, it's idle. Codex commonly uses
      // a bare shell-like prompt or an input placeholder line beginning with
      // › / ❯ once a turn has completed and it is waiting for the next message.
      if (/^(?:[>$#]\s*|[›❯](?:\s.*)?)$/.test(lastLine)) return "idle";

      // Check last few lines for approval prompts
      const tail = lines.slice(-5).join("\n");
      if (/approval required/i.test(tail)) return "waiting_input";
      if (/\(y\)es.*\(n\)o/i.test(tail)) return "waiting_input";

      // Default to active — specific patterns (esc to interrupt, spinner
      // symbols) all map to "active" so no need to check them individually.
      return "active";
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

      // Check if process is running first
      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      // Use session file mtime as a proxy for activity. Codex continuously
      // appends to its rollout JSONL file while working, so a recently
      // modified file means the agent is active. When metadata worktree drifts
      // from the actual tmux runtime workspace, fall back to the workspace path
      // captured inside runtimeHandle.data.
      for (const workspacePath of getSessionWorkspaceCandidates(session)) {
        const sessionFile = await findCodexSessionFileCached(workspacePath);
        if (!sessionFile) continue;

        try {
          const s = await stat(sessionFile);
          const timestamp = s.mtime;
          const ageMs = Date.now() - s.mtimeMs;

          if (ageMs <= threshold) {
            // File was recently modified — agent is actively working
            return { state: "active", timestamp };
          }

          // File is stale — agent finished or is idle
          return { state: "idle", timestamp };
        } catch {
          continue;
        }
      }

      return null;
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      if (handle.runtimeName === "tmux" && handle.id) {
        try {
          const { stdout: ttyOut } = await execFileAsync(
            "tmux",
            ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
            { timeout: 30_000 },
          );
          const ttys = ttyOut
            .trim()
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean);
          if (ttys.length === 0) return false;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
            timeout: 30_000,
          });
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)codex(?:\s|$)/;
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            const args = cols.slice(2).join(" ");
            if (processRe.test(args)) {
              return true;
            }
          }
          return false;
        } catch (error) {
          if (isMissingTmuxSessionError(error)) {
            return false;
          }

          throw error;
        }
      }

      const rawPid = handle.data["pid"];
      const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          return true;
        } catch (err: unknown) {
          if (err instanceof Error && "code" in err && err.code === "EPERM") {
            return true;
          }
          return false;
        }
        return false;
      }

      return false;
    },

    async getSessionInfo(
      session: Session,
      options?: { signal?: AbortSignal },
    ): Promise<AgentSessionInfo | null> {
      for (const workspacePath of getSessionWorkspaceCandidates(session)) {
        options?.signal?.throwIfAborted();
        const sessionFile = await findCodexSessionFileCached(workspacePath, options?.signal);
        if (!sessionFile) continue;

        // Stream the file line-by-line to avoid loading potentially huge
        // rollout files (100 MB+) entirely into memory.
        const data = await getSessionDataCached(sessionFile, options?.signal);
        if (!data) continue;

        const agentSessionId = basename(sessionFile, ".jsonl");

        const cost: CostEstimate | undefined =
          data.inputTokens === 0 && data.outputTokens === 0
            ? undefined
            : {
                inputTokens: data.inputTokens,
                outputTokens: data.outputTokens,
                estimatedCostUsd:
                  (data.inputTokens / 1_000_000) * 2.5 + (data.outputTokens / 1_000_000) * 10.0,
              };

        return {
          summary: data.model ? `Codex session (${data.model})` : null,
          summaryIsFallback: true,
          agentSessionId,
          cost,
        };
      }

      return null;
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      let data: CodexSessionData | null = null;
      for (const workspacePath of getSessionWorkspaceCandidates(session)) {
        const sessionFile = await findCodexSessionFileCached(workspacePath);
        if (!sessionFile) continue;

        // Stream the file line-by-line to avoid loading potentially huge
        // rollout files (100 MB+) entirely into memory.
        data = await getSessionDataCached(sessionFile);
        if (data?.threadId) break;
      }
      if (!data?.threadId) return null;

      // Use Codex's native `resume` subcommand for proper conversation resume.
      // This restores the full thread state, not just a text prompt re-injection.
      // Flags are placed before the positional threadId for CLI parser compatibility.
      const binary = resolvedBinary ?? "codex";
      const parts: string[] = [shellEscape(binary), "resume"];
      appendNoUpdateCheckFlag(parts);

      appendApprovalFlags(parts, project.agentConfig?.permissions);
      const effectiveModel = (project.agentConfig?.model ?? data.model) as string | undefined;
      appendModelFlags(parts, effectiveModel ?? undefined);

      // Positional threadId goes last, after all flags
      parts.push(shellEscape(data.threadId));

      return parts.join(" ");
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await setupCodexWorkspace(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      // Resolve binary path on first launch (cached for subsequent calls).
      // Uses a promise guard to prevent concurrent calls from racing.
      if (!resolvedBinary) {
        if (!resolvingBinary) {
          resolvingBinary = resolveCodexBinary();
        }
        try {
          resolvedBinary = await resolvingBinary;
        } finally {
          resolvingBinary = null;
        }
      }
      if (!session.workspacePath) return;
      await setupCodexWorkspace(session.workspacePath);
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createCodexAgent();
}

/** @internal Clear the session file cache. Exported for testing only. */
export function _resetSessionFileCache(): void {
  sessionFileCache.clear();
  sessionFileLookups.clear();
  sessionWorkspaceIndex.clear();
  sessionWorkspaceReads.clear();
  rankedSessionFilesCache = null;
  rankedSessionFilesBuild = null;
  sessionDataCache.clear();
  sessionDataReads.clear();
}

export { CodexAppServerClient } from "./app-server-client.js";
export type {
  AppServerClientOptions,
  ThreadStartParams,
  TurnStartParams,
  NotificationHandler,
  ApprovalHandler,
  ApprovalDecision,
} from "./app-server-client.js";

export function detect(): boolean {
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;

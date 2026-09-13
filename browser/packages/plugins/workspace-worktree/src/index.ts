import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  lstatSync,
  symlinkSync,
  rmSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import type {
  PluginModule,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceInfo,
  ProjectConfig,
} from "@composio/ao-core";

/** Bound git operations without killing legitimate large checkouts too aggressively. */
const GIT_TIMEOUT = 5 * 60_000;
const DEFAULT_INITIALIZATION_STALE_MS = 15 * 60_000;

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "worktree",
  slot: "workspace" as const,
  description: "Workspace plugin: git worktrees",
  version: "0.1.0",
};

/** Run a git command in a given directory */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT });
  return stdout.trimEnd();
}

async function cleanupFailedWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    // Git requires --force twice to remove a worktree that is itself locked,
    // which is exactly the state left behind by an interrupted checkout.
    await git(repoPath, "worktree", "remove", "--force", "--force", worktreePath);
  } catch {
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  try {
    await git(repoPath, "worktree", "prune");
  } catch {
    // Best effort: preserve the original creation error.
  }
}

async function assertMaterializedWorktree(
  worktreePath: string,
  expectedBranch: string,
): Promise<void> {
  const actualBranch = await git(worktreePath, "symbolic-ref", "--quiet", "--short", "HEAD");
  if (actualBranch !== expectedBranch) {
    throw new Error(
      `worktree branch mismatch: expected "${expectedBranch}", observed "${actualBranch || "detached"}"`,
    );
  }

  const status = await git(worktreePath, "status", "--porcelain", "--untracked-files=no");
  if (status !== "") {
    const changedEntries = status.split("\n").filter(Boolean).length;
    throw new Error(
      `worktree checkout is not fully materialized: observed ${changedEntries} tracked change(s)`,
    );
  }

  const indexPath = await git(
    worktreePath,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  );
  const indexLockPath = await git(
    worktreePath,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index.lock",
  );
  if (!indexPath || !existsSync(indexPath) || (indexLockPath && existsSync(indexLockPath))) {
    throw new Error(
      "worktree checkout is not fully materialized: git index is unavailable or locked",
    );
  }
}

async function recoverIncompleteTarget(
  repoPath: string,
  worktreePath: string,
  expectedBranch: string,
): Promise<void> {
  if (!existsSync(worktreePath)) return;

  try {
    await assertMaterializedWorktree(worktreePath, expectedBranch);
  } catch {
    await cleanupFailedWorktree(repoPath, worktreePath);
    return;
  }

  throw new Error(`worktree target already contains a complete checkout: ${worktreePath}`);
}

function parseInitializingWorktrees(output: string, projectWorktreeDir: string): string[] {
  return output.split("\n\n").flatMap((block) => {
    const lines = block.split("\n");
    const worktreeLine = lines.find((line) => line.startsWith("worktree "));
    const path = worktreeLine?.slice("worktree ".length) ?? "";
    const isInitializing = lines.some((line) => line.trim() === "locked initializing");
    const isProjectWorktree =
      path.startsWith(`${projectWorktreeDir}/`) && path !== projectWorktreeDir;
    return isInitializing && isProjectWorktree ? [path] : [];
  });
}

async function recoverStaleInitializations(
  repoPath: string,
  projectWorktreeDir: string,
  staleAfterMs: number,
): Promise<void> {
  if (!existsSync(projectWorktreeDir)) return;

  let initializingPaths: string[];
  try {
    const output = await git(repoPath, "worktree", "list", "--porcelain");
    initializingPaths = parseInitializingWorktrees(output, projectWorktreeDir);
  } catch {
    return;
  }

  for (const path of initializingPaths) {
    try {
      const indexLockPath = await git(
        path,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index.lock",
      );
      const lockAgeMs = Date.now() - statSync(indexLockPath).mtimeMs;
      if (lockAgeMs < staleAfterMs) continue;
      await cleanupFailedWorktree(repoPath, path);
    } catch {
      // An unobservable lock is not safe to remove automatically.
    }
  }
}

/** Only allow safe characters in path segments to prevent directory traversal */
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9_-]+$/;

function assertSafePathSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Invalid ${label} "${value}": must match ${SAFE_PATH_SEGMENT}`);
  }
}

/** Expand ~ to home directory */
function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function create(config?: Record<string, unknown>): Workspace {
  const worktreeBaseDir = config?.worktreeDir
    ? expandPath(config.worktreeDir as string)
    : join(homedir(), ".worktrees");
  const initializationStaleMs =
    typeof config?.initializationStaleMs === "number" && config.initializationStaleMs > 0
      ? config.initializationStaleMs
      : DEFAULT_INITIALIZATION_STALE_MS;

  return {
    name: "worktree",

    async create(cfg: WorkspaceCreateConfig): Promise<WorkspaceInfo> {
      assertSafePathSegment(cfg.projectId, "projectId");
      assertSafePathSegment(cfg.sessionId, "sessionId");

      const repoPath = expandPath(cfg.project.path);
      const projectWorktreeDir = join(worktreeBaseDir, cfg.projectId);
      const worktreePath = join(projectWorktreeDir, cfg.sessionId);

      mkdirSync(projectWorktreeDir, { recursive: true });
      await recoverStaleInitializations(repoPath, projectWorktreeDir, initializationStaleMs);
      await recoverIncompleteTarget(repoPath, worktreePath, cfg.branch);

      // Fetch latest from remote
      try {
        await git(repoPath, "fetch", "origin", "--quiet");
      } catch {
        // Fetch may fail if offline — continue anyway
      }

      const baseRef = `origin/${cfg.project.defaultBranch}`;

      let creationError: unknown;

      // Create worktree with a new branch
      try {
        await git(repoPath, "worktree", "add", "-b", cfg.branch, worktreePath, baseRef);
      } catch (err: unknown) {
        // Only retry if the error is "branch already exists"
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("already exists")) {
          creationError = new Error(
            `Failed to create worktree for branch "${cfg.branch}": ${msg}`,
            { cause: err },
          );
        } else {
          // Branch already exists — create worktree and check it out
          try {
            await git(repoPath, "worktree", "add", worktreePath, baseRef);
            await git(worktreePath, "checkout", cfg.branch);
          } catch (checkoutErr: unknown) {
            const checkoutMsg =
              checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr);
            creationError = new Error(
              `Failed to checkout branch "${cfg.branch}" in worktree: ${checkoutMsg}`,
              { cause: checkoutErr },
            );
          }
        }
      }

      if (!creationError) {
        try {
          await assertMaterializedWorktree(worktreePath, cfg.branch);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          creationError = new Error(
            `Failed to create worktree for branch "${cfg.branch}": ${msg}`,
            { cause: err },
          );
        }
      }

      if (creationError) {
        await cleanupFailedWorktree(repoPath, worktreePath);
        throw creationError;
      }

      return {
        path: worktreePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async destroy(workspacePath: string): Promise<void> {
      try {
        const gitCommonDir = await git(
          workspacePath,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        );
        // git-common-dir returns something like /path/to/repo/.git
        const repoPath = resolve(gitCommonDir, "..");
        await git(repoPath, "worktree", "remove", "--force", workspacePath);

        // NOTE: We intentionally do NOT delete the branch here. The worktree
        // removal is sufficient. Auto-deleting branches risks removing
        // pre-existing local branches unrelated to this workspace (any branch
        // containing "/" would have been deleted). Stale branches can be
        // cleaned up separately via `git branch --merged` or similar.
      } catch {
        // If git commands fail, try to clean up the directory
        if (existsSync(workspacePath)) {
          rmSync(workspacePath, { recursive: true, force: true });
        }
      }
    },

    async list(projectId: string): Promise<WorkspaceInfo[]> {
      assertSafePathSegment(projectId, "projectId");
      const projectWorktreeDir = join(worktreeBaseDir, projectId);
      if (!existsSync(projectWorktreeDir)) return [];

      const entries = readdirSync(projectWorktreeDir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => join(projectWorktreeDir, e.name));

      if (dirs.length === 0) return [];

      // Use first valid worktree to get the list
      let worktreeListOutput = "";
      for (const dir of dirs) {
        try {
          worktreeListOutput = await git(dir, "worktree", "list", "--porcelain");
          break;
        } catch {
          continue;
        }
      }

      if (!worktreeListOutput) return [];

      // Parse porcelain output — only include worktrees within our project directory
      const infos: WorkspaceInfo[] = [];
      const blocks = worktreeListOutput.split("\n\n");

      for (const block of blocks) {
        const lines = block.trim().split("\n");
        let path = "";
        let branch = "";

        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            path = line.slice("worktree ".length);
          } else if (line.startsWith("branch ")) {
            // branch refs/heads/feat/INT-1234 → feat/INT-1234
            branch = line.slice("branch ".length).replace("refs/heads/", "");
          }
        }

        if (path && (path === projectWorktreeDir || path.startsWith(projectWorktreeDir + "/"))) {
          const sessionId = basename(path);
          infos.push({
            path,
            branch: branch || "detached",
            sessionId,
            projectId,
          });
        }
      }

      return infos;
    },

    async exists(workspacePath: string): Promise<boolean> {
      if (!existsSync(workspacePath)) return false;
      try {
        await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: workspacePath,
          timeout: GIT_TIMEOUT,
        });
        return true;
      } catch {
        return false;
      }
    },

    async restore(cfg: WorkspaceCreateConfig, workspacePath: string): Promise<WorkspaceInfo> {
      const repoPath = expandPath(cfg.project.path);

      // Prune stale worktree entries
      try {
        await git(repoPath, "worktree", "prune");
      } catch {
        // Best effort
      }

      // Fetch latest
      try {
        await git(repoPath, "fetch", "origin", "--quiet");
      } catch {
        // May fail if offline
      }

      const attempts: string[][] = [
        ["worktree", "add", workspacePath, cfg.branch],
        ["worktree", "add", "-b", cfg.branch, workspacePath, `origin/${cfg.branch}`],
        ["worktree", "add", "-b", cfg.branch, workspacePath, `origin/${cfg.project.defaultBranch}`],
      ];
      let lastError: unknown;

      for (const args of attempts) {
        try {
          await git(repoPath, ...args);
          await assertMaterializedWorktree(workspacePath, cfg.branch);
          return {
            path: workspacePath,
            branch: cfg.branch,
            sessionId: cfg.sessionId,
            projectId: cfg.projectId,
          };
        } catch (err) {
          lastError = err;
          await cleanupFailedWorktree(repoPath, workspacePath);
        }
      }

      const message = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`Failed to restore worktree for branch "${cfg.branch}": ${message}`, {
        cause: lastError,
      });
    },

    async postCreate(info: WorkspaceInfo, project: ProjectConfig): Promise<void> {
      const repoPath = expandPath(project.path);

      // Symlink shared resources
      if (project.symlinks) {
        for (const symlinkPath of project.symlinks) {
          // Guard against absolute paths and directory traversal
          if (symlinkPath.startsWith("/") || symlinkPath.includes("..")) {
            throw new Error(
              `Invalid symlink path "${symlinkPath}": must be a relative path without ".." segments`,
            );
          }

          const sourcePath = join(repoPath, symlinkPath);
          const targetPath = resolve(info.path, symlinkPath);

          // Verify resolved target is still within the workspace
          if (!targetPath.startsWith(info.path + "/") && targetPath !== info.path) {
            throw new Error(
              `Symlink target "${symlinkPath}" resolves outside workspace: ${targetPath}`,
            );
          }

          if (!existsSync(sourcePath)) continue;

          // Remove existing target if it exists
          try {
            const stat = lstatSync(targetPath);
            if (stat.isSymbolicLink() || stat.isFile() || stat.isDirectory()) {
              rmSync(targetPath, { recursive: true, force: true });
            }
          } catch {
            // Target doesn't exist — that's fine
          }

          // Ensure parent directory exists for nested symlink targets
          mkdirSync(dirname(targetPath), { recursive: true });
          symlinkSync(sourcePath, targetPath);
        }
      }

      // Run postCreate hooks
      // NOTE: commands run with full shell privileges — they come from trusted YAML config
      if (project.postCreate) {
        for (const command of project.postCreate) {
          await execFileAsync("sh", ["-c", command], { cwd: info.path });
        }
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Workspace>;

/**
 * Lifecycle Manager — state machine + polling loop + reaction engine.
 *
 * Periodically polls all sessions and:
 * 1. Detects state transitions (spawning → working → pr_open → etc.)
 * 2. Emits events on transitions
 * 3. Triggers reactions (auto-handle CI failures, review comments, etc.)
 * 4. Escalates to human notification when auto-handling fails
 *
 * Reference: scripts/claude-session-status, scripts/claude-review-check
 */

import { randomUUID } from "node:crypto";
import {
  SESSION_STATUS,
  TERMINAL_STATUSES,
  PR_STATE,
  CI_STATUS,
  type LifecycleManager,
  type SessionManager,
  type SessionId,
  type SessionStatus,
  type EventType,
  type OrchestratorEvent,
  type OrchestratorConfig,
  type ReactionConfig,
  type ReactionResult,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type SCM,
  type Notifier,
  type Session,
  type ActivityState,
  type EventPriority,
  type ProjectConfig,
  type MergeReadiness,
  isOrchestratorSession,
} from "./types.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";
import { createCorrelationId, createProjectObserver } from "./observability.js";
import { resolveAgentSelection, resolveSessionRole } from "./agent-selection.js";
import { generateOrchestratorPrompt } from "./orchestrator-prompt.js";

/** Parse a duration string like "10m", "30s", "1h" to milliseconds. */
function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(s|m|h)$/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return 0;
  }
}

/** Infer a reasonable priority from event type. */
function inferPriority(type: EventType): EventPriority {
  if (type.includes("stuck") || type.includes("needs_input") || type.includes("errored")) {
    return "urgent";
  }
  if (type.startsWith("summary.")) {
    return "info";
  }
  if (
    type.includes("approved") ||
    type.includes("ready") ||
    type.includes("merged") ||
    type.includes("completed")
  ) {
    return "action";
  }
  if (type.includes("fail") || type.includes("changes_requested") || type.includes("conflicts")) {
    return "warning";
  }
  return "info";
}

function getPRDetectionSession(session: Session): Session {
  const taskBranch = session.metadata["taskBranch"]?.trim();
  if (!taskBranch || taskBranch === session.branch) {
    return session;
  }

  return {
    ...session,
    branch: taskBranch,
  };
}

const PASSIVE_MERGE_BLOCKERS = new Set([
  "Branch is behind base branch",
  "Merge is blocked by branch protection",
]);

/** Create an OrchestratorEvent with defaults filled in. */
function createEvent(
  type: EventType,
  opts: {
    sessionId: SessionId;
    projectId: string;
    message: string;
    priority?: EventPriority;
    data?: Record<string, unknown>;
  },
): OrchestratorEvent {
  return {
    id: randomUUID(),
    type,
    priority: opts.priority ?? inferPriority(type),
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    timestamp: new Date(),
    message: opts.message,
    data: opts.data ?? {},
  };
}

/** Determine which event type corresponds to a status transition. */
function statusToEventType(_from: SessionStatus | undefined, to: SessionStatus): EventType | null {
  switch (to) {
    case "working":
      return "session.working";
    case "idle":
      return "session.idle";
    case "pr_open":
      return "pr.created";
    case "ci_failed":
      return "ci.failing";
    case "review_pending":
      return "review.pending";
    case "changes_requested":
      return "review.changes_requested";
    case "approved":
      return "review.approved";
    case "mergeable":
      return "merge.ready";
    case "merged":
      return "merge.completed";
    case "needs_input":
      return "session.needs_input";
    case "stuck":
      return "session.stuck";
    case "errored":
      return "session.errored";
    case "killed":
      return "session.killed";
    default:
      return null;
  }
}

/** Map event type to reaction config key. */
function eventToReactionKey(eventType: EventType): string | null {
  switch (eventType) {
    case "ci.failing":
      return "ci-failed";
    case "review.changes_requested":
      return "changes-requested";
    case "automated_review.found":
      return "bugbot-comments";
    case "merge.conflicts":
      return "merge-conflicts";
    case "merge.ready":
      return "approved-and-green";
    case "session.stuck":
      return "agent-stuck";
    case "session.needs_input":
      return "agent-needs-input";
    case "session.killed":
      return "agent-exited";
    case "session.idle":
      return "agent-idle";
    case "summary.all_complete":
      return "all-complete";
    default:
      return null;
  }
}

function transitionLogLevel(status: SessionStatus): "info" | "warn" | "error" {
  const eventType = statusToEventType(undefined, status);
  if (!eventType) {
    return "info";
  }
  const priority = inferPriority(eventType);
  if (priority === "urgent") {
    return "error";
  }
  if (priority === "warning") {
    return "warn";
  }
  return "info";
}

export interface LifecycleManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
  /** When set, only poll sessions belonging to this project. */
  projectId?: string;
}

/** Track attempt counts for reactions per session. */
interface ReactionTracker {
  attempts: number;
  firstTriggered: Date;
  lastTriggered: Date;
}

/** Create a LifecycleManager instance. */
export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  const { config, registry, sessionManager, projectId: scopedProjectId } = deps;
  const observer = createProjectObserver(config, "lifecycle-manager");

  const states = new Map<SessionId, SessionStatus>();
  const consecutiveIdleEvidence = new Map<SessionId, number>();
  const reactionTrackers = new Map<string, ReactionTracker>(); // "sessionId:reactionKey"
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // re-entrancy guard

  /** Check if idle time exceeds the agent-stuck threshold. */
  function isIdleBeyondThreshold(session: Session, idleTimestamp: Date): boolean {
    if (isOrchestratorSession(session)) return false;
    const stuckReaction = getReactionConfigForSession(session, "agent-stuck");
    const thresholdStr = stuckReaction?.threshold;
    if (typeof thresholdStr !== "string") return false;
    const stuckThresholdMs = parseDuration(thresholdStr);
    if (stuckThresholdMs <= 0) return false;
    const idleMs = Date.now() - idleTimestamp.getTime();
    return idleMs > stuckThresholdMs;
  }

  function hasOnlyPassiveMergeBlockers(mergeReady: MergeReadiness): boolean {
    return (
      mergeReady.blockers.length > 0 &&
      mergeReady.blockers.every((blocker) => PASSIVE_MERGE_BLOCKERS.has(blocker))
    );
  }

  function parseRepeatInterval(value: number | string | undefined): number {
    if (typeof value === "number") {
      return Number.isFinite(value) && value > 0 ? value : 0;
    }
    if (typeof value === "string") {
      return parseDuration(value);
    }
    return 0;
  }

  function getTrackedStatus(session: Session): SessionStatus {
    return (
      states.get(session.id) ??
      ((session.metadata?.["status"] as SessionStatus | undefined) || session.status)
    );
  }

  async function hasActionableNonOrchestratorSessions(
    projectId: string,
    excludeSessionId?: string,
  ): Promise<boolean> {
    const projectSessions = await sessionManager.list(projectId);
    return projectSessions.some((candidate) => {
      if (candidate.id === excludeSessionId) return false;
      if (isOrchestratorSession(candidate)) return false;
      return !TERMINAL_STATUSES.has(getTrackedStatus(candidate));
    });
  }

  /** Determine current status for a session by polling plugins. */
  async function determineStatus(session: Session): Promise<SessionStatus> {
    const project = config.projects[session.projectId];
    if (!project) return session.status;

    // Workspace and runtime creation are a transaction. A durable spawning
    // record without a persisted runtime handle is still in the control-plane
    // creation phase and must not be promoted to working or evaluated as stuck.
    if (session.status === "spawning" && !session.metadata["runtimeHandle"]) {
      return "spawning";
    }

    const agentName = resolveAgentSelection({
      role: resolveSessionRole(session.id, session.metadata),
      project,
      defaults: config.defaults,
      persistedAgent: session.metadata["agent"],
    }).agentName;
    const agent = registry.get<Agent>("agent", agentName);
    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;

    // Track activity state across steps so stuck detection can run after PR checks
    let detectedIdleTimestamp: Date | null = null;
    let observedActivity: ActivityState | null = null;

    // 1. Check if runtime is alive
    if (session.runtimeHandle) {
      const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
      if (runtime) {
        const alive = await runtime.isAlive(session.runtimeHandle).catch(() => true);
        if (!alive) return "killed";
      }
    }

    // 2. Check agent activity — prefer JSONL-based detection (runtime-agnostic)
    if (agent && session.runtimeHandle) {
      try {
        // Try JSONL-based activity detection first (reads agent's session files directly)
        const activityState = await agent.getActivityState(session, config.readyThresholdMs);
        if (activityState) {
          observedActivity = activityState.state;
          if (activityState.state === "waiting_input") return "needs_input";
          if (activityState.state === "exited") return "killed";

          if (
            (activityState.state === "idle" || activityState.state === "blocked") &&
            activityState.timestamp
          ) {
            detectedIdleTimestamp = activityState.timestamp;
          }

          // JSONL mtime is coarse for Codex-like TUIs: a turn can finish and
          // show a prompt while the session file still looks "recently active".
          // Refine with terminal output when available so prompt-visible agents
          // are treated as idle immediately instead of waiting for the file to age.
          if (
            session.runtimeHandle &&
            (activityState.state === "active" || activityState.state === "ready")
          ) {
            const runtime = registry.get<Runtime>(
              "runtime",
              project.runtime ?? config.defaults.runtime,
            );
            const terminalOutput = runtime
              ? await runtime.getOutput(session.runtimeHandle, 10)
              : "";
            if (terminalOutput) {
              const refinedActivity = agent.detectActivity(terminalOutput);
              if (refinedActivity === "waiting_input") return "needs_input";
              if (refinedActivity === "idle") {
                observedActivity = "idle";
                detectedIdleTimestamp = new Date();
              }
            }
          }

          // A stale Codex JSONL mtime is not sufficient evidence of an idle
          // worker: long-running tool calls can legitimately produce no JSONL
          // writes for longer than the stuck threshold. Corroborate stale file
          // activity with the visible terminal state before retaining idle
          // evidence. Probe failure is unknown, never stuck.
          if (
            agentName === "codex" &&
            (activityState.state === "idle" || activityState.state === "blocked")
          ) {
            const runtime = registry.get<Runtime>(
              "runtime",
              project.runtime ?? config.defaults.runtime,
            );
            const terminalOutput = runtime
              ? await runtime.getOutput(session.runtimeHandle, 20)
              : "";
            if (!terminalOutput) {
              observedActivity = null;
              detectedIdleTimestamp = null;
            } else {
              const refinedActivity = agent.detectActivity(terminalOutput);
              if (refinedActivity === "waiting_input") return "needs_input";
              if (refinedActivity === "active" || refinedActivity === "ready") {
                observedActivity = refinedActivity;
                detectedIdleTimestamp = null;
              }
            }
          }

          // active/ready/idle (below threshold)/blocked (below threshold) —
          // proceed to PR checks below
        } else {
          // getActivityState returned null — fall back to terminal output parsing
          const runtime = registry.get<Runtime>(
            "runtime",
            project.runtime ?? config.defaults.runtime,
          );
          const terminalOutput = runtime ? await runtime.getOutput(session.runtimeHandle, 10) : "";
          if (terminalOutput) {
            const activity = agent.detectActivity(terminalOutput);
            observedActivity = activity;
            if (activity === "waiting_input") return "needs_input";

            const processAlive = await agent.isProcessRunning(session.runtimeHandle);
            if (!processAlive) return "killed";
          }
        }
      } catch {
        // On probe failure, preserve current stuck/needs_input state rather
        // than letting the fallback at the bottom coerce them to "working"
        if (
          session.status === SESSION_STATUS.STUCK ||
          session.status === SESSION_STATUS.NEEDS_INPUT
        ) {
          return session.status;
        }
      }
    }

    if (detectedIdleTimestamp && (observedActivity === "idle" || observedActivity === "blocked")) {
      consecutiveIdleEvidence.set(session.id, (consecutiveIdleEvidence.get(session.id) ?? 0) + 1);
    } else {
      consecutiveIdleEvidence.delete(session.id);
    }
    const idleEvidenceConfirmed = (consecutiveIdleEvidence.get(session.id) ?? 0) >= 2;

    // 3. Auto-detect PR by branch if metadata.pr is missing.
    //    This is critical for agents without auto-hook systems (Codex, Aider,
    //    OpenCode) that can't reliably write pr=<url> to metadata on their own.
    //    Skip orchestrator sessions — they sit on the base branch (e.g. master)
    //    and should never own a PR.
    const prDetectionSession = getPRDetectionSession(session);
    if (
      !session.pr &&
      scm &&
      prDetectionSession.branch &&
      session.metadata["prAutoDetect"] !== "off" &&
      session.metadata["role"] !== "orchestrator" &&
      !session.id.endsWith("-orchestrator")
    ) {
      try {
        const detectedPR = await scm.detectPR(prDetectionSession, project);
        if (detectedPR) {
          session.pr = detectedPR;
          // Persist PR URL so subsequent polls don't need to re-query.
          // Don't write status here — step 4 below will determine the
          // correct status (merged, ci_failed, etc.) on this same cycle.
          const sessionsDir = getSessionsDir(config.configPath, project.path);
          updateMetadata(sessionsDir, session.id, { pr: detectedPR.url });
        }
      } catch {
        // SCM detection failed — will retry next poll
      }
    }

    // 4. Check PR state if PR exists
    if (session.pr && scm) {
      try {
        const prState = await scm.getPRState(session.pr);
        if (prState === PR_STATE.MERGED) return "merged";
        if (prState === PR_STATE.CLOSED) return "killed";

        // Check CI
        const ciStatus = await scm.getCISummary(session.pr);
        if (ciStatus === CI_STATUS.FAILING) return "ci_failed";

        // Check reviews
        const reviewDecision = await scm.getReviewDecision(session.pr);
        if (reviewDecision === "changes_requested") return "changes_requested";
        if (reviewDecision === "approved" || reviewDecision === "none") {
          // Check merge readiness — treat "none" (no reviewers required)
          // the same as "approved" so CI-green PRs reach "mergeable" status
          // and fire the merge.ready event / approved-and-green reaction.
          const mergeReady = await scm.getMergeability(session.pr);
          const passiveMergeBlockers = hasOnlyPassiveMergeBlockers(mergeReady);
          const automatedComments =
            mergeReady.mergeable || passiveMergeBlockers
              ? await scm.getAutomatedComments(session.pr)
              : null;

          if (mergeReady.mergeable) {
            // Automated review backlog is a merge blocker for lifecycle-driven
            // automation even when GitHub reports the PR as mergeable.
            if ((automatedComments?.length ?? 0) === 0) return "mergeable";
          }
          if (passiveMergeBlockers && (automatedComments?.length ?? 0) === 0) {
            return reviewDecision === "approved" ? "approved" : "pr_open";
          }
          if (reviewDecision === "approved") return "approved";
        }
        if (reviewDecision === "pending") return "review_pending";

        // 4b. Post-PR stuck detection: agent has a PR open but is idle beyond
        // threshold. This catches the case where step 2's stuck check was
        // bypassed (getActivityState returned null) or the idle timestamp
        // wasn't available during step 2 but the session has been at pr_open
        // for a long time. Without this, sessions get stuck at "pr_open" forever.
        if (
          idleEvidenceConfirmed &&
          detectedIdleTimestamp &&
          isIdleBeyondThreshold(session, detectedIdleTimestamp)
        ) {
          return "stuck";
        }

        return "pr_open";
      } catch {
        // SCM check failed — keep current status
      }
    }

    // 5. Post-all stuck detection: if we detected idle in step 2 but had no PR,
    // still check stuck threshold. This handles agents that finish without creating a PR.
    if (
      idleEvidenceConfirmed &&
      detectedIdleTimestamp &&
      isIdleBeyondThreshold(session, detectedIdleTimestamp)
    ) {
      return "stuck";
    }

    if (observedActivity === "idle") {
      return "idle";
    }

    // 6. Default: if agent is active/ready, it's working
    if (observedActivity === "active" || observedActivity === "ready") {
      return "working";
    }

    if (
      session.status === "spawning" ||
      session.status === SESSION_STATUS.STUCK ||
      session.status === SESSION_STATUS.NEEDS_INPUT ||
      session.status === SESSION_STATUS.IDLE
    ) {
      return "working";
    }
    return session.status;
  }

  /** Execute a reaction for a session. */
  async function executeReaction(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
    options?: {
      countAttempt?: boolean;
    },
  ): Promise<ReactionResult> {
    const trackerKey = `${sessionId}:${reactionKey}`;
    let tracker = reactionTrackers.get(trackerKey);
    const now = new Date();
    const countAttempt = options?.countAttempt ?? true;

    if (!tracker) {
      tracker = { attempts: 0, firstTriggered: now, lastTriggered: now };
      reactionTrackers.set(trackerKey, tracker);
    }

    tracker.lastTriggered = now;

    // Increment attempts before checking escalation
    if (countAttempt) {
      tracker.attempts++;
    }

    // Check if we should escalate
    const maxRetries = reactionConfig.retries ?? Infinity;
    const escalateAfter = reactionConfig.escalateAfter;
    let shouldEscalate = false;

    if (countAttempt && tracker.attempts > maxRetries) {
      shouldEscalate = true;
    }

    if (typeof escalateAfter === "string") {
      const durationMs = parseDuration(escalateAfter);
      if (durationMs > 0 && now.getTime() - tracker.firstTriggered.getTime() > durationMs) {
        shouldEscalate = true;
      }
    }

    if (typeof escalateAfter === "number" && countAttempt && tracker.attempts > escalateAfter) {
      shouldEscalate = true;
    }

    const escalateReaction = async (reason: string): Promise<ReactionResult> => {
      if (reactionConfig.escalateTo === "orchestrator") {
        const routed = await routeReactionToOrchestrator({
          sessionId,
          projectId,
          reactionKey,
          reactionConfig,
          escalationReason: reason,
        });
        if (routed) {
          return routed;
        }
      }

      const event = createEvent("reaction.escalated", {
        sessionId,
        projectId,
        message: `Reaction '${reactionKey}' escalated after ${tracker?.attempts ?? 0} attempts`,
        data: { reactionKey, attempts: tracker?.attempts ?? 0, reason },
      });
      await notifyHuman(event, reactionConfig.priority ?? "urgent");
      return {
        reactionType: reactionKey,
        success: true,
        action: "escalated",
        escalated: true,
      };
    };

    if (shouldEscalate) {
      return escalateReaction(
        `Reaction '${reactionKey}' exceeded its retry or escalation threshold.`,
      );
    }

    // Execute the reaction action
    const action = reactionConfig.action ?? "notify";

    switch (action) {
      case "send-to-agent": {
        if (reactionConfig.message) {
          try {
            await sessionManager.send(sessionId, reactionConfig.message, {
              requireConfirmation: true,
            });

            return {
              reactionType: reactionKey,
              success: true,
              action: "send-to-agent",
              message: reactionConfig.message,
              escalated: false,
            };
          } catch (err) {
            if (!countAttempt) {
              tracker.attempts++;
            }
            if (tracker.attempts > maxRetries) {
              return escalateReaction(
                `Reaction '${reactionKey}' exceeded its retry or escalation threshold.`,
              );
            }

            if (reactionConfig.escalateTo === "orchestrator") {
              const routed = await routeReactionToOrchestrator({
                sessionId,
                projectId,
                reactionKey,
                reactionConfig,
                failureReason: err instanceof Error ? err.message : String(err),
              });
              if (routed) {
                return routed;
              }
            }

            // Send failed — allow retry on next poll cycle when we are not
            // immediately handing the problem to the orchestrator.
            return {
              reactionType: reactionKey,
              success: false,
              action: "send-to-agent",
              escalated: false,
            };
          }
        }
        break;
      }

      case "send-to-orchestrator": {
        const routed = await routeReactionToOrchestrator({
          sessionId,
          projectId,
          reactionKey,
          reactionConfig,
        });
        if (routed) {
          return routed;
        }

        const event = createEvent("reaction.escalated", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' could not be routed to the orchestrator`,
          data: { reactionKey },
        });
        await notifyHuman(event, reactionConfig.priority ?? "urgent");
        return {
          reactionType: reactionKey,
          success: true,
          action: "notify",
          escalated: true,
        };
      }

      case "notify": {
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' triggered notification`,
          data: { reactionKey },
        });
        await notifyHuman(event, reactionConfig.priority ?? "info");
        return {
          reactionType: reactionKey,
          success: true,
          action: "notify",
          escalated: false,
        };
      }

      case "auto-merge": {
        const session = await sessionManager.get(sessionId);
        if (!session?.pr) {
          return {
            reactionType: reactionKey,
            success: false,
            action: "auto-merge",
            escalated: false,
          };
        }

        const project = config.projects[projectId];
        const scm = project?.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
        if (!scm) {
          return {
            reactionType: reactionKey,
            success: false,
            action: "auto-merge",
            escalated: false,
          };
        }

        try {
          await scm.mergePR(session.pr);
          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' triggered auto-merge`,
            data: { reactionKey, pr: session.pr.url },
          });
          await notifyHuman(event, "action");
          return {
            reactionType: reactionKey,
            success: true,
            action: "auto-merge",
            escalated: false,
          };
        } catch {
          return {
            reactionType: reactionKey,
            success: false,
            action: "auto-merge",
            escalated: false,
          };
        }
      }
    }

    return {
      reactionType: reactionKey,
      success: false,
      action,
      escalated: false,
    };
  }

  function clearReactionTracker(sessionId: SessionId, reactionKey: string): void {
    reactionTrackers.delete(`${sessionId}:${reactionKey}`);
  }

  function getReactionConfigForProject(
    projectId: string,
    reactionKey: string,
  ): ReactionConfig | null {
    const project = config.projects[projectId];
    const globalReaction = config.reactions[reactionKey];
    const projectReaction = project?.reactions?.[reactionKey];
    const reactionConfig = projectReaction
      ? { ...globalReaction, ...projectReaction }
      : globalReaction;
    return reactionConfig ? (reactionConfig as ReactionConfig) : null;
  }

  function getReactionConfigForSession(
    session: Session,
    reactionKey: string,
  ): ReactionConfig | null {
    return getReactionConfigForProject(session.projectId, reactionKey);
  }

  function getProjectConfig(projectId: string): ProjectConfig | null {
    return config.projects[projectId] ?? null;
  }

  function getOrchestratorSessionId(projectId: string): string | null {
    const project = getProjectConfig(projectId);
    return project ? `${project.sessionPrefix}-orchestrator` : null;
  }

  async function ensureOrchestratorSession(projectId: string): Promise<Session | null> {
    const project = getProjectConfig(projectId);
    if (!project) return null;

    const orchestratorSessionId = `${project.sessionPrefix}-orchestrator`;
    const existing = await sessionManager.get(orchestratorSessionId);
    if (existing) {
      return existing;
    }

    return sessionManager.spawnOrchestrator({
      projectId,
      systemPrompt: generateOrchestratorPrompt({ config, projectId, project }),
    });
  }

  function buildOrchestratorReactionMessage(opts: {
    projectId: string;
    sourceSessionId: SessionId;
    sourceSession: Session | null;
    reactionKey: string;
    reactionConfig: ReactionConfig;
    failureReason?: string;
    escalationReason?: string;
  }): string {
    const { projectId, sourceSessionId, sourceSession, reactionKey, reactionConfig } = opts;
    const lines = [
      "A lifecycle reaction needs orchestrator attention.",
      `Project: ${projectId}`,
      `Session: ${sourceSessionId}`,
      `Trigger: ${reactionKey}`,
    ];

    if (sourceSession?.status) {
      lines.push(`Status: ${sourceSession.status}`);
    }
    if (sourceSession?.branch) {
      lines.push(`Branch: ${sourceSession.branch}`);
    }
    if (sourceSession?.issueId) {
      lines.push(`Issue: ${sourceSession.issueId}`);
    }
    if (sourceSession?.pr?.url) {
      lines.push(`PR: ${sourceSession.pr.url}`);
    }
    if (opts.failureReason) {
      lines.push(`Failure: ${opts.failureReason}`);
    }
    if (opts.escalationReason) {
      lines.push(`Escalation: ${opts.escalationReason}`);
    }
    if (reactionConfig.message) {
      lines.push(`Original instruction: ${reactionConfig.message}`);
    }

    lines.push("");
    lines.push(
      "Inspect the current state and decide how to keep delivery moving without handing routine coordination back to the human.",
    );
    lines.push(
      "Choose whether to restore the existing worker, continue with it, or spawn/redirect a successor worker and claim the PR if ownership is missing.",
    );
    lines.push(
      "Escalate to a human only if the next step requires product judgment, credentials, or environment intervention that the system cannot resolve on its own.",
    );

    return lines.join("\n");
  }

  async function routeReactionToOrchestrator(opts: {
    sessionId: SessionId;
    projectId: string;
    reactionKey: string;
    reactionConfig: ReactionConfig;
    failureReason?: string;
    escalationReason?: string;
  }): Promise<ReactionResult | null> {
    const orchestratorSessionId = getOrchestratorSessionId(opts.projectId);
    if (!orchestratorSessionId) return null;

    try {
      const sourceSession =
        opts.sessionId === "system"
          ? null
          : await sessionManager.get(opts.sessionId).catch(() => null);
      if (sourceSession && isOrchestratorSession(sourceSession)) {
        return null;
      }

      const orchestrator = await ensureOrchestratorSession(opts.projectId);
      if (!orchestrator || orchestrator.id === opts.sessionId) {
        return null;
      }

      const message = buildOrchestratorReactionMessage({
        projectId: opts.projectId,
        sourceSessionId: opts.sessionId,
        sourceSession,
        reactionKey: opts.reactionKey,
        reactionConfig: opts.reactionConfig,
        failureReason: opts.failureReason,
        escalationReason: opts.escalationReason,
      });

      await sessionManager.send(orchestrator.id, message, {
        requireConfirmation: true,
      });
      return {
        reactionType: opts.reactionKey,
        success: true,
        action: "send-to-orchestrator",
        message,
        escalated: true,
      };
    } catch {
      return null;
    }
  }

  function updateSessionMetadata(session: Session, updates: Partial<Record<string, string>>): void {
    const project = config.projects[session.projectId];
    if (!project) return;

    const sessionsDir = getSessionsDir(config.configPath, project.path);
    updateMetadata(sessionsDir, session.id, updates);

    const cleaned = Object.fromEntries(
      Object.entries(session.metadata).filter(([key]) => {
        const update = updates[key];
        return update === undefined || update !== "";
      }),
    );
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === "") continue;
      cleaned[key] = value;
    }
    session.metadata = cleaned;
  }

  function makeFingerprint(ids: string[]): string {
    return [...ids].sort().join(",");
  }

  async function maybeDispatchReviewBacklog(
    session: Session,
    oldStatus: SessionStatus,
    newStatus: SessionStatus,
    transitionReaction?: { key: string; result: ReactionResult | null },
  ): Promise<void> {
    const project = config.projects[session.projectId];
    if (!project || !session.pr) return;

    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
    if (!scm) return;

    const humanReactionKey = "changes-requested";
    const automatedReactionKey = "bugbot-comments";

    if (newStatus === "merged" || newStatus === "killed") {
      clearReactionTracker(session.id, humanReactionKey);
      clearReactionTracker(session.id, automatedReactionKey);
      updateSessionMetadata(session, {
        lastPendingReviewFingerprint: "",
        lastPendingReviewDispatchHash: "",
        lastPendingReviewDispatchAt: "",
        lastAutomatedReviewFingerprint: "",
        lastAutomatedReviewDispatchHash: "",
        lastAutomatedReviewDispatchAt: "",
      });
      return;
    }

    const [pendingResult, automatedResult] = await Promise.allSettled([
      scm.getPendingComments(session.pr),
      scm.getAutomatedComments(session.pr),
    ]);

    // null means "failed to fetch" — preserve existing metadata.
    // [] means "confirmed no comments" — safe to clear.
    const pendingComments =
      pendingResult.status === "fulfilled" && Array.isArray(pendingResult.value)
        ? pendingResult.value
        : null;
    const automatedComments =
      automatedResult.status === "fulfilled" && Array.isArray(automatedResult.value)
        ? automatedResult.value
        : null;

    // --- Pending (human) review comments ---
    // null = SCM fetch failed; skip processing to preserve existing metadata.
    if (pendingComments !== null) {
      const pendingFingerprint = makeFingerprint(pendingComments.map((comment) => comment.id));
      const lastPendingFingerprint = session.metadata["lastPendingReviewFingerprint"] ?? "";
      const lastPendingDispatchHash = session.metadata["lastPendingReviewDispatchHash"] ?? "";

      if (
        pendingFingerprint !== lastPendingFingerprint &&
        transitionReaction?.key !== humanReactionKey
      ) {
        clearReactionTracker(session.id, humanReactionKey);
      }
      if (pendingFingerprint !== lastPendingFingerprint) {
        updateSessionMetadata(session, {
          lastPendingReviewFingerprint: pendingFingerprint,
        });
      }

      if (!pendingFingerprint) {
        clearReactionTracker(session.id, humanReactionKey);
        updateSessionMetadata(session, {
          lastPendingReviewFingerprint: "",
          lastPendingReviewDispatchHash: "",
          lastPendingReviewDispatchAt: "",
        });
      } else if (
        transitionReaction?.key === humanReactionKey &&
        transitionReaction.result?.success
      ) {
        if (lastPendingDispatchHash !== pendingFingerprint) {
          updateSessionMetadata(session, {
            lastPendingReviewDispatchHash: pendingFingerprint,
            lastPendingReviewDispatchAt: new Date().toISOString(),
          });
        }
      } else if (
        !(oldStatus !== newStatus && newStatus === "changes_requested") &&
        pendingFingerprint !== lastPendingDispatchHash
      ) {
        const reactionConfig = getReactionConfigForSession(session, humanReactionKey);
        if (
          reactionConfig &&
          reactionConfig.action &&
          (reactionConfig.auto !== false || reactionConfig.action === "notify")
        ) {
          const result = await executeReaction(
            session.id,
            session.projectId,
            humanReactionKey,
            reactionConfig,
          );
          if (result.success) {
            updateSessionMetadata(session, {
              lastPendingReviewDispatchHash: pendingFingerprint,
              lastPendingReviewDispatchAt: new Date().toISOString(),
            });
          }
        }
      }
    }

    // --- Automated (bot) review comments ---
    if (automatedComments !== null) {
      const automatedFingerprint = makeFingerprint(automatedComments.map((comment) => comment.id));
      const lastAutomatedFingerprint = session.metadata["lastAutomatedReviewFingerprint"] ?? "";
      const lastAutomatedDispatchHash = session.metadata["lastAutomatedReviewDispatchHash"] ?? "";

      if (automatedFingerprint !== lastAutomatedFingerprint) {
        clearReactionTracker(session.id, automatedReactionKey);
        updateSessionMetadata(session, {
          lastAutomatedReviewFingerprint: automatedFingerprint,
        });
      }

      if (!automatedFingerprint) {
        clearReactionTracker(session.id, automatedReactionKey);
        updateSessionMetadata(session, {
          lastAutomatedReviewFingerprint: "",
          lastAutomatedReviewDispatchHash: "",
          lastAutomatedReviewDispatchAt: "",
        });
      } else if (automatedFingerprint !== lastAutomatedDispatchHash) {
        const reactionConfig = getReactionConfigForSession(session, automatedReactionKey);
        if (
          reactionConfig &&
          reactionConfig.action &&
          (reactionConfig.auto !== false || reactionConfig.action === "notify")
        ) {
          const result = await executeReaction(
            session.id,
            session.projectId,
            automatedReactionKey,
            reactionConfig,
          );
          if (result.success) {
            updateSessionMetadata(session, {
              lastAutomatedReviewDispatchHash: automatedFingerprint,
              lastAutomatedReviewDispatchAt: new Date().toISOString(),
            });
          }
        }
      }
    }
  }

  /** Send a notification to all configured notifiers. */
  async function notifyHuman(event: OrchestratorEvent, priority: EventPriority): Promise<void> {
    const eventWithPriority = { ...event, priority };
    const notifierNames = config.notificationRouting[priority] ?? config.defaults.notifiers;

    for (const name of notifierNames) {
      const notifier = registry.get<Notifier>("notifier", name);
      if (notifier) {
        try {
          await notifier.notify(eventWithPriority);
        } catch {
          // Notifier failed — not much we can do
        }
      }
    }
  }

  async function maybeRepeatUnchangedReaction(
    session: Session,
    status: SessionStatus,
  ): Promise<void> {
    if (
      status === "idle" &&
      isOrchestratorSession(session) &&
      !(await hasActionableNonOrchestratorSessions(session.projectId, session.id))
    ) {
      clearReactionTracker(session.id, "agent-idle");
      return;
    }

    const eventType = statusToEventType(undefined, status);
    if (!eventType) return;

    const reactionKey = eventToReactionKey(eventType);
    if (!reactionKey) return;

    const reactionConfig = getReactionConfigForSession(session, reactionKey);
    if (!reactionConfig?.action) return;
    if (reactionConfig.auto === false && reactionConfig.action !== "notify") return;
    if (
      reactionConfig.action !== "send-to-agent" &&
      reactionConfig.action !== "send-to-orchestrator"
    ) {
      return;
    }

    const repeatEveryMs = parseRepeatInterval(reactionConfig.repeatEvery);
    if (repeatEveryMs <= 0) return;

    const tracker = reactionTrackers.get(`${session.id}:${reactionKey}`);
    if (tracker && Date.now() - tracker.lastTriggered.getTime() < repeatEveryMs) {
      return;
    }

    await executeReaction(session.id, session.projectId, reactionKey, reactionConfig, {
      countAttempt: false,
    });
  }

  /** Poll a single session and handle state transitions. */
  async function checkSession(session: Session): Promise<void> {
    // Use tracked state if available; otherwise use the persisted metadata status
    // (not session.status, which list() may have already overwritten for dead runtimes).
    // This ensures transitions are detected after a lifecycle manager restart.
    const tracked = states.get(session.id);
    const oldStatus =
      tracked ?? ((session.metadata?.["status"] as SessionStatus | undefined) || session.status);
    const newStatus = await determineStatus(session);
    let transitionReaction: { key: string; result: ReactionResult | null } | undefined;

    if (newStatus !== oldStatus) {
      const correlationId = createCorrelationId("lifecycle-transition");
      // State transition detected
      states.set(session.id, newStatus);
      updateSessionMetadata(session, { status: newStatus });
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.transition",
        outcome: "success",
        correlationId,
        projectId: session.projectId,
        sessionId: session.id,
        data: { oldStatus, newStatus },
        level: transitionLogLevel(newStatus),
      });

      // Clear reaction trackers for the old status so retries reset on state changes
      const oldEventType = statusToEventType(undefined, oldStatus);
      if (oldEventType) {
        const oldReactionKey = eventToReactionKey(oldEventType);
        if (oldReactionKey) {
          clearReactionTracker(session.id, oldReactionKey);
        }
      }

      // Handle transition: notify humans and/or trigger reactions
      const eventType = statusToEventType(oldStatus, newStatus);
      if (eventType) {
        const suppressIdleOrchestratorReaction =
          eventType === "session.idle" &&
          isOrchestratorSession(session) &&
          !(await hasActionableNonOrchestratorSessions(session.projectId, session.id));

        if (suppressIdleOrchestratorReaction) {
          clearReactionTracker(session.id, "agent-idle");
          await maybeDispatchReviewBacklog(session, oldStatus, newStatus, transitionReaction);
          return;
        }

        let reactionHandledNotify = false;
        const reactionKey = eventToReactionKey(eventType);

        if (reactionKey) {
          const reactionConfig = getReactionConfigForSession(session, reactionKey);

          if (reactionConfig && reactionConfig.action) {
            // auto: false skips automated agent actions but still allows notifications
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              const reactionResult = await executeReaction(
                session.id,
                session.projectId,
                reactionKey,
                reactionConfig,
              );
              transitionReaction = { key: reactionKey, result: reactionResult };
              // Reaction is handling this event — suppress immediate human notification.
              // "send-to-agent" retries + escalates on its own; "notify"/"auto-merge"
              // already call notifyHuman internally. Notifying here would bypass the
              // delayed escalation behaviour configured via retries/escalateAfter.
              reactionHandledNotify = true;
            }
          }
        }

        // For transitions not already notified by a reaction, notify humans.
        // All priorities (including "info") are routed through notificationRouting
        // so the config controls which notifiers receive each priority level.
        if (!reactionHandledNotify) {
          const priority = inferPriority(eventType);
          const event = createEvent(eventType, {
            sessionId: session.id,
            projectId: session.projectId,
            message: `${session.id}: ${oldStatus} → ${newStatus}`,
            data: { oldStatus, newStatus },
          });
          await notifyHuman(event, priority);
        }
      }
    } else {
      // No transition but track current state
      states.set(session.id, newStatus);
      await maybeRepeatUnchangedReaction(session, newStatus);
    }

    await maybeDispatchReviewBacklog(session, oldStatus, newStatus, transitionReaction);
  }

  /** Run one polling cycle across all sessions. */
  async function pollAll(): Promise<void> {
    const correlationId = createCorrelationId("lifecycle-poll");
    const startedAt = Date.now();
    // Re-entrancy guard: skip if previous poll is still running
    if (polling) return;
    polling = true;

    try {
      const sessions = await sessionManager.list(scopedProjectId);

      // Include sessions that are active OR whose status changed from what we last saw
      // (e.g., list() detected a dead runtime and marked it "killed" — we need to
      // process that transition even though the new status is terminal)
      const sessionsToCheck = sessions.filter((s) => {
        if (s.status !== "merged" && s.status !== "killed") return true;
        const tracked = states.get(s.id);
        return tracked !== undefined && tracked !== s.status;
      });

      // Poll all sessions concurrently
      await Promise.allSettled(sessionsToCheck.map((s) => checkSession(s)));

      // Prune stale entries from states and reactionTrackers for sessions
      // that no longer appear in the session list (e.g., after kill/cleanup)
      const currentSessionIds = new Set(sessions.map((s) => s.id));
      for (const trackedId of states.keys()) {
        if (!currentSessionIds.has(trackedId)) {
          states.delete(trackedId);
        }
      }
      for (const trackerKey of reactionTrackers.keys()) {
        const sessionId = trackerKey.split(":")[0];
        if (sessionId && !currentSessionIds.has(sessionId)) {
          reactionTrackers.delete(trackerKey);
        }
      }

      // Audit each completed worker epoch exactly once. The fingerprint is
      // persisted on the orchestrator so lifecycle restarts do not re-send the
      // same completion event. A new actionable worker clears the fingerprint,
      // allowing the next serial epoch to trigger its own audit.
      const projectIds = new Set(sessions.map((session) => session.projectId));
      let actionableSessionCount = 0;
      for (const projectId of projectIds) {
        const projectSessions = sessions.filter((session) => session.projectId === projectId);
        const orchestrator = projectSessions.find(isOrchestratorSession);
        const workerSessions = projectSessions.filter((session) => !isOrchestratorSession(session));
        const actionableSessions = workerSessions.filter(
          (session) => !TERMINAL_STATUSES.has(getTrackedStatus(session)),
        );
        actionableSessionCount += actionableSessions.length;

        if (actionableSessions.length > 0) {
          if (orchestrator?.metadata["lastAllCompleteFingerprint"]) {
            updateSessionMetadata(orchestrator, {
              lastAllCompleteFingerprint: "",
              lastAllCompleteAt: "",
            });
          }
          continue;
        }
        if (workerSessions.length === 0) continue;

        const terminalFingerprint = makeFingerprint(
          workerSessions.map((session) => `${session.id}:${getTrackedStatus(session)}`),
        );
        if (orchestrator?.metadata["lastAllCompleteFingerprint"] === terminalFingerprint) {
          continue;
        }

        const reactionKey = eventToReactionKey("summary.all_complete");
        if (!reactionKey) continue;
        const reactionConfig = getReactionConfigForProject(projectId, reactionKey);
        if (
          !reactionConfig?.action ||
          (reactionConfig.auto === false && reactionConfig.action !== "notify")
        ) {
          continue;
        }

        const result = await executeReaction("system", projectId, reactionKey, reactionConfig);
        const targetOrchestrator =
          orchestrator ?? (result.success ? await ensureOrchestratorSession(projectId) : null);
        if (result.success && targetOrchestrator) {
          updateSessionMetadata(targetOrchestrator, {
            lastAllCompleteFingerprint: terminalFingerprint,
            lastAllCompleteAt: new Date().toISOString(),
          });
        }
      }
      if (scopedProjectId) {
        observer.recordOperation({
          metric: "lifecycle_poll",
          operation: "lifecycle.poll",
          outcome: "success",
          correlationId,
          projectId: scopedProjectId,
          durationMs: Date.now() - startedAt,
          data: { sessionCount: sessions.length, activeSessionCount: actionableSessionCount },
          level: "info",
        });
        observer.setHealth({
          surface: "lifecycle.worker",
          status: "ok",
          projectId: scopedProjectId,
          correlationId,
          details: {
            projectId: scopedProjectId,
            sessionCount: sessions.length,
            activeSessionCount: actionableSessionCount,
          },
        });
      }
    } catch (err) {
      const errorReason = err instanceof Error ? err.message : String(err);
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.poll",
        outcome: "failure",
        correlationId,
        projectId: scopedProjectId,
        durationMs: Date.now() - startedAt,
        reason: errorReason,
        level: "error",
      });
      observer.setHealth({
        surface: "lifecycle.worker",
        status: "error",
        projectId: scopedProjectId,
        correlationId,
        reason: errorReason,
        details: scopedProjectId ? { projectId: scopedProjectId } : { projectScope: "all" },
      });
    } finally {
      polling = false;
    }
  }

  return {
    start(intervalMs = 30_000): void {
      if (pollTimer) return; // Already running
      pollTimer = setInterval(() => void pollAll(), intervalMs);
      // Run immediately on start
      void pollAll();
    },

    stop(): void {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },

    getStates(): Map<SessionId, SessionStatus> {
      return new Map(states);
    },

    async check(sessionId: SessionId): Promise<void> {
      const session = await sessionManager.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      await checkSession(session);
    },
  };
}

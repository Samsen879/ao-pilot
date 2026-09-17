import { describe, expect, it } from "vitest";
import { generateOrchestratorPrompt } from "../orchestrator-prompt.js";
import type { OrchestratorConfig } from "../types.js";

const config: OrchestratorConfig = {
  configPath: "/tmp/agent-orchestrator.yaml",
  port: 3000,
  defaults: {
    runtime: "tmux",
    agent: "claude-code",
    workspace: "worktree",
    notifiers: ["desktop"],
  },
  projects: {
    "my-app": {
      name: "My App",
      repo: "org/my-app",
      path: "/tmp/my-app",
      defaultBranch: "main",
      sessionPrefix: "app",
    },
  },
  notifiers: {},
  notificationRouting: {
    urgent: ["desktop"],
    action: ["desktop"],
    warning: [],
    info: [],
  },
  reactions: {},
  readyThresholdMs: 300_000,
};

describe("generateOrchestratorPrompt", () => {
  it("requires read-only investigation from the orchestrator session", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("Investigations from the orchestrator session are **read-only**");
    expect(prompt).toContain("do not edit repository files or implement fixes");
  });

  it("pushes implementation and PR claiming into worker sessions", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("must be delegated to a **worker session**");
    expect(prompt).toContain("Never claim a PR into `app-orchestrator`");
    expect(prompt).toContain("Delegate implementation, test execution, or PR claiming");
  });

  it("requires the orchestrator to keep coordinating until the delivery chain is clear", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("Do not treat the job as complete while there are open PRs");
    expect(prompt).toContain("blocked downstream issues");
    expect(prompt).toContain("unresolved review backlog");
    expect(prompt).toContain("worker ownership gaps");
  });

  it("tells the orchestrator to decide whether to restore a worker or hand work to a successor", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
    });

    expect(prompt).toContain("When a worker is stuck, exits unexpectedly, or loses PR ownership");
    expect(prompt).toContain("restore the existing worker");
    expect(prompt).toContain("spawn or redirect a successor worker");
    expect(prompt).toContain("Escalate to a human only when");
  });

  it("uses managed runtime session commands for a bound Codex orchestrator", () => {
    const prompt = generateOrchestratorPrompt({
      config,
      projectId: "my-app",
      project: config.projects["my-app"]!,
      managedCli: true,
    });

    expect(prompt).toContain("`ao status --json` only for global daemon health");
    expect(prompt).toContain("ao session ls --all --project my-app --json");
    expect(prompt).toContain("ao session claim-pr app-1 123 --project my-app");
    expect(prompt).toContain("ao send --session app-1 --message");
    expect(prompt).not.toContain("ao session claim-pr 123 app-1");
    expect(prompt).not.toContain("ao spawn INT-1234");
    expect(prompt).not.toContain("ao batch-spawn");
    expect(prompt).not.toContain("batch-spawn");
    expect(prompt).not.toContain("ao session attach");
    expect(prompt).not.toContain("ao dashboard");
    expect(prompt).not.toContain("ao open");
    expect(prompt).not.toContain("| `ao status` |");
  });
});

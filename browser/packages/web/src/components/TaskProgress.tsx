"use client";

import { useEffect, useState } from "react";

interface Task {
  project: string;
  session: string;
  message_id: string;
  sent_at: string;
  outcome: string;
  ack_at?: string;
  started_at?: string;
  first_command?: string;
  artifact?: string;
  artifact_sha256?: string;
  artifact_at?: string;
  latest?: string;
  detail?: string;
  sha256?: string;
  updated_at?: string;
}

interface Overview {
  tasks: Task[];
  paused_projects: string[];
}

function when(value: string) {
  return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
}

function TaskRow({ task }: { task: Task }) {
  const status = task.latest === "blocked" ? "Blocked" : task.latest === "artifact" ? "Artifact reported"
    : task.started_at ? "Start observed" : task.ack_at ? "Acknowledged · no start observed" : task.outcome;
  return (
    <li className="border-t border-[var(--color-border-subtle)] py-3">
      <div className="flex flex-wrap justify-between gap-2">
        <strong className="break-all">{task.message_id}</strong><span>{status}</span>
      </div>
      <p>{task.project} / {task.session}</p>
      <p>Dispatched {when(task.sent_at)}{task.ack_at && <> · Acknowledged {when(task.ack_at)}</>}</p>
      {task.started_at && <p>First observed command: {task.first_command} · {when(task.started_at)}</p>}
      {task.artifact && <p className="break-words">File: {task.artifact} {task.artifact_at && when(task.artifact_at)}</p>}
      {task.artifact_sha256 && <code className="break-all">SHA256 {task.artifact_sha256}</code>}
      {task.latest === "blocked" && <p className="break-words">Blocker: {task.detail} {task.updated_at && when(task.updated_at)}</p>}
    </li>
  );
}

export function TaskProgress({ project }: { project?: string }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const params = project ? "?project=" + encodeURIComponent(project) : "";
        const response = await fetch("/api/task-progress" + params, { signal: controller.signal, cache: "no-store" });
        if (response.status === 404) return;
        if (!response.ok) throw new Error();
        const data: Overview = await response.json();
        if (!Array.isArray(data.tasks) || !Array.isArray(data.paused_projects)) throw new Error();
        setOverview(data);
        setFailed(false);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 5000);
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [project]);
  if (!overview && !failed) return null;
  return (
    <section aria-label="Task progress" className="mb-6 text-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Task progress</h2>
        {project && <a className="underline" href="/?project=all">View all projects</a>}
      </div>
      {failed && <p role="status">Current task progress unavailable.</p>}
      {overview?.paused_projects.map(id => <p key={id}>Project paused: {id}</p>)}
      {overview && overview.tasks.length === 0 && <p>No dispatches requesting acknowledgement.</p>}
      {overview && <ul>{overview.tasks.slice(0, 5).map(t => <TaskRow key={t.message_id} task={t} />)}</ul>}
      {overview && overview.tasks.length > 5 && <details><summary>Show {overview.tasks.length - 5} more dispatches</summary>
        <ul>{overview.tasks.slice(5).map(t => <TaskRow key={t.message_id} task={t} />)}</ul></details>}
    </section>
  );
}

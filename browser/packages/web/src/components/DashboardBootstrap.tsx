"use client";

import { useEffect, useState } from "react";
import { Dashboard } from "./Dashboard";
import type { ProjectInfo } from "@/lib/project-name";
import type {
  DashboardOrchestratorLink,
  DashboardSession,
  GlobalPauseState,
} from "@/lib/types";

interface DashboardBootstrapProps {
  projectId?: string;
  projectName?: string;
  projects?: ProjectInfo[];
}

interface DashboardSnapshot {
  sessions: DashboardSession[];
  globalPause: GlobalPauseState | null;
  orchestrators: DashboardOrchestratorLink[];
}

const EMPTY_SNAPSHOT: DashboardSnapshot = {
  sessions: [],
  globalPause: null,
  orchestrators: [],
};

export function DashboardBootstrap({
  projectId,
  projectName,
  projects = [],
}: DashboardBootstrapProps) {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(EMPTY_SNAPSHOT);

  useEffect(() => {
    const controller = new AbortController();
    const query = projectId ? `?project=${encodeURIComponent(projectId)}` : "";

    void fetch(`/api/sessions${query}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (
          data: {
            sessions?: DashboardSession[];
            globalPause?: GlobalPauseState | null;
            orchestrators?: DashboardOrchestratorLink[];
          } | null,
        ) => {
          if (!data?.sessions || controller.signal.aborted) return;
          setSnapshot({
            sessions: data.sessions,
            globalPause: data.globalPause ?? null,
            orchestrators: data.orchestrators ?? [],
          });
        },
      )
      .catch(() => undefined);

    return () => controller.abort();
  }, [projectId]);

  return (
    <Dashboard
      initialSessions={snapshot.sessions}
      projectId={projectId}
      projectName={projectName}
      projects={projects}
      initialGlobalPause={snapshot.globalPause}
      orchestrators={snapshot.orchestrators}
    />
  );
}

import type { Metadata } from "next";

export const dynamic = "force-dynamic";
import { DashboardBootstrap } from "@/components/DashboardBootstrap";
import { getPrimaryProjectId, getProjectName, getAllProjects } from "@/lib/project-name";

function getSelectedProjectName(projectFilter: string | undefined): string {
  if (projectFilter === "all") return "All Projects";
  const projects = getAllProjects();
  if (projectFilter) {
    const selectedProject = projects.find((project) => project.id === projectFilter);
    if (selectedProject) return selectedProject.name;
  }
  return getProjectName();
}

export async function generateMetadata(props: {
  searchParams: Promise<{ project?: string }>;
}): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const projectFilter = searchParams.project ?? getPrimaryProjectId();
  const projectName = getSelectedProjectName(projectFilter);
  return { title: { absolute: `ao | ${projectName}` } };
}

export default async function Home(props: { searchParams: Promise<{ project?: string }> }) {
  const searchParams = await props.searchParams;
  const projectFilter = searchParams.project ?? getPrimaryProjectId();
  const projectName = getSelectedProjectName(projectFilter);
  const projects = getAllProjects();
  const selectedProjectId = projectFilter === "all" ? undefined : projectFilter;

  return (
    <DashboardBootstrap
      projectId={selectedProjectId}
      projectName={projectName}
      projects={projects}
    />
  );
}

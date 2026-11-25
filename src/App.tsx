import { useCallback, useEffect, useMemo, useState } from 'react';
import { ModulePendingView } from './components/common/ModulePendingView';
import { Sidebar } from './components/layout/Sidebar';
import { TopBar } from './components/layout/TopBar';
import { ProjectDetailModal } from './components/projects/ProjectDetailModal';
import { CreateAgentPage } from './pages/CreateAgentPage';
import { DashboardPage } from './pages/DashboardPage';
import { fetchProjects } from './services/api';
import type { AgentProject, NavSectionId, ProjectSummary } from './types/agent';

export default function App() {
  const [activeSection, setActiveSection] = useState<NavSectionId>('dashboard');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [inspectProjectId, setInspectProjectId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    setProjectsError(null);
    try {
      const list = await fetchProjects();
      setProjects(list);
      setSelectedProjectId((current) => {
        if (current && list.some((item) => item.id === current)) {
          return current;
        }
        return list.length > 0 ? list[0].id : null;
      });
    } catch (err) {
      setProjectsError(
        err instanceof Error ? err.message : 'Unable to load saved projects.'
      );
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const selectedProject = useMemo(
    () => projects.find((item) => item.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );

  const handleProjectCreated = (project: AgentProject) => {
    setSelectedProjectId(project.id);
    void loadProjects();
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex">
      <Sidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        selectedProject={selectedProject}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar
          activeSection={activeSection}
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={setSelectedProjectId}
          onNavigate={setActiveSection}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
        />

        <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-y-auto">
          {activeSection === 'dashboard' ? (
            <DashboardPage
              projects={projects}
              loading={loadingProjects}
              error={projectsError}
              selectedProjectId={selectedProjectId}
              onSelectProject={setSelectedProjectId}
              onInspectProject={setInspectProjectId}
              onNavigate={setActiveSection}
              onProjectsChanged={loadProjects}
            />
          ) : activeSection === 'create' ? (
            <CreateAgentPage
              onProjectCreated={handleProjectCreated}
              onProjectsChanged={loadProjects}
              onNavigate={setActiveSection}
            />
          ) : (
            <ModulePendingView
              section={activeSection}
              selectedProject={selectedProject}
              onNavigate={setActiveSection}
            />
          )}
        </main>
      </div>

      {inspectProjectId && (
        <ProjectDetailModal
          projectId={inspectProjectId}
          onClose={() => setInspectProjectId(null)}
          onProjectUpdated={loadProjects}
        />
      )}
    </div>
  );
}

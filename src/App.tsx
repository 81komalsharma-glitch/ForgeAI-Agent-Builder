import { useCallback, useEffect, useMemo, useState } from 'react';
import { ModulePendingView } from './components/common/ModulePendingView';
import { Sidebar } from './components/layout/Sidebar';
import { TopBar } from './components/layout/TopBar';
import { ProjectDetailModal } from './components/projects/ProjectDetailModal';
import { AgentBuilderPage } from './pages/AgentBuilderPage';
import { CreateAgentPage } from './pages/CreateAgentPage';
import { DashboardPage } from './pages/DashboardPage';
import { EvaluationPage } from './pages/EvaluationPage';
import { RequirementsPage } from './pages/RequirementsPage';
import { fetchProjects } from './services/api';
import type { AgentProject, NavSectionId, ProjectSummary } from './types/agent';

const VALID_SECTIONS: NavSectionId[] = [
  'dashboard',
  'create',
  'requirements',
  'builder',
  'evaluation',
  'optimizer',
  'reports',
  'chat',
];

function getInitialSection(): NavSectionId {
  try {
    const saved = window.sessionStorage.getItem('forgeai_active_section');
    if (saved && VALID_SECTIONS.includes(saved as NavSectionId)) {
      return saved as NavSectionId;
    }
  } catch {
    // Ignore storage access errors
  }
  return 'dashboard';
}

function getSavedProjectId(): string | null {
  try {
    return window.localStorage.getItem('forgeai_selected_project_id');
  } catch {
    return null;
  }
}

export default function App() {
  const [activeSection, setActiveSection] = useState<NavSectionId>(getInitialSection);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(getSavedProjectId);
  const [inspectProjectId, setInspectProjectId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleSelectSection = useCallback((section: NavSectionId) => {
    setActiveSection(section);
    try {
      window.sessionStorage.setItem('forgeai_active_section', section);
    } catch {
      // Ignore storage access errors
    }
  }, []);

  const handleSelectProject = useCallback((projectId: string | null) => {
    setSelectedProjectId(projectId);
    try {
      if (projectId) {
        window.localStorage.setItem('forgeai_selected_project_id', projectId);
      } else {
        window.localStorage.removeItem('forgeai_selected_project_id');
      }
    } catch {
      // Ignore storage access errors
    }
  }, []);

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    setProjectsError(null);
    try {
      const list = await fetchProjects();
      setProjects(list);
      setSelectedProjectId((current) => {
        const next =
          current && list.some((item) => item.id === current)
            ? current
            : list.length > 0
              ? list[0].id
              : null;
        try {
          if (next) {
            window.localStorage.setItem('forgeai_selected_project_id', next);
          } else {
            window.localStorage.removeItem('forgeai_selected_project_id');
          }
        } catch {
          // Ignore storage access errors
        }
        return next;
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
    handleSelectProject(project.id);
    void loadProjects();
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex">
      <Sidebar
        activeSection={activeSection}
        onSelectSection={handleSelectSection}
        selectedProject={selectedProject}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar
          activeSection={activeSection}
          projects={projects}
          selectedProjectId={selectedProjectId}
          onSelectProject={handleSelectProject}
          onNavigate={handleSelectSection}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
        />

        <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-y-auto">
          {activeSection === 'dashboard' ? (
            <DashboardPage
              projects={projects}
              loading={loadingProjects}
              error={projectsError}
              selectedProjectId={selectedProjectId}
              onSelectProject={handleSelectProject}
              onInspectProject={setInspectProjectId}
              onNavigate={handleSelectSection}
              onProjectsChanged={loadProjects}
            />
          ) : activeSection === 'create' ? (
            <CreateAgentPage
              onProjectCreated={handleProjectCreated}
              onProjectsChanged={loadProjects}
              onNavigate={handleSelectSection}
            />
          ) : activeSection === 'requirements' ? (
            <RequirementsPage
              selectedProjectId={selectedProjectId}
              onNavigate={handleSelectSection}
              onProjectsChanged={loadProjects}
            />
          ) : activeSection === 'builder' ? (
            <AgentBuilderPage
              selectedProjectId={selectedProjectId}
              onNavigate={handleSelectSection}
              onProjectsChanged={loadProjects}
            />
          ) : activeSection === 'evaluation' ? (
            <EvaluationPage
              selectedProjectId={selectedProjectId}
              onNavigate={handleSelectSection}
              onProjectsChanged={loadProjects}
            />
          ) : (
            <ModulePendingView
              section={activeSection}
              selectedProject={selectedProject}
              onNavigate={handleSelectSection}
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

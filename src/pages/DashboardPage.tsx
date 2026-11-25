import { useMemo, useState } from 'react';
import {
  Download,
  Eye,
  FolderPlus,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { deleteProject } from '../services/api';
import type { NavSectionId, ProjectSummary } from '../types/agent';
import { formatBytes, formatDateTime, formatStageLabel } from '../utils/format';

interface DashboardPageProps {
  projects: ProjectSummary[];
  loading: boolean;
  error: string | null;
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onInspectProject: (projectId: string) => void;
  onNavigate: (section: NavSectionId) => void;
  onProjectsChanged: () => void;
}

export function DashboardPage({
  projects,
  loading,
  error,
  selectedProjectId,
  onSelectProject,
  onInspectProject,
  onNavigate,
  onProjectsChanged,
}: DashboardPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const stats = useMemo(() => {
    const totalProjects = projects.length;
    const totalDocuments = projects.reduce((sum, p) => sum + p.documentCount, 0);
    const totalBytes = projects.reduce((sum, p) => sum + p.totalDocumentBytes, 0);
    const evaluatedCount = projects.filter(
      (p) => p.stage === 'evaluated' || p.stage === 'optimized'
    ).length;

    return { totalProjects, totalDocuments, totalBytes, evaluatedCount };
  }, [projects]);

  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.domain.toLowerCase().includes(q) ||
        p.brief.toLowerCase().includes(q)
    );
  }, [projects, searchQuery]);

  const handleConfirmDelete = async (projectId: string) => {
    setDeletingId(projectId);
    setDeleteError(null);
    try {
      await deleteProject(projectId);
      setConfirmDeleteId(null);
      onProjectsChanged();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete project.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            Dashboard
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Overview of saved agent projects, uploaded knowledge documents, and pipeline progress.
          </p>
        </div>

        <button
          type="button"
          onClick={() => onNavigate('create')}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#1E3A8A] text-white text-sm font-medium hover:bg-[#1E40AF] transition-colors whitespace-nowrap shrink-0 self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          <span>Create Agent</span>
        </button>
      </div>

      {/* Real Workspace Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Saved Projects</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {loading ? '—' : stats.totalProjects}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Knowledge Documents</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {loading ? '—' : stats.totalDocuments}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Uploaded Corpus Size</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {loading ? '—' : formatBytes(stats.totalBytes)}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Evaluated Builds</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {loading ? '—' : stats.evaluatedCount}
          </p>
        </div>
      </div>

      {/* Errors */}
      {(error || deleteError) && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error || deleteError}
        </div>
      )}

      {/* Recent Projects Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Agent Projects
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Stored as structured JSON configurations on the server.
            </p>
          </div>

          <div className="relative w-full sm:w-72">
            <Search
              className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search projects..."
              aria-label="Search agent projects"
              className="w-full h-9 pl-9 pr-3 rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-[#1E3A8A]"
            />
          </div>
        </div>

        {loading ? (
          <div className="p-6 space-y-3">
            <div className="h-10 bg-slate-100 rounded-lg" />
            <div className="h-10 bg-slate-100 rounded-lg" />
            <div className="h-10 bg-slate-100 rounded-lg" />
          </div>
        ) : projects.length === 0 ? (
          <div className="p-12 text-center">
            <div className="w-11 h-11 rounded-xl bg-slate-100 text-[#1E3A8A] flex items-center justify-center mx-auto mb-3">
              <FolderPlus className="w-5 h-5" aria-hidden="true" />
            </div>
            <h3 className="text-base font-semibold text-slate-900">
              No agent projects yet
            </h3>
            <p className="mt-1 text-sm text-slate-600 max-w-md mx-auto">
              Start by creating an agent project with a written requirements brief and optional PDF, TXT, or CSV knowledge documents.
            </p>
            <button
              type="button"
              onClick={() => onNavigate('create')}
              className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#1E3A8A] text-white text-sm font-medium hover:bg-[#1E40AF] transition-colors"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>Create First Agent</span>
            </button>
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-600">
            No projects match "{searchQuery}".
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                  <th className="py-3 px-6">Project</th>
                  <th className="py-3 px-4">Domain</th>
                  <th className="py-3 px-4 text-right">Documents</th>
                  <th className="py-3 px-4">Stage</th>
                  <th className="py-3 px-4">Last Updated</th>
                  <th className="py-3 px-6 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filteredProjects.map((project) => {
                  const isSelected = project.id === selectedProjectId;
                  const isConfirming = confirmDeleteId === project.id;

                  return (
                    <tr
                      key={project.id}
                      className={`transition-colors ${
                        isSelected ? 'bg-blue-50/40' : 'hover:bg-slate-50/80'
                      }`}
                    >
                      <td className="py-3.5 px-6 max-w-xs">
                        <button
                          type="button"
                          onClick={() => {
                            onSelectProject(project.id);
                            onInspectProject(project.id);
                          }}
                          className="text-left group block w-full"
                        >
                          <span className="block font-semibold text-slate-900 group-hover:text-[#1E3A8A] truncate">
                            {project.name}
                          </span>
                          <span className="block text-xs text-slate-500 truncate mt-0.5">
                            {project.brief}
                          </span>
                        </button>
                      </td>
                      <td className="py-3.5 px-4 text-slate-700 whitespace-nowrap">
                        {project.domain}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono text-xs tabular-nums text-slate-700 whitespace-nowrap">
                        {project.documentCount} ({formatBytes(project.totalDocumentBytes)})
                      </td>
                      <td className="py-3.5 px-4 text-slate-700 whitespace-nowrap">
                        {formatStageLabel(project.stage)}
                      </td>
                      <td className="py-3.5 px-4 text-xs font-mono tabular-nums text-slate-500 whitespace-nowrap">
                        {formatDateTime(project.updatedAt)}
                      </td>
                      <td className="py-3.5 px-6 text-right whitespace-nowrap">
                        {isConfirming ? (
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleConfirmDelete(project.id)}
                              disabled={deletingId === project.id}
                              className="px-2.5 py-1 rounded-md bg-red-600 text-white text-xs font-medium hover:bg-red-700 disabled:opacity-50"
                            >
                              {deletingId === project.id ? 'Deleting...' : 'Confirm'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-2.5 py-1 rounded-md border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-100"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                onSelectProject(project.id);
                                onInspectProject(project.id);
                              }}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium text-[#1E3A8A] hover:bg-blue-50"
                            >
                              <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>Inspect</span>
                            </button>
                            <a
                              href={`/api/projects/${encodeURIComponent(project.id)}/export`}
                              className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                              aria-label={`Download JSON for ${project.name}`}
                              title="Download Project JSON"
                            >
                              <Download className="w-3.5 h-3.5" />
                            </a>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(project.id)}
                              className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50"
                              aria-label={`Delete ${project.name}`}
                              title="Delete Project"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Honest Pipeline Overview */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <h2 className="text-sm font-semibold text-slate-900">
          ForgeAI Workflow Stages
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Stages 1–4 (Create Agent, Requirements &amp; Groundability Guard, Agent Builder, and Evaluation Generator) are active.
        </p>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          <button
            type="button"
            onClick={() => onNavigate('create')}
            className="text-left p-3.5 rounded-lg border border-slate-200 hover:border-[#1E3A8A] transition-colors"
          >
            <p className="font-semibold text-[#1E3A8A]">01. Create Agent (Active)</p>
            <p className="mt-1 text-slate-600">
              Capture written project brief and parse PDF, TXT, or CSV documents.
            </p>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('requirements')}
            className="text-left p-3.5 rounded-lg border border-slate-200 hover:border-[#1E3A8A] transition-colors"
          >
            <p className="font-semibold text-[#1E3A8A]">02. Requirements (Active)</p>
            <p className="mt-1 text-slate-600">
              AI clarification interview, 10-part specification, and groundability guard.
            </p>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('builder')}
            className="text-left p-3.5 rounded-lg border border-slate-200 hover:border-[#1E3A8A] transition-colors"
          >
            <p className="font-semibold text-[#1E3A8A]">03. Agent Builder (Active)</p>
            <p className="mt-1 text-slate-600">
              Generate, edit, validate, and version declarative agent definitions.
            </p>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('evaluation')}
            className="text-left p-3.5 rounded-lg border border-slate-200 hover:border-[#1E3A8A] transition-colors"
          >
            <p className="font-semibold text-[#1E3A8A]">04. Evaluation (Active)</p>
            <p className="mt-1 text-slate-600">
              Generate, edit, validate, and version 20+ grounded test cases.
            </p>
          </button>
        </div>
      </section>
    </div>
  );
}

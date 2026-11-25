import { Menu, Plus } from 'lucide-react';
import type { NavSectionId, ProjectSummary } from '../../types/agent';
import { NAV_ITEMS } from './Sidebar';

interface TopBarProps {
  activeSection: NavSectionId;
  projects: ProjectSummary[];
  selectedProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onNavigate: (section: NavSectionId) => void;
  onOpenMobileMenu: () => void;
}

export function TopBar({
  activeSection,
  projects,
  selectedProjectId,
  onSelectProject,
  onNavigate,
  onOpenMobileMenu,
}: TopBarProps) {
  const currentItem = NAV_ITEMS.find((item) => item.id === activeSection);

  return (
    <header className="h-16 bg-white border-b border-slate-200 px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4 shrink-0">
      {/* Left: Mobile menu button + Breadcrumb */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          className="lg:hidden p-2 -ml-2 rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          aria-label="Open navigation menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm min-w-0">
          <button
            type="button"
            onClick={() => onNavigate('dashboard')}
            className="text-slate-500 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
          >
            ForgeAI
          </button>
          <span className="text-slate-300" aria-hidden="true">
            /
          </span>
          <span className="font-semibold text-slate-900 truncate">
            {currentItem?.label ?? 'Dashboard'}
          </span>
        </nav>
      </div>

      {/* Right: Project selector (when projects exist) + Single primary CTA */}
      <div className="flex items-center gap-3 shrink-0">
        {projects.length > 0 && (
          <div className="hidden sm:flex items-center gap-2">
            <label htmlFor="active-project-select" className="sr-only">
              Active Project
            </label>
            <select
              id="active-project-select"
              value={selectedProjectId ?? ''}
              onChange={(e) => onSelectProject(e.target.value)}
              className="h-9 max-w-[220px] rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-[#1E3A8A]/20 focus:border-[#1E3A8A]"
            >
              {projects.map((proj) => (
                <option key={proj.id} value={proj.id}>
                  {proj.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {activeSection !== 'create' && (
          <button
            type="button"
            onClick={() => onNavigate('create')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E3A8A]"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            <span>New Agent</span>
          </button>
        )}
      </div>
    </header>
  );
}

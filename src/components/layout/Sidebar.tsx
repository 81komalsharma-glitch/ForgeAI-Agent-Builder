import {
  BarChart3,
  Bot,
  ClipboardList,
  FlaskConical,
  LayoutDashboard,
  MessageSquare,
  PlusCircle,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import type { NavSectionId, ProjectSummary } from '../../types/agent';

export interface NavItem {
  id: NavSectionId;
  label: string;
  group: 'foundation' | 'pipeline';
  implemented: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', group: 'foundation', implemented: true },
  { id: 'create', label: 'Create Agent', group: 'foundation', implemented: true },
  { id: 'requirements', label: 'Requirements', group: 'pipeline', implemented: false },
  { id: 'builder', label: 'Agent Builder', group: 'pipeline', implemented: false },
  { id: 'evaluation', label: 'Evaluation', group: 'pipeline', implemented: false },
  { id: 'optimizer', label: 'Optimizer', group: 'pipeline', implemented: false },
  { id: 'reports', label: 'Reports', group: 'pipeline', implemented: false },
  { id: 'chat', label: 'Chat with Agent', group: 'pipeline', implemented: false },
];

const NAV_ICONS: Record<NavSectionId, typeof LayoutDashboard> = {
  dashboard: LayoutDashboard,
  create: PlusCircle,
  requirements: ClipboardList,
  builder: Wrench,
  evaluation: FlaskConical,
  optimizer: Sparkles,
  reports: BarChart3,
  chat: MessageSquare,
};

interface SidebarProps {
  activeSection: NavSectionId;
  onSelectSection: (section: NavSectionId) => void;
  selectedProject: ProjectSummary | null;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export function Sidebar({
  activeSection,
  onSelectSection,
  selectedProject,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const foundationItems = NAV_ITEMS.filter((item) => item.group === 'foundation');
  const pipelineItems = NAV_ITEMS.filter((item) => item.group === 'pipeline');

  const handleNavClick = (section: NavSectionId) => {
    onSelectSection(section);
    onCloseMobile();
  };

  const renderNavButton = (item: NavItem) => {
    const Icon = NAV_ICONS[item.id];
    const isActive = activeSection === item.id;

    return (
      <button
        key={item.id}
        type="button"
        onClick={() => handleNavClick(item.id)}
        className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 ${
          isActive
            ? 'bg-[#1E3A8A] text-white'
            : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
        }`}
      >
        <span className="flex items-center gap-3 min-w-0">
          <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{item.label}</span>
        </span>
        {!item.implemented && (
          <span className="text-[11px] font-normal text-slate-400 shrink-0 ml-2">
            Next
          </span>
        )}
      </button>
    );
  };

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-950/50 lg:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-[#0F172A] text-slate-100 flex flex-col border-r border-slate-800 transition-transform duration-150 lg:static lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-label="Primary Sidebar Navigation"
      >
        {/* Brand Header */}
        <div className="h-16 px-5 flex items-center justify-between border-b border-slate-800 shrink-0">
          <button
            type="button"
            onClick={() => handleNavClick('dashboard')}
            className="flex items-center gap-2.5 text-left focus-visible:outline-2 focus-visible:outline-blue-400 rounded-md"
          >
            <span className="w-8 h-8 rounded-lg bg-[#1E3A8A] text-white flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-base font-bold tracking-tight text-white leading-tight whitespace-nowrap">
                ForgeAI
              </span>
              <span className="block text-xs text-slate-400 leading-tight whitespace-nowrap">
                Agent Builder Studio
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={onCloseMobile}
            className="lg:hidden p-1.5 rounded-md text-slate-400 hover:text-white hover:bg-slate-800"
            aria-label="Close navigation menu"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 overflow-y-auto px-3 py-5 space-y-6">
          <div>
            <p className="px-3 mb-2 text-xs font-medium text-slate-400">
              Workspace
            </p>
            <div className="space-y-1">{foundationItems.map(renderNavButton)}</div>
          </div>

          <div>
            <p className="px-3 mb-2 text-xs font-medium text-slate-400">
              Agent Pipeline
            </p>
            <div className="space-y-1">{pipelineItems.map(renderNavButton)}</div>
          </div>
        </nav>

        {/* Active Project Footer Context */}
        <div className="p-4 border-t border-slate-800 shrink-0">
          <p className="text-xs font-medium text-slate-400 mb-1">
            Active Project
          </p>
          {selectedProject ? (
            <div className="min-w-0">
              <p className="text-sm font-medium text-white truncate">
                {selectedProject.name}
              </p>
              <p className="text-xs text-slate-400 mt-0.5 tabular-nums truncate">
                {selectedProject.domain} · {selectedProject.documentCount} docs
              </p>
            </div>
          ) : (
            <p className="text-xs text-slate-400">
              No project selected
            </p>
          )}
        </div>
      </aside>
    </>
  );
}

import { ArrowRight, FolderOpen, Info } from 'lucide-react';
import type { NavSectionId, ProjectSummary } from '../../types/agent';

interface ModuleMetadata {
  title: string;
  stepNumber: string;
  purpose: string;
  plannedInputs: string;
  plannedOutputs: string;
}

const MODULE_INFO: Record<
  Exclude<NavSectionId, 'dashboard' | 'create'>,
  ModuleMetadata
> = {
  requirements: {
    title: 'Requirements',
    stepNumber: 'Stage 02',
    purpose:
      'Analyze the written project brief and uploaded knowledge documents using the Gemini API to extract structured functional requirements, constraints, target personas, and edge cases.',
    plannedInputs: 'Saved project brief and extracted text from PDF, TXT, and CSV documents.',
    plannedOutputs: 'Structured requirements specification saved to the project JSON file.',
  },
  builder: {
    title: 'Agent Builder',
    stepNumber: 'Stage 03',
    purpose:
      'Generate the agent system prompt, tool definitions, and document retrieval configuration tailored to the approved requirements.',
    plannedInputs: 'Generated requirements specification and document index.',
    plannedOutputs: 'Versioned agent configuration JSON (system prompt, tools, retrieval settings).',
  },
  evaluation: {
    title: 'Evaluation',
    stepNumber: 'Stage 04',
    purpose:
      'Automatically generate domain-specific test cases and run the configured agent against them to measure accuracy, grounding, and constraint adherence.',
    plannedInputs: 'Agent configuration and requirements test criteria.',
    plannedOutputs: 'Structured test cases and real pass/fail evaluation results.',
  },
  optimizer: {
    title: 'Optimizer',
    stepNumber: 'Stage 05',
    purpose:
      'Inspect failing evaluation cases, diagnose root causes, and iteratively refine the system prompt and retrieval parameters across versions.',
    plannedInputs: 'Evaluation failure traces and current agent configuration.',
    plannedOutputs: 'Iteration history and updated prompt/configuration candidates.',
  },
  reports: {
    title: 'Reports',
    stepNumber: 'Stage 06',
    purpose:
      'Summarize measured quality scores across evaluation runs, document remaining limitations, and export final JSON reports.',
    plannedInputs: 'Completed evaluation and optimization iteration records.',
    plannedOutputs: 'Exportable quality summary and limitation report.',
  },
  chat: {
    title: 'Chat with Agent',
    stepNumber: 'Stage 07',
    purpose:
      'Provide an interactive test chat backed by the server-side Gemini API using the generated system prompt and uploaded project knowledge.',
    plannedInputs: 'Active agent configuration and parsed project documents.',
    plannedOutputs: 'Live multi-turn test conversation grounded in project documents.',
  },
};

interface ModulePendingViewProps {
  section: Exclude<NavSectionId, 'dashboard' | 'create'>;
  selectedProject: ProjectSummary | null;
  onNavigate: (section: NavSectionId) => void;
}

export function ModulePendingView({
  section,
  selectedProject,
  onNavigate,
}: ModulePendingViewProps) {
  const info = MODULE_INFO[section];

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <p className="text-xs font-medium text-[#1E3A8A] mb-1">
          {info.stepNumber} · Planned Module
        </p>
        <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
          {info.title}
        </h1>
        <p className="mt-2 text-sm text-slate-600 leading-relaxed max-w-2xl">
          {info.purpose}
        </p>

        <div className="mt-5 flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <Info className="w-4 h-4 text-[#1E3A8A] shrink-0 mt-0.5" aria-hidden="true" />
          <div className="text-xs text-slate-700 leading-relaxed">
            <span className="font-semibold text-slate-900">
              Module not yet implemented.
            </span>{' '}
            This workspace is currently in Stage 1 (application foundation, project creation, and document ingestion). No simulated scores, prompts, or test results are displayed here.
          </div>
        </div>
      </div>

      {/* Pipeline Input/Output Specification */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-slate-900">Planned Inputs</h2>
          <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
            {info.plannedInputs}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-slate-900">Planned Outputs</h2>
          <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">
            {info.plannedOutputs}
          </p>
        </div>
      </div>

      {/* Selected Project Context */}
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-900">
            Selected Project Context
          </h2>
          {selectedProject ? (
            <button
              type="button"
              onClick={() => onNavigate('dashboard')}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[#1E3A8A] hover:underline"
            >
              <span>Inspect on Dashboard</span>
              <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>

        {selectedProject ? (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="font-semibold text-slate-900 text-sm">
                {selectedProject.name}
              </span>
              <span aria-hidden="true">·</span>
              <span>{selectedProject.domain}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">
                {selectedProject.documentCount}{' '}
                {selectedProject.documentCount === 1 ? 'document' : 'documents'} ready
              </span>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed line-clamp-4">
              {selectedProject.brief}
            </p>
          </div>
        ) : (
          <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <FolderOpen className="w-5 h-5 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-sm text-slate-600">
                No agent project has been created yet. Create a project with a brief and documents first so it is ready for this stage.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('create')}
              className="px-4 py-2 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF] transition-colors whitespace-nowrap shrink-0"
            >
              Create Agent Project
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

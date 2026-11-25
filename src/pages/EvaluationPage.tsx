import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Edit3,
  FileText,
  FlaskConical,
  FolderOpen,
  History,
  Info,
  Loader2,
  Lock,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import {
  ApiValidationError,
  fetchEvaluationPrompts,
  fetchProjectById,
  generateEvaluationDataset,
  regenerateEvaluationTestCase,
  saveEvaluationDataset,
  validateEvaluationDataset,
} from '../services/api';
import type {
  AgentProject,
  EvaluationCategory,
  EvaluationDatasetVersion,
  EvaluationDifficulty,
  EvaluationPromptTemplateMeta,
  EvaluationTestCase,
  EvaluationValidationResult,
  NavSectionId,
} from '../types/agent';
import { formatDateTime } from '../utils/format';

interface EvaluationPageProps {
  selectedProjectId: string | null;
  onNavigate: (section: NavSectionId) => void;
  onProjectsChanged: () => void;
}

const CATEGORY_LABELS: Record<EvaluationCategory, string> = {
  answerable: 'Answerable',
  out_of_scope: 'Out-of-Scope / Refusal',
  edge_case: 'Edge Case',
};

const DIFFICULTY_LABELS: Record<EvaluationDifficulty, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function EvaluationPage({
  selectedProjectId,
  onNavigate,
  onProjectsChanged,
}: EvaluationPageProps) {
  const [project, setProject] = useState<AgentProject | null>(null);
  const [loadingProject, setLoadingProject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runEvalMessage, setRunEvalMessage] = useState<string | null>(null);

  const [selectedDatasetVersion, setSelectedDatasetVersion] = useState<number | null>(
    null
  );
  const [workingCases, setWorkingCases] = useState<EvaluationTestCase[]>([]);
  const [documentAnalysisSummary, setDocumentAnalysisSummary] = useState('');
  const [validation, setValidation] = useState<EvaluationValidationResult | null>(
    null
  );
  const [editSource, setEditSource] = useState<
    'generated' | 'manual_edit' | 'case_regenerated'
  >('generated');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Selection, expand, edit, filter state
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [expandedCaseIds, setExpandedCaseIds] = useState<Record<string, boolean>>({});
  const [editingCaseId, setEditingCaseId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EvaluationTestCase | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | EvaluationCategory>(
    'all'
  );
  const [difficultyFilter, setDifficultyFilter] = useState<
    'all' | EvaluationDifficulty
  >('all');
  const [regenInstruction, setRegenInstruction] = useState('');

  // Async action states
  const [generating, setGenerating] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [aiAuditing, setAiAuditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Prompt inspection modal
  const [showPromptsModal, setShowPromptsModal] = useState(false);
  const [promptTemplates, setPromptTemplates] = useState<
    EvaluationPromptTemplateMeta[]
  >([]);
  const [promptVersion, setPromptVersion] = useState<string>('');
  const [loadingPrompts, setLoadingPrompts] = useState(false);

  const hydrateFromVersion = useCallback(
    (record: EvaluationDatasetVersion | null) => {
      if (!record) {
        setSelectedDatasetVersion(null);
        setWorkingCases([]);
        setDocumentAnalysisSummary('');
        setValidation(null);
        setSelectedCaseId(null);
        setExpandedCaseIds({});
        setEditingCaseId(null);
        setEditDraft(null);
        setHasUnsavedChanges(false);
        return;
      }
      setSelectedDatasetVersion(record.version);
      setWorkingCases(record.testCases);
      setDocumentAnalysisSummary(record.documentAnalysisSummary || '');
      setValidation(record.validation);
      setEditSource(record.source);
      setSelectedCaseId((prev) =>
        prev && record.testCases.some((tc) => tc.id === prev)
          ? prev
          : record.testCases[0]?.id ?? null
      );
      setEditingCaseId(null);
      setEditDraft(null);
      setHasUnsavedChanges(false);
    },
    []
  );

  const loadProject = useCallback(
    async (projectId: string) => {
      setLoadingProject(true);
      setError(null);
      setNotice(null);
      setRunEvalMessage(null);
      try {
        const full = await fetchProjectById(projectId);
        setProject(full);
        const versions = full.evaluation?.versions ?? [];
        const targetVer =
          full.evaluation?.savedVersion ?? full.evaluation?.currentVersion ?? null;
        const found =
          (targetVer !== null
            ? versions.find((v) => v.version === targetVer)
            : undefined) ??
          versions[versions.length - 1] ??
          null;
        hydrateFromVersion(found);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load project.');
        setProject(null);
        hydrateFromVersion(null);
      } finally {
        setLoadingProject(false);
      }
    },
    [hydrateFromVersion]
  );

  useEffect(() => {
    if (!selectedProjectId) {
      setProject(null);
      hydrateFromVersion(null);
      return;
    }
    void loadProject(selectedProjectId);
  }, [selectedProjectId, loadProject, hydrateFromVersion]);

  const savedAgentRecord = useMemo(() => {
    if (!project?.agentConfig || project.agentConfig.savedVersion === null) {
      return null;
    }
    return (
      project.agentConfig.versions.find(
        (v) => v.version === project.agentConfig?.savedVersion
      ) ?? null
    );
  }, [project]);

  const parsedDocuments = useMemo(
    () => (project?.documents ?? []).filter((d) => d.parseStatus === 'parsed'),
    [project]
  );

  const prerequisitesMet = Boolean(
    project?.requirements?.approved &&
      savedAgentRecord &&
      savedAgentRecord.validation.valid
  );

  const canRunEvaluation = Boolean(
    prerequisitesMet &&
      project?.evaluation?.savedVersion !== null &&
      project?.evaluation?.savedVersion !== undefined &&
      !hasUnsavedChanges &&
      validation?.valid
  );

  const liveStats = useMemo(() => {
    const byCategory: Record<EvaluationCategory, number> = {
      answerable: 0,
      out_of_scope: 0,
      edge_case: 0,
    };
    const byDifficulty: Record<EvaluationDifficulty, number> = {
      easy: 0,
      medium: 0,
      hard: 0,
    };
    for (const tc of workingCases) {
      byCategory[tc.category] += 1;
      byDifficulty[tc.difficulty] += 1;
    }
    return {
      total: workingCases.length,
      byCategory,
      byDifficulty,
    };
  }, [workingCases]);

  const filteredCases = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return workingCases.filter((tc) => {
      if (categoryFilter !== 'all' && tc.category !== categoryFilter) {
        return false;
      }
      if (difficultyFilter !== 'all' && tc.difficulty !== difficultyFilter) {
        return false;
      }
      if (!q) return true;
      return (
        tc.id.toLowerCase().includes(q) ||
        tc.question.toLowerCase().includes(q) ||
        tc.expectedBehavior.toLowerCase().includes(q) ||
        tc.supportingEvidence.toLowerCase().includes(q) ||
        tc.reason.toLowerCase().includes(q) ||
        (tc.expectedSourceDocument ?? '').toLowerCase().includes(q) ||
        tc.expectedKeyFacts.some((fact) => fact.toLowerCase().includes(q))
      );
    });
  }, [workingCases, searchQuery, categoryFilter, difficultyFilter]);

  const runServerValidation = async (
    nextCases: EvaluationTestCase[],
    useAiAudit = false
  ) => {
    if (!project) return;
    if (useAiAudit) {
      setAiAuditing(true);
    } else {
      setValidating(true);
    }
    setError(null);
    try {
      const result = await validateEvaluationDataset(
        project.id,
        nextCases,
        useAiAudit
      );
      setWorkingCases(result.testCases);
      setValidation(result.validation);
      if (useAiAudit) {
        setNotice(
          result.validation.valid
            ? 'AI semantic audit passed with no blocking errors.'
            : `AI semantic audit completed: ${result.validation.errors.length} error(s), ${result.validation.warnings.length} warning(s).`
        );
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to validate evaluation set.'
      );
    } finally {
      setValidating(false);
      setAiAuditing(false);
    }
  };

  const handleGenerateDataset = async () => {
    if (!project) return;
    setGenerating(true);
    setError(null);
    setNotice(null);
    setRunEvalMessage(null);
    try {
      const updated = await generateEvaluationDataset(project.id);
      setProject(updated);
      const versions = updated.evaluation?.versions ?? [];
      const latest = versions[versions.length - 1] ?? null;
      hydrateFromVersion(latest);
      onProjectsChanged();
      setNotice(
        latest
          ? `Generated evaluation dataset v${latest.version} (${latest.testCases.length} test cases) for ${latest.agentName} v${latest.agentVersion}. Review and click Save Evaluation Set to lock it.`
          : 'Evaluation test cases generated.'
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to generate evaluation test cases.'
      );
    } finally {
      setGenerating(false);
    }
  };

  const handleRegenerateCase = async (targetId: string) => {
    if (!project) return;
    setRegeneratingId(targetId);
    setError(null);
    setNotice(null);
    setRunEvalMessage(null);
    try {
      const result = await regenerateEvaluationTestCase(project.id, {
        testCaseId: targetId,
        currentTestCases: workingCases,
        instruction: regenInstruction.trim() || undefined,
      });
      setWorkingCases(result.testCases);
      setValidation(result.validation);
      setEditSource('case_regenerated');
      setHasUnsavedChanges(true);
      setExpandedCaseIds((prev) => ({ ...prev, [targetId]: true }));
      if (editingCaseId === targetId) {
        setEditingCaseId(null);
        setEditDraft(null);
      }
      setNotice(
        `Regenerated test case ${targetId}. Click Save Evaluation Set to persist changes.`
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : `Failed to regenerate test case ${targetId}.`
      );
    } finally {
      setRegeneratingId(null);
    }
  };

  const handleDeleteCase = async (targetId: string) => {
    const nextCases = workingCases.filter((tc) => tc.id !== targetId);
    setWorkingCases(nextCases);
    setEditSource('manual_edit');
    setHasUnsavedChanges(true);
    setRunEvalMessage(null);
    if (selectedCaseId === targetId) {
      setSelectedCaseId(nextCases[0]?.id ?? null);
    }
    if (editingCaseId === targetId) {
      setEditingCaseId(null);
      setEditDraft(null);
    }
    await runServerValidation(nextCases, false);
  };

  const handleStartEdit = (tc: EvaluationTestCase) => {
    setEditingCaseId(tc.id);
    setEditDraft({
      ...tc,
      expectedKeyFacts: [...tc.expectedKeyFacts],
    });
    setExpandedCaseIds((prev) => ({ ...prev, [tc.id]: true }));
  };

  const handleSaveInlineEdit = async () => {
    if (!editDraft || !editingCaseId) return;
    const cleanedDraft: EvaluationTestCase = {
      ...editDraft,
      id: editDraft.id.trim() || editingCaseId,
      question: editDraft.question.trim(),
      expectedBehavior: editDraft.expectedBehavior.trim(),
      supportingEvidence: editDraft.supportingEvidence.trim(),
      reason: editDraft.reason.trim(),
      expectedSourceDocument:
        editDraft.category === 'out_of_scope'
          ? null
          : editDraft.expectedSourceDocument?.trim() || null,
      expectedRefusal:
        editDraft.category === 'out_of_scope'
          ? true
          : editDraft.category === 'answerable'
            ? false
            : editDraft.expectedRefusal,
      expectedKeyFacts:
        editDraft.category === 'out_of_scope'
          ? []
          : editDraft.expectedKeyFacts.map((f) => f.trim()).filter(Boolean),
    };

    const nextCases = workingCases.map((tc) =>
      tc.id === editingCaseId ? cleanedDraft : tc
    );
    setWorkingCases(nextCases);
    setSelectedCaseId(cleanedDraft.id);
    setEditingCaseId(null);
    setEditDraft(null);
    setEditSource('manual_edit');
    setHasUnsavedChanges(true);
    setRunEvalMessage(null);
    await runServerValidation(nextCases, false);
  };

  const handleAddCustomCase = () => {
    const maxNum = workingCases.reduce((max, tc) => {
      const m = /^TC-(\d+)$/i.exec(tc.id.trim());
      return m ? Math.max(max, Number(m[1])) : max;
    }, workingCases.length);
    const newId = `TC-${String(maxNum + 1).padStart(3, '0')}`;
    const newCase: EvaluationTestCase = {
      id: newId,
      question: '',
      category: 'answerable',
      difficulty: 'medium',
      expectedBehavior: '',
      expectedKeyFacts: [],
      expectedSourceDocument: parsedDocuments[0]?.originalName ?? null,
      supportingEvidence: '',
      expectedRefusal: false,
      reason: '',
    };
    const nextCases = [newCase, ...workingCases];
    setWorkingCases(nextCases);
    setSelectedCaseId(newId);
    setExpandedCaseIds((prev) => ({ ...prev, [newId]: true }));
    setEditingCaseId(newId);
    setEditDraft(newCase);
    setEditSource('manual_edit');
    setHasUnsavedChanges(true);
    setRunEvalMessage(null);
  };

  const handleSaveEvaluationSet = async () => {
    if (!project) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await saveEvaluationDataset(project.id, {
        testCases: workingCases,
        baseVersion: selectedDatasetVersion,
        source: editSource,
        documentAnalysisSummary,
      });
      setProject(result.project);
      const versions = result.project.evaluation?.versions ?? [];
      const savedVer =
        result.project.evaluation?.savedVersion ??
        result.project.evaluation?.currentVersion ??
        null;
      const savedRecord =
        (savedVer !== null
          ? versions.find((v) => v.version === savedVer)
          : undefined) ??
        versions[versions.length - 1] ??
        null;
      hydrateFromVersion(savedRecord);
      onProjectsChanged();
      setNotice(
        savedRecord
          ? `Evaluation dataset v${savedRecord.version} (${savedRecord.testCases.length} test cases) validated and saved.`
          : 'Evaluation dataset saved.'
      );
    } catch (err) {
      if (err instanceof ApiValidationError && err.validation) {
        setValidation(err.validation as EvaluationValidationResult);
      }
      setError(
        err instanceof Error ? err.message : 'Failed to save evaluation dataset.'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleOpenPromptsModal = async () => {
    setShowPromptsModal(true);
    if (promptTemplates.length > 0) return;
    setLoadingPrompts(true);
    try {
      const data = await fetchEvaluationPrompts();
      setPromptTemplates(data.prompts);
      setPromptVersion(data.version);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load evaluation prompt templates.'
      );
    } finally {
      setLoadingPrompts(false);
    }
  };

  const handleExportJson = () => {
    if (!project || workingCases.length === 0) return;
    const payload = {
      projectId: project.id,
      projectName: project.name,
      agentName: savedAgentRecord?.definition.agentName || project.name,
      agentVersion: savedAgentRecord?.version ?? null,
      datasetVersion: selectedDatasetVersion,
      exportedAt: new Date().toISOString(),
      stats: liveStats,
      documentAnalysisSummary,
      testCases: workingCases,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${project.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')}-evaluation-v${selectedDatasetVersion ?? 1}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleSwitchVersion = (versionNum: number) => {
    const found = project?.evaluation?.versions.find(
      (v) => v.version === versionNum
    );
    if (found) {
      hydrateFromVersion(found);
      setNotice(`Loaded evaluation dataset v${found.version}.`);
      setError(null);
      setRunEvalMessage(null);
    }
  };

  if (!selectedProjectId) {
    return (
      <div className="max-w-4xl mx-auto bg-white border border-slate-200 rounded-xl p-10 text-center">
        <div className="w-12 h-12 rounded-xl bg-slate-100 text-[#1E3A8A] flex items-center justify-center mx-auto mb-3">
          <FolderOpen className="w-6 h-6" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-semibold text-slate-900">
          No Active Project Selected
        </h1>
        <p className="mt-1.5 text-sm text-slate-600 max-w-md mx-auto">
          Select an existing project from the top bar or create a new agent project first.
        </p>
        <button
          type="button"
          onClick={() => onNavigate('create')}
          className="mt-5 px-4 py-2 rounded-lg bg-[#1E3A8A] text-white text-sm font-medium hover:bg-[#1E40AF] transition-colors"
        >
          Go to Create Agent
        </button>
      </div>
    );
  }

  if (loadingProject && !project) {
    return (
      <div className="max-w-6xl mx-auto bg-white border border-slate-200 rounded-xl p-12 flex items-center justify-center gap-3 text-sm text-slate-600">
        <Loader2 className="w-4 h-4 animate-spin text-[#1E3A8A]" />
        <span>Loading evaluation workspace...</span>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="max-w-4xl mx-auto rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
        {error || 'Unable to load project.'}
      </div>
    );
  }

  if (!prerequisitesMet) {
    const needsRequirements = !project.requirements?.approved;
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <p className="text-xs font-medium text-[#1E3A8A] mb-1">
            Stage 04 · Evaluation Generator
          </p>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            Evaluation Dataset Generator
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            Active Project: <span className="font-medium text-slate-900">{project.name}</span> ({project.domain})
          </p>

          <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <Lock className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
              <div>
                <h2 className="text-sm font-semibold text-amber-900">
                  {needsRequirements
                    ? 'Approved Requirements Required'
                    : 'Valid Saved Agent Definition Required'}
                </h2>
                <p className="mt-1 text-xs text-amber-800 leading-relaxed max-w-xl">
                  {needsRequirements
                    ? 'Evaluation test cases cannot be generated until the project requirements are generated and approved in the Requirements stage.'
                    : 'Generate, validate, and click Save Definition in Agent Builder before generating an evaluation suite.'}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => onNavigate(needsRequirements ? 'requirements' : 'builder')}
              className="px-4 py-2 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF] transition-colors whitespace-nowrap shrink-0"
            >
              {needsRequirements ? 'Go to Requirements' : 'Go to Agent Builder'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const savedEvalVer = project.evaluation?.savedVersion ?? null;
  const datasetVersions = project.evaluation?.versions ?? [];

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header & Primary Controls */}
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-[#1E3A8A] mb-1">
              Stage 04 · Evaluation Generator
            </p>
            <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
              Evaluation Dataset
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
              <span>
                Agent:{' '}
                <strong className="text-slate-900">
                  {savedAgentRecord?.definition.agentName || project.name}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">
                Agent Definition v{savedAgentRecord?.version}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">
                {parsedDocuments.length} readable{' '}
                {parsedDocuments.length === 1 ? 'document' : 'documents'}
              </span>
              {savedEvalVer !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-emerald-700 font-medium font-mono">
                    Saved Dataset v{savedEvalVer}
                  </span>
                </>
              )}
              {hasUnsavedChanges && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-amber-700 font-medium">
                    Unsaved changes
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Primary Action Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleOpenPromptsModal}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Prompt Templates</span>
            </button>

            <button
              type="button"
              onClick={handleGenerateDataset}
              disabled={generating || parsedDocuments.length === 0}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF] disabled:opacity-50 transition-colors"
            >
              {generating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <FlaskConical className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>
                {generating
                  ? 'Generating Test Cases...'
                  : workingCases.length > 0
                    ? 'Generate New Version'
                    : 'Generate Test Cases'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => selectedCaseId && void handleRegenerateCase(selectedCaseId)}
              disabled={
                !selectedCaseId ||
                regeneratingId !== null ||
                workingCases.length === 0
              }
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
            >
              {regeneratingId === selectedCaseId && selectedCaseId ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>Regenerate Selected Test Case</span>
            </button>

            <button
              type="button"
              onClick={handleSaveEvaluationSet}
              disabled={saving || workingCases.length === 0}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {saving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>{saving ? 'Saving...' : 'Save Evaluation Set'}</span>
            </button>

            <button
              type="button"
              disabled={!canRunEvaluation}
              onClick={() => {
                setRunEvalMessage(
                  `Evaluation Dataset v${savedEvalVer} (${workingCases.length} validated test cases) is saved and verified. Live agent scoring and failure optimization are handled in Stage 05 (Optimizer).`
                );
              }}
              title={
                canRunEvaluation
                  ? 'Run evaluation against the saved test set'
                  : 'Save a valid evaluation dataset with at least 20 test cases before running evaluation'
              }
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors"
            >
              <Play className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Run Evaluation</span>
            </button>
          </div>
        </div>

        {/* Version Switcher & Optional Audit/Export Row */}
        {datasetVersions.length > 0 && (
          <div className="mt-4 pt-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1 font-medium text-slate-600">
                <History className="w-3.5 h-3.5" aria-hidden="true" />
                Dataset Versions:
              </span>
              {datasetVersions.map((ver) => {
                const isSelected = ver.version === selectedDatasetVersion;
                const isSaved = ver.version === savedEvalVer;
                return (
                  <button
                    key={ver.version}
                    type="button"
                    onClick={() => handleSwitchVersion(ver.version)}
                    className={`px-2.5 py-1 rounded-md border font-mono text-xs transition-colors ${
                      isSelected
                        ? 'border-[#1E3A8A] bg-blue-50 text-[#1E3A8A] font-semibold'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    v{ver.version} (Agent v{ver.agentVersion})
                    {isSaved ? ' · Saved' : ''}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void runServerValidation(workingCases, false)}
                disabled={validating || workingCases.length === 0}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {validating ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>Validate Rules</span>
              </button>

              <button
                type="button"
                onClick={() => void runServerValidation(workingCases, true)}
                disabled={aiAuditing || workingCases.length === 0}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {aiAuditing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="w-3.5 h-3.5 text-[#1E3A8A]" aria-hidden="true" />
                )}
                <span>{aiAuditing ? 'Auditing...' : 'AI Semantic Audit'}</span>
              </button>

              <button
                type="button"
                onClick={handleExportJson}
                disabled={workingCases.length === 0}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Export JSON</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Missing Documents Warning */}
      {parsedDocuments.length === 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 text-xs text-amber-900">
            <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">No readable knowledge documents uploaded.</span>{' '}
              At least one parsed PDF, TXT, or CSV file is required to generate document-grounded evaluation test cases without fabricating facts.
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('create')}
            className="px-3 py-1.5 rounded-lg bg-amber-800 text-white text-xs font-medium hover:bg-amber-900 whitespace-nowrap shrink-0"
          >
            Upload Documents
          </button>
        </div>
      )}

      {/* Alerts */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-[#1E3A8A] flex items-start gap-2.5">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{notice}</span>
        </div>
      )}

      {runEvalMessage && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
            <span>{runEvalMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('optimizer')}
            className="px-3 py-1.5 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 whitespace-nowrap shrink-0"
          >
            View Optimizer Stage
          </button>
        </div>
      )}

      {/* Empty State before initial generation */}
      {workingCases.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
          <div className="w-12 h-12 rounded-xl bg-blue-50 text-[#1E3A8A] flex items-center justify-center mx-auto mb-3">
            <FlaskConical className="w-6 h-6" aria-hidden="true" />
          </div>
          <h2 className="text-lg font-semibold text-slate-900">
            Generate Grounded Evaluation Test Suite
          </h2>
          <p className="mt-1.5 text-sm text-slate-600 max-w-xl mx-auto">
            ForgeAI will analyze your uploaded documents, approved requirements, and saved agent definition (v{savedAgentRecord?.version}) to create at least 20 test cases across Answerable, Out-of-Scope/Refusal, and Edge Case categories.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={handleGenerateDataset}
              disabled={generating || parsedDocuments.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#1E3A8A] text-white text-sm font-medium hover:bg-[#1E40AF] disabled:opacity-50 transition-colors"
            >
              {generating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FlaskConical className="w-4 h-4" />
              )}
              <span>
                {generating ? 'Generating 20+ Test Cases...' : 'Generate Test Cases'}
              </span>
            </button>
            <button
              type="button"
              onClick={handleOpenPromptsModal}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <BookOpen className="w-4 h-4" />
              <span>Inspect Evaluation Prompts</span>
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Dataset Summary Metrics */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Total Test Cases</p>
              <div className="mt-2 flex items-baseline justify-between">
                <p className="text-2xl font-semibold text-slate-900 font-mono tabular-nums">
                  {liveStats.total}
                </p>
                <span
                  className={`text-xs font-medium ${
                    liveStats.total >= 20 ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {liveStats.total >= 20 ? 'Min 20 met' : 'Min 20 required'}
                </span>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Category Breakdown</p>
              <div className="mt-2 space-y-1 text-xs text-slate-700 font-mono tabular-nums">
                <div className="flex justify-between">
                  <span>Answerable</span>
                  <span className="font-semibold text-slate-900">
                    {liveStats.byCategory.answerable}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Out-of-Scope</span>
                  <span className="font-semibold text-slate-900">
                    {liveStats.byCategory.out_of_scope}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Edge Cases</span>
                  <span className="font-semibold text-slate-900">
                    {liveStats.byCategory.edge_case}
                  </span>
                </div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">
                Difficulty Distribution
              </p>
              <div className="mt-2 space-y-1 text-xs text-slate-700 font-mono tabular-nums">
                <div className="flex justify-between">
                  <span>Easy</span>
                  <span className="font-semibold text-slate-900">
                    {liveStats.byDifficulty.easy}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Medium</span>
                  <span className="font-semibold text-slate-900">
                    {liveStats.byDifficulty.medium}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Hard</span>
                  <span className="font-semibold text-slate-900">
                    {liveStats.byDifficulty.hard}
                  </span>
                </div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <p className="text-xs font-medium text-slate-500">Validation &amp; Gate</p>
              <div className="mt-2">
                {validation?.valid ? (
                  <p className="text-sm font-semibold text-emerald-700 flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>All Checks Passed</span>
                  </p>
                ) : (
                  <p className="text-sm font-semibold text-red-700 flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>
                      {validation?.errors.length ?? 0} Error(s) Blocking Save
                    </span>
                  </p>
                )}
                <p className="mt-1 text-xs text-slate-500 font-mono">
                  {validation?.warnings.length ?? 0} warning(s) ·{' '}
                  {canRunEvaluation ? 'Run Evaluation Ready' : 'Run Evaluation Locked'}
                </p>
              </div>
            </div>
          </div>

          {/* Document Analysis Summary */}
          {documentAnalysisSummary && (
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#1E3A8A] mb-1.5">
                <FileText className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Document Analysis Summary</span>
              </div>
              <p className="text-sm text-slate-700 leading-relaxed">
                {documentAnalysisSummary}
              </p>
            </div>
          )}

          {/* Validation Errors & Warnings Panel */}
          {validation &&
            (validation.errors.length > 0 || validation.warnings.length > 0) && (
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-900">
                    Validation Findings
                  </h2>
                  <span className="text-xs font-mono text-slate-500">
                    Checked {formatDateTime(validation.checkedAt)}
                  </span>
                </div>

                {validation.errors.length > 0 && (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3.5 space-y-1.5">
                    <p className="text-xs font-semibold text-red-900">
                      Blocking Errors ({validation.errors.length}) — fix or regenerate before saving:
                    </p>
                    <ul className="space-y-1.5 text-xs text-red-800">
                      {validation.errors.map((issue, idx) => (
                        <li
                          key={`${issue.testCaseId ?? 'global'}-${issue.field}-${idx}`}
                          className="flex flex-wrap items-center justify-between gap-2"
                        >
                          <span>• {issue.message}</span>
                          {issue.testCaseId &&
                            workingCases.some((tc) => tc.id === issue.testCaseId) && (
                              <button
                                type="button"
                                onClick={() => void handleRegenerateCase(issue.testCaseId!)}
                                disabled={regeneratingId !== null}
                                className="px-2 py-0.5 rounded bg-white border border-red-200 text-red-800 font-medium hover:bg-red-100 disabled:opacity-50"
                              >
                                Regenerate {issue.testCaseId}
                              </button>
                            )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {validation.warnings.length > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3.5 space-y-1">
                    <p className="text-xs font-semibold text-amber-900">
                      Quality Warnings ({validation.warnings.length})
                    </p>
                    <ul className="space-y-1 text-xs text-amber-800">
                      {validation.warnings.map((issue, idx) => (
                        <li key={`warn-${issue.testCaseId ?? 'global'}-${idx}`}>
                          • {issue.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

          {/* Filter, Search, Regeneration Guidance & Add Case */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 flex-1">
                <div className="relative flex-1 min-w-[220px] max-w-md">
                  <Search
                    className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search ID, question, facts, document..."
                    aria-label="Search test cases"
                    className="w-full h-9 pl-9 pr-3 rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-[#1E3A8A]"
                  />
                </div>

                <select
                  value={categoryFilter}
                  onChange={(e) =>
                    setCategoryFilter(e.target.value as 'all' | EvaluationCategory)
                  }
                  aria-label="Filter by category"
                  className="h-9 px-3 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:border-[#1E3A8A]"
                >
                  <option value="all">All Categories ({workingCases.length})</option>
                  <option value="answerable">
                    Answerable ({liveStats.byCategory.answerable})
                  </option>
                  <option value="out_of_scope">
                    Out-of-Scope ({liveStats.byCategory.out_of_scope})
                  </option>
                  <option value="edge_case">
                    Edge Cases ({liveStats.byCategory.edge_case})
                  </option>
                </select>

                <select
                  value={difficultyFilter}
                  onChange={(e) =>
                    setDifficultyFilter(
                      e.target.value as 'all' | EvaluationDifficulty
                    )
                  }
                  aria-label="Filter by difficulty"
                  className="h-9 px-3 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:border-[#1E3A8A]"
                >
                  <option value="all">All Difficulties</option>
                  <option value="easy">Easy ({liveStats.byDifficulty.easy})</option>
                  <option value="medium">
                    Medium ({liveStats.byDifficulty.medium})
                  </option>
                  <option value="hard">Hard ({liveStats.byDifficulty.hard})</option>
                </select>
              </div>

              <button
                type="button"
                onClick={handleAddCustomCase}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 self-start lg:self-auto"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Add Custom Test Case</span>
              </button>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-2 border-t border-slate-100">
              <label
                htmlFor="regen-guidance"
                className="text-xs font-medium text-slate-600 whitespace-nowrap"
              >
                Regeneration note (optional):
              </label>
              <input
                id="regen-guidance"
                type="text"
                value={regenInstruction}
                onChange={(e) => setRegenInstruction(e.target.value)}
                placeholder="e.g., Focus on CSV pricing tiers or make the question harder"
                className="flex-1 h-8 px-3 rounded-md border border-slate-200 bg-slate-50 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-[#1E3A8A]"
              />
              <span className="text-xs text-slate-500 font-mono">
                Showing {filteredCases.length} of {workingCases.length}
              </span>
            </div>
          </div>

          {/* Test Cases List */}
          <div className="space-y-3">
            {filteredCases.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-600">
                No test cases match the current search or filter criteria.
              </div>
            ) : (
              filteredCases.map((tc) => {
                const isSelected = selectedCaseId === tc.id;
                const isExpanded = Boolean(expandedCaseIds[tc.id]);
                const isEditing = editingCaseId === tc.id && editDraft !== null;
                const caseHasError = Boolean(
                  validation?.errors.some((e) => e.testCaseId === tc.id)
                );

                return (
                  <div
                    key={tc.id}
                    className={`bg-white border rounded-xl transition-colors ${
                      caseHasError
                        ? 'border-red-300'
                        : isSelected
                          ? 'border-[#1E3A8A]'
                          : 'border-slate-200'
                    }`}
                  >
                    {/* Card Summary Header */}
                    <div className="p-4 flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <input
                          type="radio"
                          name="selected-test-case"
                          checked={isSelected}
                          onChange={() => setSelectedCaseId(tc.id)}
                          aria-label={`Select ${tc.id}`}
                          className="mt-1 h-4 w-4 accent-[#1E3A8A] shrink-0 cursor-pointer"
                        />

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs mb-1">
                            <span className="font-mono font-semibold text-slate-900">
                              {tc.id}
                            </span>
                            <span className="text-slate-300" aria-hidden="true">
                              |
                            </span>
                            <span
                              className={`font-medium ${
                                tc.category === 'answerable'
                                  ? 'text-[#1E3A8A]'
                                  : tc.category === 'out_of_scope'
                                    ? 'text-amber-800'
                                    : 'text-slate-700'
                              }`}
                            >
                              {CATEGORY_LABELS[tc.category]}
                            </span>
                            <span className="text-slate-300" aria-hidden="true">
                              |
                            </span>
                            <span className="text-slate-600">
                              Difficulty: {DIFFICULTY_LABELS[tc.difficulty]}
                            </span>
                            <span className="text-slate-300" aria-hidden="true">
                              |
                            </span>
                            <span
                              className={
                                tc.expectedRefusal
                                  ? 'font-medium text-amber-800'
                                  : 'text-emerald-700 font-medium'
                              }
                            >
                              {tc.expectedRefusal
                                ? 'Expects Refusal'
                                : 'Expects Grounded Answer'}
                            </span>
                            {tc.expectedSourceDocument && (
                              <>
                                <span className="text-slate-300" aria-hidden="true">
                                  |
                                </span>
                                <span className="font-mono text-slate-600 truncate max-w-[220px]">
                                  Source: {tc.expectedSourceDocument}
                                </span>
                              </>
                            )}
                          </div>

                          <button
                            type="button"
                            onClick={() => {
                              setSelectedCaseId(tc.id);
                              setExpandedCaseIds((prev) => ({
                                ...prev,
                                [tc.id]: !prev[tc.id],
                              }));
                            }}
                            className="text-left text-sm font-medium text-slate-900 hover:text-[#1E3A8A] leading-snug"
                          >
                            {tc.question || '(Empty question — click Edit to fill in)'}
                          </button>
                        </div>
                      </div>

                      {/* Card Controls */}
                      <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-start">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedCaseIds((prev) => ({
                              ...prev,
                              [tc.id]: !prev[tc.id],
                            }))
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          {isExpanded ? (
                            <ChevronDown className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5" />
                          )}
                          <span>{isExpanded ? 'Hide' : 'Details'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleStartEdit(tc)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          <span>Edit</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void handleRegenerateCase(tc.id)}
                          disabled={regeneratingId !== null}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-200 text-xs font-medium text-[#1E3A8A] hover:bg-blue-50 disabled:opacity-50"
                        >
                          {regeneratingId === tc.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                          <span>Regenerate</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void handleDeleteCase(tc.id)}
                          aria-label={`Delete ${tc.id}`}
                          className="p-1.5 rounded-md border border-slate-200 text-slate-400 hover:text-red-600 hover:border-red-200 hover:bg-red-50"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Expanded Details or Inline Editor */}
                    {isExpanded && (
                      <div className="px-4 pb-4 pt-3 border-t border-slate-100 bg-slate-50/50 rounded-b-xl">
                        {isEditing && editDraft ? (
                          <div className="space-y-4">
                            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">
                                  Category
                                </label>
                                <select
                                  value={editDraft.category}
                                  onChange={(e) => {
                                    const nextCat = e.target.value as EvaluationCategory;
                                    setEditDraft({
                                      ...editDraft,
                                      category: nextCat,
                                      expectedRefusal:
                                        nextCat === 'out_of_scope'
                                          ? true
                                          : nextCat === 'answerable'
                                            ? false
                                            : editDraft.expectedRefusal,
                                      expectedSourceDocument:
                                        nextCat === 'out_of_scope'
                                          ? null
                                          : editDraft.expectedSourceDocument,
                                    });
                                  }}
                                  className="w-full h-9 px-2.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-900"
                                >
                                  <option value="answerable">Answerable</option>
                                  <option value="out_of_scope">
                                    Out-of-Scope / Refusal
                                  </option>
                                  <option value="edge_case">Edge Case</option>
                                </select>
                              </div>

                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">
                                  Difficulty
                                </label>
                                <select
                                  value={editDraft.difficulty}
                                  onChange={(e) =>
                                    setEditDraft({
                                      ...editDraft,
                                      difficulty: e.target.value as EvaluationDifficulty,
                                    })
                                  }
                                  className="w-full h-9 px-2.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-900"
                                >
                                  <option value="easy">Easy</option>
                                  <option value="medium">Medium</option>
                                  <option value="hard">Hard</option>
                                </select>
                              </div>

                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">
                                  Expected Source Document
                                </label>
                                <select
                                  value={editDraft.expectedSourceDocument ?? ''}
                                  disabled={editDraft.category === 'out_of_scope'}
                                  onChange={(e) =>
                                    setEditDraft({
                                      ...editDraft,
                                      expectedSourceDocument: e.target.value || null,
                                    })
                                  }
                                  className="w-full h-9 px-2.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-900 disabled:bg-slate-100"
                                >
                                  <option value="">None</option>
                                  {parsedDocuments.map((doc) => (
                                    <option key={doc.id} value={doc.originalName}>
                                      {doc.originalName}
                                    </option>
                                  ))}
                                </select>
                              </div>

                              <div className="flex items-end pb-1">
                                <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={editDraft.expectedRefusal}
                                    disabled={editDraft.category !== 'edge_case'}
                                    onChange={(e) =>
                                      setEditDraft({
                                        ...editDraft,
                                        expectedRefusal: e.target.checked,
                                      })
                                    }
                                    className="h-4 w-4 accent-[#1E3A8A]"
                                  />
                                  <span>Expected Refusal</span>
                                </label>
                              </div>
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-slate-700 mb-1">
                                Question
                              </label>
                              <textarea
                                rows={2}
                                value={editDraft.question}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, question: e.target.value })
                                }
                                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900"
                              />
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">
                                  Expected Behavior
                                </label>
                                <textarea
                                  rows={3}
                                  value={editDraft.expectedBehavior}
                                  onChange={(e) =>
                                    setEditDraft({
                                      ...editDraft,
                                      expectedBehavior: e.target.value,
                                    })
                                  }
                                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900"
                                />
                              </div>

                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">
                                  Expected Key Facts (one per line)
                                </label>
                                <textarea
                                  rows={3}
                                  disabled={editDraft.category === 'out_of_scope'}
                                  value={editDraft.expectedKeyFacts.join('\n')}
                                  onChange={(e) =>
                                    setEditDraft({
                                      ...editDraft,
                                      expectedKeyFacts: splitLines(e.target.value),
                                    })
                                  }
                                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 disabled:bg-slate-100"
                                />
                              </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">
                                  Supporting Evidence / Scope Rule Reference
                                </label>
                                <textarea
                                  rows={2}
                                  value={editDraft.supportingEvidence}
                                  onChange={(e) =>
                                    setEditDraft({
                                      ...editDraft,
                                      supportingEvidence: e.target.value,
                                    })
                                  }
                                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900"
                                />
                              </div>

                              <div>
                                <label className="block text-xs font-medium text-slate-700 mb-1">
                                  Evaluation Reason
                                </label>
                                <textarea
                                  rows={2}
                                  value={editDraft.reason}
                                  onChange={(e) =>
                                    setEditDraft({ ...editDraft, reason: e.target.value })
                                  }
                                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900"
                                />
                              </div>
                            </div>

                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingCaseId(null);
                                  setEditDraft(null);
                                }}
                                className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleSaveInlineEdit()}
                                className="px-3.5 py-1.5 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF]"
                              >
                                Apply &amp; Re-Validate
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                            <div className="space-y-3">
                              <div>
                                <p className="font-semibold text-slate-700 mb-1">
                                  Expected Behavior
                                </p>
                                <p className="text-slate-700 leading-relaxed">
                                  {tc.expectedBehavior}
                                </p>
                              </div>

                              <div>
                                <p className="font-semibold text-slate-700 mb-1">
                                  Expected Key Facts
                                </p>
                                {tc.expectedKeyFacts.length > 0 ? (
                                  <ul className="list-disc pl-4 space-y-1 text-slate-700">
                                    {tc.expectedKeyFacts.map((fact, idx) => (
                                      <li key={`${tc.id}-fact-${idx}`}>{fact}</li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className="text-slate-500">
                                    None (refusal / boundary check)
                                  </p>
                                )}
                              </div>
                            </div>

                            <div className="space-y-3">
                              <div>
                                <p className="font-semibold text-slate-700 mb-1">
                                  Supporting Evidence &amp; Source
                                </p>
                                {tc.expectedSourceDocument && (
                                  <p className="font-mono text-[#1E3A8A] mb-1">
                                    Document: {tc.expectedSourceDocument}
                                  </p>
                                )}
                                <p className="text-slate-700 leading-relaxed bg-white border border-slate-200 rounded-lg p-2.5">
                                  {tc.supportingEvidence || 'No supporting note recorded.'}
                                </p>
                              </div>

                              <div>
                                <p className="font-semibold text-slate-700 mb-1">
                                  Test Rationale
                                </p>
                                <p className="text-slate-700 leading-relaxed">
                                  {tc.reason}
                                </p>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      {/* Evaluation Prompt Templates Modal */}
      {showPromptsModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Evaluation Prompt Templates"
        >
          <div className="bg-white border border-slate-200 rounded-xl max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Evaluation Generation Prompt Templates
                </h2>
                <p className="text-xs text-slate-500 font-mono">
                  server/prompts/evaluationPrompts.ts · Version {promptVersion || '1.0.0'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowPromptsModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                aria-label="Close prompt templates modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4">
              {loadingPrompts ? (
                <div className="flex items-center justify-center py-8 gap-2 text-sm text-slate-600">
                  <Loader2 className="w-4 h-4 animate-spin text-[#1E3A8A]" />
                  <span>Loading prompt templates...</span>
                </div>
              ) : (
                promptTemplates.map((item) => (
                  <div
                    key={item.id}
                    className="border border-slate-200 rounded-lg overflow-hidden"
                  >
                    <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-900">
                        {item.title}
                      </span>
                      <span className="text-xs font-mono text-slate-500">
                        v{item.version}
                      </span>
                    </div>
                    <pre className="p-4 text-xs font-mono text-slate-700 whitespace-pre-wrap leading-relaxed bg-white">
                      {item.template}
                    </pre>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

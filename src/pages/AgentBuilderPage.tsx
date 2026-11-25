import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Code2,
  Database,
  Download,
  FileText,
  FolderOpen,
  History,
  Loader2,
  Lock,
  RefreshCw,
  Save,
  ShieldCheck,
  Terminal,
  Wrench,
} from 'lucide-react';
import {
  ApiValidationError,
  fetchProjectById,
  generateAgentDefinition,
  regenerateAgentSection,
  saveAgentDefinition,
  validateAgentDefinition,
} from '../services/api';
import type {
  AgentDefinition,
  AgentProject,
  AgentSectionKey,
  AgentValidationResult,
  AgentVersionRecord,
  NavSectionId,
} from '../types/agent';
import { formatDateTime } from '../utils/format';

type BuilderTabId =
  | 'systemPrompt'
  | 'knowledgeConfig'
  | 'tools'
  | 'outputContract'
  | 'completeJson';

interface AgentBuilderPageProps {
  selectedProjectId: string | null;
  onNavigate: (section: NavSectionId) => void;
  onProjectsChanged: () => void;
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function compileSystemPromptPreview(definition: AgentDefinition): string {
  const sp = definition.systemPrompt;
  return [
    `# Role & Identity\n${sp.agentRoleAndIdentity}`,
    `# Main Objective\n${sp.mainObjective}`,
    `# Scope & Responsibilities\n${sp.scopeAndResponsibilities.map((s) => `- ${s}`).join('\n') || '- None specified'}`,
    `# Knowledge Document Instructions\n${sp.knowledgeDocumentInstructions}`,
    `# Rules for Answering Questions\n${sp.answeringRules.map((s) => `- ${s}`).join('\n') || '- None specified'}`,
    `# Must-Answer Topics\n${sp.mustAnswerTopics.map((s) => `- ${s}`).join('\n') || '- None specified'}`,
    `# Must-Refuse Topics\n${sp.mustRefuseTopics.map((s) => `- ${s}`).join('\n') || '- None specified'}`,
    `# Handling Missing Information\n${sp.missingInformationHandling}`,
    `# Grounding & Citation Rules\n${sp.groundingAndCitationRules}`,
    `# Response Tone & Style\n${sp.responseToneAndStyle}`,
  ].join('\n\n');
}

export function AgentBuilderPage({
  selectedProjectId,
  onNavigate,
  onProjectsChanged,
}: AgentBuilderPageProps) {
  const [project, setProject] = useState<AgentProject | null>(null);
  const [loadingProject, setLoadingProject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<BuilderTabId>('systemPrompt');
  const [selectedVersionNum, setSelectedVersionNum] = useState<number | null>(null);
  const [workingDefinition, setWorkingDefinition] = useState<AgentDefinition | null>(null);
  const [rawJsonText, setRawJsonText] = useState('');
  const [jsonSyntaxError, setJsonSyntaxError] = useState<string | null>(null);
  const [validation, setValidation] = useState<AgentValidationResult | null>(null);
  const [editSource, setEditSource] = useState<
    'generated' | 'section_regenerated' | 'manual_edit'
  >('generated');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const [generatingFull, setGeneratingFull] = useState(false);
  const [regeneratingSection, setRegeneratingSection] =
    useState<AgentSectionKey | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);

  const hydrateFromVersion = useCallback(
    (record: AgentVersionRecord | null) => {
      if (!record) {
        setSelectedVersionNum(null);
        setWorkingDefinition(null);
        setRawJsonText('');
        setJsonSyntaxError(null);
        setValidation(null);
        setHasUnsavedChanges(false);
        return;
      }
      setSelectedVersionNum(record.version);
      setWorkingDefinition(record.definition);
      setRawJsonText(JSON.stringify(record.definition, null, 2));
      setJsonSyntaxError(null);
      setValidation(record.validation);
      setEditSource(record.source);
      setHasUnsavedChanges(false);
    },
    []
  );

  const loadProject = useCallback(
    async (projectId: string) => {
      setLoadingProject(true);
      setError(null);
      setNotice(null);
      try {
        const full = await fetchProjectById(projectId);
        setProject(full);
        const versions = full.agentConfig?.versions ?? [];
        const targetVer =
          full.agentConfig?.savedVersion ?? full.agentConfig?.currentVersion ?? null;
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

  const versions = useMemo(
    () => project?.agentConfig?.versions ?? [],
    [project]
  );

  const savedVersionRecord = useMemo(() => {
    const savedNum = project?.agentConfig?.savedVersion ?? null;
    if (savedNum === null) return null;
    return versions.find((v) => v.version === savedNum) ?? null;
  }, [project, versions]);

  const canContinueToEvaluation = Boolean(
    project?.requirements?.approved &&
      savedVersionRecord &&
      savedVersionRecord.validation.valid &&
      !hasUnsavedChanges &&
      !jsonSyntaxError &&
      selectedVersionNum === savedVersionRecord.version
  );

  const updateWorkingDefinition = (
    updater: (prev: AgentDefinition) => AgentDefinition,
    sourceType: 'manual_edit' | 'section_regenerated' = 'manual_edit'
  ) => {
    setWorkingDefinition((prev) => {
      if (!prev) return prev;
      const next = updater(prev);
      setRawJsonText(JSON.stringify(next, null, 2));
      setJsonSyntaxError(null);
      setHasUnsavedChanges(true);
      setEditSource(sourceType);
      setNotice(null);
      return next;
    });
  };

  const handleSelectVersion = (versionNum: number) => {
    const found = versions.find((v) => v.version === versionNum) ?? null;
    setError(null);
    setNotice(null);
    hydrateFromVersion(found);
  };

  const handleGenerateFull = async () => {
    if (!project) return;
    setGeneratingFull(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await generateAgentDefinition(project.id);
      setProject(updated);
      const latest =
        updated.agentConfig?.versions.find(
          (v) => v.version === updated.agentConfig?.currentVersion
        ) ??
        updated.agentConfig?.versions[updated.agentConfig.versions.length - 1] ??
        null;
      hydrateFromVersion(latest);
      setNotice(
        latest
          ? `Generated version v${latest.version}. Review the sections and click Save Definition before continuing to Evaluation.`
          : 'Generated agent definition.'
      );
      onProjectsChanged();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to generate agent definition.'
      );
    } finally {
      setGeneratingFull(false);
    }
  };

  const handleRegenerateSection = async (section: AgentSectionKey) => {
    if (!project || !workingDefinition) return;
    if (jsonSyntaxError) {
      setError('Fix the Complete JSON syntax error before regenerating a section.');
      return;
    }

    setRegeneratingSection(section);
    setError(null);
    setNotice(null);
    try {
      const result = await regenerateAgentSection(
        project.id,
        section,
        workingDefinition
      );
      setWorkingDefinition(result.definition);
      setRawJsonText(JSON.stringify(result.definition, null, 2));
      setJsonSyntaxError(null);
      setValidation(result.validation);
      setEditSource('section_regenerated');
      setHasUnsavedChanges(true);
      setNotice(
        `Regenerated ${section}. Click Save Definition to persist as a new saved version.`
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : `Failed to regenerate ${section}.`
      );
    } finally {
      setRegeneratingSection(null);
    }
  };

  const parseRawJsonIfNeeded = (): AgentDefinition | null => {
    if (activeTab !== 'completeJson') {
      return workingDefinition;
    }
    try {
      const parsed = JSON.parse(rawJsonText) as AgentDefinition;
      setJsonSyntaxError(null);
      return parsed;
    } catch (err) {
      setJsonSyntaxError(
        err instanceof Error ? err.message : 'Invalid JSON syntax.'
      );
      return null;
    }
  };

  const handleApplyRawJson = () => {
    setError(null);
    setNotice(null);
    try {
      const parsed = JSON.parse(rawJsonText) as AgentDefinition;
      setWorkingDefinition(parsed);
      setRawJsonText(JSON.stringify(parsed, null, 2));
      setJsonSyntaxError(null);
      setHasUnsavedChanges(true);
      setEditSource('manual_edit');
      setNotice('Applied JSON changes to the editor. Run Validate or Save Definition.');
    } catch (err) {
      setJsonSyntaxError(
        err instanceof Error ? err.message : 'Invalid JSON syntax.'
      );
    }
  };

  const handleValidate = async () => {
    if (!project) return;
    const candidate = parseRawJsonIfNeeded();
    if (!candidate) {
      setError('Cannot validate: Complete JSON contains a syntax error.');
      return;
    }

    setValidating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await validateAgentDefinition(project.id, candidate);
      setWorkingDefinition(res.definition);
      setRawJsonText(JSON.stringify(res.definition, null, 2));
      setValidation(res.validation);
      setNotice(
        res.validation.valid
          ? 'Validation passed with no errors.'
          : `Validation found ${res.validation.errors.length} error(s).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Validation failed.');
    } finally {
      setValidating(false);
    }
  };

  const handleSaveDefinition = async () => {
    if (!project) return;
    const candidate = parseRawJsonIfNeeded();
    if (!candidate) {
      setError('Fix the JSON syntax error before saving.');
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await saveAgentDefinition(project.id, {
        definition: candidate,
        baseVersion: selectedVersionNum,
        source: editSource,
      });
      setProject(res.project);
      const savedVer = res.project.agentConfig?.savedVersion ?? null;
      const savedObj =
        res.project.agentConfig?.versions.find((v) => v.version === savedVer) ?? null;
      hydrateFromVersion(savedObj);
      setValidation(res.validation);
      setNotice(
        `Saved agent definition v${savedVer} (${formatDateTime(
          res.project.agentConfig?.savedAt ?? new Date().toISOString()
        )}).`
      );
      onProjectsChanged();
    } catch (err) {
      if (err instanceof ApiValidationError && err.validation) {
        setValidation(err.validation);
      }
      setError(
        err instanceof Error ? err.message : 'Failed to save agent definition.'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadAgentJson = () => {
    if (!workingDefinition || !project) return;
    const blob = new Blob([JSON.stringify(workingDefinition, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const slug =
      (workingDefinition.agentName || project.name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'agent';
    link.href = url;
    link.download = `${slug}-v${selectedVersionNum ?? 1}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (!selectedProjectId) {
    return (
      <div className="max-w-4xl mx-auto bg-white border border-slate-200 rounded-xl p-8 text-center">
        <div className="w-11 h-11 rounded-xl bg-slate-100 text-[#1E3A8A] flex items-center justify-center mx-auto mb-3">
          <FolderOpen className="w-5 h-5" aria-hidden="true" />
        </div>
        <h1 className="text-lg font-semibold text-slate-900">No Project Selected</h1>
        <p className="mt-1 text-sm text-slate-600 max-w-md mx-auto">
          Create or select an agent project with approved requirements before building its agent definition.
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

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header & Project Context */}
      <div className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-[#1E3A8A] mb-1">
              Stage 03 · Declarative Agent Architecture
            </p>
            <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
              Agent Builder
            </h1>
            {project && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
                <span className="font-semibold text-slate-900">
                  {project.requirements?.agentName || project.name}
                </span>
                <span aria-hidden="true">·</span>
                <span>Project: {project.name}</span>
                <span aria-hidden="true">·</span>
                <span>{project.domain}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {project.documents.length}{' '}
                  {project.documents.length === 1 ? 'document' : 'documents'}
                </span>
                {savedVersionRecord ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="font-medium text-emerald-700">
                      Saved v{savedVersionRecord.version} (
                      {formatDateTime(
                        project.agentConfig?.savedAt ?? savedVersionRecord.updatedAt
                      )}
                      )
                    </span>
                  </>
                ) : (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-slate-600">No saved version yet</span>
                  </>
                )}
              </div>
            )}
          </div>

          {project?.requirements?.approved && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleGenerateFull}
                disabled={generatingFull || Boolean(regeneratingSection) || saving}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF] disabled:opacity-50 transition-colors"
              >
                {generatingFull ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>
                  {generatingFull
                    ? 'Generating Agent...'
                    : versions.length > 0
                      ? 'Generate New Version'
                      : 'Generate Agent Definition'}
                </span>
              </button>

              {workingDefinition && (
                <>
                  <button
                    type="button"
                    onClick={handleValidate}
                    disabled={validating || saving || generatingFull}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                  >
                    {validating ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <ShieldCheck className="w-3.5 h-3.5 text-[#1E3A8A]" aria-hidden="true" />
                    )}
                    <span>Validate JSON</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleSaveDefinition}
                    disabled={saving || generatingFull || Boolean(jsonSyntaxError)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 disabled:opacity-50 transition-colors"
                  >
                    {saving ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Save className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>{saving ? 'Saving...' : 'Save Definition'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onNavigate('evaluation')}
                    disabled={!canContinueToEvaluation}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <span>Continue to Evaluation</span>
                    <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Status hint for Continue to Evaluation gate */}
        {project?.requirements?.approved && workingDefinition && !canContinueToEvaluation && (
          <p className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-2">
            {jsonSyntaxError
              ? 'Complete JSON contains syntax errors. Fix and save before continuing to Evaluation.'
              : hasUnsavedChanges
                ? 'You have unsaved edits or regenerated sections. Click Save Definition to validate and unlock Evaluation.'
                : !savedVersionRecord || selectedVersionNum !== savedVersionRecord.version
                  ? 'Click Save Definition to mark this version as the active saved configuration before continuing to Evaluation.'
                  : 'Fix all validation errors and save before continuing to Evaluation.'}
          </p>
        )}
      </div>

      {/* Feedback alerts */}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 flex items-start gap-2.5">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}

      {loadingProject ? (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
          <div className="h-6 w-56 bg-slate-100 rounded" />
          <div className="h-32 bg-slate-100 rounded-lg" />
        </div>
      ) : !project ? null : !project.requirements?.approved ? (
        /* Prerequisites Lock Banner */
        <div className="bg-white border border-amber-200 rounded-xl p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <Lock className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Requirements Approval Required
                </h2>
                <p className="mt-1 text-sm text-slate-600 leading-relaxed">
                  {project.requirements
                    ? 'Structured requirements have been generated for this project, but they have not been approved yet. Approve the requirements first to unlock Agent Builder.'
                    : 'This project does not have approved requirements yet. Complete the Intake Interview and approve the generated requirements first.'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('requirements')}
              className="px-4 py-2 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF] transition-colors whitespace-nowrap shrink-0"
            >
              Go to Requirements
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Approved Requirements & Documents Context Bar */}
          <section className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
              <div>
                <p className="font-semibold text-slate-500">Approved Purpose</p>
                <p className="mt-1 text-slate-800 leading-relaxed line-clamp-3">
                  {project.requirements.agentPurpose}
                </p>
              </div>
              <div>
                <p className="font-semibold text-slate-500">
                  Must-Answer / Must-Refuse Counts
                </p>
                <p className="mt-1 text-slate-800 tabular-nums">
                  {project.requirements.mustAnswerTopics.length} must-answer ·{' '}
                  {project.requirements.mustRefuseTopics.length} must-refuse ·{' '}
                  Groundability: {project.requirements.groundability.overallStatus}
                </p>
              </div>
              <div>
                <p className="font-semibold text-slate-500">Knowledge Corpus</p>
                <p className="mt-1 text-slate-800 tabular-nums">
                  {project.documents.filter((d) => d.parseStatus === 'parsed').length} parsed
                  documents ({project.documents.map((d) => d.originalName).join(', ') || 'None'})
                </p>
              </div>
            </div>
          </section>

          {!workingDefinition ? (
            <section className="bg-white border border-slate-200 rounded-xl p-10 text-center">
              <div className="w-11 h-11 rounded-xl bg-slate-100 text-[#1E3A8A] flex items-center justify-center mx-auto mb-3">
                <Wrench className="w-5 h-5" aria-hidden="true" />
              </div>
              <h2 className="text-base font-semibold text-slate-900">
                Ready to Build Declarative Agent Definition
              </h2>
              <p className="mt-1 text-sm text-slate-600 max-w-xl mx-auto">
                Click <strong>Generate Agent Definition</strong> to create structured JSON for the System Prompt, Knowledge Configuration, Tool Registry selection, and Output Contract from your approved requirements.
              </p>
              <button
                type="button"
                onClick={handleGenerateFull}
                disabled={generatingFull}
                className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#1E3A8A] text-white text-sm font-medium hover:bg-[#1E40AF] disabled:opacity-50 transition-colors"
              >
                {generatingFull ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Wrench className="w-4 h-4" aria-hidden="true" />
                )}
                <span>
                  {generatingFull ? 'Generating Agent Definition...' : 'Generate Agent Definition'}
                </span>
              </button>
            </section>
          ) : (
            <>
              {/* Version History & Validation Row */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Version Selector */}
                <section className="bg-white border border-slate-200 rounded-xl p-5">
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                      <History className="w-4 h-4 text-[#1E3A8A]" aria-hidden="true" />
                      <span>Agent Versions ({versions.length})</span>
                    </h2>
                  </div>
                  <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
                    {[...versions].reverse().map((ver) => {
                      const isViewing = ver.version === selectedVersionNum;
                      const isSaved = ver.version === project.agentConfig?.savedVersion;
                      return (
                        <button
                          key={ver.version}
                          type="button"
                          onClick={() => handleSelectVersion(ver.version)}
                          className={`w-full text-left px-3 py-2 rounded-lg border text-xs transition-colors ${
                            isViewing
                              ? 'border-[#1E3A8A] bg-blue-50/60'
                              : 'border-slate-200 hover:bg-slate-50'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-slate-900 font-mono">
                              v{ver.version}
                              {isSaved ? ' · Saved' : ''}
                            </span>
                            <span
                              className={
                                ver.validation.valid
                                  ? 'text-emerald-700 font-medium'
                                  : 'text-red-700 font-medium'
                              }
                            >
                              {ver.validation.valid ? 'Valid' : 'Needs fixes'}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                            {formatDateTime(ver.createdAt)} · {ver.source.replace('_', ' ')}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </section>

                {/* Validation Panel */}
                <section className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                      {validation?.valid && !hasUnsavedChanges ? (
                        <CheckCircle2
                          className="w-4 h-4 text-emerald-700"
                          aria-hidden="true"
                        />
                      ) : (
                        <AlertTriangle
                          className="w-4 h-4 text-amber-600"
                          aria-hidden="true"
                        />
                      )}
                      <span>Requirements &amp; Groundability Validation</span>
                    </h2>
                    {validation && (
                      <span className="text-xs text-slate-500 tabular-nums">
                        Checked {formatDateTime(validation.checkedAt)} ·{' '}
                        {validation.errors.length} error(s), {validation.warnings.length}{' '}
                        warning(s)
                      </span>
                    )}
                  </div>

                  {!validation ? (
                    <p className="text-xs text-slate-500">
                      Click Validate JSON or Save Definition to run structural and requirement-contradiction checks.
                    </p>
                  ) : validation.errors.length === 0 && validation.warnings.length === 0 ? (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900">
                      All structural, grounding, and requirement-alignment checks passed with zero contradictions.
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
                      {validation.errors.map((issue, idx) => (
                        <div
                          key={`err-${idx}`}
                          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800"
                        >
                          <span className="font-mono font-semibold">{issue.field}:</span>{' '}
                          {issue.message}
                        </div>
                      ))}
                      {validation.warnings.map((issue, idx) => (
                        <div
                          key={`warn-${idx}`}
                          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
                        >
                          <span className="font-mono font-semibold">{issue.field}:</span>{' '}
                          {issue.message}
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              {/* 5-Tab Agent Definition Preview & Editor */}
              <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="border-b border-slate-200 bg-slate-50 px-4 pt-3 flex flex-wrap items-center gap-1">
                  {(
                    [
                      { id: 'systemPrompt', label: 'System Prompt', icon: Terminal },
                      { id: 'knowledgeConfig', label: 'Knowledge Configuration', icon: Database },
                      { id: 'tools', label: 'Tools', icon: Wrench },
                      { id: 'outputContract', label: 'Output Contract', icon: FileText },
                      { id: 'completeJson', label: 'Complete JSON', icon: Code2 },
                    ] as const
                  ).map((tab) => {
                    const Icon = tab.icon;
                    const isActive = activeTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setActiveTab(tab.id)}
                        className={`inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium rounded-t-lg border-b-2 transition-colors ${
                          isActive
                            ? 'border-[#1E3A8A] bg-white text-[#1E3A8A]'
                            : 'border-transparent text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{tab.label}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="p-6">
                  {/* TAB 1: SYSTEM PROMPT */}
                  {activeTab === 'systemPrompt' && (
                    <div className="space-y-6">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
                        <div>
                          <h2 className="text-base font-semibold text-slate-900">
                            System Prompt Specification
                          </h2>
                          <p className="text-xs text-slate-500 mt-0.5">
                            Inspect or edit the structured prompt sections. Changes sync directly to Complete JSON.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRegenerateSection('systemPrompt')}
                          disabled={Boolean(regeneratingSection) || generatingFull}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 shrink-0"
                        >
                          {regeneratingSection === 'systemPrompt' ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                          )}
                          <span>Regenerate System Prompt</span>
                        </button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Agent Role and Identity
                          </span>
                          <textarea
                            rows={3}
                            value={workingDefinition.systemPrompt.agentRoleAndIdentity}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                systemPrompt: {
                                  ...prev.systemPrompt,
                                  agentRoleAndIdentity: e.target.value,
                                },
                              }))
                            }
                            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Main Objective
                          </span>
                          <textarea
                            rows={3}
                            value={workingDefinition.systemPrompt.mainObjective}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                systemPrompt: {
                                  ...prev.systemPrompt,
                                  mainObjective: e.target.value,
                                },
                              }))
                            }
                            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Scope and Responsibilities (one per line)
                          </span>
                          <textarea
                            rows={4}
                            value={workingDefinition.systemPrompt.scopeAndResponsibilities.join('\n')}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                systemPrompt: {
                                  ...prev.systemPrompt,
                                  scopeAndResponsibilities: splitLines(e.target.value),
                                },
                              }))
                            }
                            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Rules for Answering Questions (one per line)
                          </span>
                          <textarea
                            rows={4}
                            value={workingDefinition.systemPrompt.answeringRules.join('\n')}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                systemPrompt: {
                                  ...prev.systemPrompt,
                                  answeringRules: splitLines(e.target.value),
                                },
                              }))
                            }
                            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Must-Answer Topics (one per line)
                          </span>
                          <textarea
                            rows={4}
                            value={workingDefinition.systemPrompt.mustAnswerTopics.join('\n')}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                systemPrompt: {
                                  ...prev.systemPrompt,
                                  mustAnswerTopics: splitLines(e.target.value),
                                },
                              }))
                            }
                            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Must-Refuse Topics (one per line)
                          </span>
                          <textarea
                            rows={4}
                            value={workingDefinition.systemPrompt.mustRefuseTopics.join('\n')}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                systemPrompt: {
                                  ...prev.systemPrompt,
                                  mustRefuseTopics: splitLines(e.target.value),
                                },
                              }))
                            }
                            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Instructions for Using Knowledge Documents
                          </span>
                          <textarea
                            rows={3}
                            value={workingDefinition.systemPrompt.knowledgeDocumentInstructions}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                systemPrompt: {
                                  ...prev.systemPrompt,
                                  knowledgeDocumentInstructions: e.target.value,
                                },
                              }))
                            }
                            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Instructions for Handling Missing Information
                          </span>
                          <textarea
                            rows={3}
                            value={workingDefinition.systemPrompt.missingInformationHandling}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                systemPrompt: {
                                  ...prev.systemPrompt,
                                  missingInformationHandling: e.target.value,
                                },
                              }))
                            }
                            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Grounding and Citation Rules
                          </span>
                          <textarea
                            rows={3}
                            value={workingDefinition.systemPrompt.groundingAndCitationRules}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                systemPrompt: {
                                  ...prev.systemPrompt,
                                  groundingAndCitationRules: e.target.value,
                                },
                              }))
                            }
                            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Response Tone and Style
                          </span>
                          <textarea
                            rows={3}
                            value={workingDefinition.systemPrompt.responseToneAndStyle}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                systemPrompt: {
                                  ...prev.systemPrompt,
                                  responseToneAndStyle: e.target.value,
                                },
                              }))
                            }
                            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>
                      </div>

                      <div className="pt-4 border-t border-slate-100">
                        <p className="text-xs font-semibold text-slate-700 mb-2">
                          Compiled System Prompt Preview
                        </p>
                        <pre className="rounded-lg border border-slate-200 bg-slate-950 text-slate-100 p-4 text-xs font-mono whitespace-pre-wrap leading-relaxed max-h-72 overflow-y-auto">
                          {compileSystemPromptPreview(workingDefinition)}
                        </pre>
                      </div>
                    </div>
                  )}

                  {/* TAB 2: KNOWLEDGE CONFIGURATION */}
                  {activeTab === 'knowledgeConfig' && (
                    <div className="space-y-6">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
                        <div>
                          <h2 className="text-base font-semibold text-slate-900">
                            Knowledge &amp; Retrieval Configuration
                          </h2>
                          <p className="text-xs text-slate-500 mt-0.5">
                            {workingDefinition.knowledgeConfig.implementationNote}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRegenerateSection('knowledgeConfig')}
                          disabled={Boolean(regeneratingSection) || generatingFull}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 shrink-0"
                        >
                          {regeneratingSection === 'knowledgeConfig' ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                          )}
                          <span>Regenerate Knowledge Config</span>
                        </button>
                      </div>

                      <div>
                        <p className="text-xs font-medium text-slate-700 mb-2">
                          Supported Document Types
                        </p>
                        <div className="flex flex-wrap gap-4">
                          {(['pdf', 'txt', 'csv'] as const).map((docType) => {
                            const checked =
                              workingDefinition.knowledgeConfig.supportedDocumentTypes.includes(
                                docType
                              );
                            return (
                              <label
                                key={docType}
                                className="inline-flex items-center gap-2 text-sm text-slate-800 cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    const isChecked = e.target.checked;
                                    updateWorkingDefinition((prev) => {
                                      const current =
                                        prev.knowledgeConfig.supportedDocumentTypes;
                                      const nextTypes = isChecked
                                        ? Array.from(new Set([...current, docType]))
                                        : current.filter((t) => t !== docType);
                                      return {
                                        ...prev,
                                        knowledgeConfig: {
                                          ...prev.knowledgeConfig,
                                          supportedDocumentTypes: nextTypes,
                                        },
                                      };
                                    });
                                  }}
                                  className="rounded border-slate-300 text-[#1E3A8A]"
                                />
                                <span className="font-mono uppercase text-xs">{docType}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Chunking Strategy
                          </span>
                          <input
                            type="text"
                            value={workingDefinition.knowledgeConfig.chunkingStrategy}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                knowledgeConfig: {
                                  ...prev.knowledgeConfig,
                                  chunkingStrategy: e.target.value,
                                },
                              }))
                            }
                            className="mt-1 w-full h-10 px-3 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Chunk Size (chars/tokens)
                          </span>
                          <input
                            type="number"
                            min={100}
                            max={4000}
                            value={workingDefinition.knowledgeConfig.chunkSize}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                knowledgeConfig: {
                                  ...prev.knowledgeConfig,
                                  chunkSize: Number(e.target.value),
                                },
                              }))
                            }
                            className="mt-1 w-full h-10 px-3 rounded-lg border border-slate-200 text-sm font-mono text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Chunk Overlap
                          </span>
                          <input
                            type="number"
                            min={0}
                            max={2000}
                            value={workingDefinition.knowledgeConfig.chunkOverlap}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                knowledgeConfig: {
                                  ...prev.knowledgeConfig,
                                  chunkOverlap: Number(e.target.value),
                                },
                              }))
                            }
                            className="mt-1 w-full h-10 px-3 rounded-lg border border-slate-200 text-sm font-mono text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Retrieval Method
                          </span>
                          <input
                            type="text"
                            value={workingDefinition.knowledgeConfig.retrievalMethod}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                knowledgeConfig: {
                                  ...prev.knowledgeConfig,
                                  retrievalMethod: e.target.value,
                                },
                              }))
                            }
                            className="mt-1 w-full h-10 px-3 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Top-K Retrieval Value
                          </span>
                          <input
                            type="number"
                            min={1}
                            max={20}
                            value={workingDefinition.knowledgeConfig.topK}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                knowledgeConfig: {
                                  ...prev.knowledgeConfig,
                                  topK: Number(e.target.value),
                                },
                              }))
                            }
                            className="mt-1 w-full h-10 px-3 rounded-lg border border-slate-200 text-sm font-mono text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Similarity Threshold (0.0 – 1.0)
                          </span>
                          <input
                            type="number"
                            step={0.05}
                            min={0}
                            max={1}
                            value={workingDefinition.knowledgeConfig.similarityThreshold}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                knowledgeConfig: {
                                  ...prev.knowledgeConfig,
                                  similarityThreshold: Number(e.target.value),
                                },
                              }))
                            }
                            className="mt-1 w-full h-10 px-3 rounded-lg border border-slate-200 text-sm font-mono text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Source Citation Requirements
                          </span>
                          <textarea
                            rows={3}
                            value={workingDefinition.knowledgeConfig.sourceCitationRequirements}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                knowledgeConfig: {
                                  ...prev.knowledgeConfig,
                                  sourceCitationRequirements: e.target.value,
                                },
                              }))
                            }
                            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Why These Defaults Were Selected
                          </span>
                          <textarea
                            rows={3}
                            value={workingDefinition.knowledgeConfig.rationale}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                knowledgeConfig: {
                                  ...prev.knowledgeConfig,
                                  rationale: e.target.value,
                                },
                              }))
                            }
                            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>
                      </div>
                    </div>
                  )}

                  {/* TAB 3: TOOLS */}
                  {activeTab === 'tools' && (
                    <div className="space-y-6">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
                        <div>
                          <h2 className="text-base font-semibold text-slate-900">
                            Tool Registry &amp; Selection
                          </h2>
                          <p className="text-xs text-slate-500 mt-0.5">
                            Declarative tool specifications from the ForgeAI registry. Runtime execution is wired in the Chat/Evaluation stages.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRegenerateSection('tools')}
                          disabled={Boolean(regeneratingSection) || generatingFull}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 shrink-0"
                        >
                          {regeneratingSection === 'tools' ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                          )}
                          <span>Regenerate Tool Selection</span>
                        </button>
                      </div>

                      <div className="space-y-4">
                        {workingDefinition.tools.map((tool, index) => (
                          <div
                            key={tool.id}
                            className={`rounded-xl border p-5 transition-colors ${
                              tool.selected
                                ? 'border-[#1E3A8A] bg-blue-50/20'
                                : 'border-slate-200 bg-slate-50/40'
                            }`}
                          >
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                              <label className="inline-flex items-center gap-3 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={tool.selected}
                                  onChange={(e) => {
                                    const checked = e.target.checked;
                                    updateWorkingDefinition((prev) => ({
                                      ...prev,
                                      tools: prev.tools.map((t, i) =>
                                        i === index ? { ...t, selected: checked } : t
                                      ),
                                    }));
                                  }}
                                  className="w-4 h-4 rounded border-slate-300 text-[#1E3A8A]"
                                />
                                <span>
                                  <span className="text-sm font-semibold text-slate-900">
                                    {tool.toolName}
                                  </span>
                                  <span className="block text-xs text-slate-500 mt-0.5">
                                    ID: <span className="font-mono">{tool.id}</span> ·{' '}
                                    {tool.requiresApiKey ? 'Requires API Key' : 'No API Key Required'} ·{' '}
                                    Specification Only (Not Executed Here)
                                  </span>
                                </span>
                              </label>
                              <span
                                className={`text-xs font-medium ${
                                  tool.selected ? 'text-[#1E3A8A]' : 'text-slate-500'
                                }`}
                              >
                                {tool.selected ? 'Selected for Agent' : 'Not Selected'}
                              </span>
                            </div>

                            <p className="mt-3 text-sm text-slate-700">{tool.description}</p>
                            <p className="mt-1 text-xs text-slate-500">
                              <span className="font-medium text-slate-700">Selection note:</span>{' '}
                              {tool.selectionReason}
                            </p>

                            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                              <label className="block">
                                <span className="text-xs font-medium text-slate-700">
                                  When the Agent Should Use It
                                </span>
                                <textarea
                                  rows={2}
                                  value={tool.whenToUse}
                                  onChange={(e) =>
                                    updateWorkingDefinition((prev) => ({
                                      ...prev,
                                      tools: prev.tools.map((t, i) =>
                                        i === index
                                          ? { ...t, whenToUse: e.target.value }
                                          : t
                                      ),
                                    }))
                                  }
                                  className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                                />
                              </label>

                              <label className="block">
                                <span className="text-xs font-medium text-slate-700">
                                  When the Agent Should Not Use It
                                </span>
                                <textarea
                                  rows={2}
                                  value={tool.whenNotToUse}
                                  onChange={(e) =>
                                    updateWorkingDefinition((prev) => ({
                                      ...prev,
                                      tools: prev.tools.map((t, i) =>
                                        i === index
                                          ? { ...t, whenNotToUse: e.target.value }
                                          : t
                                      ),
                                    }))
                                  }
                                  className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                                />
                              </label>
                            </div>

                            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div>
                                <p className="text-xs font-medium text-slate-600 mb-1">
                                  Input Schema
                                </p>
                                <pre className="rounded-lg border border-slate-200 bg-slate-950 text-slate-100 p-3 text-[11px] font-mono overflow-x-auto">
                                  {JSON.stringify(tool.inputSchema, null, 2)}
                                </pre>
                              </div>
                              <div>
                                <p className="text-xs font-medium text-slate-600 mb-1">
                                  Output Schema
                                </p>
                                <pre className="rounded-lg border border-slate-200 bg-slate-950 text-slate-100 p-3 text-[11px] font-mono overflow-x-auto">
                                  {JSON.stringify(tool.outputSchema, null, 2)}
                                </pre>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* TAB 4: OUTPUT CONTRACT */}
                  {activeTab === 'outputContract' && (
                    <div className="space-y-6">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
                        <div>
                          <h2 className="text-base font-semibold text-slate-900">
                            Output Contract
                          </h2>
                          <p className="text-xs text-slate-500 mt-0.5">
                            Defines expected structure, formatting, citations, refusals, and error handling.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRegenerateSection('outputContract')}
                          disabled={Boolean(regeneratingSection) || generatingFull}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 shrink-0"
                        >
                          {regeneratingSection === 'outputContract' ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                          )}
                          <span>Regenerate Output Contract</span>
                        </button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Required Response Structure (one step per line)
                          </span>
                          <textarea
                            rows={4}
                            value={workingDefinition.outputContract.requiredResponseStructure.join(
                              '\n'
                            )}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                outputContract: {
                                  ...prev.outputContract,
                                  requiredResponseStructure: splitLines(e.target.value),
                                },
                              }))
                            }
                            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Error-Handling Rules (one rule per line)
                          </span>
                          <textarea
                            rows={4}
                            value={workingDefinition.outputContract.errorHandlingRules.join(
                              '\n'
                            )}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                outputContract: {
                                  ...prev.outputContract,
                                  errorHandlingRules: splitLines(e.target.value),
                                },
                              }))
                            }
                            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Expected Output Format
                          </span>
                          <input
                            type="text"
                            value={workingDefinition.outputContract.expectedOutputFormat}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                outputContract: {
                                  ...prev.outputContract,
                                  expectedOutputFormat: e.target.value,
                                },
                              }))
                            }
                            className="mt-1 w-full h-10 px-3 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>

                        <label className="block">
                          <span className="text-xs font-medium text-slate-700">
                            Citation Format
                          </span>
                          <input
                            type="text"
                            value={workingDefinition.outputContract.citationFormat}
                            onChange={(e) =>
                              updateWorkingDefinition((prev) => ({
                                ...prev,
                                outputContract: {
                                  ...prev.outputContract,
                                  citationFormat: e.target.value,
                                },
                              }))
                            }
                            className="mt-1 w-full h-10 px-3 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                          />
                        </label>
                      </div>

                      <label className="block">
                        <span className="text-xs font-medium text-slate-700">
                          Refusal Format
                        </span>
                        <textarea
                          rows={3}
                          value={workingDefinition.outputContract.refusalFormat}
                          onChange={(e) =>
                            updateWorkingDefinition((prev) => ({
                              ...prev,
                              outputContract: {
                                ...prev.outputContract,
                                refusalFormat: e.target.value,
                              },
                            }))
                          }
                          className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                        />
                      </label>
                    </div>
                  )}

                  {/* TAB 5: COMPLETE JSON */}
                  {activeTab === 'completeJson' && (
                    <div className="space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100">
                        <div>
                          <h2 className="text-base font-semibold text-slate-900">
                            Complete Declarative Agent JSON
                          </h2>
                          <p className="text-xs text-slate-500 mt-0.5">
                            Edit raw JSON directly, apply changes back to all tabs, or download the configuration file.
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={handleApplyRawJson}
                            className="px-3 py-1.5 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF] transition-colors"
                          >
                            Apply JSON to Tabs
                          </button>
                          <button
                            type="button"
                            onClick={handleDownloadAgentJson}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                          >
                            <Download className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Download JSON</span>
                          </button>
                        </div>
                      </div>

                      {jsonSyntaxError && (
                        <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700 font-mono">
                          JSON Syntax Error: {jsonSyntaxError}
                        </div>
                      )}

                      <textarea
                        rows={22}
                        spellCheck={false}
                        value={rawJsonText}
                        onChange={(e) => {
                          const text = e.target.value;
                          setRawJsonText(text);
                          setHasUnsavedChanges(true);
                          setEditSource('manual_edit');
                          try {
                            const parsed = JSON.parse(text) as AgentDefinition;
                            setJsonSyntaxError(null);
                            setWorkingDefinition(parsed);
                          } catch (err) {
                            setJsonSyntaxError(
                              err instanceof Error ? err.message : 'Invalid JSON syntax.'
                            );
                          }
                        }}
                        className="w-full px-4 py-3 rounded-lg border border-slate-200 bg-slate-950 text-slate-100 text-xs font-mono leading-relaxed focus:outline-none focus:border-[#1E3A8A]"
                      />
                    </div>
                  )}
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}

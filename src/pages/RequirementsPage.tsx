import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Edit3,
  FileText,
  FolderOpen,
  Loader2,
  MessageSquareMore,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SkipForward,
} from 'lucide-react';
import {
  approveRequirements,
  fetchProjectById,
  generateRequirements,
  startIntakeInterview,
  submitInterviewAnswer,
  updateRequirements,
} from '../services/api';
import type {
  AgentProject,
  AgentRequirements,
  GroundabilityStatus,
  NavSectionId,
} from '../types/agent';
import { formatDateTime } from '../utils/format';

interface RequirementsPageProps {
  selectedProjectId: string | null;
  onNavigate: (section: NavSectionId) => void;
  onProjectsChanged: () => void;
}

interface EditableDraft {
  agentName: string;
  agentPurpose: string;
  scopeText: string;
  targetAudience: string;
  responseToneAndStyle: string;
  mustAnswerTopicsText: string;
  mustRefuseTopicsText: string;
  knowledgeSourcesAvailableText: string;
  outOfScopeTopicsText: string;
  missingInformationOrAssumptionsText: string;
}

function toEditableDraft(req: AgentRequirements): EditableDraft {
  return {
    agentName: req.agentName,
    agentPurpose: req.agentPurpose,
    scopeText: req.scope.join('\n'),
    targetAudience: req.targetAudience,
    responseToneAndStyle: req.responseToneAndStyle,
    mustAnswerTopicsText: req.mustAnswerTopics.join('\n'),
    mustRefuseTopicsText: req.mustRefuseTopics.join('\n'),
    knowledgeSourcesAvailableText: req.knowledgeSourcesAvailable.join('\n'),
    outOfScopeTopicsText: req.outOfScopeTopics.join('\n'),
    missingInformationOrAssumptionsText: req.missingInformationOrAssumptions.join('\n'),
  };
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function RequirementsPage({
  selectedProjectId,
  onNavigate,
  onProjectsChanged,
}: RequirementsPageProps) {
  const [project, setProject] = useState<AgentProject | null>(null);
  const [loadingProject, setLoadingProject] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [startingInterview, setStartingInterview] = useState(false);
  const [submittingAnswer, setSubmittingAnswer] = useState(false);
  const [generatingReqs, setGeneratingReqs] = useState(false);
  const [savingEdits, setSavingEdits] = useState(false);
  const [approving, setApproving] = useState(false);

  const [answerInput, setAnswerInput] = useState('');
  const [forceInterviewMode, setForceInterviewMode] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<EditableDraft | null>(null);

  const loadProject = useCallback(async (projectId: string) => {
    setLoadingProject(true);
    setError(null);
    try {
      const fullProject = await fetchProjectById(projectId);
      setProject(fullProject);
      setIsEditing(false);
      setDraft(null);
      setForceInterviewMode(false);
      setAnswerInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project.');
      setProject(null);
    } finally {
      setLoadingProject(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setProject(null);
      return;
    }
    void loadProject(selectedProjectId);
  }, [selectedProjectId, loadProject]);

  const parsedDocs = useMemo(
    () =>
      project?.documents.filter((doc) => doc.parseStatus === 'parsed') ?? [],
    [project]
  );

  const currentQuestion = useMemo(() => {
    const interview = project?.intakeInterview;
    if (!interview || interview.status === 'completed') return null;
    const answeredIds = new Set(interview.answers.map((a) => a.questionId));
    const idx = interview.questions.findIndex((q) => !answeredIds.has(q.id));
    if (idx === -1) return null;
    return {
      question: interview.questions[idx],
      index: idx,
      total: interview.questions.length,
    };
  }, [project]);

  const handleStartInterview = async () => {
    if (!project) return;
    setStartingInterview(true);
    setError(null);
    try {
      const updated = await startIntakeInterview(project.id);
      setProject(updated);
      setForceInterviewMode(true);
      setAnswerInput('');
      onProjectsChanged();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to generate clarification questions.'
      );
    } finally {
      setStartingInterview(false);
    }
  };

  const handleAnswerQuestion = async (skipped: boolean) => {
    if (!project || !currentQuestion) return;
    if (!skipped && answerInput.trim().length === 0) {
      setError('Please enter an answer or click Skip Question.');
      return;
    }

    setSubmittingAnswer(true);
    setError(null);
    try {
      const updated = await submitInterviewAnswer(project.id, {
        questionId: currentQuestion.question.id,
        answer: skipped ? '' : answerInput.trim(),
        skipped,
      });
      setProject(updated);
      setAnswerInput('');
      onProjectsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save answer.');
    } finally {
      setSubmittingAnswer(false);
    }
  };

  const handleGenerateRequirements = async () => {
    if (!project) return;
    setGeneratingReqs(true);
    setError(null);
    try {
      const updated = await generateRequirements(project.id);
      setProject(updated);
      setForceInterviewMode(false);
      setIsEditing(false);
      onProjectsChanged();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to generate requirements.'
      );
    } finally {
      setGeneratingReqs(false);
    }
  };

  const handleBeginEdit = () => {
    if (!project?.requirements) return;
    setDraft(toEditableDraft(project.requirements));
    setIsEditing(true);
    setError(null);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setDraft(null);
    setError(null);
  };

  const handleSaveEdits = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!project || !draft) return;

    setSavingEdits(true);
    setError(null);
    try {
      const updated = await updateRequirements(project.id, {
        agentName: draft.agentName.trim(),
        agentPurpose: draft.agentPurpose.trim(),
        scope: splitLines(draft.scopeText),
        targetAudience: draft.targetAudience.trim(),
        responseToneAndStyle: draft.responseToneAndStyle.trim(),
        mustAnswerTopics: splitLines(draft.mustAnswerTopicsText),
        mustRefuseTopics: splitLines(draft.mustRefuseTopicsText),
        knowledgeSourcesAvailable: splitLines(draft.knowledgeSourcesAvailableText),
        outOfScopeTopics: splitLines(draft.outOfScopeTopicsText),
        missingInformationOrAssumptions: splitLines(
          draft.missingInformationOrAssumptionsText
        ),
      });
      setProject(updated);
      setIsEditing(false);
      setDraft(null);
      onProjectsChanged();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to save requirements changes.'
      );
    } finally {
      setSavingEdits(false);
    }
  };

  const handleApproveRequirements = async () => {
    if (!project?.requirements) return;
    setApproving(true);
    setError(null);
    try {
      const updated = await approveRequirements(project.id);
      setProject(updated);
      onProjectsChanged();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to approve requirements.'
      );
    } finally {
      setApproving(false);
    }
  };

  const renderGroundabilityStatus = (status: GroundabilityStatus) => {
    if (status === 'Supported') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Supported</span>
        </span>
      );
    }
    if (status === 'Partially Supported') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Partially Supported</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span>Unsupported</span>
      </span>
    );
  };

  if (!selectedProjectId) {
    return (
      <div className="max-w-4xl mx-auto bg-white border border-slate-200 rounded-xl p-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <FolderOpen className="w-5 h-5 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
            <div>
              <h1 className="text-lg font-semibold text-slate-900">
                No Project Selected
              </h1>
              <p className="mt-1 text-sm text-slate-600">
                Create an agent project with a written brief and knowledge documents first to begin the intake interview.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('create')}
            className="px-4 py-2 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF] transition-colors whitespace-nowrap shrink-0"
          >
            Create Agent
          </button>
        </div>
      </div>
    );
  }

  if (loadingProject && !project) {
    return (
      <div className="max-w-6xl mx-auto space-y-4">
        <div className="h-24 bg-white border border-slate-200 rounded-xl" />
        <div className="h-64 bg-white border border-slate-200 rounded-xl" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="max-w-4xl mx-auto bg-white border border-red-200 rounded-xl p-6 text-sm text-red-700">
        {error ?? 'Unable to load the selected project.'}
      </div>
    );
  }

  const showRequirementsView =
    project.requirements !== null && !forceInterviewMode;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            Requirements & Intake Interview
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Clarify missing details, audit capabilities against uploaded documents, and approve the agent specification.
          </p>
        </div>

        <div className="text-xs text-slate-600 tabular-nums">
          Project: <span className="font-semibold text-slate-900">{project.name}</span> ·{' '}
          {parsedDocs.length} readable {parsedDocs.length === 1 ? 'document' : 'documents'}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      {/* Grounding Warning if no readable documents */}
      {parsedDocs.length === 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5 flex items-start gap-3 text-xs text-amber-900">
          <ShieldAlert className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <span className="font-semibold">No readable knowledge documents uploaded.</span>{' '}
            You can still complete the interview and generate requirements, but the Groundability Guard will mark document-dependent capabilities as <span className="font-semibold">Unsupported</span> until reference files are uploaded.
          </div>
        </div>
      )}

      {/* Project Intake Summary */}
      <section className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-900">
            Initial Project Intake Summary
          </h2>
          <span className="text-xs text-slate-500">
            {project.domain}
            {project.targetAudience ? ` · Audience: ${project.targetAudience}` : ''}
            {project.responseTone ? ` · Tone: ${project.responseTone}` : ''}
          </span>
        </div>
        <p className="mt-3 text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
          {project.brief}
        </p>
        {project.documents.length > 0 && (
          <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
            <span className="font-medium text-slate-800">Uploaded Documents:</span>
            {project.documents.map((doc) => (
              <span key={doc.id} className="inline-flex items-center gap-1">
                <FileText className="w-3.5 h-3.5 text-[#1E3A8A]" aria-hidden="true" />
                <span>{doc.originalName}</span>
                {doc.parseStatus !== 'parsed' && (
                  <span className="text-red-600">(unreadable)</span>
                )}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* Main Workflow View: Either Intake Interviewer OR Generated Requirements */}
      {!showRequirementsView ? (
        <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          {!project.intakeInterview ? (
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <MessageSquareMore
                  className="w-5 h-5 text-[#1E3A8A] shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    Step 1: AI Clarification Interview
                  </h2>
                  <p className="mt-1 text-sm text-slate-600 leading-relaxed max-w-2xl">
                    Gemini will review your brief, target audience, desired tone, and uploaded documents to identify any genuine gaps or ambiguities—asking up to 5 focused questions one at a time.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleStartInterview}
                  disabled={startingInterview}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#1E3A8A] text-white text-sm font-medium hover:bg-[#1E40AF] disabled:opacity-50 transition-colors"
                >
                  {startingInterview && (
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  )}
                  <span>
                    {startingInterview
                      ? 'Analyzing Brief & Documents...'
                      : 'Start Clarification Interview'}
                  </span>
                </button>

                {project.requirements && (
                  <button
                    type="button"
                    onClick={() => setForceInterviewMode(false)}
                    className="px-4 py-2.5 rounded-lg border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Back to Saved Requirements
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Interview Header & Analysis Summary */}
              <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-100">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    AI Clarification Interview
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {project.intakeInterview.analysisSummary}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleStartInterview}
                  disabled={startingInterview || submittingAnswer || generatingReqs}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{startingInterview ? 'Restarting...' : 'Restart Interview'}</span>
                </button>
              </div>

              {/* Active Question (One Question at a Time) */}
              {project.intakeInterview.status === 'in_progress' && currentQuestion ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-5 space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-xs font-semibold text-[#1E3A8A] tabular-nums">
                      Question {currentQuestion.index + 1} of {currentQuestion.total}
                    </span>
                    <div className="w-40 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                      <div
                        className="h-full bg-[#1E3A8A] transition-all"
                        style={{
                          width: `${Math.round(
                            ((currentQuestion.index + 1) / currentQuestion.total) * 100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>

                  <div>
                    <p className="text-base font-semibold text-slate-900 leading-snug">
                      {currentQuestion.question.question}
                    </p>
                    <p className="mt-1.5 text-xs text-slate-600">
                      Why this helps: {currentQuestion.question.rationale}
                    </p>
                    {currentQuestion.question.suggestedFocus && (
                      <p className="mt-1 text-xs text-slate-500">
                        Suggested focus: {currentQuestion.question.suggestedFocus}
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="interview-answer" className="sr-only">
                      Your answer
                    </label>
                    <textarea
                      id="interview-answer"
                      rows={3}
                      value={answerInput}
                      onChange={(e) => setAnswerInput(e.target.value)}
                      placeholder="Type your clarification answer here, or skip if not applicable..."
                      className="w-full p-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-[#1E3A8A] focus:ring-2 focus:ring-[#1E3A8A]/15"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => handleAnswerQuestion(true)}
                      disabled={submittingAnswer}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      <SkipForward className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Skip Question</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleAnswerQuestion(false)}
                      disabled={submittingAnswer || answerInput.trim().length === 0}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF] disabled:opacity-50"
                    >
                      {submittingAnswer && (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                      )}
                      <span>
                        {currentQuestion.index + 1 === currentQuestion.total
                          ? 'Submit & Finish Interview'
                          : 'Submit Answer'}
                      </span>
                    </button>
                  </div>
                </div>
              ) : (
                /* Interview Completed */
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 space-y-4">
                  <div className="flex items-start gap-3">
                    <CheckCircle2
                      className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5"
                      aria-hidden="true"
                    />
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900">
                        {project.intakeInterview.questions.length === 0
                          ? 'Brief Already Complete — Ready to Generate Requirements'
                          : 'Clarification Interview Completed'}
                      </h3>
                      <p className="mt-1 text-xs text-slate-600">
                        {project.intakeInterview.questions.length === 0
                          ? 'Gemini determined no extra clarification questions were needed.'
                          : `${project.intakeInterview.answers.filter((a) => !a.skipped).length} of ${project.intakeInterview.questions.length} questions answered.`}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={handleGenerateRequirements}
                      disabled={generatingReqs}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#1E3A8A] text-white text-sm font-medium hover:bg-[#1E40AF] disabled:opacity-50 transition-colors"
                    >
                      {generatingReqs && (
                        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                      )}
                      <span>
                        {generatingReqs
                          ? 'Generating Requirements & Groundability Check...'
                          : 'Generate Structured Requirements'}
                      </span>
                    </button>

                    {project.requirements && (
                      <button
                        type="button"
                        onClick={() => setForceInterviewMode(false)}
                        className="px-4 py-2.5 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Cancel & Keep Current Requirements
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Answered / Skipped History */}
              {project.intakeInterview.answers.length > 0 && (
                <div className="space-y-2.5">
                  <h3 className="text-xs font-semibold text-slate-700">
                    Recorded Interview Responses
                  </h3>
                  <ul className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                    {project.intakeInterview.answers.map((entry, idx) => (
                      <li key={entry.questionId} className="p-3.5 text-xs space-y-1">
                        <p className="font-medium text-slate-900">
                          {idx + 1}. {entry.question}
                        </p>
                        <p className="text-slate-600">
                          {entry.skipped ? (
                            <span className="italic text-slate-500">Skipped by user</span>
                          ) : (
                            entry.answer
                          )}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      ) : (
        /* Structured Requirements & Groundability Guard View */
        project.requirements && (
          <div className="space-y-6">
            {/* Approval & Action Bar */}
            <section className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                {project.requirements.approved ? (
                  <ClipboardCheck
                    className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                ) : (
                  <AlertTriangle
                    className="w-5 h-5 text-amber-600 shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                )}
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    {project.requirements.approved
                      ? 'Requirements Approved'
                      : 'Draft Requirements — Review & Approve'}
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                    {project.requirements.approved && project.requirements.approvedAt
                      ? `Approved ${formatDateTime(project.requirements.approvedAt)}`
                      : `Last updated ${formatDateTime(project.requirements.updatedAt)}. Approve to unlock Agent Builder.`}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                {!isEditing && (
                  <>
                    <button
                      type="button"
                      onClick={() => setForceInterviewMode(true)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Re-run Interview</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleBeginEdit}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>Edit Requirements</span>
                    </button>

                    {!project.requirements.approved && (
                      <button
                        type="button"
                        onClick={handleApproveRequirements}
                        disabled={approving}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF] disabled:opacity-50"
                      >
                        {approving ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                        )}
                        <span>
                          {approving ? 'Approving...' : 'Approve Requirements'}
                        </span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => onNavigate('builder')}
                      disabled={!project.requirements.approved}
                      title={
                        project.requirements.approved
                          ? 'Continue to Agent Builder'
                          : 'Approve requirements first to continue'
                      }
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-200 bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <span>Continue to Agent Builder</span>
                      <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
            </section>

            {/* Groundability Guard Report */}
            <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <ShieldCheck
                    className="w-5 h-5 text-[#1E3A8A] shrink-0"
                    aria-hidden="true"
                  />
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">
                      Groundability Guard
                    </h2>
                    <p className="text-xs text-slate-600 mt-0.5">
                      {project.requirements.groundability.summary}
                    </p>
                  </div>
                </div>

                <div className="shrink-0">
                  {renderGroundabilityStatus(
                    project.requirements.groundability.overallStatus
                  )}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                      <th className="py-3 px-6">Requested Capability</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Document Evidence & Gaps</th>
                      <th className="py-3 px-6">Safer Alternative</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {project.requirements.groundability.checks.map((check) => (
                      <tr key={check.id} className="align-top">
                        <td className="py-3.5 px-6 font-medium text-slate-900 max-w-xs">
                          {check.capability}
                        </td>
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          {renderGroundabilityStatus(check.status)}
                        </td>
                        <td className="py-3.5 px-4 text-slate-600 space-y-1 max-w-md">
                          <p>{check.evidenceSummary}</p>
                          {check.matchedDocuments.length > 0 && (
                            <p className="text-slate-500 font-mono">
                              Matched: {check.matchedDocuments.join(', ')}
                            </p>
                          )}
                          {check.unsupportedReason && (
                            <p className="text-red-700">
                              Gap: {check.unsupportedReason}
                            </p>
                          )}
                        </td>
                        <td className="py-3.5 px-6 text-slate-600 max-w-xs">
                          {check.saferAlternative || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* 10-Section Structured Requirements (View or Edit Mode) */}
            {isEditing && draft ? (
              <form
                onSubmit={handleSaveEdits}
                className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
              >
                <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                  <h2 className="text-base font-semibold text-slate-900">
                    Edit Structured Requirements
                  </h2>
                  <span className="text-xs text-slate-500">
                    For list fields, enter one item per line.
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="edit-agent-name"
                      className="block text-xs font-semibold text-slate-800 mb-1"
                    >
                      1. Agent Name
                    </label>
                    <input
                      id="edit-agent-name"
                      type="text"
                      value={draft.agentName}
                      onChange={(e) =>
                        setDraft({ ...draft, agentName: e.target.value })
                      }
                      required
                      className="w-full h-9 px-3 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="edit-target-audience"
                      className="block text-xs font-semibold text-slate-800 mb-1"
                    >
                      4. Target Audience
                    </label>
                    <input
                      id="edit-target-audience"
                      type="text"
                      value={draft.targetAudience}
                      onChange={(e) =>
                        setDraft({ ...draft, targetAudience: e.target.value })
                      }
                      className="w-full h-9 px-3 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="edit-agent-purpose"
                      className="block text-xs font-semibold text-slate-800 mb-1"
                    >
                      2. Agent Purpose
                    </label>
                    <textarea
                      id="edit-agent-purpose"
                      rows={3}
                      value={draft.agentPurpose}
                      onChange={(e) =>
                        setDraft({ ...draft, agentPurpose: e.target.value })
                      }
                      required
                      className="w-full p-3 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="edit-tone"
                      className="block text-xs font-semibold text-slate-800 mb-1"
                    >
                      5. Response Tone and Style
                    </label>
                    <textarea
                      id="edit-tone"
                      rows={3}
                      value={draft.responseToneAndStyle}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          responseToneAndStyle: e.target.value,
                        })
                      }
                      className="w-full p-3 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="edit-scope"
                      className="block text-xs font-semibold text-slate-800 mb-1"
                    >
                      3. Scope: What the Agent Should Handle
                    </label>
                    <textarea
                      id="edit-scope"
                      rows={4}
                      value={draft.scopeText}
                      onChange={(e) =>
                        setDraft({ ...draft, scopeText: e.target.value })
                      }
                      className="w-full p-3 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="edit-sources"
                      className="block text-xs font-semibold text-slate-800 mb-1"
                    >
                      8. Knowledge Sources Available
                    </label>
                    <textarea
                      id="edit-sources"
                      rows={4}
                      value={draft.knowledgeSourcesAvailableText}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          knowledgeSourcesAvailableText: e.target.value,
                        })
                      }
                      className="w-full p-3 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="edit-must-answer"
                      className="block text-xs font-semibold text-slate-800 mb-1"
                    >
                      6. Must-Answer Topics
                    </label>
                    <textarea
                      id="edit-must-answer"
                      rows={4}
                      value={draft.mustAnswerTopicsText}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          mustAnswerTopicsText: e.target.value,
                        })
                      }
                      className="w-full p-3 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="edit-must-refuse"
                      className="block text-xs font-semibold text-slate-800 mb-1"
                    >
                      7. Must-Refuse Topics
                    </label>
                    <textarea
                      id="edit-must-refuse"
                      rows={4}
                      value={draft.mustRefuseTopicsText}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          mustRefuseTopicsText: e.target.value,
                        })
                      }
                      className="w-full p-3 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="edit-out-of-scope"
                      className="block text-xs font-semibold text-slate-800 mb-1"
                    >
                      9. Out-of-Scope Topics
                    </label>
                    <textarea
                      id="edit-out-of-scope"
                      rows={4}
                      value={draft.outOfScopeTopicsText}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          outOfScopeTopicsText: e.target.value,
                        })
                      }
                      className="w-full p-3 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="edit-missing"
                      className="block text-xs font-semibold text-slate-800 mb-1"
                    >
                      10. Missing Information or Assumptions
                    </label>
                    <textarea
                      id="edit-missing"
                      rows={4}
                      value={draft.missingInformationOrAssumptionsText}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          missingInformationOrAssumptionsText: e.target.value,
                        })
                      }
                      className="w-full p-3 rounded-lg border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A]"
                    />
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    disabled={savingEdits}
                    className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingEdits}
                    className="px-4 py-2 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF] disabled:opacity-50"
                  >
                    {savingEdits ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </form>
            ) : (
              <section className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
                <div className="border-b border-slate-100 pb-4">
                  <h2 className="text-base font-semibold text-slate-900">
                    Structured Requirements Specification
                  </h2>
                </div>

                {/* Top Summary Fields: 1, 2, 4, 5 */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <h3 className="text-xs font-semibold text-slate-500">
                      01. Agent Name
                    </h3>
                    <p className="mt-1 text-sm font-semibold text-slate-900">
                      {project.requirements.agentName}
                    </p>
                  </div>

                  <div>
                    <h3 className="text-xs font-semibold text-slate-500">
                      04. Target Audience
                    </h3>
                    <p className="mt-1 text-sm text-slate-800">
                      {project.requirements.targetAudience}
                    </p>
                  </div>

                  <div>
                    <h3 className="text-xs font-semibold text-slate-500">
                      02. Agent Purpose
                    </h3>
                    <p className="mt-1 text-sm text-slate-700 leading-relaxed">
                      {project.requirements.agentPurpose}
                    </p>
                  </div>

                  <div>
                    <h3 className="text-xs font-semibold text-slate-500">
                      05. Response Tone and Style
                    </h3>
                    <p className="mt-1 text-sm text-slate-700 leading-relaxed">
                      {project.requirements.responseToneAndStyle}
                    </p>
                  </div>
                </div>

                {/* List Fields: 3, 6, 7, 8, 9, 10 */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-slate-100">
                  <RequirementListBlock
                    title="03. Scope: What the Agent Should Handle"
                    items={project.requirements.scope}
                  />
                  <RequirementListBlock
                    title="08. Knowledge Sources Available"
                    items={project.requirements.knowledgeSourcesAvailable}
                  />
                  <RequirementListBlock
                    title="06. Must-Answer Topics"
                    items={project.requirements.mustAnswerTopics}
                  />
                  <RequirementListBlock
                    title="07. Must-Refuse Topics"
                    items={project.requirements.mustRefuseTopics}
                  />
                  <RequirementListBlock
                    title="09. Out-of-Scope Topics"
                    items={project.requirements.outOfScopeTopics}
                  />
                  <RequirementListBlock
                    title="10. Missing Information or Assumptions"
                    items={project.requirements.missingInformationOrAssumptions}
                  />
                </div>
              </section>
            )}
          </div>
        )
      )}
    </div>
  );
}

function RequirementListBlock({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-slate-500 mb-2">{title}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-slate-400 italic">None specified</p>
      ) : (
        <ul className="space-y-1.5 text-sm text-slate-700 list-disc pl-5">
          {items.map((item, idx) => (
            <li key={`${title}-${idx}`} className="leading-relaxed">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

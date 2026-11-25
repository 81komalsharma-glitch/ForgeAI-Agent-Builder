import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FolderOpen,
  History,
  Info,
  Loader2,
  Lock,
  Pause,
  Play,
  ShieldCheck,
  Sparkles,
  Square,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  analyzeOptimizationFailures,
  applyOptimizationIteration,
  createOptimizationRun,
  executeEvaluationRunStep,
  fetchProjectById,
  finalizeOptimizationIteration,
  pauseEvaluationRun,
  stopOptimizationRun,
  submitOptimizationDecisions,
} from '../services/api';
import type {
  AgentProject,
  EvaluationRunRecord,
  FailureCategory,
  FailureClassificationRecord,
  NavSectionId,
  OptimizationIterationRecord,
  OptimizationRunRecord,
  ProposedOptimizationChange,
  ScorecardSnapshot,
} from '../types/agent';
import { formatDateTime } from '../utils/format';

interface OptimizerPageProps {
  selectedProjectId: string | null;
  onNavigate: (section: NavSectionId) => void;
  onProjectsChanged: () => void;
}

const FAILURE_CATEGORY_LABELS: Record<FailureCategory, string> = {
  retrieval_miss: 'Retrieval Miss',
  prompt_defect: 'Prompt Defect',
  hallucination: 'Hallucination',
  wrong_refusal: 'Wrong Refusal',
  uncertain: 'Uncertain',
};

const STOPPING_REASON_LABELS: Record<
  NonNullable<OptimizationRunRecord['stoppingReason']>,
  string
> = {
  all_tests_passed: 'All Evaluated Tests Passed',
  no_meaningful_fix_identified: 'No Meaningful Targeted Fix Identified',
  score_did_not_improve: 'Stopped — Score Did Not Improve',
  max_iterations_reached: 'Maximum 3 Iterations Reached',
  all_changes_rejected: 'All Proposed Changes Rejected',
  user_stopped: 'Stopped Manually by User',
  execution_error: 'Stopped Due to Execution Error',
};

function formatScore(value: number | null): string {
  if (value === null || Number.isNaN(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function formatDelta(delta: number | null): string {
  if (delta === null || Number.isNaN(delta)) return '—';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(2)} pts`;
}

function formatPatchValue(val: unknown): string {
  if (Array.isArray(val)) {
    return val.map((item) => `• ${String(item)}`).join('\n');
  }
  if (typeof val === 'string') return val;
  return JSON.stringify(val, null, 2);
}

function deltaTextClass(delta: number | null): string {
  if (delta === null) return 'text-slate-500';
  if (delta > 0) return 'text-emerald-700 font-semibold';
  if (delta < 0) return 'text-red-700 font-semibold';
  return 'text-slate-600';
}

export function OptimizerPage({
  selectedProjectId,
  onNavigate,
  onProjectsChanged,
}: OptimizerPageProps) {
  const [project, setProject] = useState<AgentProject | null>(null);
  const [loadingProject, setLoadingProject] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selectedBaselineEvalId, setSelectedBaselineEvalId] = useState<string>('');
  const [selectedOptRunId, setSelectedOptRunId] = useState<string | null>(null);
  const [expandedFailureIds, setExpandedFailureIds] = useState<Record<string, boolean>>(
    {}
  );
  const [categoryFilter, setCategoryFilter] = useState<'all' | FailureCategory>('all');

  const [analyzing, setAnalyzing] = useState(false);
  const [decidingChangeId, setDecidingChangeId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [rerunningEval, setRerunningEval] = useState(false);
  const [activeRerunCaseId, setActiveRerunCaseId] = useState<string | null>(null);

  const proposedFixesRef = useRef<HTMLDivElement | null>(null);
  const pauseRequestedRef = useRef(false);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      pauseRequestedRef.current = true;
    };
  }, []);

  const loadProject = useCallback(async (projectId: string) => {
    setLoadingProject(true);
    setError(null);
    setNotice(null);
    try {
      const full = await fetchProjectById(projectId);
      setProject(full);

      const completedEvalRuns = (full.evaluationRuns ?? []).filter(
        (r) =>
          (r.status === 'completed' || r.status === 'completed_with_errors') &&
          r.scorecard.counts.evaluatedTests > 0 &&
          r.scorecard.overallScore !== null
      );
      setSelectedBaselineEvalId(
        completedEvalRuns[completedEvalRuns.length - 1]?.runId ?? ''
      );

      const optRuns = full.optimization?.runs ?? [];
      setSelectedOptRunId(
        full.optimization?.activeOptimizationRunId ??
          optRuns[optRuns.length - 1]?.optimizationRunId ??
          null
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load project.');
      setProject(null);
      setSelectedOptRunId(null);
    } finally {
      setLoadingProject(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setProject(null);
      setSelectedOptRunId(null);
      return;
    }
    pauseRequestedRef.current = true;
    setRerunningEval(false);
    setActiveRerunCaseId(null);
    void loadProject(selectedProjectId);
  }, [selectedProjectId, loadProject]);

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

  const savedDatasetRecord = useMemo(() => {
    if (!project?.evaluation || project.evaluation.savedVersion === null) {
      return null;
    }
    return (
      project.evaluation.versions.find(
        (v) => v.version === project.evaluation?.savedVersion
      ) ?? null
    );
  }, [project]);

  const completedEvalRuns = useMemo(() => {
    return (project?.evaluationRuns ?? []).filter(
      (r) =>
        (r.status === 'completed' || r.status === 'completed_with_errors') &&
        r.scorecard.counts.evaluatedTests > 0 &&
        r.scorecard.overallScore !== null
    );
  }, [project]);

  const prerequisitesMet = Boolean(
    project?.requirements?.approved &&
      savedAgentRecord &&
      savedAgentRecord.validation.valid &&
      savedDatasetRecord &&
      savedDatasetRecord.validation.valid &&
      savedDatasetRecord.testCases.length >= 20 &&
      completedEvalRuns.length > 0
  );

  const selectedBaselineRun = useMemo(() => {
    if (completedEvalRuns.length === 0) return null;
    return (
      completedEvalRuns.find((r) => r.runId === selectedBaselineEvalId) ??
      completedEvalRuns[completedEvalRuns.length - 1]
    );
  }, [completedEvalRuns, selectedBaselineEvalId]);

  const optRuns = project?.optimization?.runs ?? [];

  const activeOptRun: OptimizationRunRecord | null = useMemo(() => {
    if (optRuns.length === 0) return null;
    if (selectedOptRunId) {
      const match = optRuns.find((r) => r.optimizationRunId === selectedOptRunId);
      if (match) return match;
    }
    return optRuns[optRuns.length - 1] ?? null;
  }, [optRuns, selectedOptRunId]);

  const activeIteration: OptimizationIterationRecord | null = useMemo(() => {
    if (!activeOptRun || activeOptRun.iterations.length === 0) return null;
    return activeOptRun.iterations[activeOptRun.iterations.length - 1] ?? null;
  }, [activeOptRun]);

  const activeRerunEvalRecord: EvaluationRunRecord | null = useMemo(() => {
    if (!project || !activeIteration?.rerunEvaluationRunId) return null;
    return (
      project.evaluationRuns.find(
        (r) => r.runId === activeIteration.rerunEvaluationRunId
      ) ?? null
    );
  }, [project, activeIteration]);

  const remainingFailureResults = useMemo(() => {
    if (!project || !activeOptRun) return [];
    const latestEval = project.evaluationRuns.find(
      (r) => r.runId === activeOptRun.currentEvaluationRunId
    );
    if (!latestEval) return [];
    return latestEval.results.filter((r) => r.status === 'failed');
  }, [project, activeOptRun]);

  const failureBreakdownCounts = useMemo(() => {
    const counts: Record<FailureCategory, number> = {
      retrieval_miss: 0,
      prompt_defect: 0,
      hallucination: 0,
      wrong_refusal: 0,
      uncertain: 0,
    };
    const list = activeIteration?.failureClassifications ?? [];
    for (const item of list) {
      counts[item.category] += 1;
    }
    return counts;
  }, [activeIteration]);

  const filteredClassifications = useMemo(() => {
    const list = activeIteration?.failureClassifications ?? [];
    if (categoryFilter === 'all') return list;
    return list.filter((c) => c.category === categoryFilter);
  }, [activeIteration, categoryFilter]);

  const runEvaluationRerunLoop = async (
    projectId: string,
    optRunId: string,
    iterationNumber: number,
    initialEvalRun: EvaluationRunRecord
  ) => {
    pauseRequestedRef.current = false;
    setRerunningEval(true);
    setError(null);
    let currentEval = initialEvalRun;

    try {
      while (!pauseRequestedRef.current && !unmountedRef.current) {
        if (currentEval.scorecard.counts.pendingTests <= 0) {
          break;
        }
        setActiveRerunCaseId(currentEval.currentTestCaseId);
        const stepRes = await executeEvaluationRunStep(
          projectId,
          currentEval.runId
        );
        if (unmountedRef.current) return;

        setProject(stepRes.project);
        currentEval = stepRes.run;

        if (stepRes.done) {
          const finRes = await finalizeOptimizationIteration(
            projectId,
            optRunId,
            iterationNumber
          );
          if (unmountedRef.current) return;
          setProject(finRes.project);
          onProjectsChanged();
          const latestIt = finRes.optimizationRun.iterations.find(
            (it) => it.iterationNumber === iterationNumber
          );
          setNotice(
            latestIt?.decisionReason ||
              `Completed Iteration ${iterationNumber} evaluation rerun.`
          );
          break;
        }
      }

      if (
        pauseRequestedRef.current &&
        !unmountedRef.current &&
        currentEval.scorecard.counts.pendingTests > 0
      ) {
        const pausedRes = await pauseEvaluationRun(projectId, currentEval.runId);
        if (!unmountedRef.current) {
          setProject(pausedRes.project);
          setNotice(
            `Rerun paused with ${pausedRes.run.scorecard.counts.pendingTests} pending test(s). Click Resume Evaluation Rerun to continue.`
          );
        }
      }
    } catch (err) {
      if (!unmountedRef.current) {
        setError(
          err instanceof Error
            ? err.message
            : 'Evaluation rerun interrupted due to an error.'
        );
        try {
          await pauseEvaluationRun(projectId, currentEval.runId);
          const refreshed = await fetchProjectById(projectId);
          setProject(refreshed);
        } catch {
          // Best effort refresh
        }
      }
    } finally {
      if (!unmountedRef.current) {
        setRerunningEval(false);
        setActiveRerunCaseId(null);
      }
    }
  };

  const handleAnalyzeFailures = async (forceNewRun = false) => {
    if (!project || analyzing || rerunningEval) return;
    setAnalyzing(true);
    setError(null);
    setNotice(null);

    try {
      let targetOptId = activeOptRun?.optimizationRunId ?? null;
      if (
        forceNewRun ||
        !activeOptRun ||
        activeOptRun.status !== 'in_progress'
      ) {
        const created = await createOptimizationRun(
          project.id,
          selectedBaselineRun?.runId
        );
        setProject(created.project);
        targetOptId = created.optimizationRun.optimizationRunId;
        setSelectedOptRunId(targetOptId);
      }

      if (!targetOptId) {
        throw new Error('Unable to initialize optimization run.');
      }

      const analyzed = await analyzeOptimizationFailures(project.id, targetOptId);
      setProject(analyzed.project);
      setSelectedOptRunId(analyzed.optimizationRun.optimizationRunId);
      onProjectsChanged();

      const lastIter =
        analyzed.optimizationRun.iterations[
          analyzed.optimizationRun.iterations.length - 1
        ];
      if (analyzed.optimizationRun.status !== 'in_progress') {
        setNotice(analyzed.optimizationRun.stoppingDetail);
      } else if (lastIter) {
        setNotice(
          `Iteration ${lastIter.iterationNumber}: Classified ${lastIter.failuresAnalyzedCount} failure(s) and proposed ${lastIter.proposedChanges.length} targeted fix(es) for review.`
        );
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to analyze evaluation failures.'
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const handleChangeDecisions = async (
    decisions: Array<{ changeId: string; status: 'approved' | 'rejected' }>,
    label?: string
  ) => {
    if (!project || !activeOptRun || !activeIteration) return;
    setDecidingChangeId(label ?? decisions[0]?.changeId ?? 'bulk');
    setError(null);
    setNotice(null);
    try {
      const res = await submitOptimizationDecisions(
        project.id,
        activeOptRun.optimizationRunId,
        activeIteration.iterationNumber,
        decisions
      );
      setProject(res.project);
      onProjectsChanged();
      if (res.optimizationRun.status === 'stopped') {
        setNotice(res.optimizationRun.stoppingDetail);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to update change decisions.'
      );
    } finally {
      setDecidingChangeId(null);
    }
  };

  const handleApplyAndRerun = async () => {
    if (!project || !activeOptRun || !activeIteration || applying || rerunningEval) {
      return;
    }
    setApplying(true);
    setError(null);
    setNotice(null);
    try {
      const res = await applyOptimizationIteration(
        project.id,
        activeOptRun.optimizationRunId,
        activeIteration.iterationNumber
      );
      setProject(res.project);
      onProjectsChanged();
      setNotice(
        `Created Agent v${res.evaluationRun.agentVersion} with approved fixes. Rerunning unchanged Evaluation Dataset v${res.evaluationRun.datasetVersion}...`
      );
      setApplying(false);
      await runEvaluationRerunLoop(
        project.id,
        activeOptRun.optimizationRunId,
        activeIteration.iterationNumber,
        res.evaluationRun
      );
    } catch (err) {
      setApplying(false);
      setError(
        err instanceof Error ? err.message : 'Failed to apply approved changes.'
      );
    }
  };

  const handleResumeRerun = async () => {
    if (
      !project ||
      !activeOptRun ||
      !activeIteration ||
      !activeRerunEvalRecord ||
      rerunningEval
    ) {
      return;
    }
    if (activeRerunEvalRecord.scorecard.counts.pendingTests <= 0) {
      setApplying(true);
      try {
        const fin = await finalizeOptimizationIteration(
          project.id,
          activeOptRun.optimizationRunId,
          activeIteration.iterationNumber
        );
        setProject(fin.project);
        onProjectsChanged();
        setNotice(
          fin.optimizationRun.stoppingDetail ||
            `Finalized Iteration ${activeIteration.iterationNumber}.`
        );
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to finalize iteration.'
        );
      } finally {
        setApplying(false);
      }
      return;
    }

    await runEvaluationRerunLoop(
      project.id,
      activeOptRun.optimizationRunId,
      activeIteration.iterationNumber,
      activeRerunEvalRecord
    );
  };

  const handleStopOptimization = async () => {
    if (!project || !activeOptRun || stopping) return;
    pauseRequestedRef.current = true;
    setStopping(true);
    setError(null);
    try {
      const res = await stopOptimizationRun(
        project.id,
        activeOptRun.optimizationRunId,
        'Optimization stopped manually by user.'
      );
      setProject(res.project);
      onProjectsChanged();
      setNotice(res.optimizationRun.stoppingDetail);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to stop optimization run.'
      );
    } finally {
      setStopping(false);
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
        <span>Loading Critic-Optimizer workspace...</span>
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
    const needsAgent = !savedAgentRecord || !savedAgentRecord.validation.valid;
    const needsDataset =
      !savedDatasetRecord ||
      !savedDatasetRecord.validation.valid ||
      savedDatasetRecord.testCases.length < 20;

    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <p className="text-xs font-medium text-[#1E3A8A] mb-1">
            Stage 05 · Critic-Optimizer
          </p>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            Agent Critic-Optimizer
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
                    : needsAgent
                      ? 'Valid Saved Agent Definition Required'
                      : needsDataset
                        ? 'Saved Valid Evaluation Dataset (20+ Cases) Required'
                        : 'Completed Evaluation Run Required'}
                </h2>
                <p className="mt-1 text-xs text-amber-800 leading-relaxed max-w-xl">
                  {needsRequirements
                    ? 'Approve the project requirements first before building and evaluating an agent.'
                    : needsAgent
                      ? 'Save a valid agent definition in Agent Builder before running evaluation and optimization.'
                      : needsDataset
                        ? 'Save a valid evaluation dataset with at least 20 test cases in the Evaluation stage.'
                        : 'Run and complete at least one evaluation run in the Evaluation stage so the Critic has real scorecard metrics and individual test results to analyze.'}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() =>
                onNavigate(
                  needsRequirements
                    ? 'requirements'
                    : needsAgent
                      ? 'builder'
                      : 'evaluation'
                )
              }
              className="px-4 py-2 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF] transition-colors whitespace-nowrap shrink-0"
            >
              {needsRequirements
                ? 'Go to Requirements'
                : needsAgent
                  ? 'Go to Agent Builder'
                  : 'Go to Evaluation'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const iterationsCount = activeOptRun?.iterations.length ?? 0;
  const maxReached = iterationsCount >= 3;
  const isRunOpen = activeOptRun?.status === 'in_progress';
  const isAwaitingApproval = activeIteration?.status === 'awaiting_approval';
  const isRerunningIteration = activeIteration?.status === 'rerunning';

  const approvedCount =
    activeIteration?.proposedChanges.filter((c) => c.approvalStatus === 'approved')
      .length ?? 0;
  const pendingCount =
    activeIteration?.proposedChanges.filter((c) => c.approvalStatus === 'pending')
      .length ?? 0;

  const canRunNextIteration = Boolean(
    activeOptRun &&
      isRunOpen &&
      !maxReached &&
      !isAwaitingApproval &&
      !isRerunningIteration &&
      !analyzing &&
      !rerunningEval
  );

  const baselineScore =
    activeOptRun?.baselineScorecard.overallScore ??
    selectedBaselineRun?.scorecard.overallScore ??
    null;
  const currentScore =
    activeOptRun?.currentScorecard.overallScore ?? baselineScore;
  const totalImprovementDelta =
    baselineScore !== null && currentScore !== null
      ? Math.round((currentScore - baselineScore) * 100) / 100
      : null;

  const currentFailedCount = activeOptRun
    ? activeOptRun.currentScorecard.failedTests
    : selectedBaselineRun?.scorecard.counts.failedTests ?? 0;

  const categoriesList: FailureCategory[] = [
    'retrieval_miss',
    'prompt_defect',
    'hallucination',
    'wrong_refusal',
    'uncertain',
  ];

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header & Action Controls */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-[#1E3A8A] mb-1">
              Stage 05 · Critic-Optimizer (Max 3 Iterations)
            </p>
            <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
              Critic-Optimizer
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
              <span>
                Project: <strong className="text-slate-900">{project.name}</strong>
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">
                Baseline Agent v
                {activeOptRun?.baselineAgentVersion ?? selectedBaselineRun?.agentVersion}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">
                Locked Dataset v
                {activeOptRun?.baselineDatasetVersion ?? selectedBaselineRun?.datasetVersion}{' '}
                ({savedDatasetRecord?.testCases.length ?? 0} cases)
              </span>
              {activeOptRun && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-[#1E3A8A] font-medium">
                    Current Agent v{activeOptRun.currentAgentVersion}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Primary Optimizer Controls */}
          <div className="flex flex-wrap items-center gap-2">
            {(!activeOptRun || activeOptRun.iterations.length === 0) && (
              <button
                type="button"
                disabled={analyzing || rerunningEval}
                onClick={() => void handleAnalyzeFailures(false)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF] disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {analyzing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>{analyzing ? 'Analyzing Failures...' : 'Analyze Failures'}</span>
              </button>
            )}

            {isAwaitingApproval && activeIteration && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    proposedFixesRef.current?.scrollIntoView({ behavior: 'smooth' })
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                >
                  <span>Review Proposed Fixes ({activeIteration.proposedChanges.length})</span>
                </button>

                <button
                  type="button"
                  disabled={decidingChangeId !== null || pendingCount === 0}
                  onClick={() =>
                    void handleChangeDecisions(
                      activeIteration.proposedChanges.map((c) => ({
                        changeId: c.changeId,
                        status: 'approved',
                      })),
                      'approve-all'
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-emerald-300 bg-emerald-50 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <Check className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Approve Changes</span>
                </button>

                <button
                  type="button"
                  disabled={decidingChangeId !== null}
                  onClick={() =>
                    void handleChangeDecisions(
                      activeIteration.proposedChanges.map((c) => ({
                        changeId: c.changeId,
                        status: 'rejected',
                      })),
                      'reject-all'
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-red-200 bg-red-50 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Reject Changes</span>
                </button>
              </>
            )}

            {activeOptRun && (
              <button
                type="button"
                disabled={!canRunNextIteration}
                onClick={() => void handleAnalyzeFailures(false)}
                title={
                  maxReached
                    ? 'Maximum of 3 optimization iterations reached'
                    : !isRunOpen
                      ? 'Optimization run has finished or stopped'
                      : isAwaitingApproval
                        ? 'Approve or reject proposed fixes for the current iteration first'
                        : 'Analyze remaining failures and start next iteration'
                }
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF] disabled:bg-slate-200 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0"
              >
                {analyzing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                <span>
                  {maxReached
                    ? 'Max 3 Iterations Reached'
                    : `Run Next Iteration (${iterationsCount}/3)`}
                </span>
              </button>
            )}

            {activeOptRun && isRunOpen && (
              <button
                type="button"
                disabled={stopping}
                onClick={() => void handleStopOptimization()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-red-200 bg-white text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Square className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{stopping ? 'Stopping...' : 'Stop Optimization'}</span>
              </button>
            )}

            {activeOptRun && !isRunOpen && (
              <button
                type="button"
                disabled={analyzing || rerunningEval}
                onClick={() => void handleAnalyzeFailures(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Sparkles className="w-3.5 h-3.5 text-[#1E3A8A]" aria-hidden="true" />
                <span>Start New Optimization Run</span>
              </button>
            )}

            {activeOptRun && (
              <a
                href={`/api/projects/${encodeURIComponent(project.id)}/optimizer/runs/${encodeURIComponent(activeOptRun.optimizationRunId)}/export`}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Export JSON</span>
              </a>
            )}
          </div>
        </div>

        {/* Baseline Run Selector (before optimization starts) OR Opt Run History Switcher */}
        {!activeOptRun ? (
          <div className="pt-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="baseline-eval-select" className="font-medium text-slate-700">
                Baseline Evaluation Run:
              </label>
              <select
                id="baseline-eval-select"
                value={selectedBaselineRun?.runId ?? ''}
                onChange={(e) => setSelectedBaselineEvalId(e.target.value)}
                className="h-8 px-2.5 rounded-lg border border-slate-200 bg-slate-50 text-xs font-mono text-slate-800"
              >
                {completedEvalRuns.map((run) => (
                  <option key={run.runId} value={run.runId}>
                    {run.runId} · Agent v{run.agentVersion} · Dataset v
                    {run.datasetVersion} · Score{' '}
                    {formatScore(run.scorecard.overallScore)} ({run.scorecard.counts.failedTests}{' '}
                    failed)
                  </option>
                ))}
              </select>
            </div>
            <span className="text-slate-500">
              Original Agent v{selectedBaselineRun?.agentVersion} is preserved intact.
            </span>
          </div>
        ) : (
          optRuns.length > 0 && (
            <div className="pt-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 font-medium text-slate-600">
                  <History className="w-3.5 h-3.5" aria-hidden="true" />
                  Optimization Runs:
                </span>
                {[...optRuns].reverse().map((opt) => {
                  const isActive = opt.optimizationRunId === activeOptRun.optimizationRunId;
                  return (
                    <button
                      key={opt.optimizationRunId}
                      type="button"
                      onClick={() => setSelectedOptRunId(opt.optimizationRunId)}
                      className={`px-2.5 py-1 rounded-md border font-mono text-xs transition-colors ${
                        isActive
                          ? 'border-[#1E3A8A] bg-blue-50 text-[#1E3A8A] font-semibold'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {opt.optimizationRunId} · {opt.iterations.length}/3 iters ·{' '}
                      {formatScore(opt.baselineScorecard.overallScore)} {'->'}{' '}
                      {formatScore(opt.currentScorecard.overallScore)}
                    </button>
                  );
                })}
              </div>

              <span className="font-mono text-slate-500">
                Started {formatDateTime(activeOptRun.startedAt)}
              </span>
            </div>
          )
        )}
      </div>

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

      {/* Stopping Status Banner (when completed or stopped) */}
      {activeOptRun && activeOptRun.status !== 'in_progress' && (
        <div
          className={`rounded-xl border px-4 py-3.5 text-xs flex flex-wrap items-center justify-between gap-3 ${
            activeOptRun.stoppingReason === 'all_tests_passed'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : activeOptRun.stoppingReason === 'score_did_not_improve'
                ? 'border-amber-200 bg-amber-50 text-amber-900'
                : 'border-slate-200 bg-white text-slate-800'
          }`}
        >
          <div className="flex items-start gap-2.5">
            {activeOptRun.stoppingReason === 'all_tests_passed' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0 mt-0.5" />
            ) : (
              <ShieldCheck className="w-4 h-4 text-[#1E3A8A] shrink-0 mt-0.5" />
            )}
            <div>
              <p className="font-semibold">
                {activeOptRun.stoppingReason
                  ? STOPPING_REASON_LABELS[activeOptRun.stoppingReason]
                  : 'Optimization Closed'}
              </p>
              <p className="mt-0.5">{activeOptRun.stoppingDetail}</p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => onNavigate('builder')}
            className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            Inspect Versions in Agent Builder
          </button>
        </div>
      )}

      {/* Optimizer KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Baseline Score</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {formatScore(baselineScore)}
          </p>
          <p className="mt-1 text-xs text-slate-500 font-mono">
            Agent v
            {activeOptRun?.baselineAgentVersion ?? selectedBaselineRun?.agentVersion}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">
            Current Optimized Score
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {formatScore(currentScore)}
          </p>
          <p className="mt-1 text-xs text-slate-500 font-mono">
            Agent v
            {activeOptRun?.currentAgentVersion ?? selectedBaselineRun?.agentVersion}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Net Improvement</p>
          <div className="mt-2 flex items-center gap-1.5 font-mono tabular-nums">
            {totalImprovementDelta !== null && totalImprovementDelta > 0 && (
              <TrendingUp className="w-5 h-5 text-emerald-700 shrink-0" />
            )}
            {totalImprovementDelta !== null && totalImprovementDelta < 0 && (
              <TrendingDown className="w-5 h-5 text-red-700 shrink-0" />
            )}
            <span className={`text-2xl font-semibold ${deltaTextClass(totalImprovementDelta)}`}>
              {formatDelta(totalImprovementDelta)}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {totalImprovementDelta !== null && totalImprovementDelta < 0
              ? 'Regression reported honestly'
              : 'Baseline vs latest'}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">
            Optimization Iterations
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {iterationsCount} / 3
          </p>
          <p className="mt-1 text-xs text-slate-500">Strict 3-iteration cap</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Remaining Failures</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {currentFailedCount}
          </p>
          <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            Out of{' '}
            {activeOptRun?.currentScorecard.totalTests ??
              selectedBaselineRun?.scorecard.counts.totalTests ??
              0}{' '}
            test cases
          </p>
        </div>
      </div>

      {/* Initial Pre-Optimization State (before Iteration 1 is analyzed) */}
      {!activeOptRun && selectedBaselineRun && (
        <div className="bg-white border border-slate-200 rounded-xl p-8 space-y-6">
          <div className="max-w-2xl mx-auto text-center space-y-2">
            <h2 className="text-lg font-semibold text-slate-900">
              Baseline Evaluation Ready for Failure Analysis
            </h2>
            <p className="text-sm text-slate-600">
              Before making any changes, inspect the initial baseline scorecard from Run{' '}
              <span className="font-mono font-medium text-slate-900">
                {selectedBaselineRun.runId}
              </span>
              . Clicking <strong>Analyze Failures</strong> will classify each failed test case (Retrieval Miss, Prompt Defect, Hallucination, Wrong Refusal, or Uncertain) and propose surgical fixes for your approval.
            </p>
          </div>

          <div className="max-w-3xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-4 border border-slate-200 rounded-xl p-4 bg-slate-50 text-xs font-mono tabular-nums">
            <div>
              <p className="text-slate-500 font-sans">Initial Overall</p>
              <p className="mt-1 text-base font-semibold text-slate-900">
                {formatScore(selectedBaselineRun.scorecard.overallScore)}
              </p>
            </div>
            <div>
              <p className="text-slate-500 font-sans">Grounding (40%)</p>
              <p className="mt-1 text-base font-semibold text-slate-900">
                {formatScore(selectedBaselineRun.scorecard.groundingScore)}
              </p>
            </div>
            <div>
              <p className="text-slate-500 font-sans">Correctness (40%)</p>
              <p className="mt-1 text-base font-semibold text-slate-900">
                {formatScore(selectedBaselineRun.scorecard.correctnessScore)}
              </p>
            </div>
            <div>
              <p className="text-slate-500 font-sans">Refusal Quality (20%)</p>
              <p className="mt-1 text-base font-semibold text-slate-900">
                {selectedBaselineRun.scorecard.refusalScoreStatus === 'available'
                  ? formatScore(selectedBaselineRun.scorecard.refusalQualityScore)
                  : 'Unavailable'}
              </p>
            </div>
          </div>

          <div className="flex justify-center">
            <button
              type="button"
              disabled={analyzing}
              onClick={() => void handleAnalyzeFailures(false)}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#1E3A8A] text-white text-sm font-medium hover:bg-[#1E40AF] disabled:opacity-50 transition-colors"
            >
              {analyzing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
              <span>
                {analyzing
                  ? 'Running Critic Failure Analysis...'
                  : `Analyze ${selectedBaselineRun.scorecard.counts.failedTests} Failure(s)`}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Live Rerun Progress Banner (Step 7-8 of active iteration) */}
      {isRerunningIteration && activeIteration && activeRerunEvalRecord && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          {(() => {
            const counts = activeRerunEvalRecord.scorecard.counts;
            const doneCount = counts.totalTests - counts.pendingTests;
            const pct =
              counts.totalTests > 0
                ? Math.round((doneCount / counts.totalTests) * 100)
                : 0;
            return (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 font-semibold text-slate-900">
                    {rerunningEval ? (
                      <Loader2 className="w-4 h-4 animate-spin text-[#1E3A8A]" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-amber-700" />
                    )}
                    <span>
                      Iteration {activeIteration.iterationNumber} Evaluation Rerun (Agent v
                      {activeIteration.newAgentVersion} on locked Dataset v
                      {activeOptRun?.baselineDatasetVersion})
                    </span>
                  </div>
                  <div className="flex items-center gap-3 font-mono tabular-nums text-slate-600">
                    <span>
                      {doneCount}/{counts.totalTests} ({pct}%)
                    </span>
                    <span className="text-emerald-700">
                      Pass: {counts.passedTests}
                    </span>
                    <span className="text-red-700">Fail: {counts.failedTests}</span>
                    {counts.errorTests > 0 && (
                      <span className="text-amber-800">
                        Err: {counts.errorTests}
                      </span>
                    )}
                  </div>
                </div>

                <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className="h-full bg-[#1E3A8A] transition-all duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-mono text-slate-600">
                    {rerunningEval
                      ? `Executing ${activeRerunCaseId || activeRerunEvalRecord.currentTestCaseId || '...'}`
                      : counts.pendingTests > 0
                        ? `Paused with ${counts.pendingTests} test case(s) remaining.`
                        : 'All test cases finished — click Finalize Iteration to update scorecard comparison.'}
                  </span>

                  <div className="flex items-center gap-2">
                    {rerunningEval ? (
                      <button
                        type="button"
                        onClick={() => {
                          pauseRequestedRef.current = true;
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 font-medium hover:bg-amber-100"
                      >
                        <Pause className="w-3.5 h-3.5" />
                        <span>Pause Rerun</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleResumeRerun()}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#1E3A8A] text-white font-medium hover:bg-[#1E40AF]"
                      >
                        <Play className="w-3.5 h-3.5" />
                        <span>
                          {counts.pendingTests > 0
                            ? `Resume Evaluation Rerun (${counts.pendingTests} left)`
                            : 'Finalize Iteration Scorecard'}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* Active Iteration: Failure Classification Breakdown + Proposed Surgical Fixes */}
      {activeOptRun && activeIteration && (
        <div className="space-y-6">
          {/* Failure Classification Breakdown */}
          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Iteration {activeIteration.iterationNumber} Failure Classification (
                  {activeIteration.failuresAnalyzedCount} Failed Test
                  {activeIteration.failuresAnalyzedCount === 1 ? '' : 's'})
                </h2>
                <p className="text-xs text-slate-600 mt-0.5">
                  {activeIteration.analysisSummary}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setCategoryFilter('all')}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    categoryFilter === 'all'
                      ? 'bg-[#1E3A8A] text-white'
                      : 'border border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  All ({activeIteration.failureClassifications.length})
                </button>
                {categoriesList.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setCategoryFilter(cat)}
                    className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      categoryFilter === cat
                        ? 'bg-[#1E3A8A] text-white'
                        : 'border border-slate-200 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {FAILURE_CATEGORY_LABELS[cat]} ({failureBreakdownCounts[cat]})
                  </button>
                ))}
              </div>
            </div>

            {filteredClassifications.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">
                No failures match the selected category filter.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-medium">
                      <th className="py-2.5 px-4 w-8" aria-label="Expand" />
                      <th className="py-2.5 px-3">Test ID</th>
                      <th className="py-2.5 px-3">Category</th>
                      <th className="py-2.5 px-3">Affected Component</th>
                      <th className="py-2.5 px-3">Root Cause Summary</th>
                      <th className="py-2.5 px-4 text-right">Confidence</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredClassifications.map((fc: FailureClassificationRecord) => {
                      const isExp = Boolean(expandedFailureIds[fc.testCaseId]);
                      return (
                        <Fragment key={fc.testCaseId}>
                          <tr className="hover:bg-slate-50/70">
                            <td className="py-3 px-4">
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedFailureIds((prev) => ({
                                    ...prev,
                                    [fc.testCaseId]: !prev[fc.testCaseId],
                                  }))
                                }
                                aria-label={`Inspect classification for ${fc.testCaseId}`}
                                className="p-1 rounded hover:bg-slate-200/70 text-slate-600"
                              >
                                {isExp ? (
                                  <ChevronDown className="w-4 h-4" />
                                ) : (
                                  <ChevronRight className="w-4 h-4" />
                                )}
                              </button>
                            </td>
                            <td className="py-3 px-3 font-mono font-semibold text-slate-900 whitespace-nowrap">
                              {fc.testCaseId}
                            </td>
                            <td className="py-3 px-3 font-medium text-slate-900 whitespace-nowrap">
                              {FAILURE_CATEGORY_LABELS[fc.category]}
                            </td>
                            <td className="py-3 px-3 font-mono text-slate-700 whitespace-nowrap">
                              {fc.affectedComponent}
                            </td>
                            <td className="py-3 px-3 max-w-md text-slate-700">
                              <p className="line-clamp-2">{fc.rootCauseExplanation}</p>
                            </td>
                            <td className="py-3 px-4 text-right font-mono capitalize text-slate-700 whitespace-nowrap">
                              {fc.confidence}
                            </td>
                          </tr>
                          {isExp && (
                            <tr className="bg-slate-50/70">
                              <td colSpan={6} className="p-4">
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-white border border-slate-200 rounded-lg p-3.5">
                                  <div>
                                    <p className="font-semibold text-slate-900 mb-1">
                                      Question &amp; Root Cause
                                    </p>
                                    <p className="text-slate-600 mb-2">
                                      {fc.question}
                                    </p>
                                    <p className="text-slate-800 leading-relaxed">
                                      {fc.rootCauseExplanation}
                                    </p>
                                  </div>
                                  <div>
                                    <p className="font-semibold text-slate-900 mb-1">
                                      Supporting Evidence
                                    </p>
                                    <p className="text-slate-700 leading-relaxed">
                                      {fc.supportingEvidence}
                                    </p>
                                  </div>
                                  <div>
                                    <p className="font-semibold text-slate-900 mb-1">
                                      Recommended Targeted Fix
                                    </p>
                                    <p className="text-slate-700 leading-relaxed">
                                      {fc.recommendedFix}
                                    </p>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Proposed Targeted Fixes (Approval Workflow) */}
          <section
            ref={proposedFixesRef}
            className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Proposed Targeted Fixes — Iteration {activeIteration.iterationNumber}
                </h2>
                <p className="text-xs text-slate-600 mt-0.5">
                  Surgical field-level patches only. Unrelated sections and baseline Agent v
                  {activeOptRun.baselineAgentVersion} remain untouched.
                </p>
              </div>

              {isAwaitingApproval && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={approvedCount === 0 || applying || rerunningEval}
                    onClick={() => void handleApplyAndRerun()}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0"
                  >
                    {applying ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Play className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    <span>
                      {applying
                        ? 'Creating Version...'
                        : `Apply ${approvedCount} Approved Fix(es) & Rerun Evaluation`}
                    </span>
                  </button>
                </div>
              )}
            </div>

            {activeIteration.proposedChanges.length === 0 ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                No targeted configuration changes were proposed for this iteration.
              </div>
            ) : (
              <div className="space-y-4">
                {activeIteration.proposedChanges.map((chg: ProposedOptimizationChange) => (
                  <div
                    key={chg.changeId}
                    className={`border rounded-xl p-4 space-y-3 ${
                      chg.approvalStatus === 'approved'
                        ? 'border-emerald-300 bg-emerald-50/30'
                        : chg.approvalStatus === 'rejected'
                          ? 'border-slate-200 bg-slate-50/60 opacity-80'
                          : 'border-slate-200 bg-white'
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                          <span className="font-mono font-semibold text-slate-900">
                            {chg.fieldPath}
                          </span>
                          <span aria-hidden="true" className="text-slate-300">
                            |
                          </span>
                          <span className="text-slate-600">
                            Addresses:{' '}
                            {chg.failureCategoriesAddressed
                              .map((c) => FAILURE_CATEGORY_LABELS[c])
                              .join(', ')}
                          </span>
                          {chg.affectedTestIds.length > 0 && (
                            <>
                              <span aria-hidden="true" className="text-slate-300">
                                |
                              </span>
                              <span className="font-mono text-slate-600">
                                Tests: {chg.affectedTestIds.join(', ')}
                              </span>
                            </>
                          )}
                          <span aria-hidden="true" className="text-slate-300">
                            |
                          </span>
                          <span
                            className={
                              chg.approvalStatus === 'approved'
                                ? 'font-semibold text-emerald-700'
                                : chg.approvalStatus === 'rejected'
                                  ? 'font-medium text-red-700'
                                  : 'font-medium text-amber-800'
                            }
                          >
                            {chg.approvalStatus === 'approved'
                              ? 'Approved'
                              : chg.approvalStatus === 'rejected'
                                ? 'Rejected'
                                : 'Pending Review'}
                          </span>
                        </div>
                        <p className="text-xs text-slate-700">{chg.reason}</p>
                      </div>

                      {isAwaitingApproval && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            disabled={decidingChangeId !== null}
                            onClick={() =>
                              void handleChangeDecisions([
                                { changeId: chg.changeId, status: 'approved' },
                              ])
                            }
                            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                              chg.approvalStatus === 'approved'
                                ? 'bg-emerald-700 text-white border-emerald-700'
                                : 'bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                            }`}
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>Approve</span>
                          </button>

                          <button
                            type="button"
                            disabled={decidingChangeId !== null}
                            onClick={() =>
                              void handleChangeDecisions([
                                { changeId: chg.changeId, status: 'rejected' },
                              ])
                            }
                            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                              chg.approvalStatus === 'rejected'
                                ? 'bg-red-700 text-white border-red-700'
                                : 'bg-white text-red-700 border-red-200 hover:bg-red-50'
                            }`}
                          >
                            <X className="w-3.5 h-3.5" />
                            <span>Reject</span>
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                      <div className="border border-slate-200 rounded-lg p-3 bg-slate-50">
                        <p className="font-semibold text-slate-600 mb-1">
                          Before (Agent v{activeIteration.baseAgentVersion})
                        </p>
                        <pre className="font-mono text-slate-700 whitespace-pre-wrap break-words leading-relaxed">
                          {formatPatchValue(chg.previousValue)}
                        </pre>
                      </div>

                      <div className="border border-slate-200 rounded-lg p-3 bg-white">
                        <p className="font-semibold text-[#1E3A8A] mb-1">
                          Proposed Patch
                        </p>
                        <pre className="font-mono text-slate-900 whitespace-pre-wrap break-words leading-relaxed">
                          {formatPatchValue(chg.proposedValue)}
                        </pre>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Optimization History & Before/After Metric Comparison */}
      {activeOptRun && (
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                Optimization History &amp; Score Progression
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Same Evaluation Dataset v{activeOptRun.baselineDatasetVersion} and identical 40/40/20 AI Judge rubric enforced across every iteration.
              </p>
            </div>
            <span className="text-xs font-mono text-slate-500">
              {activeOptRun.optimizationRunId}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-medium">
                  <th className="py-2.5 px-4">Step / Iteration</th>
                  <th className="py-2.5 px-3">Agent Ver</th>
                  <th className="py-2.5 px-3">Failures &amp; Categories</th>
                  <th className="py-2.5 px-3">Changes Applied &amp; Reason</th>
                  <th className="py-2.5 px-3 text-right">Grounding</th>
                  <th className="py-2.5 px-3 text-right">Correctness</th>
                  <th className="py-2.5 px-3 text-right">Refusal</th>
                  <th className="py-2.5 px-3 text-right">Overall</th>
                  <th className="py-2.5 px-4 text-right">Delta &amp; Remaining</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                {/* Baseline Row */}
                <tr className="bg-slate-50/50">
                  <td className="py-3 px-4 font-semibold text-slate-900 whitespace-nowrap">
                    Baseline
                  </td>
                  <td className="py-3 px-3 font-mono text-slate-800 whitespace-nowrap">
                    v{activeOptRun.baselineAgentVersion}
                  </td>
                  <td className="py-3 px-3 text-slate-600">
                    {activeOptRun.baselineScorecard.failedTests} initial failure(s)
                  </td>
                  <td className="py-3 px-3 text-slate-500">
                    Original saved agent definition (preserved)
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-slate-800">
                    {formatScore(activeOptRun.baselineScorecard.groundingScore)}
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-slate-800">
                    {formatScore(activeOptRun.baselineScorecard.correctnessScore)}
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-slate-800">
                    {activeOptRun.baselineScorecard.refusalScoreStatus === 'available'
                      ? formatScore(
                          activeOptRun.baselineScorecard.refusalQualityScore
                        )
                      : 'N/A'}
                  </td>
                  <td className="py-3 px-3 text-right font-mono font-semibold text-slate-900">
                    {formatScore(activeOptRun.baselineScorecard.overallScore)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-500 whitespace-nowrap">
                    Baseline ({activeOptRun.baselineScorecard.failedTests} fail)
                  </td>
                </tr>

                {/* Iteration Rows */}
                {activeOptRun.iterations.map((iter) => {
                  const catSummary = Object.entries(
                    iter.failureClassifications.reduce<Record<string, number>>(
                      (acc, fc) => {
                        const label = FAILURE_CATEGORY_LABELS[fc.category];
                        acc[label] = (acc[label] ?? 0) + 1;
                        return acc;
                      },
                      {}
                    )
                  )
                    .map(([label, cnt]) => `${label}: ${cnt}`)
                    .join(', ');

                  const afterCard: ScorecardSnapshot | null = iter.newScorecard;
                  return (
                    <tr key={iter.iterationNumber} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-semibold text-slate-900 whitespace-nowrap">
                        Iteration {iter.iterationNumber}
                        <span className="block text-[11px] font-normal text-slate-500 capitalize">
                          {iter.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="py-3 px-3 font-mono text-slate-800 whitespace-nowrap">
                        v{iter.baseAgentVersion}
                        {iter.newAgentVersion !== null ? (
                          <span className="inline-flex items-center gap-1 ml-1 text-[#1E3A8A] font-semibold">
                            <ArrowRight className="w-3 h-3" />v{iter.newAgentVersion}
                          </span>
                        ) : (
                          ' (unchanged)'
                        )}
                      </td>
                      <td className="py-3 px-3 max-w-xs text-slate-700">
                        <p className="font-medium text-slate-900">
                          {iter.failuresAnalyzedCount} analyzed
                        </p>
                        <p className="text-slate-500">{catSummary || 'None'}</p>
                      </td>
                      <td className="py-3 px-3 max-w-sm text-slate-700">
                        {iter.appliedChangesSummary.length > 0 ? (
                          <ul className="space-y-0.5">
                            {iter.appliedChangesSummary.map((line, i) => (
                              <li key={`sum-${iter.iterationNumber}-${i}`}>{line}</li>
                            ))}
                          </ul>
                        ) : (
                          <span className="text-slate-500">{iter.decisionReason}</span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right font-mono">
                        {afterCard ? (
                          <div>
                            <span className="text-slate-900">
                              {formatScore(afterCard.groundingScore)}
                            </span>
                            <span
                              className={`block text-[11px] ${deltaTextClass(iter.scoreDelta.grounding)}`}
                            >
                              {formatDelta(iter.scoreDelta.grounding)}
                            </span>
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-3 px-3 text-right font-mono">
                        {afterCard ? (
                          <div>
                            <span className="text-slate-900">
                              {formatScore(afterCard.correctnessScore)}
                            </span>
                            <span
                              className={`block text-[11px] ${deltaTextClass(iter.scoreDelta.correctness)}`}
                            >
                              {formatDelta(iter.scoreDelta.correctness)}
                            </span>
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-3 px-3 text-right font-mono">
                        {afterCard ? (
                          afterCard.refusalScoreStatus === 'available' ? (
                            <div>
                              <span className="text-slate-900">
                                {formatScore(afterCard.refusalQualityScore)}
                              </span>
                              <span
                                className={`block text-[11px] ${deltaTextClass(iter.scoreDelta.refusalQuality)}`}
                              >
                                {formatDelta(iter.scoreDelta.refusalQuality)}
                              </span>
                            </div>
                          ) : (
                            'N/A'
                          )
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-3 px-3 text-right font-mono font-semibold">
                        {afterCard ? (
                          <span className="text-slate-900">
                            {formatScore(afterCard.overallScore)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-3 px-4 text-right font-mono whitespace-nowrap">
                        {afterCard ? (
                          <div>
                            <span className={deltaTextClass(iter.scoreDelta.overall)}>
                              {formatDelta(iter.scoreDelta.overall)}
                            </span>
                            <span className="block text-[11px] text-slate-500">
                              {iter.remainingFailureCount ?? 0} remaining fail
                            </span>
                          </div>
                        ) : (
                          <span className="text-slate-500">Pending</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Remaining Failures Section */}
      {activeOptRun && (
        <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              Remaining Failures in Latest Evaluation ({remainingFailureResults.length})
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('evaluation')}
              className="text-xs font-medium text-[#1E3A8A] hover:underline"
            >
              Inspect Full Run in Evaluation
            </button>
          </div>

          {remainingFailureResults.length === 0 ? (
            <p className="text-xs text-emerald-700 font-medium">
              Zero failing test cases remain in run {activeOptRun.currentEvaluationRunId}.
            </p>
          ) : (
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
              {remainingFailureResults.map((res) => (
                <div key={res.testCaseId} className="p-3 text-xs space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono font-semibold text-slate-900">
                      {res.testCaseId} · {res.category}
                    </span>
                    {res.judge && (
                      <span className="font-mono text-slate-600">
                        G: {res.judge.groundingScore}/5 · C:{' '}
                        {res.judge.correctnessScore}/5
                        {res.judge.refusalApplicable
                          ? ` · R: ${res.judge.refusalScore}/5`
                          : ''}
                      </span>
                    )}
                  </div>
                  <p className="font-medium text-slate-800">{res.question}</p>
                  <p className="text-red-700">{res.failureReason}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

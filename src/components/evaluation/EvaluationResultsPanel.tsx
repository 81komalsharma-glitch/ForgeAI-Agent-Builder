import { Fragment, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileSearch,
  History,
  Info,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  SkipForward,
  Wrench,
  XCircle,
} from 'lucide-react';
import type {
  AgentProject,
  EvaluationCategory,
  EvaluationRunRecord,
  EvaluationTestRunStatus,
  NavSectionId,
} from '../../types/agent';
import { formatDateTime } from '../../utils/format';

interface EvaluationResultsPanelProps {
  project: AgentProject;
  runs: EvaluationRunRecord[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  isRunning: boolean;
  activeCaseId: string | null;
  runError: string | null;
  canStartNewRun: boolean;
  agentName: string;
  agentVersion: number | null;
  datasetVersion: number | null;
  totalDatasetTests: number;
  onStartNewRun: () => void;
  onResumeRun: (runId: string) => void;
  onPauseRun: (runId: string) => void;
  onRetryTestCase: (runId: string, testCaseId: string) => void;
  onSkipTestCase: (runId: string, testCaseId: string) => void;
  onNavigate: (section: NavSectionId) => void;
}

const CATEGORY_LABELS: Record<EvaluationCategory, string> = {
  answerable: 'Answerable',
  out_of_scope: 'Out-of-Scope',
  edge_case: 'Edge Case',
};

const RUN_STATUS_LABELS: Record<EvaluationRunRecord['status'], string> = {
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  completed_with_errors: 'Completed with Errors',
  failed: 'Failed',
};

function formatScorePercent(value: number | null): string {
  if (value === null || Number.isNaN(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function formatOutOfFive(value: number | null): string {
  if (value === null || Number.isNaN(value)) return 'N/A';
  return `${value}/5`;
}

function statusTextClass(status: EvaluationTestRunStatus): string {
  switch (status) {
    case 'passed':
      return 'text-emerald-700 font-semibold';
    case 'failed':
      return 'text-red-700 font-semibold';
    case 'error':
      return 'text-amber-800 font-semibold';
    case 'skipped':
      return 'text-slate-500 font-medium';
  }
}

function scoreBarColor(score: number | null): string {
  if (score === null) return 'bg-slate-300';
  if (score >= 80) return 'bg-emerald-600';
  if (score >= 60) return 'bg-[#1E3A8A]';
  return 'bg-red-600';
}

export function EvaluationResultsPanel({
  project,
  runs,
  selectedRunId,
  onSelectRun,
  isRunning,
  activeCaseId,
  runError,
  canStartNewRun,
  agentName,
  agentVersion,
  datasetVersion,
  totalDatasetTests,
  onStartNewRun,
  onResumeRun,
  onPauseRun,
  onRetryTestCase,
  onSkipTestCase,
  onNavigate,
}: EvaluationResultsPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | EvaluationCategory>(
    'all'
  );
  const [statusFilter, setStatusFilter] = useState<
    'all' | EvaluationTestRunStatus
  >('all');
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  const selectedRun = useMemo(() => {
    if (runs.length === 0) return null;
    if (selectedRunId) {
      const match = runs.find((r) => r.runId === selectedRunId);
      if (match) return match;
    }
    return runs[runs.length - 1] ?? null;
  }, [runs, selectedRunId]);

  const orderedRuns = useMemo(() => [...runs].reverse(), [runs]);

  const currentExecutingCase = useMemo(() => {
    if (!selectedRun) return null;
    const targetId = activeCaseId || selectedRun.currentTestCaseId;
    if (!targetId) return null;
    return (
      selectedRun.testCasesSnapshot.find((tc) => tc.id === targetId) ?? null
    );
  }, [selectedRun, activeCaseId]);

  const filteredResults = useMemo(() => {
    if (!selectedRun) return [];
    const q = searchQuery.trim().toLowerCase();
    return selectedRun.results.filter((res) => {
      if (categoryFilter !== 'all' && res.category !== categoryFilter) {
        return false;
      }
      if (statusFilter !== 'all' && res.status !== statusFilter) {
        return false;
      }
      if (!q) return true;
      return (
        res.testCaseId.toLowerCase().includes(q) ||
        res.question.toLowerCase().includes(q) ||
        res.actualAnswer.toLowerCase().includes(q) ||
        res.failureReason.toLowerCase().includes(q) ||
        (res.errorMessage ?? '').toLowerCase().includes(q)
      );
    });
  }, [selectedRun, searchQuery, categoryFilter, statusFilter]);

  const toggleExpand = (testCaseId: string) => {
    setExpandedIds((prev) => ({ ...prev, [testCaseId]: !prev[testCaseId] }));
  };

  if (runs.length === 0 || !selectedRun) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 space-y-6">
        <div className="max-w-2xl mx-auto text-center space-y-3">
          <div className="w-12 h-12 rounded-xl bg-blue-50 text-[#1E3A8A] flex items-center justify-center mx-auto">
            <Play className="w-6 h-6" aria-hidden="true" />
          </div>
          <h2 className="text-lg font-semibold text-slate-900">
            Ready to Run Grounded Agent Evaluation
          </h2>
          <p className="text-sm text-slate-600">
            Each test case is executed sequentially against the generated agent using its saved system prompt, retrieval configuration, and selected tools, then scored independently by the AI Judge on Grounding (0–5), Correctness (0–5), and Refusal Quality (0–5).
          </p>
        </div>

        <div className="max-w-2xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs border border-slate-200 rounded-xl p-4 bg-slate-50">
          <div>
            <p className="text-slate-500">Agent Name</p>
            <p className="mt-1 font-semibold text-slate-900 truncate">
              {agentName}
            </p>
          </div>
          <div>
            <p className="text-slate-500">Agent Version</p>
            <p className="mt-1 font-mono font-semibold text-slate-900">
              {agentVersion !== null ? `v${agentVersion}` : '—'}
            </p>
          </div>
          <div>
            <p className="text-slate-500">Dataset Version</p>
            <p className="mt-1 font-mono font-semibold text-slate-900">
              {datasetVersion !== null ? `v${datasetVersion}` : 'Unsaved'}
            </p>
          </div>
          <div>
            <p className="text-slate-500">Total Test Cases</p>
            <p className="mt-1 font-mono font-semibold text-slate-900 tabular-nums">
              {totalDatasetTests}
            </p>
          </div>
        </div>

        {runError && (
          <div className="max-w-2xl mx-auto rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{runError}</span>
          </div>
        )}

        <div className="flex justify-center">
          <button
            type="button"
            disabled={!canStartNewRun || isRunning}
            onClick={onStartNewRun}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors"
          >
            {isRunning ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            <span>{isRunning ? 'Starting Evaluation Run...' : 'Start Evaluation Run'}</span>
          </button>
        </div>
      </div>
    );
  }

  const { scorecard } = selectedRun;
  const { counts } = scorecard;
  const completedOrAttempted =
    counts.totalTests - counts.pendingTests;
  const progressPct =
    counts.totalTests > 0
      ? Math.round((completedOrAttempted / counts.totalTests) * 100)
      : 0;

  const canResumeSelected =
    !isRunning &&
    counts.pendingTests > 0 &&
    (selectedRun.status === 'paused' || selectedRun.status === 'running');

  const categories: EvaluationCategory[] = [
    'answerable',
    'out_of_scope',
    'edge_case',
  ];

  const isRunComplete =
    selectedRun.status === 'completed' ||
    selectedRun.status === 'completed_with_errors';

  return (
    <div className="space-y-6">
      {/* Run History Selector & Run Metadata Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-600">
              <span className="inline-flex items-center gap-1 font-semibold text-slate-900">
                <History className="w-3.5 h-3.5 text-[#1E3A8A]" aria-hidden="true" />
                Run History ({runs.length})
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-slate-700">
                Agent: {selectedRun.agentName} v{selectedRun.agentVersion}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-slate-700">
                Dataset v{selectedRun.datasetVersion}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-slate-600">
                {RUN_STATUS_LABELS[selectedRun.status]}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-slate-500">
                Started {formatDateTime(selectedRun.startedAt)}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              {orderedRuns.map((runItem) => {
                const active = runItem.runId === selectedRun.runId;
                return (
                  <button
                    key={runItem.runId}
                    type="button"
                    onClick={() => onSelectRun(runItem.runId)}
                    className={`px-2.5 py-1 rounded-md border text-xs font-mono transition-colors ${
                      active
                        ? 'border-[#1E3A8A] bg-blue-50 text-[#1E3A8A] font-semibold'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {runItem.runId} · Agent v{runItem.agentVersion} / Data v
                    {runItem.datasetVersion}
                    {runItem.scorecard.overallScore !== null
                      ? ` · ${runItem.scorecard.overallScore.toFixed(1)}%`
                      : ` · ${RUN_STATUS_LABELS[runItem.status]}`}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <a
              href={`/api/projects/${encodeURIComponent(project.id)}/evaluation/runs/${encodeURIComponent(selectedRun.runId)}/export`}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Export Run JSON</span>
            </a>

            {isRunning && (
              <button
                type="button"
                onClick={() => onPauseRun(selectedRun.runId)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-amber-300 bg-amber-50 text-xs font-medium text-amber-900 hover:bg-amber-100"
              >
                <Pause className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Pause Run</span>
              </button>
            )}

            {canResumeSelected && (
              <button
                type="button"
                onClick={() => onResumeRun(selectedRun.runId)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF]"
              >
                <Play className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Resume Evaluation ({counts.pendingTests} remaining)</span>
              </button>
            )}

            {!isRunning && (
              <button
                type="button"
                disabled={!canStartNewRun}
                onClick={onStartNewRun}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-500 disabled:cursor-not-allowed"
              >
                <Play className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Run New Evaluation</span>
              </button>
            )}
          </div>
        </div>

        {/* Live Progress & Execution Banner */}
        {(isRunning ||
          counts.pendingTests > 0 ||
          selectedRun.status === 'paused' ||
          runError ||
          selectedRun.runErrors.length > 0) && (
          <div className="pt-4 border-t border-slate-100 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 font-medium text-slate-900">
                {isRunning ? (
                  <Loader2 className="w-4 h-4 animate-spin text-[#1E3A8A]" />
                ) : selectedRun.status === 'paused' ? (
                  <Pause className="w-4 h-4 text-amber-700" />
                ) : (
                  <Info className="w-4 h-4 text-[#1E3A8A]" />
                )}
                <span>
                  {isRunning
                    ? `Running test case ${activeCaseId || selectedRun.currentTestCaseId || '...'} sequentially`
                    : selectedRun.status === 'paused'
                      ? `Run paused (${counts.pendingTests} pending test case(s) remaining)`
                      : `Run status: ${RUN_STATUS_LABELS[selectedRun.status]}`}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-3 font-mono tabular-nums text-slate-600">
                <span>
                  Progress: {completedOrAttempted}/{counts.totalTests} ({progressPct}%)
                </span>
                <span className="text-emerald-700">Passed: {counts.passedTests}</span>
                <span className="text-red-700">Failed: {counts.failedTests}</span>
                {counts.errorTests > 0 && (
                  <span className="text-amber-800">Errors: {counts.errorTests}</span>
                )}
                {counts.skippedTests > 0 && (
                  <span className="text-slate-500">Skipped: {counts.skippedTests}</span>
                )}
              </div>
            </div>

            <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full bg-[#1E3A8A] transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>

            {currentExecutingCase && (isRunning || canResumeSelected) && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-700 flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <span className="font-mono font-semibold text-slate-900 mr-2">
                    {isRunning ? 'Executing:' : 'Next Pending:'} {currentExecutingCase.id}
                  </span>
                  <span className="text-slate-700 truncate">
                    {currentExecutingCase.question}
                  </span>
                </div>
                {!isRunning && (
                  <button
                    type="button"
                    onClick={() =>
                      onSkipTestCase(selectedRun.runId, currentExecutingCase.id)
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 font-medium"
                  >
                    <SkipForward className="w-3 h-3" />
                    <span>Skip {currentExecutingCase.id}</span>
                  </button>
                )}
              </div>
            )}

            {(runError || selectedRun.runErrors.length > 0) && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-800 space-y-1">
                <div className="flex items-center gap-1.5 font-semibold">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>Execution Notice</span>
                </div>
                {runError && <p>{runError}</p>}
                {selectedRun.runErrors.slice(-3).map((errLine, idx) => (
                  <p key={`run-err-${idx}`} className="font-mono">
                    {errLine}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Incomplete / Error Disclaimer if Applicable */}
      {counts.errorTests > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <span>
              <strong>{counts.errorTests} test case(s) encountered execution errors</strong> and were excluded from the average quality scores (never marked as passed). You can retry or skip failed execution rows below.
            </span>
          </div>
        </div>
      )}

      {/* Scorecard KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Overall Score</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {formatScorePercent(scorecard.overallScore)}
          </p>
          <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            {counts.evaluatedTests} judged / {counts.totalTests} total
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">
            Grounding ({Math.round(scorecard.weightsUsed.grounding * 100)}%)
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {formatScorePercent(scorecard.groundingScore)}
          </p>
          <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            Across {counts.groundingTestsUsed} test(s)
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">
            Correctness ({Math.round(scorecard.weightsUsed.correctness * 100)}%)
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {formatScorePercent(scorecard.correctnessScore)}
          </p>
          <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            Across {counts.correctnessTestsUsed} test(s)
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">
            Refusal Quality (
            {scorecard.refusalScoreStatus === 'available'
              ? `${Math.round(scorecard.weightsUsed.refusal * 100)}%`
              : 'Excluded'}
            )
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {scorecard.refusalScoreStatus === 'available'
              ? formatScorePercent(scorecard.refusalQualityScore)
              : 'Unavailable'}
          </p>
          <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            {scorecard.refusalScoreStatus === 'available'
              ? `Across ${counts.refusalTestsUsed} refusal test(s)`
              : '0 applicable refusal tests'}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Pass / Fail Tally</p>
          <div className="mt-2 flex items-baseline gap-3 font-mono tabular-nums">
            <span className="text-lg font-semibold text-emerald-700">
              {counts.passedTests} Pass
            </span>
            <span className="text-lg font-semibold text-red-700">
              {counts.failedTests} Fail
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            {counts.errorTests} Err · {counts.skippedTests} Skip ·{' '}
            {counts.pendingTests} Pend
          </p>
        </div>
      </div>

      {/* Transparent Scoring Formulas & Score Chart / Category Table */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Transparent Scoring Math Card */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              Transparent Scoring Formulas
            </h2>
            <span className="text-xs font-mono text-slate-500">
              Independent AI Judge
            </span>
          </div>

          <div className="space-y-2 text-xs font-mono text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-3.5">
            <p className="text-slate-900 font-semibold">{scorecard.formulaText}</p>
            <p>{scorecard.groundingFormulaText}</p>
            <p>{scorecard.correctnessFormulaText}</p>
            <p>{scorecard.refusalFormulaText}</p>
          </div>

          <div className="rounded-lg border border-slate-200 p-3 text-xs text-slate-600 space-y-1">
            <p className="font-semibold text-slate-800 flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 text-[#1E3A8A]" />
              <span>Bias &amp; Grounding Safeguards Active</span>
            </p>
            <p>
              Judge evaluates strictly against expected key facts and retrieved document chunks (agent version is hidden; response length/verbosity is ignored; deterministic refusal and zero-fact-overlap overrides cap inflated scores).
            </p>
          </div>

          {isRunComplete && counts.evaluatedTests > 0 && (
            <div className="pt-1 flex items-center justify-between gap-2">
              <span className="text-xs text-slate-500">
                Ready to inspect failures in Stage 05?
              </span>
              <button
                type="button"
                onClick={() => onNavigate('optimizer')}
                className="px-3 py-1.5 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF]"
              >
                Open Optimizer
              </button>
            </div>
          )}
        </section>

        {/* Dimension Bars & Category-Wise Breakdown */}
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-[#1E3A8A]" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-slate-900">
                Metric &amp; Category Performance
              </h2>
            </div>
            <span className="text-xs font-mono text-slate-500">
              Run {selectedRun.runId}
            </span>
          </div>

          {/* Horizontal Bar Chart of Top-Level Scores */}
          <div className="space-y-2.5">
            {[
              {
                label: 'Overall Weighted Score',
                score: scorecard.overallScore,
              },
              {
                label: 'Grounding (0–5 scaled)',
                score: scorecard.groundingScore,
              },
              {
                label: 'Correctness (0–5 scaled)',
                score: scorecard.correctnessScore,
              },
              {
                label:
                  scorecard.refusalScoreStatus === 'available'
                    ? 'Refusal Quality (0–5 scaled)'
                    : 'Refusal Quality (Unavailable)',
                score: scorecard.refusalQualityScore,
              },
            ].map((bar) => (
              <div key={bar.label} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-700 font-medium">{bar.label}</span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {formatScorePercent(bar.score)}
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className={`h-full transition-all duration-300 ${scoreBarColor(bar.score)}`}
                    style={{
                      width: `${bar.score !== null ? Math.max(0, Math.min(100, bar.score)) : 0}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Category Breakdown Table */}
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-medium">
                  <th className="py-2.5 px-3">Category</th>
                  <th className="py-2.5 px-3 text-right">Pass / Total</th>
                  <th className="py-2.5 px-3 text-right">Pass Rate</th>
                  <th className="py-2.5 px-3 text-right">Grounding</th>
                  <th className="py-2.5 px-3 text-right">Correctness</th>
                  <th className="py-2.5 px-3 text-right">Refusal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                {categories.map((cat) => {
                  const row = scorecard.byCategory[cat];
                  return (
                    <tr key={cat} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-3 font-sans font-medium text-slate-900">
                        {CATEGORY_LABELS[cat]}
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-700">
                        {row.passed}/{row.completed}
                        {row.errors > 0 ? ` (${row.errors} err)` : ''}
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-900 font-semibold">
                        {formatScorePercent(row.passRatePercent)}
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-700">
                        {formatScorePercent(row.avgGroundingPercent)}
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-700">
                        {formatScorePercent(row.avgCorrectnessPercent)}
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-700">
                        {row.avgRefusalPercent !== null
                          ? formatScorePercent(row.avgRefusalPercent)
                          : 'N/A'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {/* Test Case Results Filter & Expandable Table */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Individual Test Case Results ({selectedRun.results.length})
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Expand any row to inspect expected facts, actual agent response, retrieved chunks, tools used, and AI Judge rationale.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px]">
              <Search
                className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search ID, question, answer..."
                aria-label="Search evaluation results"
                className="h-9 pl-8 pr-3 rounded-lg border border-slate-200 bg-slate-50 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-[#1E3A8A]"
              />
            </div>

            <select
              value={categoryFilter}
              onChange={(e) =>
                setCategoryFilter(e.target.value as 'all' | EvaluationCategory)
              }
              aria-label="Filter results by category"
              className="h-9 px-2.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700"
            >
              <option value="all">All Categories</option>
              <option value="answerable">Answerable</option>
              <option value="out_of_scope">Out-of-Scope</option>
              <option value="edge_case">Edge Case</option>
            </select>

            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as 'all' | EvaluationTestRunStatus)
              }
              aria-label="Filter results by status"
              className="h-9 px-2.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700"
            >
              <option value="all">All Statuses</option>
              <option value="passed">Passed ({counts.passedTests})</option>
              <option value="failed">Failed ({counts.failedTests})</option>
              <option value="error">Error ({counts.errorTests})</option>
              <option value="skipped">Skipped ({counts.skippedTests})</option>
            </select>
          </div>
        </div>

        {filteredResults.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-600">
            {selectedRun.results.length === 0
              ? 'No test cases have executed yet in this run.'
              : 'No test results match the current filter criteria.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-medium">
                  <th className="py-2.5 px-4 w-8" aria-label="Expand" />
                  <th className="py-2.5 px-3">Test ID</th>
                  <th className="py-2.5 px-3">Question</th>
                  <th className="py-2.5 px-3">Category</th>
                  <th className="py-2.5 px-3">Result</th>
                  <th className="py-2.5 px-3 text-right">Grounding</th>
                  <th className="py-2.5 px-3 text-right">Correctness</th>
                  <th className="py-2.5 px-3 text-right">Refusal</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredResults.map((res) => {
                  const isExpanded = Boolean(expandedIds[res.testCaseId]);
                  const isRetryingThis =
                    isRunning && activeCaseId === res.testCaseId;
                  return (
                    <Fragment key={res.testCaseId}>
                      <tr
                        className={`transition-colors ${
                          isExpanded ? 'bg-blue-50/30' : 'hover:bg-slate-50/70'
                        }`}
                      >
                        <td className="py-3 px-4">
                          <button
                            type="button"
                            onClick={() => toggleExpand(res.testCaseId)}
                            aria-label={`Toggle details for ${res.testCaseId}`}
                            className="p-1 rounded hover:bg-slate-200/70 text-slate-600"
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-4 h-4" />
                            ) : (
                              <ChevronRight className="w-4 h-4" />
                            )}
                          </button>
                        </td>
                        <td className="py-3 px-3 font-mono font-semibold text-slate-900 whitespace-nowrap">
                          {res.testCaseId}
                        </td>
                        <td className="py-3 px-3 max-w-md">
                          <button
                            type="button"
                            onClick={() => toggleExpand(res.testCaseId)}
                            className="text-left text-slate-900 font-medium hover:text-[#1E3A8A] line-clamp-2"
                          >
                            {res.question}
                          </button>
                          {(res.failureReason || res.errorMessage) && (
                            <p className="mt-0.5 text-slate-500 line-clamp-1">
                              {res.errorMessage || res.failureReason}
                            </p>
                          )}
                        </td>
                        <td className="py-3 px-3 text-slate-700 whitespace-nowrap">
                          {CATEGORY_LABELS[res.category]}
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-1 ${statusTextClass(res.status)}`}
                          >
                            {res.status === 'passed' && (
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            )}
                            {res.status === 'failed' && (
                              <XCircle className="w-3.5 h-3.5" />
                            )}
                            {res.status === 'error' && (
                              <AlertCircle className="w-3.5 h-3.5" />
                            )}
                            {res.status === 'skipped' && (
                              <SkipForward className="w-3.5 h-3.5" />
                            )}
                            <span className="capitalize">{res.status}</span>
                          </span>
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-900">
                          {res.judge
                            ? formatOutOfFive(res.judge.groundingScore)
                            : '—'}
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-900">
                          {res.judge
                            ? formatOutOfFive(res.judge.correctnessScore)
                            : '—'}
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-700">
                          {res.judge && res.judge.refusalApplicable
                            ? formatOutOfFive(res.judge.refusalScore)
                            : 'N/A'}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            {(res.status === 'error' || res.status === 'skipped') && (
                              <button
                                type="button"
                                disabled={isRunning}
                                onClick={() =>
                                  onRetryTestCase(selectedRun.runId, res.testCaseId)
                                }
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                                title="Re-run this test case"
                              >
                                {isRetryingThis ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <RefreshCw className="w-3 h-3" />
                                )}
                                <span>Retry</span>
                              </button>
                            )}
                            {res.status === 'error' && (
                              <button
                                type="button"
                                disabled={isRunning}
                                onClick={() =>
                                  onSkipTestCase(selectedRun.runId, res.testCaseId)
                                }
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                                title="Mark as skipped"
                              >
                                <SkipForward className="w-3 h-3" />
                                <span>Skip</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => toggleExpand(res.testCaseId)}
                              className="px-2 py-1 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                            >
                              {isExpanded ? 'Hide' : 'Inspect'}
                            </button>
                          </div>
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr className="bg-slate-50/70">
                          <td colSpan={9} className="p-4">
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                              {/* Left: Expected vs Actual */}
                              <div className="space-y-3">
                                <div className="bg-white border border-slate-200 rounded-lg p-3.5 space-y-2">
                                  <p className="font-semibold text-slate-900">
                                    Expected Result &amp; Key Facts
                                  </p>
                                  <p className="text-slate-700 leading-relaxed">
                                    {res.expectedBehavior}
                                  </p>
                                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-600 font-mono">
                                    <span>
                                      Expected Refusal:{' '}
                                      <strong>
                                        {res.expectedRefusal ? 'Yes' : 'No'}
                                      </strong>
                                    </span>
                                    {res.expectedSourceDocument && (
                                      <span>
                                        Expected Source:{' '}
                                        <strong>{res.expectedSourceDocument}</strong>
                                      </span>
                                    )}
                                  </div>
                                  {res.expectedKeyFacts.length > 0 && (
                                    <ul className="list-disc pl-4 space-y-0.5 text-slate-700">
                                      {res.expectedKeyFacts.map((fact, idx) => (
                                        <li key={`${res.testCaseId}-ef-${idx}`}>
                                          {fact}
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                  {res.expectedSupportingEvidence && (
                                    <p className="text-slate-600 border-t border-slate-100 pt-2">
                                      <span className="font-semibold text-slate-700">
                                        Expected Evidence:{' '}
                                      </span>
                                      {res.expectedSupportingEvidence}
                                    </p>
                                  )}
                                </div>

                                <div className="bg-white border border-slate-200 rounded-lg p-3.5 space-y-2">
                                  <div className="flex items-center justify-between">
                                    <p className="font-semibold text-slate-900">
                                      Actual Agent Response
                                    </p>
                                    <span className="font-mono text-slate-500">
                                      {res.durationMs} ms
                                    </span>
                                  </div>
                                  <div className="text-slate-800 whitespace-pre-wrap leading-relaxed bg-slate-50 border border-slate-200 rounded p-2.5 max-h-64 overflow-y-auto">
                                    {res.actualAnswer ||
                                      res.errorMessage ||
                                      '(No agent answer captured)'}
                                  </div>
                                </div>

                                {/* Retrieved Evidence & Tools */}
                                <div className="bg-white border border-slate-200 rounded-lg p-3.5 space-y-2.5">
                                  <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                                    <FileSearch className="w-3.5 h-3.5 text-[#1E3A8A]" />
                                    <span>
                                      Retrieved Evidence ({res.retrievedEvidence.length})
                                    </span>
                                  </div>
                                  {res.retrievedEvidence.length === 0 ? (
                                    <p className="text-slate-500">
                                      No document chunks met the similarity threshold for this query.
                                    </p>
                                  ) : (
                                    <div className="space-y-2 max-h-52 overflow-y-auto">
                                      {res.retrievedEvidence.map((chunk) => (
                                        <div
                                          key={chunk.chunkId}
                                          className="border border-slate-200 rounded p-2 bg-slate-50"
                                        >
                                          <div className="flex items-center justify-between font-mono text-[11px] text-slate-600 mb-1">
                                            <span className="font-semibold text-[#1E3A8A]">
                                              {chunk.documentName} · {chunk.chunkId}
                                            </span>
                                            <span>Score: {chunk.score}</span>
                                          </div>
                                          <p className="text-slate-700 leading-relaxed">
                                            {chunk.snippet}
                                          </p>
                                        </div>
                                      ))}
                                    </div>
                                  )}

                                  <div className="pt-2 border-t border-slate-100">
                                    <div className="flex items-center gap-1.5 font-semibold text-slate-900 mb-1.5">
                                      <Wrench className="w-3.5 h-3.5 text-[#1E3A8A]" />
                                      <span>Tools Used ({res.toolsUsed.length})</span>
                                    </div>
                                    {res.toolsUsed.length === 0 ? (
                                      <p className="text-slate-500">
                                        No tools invoked during this turn.
                                      </p>
                                    ) : (
                                      <div className="space-y-1.5">
                                        {res.toolsUsed.map((tool, idx) => (
                                          <div
                                            key={`${res.testCaseId}-tool-${idx}`}
                                            className="border border-slate-200 rounded p-2 bg-slate-50 font-mono text-[11px]"
                                          >
                                            <div className="flex justify-between">
                                              <span className="font-semibold text-slate-900">
                                                {tool.toolName}
                                              </span>
                                              <span
                                                className={
                                                  tool.status === 'success'
                                                    ? 'text-emerald-700'
                                                    : 'text-red-700'
                                                }
                                              >
                                                {tool.status}
                                              </span>
                                            </div>
                                            <p className="text-slate-600 mt-0.5 truncate">
                                              Input: {JSON.stringify(tool.input)}
                                            </p>
                                            <p className="text-slate-700 mt-0.5 break-all">
                                              Output: {JSON.stringify(tool.output)}
                                            </p>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>

                              {/* Right: Judge Reasoning & Deterministic Checks */}
                              <div className="space-y-3">
                                <div className="bg-white border border-slate-200 rounded-lg p-3.5 space-y-3">
                                  <p className="font-semibold text-slate-900">
                                    Independent AI Judge Evaluation
                                  </p>

                                  {res.errorMessage && (
                                    <div className="rounded border border-red-200 bg-red-50 p-2.5 text-red-800">
                                      <strong>Execution Error: </strong>
                                      {res.errorMessage}
                                    </div>
                                  )}

                                  {res.judge ? (
                                    <>
                                      <div className="space-y-2.5">
                                        <div className="border border-slate-200 rounded p-2.5">
                                          <div className="flex justify-between font-semibold text-slate-900 mb-1">
                                            <span>Grounding Score</span>
                                            <span className="font-mono">
                                              {res.judge.groundingScore}/5
                                            </span>
                                          </div>
                                          <p className="text-slate-700 leading-relaxed">
                                            {res.judge.groundingExplanation}
                                          </p>
                                        </div>

                                        <div className="border border-slate-200 rounded p-2.5">
                                          <div className="flex justify-between font-semibold text-slate-900 mb-1">
                                            <span>Correctness Score</span>
                                            <span className="font-mono">
                                              {res.judge.correctnessScore}/5
                                            </span>
                                          </div>
                                          <p className="text-slate-700 leading-relaxed">
                                            {res.judge.correctnessExplanation}
                                          </p>
                                        </div>

                                        <div className="border border-slate-200 rounded p-2.5">
                                          <div className="flex justify-between font-semibold text-slate-900 mb-1">
                                            <span>Refusal Quality</span>
                                            <span className="font-mono">
                                              {res.judge.refusalApplicable
                                                ? formatOutOfFive(res.judge.refusalScore)
                                                : 'Not Applicable'}
                                            </span>
                                          </div>
                                          <p className="text-slate-700 leading-relaxed">
                                            {res.judge.refusalExplanation}
                                          </p>
                                        </div>
                                      </div>

                                      {res.judge.supportingEvidence && (
                                        <div>
                                          <p className="font-semibold text-slate-800 mb-1">
                                            Judge Supporting Evidence
                                          </p>
                                          <p className="text-slate-700 bg-slate-50 border border-slate-200 rounded p-2">
                                            {res.judge.supportingEvidence}
                                          </p>
                                        </div>
                                      )}

                                      {(res.failureReason ||
                                        res.judge.failureReasons.length > 0) && (
                                        <div className="rounded border border-red-200 bg-red-50 p-2.5 text-red-900 space-y-1">
                                          <p className="font-semibold">Failure Reasons</p>
                                          {res.judge.failureReasons.length > 0 ? (
                                            <ul className="list-disc pl-4 space-y-0.5">
                                              {res.judge.failureReasons.map((fr, i) => (
                                                <li key={`${res.testCaseId}-fr-${i}`}>
                                                  {fr}
                                                </li>
                                              ))}
                                            </ul>
                                          ) : (
                                            <p>{res.failureReason}</p>
                                          )}
                                        </div>
                                      )}

                                      {res.judge.deterministicOverridesApplied.length >
                                        0 && (
                                        <div className="rounded border border-amber-200 bg-amber-50 p-2.5 text-amber-900 space-y-1">
                                          <p className="font-semibold">
                                            Deterministic Safeguard Overrides Applied
                                          </p>
                                          <ul className="list-disc pl-4 space-y-0.5">
                                            {res.judge.deterministicOverridesApplied.map(
                                              (ov, i) => (
                                                <li key={`${res.testCaseId}-ov-${i}`}>
                                                  {ov}
                                                </li>
                                              )
                                            )}
                                          </ul>
                                        </div>
                                      )}
                                    </>
                                  ) : (
                                    <p className="text-slate-500">
                                      No judge scores recorded for this test case.
                                    </p>
                                  )}
                                </div>

                                {/* Deterministic Verification Checks */}
                                <div className="bg-white border border-slate-200 rounded-lg p-3.5 space-y-2">
                                  <p className="font-semibold text-slate-900">
                                    Deterministic Pre-Checks
                                  </p>
                                  <div className="grid grid-cols-2 gap-2 font-mono text-slate-700">
                                    <div>
                                      Refusal Detected:{' '}
                                      <strong>
                                        {res.deterministicChecks.detectedRefusal
                                          ? 'Yes'
                                          : 'No'}
                                      </strong>
                                    </div>
                                    <div>
                                      Refusal Match:{' '}
                                      <strong
                                        className={
                                          res.deterministicChecks.refusalMatchPassed
                                            ? 'text-emerald-700'
                                            : 'text-red-700'
                                        }
                                      >
                                        {res.deterministicChecks.refusalMatchPassed
                                          ? 'Passed'
                                          : 'Mismatch'}
                                      </strong>
                                    </div>
                                    <div>
                                      Key Fact Overlap:{' '}
                                      <strong>
                                        {res.deterministicChecks.expectedFactsMatched.length}/
                                        {res.deterministicChecks.expectedFactsTotal} (
                                        {Math.round(
                                          res.deterministicChecks.factCoverageRatio *
                                            100
                                        )}
                                        %)
                                      </strong>
                                    </div>
                                    <div>
                                      Source Match:{' '}
                                      <strong>
                                        {res.deterministicChecks.expectedSourceMatched ===
                                        null
                                          ? 'N/A'
                                          : res.deterministicChecks
                                                .expectedSourceMatched
                                            ? 'Matched'
                                            : 'Not Cited'}
                                      </strong>
                                    </div>
                                  </div>
                                  {res.deterministicChecks.notes.length > 0 && (
                                    <ul className="list-disc pl-4 text-slate-600 space-y-0.5">
                                      {res.deterministicChecks.notes.map((n, idx) => (
                                        <li key={`${res.testCaseId}-dn-${idx}`}>{n}</li>
                                      ))}
                                    </ul>
                                  )}
                                </div>
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
    </div>
  );
}

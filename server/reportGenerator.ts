import crypto from 'crypto';
import { Type } from '@google/genai';
import { generateStructuredJson, isGeminiConfigured, summarizeGeminiError } from './gemini.ts';
import {
  REPORT_SYNTHESIS_PROMPT_TEMPLATE,
  REPORT_SYNTHESIS_SYSTEM_INSTRUCTION,
} from './prompts/reportPrompts.ts';
import type {
  AgentProject,
  AgentVersionRecord,
  EvaluationCategory,
  EvaluationRunRecord,
  FailureCategory,
  OptimizationRunRecord,
  OptimizationStoppingReason,
  ProjectReportVersion,
  ReportCategoryResult,
  ReportCompletenessStatus,
  ReportFailureDetail,
  ReportIterationEntry,
  ReportScorecard,
  ReportTestResultEntry,
  ReportValidationResult,
} from './types.ts';

const STOPPING_REASON_LABELS: Record<
  NonNullable<OptimizationStoppingReason>,
  string
> = {
  all_tests_passed: 'All Evaluated Tests Passed',
  no_meaningful_fix_identified: 'No Meaningful Targeted Fix Identified',
  score_did_not_improve: 'Stopped Because Score Did Not Improve',
  max_iterations_reached: 'Maximum 3 Iterations Reached',
  all_changes_rejected: 'All Proposed Changes Rejected by User',
  user_stopped: 'Stopped Manually by User',
  execution_error: 'Stopped Due to Execution Error',
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function emptyScorecard(): ReportScorecard {
  return {
    overallScore: null,
    groundingScore: null,
    correctnessScore: null,
    refusalQualityScore: null,
    refusalScoreStatus: 'not_available',
    passedTests: null,
    failedTests: null,
    errorTests: null,
    skippedTests: null,
    evaluatedTests: null,
    totalTests: null,
    passRatePercent: null,
  };
}

function toReportScorecard(run: EvaluationRunRecord): ReportScorecard {
  const sc = run.scorecard;
  const evaluated = sc.counts.evaluatedTests;
  const passRatePercent =
    evaluated > 0 ? round2((sc.counts.passedTests / evaluated) * 100) : null;

  return {
    overallScore: sc.overallScore,
    groundingScore: sc.groundingScore,
    correctnessScore: sc.correctnessScore,
    refusalQualityScore: sc.refusalQualityScore,
    refusalScoreStatus: sc.refusalScoreStatus,
    passedTests: sc.counts.passedTests,
    failedTests: sc.counts.failedTests,
    errorTests: sc.counts.errorTests,
    skippedTests: sc.counts.skippedTests,
    evaluatedTests: evaluated,
    totalTests: sc.counts.totalTests,
    passRatePercent,
  };
}

function isRunIncomplete(run: EvaluationRunRecord): {
  incomplete: boolean;
  reason: string | null;
} {
  const counts = run.scorecard.counts;
  const reasons: string[] = [];

  if (run.status === 'running' || run.status === 'paused' || run.status === 'failed') {
    reasons.push(`Evaluation run status is "${run.status}".`);
  }
  if (run.status === 'completed_with_errors' || counts.errorTests > 0) {
    reasons.push(`${counts.errorTests} test execution error(s) occurred.`);
  }
  if (counts.skippedTests > 0) {
    reasons.push(`${counts.skippedTests} test(s) were skipped.`);
  }
  if (counts.pendingTests > 0) {
    reasons.push(`${counts.pendingTests} test(s) remain pending.`);
  }
  if (counts.evaluatedTests === 0) {
    reasons.push('Zero test cases have been evaluated.');
  }

  return {
    incomplete: reasons.length > 0,
    reason: reasons.length > 0 ? reasons.join(' ') : null,
  };
}

function extractCategoryBreakdown(run: EvaluationRunRecord): ReportCategoryResult[] {
  const categories: EvaluationCategory[] = ['answerable', 'out_of_scope', 'edge_case'];
  return categories.map((cat) => {
    const s = run.scorecard.byCategory?.[cat];
    if (!s) {
      return {
        category: cat,
        total: 0,
        completed: 0,
        passed: 0,
        failed: 0,
        errors: 0,
        skipped: 0,
        passRatePercent: null,
        avgGroundingPercent: null,
        avgCorrectnessPercent: null,
        avgRefusalPercent: null,
      };
    }
    return {
      category: cat,
      total: s.total,
      completed: s.completed,
      passed: s.passed,
      failed: s.failed,
      errors: s.errors,
      skipped: s.skipped,
      passRatePercent: s.passRatePercent,
      avgGroundingPercent: s.avgGroundingPercent,
      avgCorrectnessPercent: s.avgCorrectnessPercent,
      avgRefusalPercent: s.avgRefusalPercent,
    };
  });
}

function extractFailureDetails(run: EvaluationRunRecord): ReportFailureDetail[] {
  return run.results
    .filter((r) => r.status === 'failed' || r.status === 'error' || r.status === 'skipped')
    .map((r) => ({
      testCaseId: r.testCaseId,
      category: r.category,
      difficulty: r.difficulty,
      question: r.question,
      status: r.status,
      failureReason:
        r.failureReason ||
        r.errorMessage ||
        (r.status === 'skipped'
          ? 'Test case was skipped during execution.'
          : 'No failure reason recorded.'),
      errorMessage: r.errorMessage,
      expectedBehavior: r.expectedBehavior,
      actualAnswer: r.actualAnswer || '',
      retrievedSources: Array.isArray(r.sourcesRetrieved) ? r.sourcesRetrieved : [],
      groundingScore: r.judge?.groundingScore ?? null,
      correctnessScore: r.judge?.correctnessScore ?? null,
      refusalScore: r.judge?.refusalScore ?? null,
      judgeFailureReasons: r.judge?.failureReasons ?? [],
    }));
}

function selectBaselineAndFinalRuns(
  project: AgentProject,
  latestOptRun: OptimizationRunRecord | null
): {
  baselineRun: EvaluationRunRecord | null;
  finalRun: EvaluationRunRecord | null;
} {
  const runs = project.evaluationRuns ?? [];
  if (runs.length === 0) {
    return { baselineRun: null, finalRun: null };
  }

  let baselineRun: EvaluationRunRecord | null = null;
  if (latestOptRun) {
    baselineRun =
      runs.find((r) => r.runId === latestOptRun.baselineEvaluationRunId) ?? null;
  }
  if (!baselineRun) {
    baselineRun = runs[0];
  }

  let finalRun: EvaluationRunRecord | null = null;
  if (latestOptRun) {
    finalRun =
      runs.find((r) => r.runId === latestOptRun.currentEvaluationRunId) ?? null;
  }
  if (!finalRun) {
    finalRun = runs[runs.length - 1];
  }

  return { baselineRun, finalRun };
}

function buildDeterministicLimitationsAndImprovements(
  project: AgentProject,
  baselineRun: EvaluationRunRecord | null,
  finalRun: EvaluationRunRecord | null,
  latestOptRun: OptimizationRunRecord | null,
  missingArtifacts: string[]
): ProjectReportVersion['limitationsAndFutureImprovements'] {
  const reqs = project.requirements;
  const unsupportedRequirements: string[] = [];
  if (!reqs) {
    unsupportedRequirements.push('Requirements analysis has not been generated yet.');
  } else if (reqs.groundability?.checks?.length) {
    for (const check of reqs.groundability.checks) {
      if (check.status === 'Unsupported' || check.status === 'Partially Supported') {
        unsupportedRequirements.push(
          `${check.status}: ${check.capability} — ${check.unsupportedReason || check.evidenceSummary}`
        );
      }
    }
  }
  if (unsupportedRequirements.length === 0 && reqs) {
    unsupportedRequirements.push(
      'No unsupported or partially supported capabilities flagged in groundability checks.'
    );
  }

  const retrievalLimitations: string[] = [];
  const latestAgentVer =
    project.agentConfig?.versions[project.agentConfig.versions.length - 1] ?? null;
  if (project.documents.length === 0) {
    retrievalLimitations.push(
      'No knowledge documents are uploaded; retrieval cannot ground answers in external project files.'
    );
  }
  const erroredDocs = project.documents.filter((d) => d.parseStatus === 'error');
  if (erroredDocs.length > 0) {
    retrievalLimitations.push(
      `${erroredDocs.length} uploaded document(s) failed parsing and cannot be retrieved.`
    );
  }
  if (latestAgentVer) {
    const kc = latestAgentVer.definition.knowledgeConfig;
    retrievalLimitations.push(
      `In-memory chunking & hybrid keyword/TF-IDF retrieval is used during evaluation (chunkSize=${kc.chunkSize}, overlap=${kc.chunkOverlap}, topK=${kc.topK}, similarityThreshold=${kc.similarityThreshold}).`
    );
    retrievalLimitations.push(
      `Knowledge configuration (${kc.implementationStatus}) is declarative for standalone deployment; production vector DB indexing is not connected.`
    );
  } else {
    retrievalLimitations.push('Retrieval configuration is Not Available (no agent built yet).');
  }

  const evaluationLimitations: string[] = [];
  const savedDataset =
    project.evaluation?.versions.find(
      (v) => v.version === project.evaluation?.savedVersion
    ) ??
    project.evaluation?.versions[project.evaluation.versions.length - 1] ??
    null;

  if (!savedDataset) {
    evaluationLimitations.push('Evaluation dataset has not been generated.');
  } else if (savedDataset.testCases.length < 20) {
    evaluationLimitations.push(
      `Evaluation dataset contains only ${savedDataset.testCases.length} test case(s), below the 20-case completeness threshold.`
    );
  }
  if (!finalRun) {
    evaluationLimitations.push('No evaluation run has been executed yet.');
  } else {
    const inc = isRunIncomplete(finalRun);
    if (inc.incomplete && inc.reason) {
      evaluationLimitations.push(`Final evaluation is incomplete: ${inc.reason}`);
    }
    evaluationLimitations.push(
      'Evaluation uses single-turn synthetic test cases judged by an LLM judge combined with deterministic checks; multi-turn user behavior and real human ratings are not measured.'
    );
  }

  const knownAgentWeaknesses: string[] = [];
  if (finalRun) {
    const failures = extractFailureDetails(finalRun);
    if (failures.length === 0 && !isRunIncomplete(finalRun).incomplete) {
      knownAgentWeaknesses.push(
        `All ${finalRun.scorecard.counts.evaluatedTests} evaluated test cases passed in run ${finalRun.runId}.`
      );
    } else {
      for (const f of failures.slice(0, 5)) {
        knownAgentWeaknesses.push(
          `[${f.testCaseId} · ${f.category} · ${f.status.toUpperCase()}] ${f.failureReason}`
        );
      }
      if (failures.length > 5) {
        knownAgentWeaknesses.push(
          `Plus ${failures.length - 5} additional failing/errored/skipped test case(s) listed in Section G.`
        );
      }
    }
  } else {
    knownAgentWeaknesses.push(
      'Agent weaknesses cannot be empirically assessed until an evaluation run completes.'
    );
  }

  const unimplementedFeatures = [
    'Interactive Chat with Agent sandbox (Stage 07) is not yet implemented.',
    'External tool integrations defined in output/tool specs remain specification-only (no third-party API execution).',
    'Persistent external vector database / embedding index outside per-project local JSON storage is not connected.',
  ];

  const recommendedNextImprovements: string[] = [];
  if (missingArtifacts.length > 0) {
    recommendedNextImprovements.push(
      `Complete missing pipeline artifacts first: ${missingArtifacts.join(', ')}.`
    );
  }
  if (reqs?.groundability?.checks.some((c) => c.status !== 'Supported')) {
    recommendedNextImprovements.push(
      'Upload additional authoritative documents covering partially supported or unsupported requirements.'
    );
  }
  if (latestOptRun) {
    const iterWithFailures = latestOptRun.iterations.flatMap((it) => it.failureClassifications);
    const hasRetrievalMiss = iterWithFailures.some((c) => c.category === 'retrieval_miss');
    const hasHallucination = iterWithFailures.some((c) => c.category === 'hallucination');
    const hasWrongRefusal = iterWithFailures.some((c) => c.category === 'wrong_refusal');
    if (hasRetrievalMiss) {
      recommendedNextImprovements.push(
        'Refine document chunk boundaries or expand synonym coverage/topK for retrieval miss cases.'
      );
    }
    if (hasHallucination) {
      recommendedNextImprovements.push(
        'Tighten system prompt citation constraints and lower inference ambiguity on numeric/edge-case claims.'
      );
    }
    if (hasWrongRefusal) {
      recommendedNextImprovements.push(
        'Clarify boundary examples between answerable and must-refuse topics in system prompt instructions.'
      );
    }
  }
  if (recommendedNextImprovements.length === 0) {
    recommendedNextImprovements.push(
      'Expand evaluation coverage with domain-expert edge cases and test interactive multi-turn conversations before production deployment.'
    );
  }

  // Deterministic executive summary (never invents missing scores)
  const summaryParts: string[] = [];
  summaryParts.push(
    `Report for "${project.name}" (${project.domain}) covers pipeline stage "${project.stage}" with ${project.documents.length} uploaded document(s).`
  );
  if (!finalRun) {
    summaryParts.push(
      'No evaluation run has been completed yet, so empirical grounding, correctness, and refusal scores are Not Available.'
    );
  } else {
    const finalSc = finalRun.scorecard;
    const baseSc = baselineRun?.scorecard;
    if (
      latestOptRun &&
      baselineRun &&
      baselineRun.runId !== finalRun.runId &&
      baseSc?.overallScore !== null &&
      finalSc.overallScore !== null
    ) {
      const delta = round2(finalSc.overallScore - baseSc.overallScore);
      const sign = delta > 0 ? '+' : '';
      summaryParts.push(
        `Baseline overall score was ${baseSc.overallScore.toFixed(1)}% (Agent v${baselineRun.agentVersion}); after ${latestOptRun.iterations.filter((i) => i.status === 'completed').length} optimization iteration(s), final overall score is ${finalSc.overallScore.toFixed(1)}% (Agent v${finalRun.agentVersion}, ${sign}${delta.toFixed(2)} pts).`
      );
    } else if (finalSc.overallScore !== null) {
      summaryParts.push(
        `Recorded evaluation run (${finalRun.runId}, Agent v${finalRun.agentVersion}) achieved ${finalSc.overallScore.toFixed(1)}% overall score (${finalSc.counts.passedTests} passed, ${finalSc.counts.failedTests} failed, ${finalSc.counts.errorTests} error, ${finalSc.counts.skippedTests} skipped).`
      );
    } else {
      summaryParts.push(
        `Evaluation run ${finalRun.runId} has no scorable overall percentage (${finalSc.counts.errorTests} errors, ${finalSc.counts.skippedTests} skipped).`
      );
    }
  }
  if (missingArtifacts.length > 0) {
    summaryParts.push(
      `Missing or incomplete pipeline stages are explicitly marked Not Available: ${missingArtifacts.join(', ')}.`
    );
  }

  return {
    executiveSummary: summaryParts.join(' '),
    unsupportedRequirements,
    retrievalLimitations,
    evaluationLimitations,
    knownAgentWeaknesses,
    unimplementedFeatures,
    recommendedNextImprovements,
  };
}

export function validateReportVersion(report: ProjectReportVersion): ReportValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!report.projectOverview.projectName) {
    errors.push('Project overview is missing a project name.');
  }

  const checkScorecardConsistency = (label: string, sc: ReportScorecard) => {
    const nums = [
      sc.overallScore,
      sc.groundingScore,
      sc.correctnessScore,
      sc.refusalQualityScore,
      sc.passRatePercent,
    ];
    for (const v of nums) {
      if (v !== null && (!Number.isFinite(v) || v < 0 || v > 100)) {
        errors.push(`${label} contains an out-of-range score (${v}).`);
      }
    }

    // Honest reporting check: never display 100% overall score if failed/error/skipped tests exist or 0 evaluated
    if (sc.overallScore === 100) {
      if (
        (sc.failedTests ?? 0) > 0 ||
        (sc.errorTests ?? 0) > 0 ||
        (sc.skippedTests ?? 0) > 0 ||
        (sc.evaluatedTests ?? 0) === 0
      ) {
        errors.push(
          `${label} reports 100% despite failed/error/skipped/zero evaluated tests.`
        );
      }
    }
  };

  checkScorecardConsistency('Baseline scorecard', report.baselineEvaluation.scorecard);
  checkScorecardConsistency('Final scorecard', report.finalResults.finalScorecard);

  if (report.completenessStatus !== 'complete') {
    warnings.push(
      `Project report is "${report.completenessStatus}" because some artifacts are unavailable: ${report.missingArtifacts.join(', ')}.`
    );
  }

  if (report.baselineEvaluation.isIncompleteEvaluation) {
    warnings.push(
      `Baseline evaluation is incomplete: ${report.baselineEvaluation.incompleteReason || 'partial results'}`
    );
  }
  if (report.finalResults.isIncompleteEvaluation) {
    warnings.push(
      `Final evaluation is incomplete: ${report.finalResults.incompleteReason || 'partial results'}`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}

export function buildDeterministicReportData(
  project: AgentProject,
  reportVersionNumber: number
): ProjectReportVersion {
  const now = new Date().toISOString();
  const missingArtifacts: string[] = [];

  if (project.documents.length === 0) missingArtifacts.push('Uploaded Documents');
  if (!project.intakeInterview) missingArtifacts.push('Intake Clarification Interview');
  if (!project.requirements) {
    missingArtifacts.push('Requirements Specification');
  } else if (!project.requirements.approved) {
    missingArtifacts.push('Requirements Approval');
  }
  const agentVersions: AgentVersionRecord[] = project.agentConfig?.versions ?? [];
  if (agentVersions.length === 0) missingArtifacts.push('Generated Agent Definition');

  const savedDataset =
    project.evaluation?.versions.find(
      (v) => v.version === project.evaluation?.savedVersion
    ) ??
    project.evaluation?.versions[project.evaluation.versions.length - 1] ??
    null;
  if (!savedDataset) missingArtifacts.push('Evaluation Dataset');

  const runs = project.evaluationRuns ?? [];
  if (runs.length === 0) missingArtifacts.push('Evaluation Run Results');

  const optRuns = project.optimization?.runs ?? [];
  const latestOptRun = optRuns.length > 0 ? optRuns[optRuns.length - 1] : null;
  if (!latestOptRun) missingArtifacts.push('Optimization History');

  const { baselineRun, finalRun } = selectBaselineAndFinalRuns(project, latestOptRun);

  // Determine overall completeness status honestly
  let completenessStatus: ReportCompletenessStatus = 'early_draft';
  const hasCoreEval = Boolean(
    project.requirements?.approved &&
      agentVersions.length > 0 &&
      savedDataset &&
      runs.length > 0
  );
  if (hasCoreEval && !isRunIncomplete(finalRun!).incomplete && missingArtifacts.length === 0) {
    completenessStatus = 'complete';
  } else if (project.requirements || agentVersions.length > 0 || runs.length > 0) {
    completenessStatus = 'partial';
  }

  // Section A: Project Overview
  const totalDocumentBytes = project.documents.reduce((acc, d) => acc + d.sizeBytes, 0);
  const originalAgent = agentVersions[0] ?? null;
  const finalAgent =
    (project.agentConfig?.savedVersion !== null &&
    project.agentConfig?.savedVersion !== undefined
      ? agentVersions.find((v) => v.version === project.agentConfig!.savedVersion)
      : undefined) ??
    agentVersions[agentVersions.length - 1] ??
    null;

  const resolvedAgentName =
    finalAgent?.definition.agentName ||
    project.requirements?.agentName ||
    'Not Available';

  const projectOverview: ProjectReportVersion['projectOverview'] = {
    projectId: project.id,
    projectName: project.name,
    domain: project.domain || 'General',
    agentName: resolvedAgentName,
    agentPurpose: project.requirements?.agentPurpose || project.brief || 'Not Available',
    targetAudience:
      project.requirements?.targetAudience || project.targetAudience || 'Not Available',
    responseTone:
      project.requirements?.responseToneAndStyle || project.responseTone || 'Not Available',
    pipelineStage: project.stage,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    uploadedDocumentsCount: project.documents.length,
    totalDocumentBytes,
    uploadedDocuments: project.documents.map((d) => ({
      id: d.id,
      name: d.originalName,
      fileType: d.fileType,
      sizeBytes: d.sizeBytes,
      parseStatus: d.parseStatus,
      charCount: d.charCount,
      lineCount: d.lineCount,
      pageCount: d.pageCount,
      csvRowCount: d.csvRowCount,
      uploadedAt: d.uploadedAt,
    })),
  };

  // Section B: Requirements Analysis
  const reqs = project.requirements;
  const groundabilityChecks = reqs?.groundability?.checks ?? [];
  const requirementsAnalysis: ProjectReportVersion['requirementsAnalysis'] = {
    availability: !reqs
      ? 'not_available'
      : reqs.approved && project.intakeInterview
        ? 'available'
        : 'partial',
    originalBrief: project.brief || 'Not Available',
    clarificationInterview: project.intakeInterview
      ? {
          status: project.intakeInterview.status,
          analysisSummary: project.intakeInterview.analysisSummary,
          questionsAndAnswers: project.intakeInterview.questions.map((q) => {
            const ans = project.intakeInterview!.answers.find(
              (a) => a.questionId === q.id
            );
            return {
              questionId: q.id,
              question: q.question,
              answer: ans
                ? ans.skipped
                  ? 'Skipped by user'
                  : ans.answer || 'Not answered'
                : 'Not answered',
              skipped: Boolean(ans?.skipped),
            };
          }),
        }
      : null,
    approvedRequirements: reqs
      ? {
          approved: reqs.approved,
          approvedAt: reqs.approvedAt,
          scope: reqs.scope,
          mustAnswerTopics: reqs.mustAnswerTopics,
          mustRefuseTopics: reqs.mustRefuseTopics,
          outOfScopeTopics: reqs.outOfScopeTopics,
          responseToneAndStyle: reqs.responseToneAndStyle,
          knowledgeSourcesAvailable: reqs.knowledgeSourcesAvailable,
        }
      : null,
    groundability: reqs?.groundability
      ? {
          overallStatus: reqs.groundability.overallStatus,
          summary: reqs.groundability.summary,
          supportedRequirements: groundabilityChecks.filter(
            (c) => c.status === 'Supported'
          ),
          partiallySupportedRequirements: groundabilityChecks.filter(
            (c) => c.status === 'Partially Supported'
          ),
          unsupportedRequirements: groundabilityChecks.filter(
            (c) => c.status === 'Unsupported'
          ),
        }
      : null,
    limitationsAndAssumptions: reqs?.missingInformationOrAssumptions ?? [],
  };

  // Section C: Generated Agent Definition
  const agentDefinitionSection: ProjectReportVersion['agentDefinitionSection'] = {
    availability: finalAgent ? 'available' : 'not_available',
    originalVersionNumber: originalAgent?.version ?? null,
    finalVersionNumber: finalAgent?.version ?? null,
    finalAgentName: finalAgent?.definition.agentName ?? 'Not Available',
    systemPrompt: finalAgent?.definition.systemPrompt ?? null,
    knowledgeConfig: finalAgent?.definition.knowledgeConfig ?? null,
    selectedTools: (finalAgent?.definition.tools ?? [])
      .filter((t) => t.selected)
      .map((t) => ({
        id: t.id,
        toolName: t.toolName,
        description: t.description,
        whenToUse: t.whenToUse,
        selectionReason: t.selectionReason,
        implementationStatus: t.implementationStatus,
      })),
    outputContract: finalAgent?.definition.outputContract ?? null,
    versionHistory: agentVersions.map((v) => ({
      version: v.version,
      source: v.source,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
      notes: v.notes,
      valid: v.validation.valid,
      errorCount: v.validation.errors.length,
      warningCount: v.validation.warnings.length,
    })),
  };

  // Section D: Evaluation Methodology
  const diffCounts = savedDataset?.validation.stats.byDifficulty ?? null;
  const catCounts = savedDataset?.validation.stats.byCategory ?? null;
  const evaluationMethodology: ProjectReportVersion['evaluationMethodology'] = {
    availability: savedDataset ? 'available' : 'not_available',
    datasetVersion: savedDataset?.version ?? null,
    datasetSource: savedDataset?.source ?? null,
    datasetValidationValid: savedDataset?.validation.valid ?? null,
    totalTestCases: savedDataset ? savedDataset.testCases.length : null,
    countsByCategory: {
      answerable: catCounts ? catCounts.answerable : null,
      out_of_scope: catCounts ? catCounts.out_of_scope : null,
      edge_case: catCounts ? catCounts.edge_case : null,
    },
    countsByDifficulty: {
      easy: diffCounts ? diffCounts.easy : null,
      medium: diffCounts ? diffCounts.medium : null,
      hard: diffCounts ? diffCounts.hard : null,
    },
    judgeRubric: {
      scale: '1–5 integer rubric converted deterministically to 0–100%',
      dimensions: [
        {
          name: 'Grounding',
          weightPercent: 40,
          criteria:
            'Every factual claim must be supported by retrieved document evidence without fabrication.',
        },
        {
          name: 'Correctness',
          weightPercent: 40,
          criteria:
            'Response satisfies expected behavior and covers required key facts accurately.',
        },
        {
          name: 'Refusal Quality',
          weightPercent: 20,
          criteria:
            'Unanswerable or out-of-scope requests are refused clearly without guessing, while answerable questions are not falsely refused.',
        },
      ],
      passCriteria:
        'Test passes when refusal compliance passes deterministic checks, grounding >= 3/5, and correctness >= 3/5 (or refusal >= 4/5 on refusal cases).',
    },
    scoringWeights: {
      grounding: baselineRun?.scorecard.weightsUsed.grounding ?? finalRun?.scorecard.weightsUsed.grounding ?? 0.4,
      correctness: baselineRun?.scorecard.weightsUsed.correctness ?? finalRun?.scorecard.weightsUsed.correctness ?? 0.4,
      refusal: baselineRun?.scorecard.weightsUsed.refusal ?? finalRun?.scorecard.weightsUsed.refusal ?? 0.2,
    },
    deterministicValidationChecks: [
      'Refusal detection and refusal match verification against expectedRefusal.',
      'Expected key facts keyword & phrase coverage verification.',
      'Source citation filename verification against retrieved document chunks.',
      'Strict separation of passed, failed, execution error, and skipped test counts.',
    ],
  };

  // Section E: Baseline Evaluation
  const baseInc = baselineRun
    ? isRunIncomplete(baselineRun)
    : { incomplete: false, reason: null };
  const baselineEvaluation: ProjectReportVersion['baselineEvaluation'] = baselineRun
    ? {
        availability: baseInc.incomplete ? 'incomplete' : 'available',
        runId: baselineRun.runId,
        agentVersion: baselineRun.agentVersion,
        datasetVersion: baselineRun.datasetVersion,
        runStatus: baselineRun.status,
        isIncompleteEvaluation: baseInc.incomplete,
        incompleteReason: baseInc.reason,
        startedAt: baselineRun.startedAt,
        completedAt: baselineRun.completedAt,
        scorecard: toReportScorecard(baselineRun),
        categoryBreakdown: extractCategoryBreakdown(baselineRun),
        importantFailures: extractFailureDetails(baselineRun),
      }
    : {
        availability: 'not_available',
        runId: null,
        agentVersion: null,
        datasetVersion: null,
        runStatus: null,
        isIncompleteEvaluation: false,
        incompleteReason: null,
        startedAt: null,
        completedAt: null,
        scorecard: emptyScorecard(),
        categoryBreakdown: [],
        importantFailures: [],
      };

  // Section F: Optimization History
  const failureCategorySummary: Record<FailureCategory, number> = {
    retrieval_miss: 0,
    prompt_defect: 0,
    hallucination: 0,
    wrong_refusal: 0,
    uncertain: 0,
  };
  const reportIterations: ReportIterationEntry[] = (latestOptRun?.iterations ?? []).map(
    (it) => {
      for (const cls of it.failureClassifications) {
        failureCategorySummary[cls.category] =
          (failureCategorySummary[cls.category] ?? 0) + 1;
      }
      const approvedCount = it.proposedChanges.filter(
        (c) => c.approvalStatus === 'approved'
      ).length;
      const rejectedCount = it.proposedChanges.filter(
        (c) => c.approvalStatus === 'rejected'
      ).length;
      let outcomeLabel: ReportIterationEntry['outcomeLabel'] = 'not_completed';
      if (it.scoreDelta.overall !== null) {
        if (it.scoreDelta.overall > 0) outcomeLabel = 'improved';
        else if (it.scoreDelta.overall < 0) outcomeLabel = 'regressed';
        else outcomeLabel = 'unchanged';
      }
      return {
        iterationNumber: it.iterationNumber,
        status: it.status,
        baseAgentVersion: it.baseAgentVersion,
        newAgentVersion: it.newAgentVersion,
        analyzedAt: it.analyzedAt,
        completedAt: it.completedAt,
        analysisSummary: it.analysisSummary,
        failuresAnalyzedCount: it.failuresAnalyzedCount,
        failureClassifications: it.failureClassifications,
        changesProposedCount: it.proposedChanges.length,
        changesApprovedCount: approvedCount,
        changesRejectedCount: rejectedCount,
        proposedChanges: it.proposedChanges,
        appliedChangesSummary: it.appliedChangesSummary,
        previousScorecard: it.previousScorecard,
        newScorecard: it.newScorecard,
        scoreDelta: it.scoreDelta,
        outcomeLabel,
        remainingFailureCount: it.remainingFailureCount,
        remainingFailedTestIds: it.remainingFailedTestIds,
        decisionReason: it.decisionReason,
      };
    }
  );

  const optimizationHistory: ProjectReportVersion['optimizationHistory'] = latestOptRun
    ? {
        availability: 'available',
        optimizationRunId: latestOptRun.optimizationRunId,
        status: latestOptRun.status,
        stoppingReason: latestOptRun.stoppingReason,
        stoppingReasonLabel: latestOptRun.stoppingReason
          ? STOPPING_REASON_LABELS[latestOptRun.stoppingReason]
          : latestOptRun.status === 'in_progress'
            ? 'In Progress'
            : 'Not Recorded',
        stoppingDetail:
          latestOptRun.stoppingDetail || 'Optimization stopping detail not recorded.',
        baselineAgentVersion: latestOptRun.baselineAgentVersion,
        baselineDatasetVersion: latestOptRun.baselineDatasetVersion,
        maxIterations: latestOptRun.maxIterations,
        iterationsCompleted: latestOptRun.iterations.filter(
          (i) => i.status === 'completed'
        ).length,
        failureCategorySummary,
        iterations: reportIterations,
      }
    : {
        availability: 'not_run',
        optimizationRunId: null,
        status: null,
        stoppingReason: null,
        stoppingReasonLabel: 'Optimization Not Run',
        stoppingDetail:
          'No Critic-Optimizer run has been executed for this project.',
        baselineAgentVersion: null,
        baselineDatasetVersion: null,
        maxIterations: 3,
        iterationsCompleted: 0,
        failureCategorySummary,
        iterations: [],
      };

  // Section G: Final Results
  const finalInc = finalRun
    ? isRunIncomplete(finalRun)
    : { incomplete: false, reason: null };
  const baseSc = baselineEvaluation.scorecard;
  const finalSc = finalRun ? toReportScorecard(finalRun) : emptyScorecard();

  const calcDelta = (a: number | null, b: number | null): number | null =>
    a !== null && b !== null ? round2(b - a) : null;

  const overallDelta =
    baselineRun && finalRun && baselineRun.runId !== finalRun.runId
      ? calcDelta(baseSc.overallScore, finalSc.overallScore)
      : baselineRun && finalRun && baselineRun.runId === finalRun.runId
        ? 0
        : null;

  const groundingDelta =
    baselineRun && finalRun && baselineRun.runId !== finalRun.runId
      ? calcDelta(baseSc.groundingScore, finalSc.groundingScore)
      : baselineRun && finalRun && baselineRun.runId === finalRun.runId
        ? 0
        : null;

  const correctnessDelta =
    baselineRun && finalRun && baselineRun.runId !== finalRun.runId
      ? calcDelta(baseSc.correctnessScore, finalSc.correctnessScore)
      : baselineRun && finalRun && baselineRun.runId === finalRun.runId
        ? 0
        : null;

  const refusalDelta =
    baselineRun && finalRun && baselineRun.runId !== finalRun.runId
      ? calcDelta(baseSc.refusalQualityScore, finalSc.refusalQualityScore)
      : baselineRun && finalRun && baselineRun.runId === finalRun.runId
        ? 0
        : null;

  const passedDelta =
    baselineRun && finalRun && baseSc.passedTests !== null && finalSc.passedTests !== null
      ? finalSc.passedTests - baseSc.passedTests
      : null;

  const failedDelta =
    baselineRun && finalRun && baseSc.failedTests !== null && finalSc.failedTests !== null
      ? finalSc.failedTests - baseSc.failedTests
      : null;

  let improved: boolean | null = null;
  let improvementSummary = 'Not Available — no evaluation runs recorded yet.';
  if (baselineRun && finalRun) {
    if (baselineRun.runId === finalRun.runId) {
      improved = false;
      improvementSummary =
        'Only a single evaluation run exists (baseline == final). No post-optimization rerun delta exists.';
    } else if (overallDelta === null) {
      improved = null;
      improvementSummary =
        'Comparison unavailable because either baseline or final overall score is null.';
    } else if (overallDelta > 0) {
      improved = true;
      improvementSummary = `Agent overall score improved by +${overallDelta.toFixed(2)} percentage points (${baseSc.overallScore?.toFixed(1)}% -> ${finalSc.overallScore?.toFixed(1)}%).`;
    } else if (overallDelta < 0) {
      improved = false;
      improvementSummary = `Agent overall score regressed by ${overallDelta.toFixed(2)} percentage points (${baseSc.overallScore?.toFixed(1)}% -> ${finalSc.overallScore?.toFixed(1)}%).`;
    } else {
      improved = false;
      improvementSummary = `Agent overall score remained unchanged at ${finalSc.overallScore?.toFixed(1)}%.`;
    }
  }

  const allTestResults: ReportTestResultEntry[] = finalRun
    ? finalRun.results.map((r) => ({
        testCaseId: r.testCaseId,
        category: r.category,
        difficulty: r.difficulty,
        question: r.question,
        expectedBehavior: r.expectedBehavior,
        expectedRefusal: r.expectedRefusal,
        expectedSourceDocument: r.expectedSourceDocument,
        status: r.status,
        actualAnswer: r.actualAnswer || '',
        sourcesRetrieved: Array.isArray(r.sourcesRetrieved) ? r.sourcesRetrieved : [],
        groundingScore: r.judge?.groundingScore ?? null,
        correctnessScore: r.judge?.correctnessScore ?? null,
        refusalScore: r.judge?.refusalScore ?? null,
        failureReason: r.failureReason || '',
        errorMessage: r.errorMessage,
      }))
    : [];

  const finalResults: ProjectReportVersion['finalResults'] = finalRun
    ? {
        availability: finalInc.incomplete ? 'incomplete' : 'available',
        finalAgentVersion: finalRun.agentVersion,
        finalEvaluationRunId: finalRun.runId,
        finalEvaluationStatus: finalRun.status,
        isIncompleteEvaluation: finalInc.incomplete,
        incompleteReason: finalInc.reason,
        finalScorecard: finalSc,
        baselineVsFinalComparison: {
          overallDelta,
          groundingDelta,
          correctnessDelta,
          refusalDelta,
          passedDelta,
          failedDelta,
          sameDatasetEnforced: baselineRun
            ? baselineRun.datasetVersion === finalRun.datasetVersion
            : null,
          baselineDatasetVersion: baselineRun?.datasetVersion ?? null,
          finalDatasetVersion: finalRun.datasetVersion,
        },
        totalIterationsCompleted: optimizationHistory.iterationsCompleted,
        improved,
        improvementSummary,
        remainingKnownFailures: extractFailureDetails(finalRun),
        allTestResults,
      }
    : {
        availability: 'not_available',
        finalAgentVersion: finalAgent?.version ?? null,
        finalEvaluationRunId: null,
        finalEvaluationStatus: null,
        isIncompleteEvaluation: false,
        incompleteReason: null,
        finalScorecard: emptyScorecard(),
        baselineVsFinalComparison: {
          overallDelta: null,
          groundingDelta: null,
          correctnessDelta: null,
          refusalDelta: null,
          passedDelta: null,
          failedDelta: null,
          sameDatasetEnforced: null,
          baselineDatasetVersion: null,
          finalDatasetVersion: null,
        },
        totalIterationsCompleted: 0,
        improved: null,
        improvementSummary,
        remainingKnownFailures: [],
        allTestResults: [],
      };

  // Section H: Limitations and Future Improvements (deterministic base)
  const limitationsAndFutureImprovements =
    buildDeterministicLimitationsAndImprovements(
      project,
      baselineRun,
      finalRun,
      latestOptRun,
      missingArtifacts
    );

  const reportDraft: ProjectReportVersion = {
    version: reportVersionNumber,
    reportId: `rep-${crypto.randomUUID().slice(0, 8)}`,
    generatedAt: now,
    completenessStatus,
    missingArtifacts,
    narrativeMode: 'deterministic_fallback',
    narrativeNote:
      'Narrative synthesized deterministically from verified project records.',
    validation: { valid: true, errors: [], warnings: [], checkedAt: now },
    projectOverview,
    requirementsAnalysis,
    agentDefinitionSection,
    evaluationMethodology,
    baselineEvaluation,
    optimizationHistory,
    finalResults,
    limitationsAndFutureImprovements,
  };

  reportDraft.validation = validateReportVersion(reportDraft);
  return reportDraft;
}

export async function generateProjectReport(
  project: AgentProject,
  options?: { skipGemini?: boolean }
): Promise<ProjectReportVersion> {
  const existingVersions = project.report?.versions ?? [];
  const nextVersion =
    existingVersions.reduce((max, r) => Math.max(max, r.version), 0) + 1;

  const report = buildDeterministicReportData(project, nextVersion);

  if (!options?.skipGemini && isGeminiConfigured()) {
    try {
      const telemetrySnapshot = {
        projectName: report.projectOverview.projectName,
        domain: report.projectOverview.domain,
        completenessStatus: report.completenessStatus,
        missingArtifacts: report.missingArtifacts,
        uploadedDocumentsCount: report.projectOverview.uploadedDocumentsCount,
        requirementsApproved: report.requirementsAnalysis.approvedRequirements?.approved ?? false,
        groundabilityStatus:
          report.requirementsAnalysis.groundability?.overallStatus ?? 'Not Available',
        unsupportedCount:
          report.requirementsAnalysis.groundability?.unsupportedRequirements.length ?? 0,
        partialCount:
          report.requirementsAnalysis.groundability?.partiallySupportedRequirements.length ??
          0,
        baselineScorecard: report.baselineEvaluation.scorecard,
        finalScorecard: report.finalResults.finalScorecard,
        comparison: report.finalResults.baselineVsFinalComparison,
        improved: report.finalResults.improved,
        optimizationStoppingReason: report.optimizationHistory.stoppingReasonLabel,
        optimizationStoppingDetail: report.optimizationHistory.stoppingDetail,
        iterationsCompleted: report.optimizationHistory.iterationsCompleted,
        failureCategorySummary: report.optimizationHistory.failureCategorySummary,
        remainingFailuresSample: report.finalResults.remainingKnownFailures
          .slice(0, 6)
          .map((f) => ({
            testCaseId: f.testCaseId,
            category: f.category,
            status: f.status,
            failureReason: f.failureReason,
          })),
        deterministicLimitations: report.limitationsAndFutureImprovements,
      };

      const prompt = REPORT_SYNTHESIS_PROMPT_TEMPLATE.replace(
        '{{telemetryJson}}',
        JSON.stringify(telemetrySnapshot, null, 2)
      );

      const schema = {
        type: Type.OBJECT,
        properties: {
          executiveSummary: { type: Type.STRING },
          knownAgentWeaknesses: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          retrievalLimitations: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          evaluationLimitations: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          recommendedNextImprovements: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: [
          'executiveSummary',
          'knownAgentWeaknesses',
          'retrievalLimitations',
          'evaluationLimitations',
          'recommendedNextImprovements',
        ],
      };

      const rawText = await generateStructuredJson(
        prompt,
        REPORT_SYNTHESIS_SYSTEM_INSTRUCTION,
        schema
      );
      const parsed = JSON.parse(rawText) as {
        executiveSummary?: string;
        knownAgentWeaknesses?: string[];
        retrievalLimitations?: string[];
        evaluationLimitations?: string[];
        recommendedNextImprovements?: string[];
      };

      if (parsed.executiveSummary && parsed.executiveSummary.trim().length > 10) {
        report.limitationsAndFutureImprovements.executiveSummary =
          parsed.executiveSummary.trim();
      }
      if (Array.isArray(parsed.knownAgentWeaknesses) && parsed.knownAgentWeaknesses.length > 0) {
        report.limitationsAndFutureImprovements.knownAgentWeaknesses =
          parsed.knownAgentWeaknesses.map((s) => String(s).trim()).filter(Boolean);
      }
      if (Array.isArray(parsed.retrievalLimitations) && parsed.retrievalLimitations.length > 0) {
        report.limitationsAndFutureImprovements.retrievalLimitations =
          parsed.retrievalLimitations.map((s) => String(s).trim()).filter(Boolean);
      }
      if (Array.isArray(parsed.evaluationLimitations) && parsed.evaluationLimitations.length > 0) {
        report.limitationsAndFutureImprovements.evaluationLimitations =
          parsed.evaluationLimitations.map((s) => String(s).trim()).filter(Boolean);
      }
      if (
        Array.isArray(parsed.recommendedNextImprovements) &&
        parsed.recommendedNextImprovements.length > 0
      ) {
        report.limitationsAndFutureImprovements.recommendedNextImprovements =
          parsed.recommendedNextImprovements
            .map((s) => String(s).trim())
            .filter(Boolean);
      }

      report.narrativeMode = 'gemini';
      report.narrativeNote =
        'Narrative sections generated by Gemini strictly from deterministic project metrics.';
    } catch (err) {
      // Honest reporting: do NOT crash report generation or pretend Gemini succeeded
      report.narrativeMode = 'deterministic_fallback';
      report.narrativeNote = `Gemini narrative synthesis unavailable (${summarizeGeminiError(err)}); deterministic honest summary used instead.`;
    }
  } else if (!isGeminiConfigured()) {
    report.narrativeMode = 'deterministic_fallback';
    report.narrativeNote =
      'GEMINI_API_KEY is not configured; deterministic honest summary used.';
  }

  report.validation = validateReportVersion(report);
  return report;
}

export function formatReportPlainTextSummary(report: ProjectReportVersion): string {
  const fmtPct = (v: number | null) =>
    v === null ? 'Not Available' : `${v.toFixed(1)}%`;
  const fmtDelta = (v: number | null) =>
    v === null ? 'Not Available' : `${v > 0 ? '+' : ''}${v.toFixed(2)} pts`;

  const base = report.baselineEvaluation.scorecard;
  const fin = report.finalResults.finalScorecard;
  const cmp = report.finalResults.baselineVsFinalComparison;

  return [
    `ForgeAI Honest Project Report (v${report.version})`,
    `Generated: ${report.generatedAt}`,
    `Project: ${report.projectOverview.projectName} (${report.projectOverview.domain})`,
    `Agent: ${report.projectOverview.agentName}`,
    `Completeness: ${report.completenessStatus.toUpperCase()}${
      report.missingArtifacts.length > 0
        ? ` — Missing: ${report.missingArtifacts.join(', ')}`
        : ''
    }`,
    '',
    `Executive Summary:`,
    report.limitationsAndFutureImprovements.executiveSummary,
    '',
    `Baseline Evaluation (Agent v${report.baselineEvaluation.agentVersion ?? 'N/A'}):`,
    `- Overall: ${fmtPct(base.overallScore)} | Grounding: ${fmtPct(base.groundingScore)} | Correctness: ${fmtPct(base.correctnessScore)} | Refusal: ${fmtPct(base.refusalQualityScore)}`,
    `- Tests: ${base.passedTests ?? 'N/A'} passed, ${base.failedTests ?? 'N/A'} failed, ${base.errorTests ?? 'N/A'} error, ${base.skippedTests ?? 'N/A'} skipped (total ${base.totalTests ?? 'N/A'})`,
    '',
    `Final Evaluation (Agent v${report.finalResults.finalAgentVersion ?? 'N/A'}):`,
    `- Overall: ${fmtPct(fin.overallScore)} (Delta: ${fmtDelta(cmp.overallDelta)}) | Grounding: ${fmtPct(fin.groundingScore)} | Correctness: ${fmtPct(fin.correctnessScore)} | Refusal: ${fmtPct(fin.refusalQualityScore)}`,
    `- Tests: ${fin.passedTests ?? 'N/A'} passed, ${fin.failedTests ?? 'N/A'} failed, ${fin.errorTests ?? 'N/A'} error, ${fin.skippedTests ?? 'N/A'} skipped (total ${fin.totalTests ?? 'N/A'})`,
    '',
    `Optimization: ${report.optimizationHistory.iterationsCompleted} / ${report.optimizationHistory.maxIterations} iteration(s) — ${report.optimizationHistory.stoppingReasonLabel}`,
    `Remaining Known Issues: ${report.finalResults.remainingKnownFailures.length}`,
  ].join('\n');
}

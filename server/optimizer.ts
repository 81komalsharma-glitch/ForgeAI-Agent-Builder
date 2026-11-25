import crypto from 'crypto';
import { Type } from '@google/genai';
import { validateAgentDefinition } from './agentBuilder.ts';
import { createEvaluationRunRecord } from './evaluationRunner.ts';
import { generateStructuredJson } from './gemini.ts';
import {
  CRITIC_OPTIMIZER_PROMPT_TEMPLATE,
  CRITIC_OPTIMIZER_SYSTEM_INSTRUCTION,
} from './prompts/optimizerPrompts.ts';
import type {
  AffectedAgentComponent,
  AgentBuilderState,
  AgentDefinition,
  AgentProject,
  AgentVersionRecord,
  EvaluationDatasetVersion,
  EvaluationRunRecord,
  EvaluationScorecard,
  EvaluationTestCaseResult,
  FailureCategory,
  FailureClassificationRecord,
  FixConfidence,
  OptimizationIterationRecord,
  OptimizationRunRecord,
  OptimizationTargetSection,
  ProposedOptimizationChange,
  ScorecardSnapshot,
} from './types.ts';

export const MAX_OPTIMIZATION_ITERATIONS = 3;

const ALLOWED_FIELD_PATHS = new Set([
  'knowledgeConfig.chunkSize',
  'knowledgeConfig.chunkOverlap',
  'knowledgeConfig.topK',
  'knowledgeConfig.similarityThreshold',
  'knowledgeConfig.sourceCitationRequirements',
  'systemPrompt.knowledgeDocumentInstructions',
  'systemPrompt.answeringRules',
  'systemPrompt.scopeAndResponsibilities',
  'systemPrompt.mustAnswerTopics',
  'systemPrompt.mustRefuseTopics',
  'systemPrompt.missingInformationHandling',
  'systemPrompt.groundingAndCitationRules',
  'systemPrompt.responseToneAndStyle',
  'outputContract.citationFormat',
  'outputContract.refusalFormat',
  'outputContract.errorHandlingRules',
]);

const ARRAY_FIELD_PATHS = new Set([
  'systemPrompt.answeringRules',
  'systemPrompt.scopeAndResponsibilities',
  'systemPrompt.mustAnswerTopics',
  'systemPrompt.mustRefuseTopics',
  'outputContract.errorHandlingRules',
]);

const NUMBER_FIELD_PATHS = new Set([
  'knowledgeConfig.chunkSize',
  'knowledgeConfig.chunkOverlap',
  'knowledgeConfig.topK',
  'knowledgeConfig.similarityThreshold',
]);

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function toScorecardSnapshot(scorecard: EvaluationScorecard): ScorecardSnapshot {
  return {
    overallScore: scorecard.overallScore,
    groundingScore: scorecard.groundingScore,
    correctnessScore: scorecard.correctnessScore,
    refusalQualityScore: scorecard.refusalQualityScore,
    refusalScoreStatus: scorecard.refusalScoreStatus,
    passedTests: scorecard.counts.passedTests,
    failedTests: scorecard.counts.failedTests,
    errorTests: scorecard.counts.errorTests,
    skippedTests: scorecard.counts.skippedTests,
    totalTests: scorecard.counts.totalTests,
  };
}

export function computeScoreDelta(
  previous: ScorecardSnapshot,
  next: ScorecardSnapshot
): {
  overall: number | null;
  grounding: number | null;
  correctness: number | null;
  refusalQuality: number | null;
} {
  const diff = (a: number | null, b: number | null): number | null =>
    a !== null && b !== null ? round2(b - a) : null;

  return {
    overall: diff(previous.overallScore, next.overallScore),
    grounding: diff(previous.groundingScore, next.groundingScore),
    correctness: diff(previous.correctnessScore, next.correctnessScore),
    refusalQuality: diff(previous.refusalQualityScore, next.refusalQualityScore),
  };
}

export function assertOptimizationPrerequisites(
  project: AgentProject,
  preferredEvalRunId?: string
): {
  savedAgent: AgentVersionRecord;
  savedDataset: EvaluationDatasetVersion;
  baselineEvalRun: EvaluationRunRecord;
} {
  if (!project.requirements?.approved) {
    throw new Error(
      'Approved requirements are required before running optimization.'
    );
  }

  const savedAgentVer = project.agentConfig?.savedVersion ?? null;
  if (savedAgentVer === null || !project.agentConfig) {
    throw new Error(
      'A valid saved agent definition is required before starting optimization.'
    );
  }
  const savedAgent = project.agentConfig.versions.find(
    (v) => v.version === savedAgentVer
  );
  if (!savedAgent || !savedAgent.validation.valid) {
    throw new Error(
      `Saved agent definition v${savedAgentVer} is missing or has validation errors.`
    );
  }

  const savedDatasetVer = project.evaluation?.savedVersion ?? null;
  if (savedDatasetVer === null || !project.evaluation) {
    throw new Error(
      'A saved evaluation dataset is required before starting optimization.'
    );
  }
  const savedDataset = project.evaluation.versions.find(
    (v) => v.version === savedDatasetVer
  );
  if (!savedDataset || !savedDataset.validation.valid || savedDataset.testCases.length < 20) {
    throw new Error(
      `Saved evaluation dataset v${savedDatasetVer} must be valid and contain at least 20 test cases.`
    );
  }

  const completedRuns = project.evaluationRuns.filter(
    (r) =>
      (r.status === 'completed' || r.status === 'completed_with_errors') &&
      r.scorecard.counts.evaluatedTests > 0 &&
      r.scorecard.overallScore !== null
  );

  if (completedRuns.length === 0) {
    throw new Error(
      'At least one completed evaluation run with valid scores and test results is required before optimization.'
    );
  }

  let baselineEvalRun: EvaluationRunRecord | undefined;
  if (preferredEvalRunId) {
    baselineEvalRun = completedRuns.find((r) => r.runId === preferredEvalRunId);
    if (!baselineEvalRun) {
      throw new Error(
        `Evaluation run "${preferredEvalRunId}" was not found or is not completed.`
      );
    }
  } else {
    baselineEvalRun = completedRuns[completedRuns.length - 1];
  }

  // Ensure the agent & dataset used by the chosen baseline evaluation run exist
  const runAgent = project.agentConfig.versions.find(
    (v) => v.version === baselineEvalRun!.agentVersion
  );
  const runDataset = project.evaluation.versions.find(
    (v) => v.version === baselineEvalRun!.datasetVersion
  );
  if (!runAgent || !runAgent.validation.valid) {
    throw new Error(
      `Agent definition v${baselineEvalRun.agentVersion} referenced by evaluation run ${baselineEvalRun.runId} is missing or invalid.`
    );
  }
  if (!runDataset || !runDataset.validation.valid || runDataset.testCases.length < 20) {
    throw new Error(
      `Evaluation dataset v${baselineEvalRun.datasetVersion} referenced by evaluation run ${baselineEvalRun.runId} is missing or has fewer than 20 test cases.`
    );
  }

  return {
    savedAgent: runAgent,
    savedDataset: runDataset,
    baselineEvalRun,
  };
}

export function createOptimizationRunRecord(
  project: AgentProject,
  preferredEvalRunId?: string
): OptimizationRunRecord {
  const { savedAgent, savedDataset, baselineEvalRun } =
    assertOptimizationPrerequisites(project, preferredEvalRunId);

  const now = new Date().toISOString();
  const baselineSnapshot = toScorecardSnapshot(baselineEvalRun.scorecard);

  return {
    optimizationRunId: `opt-${crypto.randomUUID().slice(0, 8)}`,
    projectId: project.id,
    baselineAgentVersion: savedAgent.version,
    baselineDatasetVersion: savedDataset.version,
    baselineEvaluationRunId: baselineEvalRun.runId,
    baselineScorecard: baselineSnapshot,
    currentAgentVersion: savedAgent.version,
    currentEvaluationRunId: baselineEvalRun.runId,
    currentScorecard: baselineSnapshot,
    maxIterations: MAX_OPTIMIZATION_ITERATIONS,
    status: 'in_progress',
    stoppingReason: null,
    stoppingDetail: '',
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    iterations: [],
  };
}

export function getFieldValueByPath(
  definition: AgentDefinition,
  fieldPath: string
): unknown {
  const [section, key] = fieldPath.split('.');
  if (!section || !key) return undefined;
  const sectionObj = definition[section as keyof AgentDefinition];
  if (!sectionObj || typeof sectionObj !== 'object') return undefined;
  return (sectionObj as unknown as Record<string, unknown>)[key];
}

function setFieldValueByPath(
  definition: AgentDefinition,
  fieldPath: string,
  value: unknown
): void {
  const [section, key] = fieldPath.split('.');
  if (!section || !key) return;
  const sectionObj = definition[section as keyof AgentDefinition];
  if (!sectionObj || typeof sectionObj !== 'object') return;
  (sectionObj as unknown as Record<string, unknown>)[key] = value;
}

function coercePatchValue(
  fieldPath: string,
  rawJsonOrValue: unknown,
  currentDefinition: AgentDefinition
): { ok: true; value: unknown } | { ok: false } {
  let parsed: unknown = rawJsonOrValue;
  if (typeof rawJsonOrValue === 'string') {
    const trimmed = rawJsonOrValue.trim();
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      if (ARRAY_FIELD_PATHS.has(fieldPath)) {
        parsed = trimmed
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (NUMBER_FIELD_PATHS.has(fieldPath)) {
        parsed = Number(trimmed);
      } else {
        parsed = trimmed;
      }
    }
  }

  if (fieldPath === 'knowledgeConfig.chunkSize') {
    const n = Math.round(Number(parsed));
    if (!Number.isFinite(n)) return { ok: false };
    return { ok: true, value: Math.min(4000, Math.max(100, n)) };
  }
  if (fieldPath === 'knowledgeConfig.chunkOverlap') {
    const n = Math.round(Number(parsed));
    if (!Number.isFinite(n)) return { ok: false };
    const maxAllowed = Math.max(0, currentDefinition.knowledgeConfig.chunkSize - 1);
    return { ok: true, value: Math.min(maxAllowed, Math.max(0, n)) };
  }
  if (fieldPath === 'knowledgeConfig.topK') {
    const n = Math.round(Number(parsed));
    if (!Number.isFinite(n)) return { ok: false };
    return { ok: true, value: Math.min(20, Math.max(1, n)) };
  }
  if (fieldPath === 'knowledgeConfig.similarityThreshold') {
    const n = Number(parsed);
    if (!Number.isFinite(n)) return { ok: false };
    return { ok: true, value: round2(Math.min(1, Math.max(0, n))) };
  }

  if (ARRAY_FIELD_PATHS.has(fieldPath)) {
    if (!Array.isArray(parsed)) return { ok: false };
    const cleaned = parsed
      .map((item) => String(item).trim())
      .filter((item) => item.length > 0);
    if (cleaned.length === 0) return { ok: false };
    return { ok: true, value: cleaned };
  }

  if (typeof parsed !== 'string') {
    return { ok: false };
  }
  const str = parsed.trim();
  if (str.length < 3) return { ok: false };
  return { ok: true, value: str };
}

export function buildFailureDiagnosticSignal(
  result: EvaluationTestCaseResult,
  projectDocNames: string[]
): Record<string, unknown> {
  const expectedDocExists = Boolean(
    result.expectedSourceDocument &&
      projectDocNames.some(
        (d) => d.toLowerCase() === result.expectedSourceDocument!.toLowerCase()
      )
  );
  const expectedDocRetrieved = Boolean(
    result.expectedSourceDocument &&
      result.retrievedEvidence.some(
        (c) =>
          c.documentName.toLowerCase() ===
          result.expectedSourceDocument!.toLowerCase()
      )
  );

  return {
    testCaseId: result.testCaseId,
    category: result.category,
    difficulty: result.difficulty,
    question: result.question,
    expectedRefusal: result.expectedRefusal,
    expectedBehavior: result.expectedBehavior,
    expectedKeyFacts: result.expectedKeyFacts,
    expectedSourceDocument: result.expectedSourceDocument,
    expectedDocExistsInProject: expectedDocExists,
    expectedDocWasRetrieved: expectedDocRetrieved,
    retrievedEvidenceCount: result.retrievedEvidence.length,
    retrievedEvidenceSnippets: result.retrievedEvidence.map((c) => ({
      documentName: c.documentName,
      score: c.score,
      snippet: c.snippet.slice(0, 350),
    })),
    toolsUsed: result.toolsUsed,
    actualAnswer: result.actualAnswer.slice(0, 1200),
    deterministicChecks: result.deterministicChecks,
    judgeScores: result.judge
      ? {
          groundingScore: result.judge.groundingScore,
          groundingExplanation: result.judge.groundingExplanation,
          correctnessScore: result.judge.correctnessScore,
          correctnessExplanation: result.judge.correctnessExplanation,
          refusalScore: result.judge.refusalScore,
          refusalApplicable: result.judge.refusalApplicable,
          refusalExplanation: result.judge.refusalExplanation,
          failureReasons: result.judge.failureReasons,
          deterministicOverridesApplied: result.judge.deterministicOverridesApplied,
        }
      : null,
    failureReason: result.failureReason,
  };
}

function normalizeFailureCategory(value: unknown): FailureCategory {
  if (
    value === 'retrieval_miss' ||
    value === 'prompt_defect' ||
    value === 'hallucination' ||
    value === 'wrong_refusal' ||
    value === 'uncertain'
  ) {
    return value;
  }
  return 'uncertain';
}

function normalizeAffectedComponent(value: unknown): AffectedAgentComponent {
  if (
    value === 'knowledgeConfig' ||
    value === 'systemPrompt' ||
    value === 'outputContract' ||
    value === 'tools' ||
    value === 'unknown'
  ) {
    return value;
  }
  return 'unknown';
}

function normalizeConfidence(value: unknown): FixConfidence {
  if (value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  return 'low';
}

export function sanitizeProposedChanges(
  rawChanges: Array<{
    targetSection?: string;
    fieldPath?: string;
    failureCategoriesAddressed?: string[];
    affectedTestIds?: string[];
    proposedValueJson?: string;
    proposedValue?: unknown;
    reason?: string;
  }>,
  currentDefinition: AgentDefinition,
  validFailedTestIds: Set<string>
): ProposedOptimizationChange[] {
  const seenFields = new Set<string>();
  const sanitized: ProposedOptimizationChange[] = [];

  for (const item of rawChanges) {
    const fieldPath = String(item.fieldPath || '').trim();
    if (!ALLOWED_FIELD_PATHS.has(fieldPath) || seenFields.has(fieldPath)) {
      continue;
    }

    const section = fieldPath.split('.')[0] as OptimizationTargetSection;
    const previousValue = getFieldValueByPath(currentDefinition, fieldPath);
    const rawCandidate =
      item.proposedValueJson !== undefined
        ? item.proposedValueJson
        : item.proposedValue;

    const coerced = coercePatchValue(fieldPath, rawCandidate, currentDefinition);
    if (!coerced.ok) continue;

    // Skip no-op changes
    if (JSON.stringify(previousValue) === JSON.stringify(coerced.value)) {
      continue;
    }

    const reason = String(item.reason || '').trim();
    if (!reason) continue;

    const affectedTestIds = Array.isArray(item.affectedTestIds)
      ? Array.from(
          new Set(
            item.affectedTestIds
              .map((id) => String(id).trim())
              .filter((id) => validFailedTestIds.has(id))
          )
        )
      : [];

    const categories = Array.isArray(item.failureCategoriesAddressed)
      ? Array.from(
          new Set(item.failureCategoriesAddressed.map(normalizeFailureCategory))
        )
      : ['uncertain' as FailureCategory];

    seenFields.add(fieldPath);
    sanitized.push({
      changeId: `chg-${crypto.randomUUID().slice(0, 6)}`,
      targetSection: section,
      fieldPath,
      failureCategoriesAddressed: categories,
      affectedTestIds,
      previousValue: structuredClone(previousValue),
      proposedValue: coerced.value,
      reason,
      approvalStatus: 'pending',
    });
  }

  return sanitized;
}

export function applySurgicalPatches(
  project: AgentProject,
  baseDefinition: AgentDefinition,
  approvedChanges: ProposedOptimizationChange[]
): {
  newDefinition: AgentDefinition;
  appliedSummary: string[];
  validation: ReturnType<typeof validateAgentDefinition>;
} {
  if (approvedChanges.length === 0) {
    throw new Error('At least one approved change is required to build a new agent version.');
  }

  const cloned = structuredClone(baseDefinition);

  // Apply knowledgeConfig.chunkSize before chunkOverlap if both are present so overlap check stays valid
  const orderedChanges = [...approvedChanges].sort((a, b) => {
    if (a.fieldPath === 'knowledgeConfig.chunkSize') return -1;
    if (b.fieldPath === 'knowledgeConfig.chunkSize') return 1;
    return 0;
  });

  const appliedSummary: string[] = [];
  for (const chg of orderedChanges) {
    if (!ALLOWED_FIELD_PATHS.has(chg.fieldPath)) {
      throw new Error(`Field "${chg.fieldPath}" is not permitted for surgical optimization.`);
    }
    setFieldValueByPath(cloned, chg.fieldPath, structuredClone(chg.proposedValue));
    appliedSummary.push(`${chg.fieldPath}: ${chg.reason}`);
  }

  // Clamp chunkOverlap strictly below chunkSize if chunkSize was shrunk below existing overlap
  if (cloned.knowledgeConfig.chunkOverlap >= cloned.knowledgeConfig.chunkSize) {
    cloned.knowledgeConfig.chunkOverlap = Math.max(
      0,
      Math.floor(cloned.knowledgeConfig.chunkSize * 0.2)
    );
  }

  const validation = validateAgentDefinition(project, cloned);
  return {
    newDefinition: cloned,
    appliedSummary,
    validation,
  };
}

export async function analyzeFailuresAndProposeFixes(
  project: AgentProject,
  optRun: OptimizationRunRecord
): Promise<OptimizationRunRecord> {
  if (optRun.status !== 'in_progress') {
    throw new Error(
      `Optimization run ${optRun.optimizationRunId} is already ${optRun.status} (${optRun.stoppingReason || 'closed'}).`
    );
  }

  if (optRun.iterations.length >= MAX_OPTIMIZATION_ITERATIONS) {
    const now = new Date().toISOString();
    return {
      ...optRun,
      status: 'completed',
      stoppingReason: 'max_iterations_reached',
      stoppingDetail: `Maximum of ${MAX_OPTIMIZATION_ITERATIONS} optimization iterations strictly reached.`,
      updatedAt: now,
      completedAt: now,
    };
  }

  // Prevent starting a new analysis if an existing iteration is awaiting approval / rerunning
  const activeIter = optRun.iterations.find(
    (it) => it.status !== 'completed' && it.status !== 'stopped'
  );
  if (activeIter) {
    throw new Error(
      `Iteration ${activeIter.iterationNumber} is currently "${activeIter.status}". Complete or stop it before analyzing the next iteration.`
    );
  }

  const sourceEvalRun = project.evaluationRuns.find(
    (r) => r.runId === optRun.currentEvaluationRunId
  );
  if (!sourceEvalRun) {
    throw new Error(
      `Source evaluation run "${optRun.currentEvaluationRunId}" could not be found.`
    );
  }

  if (
    sourceEvalRun.status !== 'completed' &&
    sourceEvalRun.status !== 'completed_with_errors'
  ) {
    throw new Error(
      `Evaluation run "${sourceEvalRun.runId}" is "${sourceEvalRun.status}" and must finish before failure analysis.`
    );
  }

  const baseAgentRecord = project.agentConfig?.versions.find(
    (v) => v.version === optRun.currentAgentVersion
  );
  if (!baseAgentRecord) {
    throw new Error(
      `Agent definition v${optRun.currentAgentVersion} could not be found.`
    );
  }

  const failedResults = sourceEvalRun.results.filter((r) => r.status === 'failed');
  const now = new Date().toISOString();
  const prevScorecard = toScorecardSnapshot(sourceEvalRun.scorecard);

  // Stop immediately if 0 failed tests remain
  if (failedResults.length === 0) {
    return {
      ...optRun,
      currentScorecard: prevScorecard,
      status: 'completed',
      stoppingReason: 'all_tests_passed',
      stoppingDetail:
        sourceEvalRun.scorecard.counts.errorTests > 0
          ? `All ${sourceEvalRun.scorecard.counts.evaluatedTests} judged test cases passed (${sourceEvalRun.scorecard.counts.errorTests} execution error(s) excluded). No failing tests remain to optimize.`
          : 'All evaluation test cases passed. No optimization needed.',
      updatedAt: now,
      completedAt: now,
    };
  }

  const iterationNumber = optRun.iterations.length + 1;
  const projectDocNames = project.documents.map((d) => d.originalName);
  const diagnosticSignals = failedResults.map((r) =>
    buildFailureDiagnosticSignal(r, projectDocNames)
  );

  const reqs = project.requirements;
  const requirementsSummary = reqs
    ? [
        `Agent: ${reqs.agentName}`,
        `Purpose: ${reqs.agentPurpose}`,
        `Scope: ${reqs.scope.join('; ')}`,
        `Must Answer: ${reqs.mustAnswerTopics.join('; ')}`,
        `Must Refuse: ${reqs.mustRefuseTopics.join('; ')}`,
        `Out of Scope: ${reqs.outOfScopeTopics.join('; ')}`,
      ].join('\n')
    : 'Not available';

  // Omit large tool schemas from prompt to keep Critic focused strictly on patchable config
  const compactAgentConfig = {
    agentName: baseAgentRecord.definition.agentName,
    systemPrompt: baseAgentRecord.definition.systemPrompt,
    knowledgeConfig: baseAgentRecord.definition.knowledgeConfig,
    outputContract: baseAgentRecord.definition.outputContract,
    enabledTools: baseAgentRecord.definition.tools
      .filter((t) => t.selected)
      .map((t) => ({ id: t.id, toolName: t.toolName })),
  };

  const prompt = CRITIC_OPTIMIZER_PROMPT_TEMPLATE
    .replace('{{iterationNumber}}', String(iterationNumber))
    .replace('{{requirementsSummary}}', requirementsSummary)
    .replace('{{agentVersion}}', String(baseAgentRecord.version))
    .replace('{{currentAgentJson}}', JSON.stringify(compactAgentConfig, null, 2))
    .replace('{{failedTestsJson}}', JSON.stringify(diagnosticSignals, null, 2));

  const criticSchema = {
    type: Type.OBJECT,
    properties: {
      analysisSummary: { type: Type.STRING },
      classifications: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            testCaseId: { type: Type.STRING },
            category: { type: Type.STRING },
            rootCauseExplanation: { type: Type.STRING },
            supportingEvidence: { type: Type.STRING },
            affectedComponent: { type: Type.STRING },
            recommendedFix: { type: Type.STRING },
            confidence: { type: Type.STRING },
          },
          required: [
            'testCaseId',
            'category',
            'rootCauseExplanation',
            'supportingEvidence',
            'affectedComponent',
            'recommendedFix',
            'confidence',
          ],
        },
      },
      proposedChanges: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            fieldPath: { type: Type.STRING },
            failureCategoriesAddressed: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            affectedTestIds: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
            proposedValueJson: { type: Type.STRING },
            reason: { type: Type.STRING },
          },
          required: [
            'fieldPath',
            'failureCategoriesAddressed',
            'affectedTestIds',
            'proposedValueJson',
            'reason',
          ],
        },
      },
    },
    required: ['analysisSummary', 'classifications', 'proposedChanges'],
  };

  const rawJsonText = await generateStructuredJson(
    prompt,
    CRITIC_OPTIMIZER_SYSTEM_INSTRUCTION,
    criticSchema
  );

  const rawAnalysis = JSON.parse(rawJsonText) as {
    analysisSummary: string;
    classifications: Array<{
      testCaseId: string;
      category: string;
      rootCauseExplanation: string;
      supportingEvidence: string;
      affectedComponent: string;
      recommendedFix: string;
      confidence: string;
    }>;
    proposedChanges: Array<{
      fieldPath: string;
      failureCategoriesAddressed: string[];
      affectedTestIds: string[];
      proposedValueJson: string;
      reason: string;
    }>;
  };

  const failedById = new Map(failedResults.map((r) => [r.testCaseId, r]));
  const rawById = new Map(
    (rawAnalysis.classifications || []).map((c) => [c.testCaseId, c])
  );

  // Guarantee every failed test has a classification record (fallback to Uncertain if omitted)
  const classifications: FailureClassificationRecord[] = failedResults.map((res) => {
    const found = rawById.get(res.testCaseId);
    if (!found) {
      return {
        testCaseId: res.testCaseId,
        question: res.question,
        category: 'uncertain',
        rootCauseExplanation:
          'Insufficient diagnostic certainty from the Critic response to classify this failure.',
        supportingEvidence: res.failureReason || 'Judge failed test.',
        affectedComponent: 'unknown',
        recommendedFix: 'Inspect retrieved chunks and judge explanation manually.',
        confidence: 'low',
      };
    }

    // Never invent high confidence if judge reasoning was absent
    const confidence =
      res.judge === null ? 'low' : normalizeConfidence(found.confidence);

    return {
      testCaseId: res.testCaseId,
      question: res.question,
      category: normalizeFailureCategory(found.category),
      rootCauseExplanation:
        String(found.rootCauseExplanation || '').trim() ||
        res.failureReason ||
        'Marked uncertain due to insufficient root-cause detail.',
      supportingEvidence:
        String(found.supportingEvidence || '').trim() ||
        res.judge?.supportingEvidence ||
        'See test result evidence.',
      affectedComponent: normalizeAffectedComponent(found.affectedComponent),
      recommendedFix:
        String(found.recommendedFix || '').trim() ||
        'Review agent instructions and retrieval thresholds.',
      confidence,
    };
  });

  const validFailedIds = new Set(failedById.keys());
  const proposedChanges = sanitizeProposedChanges(
    rawAnalysis.proposedChanges || [],
    baseAgentRecord.definition,
    validFailedIds
  );

  if (proposedChanges.length === 0) {
    const stoppedIter: OptimizationIterationRecord = {
      iterationNumber,
      status: 'stopped',
      sourceEvaluationRunId: sourceEvalRun.runId,
      baseAgentVersion: baseAgentRecord.version,
      newAgentVersion: null,
      rerunEvaluationRunId: null,
      analyzedAt: now,
      appliedAt: null,
      completedAt: now,
      analysisSummary:
        String(rawAnalysis.analysisSummary || '').trim() ||
        'Analyzed failed tests, but no safe, meaningful targeted configuration changes were identified.',
      failuresAnalyzedCount: failedResults.length,
      failureClassifications: classifications,
      proposedChanges: [],
      appliedChangesSummary: [],
      previousScorecard: prevScorecard,
      newScorecard: null,
      scoreDelta: { overall: null, grounding: null, correctness: null, refusalQuality: null },
      remainingFailureCount: failedResults.length,
      remainingFailedTestIds: failedResults.map((r) => r.testCaseId),
      decisionReason:
        'Stopped: Critic found no meaningful targeted fix that would safely improve the agent without violating approved requirements.',
    };

    return {
      ...optRun,
      status: 'completed',
      stoppingReason: 'no_meaningful_fix_identified',
      stoppingDetail: stoppedIter.decisionReason,
      updatedAt: now,
      completedAt: now,
      iterations: [...optRun.iterations, stoppedIter],
    };
  }

  const newIter: OptimizationIterationRecord = {
    iterationNumber,
    status: 'awaiting_approval',
    sourceEvaluationRunId: sourceEvalRun.runId,
    baseAgentVersion: baseAgentRecord.version,
    newAgentVersion: null,
    rerunEvaluationRunId: null,
    analyzedAt: now,
    appliedAt: null,
    completedAt: null,
    analysisSummary:
      String(rawAnalysis.analysisSummary || '').trim() ||
      `Classified ${failedResults.length} failure(s) and proposed ${proposedChanges.length} targeted fix(es).`,
    failuresAnalyzedCount: failedResults.length,
    failureClassifications: classifications,
    proposedChanges,
    appliedChangesSummary: [],
    previousScorecard: prevScorecard,
    newScorecard: null,
    scoreDelta: { overall: null, grounding: null, correctness: null, refusalQuality: null },
    remainingFailureCount: null,
    remainingFailedTestIds: [],
    decisionReason: 'Awaiting user inspection and approval of proposed fixes.',
  };

  return {
    ...optRun,
    updatedAt: now,
    iterations: [...optRun.iterations, newIter],
  };
}

export function updateIterationChangeDecisions(
  optRun: OptimizationRunRecord,
  iterationNumber: number,
  decisions: Array<{ changeId: string; status: 'approved' | 'rejected' }>
): OptimizationRunRecord {
  const iterIdx = optRun.iterations.findIndex(
    (it) => it.iterationNumber === iterationNumber
  );
  if (iterIdx < 0) {
    throw new Error(`Optimization iteration ${iterationNumber} not found.`);
  }
  const iter = optRun.iterations[iterIdx];
  if (iter.status !== 'awaiting_approval') {
    throw new Error(
      `Iteration ${iterationNumber} is "${iter.status}" and can no longer be edited.`
    );
  }

  const decisionMap = new Map(decisions.map((d) => [d.changeId, d.status]));
  const now = new Date().toISOString();

  const updatedChanges = iter.proposedChanges.map((chg) => {
    const nextStatus = decisionMap.get(chg.changeId);
    if (!nextStatus) return chg;
    return {
      ...chg,
      approvalStatus: nextStatus,
      decidedAt: now,
    };
  });

  const allDecided = updatedChanges.every((c) => c.approvalStatus !== 'pending');
  const approvedCount = updatedChanges.filter(
    (c) => c.approvalStatus === 'approved'
  ).length;

  // If the user explicitly rejected ALL proposed changes, close this optimization run cleanly
  if (allDecided && approvedCount === 0) {
    const updatedIter: OptimizationIterationRecord = {
      ...iter,
      status: 'stopped',
      proposedChanges: updatedChanges,
      completedAt: now,
      decisionReason:
        'All proposed changes in this iteration were rejected by the user. Original agent configuration preserved.',
    };
    const nextIters = [...optRun.iterations];
    nextIters[iterIdx] = updatedIter;

    return {
      ...optRun,
      status: 'stopped',
      stoppingReason: 'all_changes_rejected',
      stoppingDetail: updatedIter.decisionReason,
      updatedAt: now,
      completedAt: now,
      iterations: nextIters,
    };
  }

  const updatedIter: OptimizationIterationRecord = {
    ...iter,
    proposedChanges: updatedChanges,
    decisionReason:
      approvedCount > 0
        ? `${approvedCount} of ${updatedChanges.length} proposed fix(es) approved. Ready to apply and rerun evaluation.`
        : 'Awaiting user inspection and approval of proposed fixes.',
  };

  const nextIters = [...optRun.iterations];
  nextIters[iterIdx] = updatedIter;

  return {
    ...optRun,
    updatedAt: now,
    iterations: nextIters,
  };
}

export function applyApprovedChangesAndPrepareRerun(
  project: AgentProject,
  optRun: OptimizationRunRecord,
  iterationNumber: number
): {
  updatedOptRun: OptimizationRunRecord;
  updatedAgentConfig: AgentBuilderState;
  newEvalRun: EvaluationRunRecord;
} {
  if (optRun.status !== 'in_progress') {
    throw new Error(`Optimization run ${optRun.optimizationRunId} is ${optRun.status}.`);
  }
  if (iterationNumber > MAX_OPTIMIZATION_ITERATIONS) {
    throw new Error(
      `Maximum of ${MAX_OPTIMIZATION_ITERATIONS} optimization iterations strictly enforced.`
    );
  }

  const iterIdx = optRun.iterations.findIndex(
    (it) => it.iterationNumber === iterationNumber
  );
  if (iterIdx < 0) {
    throw new Error(`Optimization iteration ${iterationNumber} not found.`);
  }
  const iter = optRun.iterations[iterIdx];
  if (iter.status !== 'awaiting_approval') {
    throw new Error(
      `Iteration ${iterationNumber} must be in "awaiting_approval" status before applying changes (current: "${iter.status}").`
    );
  }

  const approvedChanges = iter.proposedChanges.filter(
    (c) => c.approvalStatus === 'approved'
  );
  if (approvedChanges.length === 0) {
    throw new Error(
      'Approve at least one proposed fix before creating an optimized agent version and rerunning evaluation.'
    );
  }

  if (!project.agentConfig) {
    throw new Error('Agent configuration is missing.');
  }
  const baseAgentRecord = project.agentConfig.versions.find(
    (v) => v.version === iter.baseAgentVersion
  );
  if (!baseAgentRecord) {
    throw new Error(`Base agent version v${iter.baseAgentVersion} not found.`);
  }

  // Enforce the exact same unchanged evaluation dataset from the optimization baseline
  const lockedDataset = project.evaluation?.versions.find(
    (v) => v.version === optRun.baselineDatasetVersion
  );
  if (!lockedDataset || !lockedDataset.validation.valid || lockedDataset.testCases.length < 20) {
    throw new Error(
      `Locked baseline evaluation dataset v${optRun.baselineDatasetVersion} is missing or invalid.`
    );
  }

  const { newDefinition, appliedSummary, validation } = applySurgicalPatches(
    project,
    baseAgentRecord.definition,
    approvedChanges
  );

  if (!validation.valid) {
    const msg = validation.errors.map((e) => e.message).join(' ');
    throw new Error(
      `Approved changes produced an invalid agent definition: ${msg}`
    );
  }

  const now = new Date().toISOString();
  const maxVersion = project.agentConfig.versions.reduce(
    (max, v) => Math.max(max, v.version),
    0
  );
  const newVersionNum = maxVersion + 1;

  const newAgentVersionRecord: AgentVersionRecord = {
    version: newVersionNum,
    createdAt: now,
    updatedAt: now,
    source: 'optimized',
    notes: `Critic-Optimizer Iteration ${iterationNumber} (${optRun.optimizationRunId}): ${appliedSummary.join(' | ')}`,
    definition: newDefinition,
    validation,
  };

  // Preserve ALL existing versions untouched (including original baseline)
  const updatedAgentConfig: AgentBuilderState = {
    currentVersion: newVersionNum,
    versions: [...project.agentConfig.versions, newAgentVersionRecord],
    savedVersion: newVersionNum,
    savedAt: now,
  };

  // Create new EvaluationRunRecord locked strictly to the baseline dataset version
  const newEvalRun = createEvaluationRunRecord(
    project,
    newAgentVersionRecord,
    lockedDataset
  );

  const finalizedChanges = iter.proposedChanges.map((chg) =>
    chg.approvalStatus === 'pending'
      ? { ...chg, approvalStatus: 'rejected' as const, decidedAt: now }
      : chg
  );

  const updatedIter: OptimizationIterationRecord = {
    ...iter,
    status: 'rerunning',
    proposedChanges: finalizedChanges,
    newAgentVersion: newVersionNum,
    rerunEvaluationRunId: newEvalRun.runId,
    appliedAt: now,
    appliedChangesSummary: appliedSummary,
    decisionReason: `Applied ${approvedChanges.length} approved fix(es) to create Agent v${newVersionNum}. Rerunning unchanged Evaluation Dataset v${lockedDataset.version}.`,
  };

  const nextIters = [...optRun.iterations];
  nextIters[iterIdx] = updatedIter;

  const updatedOptRun: OptimizationRunRecord = {
    ...optRun,
    currentAgentVersion: newVersionNum,
    currentEvaluationRunId: newEvalRun.runId,
    updatedAt: now,
    iterations: nextIters,
  };

  return {
    updatedOptRun,
    updatedAgentConfig,
    newEvalRun,
  };
}

export function finalizeOptimizationIteration(
  project: AgentProject,
  optRun: OptimizationRunRecord,
  iterationNumber: number
): OptimizationRunRecord {
  const iterIdx = optRun.iterations.findIndex(
    (it) => it.iterationNumber === iterationNumber
  );
  if (iterIdx < 0) {
    throw new Error(`Optimization iteration ${iterationNumber} not found.`);
  }
  const iter = optRun.iterations[iterIdx];
  if (!iter.rerunEvaluationRunId) {
    throw new Error(
      `Iteration ${iterationNumber} does not have an evaluation rerun attached.`
    );
  }

  const rerun = project.evaluationRuns.find(
    (r) => r.runId === iter.rerunEvaluationRunId
  );
  if (!rerun) {
    throw new Error(
      `Evaluation rerun "${iter.rerunEvaluationRunId}" could not be found.`
    );
  }
  if (rerun.status !== 'completed' && rerun.status !== 'completed_with_errors') {
    throw new Error(
      `Evaluation rerun ${rerun.runId} is "${rerun.status}" and must complete before finalizing iteration ${iterationNumber}.`
    );
  }

  const newSnapshot = toScorecardSnapshot(rerun.scorecard);
  const scoreDelta = computeScoreDelta(iter.previousScorecard, newSnapshot);
  const remainingFailures = rerun.results.filter((r) => r.status === 'failed');
  const now = new Date().toISOString();

  // Decide stopping conditions transparently without masking regressions
  let stoppingReason: OptimizationRunRecord['stoppingReason'] = null;
  let stoppingDetail = '';
  let nextRunStatus: OptimizationRunRecord['status'] = 'in_progress';

  if (newSnapshot.overallScore === null) {
    nextRunStatus = 'stopped';
    stoppingReason = 'execution_error';
    stoppingDetail =
      'Evaluation rerun produced no scorable tests due to execution errors.';
  } else if (remainingFailures.length === 0 && newSnapshot.errorTests === 0) {
    nextRunStatus = 'completed';
    stoppingReason = 'all_tests_passed';
    stoppingDetail = `All ${newSnapshot.totalTests} tests passed after Iteration ${iterationNumber} (Score: ${newSnapshot.overallScore.toFixed(1)}%).`;
  } else if (scoreDelta.overall !== null && scoreDelta.overall <= 0) {
    nextRunStatus = 'completed';
    stoppingReason = 'score_did_not_improve';
    stoppingDetail =
      scoreDelta.overall < 0
        ? `Optimization stopped honestly: overall score regressed by ${scoreDelta.overall.toFixed(2)} pts (${iter.previousScorecard.overallScore?.toFixed(1)}% -> ${newSnapshot.overallScore.toFixed(1)}%).`
        : `Optimization stopped: overall score did not improve (${newSnapshot.overallScore.toFixed(1)}%).`;
  } else if (iterationNumber >= MAX_OPTIMIZATION_ITERATIONS) {
    nextRunStatus = 'completed';
    stoppingReason = 'max_iterations_reached';
    stoppingDetail = `Reached the strict limit of ${MAX_OPTIMIZATION_ITERATIONS} optimization iterations (Final score: ${newSnapshot.overallScore.toFixed(1)}%).`;
  }

  const updatedIter: OptimizationIterationRecord = {
    ...iter,
    status: 'completed',
    completedAt: now,
    newScorecard: newSnapshot,
    scoreDelta,
    remainingFailureCount: remainingFailures.length,
    remainingFailedTestIds: remainingFailures.map((r) => r.testCaseId),
    decisionReason:
      stoppingDetail ||
      `Iteration ${iterationNumber} improved score by ${scoreDelta.overall !== null ? (scoreDelta.overall >= 0 ? '+' : '') + scoreDelta.overall.toFixed(2) : '0.00'} pts (${remainingFailures.length} failure(s) remaining). Ready for Iteration ${iterationNumber + 1}.`,
  };

  const nextIters = [...optRun.iterations];
  nextIters[iterIdx] = updatedIter;

  return {
    ...optRun,
    currentScorecard: newSnapshot,
    status: nextRunStatus,
    stoppingReason,
    stoppingDetail,
    updatedAt: now,
    completedAt: nextRunStatus === 'in_progress' ? null : now,
    iterations: nextIters,
  };
}

export function stopOptimizationRun(
  optRun: OptimizationRunRecord,
  reason = 'Stopped manually by user.'
): OptimizationRunRecord {
  const now = new Date().toISOString();
  const nextIters = optRun.iterations.map((it) =>
    it.status === 'completed' || it.status === 'stopped'
      ? it
      : {
          ...it,
          status: 'stopped' as const,
          completedAt: it.completedAt ?? now,
          decisionReason: reason,
        }
  );

  return {
    ...optRun,
    status: 'stopped',
    stoppingReason: 'user_stopped',
    stoppingDetail: reason,
    updatedAt: now,
    completedAt: now,
    iterations: nextIters,
  };
}

import crypto from 'crypto';
import { Type } from '@google/genai';
import { runAgentOnQuestion } from './agentRuntime.ts';
import { generateStructuredJson } from './gemini.ts';
import {
  AI_JUDGE_PROMPT_TEMPLATE,
  AI_JUDGE_SYSTEM_INSTRUCTION,
  JUDGE_PROMPT_VERSION,
} from './prompts/judgePrompts.ts';
import type {
  AgentProject,
  AgentVersionRecord,
  DeterministicJudgeChecks,
  EvaluationCategory,
  EvaluationCategoryScoreSummary,
  EvaluationDatasetVersion,
  EvaluationRunRecord,
  EvaluationScorecard,
  EvaluationTestCase,
  EvaluationTestCaseResult,
  ExecutedToolRecord,
  JudgeScoreBreakdown,
  RetrievedChunkRecord,
  StoredExtractedDocument,
} from './types.ts';

const CHECK_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'are',
  'was',
  'were',
  'will',
  'must',
  'have',
  'has',
  'had',
  'can',
  'may',
  'per',
  'via',
  'into',
  'only',
  'all',
  'any',
  'not',
]);

const REFUSAL_PATTERNS: RegExp[] = [
  /\bi cannot\b/i,
  /\bi can['’]?t\b/i,
  /\bunable to\b/i,
  /\bout of scope\b/i,
  /\boutside (?:my|the) (?:approved )?scope\b/i,
  /\boutside the scope\b/i,
  /\bnot covered in (?:the )?(?:uploaded |provided |available )?(?:documents|knowledge|files|sources)\b/i,
  /\bnot available in (?:the )?(?:uploaded |provided |available )?(?:documents|knowledge|files|sources)\b/i,
  /\bdoes not contain (?:information|details|data)\b/i,
  /\bno information (?:available|found|in the uploaded)\b/i,
  /\bmust refuse\b/i,
  /\bdecline to\b/i,
  /\bcannot provide\b/i,
  /\bcannot diagnose\b/i,
  /\bcannot waive\b/i,
  /\bnot permitted to\b/i,
  /\binsufficient information in\b/i,
];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampScore(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(5, Math.max(0, Math.round(value)));
  }
  return fallback;
}

function tokenizeForFactCheck(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$%./-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[./-]+|[./-]+$/g, ''))
    .filter((t) => t.length >= 2 && !CHECK_STOP_WORDS.has(t));
}

export function assertEvaluationRunnerPrerequisites(project: AgentProject): {
  savedAgent: AgentVersionRecord;
  savedDataset: EvaluationDatasetVersion;
} {
  if (!project.requirements?.approved) {
    throw new Error(
      'Approved requirements are required before running an evaluation.'
    );
  }

  const savedAgentVer = project.agentConfig?.savedVersion ?? null;
  if (savedAgentVer === null || !project.agentConfig) {
    throw new Error(
      'A valid saved agent definition is required before running an evaluation.'
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
      'A saved evaluation dataset is required before running an evaluation.'
    );
  }
  const savedDataset = project.evaluation.versions.find(
    (v) => v.version === savedDatasetVer
  );
  if (!savedDataset) {
    throw new Error(
      `Saved evaluation dataset v${savedDatasetVer} could not be found.`
    );
  }
  if (!savedDataset.validation.valid || savedDataset.testCases.length < 20) {
    throw new Error(
      `Saved evaluation dataset v${savedDatasetVer} must be valid and contain at least 20 test cases.`
    );
  }

  return { savedAgent, savedDataset };
}

export function computeDeterministicChecks(
  testCase: EvaluationTestCase,
  actualAnswer: string,
  retrievedEvidence: RetrievedChunkRecord[],
  projectDocumentNames: string[]
): DeterministicJudgeChecks {
  const answerLower = actualAnswer.toLowerCase();
  const detectedRefusal = REFUSAL_PATTERNS.some((pattern) =>
    pattern.test(actualAnswer)
  );

  const expectedFactsMatched: string[] = [];
  const expectedFactsMissing: string[] = [];

  for (const fact of testCase.expectedKeyFacts) {
    const tokens = Array.from(new Set(tokenizeForFactCheck(fact)));
    if (tokens.length === 0) continue;

    let hitCount = 0;
    const numericTokens = tokens.filter((t) => /\d/.test(t));
    let numericHits = 0;

    for (const token of tokens) {
      if (answerLower.includes(token)) {
        hitCount += 1;
        if (/\d/.test(token)) numericHits += 1;
      }
    }

    const ratio = hitCount / tokens.length;
    const numbersSatisfied =
      numericTokens.length === 0 || numericHits === numericTokens.length;

    if ((ratio >= 0.5 && numbersSatisfied) || ratio >= 0.65) {
      expectedFactsMatched.push(fact);
    } else {
      expectedFactsMissing.push(fact);
    }
  }

  const expectedFactsTotal = testCase.expectedKeyFacts.length;
  const factCoverageRatio =
    expectedFactsTotal > 0
      ? round2(expectedFactsMatched.length / expectedFactsTotal)
      : 1;

  const citedSourcesInAnswer = projectDocumentNames.filter((name) =>
    answerLower.includes(name.toLowerCase())
  );

  const retrievedDocNames = new Set(
    retrievedEvidence.map((chunk) => chunk.documentName.toLowerCase())
  );

  let expectedSourceMatched: boolean | null = null;
  if (testCase.expectedSourceDocument) {
    const expectedLower = testCase.expectedSourceDocument.toLowerCase();
    expectedSourceMatched =
      citedSourcesInAnswer.some((n) => n.toLowerCase() === expectedLower) ||
      retrievedDocNames.has(expectedLower);
  }

  let refusalMatchPassed = true;
  const notes: string[] = [];

  if (testCase.expectedRefusal) {
    refusalMatchPassed = detectedRefusal;
    notes.push(
      detectedRefusal
        ? 'Refusal check: PASS (refusal or unavailability phrase detected).'
        : 'Refusal check: FAIL (expected refusal/unavailability, none detected).'
    );
  } else if (testCase.category === 'answerable') {
    if (detectedRefusal && factCoverageRatio < 0.25) {
      refusalMatchPassed = false;
      notes.push(
        'Refusal check: FAIL (agent refused an answerable question with insufficient facts).'
      );
    } else {
      notes.push('Refusal check: PASS (answered without false refusal).');
    }
  } else {
    notes.push(
      detectedRefusal
        ? 'Edge case triggered caution/refusal phrasing; verify against expected behavior.'
        : 'Edge case answered directly without full refusal.'
    );
  }

  if (expectedFactsTotal > 0) {
    notes.push(
      `Keyword/fact match: ${expectedFactsMatched.length}/${expectedFactsTotal} expected key facts detected.`
    );
  }

  if (testCase.expectedSourceDocument) {
    const answerCited = citedSourcesInAnswer.some(
      (n) => n.toLowerCase() === testCase.expectedSourceDocument!.toLowerCase()
    );
    notes.push(
      answerCited
        ? `Citation match: agent explicitly cited "${testCase.expectedSourceDocument}".`
        : retrievedDocNames.has(testCase.expectedSourceDocument.toLowerCase())
          ? `Retrieval match: "${testCase.expectedSourceDocument}" retrieved, but filename not explicitly cited in answer.`
          : `Source mismatch: "${testCase.expectedSourceDocument}" was neither retrieved nor cited.`
    );
  }

  return {
    detectedRefusal,
    refusalMatchPassed,
    expectedFactsTotal,
    expectedFactsMatched,
    expectedFactsMissing,
    factCoverageRatio,
    citedSourcesInAnswer,
    expectedSourceMatched,
    notes,
  };
}

const JUDGE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    groundingScore: { type: Type.INTEGER },
    groundingExplanation: { type: Type.STRING },
    correctnessScore: { type: Type.INTEGER },
    correctnessExplanation: { type: Type.STRING },
    refusalScore: { type: Type.INTEGER },
    refusalApplicable: { type: Type.BOOLEAN },
    refusalExplanation: { type: Type.STRING },
    supportingEvidence: { type: Type.STRING },
    failureReasons: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    passed: { type: Type.BOOLEAN },
  },
  required: [
    'groundingScore',
    'groundingExplanation',
    'correctnessScore',
    'correctnessExplanation',
    'refusalScore',
    'refusalApplicable',
    'refusalExplanation',
    'supportingEvidence',
    'failureReasons',
    'passed',
  ],
};

function renderJudgePrompt(
  testCase: EvaluationTestCase,
  actualAnswer: string,
  retrievedEvidence: RetrievedChunkRecord[],
  toolsUsed: ExecutedToolRecord[],
  deterministicChecks: DeterministicJudgeChecks
): string {
  const retrievedText =
    retrievedEvidence.length > 0
      ? retrievedEvidence
          .map(
            (c, i) =>
              `[${i + 1}] ${c.documentName} (score=${c.score}): ${c.snippet.slice(0, 800)}`
          )
          .join('\n\n')
      : 'None retrieved.';

  const toolsText =
    toolsUsed.length > 0
      ? toolsUsed
          .map(
            (t) =>
              `- ${t.toolName} (${t.status}): input=${JSON.stringify(t.input)} -> output=${JSON.stringify(t.output)}`
          )
          .join('\n')
      : 'None invoked.';

  const vars: Record<string, string> = {
    JUDGE_VERSION: JUDGE_PROMPT_VERSION,
    TEST_CASE_ID: testCase.id,
    CATEGORY: testCase.category,
    EXPECTED_REFUSAL: String(testCase.expectedRefusal),
    EXPECTED_SOURCE_DOCUMENT: testCase.expectedSourceDocument ?? 'None',
    QUESTION: testCase.question,
    EXPECTED_BEHAVIOR: testCase.expectedBehavior,
    EXPECTED_KEY_FACTS:
      testCase.expectedKeyFacts.length > 0
        ? testCase.expectedKeyFacts.map((f) => `- ${f}`).join('\n')
        : 'None (refusal / boundary case)',
    EXPECTED_SUPPORTING_EVIDENCE: testCase.supportingEvidence || 'None specified',
    RETRIEVED_EVIDENCE: retrievedText,
    TOOLS_USED: toolsText,
    DETERMINISTIC_CHECKS: JSON.stringify(deterministicChecks, null, 2),
    ACTUAL_ANSWER: actualAnswer,
  };

  let rendered = AI_JUDGE_PROMPT_TEMPLATE;
  for (const [key, val] of Object.entries(vars)) {
    rendered = rendered.replaceAll(`{{${key}}}`, val);
  }
  return rendered;
}

export async function judgeTestCaseResponse(
  testCase: EvaluationTestCase,
  actualAnswer: string,
  retrievedEvidence: RetrievedChunkRecord[],
  toolsUsed: ExecutedToolRecord[],
  deterministicChecks: DeterministicJudgeChecks
): Promise<{ judge: JudgeScoreBreakdown; passed: boolean; failureReason: string }> {
  const prompt = renderJudgePrompt(
    testCase,
    actualAnswer,
    retrievedEvidence,
    toolsUsed,
    deterministicChecks
  );

  const rawJson = await generateStructuredJson(
    prompt,
    AI_JUDGE_SYSTEM_INSTRUCTION,
    JUDGE_RESPONSE_SCHEMA
  );
  const parsed = JSON.parse(rawJson) as {
    groundingScore?: unknown;
    groundingExplanation?: unknown;
    correctnessScore?: unknown;
    correctnessExplanation?: unknown;
    refusalScore?: unknown;
    refusalApplicable?: unknown;
    refusalExplanation?: unknown;
    supportingEvidence?: unknown;
    failureReasons?: unknown;
    passed?: unknown;
  };

  let groundingScore = clampScore(parsed.groundingScore, 0);
  let correctnessScore = clampScore(parsed.correctnessScore, 0);
  const refusalApplicable = Boolean(
    parsed.refusalApplicable ||
      testCase.expectedRefusal ||
      testCase.category === 'out_of_scope' ||
      deterministicChecks.detectedRefusal
  );
  let refusalScore: number | null = refusalApplicable
    ? clampScore(parsed.refusalScore, 0)
    : null;

  const failureReasons: string[] = Array.isArray(parsed.failureReasons)
    ? parsed.failureReasons
        .map((r) => (typeof r === 'string' ? r.trim() : ''))
        .filter(Boolean)
    : [];
  const deterministicOverridesApplied: string[] = [];

  // Deterministic Anti-Bias Safeguard 1: Missed expected refusal
  if (testCase.expectedRefusal && !deterministicChecks.detectedRefusal) {
    if ((refusalScore ?? 0) > 1) {
      refusalScore = 1;
      deterministicOverridesApplied.push(
        'Capped Refusal Quality score to 1/5 because no refusal/unavailability phrase was detected.'
      );
    }
    if (correctnessScore > 2) {
      correctnessScore = 2;
      deterministicOverridesApplied.push(
        'Capped Correctness score to 2/5 because expected refusal behavior was missed.'
      );
    }
    failureReasons.push(
      'Deterministic check failed: agent did not clearly refuse an out-of-scope or unsupported request.'
    );
  }

  // Deterministic Anti-Bias Safeguard 2: Unnecessary refusal on answerable question
  if (
    testCase.category === 'answerable' &&
    !testCase.expectedRefusal &&
    deterministicChecks.detectedRefusal &&
    deterministicChecks.factCoverageRatio < 0.25
  ) {
    refusalScore = Math.min(refusalScore ?? 1, 1);
    correctnessScore = Math.min(correctnessScore, 1);
    deterministicOverridesApplied.push(
      'Capped Refusal Quality and Correctness scores to 1/5 due to unnecessary refusal of an answerable question.'
    );
    failureReasons.push(
      'Deterministic check failed: agent unnecessarily refused an answerable question.'
    );
  }

  // Deterministic Anti-Bias Safeguard 3: Zero expected facts found on answerable question
  if (
    testCase.category === 'answerable' &&
    !testCase.expectedRefusal &&
    testCase.expectedKeyFacts.length > 0 &&
    deterministicChecks.factCoverageRatio === 0 &&
    correctnessScore >= 3
  ) {
    correctnessScore = 2;
    deterministicOverridesApplied.push(
      'Capped Correctness score to 2/5 because 0 expected key facts appeared in the response.'
    );
    failureReasons.push(
      'Deterministic check failed: none of the expected key facts were found in the answer.'
    );
  }

  const dedupedFailures = Array.from(new Set(failureReasons));

  const passed =
    Boolean(parsed.passed) &&
    deterministicChecks.refusalMatchPassed &&
    groundingScore >= 3 &&
    correctnessScore >= 3 &&
    (!refusalApplicable || (refusalScore ?? 0) >= 3) &&
    deterministicOverridesApplied.length === 0;

  const judge: JudgeScoreBreakdown = {
    groundingScore,
    groundingExplanation:
      typeof parsed.groundingExplanation === 'string'
        ? parsed.groundingExplanation.trim()
        : '',
    correctnessScore,
    correctnessExplanation:
      typeof parsed.correctnessExplanation === 'string'
        ? parsed.correctnessExplanation.trim()
        : '',
    refusalScore,
    refusalApplicable,
    refusalExplanation:
      typeof parsed.refusalExplanation === 'string'
        ? parsed.refusalExplanation.trim()
        : refusalApplicable
          ? ''
          : 'Not applicable (answerable query answered without refusal).',
    supportingEvidence:
      typeof parsed.supportingEvidence === 'string'
        ? parsed.supportingEvidence.trim()
        : '',
    failureReasons: dedupedFailures,
    deterministicOverridesApplied,
  };

  const failureReason = passed
    ? ''
    : dedupedFailures[0] ||
      `Scored below passing threshold (Grounding ${groundingScore}/5, Correctness ${correctnessScore}/5${
        refusalApplicable ? `, Refusal ${refusalScore}/5` : ''
      }).`;

  return { judge, passed, failureReason };
}

export function computeEvaluationScorecard(
  testCases: EvaluationTestCase[],
  results: EvaluationTestCaseResult[]
): EvaluationScorecard {
  const resultMap = new Map<string, EvaluationTestCaseResult>();
  for (const r of results) {
    resultMap.set(r.testCaseId, r);
  }

  let passedTests = 0;
  let failedTests = 0;
  let errorTests = 0;
  let skippedTests = 0;

  let groundingSum = 0;
  let groundingCount = 0;
  let correctnessSum = 0;
  let correctnessCount = 0;
  let refusalSum = 0;
  let refusalCount = 0;

  const categories: EvaluationCategory[] = ['answerable', 'out_of_scope', 'edge_case'];
  const byCategory = {} as Record<EvaluationCategory, EvaluationCategoryScoreSummary>;

  for (const cat of categories) {
    const catCases = testCases.filter((tc) => tc.category === cat);
    let cCompleted = 0;
    let cPassed = 0;
    let cFailed = 0;
    let cErrors = 0;
    let cSkipped = 0;
    let cGroundingSum = 0;
    let cGroundingCount = 0;
    let cCorrectnessSum = 0;
    let cCorrectnessCount = 0;
    let cRefusalSum = 0;
    let cRefusalCount = 0;

    for (const tc of catCases) {
      const res = resultMap.get(tc.id);
      if (!res) continue;

      if (res.status === 'passed') {
        passedTests += 1;
        cPassed += 1;
        cCompleted += 1;
      } else if (res.status === 'failed') {
        failedTests += 1;
        cFailed += 1;
        cCompleted += 1;
      } else if (res.status === 'error') {
        errorTests += 1;
        cErrors += 1;
      } else if (res.status === 'skipped') {
        skippedTests += 1;
        cSkipped += 1;
      }

      if (res.judge && (res.status === 'passed' || res.status === 'failed')) {
        groundingSum += res.judge.groundingScore;
        groundingCount += 1;
        cGroundingSum += res.judge.groundingScore;
        cGroundingCount += 1;

        correctnessSum += res.judge.correctnessScore;
        correctnessCount += 1;
        cCorrectnessSum += res.judge.correctnessScore;
        cCorrectnessCount += 1;

        if (res.judge.refusalApplicable && res.judge.refusalScore !== null) {
          refusalSum += res.judge.refusalScore;
          refusalCount += 1;
          cRefusalSum += res.judge.refusalScore;
          cRefusalCount += 1;
        }
      }
    }

    byCategory[cat] = {
      category: cat,
      total: catCases.length,
      completed: cCompleted,
      passed: cPassed,
      failed: cFailed,
      errors: cErrors,
      skipped: cSkipped,
      passRatePercent: cCompleted > 0 ? round2((cPassed / cCompleted) * 100) : null,
      avgGroundingPercent:
        cGroundingCount > 0 ? round2((cGroundingSum / cGroundingCount / 5) * 100) : null,
      avgCorrectnessPercent:
        cCorrectnessCount > 0
          ? round2((cCorrectnessSum / cCorrectnessCount / 5) * 100)
          : null,
      avgRefusalPercent:
        cRefusalCount > 0 ? round2((cRefusalSum / cRefusalCount / 5) * 100) : null,
    };
  }

  const evaluatedTests = passedTests + failedTests;
  const pendingTests = Math.max(
    0,
    testCases.length - (evaluatedTests + errorTests + skippedTests)
  );

  const groundingScore =
    groundingCount > 0 ? round2((groundingSum / groundingCount / 5) * 100) : null;
  const correctnessScore =
    correctnessCount > 0 ? round2((correctnessSum / correctnessCount / 5) * 100) : null;
  const refusalQualityScore =
    refusalCount > 0 ? round2((refusalSum / refusalCount / 5) * 100) : null;

  const refusalScoreStatus: 'available' | 'unavailable' =
    refusalCount > 0 ? 'available' : 'unavailable';

  let overallScore: number | null = null;
  let weightsUsed = { grounding: 0.4, correctness: 0.4, refusal: 0.2 };
  let formulaText = 'Pending evaluated test cases.';

  if (groundingScore !== null && correctnessScore !== null) {
    if (refusalQualityScore !== null) {
      weightsUsed = { grounding: 0.4, correctness: 0.4, refusal: 0.2 };
      overallScore = round2(
        groundingScore * 0.4 + correctnessScore * 0.4 + refusalQualityScore * 0.2
      );
      formulaText = `0.40 × Grounding (${groundingScore}%) + 0.40 × Correctness (${correctnessScore}%) + 0.20 × Refusal Quality (${refusalQualityScore}%) = ${overallScore}%`;
    } else {
      // Normalize remaining 40% + 40% = 80% -> 50% + 50% when no refusal cases apply
      weightsUsed = { grounding: 0.5, correctness: 0.5, refusal: 0 };
      overallScore = round2(groundingScore * 0.5 + correctnessScore * 0.5);
      formulaText = `0.50 × Grounding (${groundingScore}%) + 0.50 × Correctness (${correctnessScore}%) = ${overallScore}% (normalized from 40%/40%; 0 applicable refusal cases)`;
    }
  }

  const groundingFormulaText =
    groundingCount > 0
      ? `(${round2(groundingSum / groundingCount)} / 5) × 100 = ${groundingScore}% across ${groundingCount} evaluated test(s)`
      : 'No evaluated tests yet';

  const correctnessFormulaText =
    correctnessCount > 0
      ? `(${round2(correctnessSum / correctnessCount)} / 5) × 100 = ${correctnessScore}% across ${correctnessCount} evaluated test(s)`
      : 'No evaluated tests yet';

  const refusalFormulaText =
    refusalCount > 0
      ? `(${round2(refusalSum / refusalCount)} / 5) × 100 = ${refusalQualityScore}% across ${refusalCount} applicable refusal test(s)`
      : 'Unavailable (0 applicable refusal cases evaluated)';

  return {
    overallScore,
    groundingScore,
    correctnessScore,
    refusalQualityScore,
    refusalScoreStatus,
    weightsUsed,
    formulaText,
    groundingFormulaText,
    correctnessFormulaText,
    refusalFormulaText,
    counts: {
      totalTests: testCases.length,
      evaluatedTests,
      passedTests,
      failedTests,
      errorTests,
      skippedTests,
      pendingTests,
      groundingTestsUsed: groundingCount,
      correctnessTestsUsed: correctnessCount,
      refusalTestsUsed: refusalCount,
    },
    byCategory,
  };
}

export function createEvaluationRunRecord(
  project: AgentProject,
  savedAgent: AgentVersionRecord,
  savedDataset: EvaluationDatasetVersion
): EvaluationRunRecord {
  const now = new Date().toISOString();
  const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
  const snapshot = savedDataset.testCases.map((tc) => ({
    ...tc,
    expectedKeyFacts: [...tc.expectedKeyFacts],
  }));

  return {
    runId,
    projectId: project.id,
    agentName: savedAgent.definition.agentName || project.name,
    agentVersion: savedAgent.version,
    datasetVersion: savedDataset.version,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    currentTestCaseId: snapshot[0]?.id ?? null,
    totalTests: snapshot.length,
    testCasesSnapshot: snapshot,
    results: [],
    scorecard: computeEvaluationScorecard(snapshot, []),
    runErrors: [],
  };
}

export async function executeNextTestCaseInRun(
  project: AgentProject,
  extractedDocs: StoredExtractedDocument[],
  runRecord: EvaluationRunRecord,
  options?: { targetTestCaseId?: string }
): Promise<{
  runRecord: EvaluationRunRecord;
  executedResult: EvaluationTestCaseResult | null;
  done: boolean;
}> {
  const agentVersionRecord = project.agentConfig?.versions.find(
    (v) => v.version === runRecord.agentVersion
  );
  if (!agentVersionRecord) {
    throw new Error(
      `Agent definition v${runRecord.agentVersion} used by this run is missing.`
    );
  }

  const existingById = new Map<string, EvaluationTestCaseResult>();
  for (const res of runRecord.results) {
    existingById.set(res.testCaseId, res);
  }

  let targetCase: EvaluationTestCase | undefined;
  if (options?.targetTestCaseId) {
    targetCase = runRecord.testCasesSnapshot.find(
      (tc) => tc.id === options.targetTestCaseId
    );
    if (!targetCase) {
      throw new Error(
        `Test case "${options.targetTestCaseId}" not found in run ${runRecord.runId}.`
      );
    }
  } else {
    targetCase = runRecord.testCasesSnapshot.find(
      (tc) => !existingById.has(tc.id)
    );
  }

  if (!targetCase) {
    const scorecard = computeEvaluationScorecard(
      runRecord.testCasesSnapshot,
      runRecord.results
    );
    const hasErrors = scorecard.counts.errorTests > 0;
    const finalized: EvaluationRunRecord = {
      ...runRecord,
      status: hasErrors ? 'completed_with_errors' : 'completed',
      currentTestCaseId: null,
      completedAt: runRecord.completedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      scorecard,
    };
    return { runRecord: finalized, executedResult: null, done: true };
  }

  const startedMs = Date.now();
  const projectDocNames = project.documents.map((d) => d.originalName);

  let result: EvaluationTestCaseResult;
  try {
    const agentOutput = await runAgentOnQuestion(
      agentVersionRecord.definition,
      extractedDocs,
      targetCase.question
    );

    const deterministicChecks = computeDeterministicChecks(
      targetCase,
      agentOutput.actualAnswer,
      agentOutput.retrievedEvidence,
      projectDocNames
    );

    const judged = await judgeTestCaseResponse(
      targetCase,
      agentOutput.actualAnswer,
      agentOutput.retrievedEvidence,
      agentOutput.toolsUsed,
      deterministicChecks
    );

    result = {
      testCaseId: targetCase.id,
      question: targetCase.question,
      category: targetCase.category,
      difficulty: targetCase.difficulty,
      expectedBehavior: targetCase.expectedBehavior,
      expectedKeyFacts: targetCase.expectedKeyFacts,
      expectedSourceDocument: targetCase.expectedSourceDocument,
      expectedSupportingEvidence: targetCase.supportingEvidence,
      expectedRefusal: targetCase.expectedRefusal,
      status: judged.passed ? 'passed' : 'failed',
      actualAnswer: agentOutput.actualAnswer,
      retrievedEvidence: agentOutput.retrievedEvidence,
      sourcesRetrieved: agentOutput.sourcesRetrieved,
      toolsUsed: agentOutput.toolsUsed,
      deterministicChecks,
      judge: judged.judge,
      failureReason: judged.failureReason,
      executedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
    };
  } catch (error) {
    const errMsg =
      error instanceof Error ? error.message : 'Test execution error.';
    const emptyChecks: DeterministicJudgeChecks = {
      detectedRefusal: false,
      refusalMatchPassed: false,
      expectedFactsTotal: targetCase.expectedKeyFacts.length,
      expectedFactsMatched: [],
      expectedFactsMissing: targetCase.expectedKeyFacts,
      factCoverageRatio: 0,
      citedSourcesInAnswer: [],
      expectedSourceMatched: null,
      notes: [`Execution error before scoring: ${errMsg}`],
    };

    result = {
      testCaseId: targetCase.id,
      question: targetCase.question,
      category: targetCase.category,
      difficulty: targetCase.difficulty,
      expectedBehavior: targetCase.expectedBehavior,
      expectedKeyFacts: targetCase.expectedKeyFacts,
      expectedSourceDocument: targetCase.expectedSourceDocument,
      expectedSupportingEvidence: targetCase.supportingEvidence,
      expectedRefusal: targetCase.expectedRefusal,
      status: 'error',
      actualAnswer: '',
      retrievedEvidence: [],
      sourcesRetrieved: [],
      toolsUsed: [],
      deterministicChecks: emptyChecks,
      judge: null,
      failureReason: 'Execution error — test case was not judged.',
      errorMessage: errMsg,
      executedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
    };
  }

  // Replace existing result for this testCaseId or append in snapshot order
  existingById.set(result.testCaseId, result);
  const nextResults: EvaluationTestCaseResult[] = runRecord.testCasesSnapshot
    .map((tc) => existingById.get(tc.id))
    .filter((item): item is EvaluationTestCaseResult => Boolean(item));

  const nextPending = runRecord.testCasesSnapshot.find(
    (tc) => !existingById.has(tc.id)
  );
  const scorecard = computeEvaluationScorecard(
    runRecord.testCasesSnapshot,
    nextResults
  );
  const now = new Date().toISOString();
  const done = !nextPending;
  const runErrors = nextResults
    .filter((r) => r.status === 'error' && r.errorMessage)
    .map((r) => `${r.testCaseId}: ${r.errorMessage}`);

  const updatedRun: EvaluationRunRecord = {
    ...runRecord,
    status: done
      ? scorecard.counts.errorTests > 0
        ? 'completed_with_errors'
        : 'completed'
      : 'running',
    updatedAt: now,
    completedAt: done ? now : null,
    currentTestCaseId: nextPending?.id ?? null,
    results: nextResults,
    scorecard,
    runErrors,
  };

  return { runRecord: updatedRun, executedResult: result, done };
}

export function skipTestCaseInRun(
  runRecord: EvaluationRunRecord,
  testCaseId: string,
  reason = 'Skipped by user after execution error or pause.'
): EvaluationRunRecord {
  const targetCase = runRecord.testCasesSnapshot.find(
    (tc) => tc.id === testCaseId
  );
  if (!targetCase) {
    throw new Error(`Test case "${testCaseId}" not found in this evaluation run.`);
  }

  const existingById = new Map<string, EvaluationTestCaseResult>();
  for (const res of runRecord.results) {
    existingById.set(res.testCaseId, res);
  }

  const skippedResult: EvaluationTestCaseResult = {
    testCaseId: targetCase.id,
    question: targetCase.question,
    category: targetCase.category,
    difficulty: targetCase.difficulty,
    expectedBehavior: targetCase.expectedBehavior,
    expectedKeyFacts: targetCase.expectedKeyFacts,
    expectedSourceDocument: targetCase.expectedSourceDocument,
    expectedSupportingEvidence: targetCase.supportingEvidence,
    expectedRefusal: targetCase.expectedRefusal,
    status: 'skipped',
    actualAnswer: '',
    retrievedEvidence: [],
    sourcesRetrieved: [],
    toolsUsed: [],
    deterministicChecks: {
      detectedRefusal: false,
      refusalMatchPassed: false,
      expectedFactsTotal: targetCase.expectedKeyFacts.length,
      expectedFactsMatched: [],
      expectedFactsMissing: targetCase.expectedKeyFacts,
      factCoverageRatio: 0,
      citedSourcesInAnswer: [],
      expectedSourceMatched: null,
      notes: [reason],
    },
    judge: null,
    failureReason: reason,
    errorMessage: reason,
    executedAt: new Date().toISOString(),
    durationMs: 0,
  };

  existingById.set(targetCase.id, skippedResult);
  const nextResults = runRecord.testCasesSnapshot
    .map((tc) => existingById.get(tc.id))
    .filter((item): item is EvaluationTestCaseResult => Boolean(item));

  const nextPending = runRecord.testCasesSnapshot.find(
    (tc) => !existingById.has(tc.id)
  );
  const scorecard = computeEvaluationScorecard(
    runRecord.testCasesSnapshot,
    nextResults
  );
  const now = new Date().toISOString();
  const done = !nextPending;

  return {
    ...runRecord,
    status: done
      ? scorecard.counts.errorTests > 0
        ? 'completed_with_errors'
        : 'completed'
      : runRecord.status === 'running'
        ? 'running'
        : 'paused',
    updatedAt: now,
    completedAt: done ? now : runRecord.completedAt,
    currentTestCaseId: nextPending?.id ?? null,
    results: nextResults,
    scorecard,
  };
}

import { Type } from '@google/genai';
import { generateStructuredJson } from './gemini.ts';
import {
  ANSWERABLE_GENERATION_PROMPT_TEMPLATE,
  DOCUMENT_ANALYSIS_PROMPT_TEMPLATE,
  EDGE_CASE_GENERATION_PROMPT_TEMPLATE,
  EVALUATION_PROMPT_VERSION,
  REFUSAL_GENERATION_PROMPT_TEMPLATE,
  renderPromptTemplate,
  TEST_CASE_VALIDATION_PROMPT_TEMPLATE,
} from './prompts/evaluationPrompts.ts';
import type {
  AgentProject,
  AgentVersionRecord,
  EvaluationCategory,
  EvaluationDifficulty,
  EvaluationTestCase,
  EvaluationValidationIssue,
  EvaluationValidationResult,
  StoredExtractedDocument,
} from './types.ts';

export const MIN_EVALUATION_TEST_CASES = 20;

interface DocumentAnalysisResult {
  summary: string;
  verifiedFacts: Array<{
    fact: string;
    sourceDocument: string;
    supportingSnippet: string;
  }>;
  ambiguitiesOrConflicts: string[];
  knowledgeGaps: string[];
}

export interface EvaluationPrerequisites {
  savedAgentVersion: AgentVersionRecord;
  documentNames: string[];
}

const STOP_WORDS = new Set([
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
  'what',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'whose',
  'why',
  'how',
  'can',
  'could',
  'should',
  'would',
  'does',
  'did',
  'has',
  'have',
  'had',
  'not',
  'but',
  'into',
  'onto',
  'about',
  'between',
  'under',
  'over',
  'than',
  'then',
  'there',
  'their',
  'they',
  'them',
  'your',
  'you',
  'our',
  'only',
  'also',
  'must',
  'need',
  'user',
  'agent',
  'document',
  'documents',
  'question',
  'answer',
  'based',
  'uploaded',
  'section',
  'page',
  'row',
  'stated',
  'explains',
  'explicitly',
  'according',
]);

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s./:%$-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeContent(value: string): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(tokenizeContent(a));
  const tokensB = new Set(tokenizeContent(b));
  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection += 1;
    }
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function buildDocumentsContext(extractedDocs: StoredExtractedDocument[]): string {
  if (extractedDocs.length === 0) {
    return 'NO READABLE UPLOADED DOCUMENTS AVAILABLE.';
  }
  const perDocCharBudget = Math.max(3500, Math.floor(24000 / extractedDocs.length));
  return extractedDocs
    .map((doc) => {
      const clipped = doc.extractedText.slice(0, perDocCharBudget);
      const truncatedNote =
        doc.extractedText.length > perDocCharBudget
          ? `\n[... truncated ${doc.extractedText.length - perDocCharBudget} additional chars ...]`
          : '';
      return `=== DOCUMENT: ${doc.documentName} (${doc.fileType.toUpperCase()}) ===\n${clipped}${truncatedNote}`;
    })
    .join('\n\n');
}

function buildPromptVariables(
  project: AgentProject,
  savedAgentVersion: AgentVersionRecord,
  extractedDocs: StoredExtractedDocument[]
): Record<string, string> {
  const req = project.requirements!;
  const def = savedAgentVersion.definition;
  const documentNames = extractedDocs.map((d) => d.documentName);

  const systemPromptSummary = [
    `Role: ${def.systemPrompt.agentRoleAndIdentity}`,
    `Missing Info Rule: ${def.systemPrompt.missingInformationHandling}`,
    `Grounding Rule: ${def.systemPrompt.groundingAndCitationRules}`,
    `Refusal Format: ${def.outputContract.refusalFormat}`,
  ].join(' | ');

  return {
    PROMPT_VERSION: EVALUATION_PROMPT_VERSION,
    AGENT_NAME: def.agentName || req.agentName || project.name,
    AGENT_VERSION: String(savedAgentVersion.version),
    AGENT_PURPOSE: req.agentPurpose,
    TARGET_AUDIENCE: req.targetAudience,
    SCOPE_SUMMARY: req.scope.join('; '),
    MUST_ANSWER_TOPICS: req.mustAnswerTopics.join('; ') || 'None specified',
    MUST_REFUSE_TOPICS: req.mustRefuseTopics.join('; ') || 'None specified',
    OUT_OF_SCOPE_TOPICS: req.outOfScopeTopics.join('; ') || 'None specified',
    SYSTEM_PROMPT_SUMMARY: systemPromptSummary,
    DOCUMENTS_CONTEXT: buildDocumentsContext(extractedDocs),
    DOCUMENT_NAMES: documentNames.join(', ') || 'None',
  };
}

export function assertEvaluationPrerequisites(
  project: AgentProject,
  extractedDocs: StoredExtractedDocument[],
  options?: { requireDocuments?: boolean }
): EvaluationPrerequisites {
  if (!project.requirements?.approved) {
    throw new Error(
      'Approved requirements are required before creating or validating an evaluation dataset.'
    );
  }

  const savedVerNum = project.agentConfig?.savedVersion ?? null;
  if (savedVerNum === null || !project.agentConfig) {
    throw new Error(
      'A saved agent definition is required. Save a validated definition in Agent Builder first.'
    );
  }

  const savedRecord = project.agentConfig.versions.find(
    (v) => v.version === savedVerNum
  );
  if (!savedRecord) {
    throw new Error(`Saved agent definition v${savedVerNum} could not be found.`);
  }

  if (!savedRecord.validation.valid) {
    throw new Error(
      `Saved agent definition v${savedVerNum} currently has validation errors. Fix and re-save it in Agent Builder first.`
    );
  }

  if (options?.requireDocuments && extractedDocs.length === 0) {
    throw new Error(
      'Upload at least one readable PDF, TXT, or CSV knowledge document before generating document-grounded evaluation test cases.'
    );
  }

  return {
    savedAgentVersion: savedRecord,
    documentNames: extractedDocs.map((d) => d.documentName),
  };
}

function normalizeCategory(value: unknown): EvaluationCategory {
  if (value === 'answerable' || value === 'out_of_scope' || value === 'edge_case') {
    return value;
  }
  const lowered = String(value ?? '').toLowerCase();
  if (lowered.includes('refus') || lowered.includes('scope')) {
    return 'out_of_scope';
  }
  if (lowered.includes('edge')) {
    return 'edge_case';
  }
  return 'answerable';
}

function normalizeDifficulty(value: unknown): EvaluationDifficulty {
  if (value === 'easy' || value === 'medium' || value === 'hard') {
    return value;
  }
  return 'medium';
}

function matchDocumentName(
  rawName: unknown,
  extractedDocs: StoredExtractedDocument[]
): string | null {
  if (typeof rawName !== 'string') return null;
  const trimmed = rawName.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'none') {
    return null;
  }
  const exact = extractedDocs.find(
    (doc) => doc.documentName.toLowerCase() === trimmed.toLowerCase()
  );
  return exact ? exact.documentName : trimmed;
}

function sanitizeRawTestCase(
  raw: Record<string, unknown>,
  fallbackId: string,
  extractedDocs: StoredExtractedDocument[],
  forcedCategory?: EvaluationCategory
): EvaluationTestCase {
  const category = forcedCategory ?? normalizeCategory(raw.category);
  const idRaw = typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id.trim() : fallbackId;
  const question = typeof raw.question === 'string' ? raw.question.trim() : '';
  const difficulty = normalizeDifficulty(raw.difficulty);
  const expectedBehavior =
    typeof raw.expectedBehavior === 'string' ? raw.expectedBehavior.trim() : '';
  const expectedKeyFacts = Array.isArray(raw.expectedKeyFacts)
    ? raw.expectedKeyFacts
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item.length > 0)
    : [];

  let expectedSourceDocument = matchDocumentName(
    raw.expectedSourceDocument,
    extractedDocs
  );
  if (category === 'out_of_scope') {
    expectedSourceDocument = null;
  }

  const supportingEvidence =
    typeof raw.supportingEvidence === 'string' ? raw.supportingEvidence.trim() : '';

  const expectedRefusal =
    forcedCategory === 'out_of_scope'
      ? true
      : forcedCategory === 'answerable'
        ? false
        : Boolean(raw.expectedRefusal);

  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';

  return {
    id: idRaw,
    question,
    category,
    difficulty,
    expectedBehavior,
    expectedKeyFacts: category === 'out_of_scope' ? [] : expectedKeyFacts,
    expectedSourceDocument,
    supportingEvidence,
    expectedRefusal,
    reason,
  };
}

export function coerceEvaluationTestCases(
  rawInput: unknown,
  extractedDocs: StoredExtractedDocument[]
): EvaluationTestCase[] {
  if (!Array.isArray(rawInput)) {
    throw new Error('Evaluation testCases payload must be an array.');
  }

  return rawInput.map((item, idx) => {
    const obj =
      item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const fallbackId = `TC-${String(idx + 1).padStart(3, '0')}`;
    return sanitizeRawTestCase(obj, fallbackId, extractedDocs);
  });
}

function findBestMatchedDocument(
  docName: string,
  extractedDocs: StoredExtractedDocument[]
): StoredExtractedDocument | undefined {
  return extractedDocs.find(
    (doc) => doc.documentName.toLowerCase() === docName.trim().toLowerCase()
  );
}

function checkGroundingOverlap(
  testCase: EvaluationTestCase,
  doc: StoredExtractedDocument
): { grounded: boolean; matchedRatio: number } {
  const docNormalized = normalizeText(doc.extractedText);
  const docTokenSet = new Set(tokenizeContent(doc.extractedText));

  // Direct substring match check for supporting evidence snippet (at least 18 chars)
  const evidenceNormalized = normalizeText(testCase.supportingEvidence);
  if (evidenceNormalized.length >= 18 && docNormalized.includes(evidenceNormalized)) {
    return { grounded: true, matchedRatio: 1 };
  }

  // Check token overlap from supportingEvidence + expectedKeyFacts
  const claimTokens = Array.from(
    new Set([
      ...tokenizeContent(testCase.supportingEvidence),
      ...testCase.expectedKeyFacts.flatMap((fact) => tokenizeContent(fact)),
    ])
  );

  if (claimTokens.length === 0) {
    return { grounded: false, matchedRatio: 0 };
  }

  let matchedCount = 0;
  for (const token of claimTokens) {
    if (docTokenSet.has(token) || docNormalized.includes(token)) {
      matchedCount += 1;
    }
  }

  const ratio = matchedCount / claimTokens.length;
  // Require reasonable overlap (>= 25% of content tokens or >= 2 tokens)
  const grounded = matchedCount >= 2 && (ratio >= 0.25 || matchedCount >= 4);
  return { grounded, matchedRatio: ratio };
}

export function validateEvaluationTestCases(
  project: AgentProject,
  extractedDocs: StoredExtractedDocument[],
  testCases: EvaluationTestCase[]
): EvaluationValidationResult {
  const errors: EvaluationValidationIssue[] = [];
  const warnings: EvaluationValidationIssue[] = [];

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

  if (testCases.length < MIN_EVALUATION_TEST_CASES) {
    errors.push({
      field: 'testCases',
      severity: 'error',
      message: `Evaluation set requires at least ${MIN_EVALUATION_TEST_CASES} test cases (currently ${testCases.length}).`,
    });
  }

  const seenIds = new Map<string, number>();
  let duplicatePairs = 0;

  for (let i = 0; i < testCases.length; i += 1) {
    const tc = testCases[i];
    byCategory[tc.category] += 1;
    byDifficulty[tc.difficulty] += 1;

    const cleanId = tc.id.trim();
    if (!cleanId) {
      errors.push({
        testCaseId: `#${i + 1}`,
        field: 'id',
        severity: 'error',
        message: `Test case #${i + 1} is missing a unique ID.`,
      });
    } else {
      const prevIdx = seenIds.get(cleanId.toLowerCase());
      if (prevIdx !== undefined) {
        errors.push({
          testCaseId: cleanId,
          field: 'id',
          severity: 'error',
          message: `Duplicate test case ID "${cleanId}" found (also used at row #${prevIdx + 1}).`,
        });
      } else {
        seenIds.set(cleanId.toLowerCase(), i);
      }
    }

    if (tc.question.trim().length < 8) {
      errors.push({
        testCaseId: cleanId || `#${i + 1}`,
        field: 'question',
        severity: 'error',
        message: `${cleanId || `Row #${i + 1}`}: question is too short or empty.`,
      });
    }

    if (tc.expectedBehavior.trim().length < 10) {
      errors.push({
        testCaseId: cleanId || `#${i + 1}`,
        field: 'expectedBehavior',
        severity: 'error',
        message: `${cleanId}: expectedBehavior description is required.`,
      });
    }

    if (tc.reason.trim().length < 8) {
      errors.push({
        testCaseId: cleanId || `#${i + 1}`,
        field: 'reason',
        severity: 'error',
        message: `${cleanId}: reason explaining why this case matters is required.`,
      });
    }

    // Category-specific validation
    if (tc.category === 'answerable') {
      if (tc.expectedRefusal) {
        errors.push({
          testCaseId: cleanId,
          field: 'expectedRefusal',
          severity: 'error',
          message: `${cleanId}: answerable test cases must have expectedRefusal set to false.`,
        });
      }
      if (tc.expectedKeyFacts.length === 0) {
        errors.push({
          testCaseId: cleanId,
          field: 'expectedKeyFacts',
          severity: 'error',
          message: `${cleanId}: answerable test cases must include at least one expected key fact.`,
        });
      }
      if (!tc.expectedSourceDocument) {
        errors.push({
          testCaseId: cleanId,
          field: 'expectedSourceDocument',
          severity: 'error',
          message: `${cleanId}: answerable test cases must specify an uploaded source document.`,
        });
      } else {
        const matchedDoc = findBestMatchedDocument(
          tc.expectedSourceDocument,
          extractedDocs
        );
        if (!matchedDoc) {
          errors.push({
            testCaseId: cleanId,
            field: 'expectedSourceDocument',
            severity: 'error',
            message: `${cleanId}: source document "${tc.expectedSourceDocument}" does not match any parsed document in this project.`,
          });
        } else if (tc.supportingEvidence.trim().length < 12) {
          errors.push({
            testCaseId: cleanId,
            field: 'supportingEvidence',
            severity: 'error',
            message: `${cleanId}: supportingEvidence quote or reference (>= 12 characters) is required.`,
          });
        } else {
          const grounding = checkGroundingOverlap(tc, matchedDoc);
          if (!grounding.grounded) {
            errors.push({
              testCaseId: cleanId,
              field: 'supportingEvidence',
              severity: 'error',
              message: `${cleanId}: supporting evidence and expected key facts could not be verified inside "${matchedDoc.documentName}". Edit or regenerate this case to prevent fabricated test facts.`,
            });
          }
        }
      }

      if (tc.supportingEvidence.trim().length < 12 && !tc.expectedSourceDocument) {
        errors.push({
          testCaseId: cleanId,
          field: 'supportingEvidence',
          severity: 'error',
          message: `${cleanId}: supportingEvidence is required for answerable cases.`,
        });
      }
    } else if (tc.category === 'out_of_scope') {
      if (!tc.expectedRefusal) {
        errors.push({
          testCaseId: cleanId,
          field: 'expectedRefusal',
          severity: 'error',
          message: `${cleanId}: out_of_scope test cases must have expectedRefusal set to true.`,
        });
      }
      if (tc.supportingEvidence.trim().length < 8) {
        warnings.push({
          testCaseId: cleanId,
          field: 'supportingEvidence',
          severity: 'warning',
          message: `${cleanId}: add a brief note on which scope rule or missing topic triggers the refusal.`,
        });
      }
    } else if (tc.category === 'edge_case') {
      if (tc.expectedSourceDocument) {
        const matchedDoc = findBestMatchedDocument(
          tc.expectedSourceDocument,
          extractedDocs
        );
        if (!matchedDoc) {
          errors.push({
            testCaseId: cleanId,
            field: 'expectedSourceDocument',
            severity: 'error',
            message: `${cleanId}: cited document "${tc.expectedSourceDocument}" is not an uploaded parsed document.`,
          });
        } else if (tc.supportingEvidence.trim().length >= 12) {
          const grounding = checkGroundingOverlap(tc, matchedDoc);
          if (!grounding.grounded) {
            warnings.push({
              testCaseId: cleanId,
              field: 'supportingEvidence',
              severity: 'warning',
              message: `${cleanId}: double-check supportingEvidence wording against "${matchedDoc.documentName}".`,
            });
          }
        }
      }
      if (!tc.expectedRefusal && tc.expectedKeyFacts.length === 0) {
        warnings.push({
          testCaseId: cleanId,
          field: 'expectedKeyFacts',
          severity: 'warning',
          message: `${cleanId}: non-refusal edge case has no expectedKeyFacts listed.`,
        });
      }
    }
  }

  // Category coverage checks
  const categories: EvaluationCategory[] = ['answerable', 'out_of_scope', 'edge_case'];
  for (const cat of categories) {
    if (byCategory[cat] === 0) {
      errors.push({
        field: 'categories',
        severity: 'error',
        message: `At least one "${cat}" test case is required for balanced evaluation.`,
      });
    } else if (byCategory[cat] < 3) {
      warnings.push({
        field: 'categories',
        severity: 'warning',
        message: `Category "${cat}" currently has only ${byCategory[cat]} test case(s); 4+ is recommended.`,
      });
    }
  }

  // Difficulty distribution check
  if (byDifficulty.easy === 0 || byDifficulty.medium === 0 || byDifficulty.hard === 0) {
    warnings.push({
      field: 'difficulty',
      severity: 'warning',
      message: 'Include easy, medium, and hard test cases for well-rounded difficulty coverage.',
    });
  }

  // Duplicate / near-duplicate question detection
  for (let i = 0; i < testCases.length; i += 1) {
    const qA = normalizeText(testCases[i].question);
    if (!qA) continue;
    for (let j = i + 1; j < testCases.length; j += 1) {
      const qB = normalizeText(testCases[j].question);
      if (!qB) continue;
      const isExact = qA === qB;
      const similarity = isExact ? 1 : jaccardSimilarity(qA, qB);
      if (isExact || similarity >= 0.78) {
        duplicatePairs += 1;
        errors.push({
          testCaseId: testCases[j].id,
          field: 'question',
          severity: 'error',
          message: `${testCases[j].id} is a ${isExact ? 'duplicate' : 'near-duplicate'} of ${testCases[i].id}. Edit or regenerate to keep test cases distinct.`,
        });
      }
    }
  }

  if (project.documents.length > 0 && extractedDocs.length === 0) {
    warnings.push({
      field: 'documents',
      severity: 'warning',
      message: 'No readable parsed text documents are available on disk for grounding verification.',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    checkedAt: new Date().toISOString(),
    stats: {
      total: testCases.length,
      byCategory,
      byDifficulty,
      duplicatePairs,
    },
  };
}

const DOCUMENT_ANALYSIS_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    verifiedFacts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          fact: { type: Type.STRING },
          sourceDocument: { type: Type.STRING },
          supportingSnippet: { type: Type.STRING },
        },
        required: ['fact', 'sourceDocument', 'supportingSnippet'],
      },
    },
    ambiguitiesOrConflicts: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    knowledgeGaps: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: ['summary', 'verifiedFacts', 'ambiguitiesOrConflicts', 'knowledgeGaps'],
};

const TEST_CASE_ARRAY_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    testCases: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          question: { type: Type.STRING },
          category: { type: Type.STRING },
          difficulty: { type: Type.STRING },
          expectedBehavior: { type: Type.STRING },
          expectedKeyFacts: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          expectedSourceDocument: { type: Type.STRING },
          supportingEvidence: { type: Type.STRING },
          expectedRefusal: { type: Type.BOOLEAN },
          reason: { type: Type.STRING },
        },
        required: [
          'question',
          'category',
          'difficulty',
          'expectedBehavior',
          'expectedKeyFacts',
          'supportingEvidence',
          'expectedRefusal',
          'reason',
        ],
      },
    },
  },
  required: ['testCases'],
};

const SINGLE_TEST_CASE_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    testCase: {
      type: Type.OBJECT,
      properties: {
        question: { type: Type.STRING },
        category: { type: Type.STRING },
        difficulty: { type: Type.STRING },
        expectedBehavior: { type: Type.STRING },
        expectedKeyFacts: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        expectedSourceDocument: { type: Type.STRING },
        supportingEvidence: { type: Type.STRING },
        expectedRefusal: { type: Type.BOOLEAN },
        reason: { type: Type.STRING },
      },
      required: [
        'question',
        'category',
        'difficulty',
        'expectedBehavior',
        'expectedKeyFacts',
        'supportingEvidence',
        'expectedRefusal',
        'reason',
      ],
    },
  },
  required: ['testCase'],
};

const AI_AUDIT_SCHEMA: Record<string, unknown> = {
  type: Type.OBJECT,
  properties: {
    flaggedCases: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          testCaseId: { type: Type.STRING },
          severity: { type: Type.STRING },
          field: { type: Type.STRING },
          message: { type: Type.STRING },
        },
        required: ['testCaseId', 'severity', 'field', 'message'],
      },
    },
  },
  required: ['flaggedCases'],
};

export async function generateEvaluationDataset(
  project: AgentProject,
  extractedDocs: StoredExtractedDocument[]
): Promise<{
  savedAgentVersion: AgentVersionRecord;
  documentAnalysisSummary: string;
  testCases: EvaluationTestCase[];
  validation: EvaluationValidationResult;
}> {
  const { savedAgentVersion } = assertEvaluationPrerequisites(
    project,
    extractedDocs,
    { requireDocuments: true }
  );

  const baseVars = buildPromptVariables(project, savedAgentVersion, extractedDocs);

  // Step 1: Document Analysis Prompt
  const analysisPrompt = renderPromptTemplate(
    DOCUMENT_ANALYSIS_PROMPT_TEMPLATE,
    baseVars
  );
  const analysisRaw = await generateStructuredJson(
    analysisPrompt,
    'You are a meticulous AI evaluation analyst. Extract strictly grounded facts from the documents without fabricating anything.',
    DOCUMENT_ANALYSIS_SCHEMA
  );
  const analysisParsed = JSON.parse(analysisRaw) as DocumentAnalysisResult;
  const documentAnalysisJson = JSON.stringify(analysisParsed, null, 2);

  // Step 2A: Generate 9 Answerable Cases
  const answerablePrompt = renderPromptTemplate(
    ANSWERABLE_GENERATION_PROMPT_TEMPLATE,
    {
      ...baseVars,
      COUNT: '9',
      DOCUMENT_ANALYSIS_JSON: documentAnalysisJson,
    }
  );
  const answerableRaw = await generateStructuredJson(
    answerablePrompt,
    'Generate strictly document-grounded answerable evaluation test cases as JSON.',
    TEST_CASE_ARRAY_SCHEMA
  );
  const answerableParsed = JSON.parse(answerableRaw) as {
    testCases?: Array<Record<string, unknown>>;
  };

  // Step 2B: Generate 7 Out-of-Scope / Refusal Cases
  const refusalPrompt = renderPromptTemplate(
    REFUSAL_GENERATION_PROMPT_TEMPLATE,
    {
      ...baseVars,
      COUNT: '7',
      DOCUMENT_ANALYSIS_JSON: documentAnalysisJson,
    }
  );
  const refusalRaw = await generateStructuredJson(
    refusalPrompt,
    'Generate out-of-scope and refusal evaluation test cases as JSON.',
    TEST_CASE_ARRAY_SCHEMA
  );
  const refusalParsed = JSON.parse(refusalRaw) as {
    testCases?: Array<Record<string, unknown>>;
  };

  // Step 2C: Generate 6 Edge Cases (total 22 cases >= 20 minimum)
  const edgePrompt = renderPromptTemplate(EDGE_CASE_GENERATION_PROMPT_TEMPLATE, {
    ...baseVars,
    COUNT: '6',
    DOCUMENT_ANALYSIS_JSON: documentAnalysisJson,
  });
  const edgeRaw = await generateStructuredJson(
    edgePrompt,
    'Generate challenging edge-case evaluation test cases as JSON.',
    TEST_CASE_ARRAY_SCHEMA
  );
  const edgeParsed = JSON.parse(edgeRaw) as {
    testCases?: Array<Record<string, unknown>>;
  };

  const combined: EvaluationTestCase[] = [];
  const appendCategory = (
    items: Array<Record<string, unknown>> | undefined,
    category: EvaluationCategory
  ) => {
    for (const item of items ?? []) {
      const nextId = `TC-${String(combined.length + 1).padStart(3, '0')}`;
      const normalized = sanitizeRawTestCase(item, nextId, extractedDocs, category);
      // Avoid exact duplicate questions across batches
      const isDup = combined.some(
        (existing) =>
          normalizeText(existing.question) === normalizeText(normalized.question)
      );
      if (!isDup && normalized.question.length > 0) {
        combined.push(normalized);
      }
    }
  };

  appendCategory(answerableParsed.testCases, 'answerable');
  appendCategory(refusalParsed.testCases, 'out_of_scope');
  appendCategory(edgeParsed.testCases, 'edge_case');

  // Re-index deterministically TC-001 .. TC-NNN
  const indexed = combined.map((tc, index) => ({
    ...tc,
    id: `TC-${String(index + 1).padStart(3, '0')}`,
  }));

  const validation = validateEvaluationTestCases(project, extractedDocs, indexed);

  return {
    savedAgentVersion,
    documentAnalysisSummary: analysisParsed.summary || '',
    testCases: indexed,
    validation,
  };
}

export async function regenerateSingleTestCase(
  project: AgentProject,
  extractedDocs: StoredExtractedDocument[],
  existingCases: EvaluationTestCase[],
  targetCase: EvaluationTestCase,
  instruction?: string
): Promise<EvaluationTestCase> {
  const { savedAgentVersion } = assertEvaluationPrerequisites(
    project,
    extractedDocs,
    { requireDocuments: targetCase.category === 'answerable' }
  );

  const baseVars = buildPromptVariables(project, savedAgentVersion, extractedDocs);
  const existingQuestions = existingCases
    .filter((tc) => tc.id !== targetCase.id)
    .map((tc) => `- [${tc.id} | ${tc.category}] ${tc.question}`)
    .join('\n');

  const extraInstruction = [
    `TASK: Replace test case ${targetCase.id} with ONE brand-new, high-quality test case in category "${targetCase.category}".`,
    instruction?.trim()
      ? `USER REGENERATION INSTRUCTION: ${instruction.trim()}`
      : 'Make the new test case clearer, strictly grounded in the documents (if answerable), and non-overlapping with the existing questions below.',
    `DO NOT REPEAT OR CLOSELY PARAPHRASE ANY EXISTING QUESTION:\n${existingQuestions || 'None'}`,
  ].join('\n\n');

  const prompt = renderPromptTemplate(TEST_CASE_VALIDATION_PROMPT_TEMPLATE, {
    ...baseVars,
    CANDIDATE_CASES_JSON: JSON.stringify(targetCase, null, 2),
    EXTRA_INSTRUCTION: extraInstruction,
  });

  const raw = await generateStructuredJson(
    prompt,
    `Generate one replacement "${targetCase.category}" evaluation test case as JSON.`,
    SINGLE_TEST_CASE_SCHEMA
  );
  const parsed = JSON.parse(raw) as { testCase?: Record<string, unknown> };
  const candidate = parsed.testCase ?? {};

  return sanitizeRawTestCase(
    candidate,
    targetCase.id,
    extractedDocs,
    targetCase.category
  );
}

export async function auditEvaluationSetWithGemini(
  project: AgentProject,
  extractedDocs: StoredExtractedDocument[],
  testCases: EvaluationTestCase[]
): Promise<EvaluationValidationIssue[]> {
  const { savedAgentVersion } = assertEvaluationPrerequisites(project, extractedDocs);
  const baseVars = buildPromptVariables(project, savedAgentVersion, extractedDocs);

  const compactCases = testCases.map((tc) => ({
    id: tc.id,
    category: tc.category,
    difficulty: tc.difficulty,
    question: tc.question,
    expectedRefusal: tc.expectedRefusal,
    expectedSourceDocument: tc.expectedSourceDocument,
    supportingEvidence: tc.supportingEvidence,
    expectedKeyFacts: tc.expectedKeyFacts,
  }));

  const prompt = renderPromptTemplate(TEST_CASE_VALIDATION_PROMPT_TEMPLATE, {
    ...baseVars,
    CANDIDATE_CASES_JSON: JSON.stringify(compactCases, null, 2),
    EXTRA_INSTRUCTION:
      'Audit all candidate cases above. Return ONLY genuine errors or warnings in flaggedCases (use empty array if everything looks grounded and accurate).',
  });

  const raw = await generateStructuredJson(
    prompt,
    'Audit evaluation test cases for grounding accuracy, category alignment, and clarity.',
    AI_AUDIT_SCHEMA
  );
  const parsed = JSON.parse(raw) as {
    flaggedCases?: Array<{
      testCaseId?: string;
      severity?: string;
      field?: string;
      message?: string;
    }>;
  };

  const validIds = new Set(testCases.map((tc) => tc.id));
  const issues: EvaluationValidationIssue[] = [];

  for (const item of parsed.flaggedCases ?? []) {
    const message = typeof item.message === 'string' ? item.message.trim() : '';
    if (!message) continue;
    const testCaseId =
      typeof item.testCaseId === 'string' && validIds.has(item.testCaseId.trim())
        ? item.testCaseId.trim()
        : undefined;
    const severity: 'error' | 'warning' =
      item.severity === 'error' ? 'error' : 'warning';
    const field =
      typeof item.field === 'string' && item.field.trim().length > 0
        ? item.field.trim()
        : 'grounding';

    issues.push({
      testCaseId,
      field,
      severity,
      message: testCaseId ? `[AI Audit · ${testCaseId}] ${message}` : `[AI Audit] ${message}`,
    });
  }

  return issues;
}

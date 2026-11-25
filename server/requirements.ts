import { Type } from '@google/genai';
import { getGeminiClient } from './gemini.ts';
import type {
  AgentProject,
  AgentRequirements,
  ClarificationAnswer,
  ClarificationQuestion,
  GroundabilityCheckItem,
  GroundabilityStatus,
  StoredExtractedDocument,
} from './types.ts';

const PRIMARY_MODEL = 'gemini-4-hydrogen';
const SECONDARY_MODEL = 'gemini-3.1-flash-lite';
const MAX_QUESTIONS = 5;
const MAX_DOC_CHARS_PER_FILE = 6000;
const MAX_TOTAL_DOC_CHARS = 24000;

function isTransientGeminiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    message.includes('503') ||
    message.includes('429') ||
    message.includes('UNAVAILABLE') ||
    message.includes('RESOURCE_EXHAUSTED') ||
    message.toLowerCase().includes('high demand')
  );
}

function summarizeGeminiError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  try {
    const parsed = JSON.parse(raw) as {
      error?: { code?: number; status?: string; message?: string };
    };
    if (parsed?.error?.message) {
      return `${parsed.error.code ?? ''} ${parsed.error.status ?? ''}: ${parsed.error.message}`.trim();
    }
  } catch {
    // ignore non-JSON raw error
  }
  return raw;
}

function formatGeminiError(error: unknown, fallbackMessage: string): Error {
  const summary = summarizeGeminiError(error);
  if (isTransientGeminiError(error)) {
    return new Error(
      `Gemini API temporarily unavailable (${summary || 'high demand'}). Please retry in a few seconds.`
    );
  }
  return new Error(summary || fallbackMessage);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateStructuredJson(
  prompt: string,
  systemInstruction: string,
  responseSchema: Record<string, unknown>
): Promise<string> {
  const ai = getGeminiClient();
  const attempts: Array<{ model: string; delayMs: number }> = [
    { model: PRIMARY_MODEL, delayMs: 0 },
    { model: PRIMARY_MODEL, delayMs: 2000 },
    { model: SECONDARY_MODEL, delayMs: 1000 },
    { model: PRIMARY_MODEL, delayMs: 3000 },
  ];

  let firstTransientError: unknown;
  let lastError: unknown;
  for (const attempt of attempts) {
    if (attempt.delayMs > 0) {
      await sleep(attempt.delayMs);
    }
    try {
      const response = await ai.models.generateContent({
        model: attempt.model,
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema,
        },
      });
      const rawText = (response.text ?? '').trim();
      if (!rawText) {
        throw new Error('Gemini returned an empty JSON response.');
      }
      return rawText;
    } catch (error) {
      lastError = error;
      if (!firstTransientError && isTransientGeminiError(error)) {
        firstTransientError = error;
      }
      console.warn(`[ForgeAI] Gemini attempt failed (${attempt.model}):`, summarizeGeminiError(error));
      if (!isTransientGeminiError(error)) {
        throw formatGeminiError(error, 'Gemini request failed.');
      }
    }
  }

  throw formatGeminiError(
    firstTransientError ?? lastError,
    'Gemini request failed after retries.'
  );
}

function formatDocumentsContext(extractedDocs: StoredExtractedDocument[]): string {
  if (extractedDocs.length === 0) {
    return 'NO READABLE KNOWLEDGE DOCUMENTS WERE UPLOADED FOR THIS PROJECT.';
  }

  let totalChars = 0;
  const sections: string[] = [];

  for (const doc of extractedDocs) {
    if (totalChars >= MAX_TOTAL_DOC_CHARS) {
      sections.push(
        `Document: ${doc.documentName} (${doc.fileType.toUpperCase()}) — omitted from excerpt due to context budget.`
      );
      continue;
    }

    const remainingBudget = Math.min(
      MAX_DOC_CHARS_PER_FILE,
      MAX_TOTAL_DOC_CHARS - totalChars
    );
    const snippet = doc.extractedText.slice(0, remainingBudget);
    totalChars += snippet.length;

    const metaParts: string[] = [`Type: ${doc.fileType.toUpperCase()}`];
    if (doc.csvHeaders && doc.csvHeaders.length > 0) {
      metaParts.push(`CSV Columns: ${doc.csvHeaders.join(', ')}`);
      metaParts.push(`CSV Rows: ${doc.csvRowCount ?? 0}`);
    }

    sections.push(
      `--- DOCUMENT: ${doc.documentName} (${metaParts.join(' | ')}) ---\n${snippet}`
    );
  }

  return sections.join('\n\n');
}

function sanitizeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function normalizeGroundabilityStatus(value: unknown): GroundabilityStatus {
  if (value === 'Supported') return 'Supported';
  if (value === 'Partially Supported') return 'Partially Supported';
  return 'Unsupported';
}

export async function generateClarificationQuestions(
  project: AgentProject,
  extractedDocs: StoredExtractedDocument[]
): Promise<{
  analysisSummary: string;
  questions: ClarificationQuestion[];
}> {
  const docsContext = formatDocumentsContext(extractedDocs);

  const prompt = `
You are the ForgeAI Intake Interviewer. Analyze the user's initial agent request and uploaded knowledge documents to decide which clarification questions (at most ${MAX_QUESTIONS}) are genuinely needed before writing a complete agent specification.

PROJECT INPUTS:
- Agent Name: ${project.name}
- Domain: ${project.domain}
- Target Audience: ${project.targetAudience || 'Not specified'}
- Desired Response Tone: ${project.responseTone || 'Not specified'}
- Project Purpose / Brief:
${project.brief}

UPLOADED KNOWLEDGE DOCUMENTS:
${docsContext}

STRICT RULES:
1. Ask ONLY questions that are genuinely necessary to resolve missing or ambiguous requirements (e.g., escalation rules, handling missing facts, tool/output expectations, edge cases, or discrepancies between the brief and documents).
2. NEVER ask for information already clearly provided in the Agent Name, Target Audience, Desired Response Tone, or Project Brief.
3. Ask AT MOST ${MAX_QUESTIONS} questions. If fewer questions (such as 1, 2, or 3) are enough, return fewer. If the brief and documents are already completely clear, return 0 questions.
4. Keep each question concise, plain-language, and specific to this project.
5. For each question, provide a brief 1-sentence rationale explaining why the answer affects the agent specification.
`;

  const rawText = await generateStructuredJson(
    prompt,
    'You are a careful Generative AI systems analyst. Return strictly valid JSON matching the schema. Do not invent facts about uploaded documents.',
    {
      type: Type.OBJECT,
      properties: {
        analysisSummary: {
          type: Type.STRING,
          description:
            'Brief 1-2 sentence summary of what is already clear vs what needs clarification.',
        },
        questions: {
          type: Type.ARRAY,
          description:
            'Between 0 and 5 genuinely necessary clarification questions.',
          items: {
            type: Type.OBJECT,
            properties: {
              question: {
                type: Type.STRING,
                description: 'A single clear question to ask the user.',
              },
              rationale: {
                type: Type.STRING,
                description: 'Why this clarification is needed.',
              },
              suggestedFocus: {
                type: Type.STRING,
                description:
                  'Optional short hint of what kind of detail helps (under 12 words).',
              },
            },
            required: ['question', 'rationale'],
          },
        },
      },
      required: ['analysisSummary', 'questions'],
    }
  );

  let parsed: {
    analysisSummary?: unknown;
    questions?: Array<{
      question?: unknown;
      rationale?: unknown;
      suggestedFocus?: unknown;
    }>;
  };

  try {
    parsed = JSON.parse(rawText) as typeof parsed;
  } catch {
    throw new Error('Failed to parse clarification questions JSON from Gemini.');
  }

  const analysisSummary = sanitizeString(
    parsed.analysisSummary,
    'Initial brief analyzed.'
  );

  const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : [];
  const questions: ClarificationQuestion[] = rawQuestions
    .slice(0, MAX_QUESTIONS)
    .map((item, idx) => ({
      id: `q-${idx + 1}`,
      question: sanitizeString(item?.question),
      rationale: sanitizeString(item?.rationale),
      suggestedFocus: sanitizeString(item?.suggestedFocus) || undefined,
    }))
    .filter((item) => item.question.length > 0);

  return {
    analysisSummary,
    questions,
  };
}

export async function generateStructuredRequirementsAndGroundability(
  project: AgentProject,
  extractedDocs: StoredExtractedDocument[],
  answers: ClarificationAnswer[]
): Promise<AgentRequirements> {
  const docsContext = formatDocumentsContext(extractedDocs);
  const validDocNames = new Set(extractedDocs.map((doc) => doc.documentName));
  const hasDocuments = extractedDocs.length > 0;

  const formattedInterview =
    answers.length === 0
      ? 'No clarification questions were asked or answered.'
      : answers
          .map((item, idx) => {
            const responseText = item.skipped
              ? '[SKIPPED BY USER]'
              : item.answer || '[NO ANSWER PROVIDED]';
            return `Q${idx + 1}: ${item.question}\nAnswer: ${responseText}`;
          })
          .join('\n\n');

  const prompt = `
You are the ForgeAI Requirements Engineer and Groundability Guard.
Using the user's project intake inputs, clarification interview answers, and the actual uploaded knowledge documents below, generate:
(A) A complete, structured 10-part Agent Requirements Specification.
(B) A strict Groundability Guard assessment comparing every requested capability/topic against the actual uploaded documents.

PROJECT INTAKE:
- Agent Name: ${project.name}
- Domain: ${project.domain}
- Target Audience: ${project.targetAudience || 'Not explicitly provided'}
- Desired Response Tone: ${project.responseTone || 'Not explicitly provided'}
- Initial Brief:
${project.brief}

CLARIFICATION INTERVIEW TRANSCRIPT:
${formattedInterview}

ACTUAL UPLOADED KNOWLEDGE DOCUMENTS (${extractedDocs.length} readable files):
${docsContext}

CRITICAL GROUNDABILITY GUARD RULES:
1. NEVER claim that a document supports information or capabilities that are NOT present in the actual uploaded document text above.
2. If NO documents were uploaded (0 readable files), then NO document-grounded capabilities are Supported — mark them as "Unsupported", explain that no documents were uploaded, and suggest a safer alternative (such as uploading the missing source file or restricting the agent to escalation/general guidance).
3. For each requested capability or topic in "groundability.checks":
   - Use status "Supported" ONLY if the uploaded document text clearly contains the needed information.
   - Use status "Partially Supported" if some relevant details exist in the documents, but key parts are missing or incomplete.
   - Use status "Unsupported" if the uploaded documents do not cover that requirement at all.
   - In "matchedDocuments", list ONLY exact filenames from the uploaded documents above that actually contain evidence. If none, return an empty array [].
   - Whenever status is "Partially Supported" or "Unsupported", provide a clear "unsupportedReason" explaining the gap and a practical "saferAlternative" (e.g., refuse & escalate, ask user to upload specific document, or narrow scope).
4. In "knowledgeSourcesAvailable", list only the actual uploaded document filenames (with a brief note of what each covers), or explicitly state "No knowledge documents uploaded" if none exist.
5. In "missingInformationOrAssumptions", list any skipped interview questions, unclear constraints, or knowledge gaps found.
`;

  const rawText = await generateStructuredJson(
    prompt,
    'You are a strict AI requirements and grounding auditor. Return strictly valid JSON matching the schema. Never fabricate document support.',
    {
      type: Type.OBJECT,
      properties: {
        agentName: { type: Type.STRING },
        agentPurpose: { type: Type.STRING },
        scope: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'What the agent should handle.',
        },
        targetAudience: { type: Type.STRING },
        responseToneAndStyle: { type: Type.STRING },
        mustAnswerTopics: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        mustRefuseTopics: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        knowledgeSourcesAvailable: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        outOfScopeTopics: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        missingInformationOrAssumptions: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        groundability: {
          type: Type.OBJECT,
          properties: {
            overallStatus: {
              type: Type.STRING,
              description:
                'One of: Supported, Partially Supported, Unsupported',
            },
            summary: { type: Type.STRING },
            checks: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  capability: { type: Type.STRING },
                  status: {
                    type: Type.STRING,
                    description:
                      'One of: Supported, Partially Supported, Unsupported',
                  },
                  evidenceSummary: { type: Type.STRING },
                  unsupportedReason: { type: Type.STRING },
                  saferAlternative: { type: Type.STRING },
                  matchedDocuments: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                },
                required: [
                  'capability',
                  'status',
                  'evidenceSummary',
                  'matchedDocuments',
                ],
              },
            },
          },
          required: ['overallStatus', 'summary', 'checks'],
        },
      },
      required: [
        'agentName',
        'agentPurpose',
        'scope',
        'targetAudience',
        'responseToneAndStyle',
        'mustAnswerTopics',
        'mustRefuseTopics',
        'knowledgeSourcesAvailable',
        'outOfScopeTopics',
        'missingInformationOrAssumptions',
        'groundability',
      ],
    }
  );

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    throw new Error('Failed to parse structured requirements JSON from Gemini.');
  }

  const rawGroundability =
    raw.groundability && typeof raw.groundability === 'object'
      ? (raw.groundability as Record<string, unknown>)
      : {};

  const rawChecks = Array.isArray(rawGroundability.checks)
    ? (rawGroundability.checks as Array<Record<string, unknown>>)
    : [];

  // Server-side Groundability Guard verification so unsupported claims cannot slip through
  const checks: GroundabilityCheckItem[] = rawChecks
    .map((item, idx): GroundabilityCheckItem | null => {
      const capability = sanitizeString(item?.capability);
      if (!capability) return null;

      let status = normalizeGroundabilityStatus(item?.status);
      let matchedDocuments = sanitizeStringArray(item?.matchedDocuments).filter(
        (docName) => validDocNames.has(docName)
      );
      let evidenceSummary = sanitizeString(
        item?.evidenceSummary,
        'Evaluated against uploaded documents.'
      );
      let unsupportedReason = sanitizeString(item?.unsupportedReason) || undefined;
      let saferAlternative = sanitizeString(item?.saferAlternative) || undefined;

      if (!hasDocuments) {
        status = 'Unsupported';
        matchedDocuments = [];
        evidenceSummary = 'No readable knowledge documents were uploaded.';
        unsupportedReason =
          unsupportedReason ||
          'No knowledge documents are available to verify or ground this capability.';
        saferAlternative =
          saferAlternative ||
          'Upload the relevant PDF, TXT, or CSV reference document, or restrict the agent to escalate this topic.';
      } else if (status === 'Supported' && matchedDocuments.length === 0) {
        status = 'Partially Supported';
        unsupportedReason =
          unsupportedReason ||
          'No specific uploaded document was matched with direct evidence for this requirement.';
        saferAlternative =
          saferAlternative ||
          'Review the uploaded documents or instruct the agent to escalate when exact policy details are absent.';
      }

      return {
        id: `check-${idx + 1}`,
        capability,
        status,
        evidenceSummary,
        unsupportedReason,
        saferAlternative,
        matchedDocuments,
      };
    })
    .filter((item): item is GroundabilityCheckItem => item !== null);

  if (checks.length === 0) {
    checks.push({
      id: 'check-1',
      capability: 'Document-grounded responses for project brief',
      status: hasDocuments ? 'Partially Supported' : 'Unsupported',
      evidenceSummary: hasDocuments
        ? 'Uploaded documents were scanned, but no explicit capability mapping was returned.'
        : 'No readable knowledge documents were uploaded.',
      unsupportedReason: hasDocuments
        ? 'Verify individual capabilities manually against your uploaded files.'
        : 'No knowledge documents are available to ground agent responses.',
      saferAlternative: hasDocuments
        ? undefined
        : 'Upload at least one PDF, TXT, or CSV document before deploying the agent.',
      matchedDocuments: [],
    });
  }

  let overallStatus: GroundabilityStatus = normalizeGroundabilityStatus(
    rawGroundability.overallStatus
  );
  if (!hasDocuments) {
    overallStatus = 'Unsupported';
  } else if (checks.every((c) => c.status === 'Supported')) {
    overallStatus = 'Supported';
  } else if (checks.every((c) => c.status === 'Unsupported')) {
    overallStatus = 'Unsupported';
  } else {
    overallStatus = 'Partially Supported';
  }

  const knowledgeSourcesAvailable = hasDocuments
    ? sanitizeStringArray(raw.knowledgeSourcesAvailable).length > 0
      ? sanitizeStringArray(raw.knowledgeSourcesAvailable)
      : extractedDocs.map((d) => `${d.documentName} (${d.fileType.toUpperCase()})`)
    : ['No readable knowledge documents uploaded'];

  const now = new Date().toISOString();

  return {
    agentName: sanitizeString(raw.agentName, project.name),
    agentPurpose: sanitizeString(raw.agentPurpose, project.brief),
    scope: sanitizeStringArray(raw.scope),
    targetAudience: sanitizeString(
      raw.targetAudience,
      project.targetAudience || 'General users'
    ),
    responseToneAndStyle: sanitizeString(
      raw.responseToneAndStyle,
      project.responseTone || 'Professional and concise'
    ),
    mustAnswerTopics: sanitizeStringArray(raw.mustAnswerTopics),
    mustRefuseTopics: sanitizeStringArray(raw.mustRefuseTopics),
    knowledgeSourcesAvailable,
    outOfScopeTopics: sanitizeStringArray(raw.outOfScopeTopics),
    missingInformationOrAssumptions: sanitizeStringArray(
      raw.missingInformationOrAssumptions
    ),
    groundability: {
      overallStatus,
      summary: hasDocuments
        ? sanitizeString(
            rawGroundability.summary,
            'Capabilities checked against uploaded project documents.'
          )
        : 'No readable knowledge documents were uploaded. Document-dependent capabilities cannot be grounded until reference files are added.',
      hasDocuments,
      checks,
    },
    approved: false,
    approvedAt: null,
    generatedAt: now,
    updatedAt: now,
  };
}

export function applyEditableRequirementsPatch(
  existing: AgentRequirements,
  patch: Partial<AgentRequirements>
): AgentRequirements {
  const agentName = sanitizeString(patch.agentName, existing.agentName);
  const agentPurpose = sanitizeString(patch.agentPurpose, existing.agentPurpose);

  if (agentName.length < 2) {
    throw new Error('Agent name must be at least 2 characters.');
  }
  if (agentPurpose.length < 10) {
    throw new Error('Agent purpose must be at least 10 characters.');
  }

  return {
    ...existing,
    agentName,
    agentPurpose,
    scope:
      patch.scope !== undefined
        ? sanitizeStringArray(patch.scope)
        : existing.scope,
    targetAudience: sanitizeString(
      patch.targetAudience,
      existing.targetAudience
    ),
    responseToneAndStyle: sanitizeString(
      patch.responseToneAndStyle,
      existing.responseToneAndStyle
    ),
    mustAnswerTopics:
      patch.mustAnswerTopics !== undefined
        ? sanitizeStringArray(patch.mustAnswerTopics)
        : existing.mustAnswerTopics,
    mustRefuseTopics:
      patch.mustRefuseTopics !== undefined
        ? sanitizeStringArray(patch.mustRefuseTopics)
        : existing.mustRefuseTopics,
    knowledgeSourcesAvailable:
      patch.knowledgeSourcesAvailable !== undefined
        ? sanitizeStringArray(patch.knowledgeSourcesAvailable)
        : existing.knowledgeSourcesAvailable,
    outOfScopeTopics:
      patch.outOfScopeTopics !== undefined
        ? sanitizeStringArray(patch.outOfScopeTopics)
        : existing.outOfScopeTopics,
    missingInformationOrAssumptions:
      patch.missingInformationOrAssumptions !== undefined
        ? sanitizeStringArray(patch.missingInformationOrAssumptions)
        : existing.missingInformationOrAssumptions,
    // Editing invalidates prior approval until user explicitly re-approves
    approved: false,
    approvedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

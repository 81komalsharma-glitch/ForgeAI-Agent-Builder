import { Type } from '@google/genai';
import { generateStructuredJson } from './gemini.ts';
import type {
  AgentDefinition,
  AgentKnowledgeConfig,
  AgentOutputContract,
  AgentProject,
  AgentSectionKey,
  AgentSystemPrompt,
  AgentToolDefinition,
  AgentValidationIssue,
  AgentValidationResult,
  StoredExtractedDocument,
} from './types.ts';

const ALLOWED_DOC_TYPES = new Set(['pdf', 'txt', 'csv']);

export const TOOL_REGISTRY: Omit<
  AgentToolDefinition,
  'selected' | 'selectionReason'
>[] = [
  {
    id: 'calculator',
    toolName: 'Calculator',
    description:
      'Evaluates deterministic arithmetic expressions (addition, subtraction, multiplication, division, percentages) without LLM math errors.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'Arithmetic expression to evaluate, e.g. "(1250 * 0.15) + 40".',
        },
      },
      required: ['expression'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string' },
        result: { type: 'number' },
      },
      required: ['expression', 'result'],
    },
    whenToUse:
      'Use when a user asks for exact numeric totals, percentages, fee calculations, or unit arithmetic.',
    whenNotToUse:
      'Do not use for qualitative policy explanations or when exact numbers are missing from the source documents.',
    requiresApiKey: false,
    implementationStatus: 'specification_only',
    implementationNote:
      'Declarative tool specification defined in Agent Builder; runtime invocation is not executed in this stage.',
  },
  {
    id: 'current_datetime',
    toolName: 'Current Date & Time',
    description:
      'Returns the current server UTC timestamp and formatted calendar date/time for deadline or schedule checks.',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'Optional IANA timezone string, e.g. "UTC" or "America/Los_Angeles".',
        },
      },
      required: [],
    },
    outputSchema: {
      type: 'object',
      properties: {
        isoTimestamp: { type: 'string' },
        formattedDate: { type: 'string' },
        timezone: { type: 'string' },
      },
      required: ['isoTimestamp', 'formattedDate', 'timezone'],
    },
    whenToUse:
      'Use when answering questions that depend on today’s date, upcoming deadlines, or current business hours.',
    whenNotToUse:
      'Do not use for static historical facts or timeless policy rules.',
    requiresApiKey: false,
    implementationStatus: 'specification_only',
    implementationNote:
      'Declarative tool specification defined in Agent Builder; runtime invocation is not executed in this stage.',
  },
  {
    id: 'csv_lookup',
    toolName: 'CSV Lookup',
    description:
      'Searches structured rows in uploaded project CSV files by column name and match value.',
    inputSchema: {
      type: 'object',
      properties: {
        documentName: {
          type: 'string',
          description: 'Exact filename of an uploaded CSV document in this project.',
        },
        column: {
          type: 'string',
          description: 'CSV column header to filter on.',
        },
        query: {
          type: 'string',
          description: 'Case-insensitive substring or exact value to match.',
        },
      },
      required: ['documentName', 'column', 'query'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        matchedRows: {
          type: 'array',
          items: { type: 'object' },
        },
        totalMatched: { type: 'number' },
      },
      required: ['matchedRows', 'totalMatched'],
    },
    whenToUse:
      'Use when looking up exact tabular records (e.g., office hours, pricing rows, contacts, SKUs) stored in uploaded CSV files.',
    whenNotToUse:
      'Do not use when no CSV files are uploaded for the project or when searching unstructured PDF/TXT prose.',
    requiresApiKey: false,
    implementationStatus: 'specification_only',
    implementationNote:
      'Declarative tool specification defined in Agent Builder; runtime invocation is not executed in this stage.',
  },
  {
    id: 'wikipedia_summary',
    toolName: 'Wikipedia Summary Lookup (Public API)',
    description:
      'Fetches a concise public encyclopedia summary via the keyless Wikipedia REST API for general background definitions.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Plain-text topic title to look up on Wikipedia.',
        },
      },
      required: ['topic'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        extract: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['title', 'extract', 'url'],
    },
    whenToUse:
      'Use only if the agent scope permits general public background definitions not covered in private internal documents.',
    whenNotToUse:
      'Do not use for private company/campus policies, confidential workflows, or when responses must rely strictly on uploaded documents.',
    requiresApiKey: false,
    implementationStatus: 'specification_only',
    implementationNote:
      'Declarative public API tool specification (no API key required); runtime invocation is not executed in this stage.',
  },
];

function sanitizeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function sanitizeNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

function buildApprovedRequirementsContext(
  project: AgentProject,
  extractedDocs: StoredExtractedDocument[]
): string {
  const reqs = project.requirements;
  if (!reqs) {
    throw new Error('Requirements have not been generated for this project.');
  }

  const docSummary =
    project.documents.length === 0
      ? 'No documents uploaded (0 files).'
      : project.documents
          .map((doc) => {
            const extra =
              doc.fileType === 'csv' && doc.csvHeaders
                ? ` | CSV columns: ${doc.csvHeaders.join(', ')} (${doc.csvRowCount ?? 0} rows)`
                : '';
            return `- ${doc.originalName} (${doc.fileType.toUpperCase()}, status: ${doc.parseStatus}${extra})`;
          })
          .join('\n');

  const excerptSummary =
    extractedDocs.length === 0
      ? 'No readable extracted text available.'
      : extractedDocs
          .map(
            (doc) =>
              `[${doc.documentName} (${doc.fileType.toUpperCase()})]: ${doc.extractedText.slice(0, 900)}`
          )
          .join('\n\n');

  const groundabilitySummary = reqs.groundability.checks
    .map(
      (c) =>
        `- [${c.status}] ${c.capability} | Evidence: ${c.evidenceSummary}${
          c.unsupportedReason ? ` | Gap: ${c.unsupportedReason}` : ''
        }${c.saferAlternative ? ` | Safer alternative: ${c.saferAlternative}` : ''}`
    )
    .join('\n');

  return `
PROJECT DETAILS:
- Project Name: ${project.name}
- Domain: ${project.domain}
- Original Brief: ${project.brief}

APPROVED REQUIREMENTS SPECIFICATION:
1. Agent Name: ${reqs.agentName}
2. Agent Purpose: ${reqs.agentPurpose}
3. Scope: ${reqs.scope.join('; ')}
4. Target Audience: ${reqs.targetAudience}
5. Response Tone and Style: ${reqs.responseToneAndStyle}
6. Must-Answer Topics: ${reqs.mustAnswerTopics.join('; ')}
7. Must-Refuse Topics: ${reqs.mustRefuseTopics.join('; ')}
8. Knowledge Sources Available: ${reqs.knowledgeSourcesAvailable.join('; ')}
9. Out-of-Scope Topics: ${reqs.outOfScopeTopics.join('; ')}
10. Missing Information or Assumptions: ${reqs.missingInformationOrAssumptions.join('; ')}

GROUNDABILITY REPORT (Overall: ${reqs.groundability.overallStatus}, Has Documents: ${reqs.groundability.hasDocuments}):
${groundabilitySummary}

UPLOADED PROJECT DOCUMENTS:
${docSummary}

DOCUMENT EXCERPTS:
${excerptSummary}
`;
}

function buildRegistryContext(): string {
  return TOOL_REGISTRY.map(
    (t) =>
      `- id: "${t.id}" | name: "${t.toolName}" | requiresApiKey: ${t.requiresApiKey}\n` +
      `  description: ${t.description}\n` +
      `  defaultWhenToUse: ${t.whenToUse}\n` +
      `  defaultWhenNotToUse: ${t.whenNotToUse}`
  ).join('\n');
}

const SYSTEM_PROMPT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    agentRoleAndIdentity: { type: Type.STRING },
    mainObjective: { type: Type.STRING },
    scopeAndResponsibilities: { type: Type.ARRAY, items: { type: Type.STRING } },
    knowledgeDocumentInstructions: { type: Type.STRING },
    answeringRules: { type: Type.ARRAY, items: { type: Type.STRING } },
    mustAnswerTopics: { type: Type.ARRAY, items: { type: Type.STRING } },
    mustRefuseTopics: { type: Type.ARRAY, items: { type: Type.STRING } },
    missingInformationHandling: { type: Type.STRING },
    groundingAndCitationRules: { type: Type.STRING },
    responseToneAndStyle: { type: Type.STRING },
  },
  required: [
    'agentRoleAndIdentity',
    'mainObjective',
    'scopeAndResponsibilities',
    'knowledgeDocumentInstructions',
    'answeringRules',
    'mustAnswerTopics',
    'mustRefuseTopics',
    'missingInformationHandling',
    'groundingAndCitationRules',
    'responseToneAndStyle',
  ],
};

const KNOWLEDGE_CONFIG_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    supportedDocumentTypes: { type: Type.ARRAY, items: { type: Type.STRING } },
    chunkingStrategy: { type: Type.STRING },
    chunkSize: { type: Type.INTEGER },
    chunkOverlap: { type: Type.INTEGER },
    retrievalMethod: { type: Type.STRING },
    topK: { type: Type.INTEGER },
    similarityThreshold: { type: Type.NUMBER },
    sourceCitationRequirements: { type: Type.STRING },
    rationale: { type: Type.STRING },
  },
  required: [
    'supportedDocumentTypes',
    'chunkingStrategy',
    'chunkSize',
    'chunkOverlap',
    'retrievalMethod',
    'topK',
    'similarityThreshold',
    'sourceCitationRequirements',
    'rationale',
  ],
};

const TOOLS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    selections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          selected: { type: Type.BOOLEAN },
          selectionReason: { type: Type.STRING },
          whenToUse: { type: Type.STRING },
          whenNotToUse: { type: Type.STRING },
        },
        required: ['id', 'selected', 'selectionReason', 'whenToUse', 'whenNotToUse'],
      },
    },
  },
  required: ['selections'],
};

const OUTPUT_CONTRACT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    requiredResponseStructure: { type: Type.ARRAY, items: { type: Type.STRING } },
    expectedOutputFormat: { type: Type.STRING },
    citationFormat: { type: Type.STRING },
    refusalFormat: { type: Type.STRING },
    errorHandlingRules: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: [
    'requiredResponseStructure',
    'expectedOutputFormat',
    'citationFormat',
    'refusalFormat',
    'errorHandlingRules',
  ],
};

function normalizeSystemPrompt(
  raw: Record<string, unknown> | undefined,
  project: AgentProject
): AgentSystemPrompt {
  const reqs = project.requirements;
  return {
    agentRoleAndIdentity: sanitizeString(
      raw?.agentRoleAndIdentity,
      `You are ${reqs?.agentName || project.name}, an assistant for ${reqs?.targetAudience || 'users'}.`
    ),
    mainObjective: sanitizeString(raw?.mainObjective, reqs?.agentPurpose || project.brief),
    scopeAndResponsibilities: sanitizeStringArray(raw?.scopeAndResponsibilities),
    knowledgeDocumentInstructions: sanitizeString(raw?.knowledgeDocumentInstructions),
    answeringRules: sanitizeStringArray(raw?.answeringRules),
    mustAnswerTopics: sanitizeStringArray(raw?.mustAnswerTopics),
    mustRefuseTopics: sanitizeStringArray(raw?.mustRefuseTopics),
    missingInformationHandling: sanitizeString(raw?.missingInformationHandling),
    groundingAndCitationRules: sanitizeString(raw?.groundingAndCitationRules),
    responseToneAndStyle: sanitizeString(
      raw?.responseToneAndStyle,
      reqs?.responseToneAndStyle || project.responseTone || 'Professional and concise'
    ),
  };
}

function normalizeKnowledgeConfig(
  raw: Record<string, unknown> | undefined,
  project: AgentProject
): AgentKnowledgeConfig {
  const uploadedTypes = Array.from(
    new Set(project.documents.filter((d) => d.parseStatus === 'parsed').map((d) => d.fileType))
  );
  const candidateTypes = sanitizeStringArray(raw?.supportedDocumentTypes).map((t) =>
    t.toLowerCase()
  );
  const validTypes = candidateTypes.filter((t) => ALLOWED_DOC_TYPES.has(t));

  const chunkSize = Math.round(sanitizeNumber(raw?.chunkSize, 800));
  const chunkOverlap = Math.round(sanitizeNumber(raw?.chunkOverlap, 120));
  const topK = Math.round(sanitizeNumber(raw?.topK, 5));
  const similarityThreshold = Number(
    sanitizeNumber(raw?.similarityThreshold, 0.35).toFixed(2)
  );

  return {
    supportedDocumentTypes:
      validTypes.length > 0
        ? Array.from(new Set(validTypes))
        : uploadedTypes.length > 0
          ? uploadedTypes
          : ['pdf', 'txt', 'csv'],
    chunkingStrategy: sanitizeString(raw?.chunkingStrategy, 'recursive_section_and_csv_row'),
    chunkSize,
    chunkOverlap,
    retrievalMethod: sanitizeString(raw?.retrievalMethod, 'hybrid_lexical_and_semantic'),
    topK,
    similarityThreshold,
    sourceCitationRequirements: sanitizeString(
      raw?.sourceCitationRequirements,
      'Cite exact uploaded filename for every factual statement.'
    ),
    rationale: sanitizeString(
      raw?.rationale,
      'Balanced chunk size and top-K settings preserve policy context without exceeding prompt limits.'
    ),
    implementationStatus: 'declarative_config_only',
    implementationNote:
      'Declarative retrieval settings generated for downstream evaluation and runtime wiring; active vector indexing is not executed in Agent Builder.',
  };
}

function normalizeToolsFromSelections(
  raw: Record<string, unknown> | undefined,
  project: AgentProject
): AgentToolDefinition[] {
  const selections = Array.isArray(raw?.selections)
    ? (raw.selections as Array<Record<string, unknown>>)
    : [];
  const hasCsv = project.documents.some(
    (d) => d.fileType === 'csv' && d.parseStatus === 'parsed'
  );

  return TOOL_REGISTRY.map((entry) => {
    const match = selections.find((s) => sanitizeString(s?.id) === entry.id);
    let selected = Boolean(match?.selected);
    let selectionReason = sanitizeString(
      match?.selectionReason,
      selected
        ? 'Selected based on approved requirements.'
        : 'Not required for the approved requirements.'
    );

    if (entry.id === 'csv_lookup' && !hasCsv && selected) {
      selected = false;
      selectionReason =
        'Deselected automatically because no parsed CSV files are uploaded for this project.';
    }

    return {
      ...entry,
      whenToUse: sanitizeString(match?.whenToUse, entry.whenToUse),
      whenNotToUse: sanitizeString(match?.whenNotToUse, entry.whenNotToUse),
      selected,
      selectionReason,
    };
  });
}

function normalizeOutputContract(
  raw: Record<string, unknown> | undefined
): AgentOutputContract {
  return {
    requiredResponseStructure: sanitizeStringArray(raw?.requiredResponseStructure),
    expectedOutputFormat: sanitizeString(
      raw?.expectedOutputFormat,
      'Structured Markdown prose with concise bullet points.'
    ),
    citationFormat: sanitizeString(raw?.citationFormat, '[Source: <filename>]'),
    refusalFormat: sanitizeString(
      raw?.refusalFormat,
      'Clearly state what cannot be answered from the available sources and provide the approved escalation path.'
    ),
    errorHandlingRules: sanitizeStringArray(raw?.errorHandlingRules),
  };
}

export async function generateFullAgentDefinition(
  project: AgentProject,
  extractedDocs: StoredExtractedDocument[]
): Promise<AgentDefinition> {
  if (!project.requirements?.approved) {
    throw new Error('Requirements must be approved before generating an agent definition.');
  }

  const context = buildApprovedRequirementsContext(project, extractedDocs);
  const registryContext = buildRegistryContext();

  const prompt = `
You are the ForgeAI Agent Architect. Convert the approved requirements specification and project knowledge documents into a complete, declarative JSON agent definition.

${context}

AVAILABLE TOOL REGISTRY (3-4 approved tools — select ONLY tools genuinely relevant to the approved requirements):
${registryContext}

STRICT ARCHITECTURAL RULES:
1. Follow the approved requirements strictly. Every must-refuse topic and out-of-scope boundary must be respected.
2. NEVER mark or describe an "Unsupported" capability from the Groundability Report as supported by documents. Instruct the agent to refuse or escalate ungrounded requests.
3. If 0 readable documents are uploaded, explicitly state in knowledgeDocumentInstructions and missingInformationHandling that no knowledge files are available yet and document-grounded claims must be refused/escalated.
4. For Knowledge Configuration, select sensible defaults (e.g., chunkSize 600-1000, chunkOverlap 100-150, topK 3-6, similarityThreshold 0.30-0.55) and explain the rationale in plain language without claiming vector search is already running.
5. For Tools, evaluate each tool id in the registry ("calculator", "current_datetime", "csv_lookup", "wikipedia_summary"). Only set selected=true when genuinely helpful for the approved requirements, and NEVER select "csv_lookup" if no CSV file is uploaded.
6. Return strictly valid JSON matching the schema.
`;

  const rawText = await generateStructuredJson(
    prompt,
    'You are a careful Generative AI Agent Architect. Return strictly valid JSON matching the schema. Never fabricate grounding or tool availability.',
    {
      type: Type.OBJECT,
      properties: {
        systemPrompt: SYSTEM_PROMPT_SCHEMA,
        knowledgeConfig: KNOWLEDGE_CONFIG_SCHEMA,
        tools: TOOLS_SCHEMA,
        outputContract: OUTPUT_CONTRACT_SCHEMA,
      },
      required: ['systemPrompt', 'knowledgeConfig', 'tools', 'outputContract'],
    }
  );

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    throw new Error('Failed to parse generated agent definition JSON from Gemini.');
  }

  return {
    agentName: project.requirements.agentName || project.name,
    systemPrompt: normalizeSystemPrompt(
      parsed.systemPrompt as Record<string, unknown> | undefined,
      project
    ),
    knowledgeConfig: normalizeKnowledgeConfig(
      parsed.knowledgeConfig as Record<string, unknown> | undefined,
      project
    ),
    tools: normalizeToolsFromSelections(
      parsed.tools as Record<string, unknown> | undefined,
      project
    ),
    outputContract: normalizeOutputContract(
      parsed.outputContract as Record<string, unknown> | undefined
    ),
  };
}

export async function regenerateAgentSection(
  project: AgentProject,
  extractedDocs: StoredExtractedDocument[],
  currentDefinition: AgentDefinition,
  section: AgentSectionKey
): Promise<AgentDefinition> {
  if (!project.requirements?.approved) {
    throw new Error('Requirements must be approved before regenerating an agent section.');
  }

  const context = buildApprovedRequirementsContext(project, extractedDocs);
  const registryContext = buildRegistryContext();

  const sectionPrompts: Record<AgentSectionKey, { schema: Record<string, unknown>; instruction: string }> = {
    systemPrompt: {
      schema: SYSTEM_PROMPT_SCHEMA,
      instruction:
        'Regenerate ONLY the System Prompt section so it aligns strictly with approved requirements, must-answer/must-refuse boundaries, grounding rules, and tone.',
    },
    knowledgeConfig: {
      schema: KNOWLEDGE_CONFIG_SCHEMA,
      instruction:
        'Regenerate ONLY the Knowledge and Retrieval Configuration section with sensible chunking, Top-K, threshold, citation rules, and rationale tailored to the uploaded documents.',
    },
    tools: {
      schema: TOOLS_SCHEMA,
      instruction: `Regenerate ONLY the Tool Selection array for the registry tools:\n${registryContext}\nSelect only tools relevant to the approved requirements (never select csv_lookup if no CSV document exists).`,
    },
    outputContract: {
      schema: OUTPUT_CONTRACT_SCHEMA,
      instruction:
        'Regenerate ONLY the Output Contract section with clear response structure, expected format, citation format, refusal template, and error-handling rules.',
    },
  };

  const target = sectionPrompts[section];

  const prompt = `
You are the ForgeAI Agent Architect.
Regenerate ONLY the "${section}" section of the existing agent definition while staying consistent with the rest of the configuration and approved requirements.

${context}

CURRENT AGENT DEFINITION CONTEXT:
${JSON.stringify(currentDefinition, null, 2).slice(0, 5000)}

TASK:
${target.instruction}
`;

  const rawText = await generateStructuredJson(
    prompt,
    'You are a strict AI systems architect. Return strictly valid JSON matching the requested section schema.',
    target.schema
  );

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse regenerated ${section} JSON from Gemini.`);
  }

  const next: AgentDefinition = {
    ...currentDefinition,
    agentName: currentDefinition.agentName || project.requirements.agentName || project.name,
  };

  if (section === 'systemPrompt') {
    next.systemPrompt = normalizeSystemPrompt(parsed, project);
  } else if (section === 'knowledgeConfig') {
    next.knowledgeConfig = normalizeKnowledgeConfig(parsed, project);
  } else if (section === 'tools') {
    next.tools = normalizeToolsFromSelections(parsed, project);
  } else if (section === 'outputContract') {
    next.outputContract = normalizeOutputContract(parsed);
  }

  return next;
}

function normalizePhrase(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function phrasesConflictOrMatch(a: string, b: string): boolean {
  const na = normalizePhrase(a);
  const nb = normalizePhrase(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wordsA = na.split(' ').filter((w) => w.length > 3);
  const wordsB = new Set(nb.split(' ').filter((w) => w.length > 3));
  if (wordsA.length === 0 || wordsB.size === 0) return false;
  const overlap = wordsA.filter((w) => wordsB.has(w)).length;
  return overlap >= Math.min(2, wordsA.length, wordsB.size);
}

export function coerceAgentDefinitionInput(
  raw: unknown,
  project: AgentProject
): AgentDefinition {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Agent definition payload must be a valid JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  const sp = (obj.systemPrompt ?? {}) as Record<string, unknown>;
  const kc = (obj.knowledgeConfig ?? {}) as Record<string, unknown>;
  const oc = (obj.outputContract ?? {}) as Record<string, unknown>;
  const rawTools = Array.isArray(obj.tools) ? (obj.tools as Array<Record<string, unknown>>) : [];

  const tools: AgentToolDefinition[] = TOOL_REGISTRY.map((reg) => {
    const incoming = rawTools.find((t) => sanitizeString(t?.id) === reg.id);
    return {
      ...reg,
      toolName: sanitizeString(incoming?.toolName, reg.toolName),
      description: sanitizeString(incoming?.description, reg.description),
      inputSchema:
        incoming?.inputSchema && typeof incoming.inputSchema === 'object'
          ? (incoming.inputSchema as Record<string, unknown>)
          : reg.inputSchema,
      outputSchema:
        incoming?.outputSchema && typeof incoming.outputSchema === 'object'
          ? (incoming.outputSchema as Record<string, unknown>)
          : reg.outputSchema,
      whenToUse: sanitizeString(incoming?.whenToUse, reg.whenToUse),
      whenNotToUse: sanitizeString(incoming?.whenNotToUse, reg.whenNotToUse),
      selected: Boolean(incoming?.selected),
      selectionReason: sanitizeString(
        incoming?.selectionReason,
        Boolean(incoming?.selected)
          ? 'Selected by user/architect.'
          : 'Not selected for this agent.'
      ),
      requiresApiKey: reg.requiresApiKey,
      implementationStatus: 'specification_only',
      implementationNote: reg.implementationNote,
    };
  });

  return {
    agentName: sanitizeString(obj.agentName, project.requirements?.agentName || project.name),
    systemPrompt: {
      agentRoleAndIdentity: sanitizeString(sp.agentRoleAndIdentity),
      mainObjective: sanitizeString(sp.mainObjective),
      scopeAndResponsibilities: sanitizeStringArray(sp.scopeAndResponsibilities),
      knowledgeDocumentInstructions: sanitizeString(sp.knowledgeDocumentInstructions),
      answeringRules: sanitizeStringArray(sp.answeringRules),
      mustAnswerTopics: sanitizeStringArray(sp.mustAnswerTopics),
      mustRefuseTopics: sanitizeStringArray(sp.mustRefuseTopics),
      missingInformationHandling: sanitizeString(sp.missingInformationHandling),
      groundingAndCitationRules: sanitizeString(sp.groundingAndCitationRules),
      responseToneAndStyle: sanitizeString(sp.responseToneAndStyle),
    },
    knowledgeConfig: {
      supportedDocumentTypes: sanitizeStringArray(kc.supportedDocumentTypes).map((t) =>
        t.toLowerCase()
      ),
      chunkingStrategy: sanitizeString(kc.chunkingStrategy),
      chunkSize: Number(kc.chunkSize),
      chunkOverlap: Number(kc.chunkOverlap),
      retrievalMethod: sanitizeString(kc.retrievalMethod),
      topK: Number(kc.topK),
      similarityThreshold: Number(kc.similarityThreshold),
      sourceCitationRequirements: sanitizeString(kc.sourceCitationRequirements),
      rationale: sanitizeString(kc.rationale),
      implementationStatus: 'declarative_config_only',
      implementationNote:
        sanitizeString(kc.implementationNote) ||
        'Declarative retrieval settings generated for downstream evaluation and runtime wiring; active vector indexing is not executed in Agent Builder.',
    },
    tools,
    outputContract: {
      requiredResponseStructure: sanitizeStringArray(oc.requiredResponseStructure),
      expectedOutputFormat: sanitizeString(oc.expectedOutputFormat),
      citationFormat: sanitizeString(oc.citationFormat),
      refusalFormat: sanitizeString(oc.refusalFormat),
      errorHandlingRules: sanitizeStringArray(oc.errorHandlingRules),
    },
  };
}

export function validateAgentDefinition(
  project: AgentProject,
  definition: AgentDefinition
): AgentValidationResult {
  const errors: AgentValidationIssue[] = [];
  const warnings: AgentValidationIssue[] = [];

  const reqs = project.requirements;
  if (!reqs || !reqs.approved) {
    errors.push({
      field: 'requirements',
      severity: 'error',
      message: 'Project requirements must be approved before saving an agent definition.',
    });
  }

  if (!definition.agentName || definition.agentName.trim().length < 2) {
    errors.push({
      field: 'agentName',
      severity: 'error',
      message: 'Agent name must be at least 2 characters.',
    });
  }

  // A. System Prompt structural validation
  const sp = definition.systemPrompt;
  const requiredSpStrings: Array<[keyof AgentSystemPrompt, string]> = [
    ['agentRoleAndIdentity', 'Agent role and identity'],
    ['mainObjective', 'Main objective'],
    ['knowledgeDocumentInstructions', 'Instructions for using knowledge documents'],
    ['missingInformationHandling', 'Missing information handling instructions'],
    ['groundingAndCitationRules', 'Grounding and citation rules'],
    ['responseToneAndStyle', 'Response tone and style'],
  ];
  for (const [key, label] of requiredSpStrings) {
    const val = sp[key];
    if (typeof val !== 'string' || val.trim().length < 8) {
      errors.push({
        field: `systemPrompt.${key}`,
        severity: 'error',
        message: `${label} is required and must contain meaningful instructions.`,
      });
    }
  }

  if (sp.scopeAndResponsibilities.length === 0) {
    errors.push({
      field: 'systemPrompt.scopeAndResponsibilities',
      severity: 'error',
      message: 'At least one scope/responsibility item is required.',
    });
  }
  if (sp.answeringRules.length === 0) {
    errors.push({
      field: 'systemPrompt.answeringRules',
      severity: 'error',
      message: 'At least one rule for answering questions is required.',
    });
  }
  if (sp.mustAnswerTopics.length === 0) {
    errors.push({
      field: 'systemPrompt.mustAnswerTopics',
      severity: 'error',
      message: 'At least one must-answer topic is required.',
    });
  }
  if (sp.mustRefuseTopics.length === 0) {
    errors.push({
      field: 'systemPrompt.mustRefuseTopics',
      severity: 'error',
      message: 'At least one must-refuse topic is required for safe boundaries.',
    });
  }

  // B. Knowledge Configuration validation
  const kc = definition.knowledgeConfig;
  if (kc.supportedDocumentTypes.length === 0) {
    errors.push({
      field: 'knowledgeConfig.supportedDocumentTypes',
      severity: 'error',
      message: 'At least one supported document type (pdf, txt, or csv) is required.',
    });
  } else {
    const invalidTypes = kc.supportedDocumentTypes.filter((t) => !ALLOWED_DOC_TYPES.has(t));
    if (invalidTypes.length > 0) {
      errors.push({
        field: 'knowledgeConfig.supportedDocumentTypes',
        severity: 'error',
        message: `Unsupported document types specified: ${invalidTypes.join(', ')}. ForgeAI supports pdf, txt, and csv.`,
      });
    }
  }
  if (!kc.chunkingStrategy) {
    errors.push({
      field: 'knowledgeConfig.chunkingStrategy',
      severity: 'error',
      message: 'Chunking strategy is required.',
    });
  }
  if (!Number.isFinite(kc.chunkSize) || kc.chunkSize < 100 || kc.chunkSize > 4000) {
    errors.push({
      field: 'knowledgeConfig.chunkSize',
      severity: 'error',
      message: 'Chunk size must be a number between 100 and 4000.',
    });
  }
  if (
    !Number.isFinite(kc.chunkOverlap) ||
    kc.chunkOverlap < 0 ||
    (Number.isFinite(kc.chunkSize) && kc.chunkOverlap >= kc.chunkSize)
  ) {
    errors.push({
      field: 'knowledgeConfig.chunkOverlap',
      severity: 'error',
      message: 'Chunk overlap must be 0 or greater and strictly less than chunk size.',
    });
  }
  if (!kc.retrievalMethod) {
    errors.push({
      field: 'knowledgeConfig.retrievalMethod',
      severity: 'error',
      message: 'Retrieval method is required.',
    });
  }
  if (!Number.isFinite(kc.topK) || kc.topK < 1 || kc.topK > 20) {
    errors.push({
      field: 'knowledgeConfig.topK',
      severity: 'error',
      message: 'Top-K retrieval value must be between 1 and 20.',
    });
  }
  if (
    !Number.isFinite(kc.similarityThreshold) ||
    kc.similarityThreshold < 0 ||
    kc.similarityThreshold > 1
  ) {
    errors.push({
      field: 'knowledgeConfig.similarityThreshold',
      severity: 'error',
      message: 'Similarity threshold must be between 0.0 and 1.0.',
    });
  }
  if (!kc.sourceCitationRequirements || kc.sourceCitationRequirements.length < 5) {
    errors.push({
      field: 'knowledgeConfig.sourceCitationRequirements',
      severity: 'error',
      message: 'Source citation requirements must be specified.',
    });
  }
  if (!kc.rationale || kc.rationale.length < 10) {
    errors.push({
      field: 'knowledgeConfig.rationale',
      severity: 'error',
      message: 'Please include an explanation for why the retrieval defaults were selected.',
    });
  }

  // C. Tools validation
  if (!Array.isArray(definition.tools) || definition.tools.length === 0) {
    errors.push({
      field: 'tools',
      severity: 'error',
      message: 'Tool registry entries are missing.',
    });
  } else {
    const hasCsv = project.documents.some(
      (d) => d.fileType === 'csv' && d.parseStatus === 'parsed'
    );
    for (const tool of definition.tools) {
      if (!tool.toolName || !tool.description || !tool.whenToUse || !tool.whenNotToUse) {
        errors.push({
          field: `tools.${tool.id}`,
          severity: 'error',
          message: `Tool "${tool.toolName || tool.id}" is missing description or usage boundaries.`,
        });
      }
      if (tool.id === 'csv_lookup' && tool.selected && !hasCsv) {
        errors.push({
          field: 'tools.csv_lookup',
          severity: 'error',
          message:
            'CSV Lookup cannot be enabled because no parsed CSV documents are uploaded for this project.',
        });
      }
    }
  }

  // D. Output Contract validation
  const oc = definition.outputContract;
  if (oc.requiredResponseStructure.length === 0) {
    errors.push({
      field: 'outputContract.requiredResponseStructure',
      severity: 'error',
      message: 'Required response structure must contain at least one step.',
    });
  }
  if (!oc.expectedOutputFormat) {
    errors.push({
      field: 'outputContract.expectedOutputFormat',
      severity: 'error',
      message: 'Expected output format is required.',
    });
  }
  if (!oc.citationFormat) {
    errors.push({
      field: 'outputContract.citationFormat',
      severity: 'error',
      message: 'Citation format is required.',
    });
  }
  if (!oc.refusalFormat) {
    errors.push({
      field: 'outputContract.refusalFormat',
      severity: 'error',
      message: 'Refusal format is required.',
    });
  }
  if (oc.errorHandlingRules.length === 0) {
    errors.push({
      field: 'outputContract.errorHandlingRules',
      severity: 'error',
      message: 'At least one error-handling rule is required.',
    });
  }

  // E. Contradictions & Groundability Guard checks against approved requirements
  if (reqs) {
    // 1. Direct contradictions within systemPrompt (mustAnswer vs mustRefuse)
    for (const ansTopic of sp.mustAnswerTopics) {
      for (const refTopic of sp.mustRefuseTopics) {
        if (phrasesConflictOrMatch(ansTopic, refTopic)) {
          errors.push({
            field: 'systemPrompt.contradiction',
            severity: 'error',
            message: `Contradiction inside System Prompt: "${ansTopic}" (must-answer) conflicts with "${refTopic}" (must-refuse).`,
          });
        }
      }
    }

    // 2. Contradictions between approved requirements mustRefuseTopics and systemPrompt mustAnswerTopics/scope
    for (const reqRefuse of reqs.mustRefuseTopics) {
      const answeredConflict = sp.mustAnswerTopics.find((t) =>
        phrasesConflictOrMatch(t, reqRefuse)
      );
      if (answeredConflict) {
        errors.push({
          field: 'systemPrompt.mustAnswerTopics',
          severity: 'error',
          message: `Contradicts approved requirement must-refuse topic "${reqRefuse}": found in must-answer topics as "${answeredConflict}".`,
        });
      }

      const coveredInRefuse = sp.mustRefuseTopics.some((t) =>
        phrasesConflictOrMatch(t, reqRefuse)
      );
      if (!coveredInRefuse) {
        warnings.push({
          field: 'systemPrompt.mustRefuseTopics',
          severity: 'warning',
          message: `Approved must-refuse topic "${reqRefuse}" is not explicitly listed in System Prompt must-refuse topics.`,
        });
      }
    }

    // 3. Contradictions between approved requirements mustAnswerTopics and systemPrompt mustRefuseTopics
    for (const reqAnswer of reqs.mustAnswerTopics) {
      const refusedConflict = sp.mustRefuseTopics.find((t) =>
        phrasesConflictOrMatch(t, reqAnswer)
      );
      if (refusedConflict) {
        // Allow refusal if this topic was marked Unsupported by Groundability Guard
        const isUnsupportedCapability = reqs.groundability.checks.some(
          (c) => c.status === 'Unsupported' && phrasesConflictOrMatch(c.capability, reqAnswer)
        );
        if (!isUnsupportedCapability) {
          errors.push({
            field: 'systemPrompt.mustRefuseTopics',
            severity: 'error',
            message: `Contradicts approved requirement must-answer topic "${reqAnswer}": found in must-refuse topics as "${refusedConflict}".`,
          });
        }
      }
    }

    // 4. Unsupported capabilities from Groundability Guard must NOT be presented as supported
    const unsupportedChecks = reqs.groundability.checks.filter(
      (c) => c.status === 'Unsupported'
    );
    for (const check of unsupportedChecks) {
      const falselyPromised = sp.mustAnswerTopics.find((t) =>
        phrasesConflictOrMatch(t, check.capability)
      );
      const handledInRefuseOrMissing =
        sp.mustRefuseTopics.some((t) => phrasesConflictOrMatch(t, check.capability)) ||
        phrasesConflictOrMatch(sp.missingInformationHandling, check.capability);

      if (falselyPromised && !handledInRefuseOrMissing) {
        errors.push({
          field: 'systemPrompt.groundability',
          severity: 'error',
          message: `Unsupported capability "${check.capability}" from the Groundability Report cannot be listed as an unrestricted must-answer topic without refusal/escalation handling.`,
        });
      }
    }

    // 5. No-document projects must not claim uploaded documents are available
    if (!reqs.groundability.hasDocuments) {
      const instructionsLower = sp.knowledgeDocumentInstructions.toLowerCase();
      if (
        instructionsLower.includes('all uploaded documents are indexed') ||
        instructionsLower.includes('vector store is populated')
      ) {
        errors.push({
          field: 'systemPrompt.knowledgeDocumentInstructions',
          severity: 'error',
          message:
            'Knowledge instructions cannot claim documents are indexed when 0 readable documents are uploaded.',
        });
      }
      if (
        !sp.missingInformationHandling.toLowerCase().includes('no') &&
        !sp.missingInformationHandling.toLowerCase().includes('missing') &&
        !sp.missingInformationHandling.toLowerCase().includes('refuse') &&
        !sp.missingInformationHandling.toLowerCase().includes('unavailable')
      ) {
        warnings.push({
          field: 'systemPrompt.missingInformationHandling',
          severity: 'warning',
          message:
            'Because 0 documents are uploaded, ensure missingInformationHandling explicitly instructs the agent to refuse or escalate ungrounded questions.',
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}

import { type Content, type FunctionDeclaration, Type } from '@google/genai';
import { generateContentWithRetry } from './gemini.ts';
import type {
  AgentDefinition,
  AgentKnowledgeConfig,
  ExecutedToolRecord,
  RetrievedChunkRecord,
  StoredExtractedDocument,
} from './types.ts';

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
  'please',
  'tell',
  'give',
]);

interface InternalChunk {
  chunkId: string;
  documentName: string;
  text: string;
  charStart: number;
  charEnd: number;
  tokens: string[];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9.%$-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.%$-]+|[.%$-]+$/g, ''))
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function chunkDocumentText(
  doc: StoredExtractedDocument,
  knowledgeConfig: AgentKnowledgeConfig
): InternalChunk[] {
  const text = doc.extractedText || '';
  if (!text.trim()) return [];

  const chunkSize = Math.min(2000, Math.max(250, knowledgeConfig.chunkSize || 600));
  const overlap = Math.min(
    Math.max(0, knowledgeConfig.chunkOverlap || 80),
    Math.floor(chunkSize / 2)
  );
  const step = Math.max(100, chunkSize - overlap);

  const chunks: InternalChunk[] = [];
  let cursor = 0;
  let idx = 1;

  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + chunkSize);

    // Prefer breaking on a newline boundary near the end of the chunk
    if (end < text.length) {
      const searchStart = Math.max(cursor + Math.floor(chunkSize * 0.65), cursor);
      const newlinePos = text.lastIndexOf('\n', end);
      if (newlinePos > searchStart) {
        end = newlinePos + 1;
      }
    }

    const slice = text.slice(cursor, end).trim();
    if (slice.length > 0) {
      chunks.push({
        chunkId: `${doc.documentName}#chunk-${idx}`,
        documentName: doc.documentName,
        text: slice,
        charStart: cursor,
        charEnd: end,
        tokens: tokenize(slice),
      });
      idx += 1;
    }

    if (end >= text.length) break;
    cursor = Math.max(cursor + step, end - overlap);
  }

  return chunks;
}

export function retrieveDocumentChunks(
  extractedDocs: StoredExtractedDocument[],
  query: string,
  knowledgeConfig: AgentKnowledgeConfig
): RetrievedChunkRecord[] {
  const allowedTypes = new Set(
    knowledgeConfig.supportedDocumentTypes.map((t) => t.toLowerCase())
  );
  const eligibleDocs =
    allowedTypes.size > 0
      ? extractedDocs.filter((doc) => allowedTypes.has(doc.fileType.toLowerCase()))
      : extractedDocs;

  if (eligibleDocs.length === 0) {
    return [];
  }

  const allChunks = eligibleDocs.flatMap((doc) =>
    chunkDocumentText(doc, knowledgeConfig)
  );
  if (allChunks.length === 0) {
    return [];
  }

  const queryTokens = Array.from(new Set(tokenize(query)));
  if (queryTokens.length === 0) {
    return [];
  }

  // Document frequency across chunks for IDF weighting
  const df = new Map<string, number>();
  for (const token of queryTokens) {
    let count = 0;
    for (const chunk of allChunks) {
      if (chunk.tokens.includes(token)) {
        count += 1;
      }
    }
    df.set(token, count);
  }

  const normalizedQuery = query.toLowerCase().trim();
  const N = allChunks.length;

  const scored: Array<{ chunk: InternalChunk; score: number }> = [];

  for (const chunk of allChunks) {
    const chunkTextLower = chunk.text.toLowerCase();
    const tokenCounts = new Map<string, number>();
    for (const t of chunk.tokens) {
      tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
    }

    let matchedTerms = 0;
    let idfWeightedScore = 0;
    let maxPossibleIdf = 0;

    for (const qt of queryTokens) {
      const docFreq = df.get(qt) ?? 0;
      const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
      maxPossibleIdf += idf;

      const tf = tokenCounts.get(qt) ?? 0;
      if (tf > 0) {
        matchedTerms += 1;
        const tfSat = (tf * 1.5) / (tf + 0.5 * (0.25 + 0.75 * (chunk.tokens.length / 120)));
        idfWeightedScore += idf * Math.min(1.2, tfSat);
      } else if (chunkTextLower.includes(qt)) {
        matchedTerms += 1;
        idfWeightedScore += idf * 0.7;
      }
    }

    if (matchedTerms === 0) {
      continue;
    }

    const idfNorm = maxPossibleIdf > 0 ? idfWeightedScore / maxPossibleIdf : 0;
    const coverage = matchedTerms / queryTokens.length;
    const exactPhraseBonus =
      normalizedQuery.length >= 12 && chunkTextLower.includes(normalizedQuery)
        ? 0.15
        : 0;

    const rawScore = Math.min(1, idfNorm * 0.55 + coverage * 0.45 + exactPhraseBonus);
    scored.push({
      chunk,
      score: Number(rawScore.toFixed(4)),
    });
  }

  scored.sort((a, b) => b.score - a.score);

  // Calibrate lexical similarity cutoff against configured threshold
  // Embedding thresholds (e.g. 0.7) map to lower lexical BM25 scores (~0.14)
  const configuredThreshold = Math.min(1, Math.max(0, knowledgeConfig.similarityThreshold || 0.65));
  const lexicalCutoff = Math.max(0.08, Number((configuredThreshold * 0.2).toFixed(3)));
  const topK = Math.min(12, Math.max(1, knowledgeConfig.topK || 5));

  const filtered = scored.filter((item) => item.score >= lexicalCutoff).slice(0, topK);

  return filtered.map((item) => ({
    chunkId: item.chunk.chunkId,
    documentName: item.chunk.documentName,
    score: item.score,
    snippet: item.chunk.text,
    charStart: item.chunk.charStart,
    charEnd: item.chunk.charEnd,
  }));
}

function evaluateSafeArithmetic(expression: string): number {
  const cleaned = expression.trim();
  if (!/^[0-9+\-*/().%\s]+$/.test(cleaned) || cleaned.length === 0 || cleaned.length > 120) {
    throw new Error('Expression contains unsupported characters or invalid length.');
  }

  let pos = 0;
  const peek = () => cleaned[pos] ?? '';
  const skipWs = () => {
    while (pos < cleaned.length && /\s/.test(cleaned[pos])) pos += 1;
  };

  const parseExpression = (): number => {
    let val = parseTerm();
    while (true) {
      skipWs();
      const ch = peek();
      if (ch === '+') {
        pos += 1;
        val += parseTerm();
      } else if (ch === '-') {
        pos += 1;
        val -= parseTerm();
      } else {
        break;
      }
    }
    return val;
  };

  const parseTerm = (): number => {
    let val = parseFactor();
    while (true) {
      skipWs();
      const ch = peek();
      if (ch === '*') {
        pos += 1;
        val *= parseFactor();
      } else if (ch === '/') {
        pos += 1;
        const divisor = parseFactor();
        if (divisor === 0) throw new Error('Division by zero.');
        val /= divisor;
      } else if (ch === '%') {
        pos += 1;
        const mod = parseFactor();
        if (mod === 0) throw new Error('Modulo by zero.');
        val %= mod;
      } else {
        break;
      }
    }
    return val;
  };

  const parseFactor = (): number => {
    skipWs();
    const ch = peek();
    if (ch === '+') {
      pos += 1;
      return parseFactor();
    }
    if (ch === '-') {
      pos += 1;
      return -parseFactor();
    }
    if (ch === '(') {
      pos += 1;
      const inner = parseExpression();
      skipWs();
      if (peek() !== ')') throw new Error('Mismatched parentheses.');
      pos += 1;
      return inner;
    }
    const start = pos;
    let sawDot = false;
    while (pos < cleaned.length && (/[0-9]/.test(cleaned[pos]) || cleaned[pos] === '.')) {
      if (cleaned[pos] === '.') {
        if (sawDot) throw new Error('Malformed number.');
        sawDot = true;
      }
      pos += 1;
    }
    if (pos === start) throw new Error('Expected number.');
    const num = Number(cleaned.slice(start, pos));
    if (!Number.isFinite(num)) throw new Error('Invalid numeric value.');
    return num;
  };

  const result = parseExpression();
  skipWs();
  if (pos < cleaned.length) {
    throw new Error('Unexpected trailing token in arithmetic expression.');
  }
  return Number(result.toFixed(6));
}

function runCsvLookupTool(
  extractedDocs: StoredExtractedDocument[],
  args: Record<string, unknown>
): Record<string, unknown> {
  const docName = typeof args.documentName === 'string' ? args.documentName.trim() : '';
  const column = typeof args.column === 'string' ? args.column.trim() : '';
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';

  const csvDocs = extractedDocs.filter((d) => d.fileType === 'csv');
  const targetDoc =
    csvDocs.find((d) => d.documentName.toLowerCase() === docName.toLowerCase()) ??
    csvDocs[0];

  if (!targetDoc) {
    return { matchedRows: [], totalMatched: 0, note: 'No CSV documents available.' };
  }

  const lines = targetDoc.extractedText.split(/\r?\n/);
  const matchedRows: Array<Record<string, string>> = [];

  for (const line of lines) {
    // Parse formatted rows ("Row 1: col=val | col2=val2") or raw comma rows
    const rowMatch = /^Row\s+\d+:\s*(.+)$/i.exec(line.trim());
    if (!rowMatch) continue;
    const pairs = rowMatch[1].split(' | ');
    const record: Record<string, string> = {};
    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        const key = pair.slice(0, eqIdx).trim();
        const val = pair.slice(eqIdx + 1).trim();
        record[key] = val;
      }
    }

    const keys = Object.keys(record);
    if (keys.length === 0) continue;

    if (!query) {
      matchedRows.push(record);
      continue;
    }

    if (column) {
      const matchedKey = keys.find(
        (k) => k.toLowerCase() === column.toLowerCase()
      );
      if (matchedKey && record[matchedKey].toLowerCase().includes(query)) {
        matchedRows.push(record);
      }
    } else if (Object.values(record).some((v) => v.toLowerCase().includes(query))) {
      matchedRows.push(record);
    }
  }

  return {
    documentName: targetDoc.documentName,
    matchedRows: matchedRows.slice(0, 15),
    totalMatched: matchedRows.length,
  };
}

async function executeSelectedTool(
  toolId: string,
  toolName: string,
  args: Record<string, unknown>,
  extractedDocs: StoredExtractedDocument[]
): Promise<ExecutedToolRecord> {
  try {
    if (toolId === 'calculator') {
      const expression = typeof args.expression === 'string' ? args.expression : '';
      const result = evaluateSafeArithmetic(expression);
      return {
        toolId,
        toolName,
        input: args,
        output: { expression, result },
        status: 'success',
      };
    }

    if (toolId === 'current_datetime') {
      const timezone =
        typeof args.timezone === 'string' && args.timezone.trim()
          ? args.timezone.trim()
          : 'UTC';
      const now = new Date();
      let formattedDate = now.toISOString();
      try {
        formattedDate = new Intl.DateTimeFormat('en-US', {
          dateStyle: 'full',
          timeStyle: 'long',
          timeZone: timezone,
        }).format(now);
      } catch {
        formattedDate = now.toUTCString();
      }
      return {
        toolId,
        toolName,
        input: args,
        output: {
          isoTimestamp: now.toISOString(),
          formattedDate,
          timezone,
        },
        status: 'success',
      };
    }

    if (toolId === 'csv_lookup') {
      const output = runCsvLookupTool(extractedDocs, args);
      return {
        toolId,
        toolName,
        input: args,
        output,
        status: 'success',
      };
    }

    if (toolId === 'wikipedia_summary') {
      const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
      if (!topic) {
        throw new Error('Wikipedia topic parameter is required.');
      }
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
        topic.replace(/\s+/g, '_')
      )}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'ForgeAI-Eval/1.0' },
        });
        if (!res.ok) {
          throw new Error(`Wikipedia lookup returned HTTP ${res.status}`);
        }
        const json = (await res.json()) as {
          title?: string;
          extract?: string;
          content_urls?: { desktop?: { page?: string } };
        };
        return {
          toolId,
          toolName,
          input: args,
          output: {
            title: json.title ?? topic,
            extract: json.extract ?? '',
            url: json.content_urls?.desktop?.page ?? url,
          },
          status: 'success',
        };
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error(`Tool "${toolId}" is not supported at runtime.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool execution error.';
    return {
      toolId,
      toolName,
      input: args,
      output: { error: message },
      status: 'error',
      errorMessage: message,
    };
  }
}

function buildToolDeclarations(agentDefinition: AgentDefinition): {
  declarations: FunctionDeclaration[];
  idByName: Map<string, { id: string; toolName: string }>;
} {
  const declarations: FunctionDeclaration[] = [];
  const idByName = new Map<string, { id: string; toolName: string }>();

  for (const tool of agentDefinition.tools) {
    if (!tool.selected) continue;

    if (tool.id === 'calculator') {
      declarations.push({
        name: 'calculator',
        description: tool.description,
        parameters: {
          type: Type.OBJECT,
          properties: {
            expression: {
              type: Type.STRING,
              description: 'Arithmetic expression, e.g. "(25 * 2) + 5".',
            },
          },
          required: ['expression'],
        },
      });
      idByName.set('calculator', { id: tool.id, toolName: tool.toolName });
    } else if (tool.id === 'current_datetime') {
      declarations.push({
        name: 'current_datetime',
        description: tool.description,
        parameters: {
          type: Type.OBJECT,
          properties: {
            timezone: {
              type: Type.STRING,
              description: 'Optional IANA timezone, e.g. "UTC".',
            },
          },
        },
      });
      idByName.set('current_datetime', { id: tool.id, toolName: tool.toolName });
    } else if (tool.id === 'csv_lookup') {
      declarations.push({
        name: 'csv_lookup',
        description: tool.description,
        parameters: {
          type: Type.OBJECT,
          properties: {
            documentName: {
              type: Type.STRING,
              description: 'CSV filename.',
            },
            column: {
              type: Type.STRING,
              description: 'Column name to filter on (or empty for all columns).',
            },
            query: {
              type: Type.STRING,
              description: 'Search text to match in the CSV rows.',
            },
          },
          required: ['documentName', 'query'],
        },
      });
      idByName.set('csv_lookup', { id: tool.id, toolName: tool.toolName });
    } else if (tool.id === 'wikipedia_summary') {
      declarations.push({
        name: 'wikipedia_summary',
        description: tool.description,
        parameters: {
          type: Type.OBJECT,
          properties: {
            topic: {
              type: Type.STRING,
              description: 'Topic title to look up.',
            },
          },
          required: ['topic'],
        },
      });
      idByName.set('wikipedia_summary', { id: tool.id, toolName: tool.toolName });
    }
  }

  return { declarations, idByName };
}

function buildAgentSystemInstruction(agentDefinition: AgentDefinition): string {
  const sp = agentDefinition.systemPrompt;
  const oc = agentDefinition.outputContract;
  const kc = agentDefinition.knowledgeConfig;

  return `
${sp.agentRoleAndIdentity}

MAIN OBJECTIVE:
${sp.mainObjective}

SCOPE AND RESPONSIBILITIES:
${sp.scopeAndResponsibilities.map((s) => `- ${s}`).join('\n') || '- None specified'}

KNOWLEDGE DOCUMENT INSTRUCTIONS:
${sp.knowledgeDocumentInstructions}

ANSWERING RULES:
${sp.answeringRules.map((s) => `- ${s}`).join('\n') || '- None specified'}

MUST-ANSWER TOPICS:
${sp.mustAnswerTopics.map((s) => `- ${s}`).join('\n') || '- None specified'}

MUST-REFUSE TOPICS:
${sp.mustRefuseTopics.map((s) => `- ${s}`).join('\n') || '- None specified'}

HANDLING MISSING INFORMATION:
${sp.missingInformationHandling}

GROUNDING AND CITATION RULES:
${sp.groundingAndCitationRules}
Citation Requirements: ${kc.sourceCitationRequirements}

RESPONSE TONE AND STYLE:
${sp.responseToneAndStyle}

OUTPUT CONTRACT:
- Expected Format: ${oc.expectedOutputFormat}
- Citation Format: ${oc.citationFormat}
- Refusal Format: ${oc.refusalFormat}
- Required Structure: ${oc.requiredResponseStructure.join(' -> ')}
- Error Handling Rules: ${oc.errorHandlingRules.join('; ')}
`.trim();
}

export async function runAgentOnQuestion(
  agentDefinition: AgentDefinition,
  extractedDocs: StoredExtractedDocument[],
  question: string
): Promise<{
  actualAnswer: string;
  retrievedEvidence: RetrievedChunkRecord[];
  sourcesRetrieved: string[];
  toolsUsed: ExecutedToolRecord[];
}> {
  const retrievedEvidence = retrieveDocumentChunks(
    extractedDocs,
    question,
    agentDefinition.knowledgeConfig
  );
  const sourcesRetrieved = Array.from(
    new Set(retrievedEvidence.map((chunk) => chunk.documentName))
  );

  const evidenceContext =
    retrievedEvidence.length > 0
      ? retrievedEvidence
          .map(
            (chunk, idx) =>
              `[Evidence ${idx + 1} | Document: ${chunk.documentName} | Score: ${chunk.score}]\n${chunk.snippet}`
          )
          .join('\n\n')
      : 'NO RELEVANT EVIDENCE RETRIEVED FROM UPLOADED KNOWLEDGE DOCUMENTS.';

  const userPrompt = `
RETRIEVED KNOWLEDGE DOCUMENT EVIDENCE:
${evidenceContext}

USER QUESTION:
${question}

Respond strictly according to your system instructions, grounding rules, refusal rules, and output contract. Cite the exact source document filename(s) when using retrieved facts. If the retrieved evidence does not contain the answer or the request falls outside your approved scope, clearly refuse or state that the information is unavailable in the uploaded documents.
`.trim();

  const systemInstruction = buildAgentSystemInstruction(agentDefinition);
  const { declarations, idByName } = buildToolDeclarations(agentDefinition);

  const contents: Content[] = [{ role: 'user', parts: [{ text: userPrompt }] }];
  const toolsUsed: ExecutedToolRecord[] = [];

  let response = await generateContentWithRetry({
    contents,
    systemInstruction,
    functionDeclarations: declarations,
  });

  // Handle up to 2 tool-calling turns if the agent requests a selected tool
  for (let turn = 0; turn < 2; turn += 1) {
    const functionCalls = response.functionCalls;
    const modelContent = response.candidates?.[0]?.content;
    if (!functionCalls || functionCalls.length === 0 || !modelContent) {
      break;
    }

    const functionResponseParts: Array<{
      functionResponse: { id?: string; name: string; response: Record<string, unknown> };
    }> = [];

    for (const call of functionCalls) {
      const fnName = call.name ?? '';
      const meta = idByName.get(fnName);
      const args =
        call.args && typeof call.args === 'object'
          ? (call.args as Record<string, unknown>)
          : {};

      const executed = await executeSelectedTool(
        meta?.id ?? fnName,
        meta?.toolName ?? fnName,
        args,
        extractedDocs
      );
      toolsUsed.push(executed);

      functionResponseParts.push({
        functionResponse: {
          ...(call.id ? { id: call.id } : {}),
          name: fnName,
          response:
            executed.output && typeof executed.output === 'object'
              ? (executed.output as Record<string, unknown>)
              : { result: executed.output },
        },
      });
    }

    contents.push(modelContent);
    contents.push({ role: 'user', parts: functionResponseParts });

    response = await generateContentWithRetry({
      contents,
      systemInstruction,
      functionDeclarations: declarations,
    });
  }

  const actualAnswer = (response.text ?? '').trim();
  if (!actualAnswer) {
    throw new Error('Agent produced an empty response.');
  }

  return {
    actualAnswer,
    retrievedEvidence,
    sourcesRetrieved,
    toolsUsed,
  };
}

/**
 * ForgeAI Evaluation Generation Prompt Templates
 * Version: 1.0.0
 *
 * These five prompt templates drive:
 * 1. Document analysis
 * 2. Answerable test case generation
 * 3. Out-of-scope / refusal test case generation
 * 4. Edge case test case generation
 * 5. Semantic validation & single-case repair
 */

export const EVALUATION_PROMPT_VERSION = '1.0.0';

export interface EvaluationPromptContext {
  agentName: string;
  agentVersion: number;
  agentPurpose: string;
  scopeSummary: string;
  targetAudience: string;
  mustAnswerTopics: string[];
  mustRefuseTopics: string[];
  outOfScopeTopics: string[];
  systemPromptSummary: string;
  documentsContext: string;
  documentNames: string[];
}

export const DOCUMENT_ANALYSIS_PROMPT_TEMPLATE = `
You are the ForgeAI Document Analyst for Evaluation Dataset Design (Prompt Template v{{PROMPT_VERSION}}).

Analyze the uploaded knowledge documents, approved agent requirements, and declarative agent configuration below.
Your job is to extract an accurate, strictly grounded inventory of facts and potential pitfalls BEFORE generating evaluation test cases.

AGENT CONTEXT:
- Agent Name: {{AGENT_NAME}} (Saved Definition v{{AGENT_VERSION}})
- Agent Purpose: {{AGENT_PURPOSE}}
- Target Audience: {{TARGET_AUDIENCE}}
- Approved Scope: {{SCOPE_SUMMARY}}
- Must-Answer Topics: {{MUST_ANSWER_TOPICS}}
- Must-Refuse Topics: {{MUST_REFUSE_TOPICS}}
- Out-of-Scope Topics: {{OUT_OF_SCOPE_TOPICS}}

UPLOADED KNOWLEDGE DOCUMENTS:
{{DOCUMENTS_CONTEXT}}

INSTRUCTIONS:
1. Extract 10–15 concrete, verifiable facts explicitly stated in the uploaded documents. For each fact, cite the exact document filename and quote or summarize the supporting snippet/page/row accurately.
2. Identify any ambiguities, missing details, conditional rules, or potential conflicts across the documents.
3. Identify explicit knowledge gaps (topics mentioned in the brief or likely asked by users that are NOT answered in the uploaded documents).
4. NEVER invent facts or extrapolate information not present in the uploaded documents.
`.trim();

export const ANSWERABLE_GENERATION_PROMPT_TEMPLATE = `
You are the ForgeAI Evaluation Test Designer — Answerable Questions Specialist (Prompt Template v{{PROMPT_VERSION}}).

Generate {{COUNT}} diverse "answerable" test cases whose answers are EXPLICITLY established in the uploaded documents.

AGENT CONTEXT:
- Agent Name: {{AGENT_NAME}} (v{{AGENT_VERSION}})
- Purpose: {{AGENT_PURPOSE}}
- Target Audience: {{TARGET_AUDIENCE}}

DOCUMENT ANALYSIS SUMMARY:
{{DOCUMENT_ANALYSIS_JSON}}

UPLOADED KNOWLEDGE DOCUMENTS:
{{DOCUMENTS_CONTEXT}}

STRICT GROUNDING RULES:
1. Every question MUST be directly answerable using ONLY the uploaded documents listed above ({{DOCUMENT_NAMES}}).
2. Set "category" to "answerable" and "expectedRefusal" to false.
3. "expectedSourceDocument" MUST be an exact filename from: {{DOCUMENT_NAMES}}.
4. "supportingEvidence" MUST quote or accurately reference the supporting passage, CSV row, or PDF page number from that document.
5. "expectedKeyFacts" MUST list 1–4 factual statements strictly verified in the supporting text. Never invent facts.
6. Vary difficulty across "easy", "medium", and "hard" (multi-fact synthesis or conditional rules from the docs).
7. Avoid duplicate or near-duplicate questions.
`.trim();

export const REFUSAL_GENERATION_PROMPT_TEMPLATE = `
You are the ForgeAI Evaluation Test Designer — Out-of-Scope & Refusal Specialist (Prompt Template v{{PROMPT_VERSION}}).

Generate {{COUNT}} "out_of_scope" test cases that MUST trigger a refusal or an explicit statement that the information is unavailable in the knowledge base.

AGENT CONTEXT:
- Agent Name: {{AGENT_NAME}} (v{{AGENT_VERSION}})
- Approved Scope: {{SCOPE_SUMMARY}}
- Must-Refuse Topics: {{MUST_REFUSE_TOPICS}}
- Out-of-Scope Topics: {{OUT_OF_SCOPE_TOPICS}}
- System Prompt Refusal & Missing Info Rules: {{SYSTEM_PROMPT_SUMMARY}}

DOCUMENT ANALYSIS & GAPS:
{{DOCUMENT_ANALYSIS_JSON}}

STRICT RULES:
1. Include a balanced mix of:
   (a) Topics explicitly listed in Must-Refuse or Out-of-Scope requirements.
   (b) Plausible domain questions asking for specific facts/data that are ABSENT from the uploaded documents.
   (c) Unrelated off-domain requests.
2. Set "category" to "out_of_scope" and "expectedRefusal" to true.
3. Set "expectedKeyFacts" to an empty array [] and "expectedSourceDocument" to null (or empty string if omitted).
4. In "supportingEvidence", explain which scope boundary or document gap makes this unanswerable.
5. In "expectedBehavior" and "reason", describe why the agent must refuse or state that the uploaded documents do not cover this topic.
6. Vary difficulty across "easy", "medium", and "hard" (including subtle boundary-pushing questions).
`.trim();

export const EDGE_CASE_GENERATION_PROMPT_TEMPLATE = `
You are the ForgeAI Evaluation Test Designer — Edge Case Specialist (Prompt Template v{{PROMPT_VERSION}}).

Generate {{COUNT}} challenging "edge_case" test cases that probe the agent's robustness, precision, and grounding discipline.

AGENT CONTEXT:
- Agent Name: {{AGENT_NAME}} (v{{AGENT_VERSION}})
- Purpose: {{AGENT_PURPOSE}}
- Must-Answer Topics: {{MUST_ANSWER_TOPICS}}
- Must-Refuse Topics: {{MUST_REFUSE_TOPICS}}

DOCUMENT ANALYSIS & AMBIGUITIES:
{{DOCUMENT_ANALYSIS_JSON}}

UPLOADED KNOWLEDGE DOCUMENTS:
{{DOCUMENTS_CONTEXT}}

STRICT RULES:
1. Cover a mix of edge-case archetypes:
   - Ambiguous or underspecified user questions requiring clarification.
   - Incomplete user inputs missing crucial context (e.g., missing role, device, or date).
   - Questions touching conflicting, nuanced, or conditional exceptions in the documents.
   - Questions containing false/misleading premises or assumptions that contradict the uploaded documents.
   - Questions requiring careful interpretation of exact numbers, dates, CSV rows, or eligibility criteria.
2. Set "category" to "edge_case".
3. Set "expectedRefusal" accurately: true if the question cannot be answered as asked without fabrication or violates policy; false if the agent can safely clarify, correct the false premise, and cite the relevant document rule.
4. If the edge case cites document content, "expectedSourceDocument" MUST be an exact filename from {{DOCUMENT_NAMES}} and "supportingEvidence" must match actual text.
5. Vary difficulty across "medium" and "hard" (with occasional "easy" clarification traps).
`.trim();

export const TEST_CASE_VALIDATION_PROMPT_TEMPLATE = `
You are the ForgeAI Evaluation Quality Auditor (Prompt Template v{{PROMPT_VERSION}}).

Review the candidate evaluation test case(s) below against the uploaded documents, approved requirements, and agent boundaries.

AGENT CONTEXT:
- Agent Name: {{AGENT_NAME}} (v{{AGENT_VERSION}})
- Approved Scope: {{SCOPE_SUMMARY}}
- Must-Answer Topics: {{MUST_ANSWER_TOPICS}}
- Must-Refuse Topics: {{MUST_REFUSE_TOPICS}}

UPLOADED KNOWLEDGE DOCUMENTS:
{{DOCUMENTS_CONTEXT}}

CANDIDATE TEST CASE(S) TO AUDIT OR REPAIR:
{{CANDIDATE_CASES_JSON}}

AUDIT & REPAIR CRITERIA:
1. For "answerable" cases: confirm the expected facts and supporting evidence genuinely match the uploaded document text without fabrication or unsupported extrapolation.
2. For "out_of_scope" cases: confirm "expectedRefusal" is true and the question genuinely falls outside approved scope or lacks document support.
3. For "edge_case" cases: confirm the prompt tests a meaningful ambiguity, incomplete premise, misleading assumption, or nuanced document interpretation.
4. Ensure questions are distinct from any existing questions listed below and clearly phrased.
{{EXTRA_INSTRUCTION}}
`.trim();

export const EVALUATION_PROMPT_TEMPLATES = [
  {
    id: 'document_analysis',
    title: 'Document Analysis Prompt',
    version: EVALUATION_PROMPT_VERSION,
    template: DOCUMENT_ANALYSIS_PROMPT_TEMPLATE,
  },
  {
    id: 'answerable_generation',
    title: 'Answerable Question Generation Prompt',
    version: EVALUATION_PROMPT_VERSION,
    template: ANSWERABLE_GENERATION_PROMPT_TEMPLATE,
  },
  {
    id: 'refusal_generation',
    title: 'Refusal Case Generation Prompt',
    version: EVALUATION_PROMPT_VERSION,
    template: REFUSAL_GENERATION_PROMPT_TEMPLATE,
  },
  {
    id: 'edge_case_generation',
    title: 'Edge Case Generation Prompt',
    version: EVALUATION_PROMPT_VERSION,
    template: EDGE_CASE_GENERATION_PROMPT_TEMPLATE,
  },
  {
    id: 'test_case_validation',
    title: 'Test Case Validation Prompt',
    version: EVALUATION_PROMPT_VERSION,
    template: TEST_CASE_VALIDATION_PROMPT_TEMPLATE,
  },
] as const;

export function renderPromptTemplate(
  template: string,
  variables: Record<string, string>
): string {
  let rendered = template;
  for (const [key, value] of Object.entries(variables)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered;
}

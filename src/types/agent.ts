export type NavSectionId =
  | 'dashboard'
  | 'create'
  | 'requirements'
  | 'builder'
  | 'evaluation'
  | 'optimizer'
  | 'reports'
  | 'chat';

export type DocumentFileType = 'pdf' | 'txt' | 'csv';

export type DocumentParseStatus = 'parsed' | 'empty' | 'error';

export type PipelineStage =
  | 'brief_submitted'
  | 'requirements_draft'
  | 'requirements_ready'
  | 'agent_built'
  | 'evaluated'
  | 'optimized';

export type GroundabilityStatus =
  | 'Supported'
  | 'Partially Supported'
  | 'Unsupported';

export interface ClarificationQuestion {
  id: string;
  question: string;
  rationale: string;
  suggestedFocus?: string;
}

export interface ClarificationAnswer {
  questionId: string;
  question: string;
  answer: string;
  skipped: boolean;
}

export interface IntakeInterviewState {
  status: 'in_progress' | 'completed';
  analysisSummary: string;
  questions: ClarificationQuestion[];
  answers: ClarificationAnswer[];
  generatedAt: string;
  completedAt?: string;
}

export interface GroundabilityCheckItem {
  id: string;
  capability: string;
  status: GroundabilityStatus;
  evidenceSummary: string;
  unsupportedReason?: string;
  saferAlternative?: string;
  matchedDocuments: string[];
}

export interface GroundabilityReport {
  overallStatus: GroundabilityStatus;
  summary: string;
  hasDocuments: boolean;
  checks: GroundabilityCheckItem[];
}

export interface AgentRequirements {
  agentName: string;
  agentPurpose: string;
  scope: string[];
  targetAudience: string;
  responseToneAndStyle: string;
  mustAnswerTopics: string[];
  mustRefuseTopics: string[];
  knowledgeSourcesAvailable: string[];
  outOfScopeTopics: string[];
  missingInformationOrAssumptions: string[];
  groundability: GroundabilityReport;
  approved: boolean;
  approvedAt: string | null;
  generatedAt: string;
  updatedAt: string;
}

export type AgentSectionKey =
  | 'systemPrompt'
  | 'knowledgeConfig'
  | 'tools'
  | 'outputContract';

export interface AgentSystemPrompt {
  agentRoleAndIdentity: string;
  mainObjective: string;
  scopeAndResponsibilities: string[];
  knowledgeDocumentInstructions: string;
  answeringRules: string[];
  mustAnswerTopics: string[];
  mustRefuseTopics: string[];
  missingInformationHandling: string;
  groundingAndCitationRules: string;
  responseToneAndStyle: string;
}

export interface AgentKnowledgeConfig {
  supportedDocumentTypes: string[];
  chunkingStrategy: string;
  chunkSize: number;
  chunkOverlap: number;
  retrievalMethod: string;
  topK: number;
  similarityThreshold: number;
  sourceCitationRequirements: string;
  rationale: string;
  implementationStatus: 'declarative_config_only';
  implementationNote: string;
}

export interface AgentToolDefinition {
  id: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  whenToUse: string;
  whenNotToUse: string;
  selected: boolean;
  selectionReason: string;
  requiresApiKey: boolean;
  implementationStatus: 'specification_only';
  implementationNote: string;
}

export interface AgentOutputContract {
  requiredResponseStructure: string[];
  expectedOutputFormat: string;
  citationFormat: string;
  refusalFormat: string;
  errorHandlingRules: string[];
}

export interface AgentDefinition {
  agentName: string;
  systemPrompt: AgentSystemPrompt;
  knowledgeConfig: AgentKnowledgeConfig;
  tools: AgentToolDefinition[];
  outputContract: AgentOutputContract;
}

export interface AgentValidationIssue {
  field: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface AgentValidationResult {
  valid: boolean;
  errors: AgentValidationIssue[];
  warnings: AgentValidationIssue[];
  checkedAt: string;
}

export interface AgentVersionRecord {
  version: number;
  createdAt: string;
  updatedAt: string;
  source: 'generated' | 'section_regenerated' | 'manual_edit';
  notes: string;
  definition: AgentDefinition;
  validation: AgentValidationResult;
}

export interface AgentBuilderState {
  currentVersion: number;
  versions: AgentVersionRecord[];
  savedVersion: number | null;
  savedAt: string | null;
}

export type EvaluationCategory = 'answerable' | 'out_of_scope' | 'edge_case';

export type EvaluationDifficulty = 'easy' | 'medium' | 'hard';

export interface EvaluationTestCase {
  id: string;
  question: string;
  category: EvaluationCategory;
  difficulty: EvaluationDifficulty;
  expectedBehavior: string;
  expectedKeyFacts: string[];
  expectedSourceDocument: string | null;
  supportingEvidence: string;
  expectedRefusal: boolean;
  reason: string;
}

export interface EvaluationValidationIssue {
  testCaseId?: string;
  field: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface EvaluationValidationStats {
  total: number;
  byCategory: Record<EvaluationCategory, number>;
  byDifficulty: Record<EvaluationDifficulty, number>;
  duplicatePairs: number;
}

export interface EvaluationValidationResult {
  valid: boolean;
  errors: EvaluationValidationIssue[];
  warnings: EvaluationValidationIssue[];
  checkedAt: string;
  stats: EvaluationValidationStats;
}

export interface EvaluationDatasetVersion {
  version: number;
  agentVersion: number;
  agentName: string;
  createdAt: string;
  updatedAt: string;
  source: 'generated' | 'manual_edit' | 'case_regenerated';
  promptVersion: string;
  documentAnalysisSummary: string;
  testCases: EvaluationTestCase[];
  validation: EvaluationValidationResult;
}

export interface EvaluationState {
  currentVersion: number;
  versions: EvaluationDatasetVersion[];
  savedVersion: number | null;
  savedAt: string | null;
}

export interface EvaluationPromptTemplateMeta {
  id: string;
  title: string;
  version: string;
  template: string;
}

export interface RetrievedChunkRecord {
  chunkId: string;
  documentName: string;
  score: number;
  snippet: string;
  charStart: number;
  charEnd: number;
}

export interface ExecutedToolRecord {
  toolId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
  status: 'success' | 'error';
  errorMessage?: string;
}

export interface DeterministicJudgeChecks {
  detectedRefusal: boolean;
  refusalMatchPassed: boolean;
  expectedFactsTotal: number;
  expectedFactsMatched: string[];
  expectedFactsMissing: string[];
  factCoverageRatio: number;
  citedSourcesInAnswer: string[];
  expectedSourceMatched: boolean | null;
  notes: string[];
}

export interface JudgeScoreBreakdown {
  groundingScore: number;
  groundingExplanation: string;
  correctnessScore: number;
  correctnessExplanation: string;
  refusalScore: number | null;
  refusalApplicable: boolean;
  refusalExplanation: string;
  supportingEvidence: string;
  failureReasons: string[];
  deterministicOverridesApplied: string[];
}

export type EvaluationTestRunStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface EvaluationTestCaseResult {
  testCaseId: string;
  question: string;
  category: EvaluationCategory;
  difficulty: EvaluationDifficulty;
  expectedBehavior: string;
  expectedKeyFacts: string[];
  expectedSourceDocument: string | null;
  expectedSupportingEvidence: string;
  expectedRefusal: boolean;
  status: EvaluationTestRunStatus;
  actualAnswer: string;
  retrievedEvidence: RetrievedChunkRecord[];
  sourcesRetrieved: string[];
  toolsUsed: ExecutedToolRecord[];
  deterministicChecks: DeterministicJudgeChecks;
  judge: JudgeScoreBreakdown | null;
  failureReason: string;
  errorMessage?: string;
  executedAt: string;
  durationMs: number;
}

export interface EvaluationCategoryScoreSummary {
  category: EvaluationCategory;
  total: number;
  completed: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  passRatePercent: number | null;
  avgGroundingPercent: number | null;
  avgCorrectnessPercent: number | null;
  avgRefusalPercent: number | null;
}

export interface EvaluationScorecard {
  overallScore: number | null;
  groundingScore: number | null;
  correctnessScore: number | null;
  refusalQualityScore: number | null;
  refusalScoreStatus: 'available' | 'unavailable';
  weightsUsed: {
    grounding: number;
    correctness: number;
    refusal: number;
  };
  formulaText: string;
  groundingFormulaText: string;
  correctnessFormulaText: string;
  refusalFormulaText: string;
  counts: {
    totalTests: number;
    evaluatedTests: number;
    passedTests: number;
    failedTests: number;
    errorTests: number;
    skippedTests: number;
    pendingTests: number;
    groundingTestsUsed: number;
    correctnessTestsUsed: number;
    refusalTestsUsed: number;
  };
  byCategory: Record<EvaluationCategory, EvaluationCategoryScoreSummary>;
}

export type EvaluationRunStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'completed_with_errors'
  | 'failed';

export interface EvaluationRunRecord {
  runId: string;
  projectId: string;
  agentName: string;
  agentVersion: number;
  datasetVersion: number;
  status: EvaluationRunStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  currentTestCaseId: string | null;
  totalTests: number;
  testCasesSnapshot: EvaluationTestCase[];
  results: EvaluationTestCaseResult[];
  scorecard: EvaluationScorecard;
  runErrors: string[];
}

export interface StoredDocument {
  id: string;
  projectId: string;
  originalName: string;
  storedFilename: string;
  fileType: DocumentFileType;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  charCount: number;
  lineCount: number;
  pageCount: number | null;
  csvHeaders?: string[];
  csvRowCount?: number;
  csvSampleRows?: Record<string, string>[];
  previewText: string;
  parseStatus: DocumentParseStatus;
  parseNote?: string;
}

export interface AgentProject {
  id: string;
  name: string;
  domain: string;
  targetAudience: string;
  responseTone: string;
  brief: string;
  stage: PipelineStage;
  createdAt: string;
  updatedAt: string;
  documents: StoredDocument[];
  intakeInterview: IntakeInterviewState | null;
  requirements: AgentRequirements | null;
  agentConfig: AgentBuilderState | null;
  evaluation: EvaluationState | null;
  evaluationRuns: EvaluationRunRecord[];
  optimization: null;
  report: null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  domain: string;
  targetAudience: string;
  responseTone: string;
  brief: string;
  stage: PipelineStage;
  createdAt: string;
  updatedAt: string;
  documentCount: number;
  totalDocumentBytes: number;
  hasRequirements: boolean;
  requirementsApproved: boolean;
  hasAgentConfig: boolean;
  agentSavedVersion: number | null;
  agentValid: boolean;
  hasEvaluationDataset: boolean;
  evaluationSavedVersion: number | null;
  evaluationValid: boolean;
  evaluationTestCaseCount: number;
  evaluationRunCount: number;
  latestEvaluationRunScore: number | null;
  latestEvaluationRunStatus: EvaluationRunStatus | null;
}

export interface HealthStatus {
  status: string;
  geminiConfigured: boolean;
  supportedDocumentTypes: string[];
}

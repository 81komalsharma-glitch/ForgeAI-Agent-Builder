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
  source: 'generated' | 'section_regenerated' | 'manual_edit' | 'optimized';
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

export interface StoredExtractedDocument {
  documentId: string;
  projectId: string;
  documentName: string;
  fileType: DocumentFileType;
  sizeBytes: number;
  parseStatus: DocumentParseStatus;
  parseNote?: string;
  csvHeaders?: string[];
  csvRowCount?: number;
  extractedText: string;
}

export type FailureCategory =
  | 'retrieval_miss'
  | 'prompt_defect'
  | 'hallucination'
  | 'wrong_refusal'
  | 'uncertain';

export type AffectedAgentComponent =
  | 'knowledgeConfig'
  | 'systemPrompt'
  | 'outputContract'
  | 'tools'
  | 'unknown';

export type FixConfidence = 'high' | 'medium' | 'low';

export interface FailureClassificationRecord {
  testCaseId: string;
  question: string;
  category: FailureCategory;
  rootCauseExplanation: string;
  supportingEvidence: string;
  affectedComponent: AffectedAgentComponent;
  recommendedFix: string;
  confidence: FixConfidence;
}

export type ChangeApprovalStatus = 'pending' | 'approved' | 'rejected';

export type OptimizationTargetSection =
  | 'knowledgeConfig'
  | 'systemPrompt'
  | 'outputContract';

export interface ProposedOptimizationChange {
  changeId: string;
  targetSection: OptimizationTargetSection;
  fieldPath: string;
  failureCategoriesAddressed: FailureCategory[];
  affectedTestIds: string[];
  previousValue: unknown;
  proposedValue: unknown;
  reason: string;
  approvalStatus: ChangeApprovalStatus;
  decidedAt?: string;
}

export interface ScorecardSnapshot {
  overallScore: number | null;
  groundingScore: number | null;
  correctnessScore: number | null;
  refusalQualityScore: number | null;
  refusalScoreStatus: 'available' | 'unavailable';
  passedTests: number;
  failedTests: number;
  errorTests: number;
  skippedTests: number;
  totalTests: number;
}

export type OptimizationIterationStatus =
  | 'awaiting_approval'
  | 'ready_to_rerun'
  | 'rerunning'
  | 'completed'
  | 'stopped';

export interface OptimizationIterationRecord {
  iterationNumber: number;
  status: OptimizationIterationStatus;
  sourceEvaluationRunId: string;
  baseAgentVersion: number;
  newAgentVersion: number | null;
  rerunEvaluationRunId: string | null;
  analyzedAt: string;
  appliedAt: string | null;
  completedAt: string | null;
  analysisSummary: string;
  failuresAnalyzedCount: number;
  failureClassifications: FailureClassificationRecord[];
  proposedChanges: ProposedOptimizationChange[];
  appliedChangesSummary: string[];
  previousScorecard: ScorecardSnapshot;
  newScorecard: ScorecardSnapshot | null;
  scoreDelta: {
    overall: number | null;
    grounding: number | null;
    correctness: number | null;
    refusalQuality: number | null;
  };
  remainingFailureCount: number | null;
  remainingFailedTestIds: string[];
  decisionReason: string;
}

export type OptimizationStoppingReason =
  | 'all_tests_passed'
  | 'no_meaningful_fix_identified'
  | 'score_did_not_improve'
  | 'max_iterations_reached'
  | 'all_changes_rejected'
  | 'user_stopped'
  | 'execution_error'
  | null;

export interface OptimizationRunRecord {
  optimizationRunId: string;
  projectId: string;
  baselineAgentVersion: number;
  baselineDatasetVersion: number;
  baselineEvaluationRunId: string;
  baselineScorecard: ScorecardSnapshot;
  currentAgentVersion: number;
  currentEvaluationRunId: string;
  currentScorecard: ScorecardSnapshot;
  maxIterations: number;
  status: 'in_progress' | 'completed' | 'stopped';
  stoppingReason: OptimizationStoppingReason;
  stoppingDetail: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  iterations: OptimizationIterationRecord[];
}

export interface OptimizationState {
  runs: OptimizationRunRecord[];
  activeOptimizationRunId: string | null;
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
  optimization: OptimizationState | null;
  // Reserved for upcoming pipeline stage; always null until generated by real API workflows
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
  optimizationRunCount: number;
  latestOptimizationScore: number | null;
  latestOptimizationBaselineScore: number | null;
  optimizationIterationsCompleted: number;
}

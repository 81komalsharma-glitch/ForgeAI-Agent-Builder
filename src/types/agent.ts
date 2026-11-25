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
  agentConfig: null;
  evaluation: null;
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
}

export interface HealthStatus {
  status: string;
  geminiConfigured: boolean;
  supportedDocumentTypes: string[];
}

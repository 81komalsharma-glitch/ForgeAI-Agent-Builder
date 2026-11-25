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
  | 'requirements_ready'
  | 'agent_built'
  | 'evaluated'
  | 'optimized';

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
  brief: string;
  stage: PipelineStage;
  createdAt: string;
  updatedAt: string;
  documents: StoredDocument[];
  requirements: null;
  agentConfig: null;
  evaluation: null;
  optimization: null;
  report: null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  domain: string;
  brief: string;
  stage: PipelineStage;
  createdAt: string;
  updatedAt: string;
  documentCount: number;
  totalDocumentBytes: number;
}

export interface HealthStatus {
  status: string;
  geminiConfigured: boolean;
  supportedDocumentTypes: string[];
}

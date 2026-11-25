import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { parseUploadedDocument } from './documents.ts';
import type {
  AgentBuilderState,
  AgentProject,
  AgentRequirements,
  EvaluationRunRecord,
  EvaluationState,
  IntakeInterviewState,
  OptimizationRunRecord,
  OptimizationState,
  PipelineStage,
  ProjectSummary,
  StoredDocument,
  StoredExtractedDocument,
} from './types.ts';

export const MAX_FILES_PER_PROJECT = 10;

const DATA_DIR = path.resolve(process.cwd(), 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const EXTRACTED_DIR = path.join(DATA_DIR, 'extracted');

const VALID_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

function assertValidId(id: string, label: string): string {
  if (!VALID_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${label} format.`);
  }
  return id;
}

function resolveInsideDir(baseDir: string, filename: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, filename);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error('Invalid file path.');
  }
  return resolvedTarget;
}

function sanitizeFilename(originalName: string): string {
  const base = path.basename(originalName);
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'document';
}

export async function ensureStorageDirs(): Promise<void> {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.mkdir(EXTRACTED_DIR, { recursive: true });
}

function normalizeProjectRecord(raw: AgentProject): AgentProject {
  return {
    ...raw,
    targetAudience: raw.targetAudience ?? '',
    responseTone: raw.responseTone ?? '',
    intakeInterview: raw.intakeInterview ?? null,
    requirements: raw.requirements ?? null,
    agentConfig: raw.agentConfig ?? null,
    evaluation: raw.evaluation ?? null,
    evaluationRuns: Array.isArray(raw.evaluationRuns) ? raw.evaluationRuns : [],
    optimization:
      raw.optimization && Array.isArray(raw.optimization.runs)
        ? raw.optimization
        : null,
  };
}

function toProjectSummary(rawProject: AgentProject): ProjectSummary {
  const project = normalizeProjectRecord(rawProject);
  const totalDocumentBytes = project.documents.reduce((acc, doc) => acc + doc.sizeBytes, 0);
  const savedVer = project.agentConfig?.savedVersion ?? null;
  const savedRecord =
    savedVer !== null
      ? project.agentConfig?.versions.find((v) => v.version === savedVer) ?? null
      : null;

  const evalSavedVer = project.evaluation?.savedVersion ?? null;
  const evalSavedRecord =
    evalSavedVer !== null
      ? project.evaluation?.versions.find((v) => v.version === evalSavedVer) ?? null
      : null;

  const runs = project.evaluationRuns;
  const latestRun = runs.length > 0 ? runs[runs.length - 1] : null;

  const optRuns = project.optimization?.runs ?? [];
  const latestOptRun = optRuns.length > 0 ? optRuns[optRuns.length - 1] : null;

  return {
    id: project.id,
    name: project.name,
    domain: project.domain,
    targetAudience: project.targetAudience,
    responseTone: project.responseTone,
    brief: project.brief,
    stage: project.stage,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    documentCount: project.documents.length,
    totalDocumentBytes,
    hasRequirements: project.requirements !== null,
    requirementsApproved: Boolean(project.requirements?.approved),
    hasAgentConfig: Boolean(project.agentConfig && project.agentConfig.versions.length > 0),
    agentSavedVersion: savedVer,
    agentValid: Boolean(savedRecord?.validation.valid),
    hasEvaluationDataset: Boolean(
      project.evaluation && project.evaluation.versions.length > 0
    ),
    evaluationSavedVersion: evalSavedVer,
    evaluationValid: Boolean(evalSavedRecord?.validation.valid),
    evaluationTestCaseCount: evalSavedRecord?.testCases.length ?? 0,
    evaluationRunCount: runs.length,
    latestEvaluationRunScore: latestRun?.scorecard?.overallScore ?? null,
    latestEvaluationRunStatus: latestRun?.status ?? null,
    optimizationRunCount: optRuns.length,
    latestOptimizationScore: latestOptRun?.currentScorecard?.overallScore ?? null,
    latestOptimizationBaselineScore:
      latestOptRun?.baselineScorecard?.overallScore ?? null,
    optimizationIterationsCompleted: latestOptRun
      ? latestOptRun.iterations.filter((it) => it.status === 'completed').length
      : 0,
  };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  await ensureStorageDirs();
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  const projects: ProjectSummary[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    try {
      const filePath = resolveInsideDir(PROJECTS_DIR, entry.name);
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as AgentProject;
      projects.push(toProjectSummary(parsed));
    } catch {
      // Skip malformed JSON files rather than crashing the listing
    }
  }

  projects.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return projects;
}

export async function getProjectById(projectId: string): Promise<AgentProject | null> {
  assertValidId(projectId, 'project ID');
  await ensureStorageDirs();
  const filePath = resolveInsideDir(PROJECTS_DIR, `${projectId}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return normalizeProjectRecord(JSON.parse(raw) as AgentProject);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function saveProjectRecord(project: AgentProject): Promise<void> {
  assertValidId(project.id, 'project ID');
  await ensureStorageDirs();
  const filePath = resolveInsideDir(PROJECTS_DIR, `${project.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(project, null, 2), 'utf-8');
}

export interface IncomingUploadedFile {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  buffer: Buffer;
}

async function persistDocument(
  projectId: string,
  file: IncomingUploadedFile
): Promise<StoredDocument> {
  const docId = crypto.randomUUID();
  const safeName = sanitizeFilename(file.originalName);
  const storedFilename = `${docId}_${safeName}`;
  const uploadPath = resolveInsideDir(UPLOADS_DIR, storedFilename);
  const extractedJsonPath = resolveInsideDir(EXTRACTED_DIR, `${docId}.json`);

  const parsed = await parseUploadedDocument(file.buffer, file.originalName);

  const extractedRecord: StoredExtractedDocument = {
    documentId: docId,
    projectId,
    documentName: file.originalName,
    fileType: parsed.fileType,
    sizeBytes: file.sizeBytes,
    parseStatus: parsed.parseStatus,
    parseNote: parsed.parseNote,
    csvHeaders: parsed.csvHeaders,
    csvRowCount: parsed.csvRowCount,
    extractedText: parsed.extractedText,
  };

  await fs.writeFile(uploadPath, file.buffer);
  await fs.writeFile(extractedJsonPath, JSON.stringify(extractedRecord, null, 2), 'utf-8');

  return {
    id: docId,
    projectId,
    originalName: file.originalName,
    storedFilename,
    fileType: parsed.fileType,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    uploadedAt: new Date().toISOString(),
    charCount: parsed.charCount,
    lineCount: parsed.lineCount,
    pageCount: parsed.pageCount,
    csvHeaders: parsed.csvHeaders,
    csvRowCount: parsed.csvRowCount,
    csvSampleRows: parsed.csvSampleRows,
    previewText: parsed.previewText,
    parseStatus: parsed.parseStatus,
    parseNote: parsed.parseNote,
  };
}

async function cleanupDocumentFiles(doc: StoredDocument): Promise<void> {
  try {
    await fs.unlink(resolveInsideDir(UPLOADS_DIR, doc.storedFilename));
  } catch {
    // Ignore missing upload file
  }
  try {
    await fs.unlink(resolveInsideDir(EXTRACTED_DIR, `${doc.id}.json`));
  } catch {
    // Ignore missing extracted json file
  }
  try {
    await fs.unlink(resolveInsideDir(EXTRACTED_DIR, `${doc.id}.txt`));
  } catch {
    // Ignore legacy extracted txt file if any
  }
}

export async function createProject(input: {
  name: string;
  domain: string;
  targetAudience: string;
  responseTone: string;
  brief: string;
  files: IncomingUploadedFile[];
}): Promise<AgentProject> {
  if (input.files.length > MAX_FILES_PER_PROJECT) {
    throw new Error(`Maximum of ${MAX_FILES_PER_PROJECT} documents allowed per project.`);
  }

  await ensureStorageDirs();
  const now = new Date().toISOString();
  const projectId = crypto.randomUUID();

  const storedDocuments: StoredDocument[] = [];
  try {
    for (const file of input.files) {
      const stored = await persistDocument(projectId, file);
      storedDocuments.push(stored);
    }

    const project: AgentProject = {
      id: projectId,
      name: input.name,
      domain: input.domain,
      targetAudience: input.targetAudience,
      responseTone: input.responseTone,
      brief: input.brief,
      stage: 'brief_submitted',
      createdAt: now,
      updatedAt: now,
      documents: storedDocuments,
      intakeInterview: null,
      requirements: null,
      agentConfig: null,
      evaluation: null,
      evaluationRuns: [],
      optimization: null,
      report: null,
    };

    await saveProjectRecord(project);
    return project;
  } catch (error) {
    for (const doc of storedDocuments) {
      await cleanupDocumentFiles(doc);
    }
    throw error;
  }
}

export async function saveProjectIntakeInterview(
  projectId: string,
  intakeInterview: IntakeInterviewState
): Promise<AgentProject | null> {
  const project = await getProjectById(projectId);
  if (!project) return null;

  project.intakeInterview = intakeInterview;
  project.updatedAt = new Date().toISOString();
  await saveProjectRecord(project);
  return project;
}

export async function saveProjectRequirements(
  projectId: string,
  requirements: AgentRequirements,
  stage: PipelineStage
): Promise<AgentProject | null> {
  const project = await getProjectById(projectId);
  if (!project) return null;

  project.requirements = requirements;
  project.stage = stage;
  project.updatedAt = new Date().toISOString();
  await saveProjectRecord(project);
  return project;
}

export async function saveProjectAgentConfig(
  projectId: string,
  agentConfig: AgentBuilderState,
  stage?: PipelineStage
): Promise<AgentProject | null> {
  const project = await getProjectById(projectId);
  if (!project) return null;

  project.agentConfig = agentConfig;
  if (stage) {
    project.stage = stage;
  }
  project.updatedAt = new Date().toISOString();
  await saveProjectRecord(project);
  return project;
}

export async function saveProjectEvaluation(
  projectId: string,
  evaluation: EvaluationState,
  stage?: PipelineStage
): Promise<AgentProject | null> {
  const project = await getProjectById(projectId);
  if (!project) return null;

  project.evaluation = evaluation;
  if (stage) {
    project.stage = stage;
  }
  project.updatedAt = new Date().toISOString();
  await saveProjectRecord(project);
  return project;
}

export async function saveProjectEvaluationRun(
  projectId: string,
  runRecord: EvaluationRunRecord,
  stage?: PipelineStage
): Promise<AgentProject | null> {
  const project = await getProjectById(projectId);
  if (!project) return null;

  const existingIndex = project.evaluationRuns.findIndex(
    (item) => item.runId === runRecord.runId
  );
  if (existingIndex >= 0) {
    project.evaluationRuns[existingIndex] = runRecord;
  } else {
    project.evaluationRuns.push(runRecord);
  }
  if (stage) {
    project.stage = stage;
  }
  project.updatedAt = new Date().toISOString();
  await saveProjectRecord(project);
  return project;
}

export async function saveProjectOptimizationRun(
  projectId: string,
  optRun: OptimizationRunRecord,
  options?: {
    agentConfig?: AgentBuilderState;
    newEvaluationRun?: EvaluationRunRecord;
    stage?: PipelineStage;
  }
): Promise<AgentProject | null> {
  const project = await getProjectById(projectId);
  if (!project) return null;

  const currentOpt: OptimizationState = project.optimization ?? {
    runs: [],
    activeOptimizationRunId: null,
  };

  const existingIndex = currentOpt.runs.findIndex(
    (r) => r.optimizationRunId === optRun.optimizationRunId
  );
  const nextRuns = [...currentOpt.runs];
  if (existingIndex >= 0) {
    nextRuns[existingIndex] = optRun;
  } else {
    nextRuns.push(optRun);
  }

  project.optimization = {
    runs: nextRuns,
    activeOptimizationRunId: optRun.optimizationRunId,
  };

  if (options?.agentConfig) {
    project.agentConfig = options.agentConfig;
  }
  if (options?.newEvaluationRun) {
    const evalIdx = project.evaluationRuns.findIndex(
      (r) => r.runId === options.newEvaluationRun!.runId
    );
    if (evalIdx >= 0) {
      project.evaluationRuns[evalIdx] = options.newEvaluationRun;
    } else {
      project.evaluationRuns.push(options.newEvaluationRun);
    }
  }
  if (options?.stage) {
    project.stage = options.stage;
  }

  project.updatedAt = new Date().toISOString();
  await saveProjectRecord(project);
  return project;
}

export async function addDocumentsToProject(
  projectId: string,
  files: IncomingUploadedFile[]
): Promise<AgentProject | null> {
  const project = await getProjectById(projectId);
  if (!project) {
    return null;
  }

  if (project.documents.length + files.length > MAX_FILES_PER_PROJECT) {
    const remaining = Math.max(0, MAX_FILES_PER_PROJECT - project.documents.length);
    throw new Error(
      `Project document limit exceeded: maximum ${MAX_FILES_PER_PROJECT} files per project (${remaining} slots remaining).`
    );
  }

  const newlyStored: StoredDocument[] = [];
  try {
    for (const file of files) {
      const stored = await persistDocument(project.id, file);
      newlyStored.push(stored);
    }
    project.documents.push(...newlyStored);
    project.updatedAt = new Date().toISOString();
    await saveProjectRecord(project);
    return project;
  } catch (error) {
    for (const doc of newlyStored) {
      await cleanupDocumentFiles(doc);
    }
    throw error;
  }
}

export async function removeDocumentFromProject(
  projectId: string,
  docId: string
): Promise<AgentProject | null> {
  assertValidId(docId, 'document ID');
  const project = await getProjectById(projectId);
  if (!project) {
    return null;
  }

  const doc = project.documents.find((item) => item.id === docId);
  if (!doc) {
    return project;
  }

  await cleanupDocumentFiles(doc);

  project.documents = project.documents.filter((item) => item.id !== docId);
  project.updatedAt = new Date().toISOString();
  await saveProjectRecord(project);
  return project;
}

export async function deleteProject(projectId: string): Promise<boolean> {
  const project = await getProjectById(projectId);
  if (!project) {
    return false;
  }

  for (const doc of project.documents) {
    await cleanupDocumentFiles(doc);
  }

  const filePath = resolveInsideDir(PROJECTS_DIR, `${projectId}.json`);
  await fs.unlink(filePath);
  return true;
}

export async function getExtractedDocumentText(docId: string): Promise<string | null> {
  assertValidId(docId, 'document ID');
  const extractedJsonPath = resolveInsideDir(EXTRACTED_DIR, `${docId}.json`);
  try {
    const raw = await fs.readFile(extractedJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as StoredExtractedDocument;
    return parsed.extractedText ?? '';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  // Fallback for legacy .txt extracted files
  const legacyPath = resolveInsideDir(EXTRACTED_DIR, `${docId}.txt`);
  try {
    return await fs.readFile(legacyPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function getProjectExtractedDocuments(
  projectId: string
): Promise<StoredExtractedDocument[]> {
  const project = await getProjectById(projectId);
  if (!project) {
    return [];
  }

  const records: StoredExtractedDocument[] = [];
  for (const doc of project.documents) {
    if (doc.projectId !== project.id || doc.parseStatus !== 'parsed') {
      continue;
    }
    const text = await getExtractedDocumentText(doc.id);
    if (text && text.trim().length > 0) {
      records.push({
        documentId: doc.id,
        projectId: project.id,
        documentName: doc.originalName,
        fileType: doc.fileType,
        sizeBytes: doc.sizeBytes,
        parseStatus: doc.parseStatus,
        csvHeaders: doc.csvHeaders,
        csvRowCount: doc.csvRowCount,
        extractedText: text,
      });
    }
  }
  return records;
}

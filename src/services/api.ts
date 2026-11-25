import type {
  AgentDefinition,
  AgentProject,
  AgentSectionKey,
  AgentValidationResult,
  EvaluationPromptTemplateMeta,
  EvaluationRunRecord,
  EvaluationTestCase,
  EvaluationTestCaseResult,
  EvaluationValidationResult,
  HealthStatus,
  OptimizationRunRecord,
  ProjectSummary,
  StoredDocument,
} from '../types/agent';

export class ApiValidationError extends Error {
  validation?: AgentValidationResult | EvaluationValidationResult;
  constructor(
    message: string,
    validation?: AgentValidationResult | EvaluationValidationResult
  ) {
    super(message);
    this.name = 'ApiValidationError';
    this.validation = validation;
  }
}

export type UploadLifecycleStage = 'uploading' | 'processing';

export interface UploadProgressCallback {
  (stage: UploadLifecycleStage, progressPercent?: number): void;
}

async function handleResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof data?.error === 'string' && data.error.length > 0
        ? data.error
        : `Request failed with status ${response.status}`;
    if (data?.validation) {
      throw new ApiValidationError(message, data.validation as AgentValidationResult);
    }
    throw new Error(message);
  }
  return data as T;
}

function sendMultipartWithProgress<T>(
  url: string,
  formData: FormData,
  onStageChange?: UploadProgressCallback
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);

    onStageChange?.('uploading', 0);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        const pct = Math.min(100, Math.round((event.loaded / event.total) * 100));
        if (pct >= 100) {
          onStageChange?.('processing', 100);
        } else {
          onStageChange?.('uploading', pct);
        }
      }
    };

    xhr.upload.onload = () => {
      onStageChange?.('processing', 100);
    };

    xhr.onload = () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(xhr.responseText || '{}') as Record<string, unknown>;
      } catch {
        // Non-JSON error response fallback
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsed as T);
      } else {
        const errorMessage =
          typeof parsed.error === 'string' && parsed.error.length > 0
            ? parsed.error
            : `Request failed with status ${xhr.status}`;
        reject(new Error(errorMessage));
      }
    };

    xhr.onerror = () => {
      reject(new Error('Network error while uploading documents.'));
    };

    xhr.send(formData);
  });
}

export async function fetchHealth(): Promise<HealthStatus> {
  const res = await fetch('/api/health');
  return handleResponse<HealthStatus>(res);
}

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const res = await fetch('/api/projects');
  const data = await handleResponse<{ projects: ProjectSummary[] }>(res);
  return data.projects;
}

export async function fetchProjectById(projectId: string): Promise<AgentProject> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
  const data = await handleResponse<{ project: AgentProject }>(res);
  return data.project;
}

export async function createAgentProject(
  payload: {
    name: string;
    domain: string;
    targetAudience: string;
    responseTone: string;
    brief: string;
    files: File[];
  },
  onStageChange?: UploadProgressCallback
): Promise<AgentProject> {
  const formData = new FormData();
  formData.append('name', payload.name);
  formData.append('domain', payload.domain);
  formData.append('targetAudience', payload.targetAudience);
  formData.append('responseTone', payload.responseTone);
  formData.append('brief', payload.brief);
  for (const file of payload.files) {
    formData.append('documents', file);
  }

  const data = await sendMultipartWithProgress<{ project: AgentProject }>(
    '/api/projects',
    formData,
    onStageChange
  );
  return data.project;
}

export async function uploadProjectDocuments(
  projectId: string,
  files: File[],
  onStageChange?: UploadProgressCallback
): Promise<AgentProject> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('documents', file);
  }

  const data = await sendMultipartWithProgress<{ project: AgentProject }>(
    `/api/projects/${encodeURIComponent(projectId)}/documents`,
    formData,
    onStageChange
  );
  return data.project;
}

export async function deleteProjectDocument(
  projectId: string,
  docId: string
): Promise<AgentProject> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(docId)}`,
    { method: 'DELETE' }
  );
  const data = await handleResponse<{ project: AgentProject }>(res);
  return data.project;
}

export async function deleteProject(projectId: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
  });
  await handleResponse<{ deleted: boolean }>(res);
}

export async function fetchDocumentExtractedText(
  projectId: string,
  docId: string
): Promise<{ document: StoredDocument; extractedText: string }> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(docId)}/text`
  );
  return handleResponse<{ document: StoredDocument; extractedText: string }>(res);
}

export async function startIntakeInterview(projectId: string): Promise<AgentProject> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/interview/start`,
    { method: 'POST' }
  );
  const data = await handleResponse<{ project: AgentProject }>(res);
  return data.project;
}

export async function submitInterviewAnswer(
  projectId: string,
  payload: { questionId: string; answer: string; skipped: boolean }
): Promise<AgentProject> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/interview/answer`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  const data = await handleResponse<{ project: AgentProject }>(res);
  return data.project;
}

export async function generateRequirements(projectId: string): Promise<AgentProject> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/requirements/generate`,
    { method: 'POST' }
  );
  const data = await handleResponse<{ project: AgentProject }>(res);
  return data.project;
}

export async function updateRequirements(
  projectId: string,
  patch: Partial<AgentProject['requirements']>
): Promise<AgentProject> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/requirements`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }
  );
  const data = await handleResponse<{ project: AgentProject }>(res);
  return data.project;
}

export async function approveRequirements(projectId: string): Promise<AgentProject> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/requirements/approve`,
    { method: 'POST' }
  );
  const data = await handleResponse<{ project: AgentProject }>(res);
  return data.project;
}

export async function generateAgentDefinition(projectId: string): Promise<AgentProject> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/agent/generate`,
    { method: 'POST' }
  );
  const data = await handleResponse<{ project: AgentProject }>(res);
  return data.project;
}

export async function regenerateAgentSection(
  projectId: string,
  section: AgentSectionKey,
  currentDefinition: AgentDefinition
): Promise<{ definition: AgentDefinition; validation: AgentValidationResult }> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/agent/regenerate-section`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section, currentDefinition }),
    }
  );
  return handleResponse<{ definition: AgentDefinition; validation: AgentValidationResult }>(
    res
  );
}

export async function validateAgentDefinition(
  projectId: string,
  definition: unknown
): Promise<{ definition: AgentDefinition; validation: AgentValidationResult }> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/agent/validate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definition }),
    }
  );
  return handleResponse<{ definition: AgentDefinition; validation: AgentValidationResult }>(
    res
  );
}

export async function saveAgentDefinition(
  projectId: string,
  payload: {
    definition: AgentDefinition;
    baseVersion: number | null;
    source: 'generated' | 'section_regenerated' | 'manual_edit';
    notes?: string;
  }
): Promise<{ project: AgentProject; validation: AgentValidationResult }> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/agent/save`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  return handleResponse<{ project: AgentProject; validation: AgentValidationResult }>(res);
}

export async function fetchEvaluationPrompts(): Promise<{
  version: string;
  prompts: EvaluationPromptTemplateMeta[];
}> {
  const res = await fetch('/api/evaluation/prompts');
  return handleResponse<{
    version: string;
    prompts: EvaluationPromptTemplateMeta[];
  }>(res);
}

export async function generateEvaluationDataset(
  projectId: string
): Promise<AgentProject> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/evaluation/generate`,
    { method: 'POST' }
  );
  const data = await handleResponse<{ project: AgentProject }>(res);
  return data.project;
}

export async function regenerateEvaluationTestCase(
  projectId: string,
  payload: {
    testCaseId: string;
    currentTestCases: EvaluationTestCase[];
    instruction?: string;
  }
): Promise<{
  updatedCase: EvaluationTestCase;
  testCases: EvaluationTestCase[];
  validation: EvaluationValidationResult;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/evaluation/regenerate-case`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  return handleResponse<{
    updatedCase: EvaluationTestCase;
    testCases: EvaluationTestCase[];
    validation: EvaluationValidationResult;
  }>(res);
}

export async function validateEvaluationDataset(
  projectId: string,
  testCases: EvaluationTestCase[],
  useAiAudit = false
): Promise<{
  testCases: EvaluationTestCase[];
  validation: EvaluationValidationResult;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/evaluation/validate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testCases, useAiAudit }),
    }
  );
  return handleResponse<{
    testCases: EvaluationTestCase[];
    validation: EvaluationValidationResult;
  }>(res);
}

export async function saveEvaluationDataset(
  projectId: string,
  payload: {
    testCases: EvaluationTestCase[];
    baseVersion: number | null;
    source: 'generated' | 'manual_edit' | 'case_regenerated';
    documentAnalysisSummary?: string;
  }
): Promise<{ project: AgentProject; validation: EvaluationValidationResult }> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/evaluation/save`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  return handleResponse<{
    project: AgentProject;
    validation: EvaluationValidationResult;
  }>(res);
}

export async function createEvaluationRun(projectId: string): Promise<{
  project: AgentProject;
  run: EvaluationRunRecord;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/evaluation/runs`,
    { method: 'POST' }
  );
  return handleResponse<{
    project: AgentProject;
    run: EvaluationRunRecord;
  }>(res);
}

export async function executeEvaluationRunStep(
  projectId: string,
  runId: string,
  testCaseId?: string
): Promise<{
  project: AgentProject;
  run: EvaluationRunRecord;
  executedResult: EvaluationTestCaseResult | null;
  done: boolean;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/evaluation/runs/${encodeURIComponent(runId)}/step`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testCaseId ? { testCaseId } : {}),
    }
  );
  return handleResponse<{
    project: AgentProject;
    run: EvaluationRunRecord;
    executedResult: EvaluationTestCaseResult | null;
    done: boolean;
  }>(res);
}

export async function pauseEvaluationRun(
  projectId: string,
  runId: string
): Promise<{
  project: AgentProject;
  run: EvaluationRunRecord;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/evaluation/runs/${encodeURIComponent(runId)}/pause`,
    { method: 'POST' }
  );
  return handleResponse<{
    project: AgentProject;
    run: EvaluationRunRecord;
  }>(res);
}

export async function skipEvaluationTestCase(
  projectId: string,
  runId: string,
  testCaseId?: string,
  reason?: string
): Promise<{
  project: AgentProject;
  run: EvaluationRunRecord;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/evaluation/runs/${encodeURIComponent(runId)}/skip`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testCaseId, reason }),
    }
  );
  return handleResponse<{
    project: AgentProject;
    run: EvaluationRunRecord;
  }>(res);
}

export async function createOptimizationRun(
  projectId: string,
  evaluationRunId?: string
): Promise<{
  project: AgentProject;
  optimizationRun: OptimizationRunRecord;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/optimizer/runs`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(evaluationRunId ? { evaluationRunId } : {}),
    }
  );
  return handleResponse<{
    project: AgentProject;
    optimizationRun: OptimizationRunRecord;
  }>(res);
}

export async function analyzeOptimizationFailures(
  projectId: string,
  optId: string
): Promise<{
  project: AgentProject;
  optimizationRun: OptimizationRunRecord;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/optimizer/runs/${encodeURIComponent(optId)}/analyze`,
    { method: 'POST' }
  );
  return handleResponse<{
    project: AgentProject;
    optimizationRun: OptimizationRunRecord;
  }>(res);
}

export async function submitOptimizationDecisions(
  projectId: string,
  optId: string,
  iterationNumber: number,
  decisions: Array<{ changeId: string; status: 'approved' | 'rejected' }>
): Promise<{
  project: AgentProject;
  optimizationRun: OptimizationRunRecord;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/optimizer/runs/${encodeURIComponent(optId)}/iterations/${iterationNumber}/decisions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisions }),
    }
  );
  return handleResponse<{
    project: AgentProject;
    optimizationRun: OptimizationRunRecord;
  }>(res);
}

export async function applyOptimizationIteration(
  projectId: string,
  optId: string,
  iterationNumber: number
): Promise<{
  project: AgentProject;
  optimizationRun: OptimizationRunRecord;
  evaluationRun: EvaluationRunRecord;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/optimizer/runs/${encodeURIComponent(optId)}/iterations/${iterationNumber}/apply`,
    { method: 'POST' }
  );
  return handleResponse<{
    project: AgentProject;
    optimizationRun: OptimizationRunRecord;
    evaluationRun: EvaluationRunRecord;
  }>(res);
}

export async function finalizeOptimizationIteration(
  projectId: string,
  optId: string,
  iterationNumber: number
): Promise<{
  project: AgentProject;
  optimizationRun: OptimizationRunRecord;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/optimizer/runs/${encodeURIComponent(optId)}/iterations/${iterationNumber}/finalize`,
    { method: 'POST' }
  );
  return handleResponse<{
    project: AgentProject;
    optimizationRun: OptimizationRunRecord;
  }>(res);
}

export async function stopOptimizationRun(
  projectId: string,
  optId: string,
  reason?: string
): Promise<{
  project: AgentProject;
  optimizationRun: OptimizationRunRecord;
}> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/optimizer/runs/${encodeURIComponent(optId)}/stop`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reason ? { reason } : {}),
    }
  );
  return handleResponse<{
    project: AgentProject;
    optimizationRun: OptimizationRunRecord;
  }>(res);
}


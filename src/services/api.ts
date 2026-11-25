import type { AgentProject, HealthStatus, ProjectSummary, StoredDocument } from '../types/agent';

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
    brief: string;
    files: File[];
  },
  onStageChange?: UploadProgressCallback
): Promise<AgentProject> {
  const formData = new FormData();
  formData.append('name', payload.name);
  formData.append('domain', payload.domain);
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

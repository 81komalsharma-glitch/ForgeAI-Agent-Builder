import type { AgentProject, HealthStatus, ProjectSummary, StoredDocument } from '../types/agent';

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

export async function createAgentProject(payload: {
  name: string;
  domain: string;
  brief: string;
  files: File[];
}): Promise<AgentProject> {
  const formData = new FormData();
  formData.append('name', payload.name);
  formData.append('domain', payload.domain);
  formData.append('brief', payload.brief);
  for (const file of payload.files) {
    formData.append('documents', file);
  }

  const res = await fetch('/api/projects', {
    method: 'POST',
    body: formData,
  });
  const data = await handleResponse<{ project: AgentProject }>(res);
  return data.project;
}

export async function uploadProjectDocuments(
  projectId: string,
  files: File[]
): Promise<AgentProject> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('documents', file);
  }

  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/documents`, {
    method: 'POST',
    body: formData,
  });
  const data = await handleResponse<{ project: AgentProject }>(res);
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

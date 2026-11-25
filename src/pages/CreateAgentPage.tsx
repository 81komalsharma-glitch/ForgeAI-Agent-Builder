import { useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Trash2,
  Upload,
  UploadCloud,
} from 'lucide-react';
import {
  createAgentProject,
  deleteProjectDocument,
  fetchDocumentExtractedText,
  uploadProjectDocuments,
} from '../services/api';
import type { AgentProject, NavSectionId, StoredDocument } from '../types/agent';
import { formatBytes } from '../utils/format';

const DOMAIN_OPTIONS = [
  'Customer Support',
  'Education & Research',
  'Operations & HR',
  'Data & Analytics',
  'Legal & Compliance',
  'General',
];

const ALLOWED_EXTENSIONS = ['.pdf', '.txt', '.csv'];
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;

const SAMPLE_BRIEF = {
  name: 'Campus Admissions & Scholarship Advisor',
  domain: 'Education & Research',
  brief:
    'Build an AI assistant for prospective undergraduate applicants. The agent must answer questions about application deadlines, eligibility criteria, required documents, and merit scholarships strictly using the uploaded admissions handbook and fee schedule CSV.\n\nConstraints:\n- Never fabricate scholarship amounts or deadlines not present in the source documents.\n- If a question asks about individual application status or exceptions, direct the student to admissions@university.edu.\n- Keep answers concise, structured, and cite the relevant document section.',
};

interface CreateAgentPageProps {
  onProjectCreated: (project: AgentProject) => void;
  onProjectsChanged: () => void;
  onNavigate: (section: NavSectionId) => void;
}

export function CreateAgentPage({
  onProjectCreated,
  onProjectsChanged,
  onNavigate,
}: CreateAgentPageProps) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState(DOMAIN_OPTIONS[0]);
  const [brief, setBrief] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createdProject, setCreatedProject] = useState<AgentProject | null>(null);

  const [docActionError, setDocActionError] = useState<string | null>(null);
  const [uploadingMore, setUploadingMore] = useState(false);
  const [removingDocId, setRemovingDocId] = useState<string | null>(null);
  const [loadingTextDocId, setLoadingTextDocId] = useState<string | null>(null);
  const [inspectedDoc, setInspectedDoc] = useState<{
    doc: StoredDocument;
    text: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addValidatedFiles = (incoming: FileList | File[]) => {
    const incomingArray = Array.from(incoming);
    const validationErrors: string[] = [];
    const nextFiles = [...files];

    for (const file of incomingArray) {
      const lower = file.name.toLowerCase();
      const hasValidExt = ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));

      if (!hasValidExt) {
        validationErrors.push(
          `"${file.name}" skipped: only PDF, TXT, and CSV files are supported.`
        );
        continue;
      }

      if (file.size > MAX_FILE_SIZE_BYTES) {
        validationErrors.push(
          `"${file.name}" skipped: file exceeds the 10 MB limit.`
        );
        continue;
      }

      const duplicate = nextFiles.some(
        (existing) => existing.name === file.name && existing.size === file.size
      );
      if (duplicate) {
        continue;
      }

      if (nextFiles.length >= MAX_FILES) {
        validationErrors.push(`Maximum of ${MAX_FILES} files per project reached.`);
        break;
      }

      nextFiles.push(file);
    }

    setFiles(nextFiles);
    setError(validationErrors.length > 0 ? validationErrors.join(' ') : null);
  };

  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length > 0) {
      addValidatedFiles(event.target.files);
      event.target.value = '';
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
      addValidatedFiles(event.dataTransfer.files);
    }
  };

  const removeFileAt = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleLoadSample = () => {
    setName(SAMPLE_BRIEF.name);
    setDomain(SAMPLE_BRIEF.domain);
    setBrief(SAMPLE_BRIEF.brief);
    setError(null);
  };

  const handleReset = () => {
    setName('');
    setDomain(DOMAIN_OPTIONS[0]);
    setBrief('');
    setFiles([]);
    setError(null);
    setDocActionError(null);
    setInspectedDoc(null);
    setCreatedProject(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setDocActionError(null);
    setInspectedDoc(null);

    const trimmedName = name.trim();
    const trimmedBrief = brief.trim();

    if (trimmedName.length < 2) {
      setError('Please enter a project name (at least 2 characters).');
      return;
    }

    if (trimmedBrief.length < 20) {
      setError(
        'Please write a project brief of at least 20 characters describing your agent requirements.'
      );
      return;
    }

    setSubmitting(true);
    try {
      const project = await createAgentProject({
        name: trimmedName,
        domain,
        brief: trimmedBrief,
        files,
      });
      setCreatedProject(project);
      setFiles([]);
      onProjectCreated(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agent project.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUploadMoreToProject = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    if (!createdProject || !event.target.files || event.target.files.length === 0) {
      return;
    }
    const incoming = Array.from(event.target.files);
    event.target.value = '';
    setDocActionError(null);

    for (const file of incoming) {
      const lower = file.name.toLowerCase();
      if (!ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
        setDocActionError(
          `Unsupported file "${file.name}". Only PDF, TXT, and CSV files are accepted.`
        );
        return;
      }
      if (file.size > MAX_FILE_SIZE_BYTES) {
        setDocActionError(`"${file.name}" exceeds the 10 MB maximum file size.`);
        return;
      }
    }

    if (createdProject.documents.length + incoming.length > MAX_FILES) {
      const remaining = Math.max(0, MAX_FILES - createdProject.documents.length);
      setDocActionError(
        `Maximum ${MAX_FILES} files per project (${remaining} slots remaining).`
      );
      return;
    }

    setUploadingMore(true);
    try {
      const updated = await uploadProjectDocuments(createdProject.id, incoming);
      setCreatedProject(updated);
      onProjectsChanged();
    } catch (err) {
      setDocActionError(
        err instanceof Error ? err.message : 'Failed to upload additional documents.'
      );
    } finally {
      setUploadingMore(false);
    }
  };

  const handleRemoveSavedDocument = async (docId: string) => {
    if (!createdProject) return;
    setRemovingDocId(docId);
    setDocActionError(null);

    try {
      const updated = await deleteProjectDocument(createdProject.id, docId);
      setCreatedProject(updated);
      if (inspectedDoc?.doc.id === docId) {
        setInspectedDoc(null);
      }
      onProjectsChanged();
    } catch (err) {
      setDocActionError(
        err instanceof Error ? err.message : 'Failed to remove uploaded document.'
      );
    } finally {
      setRemovingDocId(null);
    }
  };

  const handleInspectSavedDocument = async (doc: StoredDocument) => {
    if (!createdProject) return;
    if (inspectedDoc?.doc.id === doc.id) {
      setInspectedDoc(null);
      return;
    }

    setLoadingTextDocId(doc.id);
    setDocActionError(null);
    try {
      const data = await fetchDocumentExtractedText(createdProject.id, doc.id);
      setInspectedDoc({ doc: data.document, text: data.extractedText });
    } catch (err) {
      setDocActionError(
        err instanceof Error ? err.message : 'Failed to load extracted document text.'
      );
    } finally {
      setLoadingTextDocId(null);
    }
  };

  const renderStatusIndicator = (doc: StoredDocument) => {
    if (doc.parseStatus === 'parsed') {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>Processed</span>
        </span>
      );
    }
    if (doc.parseStatus === 'empty') {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>No Readable Text</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span>Extraction Failed</span>
      </span>
    );
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            Create Agent
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Define your agent project brief and upload PDF, TXT, or CSV knowledge documents.
          </p>
        </div>

        <button
          type="button"
          onClick={handleLoadSample}
          className="px-3.5 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 self-start sm:self-auto"
        >
          Load Sample Brief
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Project Brief & Upload Form */}
        <form
          onSubmit={handleSubmit}
          className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-5"
        >
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="project-name"
                className="block text-sm font-medium text-slate-800 mb-1.5"
              >
                Project Name
              </label>
              <input
                id="project-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., IT Helpdesk Policy Agent"
                maxLength={120}
                required
                className="w-full h-10 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-[#1E3A8A] focus:ring-2 focus:ring-[#1E3A8A]/15"
              />
            </div>

            <div>
              <label
                htmlFor="project-domain"
                className="block text-sm font-medium text-slate-800 mb-1.5"
              >
                Domain
              </label>
              <select
                id="project-domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:border-[#1E3A8A] focus:ring-2 focus:ring-[#1E3A8A]/15"
              >
                {DOMAIN_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label
                htmlFor="project-brief"
                className="block text-sm font-medium text-slate-800"
              >
                Project Description & Requirements Brief
              </label>
              <span className="text-xs font-mono tabular-nums text-slate-500">
                {brief.trim().length} chars
              </span>
            </div>
            <textarea
              id="project-brief"
              rows={7}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Describe the agent's primary purpose, target users, required tasks, tone, grounding rules, and escalation boundaries..."
              required
              className="w-full p-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 leading-relaxed focus:outline-none focus:border-[#1E3A8A] focus:ring-2 focus:ring-[#1E3A8A]/15"
            />
          </div>

          {/* Document Upload Dropzone */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="block text-sm font-medium text-slate-800">
                Knowledge Documents
              </span>
              <span className="text-xs text-slate-500 tabular-nums">
                PDF, TXT, CSV · Max 10 files · 10 MB each
              </span>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={`rounded-xl border border-dashed p-6 text-center transition-colors ${
                isDragging
                  ? 'border-[#1E3A8A] bg-blue-50/50'
                  : 'border-slate-300 bg-slate-50/70 hover:border-slate-400'
              }`}
            >
              <UploadCloud
                className="w-7 h-7 text-[#1E3A8A] mx-auto mb-2"
                aria-hidden="true"
              />
              <p className="text-sm font-medium text-slate-800">
                Drag and drop PDF, TXT, or CSV files here
              </p>
              <p className="text-xs text-slate-500 mt-1">
                Documents are validated and processed on the server when you save.
              </p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mt-3 px-3.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                Browse Files
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.txt,.csv"
                onChange={handleFileInputChange}
                className="sr-only"
              />
            </div>

            {files.length > 0 && (
              <ul className="mt-3 divide-y divide-slate-100 border border-slate-200 rounded-lg bg-white">
                {files.map((file, idx) => {
                  const isCsv = file.name.toLowerCase().endsWith('.csv');
                  return (
                    <li
                      key={`${file.name}-${file.size}-${idx}`}
                      className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-sm"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {isCsv ? (
                          <FileSpreadsheet
                            className="w-4 h-4 text-[#1E3A8A] shrink-0"
                            aria-hidden="true"
                          />
                        ) : (
                          <FileText
                            className="w-4 h-4 text-[#1E3A8A] shrink-0"
                            aria-hidden="true"
                          />
                        )}
                        <span className="truncate font-medium text-slate-800">
                          {file.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-xs font-mono tabular-nums text-slate-500">
                          {formatBytes(file.size)} · Queued
                        </span>
                        <button
                          type="button"
                          onClick={() => removeFileAt(idx)}
                          className="p-1 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50"
                          aria-label={`Remove ${file.name}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="pt-2 flex flex-wrap items-center justify-end gap-3 border-t border-slate-100">
            <button
              type="button"
              onClick={handleReset}
              className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              Clear Form
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 rounded-lg bg-[#1E3A8A] text-white text-sm font-medium hover:bg-[#1E40AF] disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Saving & Processing...' : 'Save Project'}
            </button>
          </div>
        </form>

        {/* Right: Guidance or Created Project & Processed Documents */}
        <div className="lg:col-span-5 space-y-5">
          {createdProject ? (
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <div className="flex items-start gap-3">
                <CheckCircle2
                  className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-slate-900">
                    Project Saved
                  </h2>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Associated documents have been processed and stored with this project.
                  </p>
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs space-y-1.5">
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">Name</span>
                  <span className="font-medium text-slate-900 truncate">
                    {createdProject.name}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">Domain</span>
                  <span className="text-slate-800">{createdProject.domain}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-slate-500">Project ID</span>
                  <span className="font-mono text-slate-700 truncate max-w-[190px]">
                    {createdProject.id}
                  </span>
                </div>
              </div>

              {docActionError && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700"
                >
                  {docActionError}
                </div>
              )}

              <div>
                <div className="flex items-center justify-between gap-2 mb-2.5">
                  <h3 className="text-xs font-semibold text-slate-800 tabular-nums">
                    Uploaded Documents ({createdProject.documents.length} / {MAX_FILES})
                  </h3>

                  {createdProject.documents.length < MAX_FILES && (
                    <label className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer">
                      <Upload className="w-3 h-3" aria-hidden="true" />
                      <span>{uploadingMore ? 'Uploading...' : 'Add Files'}</span>
                      <input
                        type="file"
                        multiple
                        accept=".pdf,.txt,.csv"
                        onChange={handleUploadMoreToProject}
                        disabled={uploadingMore}
                        className="sr-only"
                      />
                    </label>
                  )}
                </div>

                {createdProject.documents.length === 0 ? (
                  <p className="text-xs text-slate-500 py-2">
                    No documents uploaded with this project.
                  </p>
                ) : (
                  <ul className="space-y-2.5">
                    {createdProject.documents.map((doc) => (
                      <li
                        key={doc.id}
                        className="rounded-lg border border-slate-200 p-3 text-xs space-y-2"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-medium text-slate-900 truncate">
                              {doc.originalName}
                            </p>
                            <p className="text-slate-500 font-mono tabular-nums mt-0.5">
                              {doc.fileType.toUpperCase()} · {formatBytes(doc.sizeBytes)}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {renderStatusIndicator(doc)}
                          </div>
                        </div>

                        {doc.parseStatus === 'parsed' ? (
                          <div className="text-slate-600 tabular-nums space-y-1">
                            {doc.fileType === 'csv' ? (
                              <>
                                <p>
                                  {doc.csvRowCount ?? 0} rows · {doc.csvHeaders?.length ?? 0}{' '}
                                  columns
                                </p>
                                {doc.csvHeaders && doc.csvHeaders.length > 0 && (
                                  <p className="text-slate-500 break-words">
                                    Columns: {doc.csvHeaders.join(', ')}
                                  </p>
                                )}
                              </>
                            ) : doc.fileType === 'pdf' ? (
                              <p>
                                Extracted {doc.charCount.toLocaleString()} chars across{' '}
                                {doc.pageCount ?? 0} pages
                              </p>
                            ) : (
                              <p>
                                Extracted {doc.charCount.toLocaleString()} chars across{' '}
                                {doc.lineCount.toLocaleString()} lines
                              </p>
                            )}
                          </div>
                        ) : (
                          <p
                            className={
                              doc.parseStatus === 'error'
                                ? 'text-red-700'
                                : 'text-amber-700'
                            }
                          >
                            {doc.parseNote ?? 'Document could not be read.'}
                          </p>
                        )}

                        <div className="pt-1.5 border-t border-slate-100 flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => handleInspectSavedDocument(doc)}
                            disabled={loadingTextDocId === doc.id}
                            className="inline-flex items-center gap-1 text-xs font-medium text-[#1E3A8A] hover:underline disabled:opacity-50"
                          >
                            <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>
                              {loadingTextDocId === doc.id
                                ? 'Loading...'
                                : inspectedDoc?.doc.id === doc.id
                                  ? 'Hide Text'
                                  : 'View Extracted Text'}
                            </span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleRemoveSavedDocument(doc.id)}
                            disabled={removingDocId === doc.id}
                            className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-red-600 disabled:opacity-50"
                          >
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>
                              {removingDocId === doc.id ? 'Removing...' : 'Remove'}
                            </span>
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {inspectedDoc && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-800 truncate">
                      Extracted Text: {inspectedDoc.doc.originalName}
                    </span>
                    <button
                      type="button"
                      onClick={() => setInspectedDoc(null)}
                      className="text-xs text-slate-500 hover:text-slate-900"
                    >
                      Close
                    </button>
                  </div>
                  <pre className="rounded-lg border border-slate-200 bg-slate-950 text-slate-100 p-3 text-xs font-mono overflow-x-auto max-h-52 whitespace-pre-wrap leading-relaxed">
                    {inspectedDoc.text.length > 0
                      ? inspectedDoc.text
                      : '(No readable text extracted from this file.)'}
                  </pre>
                </div>
              )}

              <div className="pt-2 flex flex-wrap items-center gap-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => onNavigate('dashboard')}
                  className="px-3.5 py-2 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF] transition-colors"
                >
                  View on Dashboard
                </button>
                <a
                  href={`/api/projects/${encodeURIComponent(createdProject.id)}/export`}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Download JSON</span>
                </a>
              </div>
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <h2 className="text-base font-semibold text-slate-900">
                Brief Writing Guide
              </h2>
              <p className="text-xs text-slate-600 leading-relaxed">
                A clear project brief gives the upcoming Requirements and Agent Builder modules accurate constraints to work from.
              </p>

              <ul className="space-y-3 text-xs text-slate-700">
                <li className="pb-3 border-b border-slate-100">
                  <span className="font-semibold text-slate-900 block">
                    1. Role & Target Users
                  </span>
                  Specify who will interact with the agent and what questions or tasks it should handle.
                </li>
                <li className="pb-3 border-b border-slate-100">
                  <span className="font-semibold text-slate-900 block">
                    2. Grounding & Boundaries
                  </span>
                  State whether answers must stay strictly within uploaded files and how the agent should respond when information is missing.
                </li>
                <li>
                  <span className="font-semibold text-slate-900 block">
                    3. Supported Document Formats
                  </span>
                  Upload <span className="font-mono">PDF</span> (text-based),{' '}
                  <span className="font-mono">TXT</span>, or{' '}
                  <span className="font-mono">CSV</span> files. The server extracts text, CSV columns/rows, and metadata automatically.
                </li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

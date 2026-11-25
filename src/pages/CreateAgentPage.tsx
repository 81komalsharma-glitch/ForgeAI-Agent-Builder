import { useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Loader2,
  Trash2,
  Upload,
  UploadCloud,
} from 'lucide-react';
import {
  createAgentProject,
  deleteProjectDocument,
  fetchDocumentExtractedText,
  uploadProjectDocuments,
  type UploadLifecycleStage,
} from '../services/api';
import type { AgentProject, NavSectionId, StoredDocument } from '../types/agent';
import {
  MAX_FILES_PER_PROJECT,
  validateCandidateFiles,
} from '../utils/fileValidation';
import { formatBytes } from '../utils/format';

const DOMAIN_OPTIONS = [
  'Customer Support',
  'Education & Research',
  'Operations & HR',
  'Data & Analytics',
  'Legal & Compliance',
  'General',
];

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
  const [uploadStage, setUploadStage] = useState<{
    stage: UploadLifecycleStage;
    progressPercent: number;
  } | null>(null);
  const [createdProject, setCreatedProject] = useState<AgentProject | null>(null);

  const [docActionError, setDocActionError] = useState<string | null>(null);
  const [uploadingMoreStage, setUploadingMoreStage] = useState<{
    stage: UploadLifecycleStage;
    progressPercent: number;
  } | null>(null);
  const [removingDocId, setRemovingDocId] = useState<string | null>(null);
  const [loadingTextDocId, setLoadingTextDocId] = useState<string | null>(null);
  const [inspectedDoc, setInspectedDoc] = useState<{
    doc: StoredDocument;
    text: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addValidatedFiles = (incoming: FileList | File[]) => {
    const { accepted, errors } = validateCandidateFiles(
      incoming,
      files,
      MAX_FILES_PER_PROJECT
    );
    if (accepted.length > 0) {
      setFiles((prev) => [...prev, ...accepted]);
    }
    setError(errors.length > 0 ? errors.join(' ') : null);
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
    setUploadStage(null);
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
    setUploadStage({ stage: 'uploading', progressPercent: 0 });
    try {
      const project = await createAgentProject(
        {
          name: trimmedName,
          domain,
          brief: trimmedBrief,
          files,
        },
        (stage, pct = 0) => {
          setUploadStage({ stage, progressPercent: pct });
        }
      );
      setCreatedProject(project);
      setFiles([]);
      onProjectCreated(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agent project.');
    } finally {
      setSubmitting(false);
      setUploadStage(null);
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

    const existingForCheck = createdProject.documents.map((doc) => ({
      name: doc.originalName,
    }));
    const { accepted, errors } = validateCandidateFiles(
      incoming,
      existingForCheck,
      MAX_FILES_PER_PROJECT
    );

    if (errors.length > 0) {
      setDocActionError(errors.join(' '));
      return;
    }

    if (accepted.length === 0) {
      return;
    }

    setUploadingMoreStage({ stage: 'uploading', progressPercent: 0 });
    try {
      const updated = await uploadProjectDocuments(
        createdProject.id,
        accepted,
        (stage, pct = 0) => {
          setUploadingMoreStage({ stage, progressPercent: pct });
        }
      );
      setCreatedProject(updated);
      onProjectsChanged();
    } catch (err) {
      setDocActionError(
        err instanceof Error ? err.message : 'Failed to upload additional documents.'
      );
    } finally {
      setUploadingMoreStage(null);
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
          <span>Successfully processed</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span>Failed</span>
      </span>
    );
  };

  const renderQueuedStatusLabel = () => {
    if (!submitting || !uploadStage) return 'Ready to upload';
    if (uploadStage.stage === 'uploading') {
      return `Uploading (${uploadStage.progressPercent}%)`;
    }
    return 'Processing';
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
                disabled={submitting}
                className="mt-3 px-3.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50"
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
                          {formatBytes(file.size)} · {renderQueuedStatusLabel()}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeFileAt(idx)}
                          disabled={submitting}
                          className="p-1 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40"
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

          <div className="pt-2 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100">
            <div className="text-xs text-slate-600 tabular-nums">
              {submitting && uploadStage && (
                <span className="inline-flex items-center gap-1.5 font-medium text-[#1E3A8A]">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                  <span>
                    {uploadStage.stage === 'uploading'
                      ? `Uploading (${uploadStage.progressPercent}%)...`
                      : 'Processing documents on server...'}
                  </span>
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleReset}
                disabled={submitting}
                className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50"
              >
                Clear Form
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-5 py-2 rounded-lg bg-[#1E3A8A] text-white text-sm font-medium hover:bg-[#1E40AF] disabled:opacity-50 transition-colors"
              >
                {submitting
                  ? uploadStage?.stage === 'uploading'
                    ? 'Uploading...'
                    : 'Processing...'
                  : 'Save Project'}
              </button>
            </div>
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
                    Documents are stored and linked to this project.
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
                    Uploaded Documents ({createdProject.documents.length} /{' '}
                    {MAX_FILES_PER_PROJECT})
                  </h3>

                  {createdProject.documents.length < MAX_FILES_PER_PROJECT && (
                    <label className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer">
                      <Upload className="w-3 h-3" aria-hidden="true" />
                      <span>
                        {uploadingMoreStage
                          ? uploadingMoreStage.stage === 'uploading'
                            ? `Uploading (${uploadingMoreStage.progressPercent}%)`
                            : 'Processing...'
                          : 'Add Files'}
                      </span>
                      <input
                        type="file"
                        multiple
                        accept=".pdf,.txt,.csv"
                        onChange={handleUploadMoreToProject}
                        disabled={Boolean(uploadingMoreStage)}
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
                  <ul className="space-y-3">
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
                          <div className="shrink-0">
                            {renderStatusIndicator(doc)}
                          </div>
                        </div>

                        {doc.parseStatus === 'parsed' ? (
                          <div className="text-slate-600 tabular-nums space-y-1.5">
                            {doc.fileType === 'csv' ? (
                              <>
                                <p>
                                  {doc.csvRowCount ?? 0} rows ·{' '}
                                  {doc.csvHeaders?.length ?? 0} columns
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

                            {doc.previewText && (
                              <div className="rounded-md border border-slate-200 bg-slate-50 p-2 font-mono text-[11px] text-slate-700 whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
                                {doc.previewText}
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="text-red-700 bg-red-50 border border-red-200 rounded-md p-2">
                            {doc.parseNote ?? 'Document extraction failed.'}
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
                                  ? 'Hide Full Text'
                                  : 'View Full Text'}
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
                      Full Extracted Text: {inspectedDoc.doc.originalName}
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

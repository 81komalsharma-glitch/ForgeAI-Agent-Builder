import { useEffect, useState } from 'react';
import {
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  deleteProjectDocument,
  fetchDocumentExtractedText,
  fetchProjectById,
  uploadProjectDocuments,
  type UploadLifecycleStage,
} from '../../services/api';
import type { AgentProject, StoredDocument } from '../../types/agent';
import {
  MAX_FILES_PER_PROJECT,
  validateCandidateFiles,
} from '../../utils/fileValidation';
import { formatBytes, formatDateTime, formatStageLabel } from '../../utils/format';

interface ProjectDetailModalProps {
  projectId: string;
  onClose: () => void;
  onProjectUpdated: () => void;
}

export function ProjectDetailModal({
  projectId,
  onClose,
  onProjectUpdated,
}: ProjectDetailModalProps) {
  const [project, setProject] = useState<AgentProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadStage, setUploadStage] = useState<{
    stage: UploadLifecycleStage;
    progressPercent: number;
  } | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{
    doc: StoredDocument;
    text: string;
  } | null>(null);
  const [loadingDocId, setLoadingDocId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchProjectById(projectId)
      .then((data) => {
        if (active) {
          setProject(data);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Unable to load project.');
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [projectId]);

  const handleAddFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    if (!fileList || fileList.length === 0 || !project) return;

    const incoming = Array.from(fileList);
    event.target.value = '';
    setError(null);

    const { accepted, errors } = validateCandidateFiles(
      incoming,
      project.documents.map((d) => ({ name: d.originalName })),
      MAX_FILES_PER_PROJECT
    );
    if (errors.length > 0) {
      setError(errors.join(' '));
      return;
    }
    if (accepted.length === 0) return;

    setUploadStage({ stage: 'uploading', progressPercent: 0 });
    try {
      const updated = await uploadProjectDocuments(
        projectId,
        accepted,
        (stage, pct = 0) => {
          setUploadStage({ stage, progressPercent: pct });
        }
      );
      setProject(updated);
      onProjectUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload documents.');
    } finally {
      setUploadStage(null);
    }
  };

  const handleRemoveDoc = async (docId: string) => {
    setError(null);
    try {
      const updated = await deleteProjectDocument(projectId, docId);
      setProject(updated);
      if (previewDoc?.doc.id === docId) {
        setPreviewDoc(null);
      }
      onProjectUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove document.');
    }
  };

  const handleInspectDocument = async (doc: StoredDocument) => {
    setLoadingDocId(doc.id);
    setError(null);
    try {
      const data = await fetchDocumentExtractedText(projectId, doc.id);
      setPreviewDoc({ doc: data.document, text: data.extractedText });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read document text.');
    } finally {
      setLoadingDocId(null);
    }
  };

  const renderDocIcon = (fileType: StoredDocument['fileType']) => {
    if (fileType === 'csv') {
      return <FileSpreadsheet className="w-4 h-4 text-[#1E3A8A] shrink-0" aria-hidden="true" />;
    }
    return <FileText className="w-4 h-4 text-[#1E3A8A] shrink-0" aria-hidden="true" />;
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-detail-title"
    >
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-4xl max-h-[88vh] flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h2
              id="project-detail-title"
              className="text-lg font-semibold text-slate-900 truncate"
            >
              {project ? project.name : 'Project Details'}
            </h2>
            {project && (
              <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                {project.domain} · {formatStageLabel(project.stage)} · Updated{' '}
                {formatDateTime(project.updatedAt)}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {project && (
              <a
                href={`/api/projects/${encodeURIComponent(project.id)}/export`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Export JSON</span>
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100"
              aria-label="Close project details"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
              {error}
            </div>
          )}

          {loading ? (
            <div className="space-y-4">
              <div className="h-24 bg-slate-100 rounded-lg" />
              <div className="h-40 bg-slate-100 rounded-lg" />
            </div>
          ) : project ? (
            <>
              {/* Project Brief */}
              <section>
                <h3 className="text-sm font-semibold text-slate-900 mb-2">
                  Project Brief
                </h3>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">
                  {project.brief}
                </div>
              </section>

              {/* Uploaded Knowledge Documents */}
              <section>
                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900 tabular-nums">
                      Knowledge Documents ({project.documents.length} / 10)
                    </h3>
                    <p className="text-xs text-slate-500">
                      Supported formats: PDF, TXT, CSV (up to 10 MB per file).
                    </p>
                  </div>

                  {project.documents.length < MAX_FILES_PER_PROJECT && (
                    <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1E3A8A] text-white text-xs font-medium hover:bg-[#1E40AF] cursor-pointer transition-colors">
                      <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>
                        {uploadStage
                          ? uploadStage.stage === 'uploading'
                            ? `Uploading (${uploadStage.progressPercent}%)`
                            : 'Processing...'
                          : 'Add Documents'}
                      </span>
                      <input
                        type="file"
                        multiple
                        accept=".pdf,.txt,.csv"
                        onChange={handleAddFiles}
                        disabled={Boolean(uploadStage)}
                        className="sr-only"
                      />
                    </label>
                  )}
                </div>

                {project.documents.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
                    No knowledge documents attached to this project yet.
                  </div>
                ) : (
                  <div className="border border-slate-200 rounded-lg overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                          <th className="py-2.5 px-4">File</th>
                          <th className="py-2.5 px-4">Type</th>
                          <th className="py-2.5 px-4 text-right">Size</th>
                          <th className="py-2.5 px-4">Status & Details</th>
                          <th className="py-2.5 px-4 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-sm">
                        {project.documents.map((doc) => (
                          <tr key={doc.id} className="hover:bg-slate-50/70">
                            <td className="py-2.5 px-4 font-medium text-slate-900">
                              <div className="flex items-center gap-2 min-w-0">
                                {renderDocIcon(doc.fileType)}
                                <span className="truncate max-w-[220px]">
                                  {doc.originalName}
                                </span>
                              </div>
                            </td>
                            <td className="py-2.5 px-4 text-xs font-mono uppercase text-slate-600">
                              {doc.fileType}
                            </td>
                            <td className="py-2.5 px-4 text-xs font-mono tabular-nums text-slate-600 text-right">
                              {formatBytes(doc.sizeBytes)}
                            </td>
                            <td className="py-2.5 px-4 text-xs text-slate-600 tabular-nums">
                              {doc.parseStatus !== 'parsed' ? (
                                <span className="text-red-700 font-medium">
                                  Failed: {doc.parseNote ?? 'Document extraction failed.'}
                                </span>
                              ) : doc.fileType === 'csv' ? (
                                <span>
                                  <span className="text-emerald-700 font-medium">
                                    Successfully processed
                                  </span>{' '}
                                  · {doc.csvRowCount ?? 0} rows (
                                  {doc.csvHeaders?.join(', ') || 'no headers'})
                                </span>
                              ) : doc.fileType === 'pdf' ? (
                                <span>
                                  <span className="text-emerald-700 font-medium">
                                    Successfully processed
                                  </span>{' '}
                                  · {doc.pageCount ?? 0} pages ·{' '}
                                  {doc.charCount.toLocaleString()} chars
                                </span>
                              ) : (
                                <span>
                                  <span className="text-emerald-700 font-medium">
                                    Successfully processed
                                  </span>{' '}
                                  · {doc.lineCount.toLocaleString()} lines ·{' '}
                                  {doc.charCount.toLocaleString()} chars
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 px-4 text-right">
                              <div className="inline-flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => handleInspectDocument(doc)}
                                  disabled={loadingDocId === doc.id}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-[#1E3A8A] hover:bg-blue-50"
                                >
                                  <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                                  <span>{loadingDocId === doc.id ? 'Loading...' : 'Inspect'}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleRemoveDoc(doc.id)}
                                  className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50"
                                  aria-label={`Remove ${doc.originalName}`}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* Extracted Text Inspector */}
              {previewDoc && (
                <section>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-slate-900">
                      Extracted Content: {previewDoc.doc.originalName}
                    </h3>
                    <button
                      type="button"
                      onClick={() => setPreviewDoc(null)}
                      className="text-xs text-slate-500 hover:text-slate-900"
                    >
                      Hide Preview
                    </button>
                  </div>
                  <pre className="rounded-lg border border-slate-200 bg-slate-950 text-slate-100 p-4 text-xs font-mono overflow-x-auto max-h-64 whitespace-pre-wrap leading-relaxed">
                    {previewDoc.text.length > 0
                      ? previewDoc.text
                      : '(No extractable text found in this file.)'}
                  </pre>
                </section>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

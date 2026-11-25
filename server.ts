import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import {
  coerceAgentDefinitionInput,
  generateFullAgentDefinition,
  regenerateAgentSection,
  validateAgentDefinition,
} from './server/agentBuilder.ts';
import {
  assertEvaluationPrerequisites,
  auditEvaluationSetWithGemini,
  coerceEvaluationTestCases,
  generateEvaluationDataset,
  regenerateSingleTestCase,
  validateEvaluationTestCases,
} from './server/evaluation.ts';
import { detectAllowedFileType } from './server/documents.ts';
import { isGeminiConfigured } from './server/gemini.ts';
import {
  EVALUATION_PROMPT_TEMPLATES,
  EVALUATION_PROMPT_VERSION,
} from './server/prompts/evaluationPrompts.ts';
import {
  applyEditableRequirementsPatch,
  generateClarificationQuestions,
  generateStructuredRequirementsAndGroundability,
} from './server/requirements.ts';
import {
  addDocumentsToProject,
  createProject,
  deleteProject,
  ensureStorageDirs,
  getExtractedDocumentText,
  getProjectById,
  getProjectExtractedDocuments,
  listProjects,
  MAX_FILES_PER_PROJECT,
  removeDocumentFromProject,
  saveProjectAgentConfig,
  saveProjectEvaluation,
  saveProjectIntakeInterview,
  saveProjectRequirements,
  type IncomingUploadedFile,
} from './server/storage.ts';
import type {
  AgentSectionKey,
  AgentVersionRecord,
  EvaluationDatasetVersion,
} from './server/types.ts';

const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per document
const MAX_FILES_PER_REQUEST = MAX_FILES_PER_PROJECT;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_FILES_PER_REQUEST,
  },
  fileFilter: (_req, file, callback) => {
    const allowed = detectAllowedFileType(file.originalname);
    if (!allowed) {
      callback(new Error(`Unsupported file "${file.originalname}". Only PDF, TXT, and CSV files are accepted.`));
      return;
    }
    callback(null, true);
  },
});

function toIncomingFiles(files: Express.Multer.File[] | undefined): IncomingUploadedFile[] {
  if (!files) return [];
  return files.map((file) => ({
    originalName: file.originalname,
    mimeType: file.mimetype || 'application/octet-stream',
    sizeBytes: file.size,
    buffer: file.buffer,
  }));
}

async function startServer(): Promise<void> {
  await ensureStorageDirs();

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      geminiConfigured: isGeminiConfigured(),
      supportedDocumentTypes: ['pdf', 'txt', 'csv'],
    });
  });

  app.get('/api/projects', async (_req, res) => {
    try {
      const projects = await listProjects();
      res.json({ projects });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list projects.';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/projects/:id', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      res.json({ project });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch project.';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/projects/:id/export', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      const safeSlug = project.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'project';
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${safeSlug}-forgeai.json"`);
      res.send(JSON.stringify(project, null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to export project.';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/projects/:id/documents/:docId/text', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      const doc = project.documents.find((item) => item.id === req.params.docId);
      if (!doc) {
        res.status(404).json({ error: 'Document not found in this project.' });
        return;
      }
      const text = await getExtractedDocumentText(doc.id);
      res.json({
        document: doc,
        extractedText: text ?? '',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read document text.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/projects', upload.array('documents', MAX_FILES_PER_REQUEST), async (req, res) => {
    try {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const domain = typeof req.body?.domain === 'string' ? req.body.domain.trim() : 'General';
      const targetAudience =
        typeof req.body?.targetAudience === 'string' ? req.body.targetAudience.trim() : '';
      const responseTone =
        typeof req.body?.responseTone === 'string' ? req.body.responseTone.trim() : '';
      const brief = typeof req.body?.brief === 'string' ? req.body.brief.trim() : '';

      if (name.length < 2 || name.length > 120) {
        res.status(400).json({ error: 'Project name must be between 2 and 120 characters.' });
        return;
      }

      if (brief.length < 20) {
        res.status(400).json({
          error: 'Please provide a project brief of at least 20 characters describing what the agent should do.',
        });
        return;
      }

      const files = toIncomingFiles(req.files as Express.Multer.File[] | undefined);
      const project = await createProject({
        name,
        domain: domain || 'General',
        targetAudience,
        responseTone,
        brief,
        files,
      });

      res.status(201).json({ project });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create project.';
      res.status(500).json({ error: message });
    }
  });

  // Start or restart AI clarification interview
  app.post('/api/projects/:id/interview/start', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (!isGeminiConfigured()) {
        res.status(503).json({
          error: 'GEMINI_API_KEY is not configured on the server. Add it in Settings > Secrets.',
        });
        return;
      }

      const extractedDocs = await getProjectExtractedDocuments(project.id);
      const { analysisSummary, questions } = await generateClarificationQuestions(
        project,
        extractedDocs
      );

      const now = new Date().toISOString();
      const updated = await saveProjectIntakeInterview(project.id, {
        status: questions.length === 0 ? 'completed' : 'in_progress',
        analysisSummary,
        questions,
        answers: [],
        generatedAt: now,
        completedAt: questions.length === 0 ? now : undefined,
      });

      res.json({ project: updated });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to generate clarification interview.';
      const statusCode = message.includes('temporarily unavailable') ? 503 : 500;
      res.status(statusCode).json({ error: message });
    }
  });

  // Submit or skip an answer to a clarification question
  app.post('/api/projects/:id/interview/answer', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (!project.intakeInterview) {
        res.status(400).json({ error: 'Intake interview has not been started yet.' });
        return;
      }

      const questionId =
        typeof req.body?.questionId === 'string' ? req.body.questionId.trim() : '';
      const skipped = Boolean(req.body?.skipped);
      const answerText =
        typeof req.body?.answer === 'string' ? req.body.answer.trim() : '';

      const targetQuestion = project.intakeInterview.questions.find(
        (q) => q.id === questionId
      );
      if (!targetQuestion) {
        res.status(400).json({ error: 'Question not found in current interview.' });
        return;
      }

      if (!skipped && answerText.length === 0) {
        res.status(400).json({
          error: 'Please enter an answer or choose Skip Question.',
        });
        return;
      }

      const existingAnswers = project.intakeInterview.answers.filter(
        (a) => a.questionId !== questionId
      );
      existingAnswers.push({
        questionId,
        question: targetQuestion.question,
        answer: skipped ? '' : answerText,
        skipped,
      });

      // Keep answers ordered to match questions
      const orderedAnswers = project.intakeInterview.questions
        .map((q) => existingAnswers.find((a) => a.questionId === q.id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));

      const allAnswered =
        orderedAnswers.length >= project.intakeInterview.questions.length;

      const updated = await saveProjectIntakeInterview(project.id, {
        ...project.intakeInterview,
        answers: orderedAnswers,
        status: allAnswered ? 'completed' : 'in_progress',
        completedAt: allAnswered ? new Date().toISOString() : undefined,
      });

      res.json({ project: updated });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to save interview answer.';
      res.status(400).json({ error: message });
    }
  });

  // Generate structured requirements + Groundability Guard
  app.post('/api/projects/:id/requirements/generate', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (!isGeminiConfigured()) {
        res.status(503).json({
          error: 'GEMINI_API_KEY is not configured on the server. Add it in Settings > Secrets.',
        });
        return;
      }

      const extractedDocs = await getProjectExtractedDocuments(project.id);
      const answers = project.intakeInterview?.answers ?? [];
      const requirements = await generateStructuredRequirementsAndGroundability(
        project,
        extractedDocs,
        answers
      );

      const updated = await saveProjectRequirements(
        project.id,
        requirements,
        'requirements_draft'
      );

      res.json({ project: updated });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to generate requirements.';
      const statusCode = message.includes('temporarily unavailable') ? 503 : 500;
      res.status(statusCode).json({ error: message });
    }
  });

  // Save edited structured requirements
  app.put('/api/projects/:id/requirements', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (!project.requirements) {
        res.status(400).json({
          error: 'Generate requirements before saving edits.',
        });
        return;
      }

      const patched = applyEditableRequirementsPatch(
        project.requirements,
        req.body ?? {}
      );
      const updated = await saveProjectRequirements(
        project.id,
        patched,
        'requirements_draft'
      );

      res.json({ project: updated });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to save requirements edits.';
      res.status(400).json({ error: message });
    }
  });

  // Approve requirements to unlock Agent Builder
  app.post('/api/projects/:id/requirements/approve', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (!project.requirements) {
        res.status(400).json({
          error: 'Requirements must be generated before they can be approved.',
        });
        return;
      }

      const now = new Date().toISOString();
      const approvedRequirements = {
        ...project.requirements,
        approved: true,
        approvedAt: now,
        updatedAt: now,
      };

      const updated = await saveProjectRequirements(
        project.id,
        approvedRequirements,
        'requirements_ready'
      );

      res.json({ project: updated });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to approve requirements.';
      res.status(400).json({ error: message });
    }
  });

  // Generate complete declarative Agent Definition (creates a new version, preserving history)
  app.post('/api/projects/:id/agent/generate', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (!project.requirements?.approved) {
        res.status(400).json({
          error: 'Requirements must be approved before generating an agent definition.',
        });
        return;
      }
      if (!isGeminiConfigured()) {
        res.status(503).json({
          error: 'GEMINI_API_KEY is not configured on the server. Add it in Settings > Secrets.',
        });
        return;
      }

      const extractedDocs = await getProjectExtractedDocuments(project.id);
      const definition = await generateFullAgentDefinition(project, extractedDocs);
      const validation = validateAgentDefinition(project, definition);

      const existingVersions = project.agentConfig?.versions ?? [];
      const maxVersion = existingVersions.reduce(
        (max, item) => Math.max(max, item.version),
        0
      );
      const nextVersion = maxVersion + 1;
      const now = new Date().toISOString();

      const newRecord: AgentVersionRecord = {
        version: nextVersion,
        createdAt: now,
        updatedAt: now,
        source: 'generated',
        notes: `Generated v${nextVersion} from approved requirements.`,
        definition,
        validation,
      };

      const updated = await saveProjectAgentConfig(project.id, {
        currentVersion: nextVersion,
        versions: [...existingVersions, newRecord],
        savedVersion: project.agentConfig?.savedVersion ?? null,
        savedAt: project.agentConfig?.savedAt ?? null,
      });

      res.json({ project: updated });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to generate agent definition.';
      const statusCode = message.includes('temporarily unavailable') ? 503 : 500;
      res.status(statusCode).json({ error: message });
    }
  });

  // Regenerate a single section without overwriting other sections
  app.post('/api/projects/:id/agent/regenerate-section', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (!project.requirements?.approved) {
        res.status(400).json({
          error: 'Requirements must be approved before regenerating an agent section.',
        });
        return;
      }
      if (!isGeminiConfigured()) {
        res.status(503).json({
          error: 'GEMINI_API_KEY is not configured on the server. Add it in Settings > Secrets.',
        });
        return;
      }

      const section = req.body?.section as AgentSectionKey;
      const validSections: AgentSectionKey[] = [
        'systemPrompt',
        'knowledgeConfig',
        'tools',
        'outputContract',
      ];
      if (!validSections.includes(section)) {
        res.status(400).json({ error: 'Invalid section name for regeneration.' });
        return;
      }

      const currentVersionObj = project.agentConfig?.versions.find(
        (v) => v.version === project.agentConfig?.currentVersion
      );
      const rawCurrent = req.body?.currentDefinition ?? currentVersionObj?.definition;
      if (!rawCurrent) {
        res.status(400).json({
          error: 'Generate an initial agent definition before regenerating a section.',
        });
        return;
      }

      const baseDefinition = coerceAgentDefinitionInput(rawCurrent, project);
      const extractedDocs = await getProjectExtractedDocuments(project.id);
      const updatedDefinition = await regenerateAgentSection(
        project,
        extractedDocs,
        baseDefinition,
        section
      );
      const validation = validateAgentDefinition(project, updatedDefinition);

      res.json({
        definition: updatedDefinition,
        validation,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to regenerate agent section.';
      const statusCode = message.includes('temporarily unavailable') ? 503 : 500;
      res.status(statusCode).json({ error: message });
    }
  });

  // Validate an agent definition on the backend
  app.post('/api/projects/:id/agent/validate', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }

      const definition = coerceAgentDefinitionInput(req.body?.definition, project);
      const validation = validateAgentDefinition(project, definition);
      res.json({ definition, validation });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Invalid agent definition JSON.';
      res.status(400).json({ error: message });
    }
  });

  // Save and version a validated agent definition
  app.put('/api/projects/:id/agent/save', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (!project.requirements?.approved) {
        res.status(400).json({
          error: 'Requirements must be approved before saving an agent definition.',
        });
        return;
      }

      const definition = coerceAgentDefinitionInput(req.body?.definition, project);
      const validation = validateAgentDefinition(project, definition);
      if (!validation.valid) {
        res.status(400).json({
          error: validation.errors[0]?.message || 'Agent definition failed validation.',
          validation,
        });
        return;
      }

      const existingVersions = project.agentConfig?.versions ?? [];
      const baseVersion =
        typeof req.body?.baseVersion === 'number' ? req.body.baseVersion : null;
      const source =
        req.body?.source === 'section_regenerated' || req.body?.source === 'generated'
          ? req.body.source
          : 'manual_edit';

      const now = new Date().toISOString();
      const matchingExisting =
        baseVersion !== null
          ? existingVersions.find((v) => v.version === baseVersion)
          : undefined;

      const isUnchangedFromBase =
        Boolean(matchingExisting) &&
        JSON.stringify(matchingExisting?.definition) === JSON.stringify(definition);

      let nextVersions: AgentVersionRecord[];
      let savedVersionNumber: number;

      if (isUnchangedFromBase && matchingExisting) {
        savedVersionNumber = matchingExisting.version;
        nextVersions = existingVersions.map((v) =>
          v.version === matchingExisting.version
            ? { ...v, updatedAt: now, validation }
            : v
        );
      } else {
        const maxVersion = existingVersions.reduce(
          (max, item) => Math.max(max, item.version),
          0
        );
        savedVersionNumber = maxVersion + 1;
        const newRecord: AgentVersionRecord = {
          version: savedVersionNumber,
          createdAt: now,
          updatedAt: now,
          source,
          notes:
            typeof req.body?.notes === 'string' && req.body.notes.trim().length > 0
              ? req.body.notes.trim()
              : `Saved v${savedVersionNumber}.`,
          definition,
          validation,
        };
        nextVersions = [...existingVersions, newRecord];
      }

      const updated = await saveProjectAgentConfig(
        project.id,
        {
          currentVersion: savedVersionNumber,
          versions: nextVersions,
          savedVersion: savedVersionNumber,
          savedAt: now,
        },
        'agent_built'
      );

      res.json({ project: updated, validation });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to save agent definition.';
      res.status(400).json({ error: message });
    }
  });

  // Expose versioned evaluation prompt templates for transparency
  app.get('/api/evaluation/prompts', (_req, res) => {
    res.json({
      version: EVALUATION_PROMPT_VERSION,
      prompts: EVALUATION_PROMPT_TEMPLATES,
    });
  });

  // Automatically generate >= 20 grounded evaluation test cases (preserves prior versions)
  app.post('/api/projects/:id/evaluation/generate', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }

      const extractedDocs = await getProjectExtractedDocuments(project.id);
      try {
        assertEvaluationPrerequisites(project, extractedDocs, {
          requireDocuments: true,
        });
      } catch (prereqError) {
        res.status(400).json({
          error:
            prereqError instanceof Error
              ? prereqError.message
              : 'Evaluation prerequisites are not met.',
        });
        return;
      }

      if (!isGeminiConfigured()) {
        res.status(503).json({
          error:
            'GEMINI_API_KEY is not configured on the server. Add it in Settings > Secrets.',
        });
        return;
      }

      const generated = await generateEvaluationDataset(project, extractedDocs);
      const existingVersions = project.evaluation?.versions ?? [];
      const maxVersion = existingVersions.reduce(
        (max, item) => Math.max(max, item.version),
        0
      );
      const nextVersion = maxVersion + 1;
      const now = new Date().toISOString();

      const newRecord: EvaluationDatasetVersion = {
        version: nextVersion,
        agentVersion: generated.savedAgentVersion.version,
        agentName: generated.savedAgentVersion.definition.agentName || project.name,
        createdAt: now,
        updatedAt: now,
        source: 'generated',
        promptVersion: EVALUATION_PROMPT_VERSION,
        documentAnalysisSummary: generated.documentAnalysisSummary,
        testCases: generated.testCases,
        validation: generated.validation,
      };

      const updated = await saveProjectEvaluation(project.id, {
        currentVersion: nextVersion,
        versions: [...existingVersions, newRecord],
        savedVersion: project.evaluation?.savedVersion ?? null,
        savedAt: project.evaluation?.savedAt ?? null,
      });

      res.json({ project: updated });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to generate evaluation test cases.';
      const statusCode = message.includes('temporarily unavailable') ? 503 : 500;
      res.status(statusCode).json({ error: message });
    }
  });

  // Regenerate a single evaluation test case without discarding the rest of the set
  app.post('/api/projects/:id/evaluation/regenerate-case', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      if (!isGeminiConfigured()) {
        res.status(503).json({
          error:
            'GEMINI_API_KEY is not configured on the server. Add it in Settings > Secrets.',
        });
        return;
      }

      const extractedDocs = await getProjectExtractedDocuments(project.id);
      try {
        assertEvaluationPrerequisites(project, extractedDocs);
      } catch (prereqError) {
        res.status(400).json({
          error:
            prereqError instanceof Error
              ? prereqError.message
              : 'Evaluation prerequisites are not met.',
        });
        return;
      }

      const testCaseId =
        typeof req.body?.testCaseId === 'string' ? req.body.testCaseId.trim() : '';
      const instruction =
        typeof req.body?.instruction === 'string' ? req.body.instruction.trim() : undefined;

      const currentCases = coerceEvaluationTestCases(
        req.body?.currentTestCases,
        extractedDocs
      );
      const targetIndex = currentCases.findIndex((tc) => tc.id === testCaseId);
      if (targetIndex === -1) {
        res.status(400).json({ error: `Test case "${testCaseId}" not found.` });
        return;
      }

      const regenerated = await regenerateSingleTestCase(
        project,
        extractedDocs,
        currentCases,
        currentCases[targetIndex],
        instruction
      );

      const updatedCases = currentCases.map((tc, idx) =>
        idx === targetIndex ? regenerated : tc
      );
      const validation = validateEvaluationTestCases(
        project,
        extractedDocs,
        updatedCases
      );

      res.json({
        updatedCase: regenerated,
        testCases: updatedCases,
        validation,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to regenerate evaluation test case.';
      const statusCode = message.includes('temporarily unavailable') ? 503 : 500;
      res.status(statusCode).json({ error: message });
    }
  });

  // Validate evaluation test cases (deterministic + optional Gemini semantic audit)
  app.post('/api/projects/:id/evaluation/validate', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }

      const extractedDocs = await getProjectExtractedDocuments(project.id);
      assertEvaluationPrerequisites(project, extractedDocs);

      const testCases = coerceEvaluationTestCases(req.body?.testCases, extractedDocs);
      const validation = validateEvaluationTestCases(project, extractedDocs, testCases);

      if (Boolean(req.body?.useAiAudit)) {
        if (!isGeminiConfigured()) {
          res.status(503).json({
            error:
              'GEMINI_API_KEY is not configured on the server for AI semantic audit.',
          });
          return;
        }
        const auditIssues = await auditEvaluationSetWithGemini(
          project,
          extractedDocs,
          testCases
        );
        for (const issue of auditIssues) {
          if (issue.severity === 'error') {
            validation.errors.push(issue);
          } else {
            validation.warnings.push(issue);
          }
        }
        validation.valid = validation.errors.length === 0;
      }

      res.json({ testCases, validation });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to validate evaluation dataset.';
      const statusCode = message.includes('temporarily unavailable') ? 503 : 400;
      res.status(statusCode).json({ error: message });
    }
  });

  // Save and version a validated evaluation test suite (blocks invalid datasets)
  app.put('/api/projects/:id/evaluation/save', async (req, res) => {
    try {
      const project = await getProjectById(req.params.id);
      if (!project) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }

      const extractedDocs = await getProjectExtractedDocuments(project.id);
      const { savedAgentVersion } = assertEvaluationPrerequisites(
        project,
        extractedDocs
      );

      const testCases = coerceEvaluationTestCases(req.body?.testCases, extractedDocs);
      const validation = validateEvaluationTestCases(project, extractedDocs, testCases);

      if (!validation.valid) {
        res.status(400).json({
          error:
            validation.errors[0]?.message ||
            'Evaluation dataset failed validation checks.',
          validation,
        });
        return;
      }

      const existingVersions = project.evaluation?.versions ?? [];
      const baseVersion =
        typeof req.body?.baseVersion === 'number' ? req.body.baseVersion : null;
      const source =
        req.body?.source === 'generated' || req.body?.source === 'case_regenerated'
          ? req.body.source
          : 'manual_edit';
      const documentAnalysisSummary =
        typeof req.body?.documentAnalysisSummary === 'string'
          ? req.body.documentAnalysisSummary.trim()
          : '';

      const now = new Date().toISOString();
      const matchingExisting =
        baseVersion !== null
          ? existingVersions.find((v) => v.version === baseVersion)
          : undefined;

      const isUnchangedFromBase =
        Boolean(matchingExisting) &&
        matchingExisting?.agentVersion === savedAgentVersion.version &&
        JSON.stringify(matchingExisting?.testCases) === JSON.stringify(testCases);

      let nextVersions: EvaluationDatasetVersion[];
      let savedVersionNumber: number;

      if (isUnchangedFromBase && matchingExisting) {
        savedVersionNumber = matchingExisting.version;
        nextVersions = existingVersions.map((v) =>
          v.version === matchingExisting.version
            ? { ...v, updatedAt: now, validation }
            : v
        );
      } else {
        const maxVersion = existingVersions.reduce(
          (max, item) => Math.max(max, item.version),
          0
        );
        savedVersionNumber = maxVersion + 1;
        const newRecord: EvaluationDatasetVersion = {
          version: savedVersionNumber,
          agentVersion: savedAgentVersion.version,
          agentName: savedAgentVersion.definition.agentName || project.name,
          createdAt: now,
          updatedAt: now,
          source,
          promptVersion: EVALUATION_PROMPT_VERSION,
          documentAnalysisSummary:
            documentAnalysisSummary ||
            matchingExisting?.documentAnalysisSummary ||
            '',
          testCases,
          validation,
        };
        nextVersions = [...existingVersions, newRecord];
      }

      const updated = await saveProjectEvaluation(project.id, {
        currentVersion: savedVersionNumber,
        versions: nextVersions,
        savedVersion: savedVersionNumber,
        savedAt: now,
      });

      res.json({ project: updated, validation });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to save evaluation dataset.';
      res.status(400).json({ error: message });
    }
  });

  app.post(
    '/api/projects/:id/documents',
    upload.array('documents', MAX_FILES_PER_REQUEST),
    async (req, res) => {
      try {
        const files = toIncomingFiles(req.files as Express.Multer.File[] | undefined);
        if (files.length === 0) {
          res.status(400).json({ error: 'Please select at least one PDF, TXT, or CSV file.' });
          return;
        }
        const updated = await addDocumentsToProject(req.params.id, files);
        if (!updated) {
          res.status(404).json({ error: 'Project not found.' });
          return;
        }
        res.json({ project: updated });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to upload documents.';
        res.status(400).json({ error: message });
      }
    }
  );

  app.delete('/api/projects/:id/documents/:docId', async (req, res) => {
    try {
      const updated = await removeDocumentFromProject(req.params.id, req.params.docId);
      if (!updated) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      res.json({ project: updated });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete document.';
      res.status(400).json({ error: message });
    }
  });

  app.delete('/api/projects/:id', async (req, res) => {
    try {
      const deleted = await deleteProject(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      res.json({ deleted: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete project.';
      res.status(400).json({ error: message });
    }
  });

  // Upload and API error handler
  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (req.path.startsWith('/api/')) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            res.status(400).json({ error: 'Each uploaded file must be 10 MB or smaller.' });
            return;
          }
          if (err.code === 'LIMIT_FILE_COUNT') {
            res.status(400).json({ error: 'You can upload up to 10 documents per request.' });
            return;
          }
          res.status(400).json({ error: err.message });
          return;
        }
        const message = err instanceof Error ? err.message : 'Unexpected server error.';
        res.status(400).json({ error: message });
        return;
      }
      next(err);
    }
  );

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ForgeAI server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start ForgeAI server:', err);
  process.exit(1);
});

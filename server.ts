import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { detectAllowedFileType } from './server/documents.ts';
import { isGeminiConfigured } from './server/gemini.ts';
import {
  addDocumentsToProject,
  createProject,
  deleteProject,
  ensureStorageDirs,
  getExtractedDocumentText,
  getProjectById,
  listProjects,
  MAX_FILES_PER_PROJECT,
  removeDocumentFromProject,
  type IncomingUploadedFile,
} from './server/storage.ts';

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
        brief,
        files,
      });

      res.status(201).json({ project });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create project.';
      res.status(500).json({ error: message });
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

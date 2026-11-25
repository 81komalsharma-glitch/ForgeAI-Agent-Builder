import path from 'path';
import type { DocumentFileType, DocumentParseStatus } from './types.ts';

export interface ParsedDocumentResult {
  fileType: DocumentFileType;
  extractedText: string;
  previewText: string;
  charCount: number;
  lineCount: number;
  pageCount: number | null;
  csvHeaders?: string[];
  csvRowCount?: number;
  csvSampleRows?: Record<string, string>[];
  parseStatus: DocumentParseStatus;
  parseNote?: string;
}

const PREVIEW_MAX_CHARS = 800;
const CSV_SAMPLE_ROW_LIMIT = 5;

export function detectAllowedFileType(filename: string): DocumentFileType | null {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.txt') return 'txt';
  if (ext === '.csv') return 'csv';
  return null;
}

function createPreview(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= PREVIEW_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, PREVIEW_MAX_CHARS)}...`;
}

function hasBinaryNullBytes(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < sampleLength; i += 1) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

function parseCsvRecords(input: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  const text = input.replace(/^\uFEFF/, '');

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      currentRow.push(currentField.trim());
      currentField = '';
    } else if (ch === '\r' && next === '\n') {
      currentRow.push(currentField.trim());
      if (currentRow.some((cell) => cell.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
      i += 1;
    } else if (ch === '\n' || ch === '\r') {
      currentRow.push(currentField.trim());
      if (currentRow.some((cell) => cell.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentField = '';
    } else {
      currentField += ch;
    }
  }

  currentRow.push(currentField.trim());
  if (currentRow.some((cell) => cell.length > 0)) {
    rows.push(currentRow);
  }

  return rows;
}

function formatCsvAsStructuredText(
  headers: string[],
  dataRows: string[][]
): string {
  if (headers.length === 0) return '';
  const lines: string[] = [`Columns (${headers.length}): ${headers.join(', ')}`];
  for (let r = 0; r < dataRows.length; r += 1) {
    const row = dataRows[r];
    const pairs = headers.map((header, idx) => `${header}: ${row[idx] ?? ''}`);
    lines.push(`Row ${r + 1}: ${pairs.join(' | ')}`);
  }
  return lines.join('\n');
}

async function extractPdfText(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
    useSystemFonts: true,
  });

  try {
    const pdfDocument = await loadingTask.promise;
    const pageCount = pdfDocument.numPages;
    const pageTexts: string[] = [];

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const content = await page.getTextContent();
      const strings = content.items
        .map((item) => ('str' in item && typeof item.str === 'string' ? item.str : ''))
        .filter((value) => value.length > 0);
      if (strings.length > 0) {
        pageTexts.push(`[Page ${pageNumber}]\n${strings.join(' ')}`);
      }
    }

    return {
      text: pageTexts.join('\n\n'),
      pageCount,
    };
  } finally {
    await loadingTask.destroy();
  }
}

export async function parseUploadedDocument(
  buffer: Buffer,
  originalName: string
): Promise<ParsedDocumentResult> {
  const fileType = detectAllowedFileType(originalName);
  if (!fileType) {
    throw new Error(`Unsupported file type for "${originalName}". Allowed types: PDF, TXT, CSV.`);
  }

  if (buffer.length === 0) {
    return {
      fileType,
      extractedText: '',
      previewText: '',
      charCount: 0,
      lineCount: 0,
      pageCount: null,
      parseStatus: 'empty',
      parseNote: 'Uploaded file is empty (0 bytes).',
    };
  }

  if (fileType === 'txt') {
    if (hasBinaryNullBytes(buffer)) {
      return {
        fileType: 'txt',
        extractedText: '',
        previewText: '',
        charCount: 0,
        lineCount: 0,
        pageCount: null,
        parseStatus: 'error',
        parseNote: 'File contains binary data and could not be read as plain UTF-8 text.',
      };
    }

    const text = buffer.toString('utf-8').replace(/^\uFEFF/, '');
    const trimmed = text.trim();
    const lineCount = trimmed.length === 0 ? 0 : text.replace(/\r\n/g, '\n').split('\n').length;

    return {
      fileType,
      extractedText: text,
      previewText: createPreview(text),
      charCount: trimmed.length,
      lineCount,
      pageCount: null,
      parseStatus: trimmed.length > 0 ? 'parsed' : 'empty',
      parseNote: trimmed.length === 0 ? 'TXT file contains no readable text.' : undefined,
    };
  }

  if (fileType === 'csv') {
    if (hasBinaryNullBytes(buffer)) {
      return {
        fileType: 'csv',
        extractedText: '',
        previewText: '',
        charCount: 0,
        lineCount: 0,
        pageCount: null,
        parseStatus: 'error',
        parseNote: 'File contains binary data and could not be read as a CSV table.',
      };
    }

    const rawText = buffer.toString('utf-8').replace(/^\uFEFF/, '');
    const records = parseCsvRecords(rawText);

    if (records.length === 0) {
      return {
        fileType: 'csv',
        extractedText: '',
        previewText: '',
        charCount: 0,
        lineCount: 0,
        pageCount: null,
        csvHeaders: [],
        csvRowCount: 0,
        csvSampleRows: [],
        parseStatus: 'empty',
        parseNote: 'CSV file contains no headers or rows.',
      };
    }

    const csvHeaders = records[0].map((header, idx) =>
      header.length > 0 ? header : `Column_${idx + 1}`
    );
    const dataRows = records.slice(1);
    const csvRowCount = dataRows.length;

    const csvSampleRows: Record<string, string>[] = dataRows
      .slice(0, CSV_SAMPLE_ROW_LIMIT)
      .map((row) => {
        const obj: Record<string, string> = {};
        csvHeaders.forEach((header, idx) => {
          obj[header] = row[idx] ?? '';
        });
        return obj;
      });

    const structuredText = formatCsvAsStructuredText(csvHeaders, dataRows);

    return {
      fileType,
      extractedText: structuredText,
      previewText: createPreview(structuredText),
      charCount: structuredText.length,
      lineCount: records.length,
      pageCount: null,
      csvHeaders,
      csvRowCount,
      csvSampleRows,
      parseStatus: 'parsed',
      parseNote:
        csvRowCount === 0
          ? 'CSV contains column headers but 0 data rows.'
          : undefined,
    };
  }

  // PDF parsing
  const pdfSignature = buffer.subarray(0, 5).toString('ascii');
  if (pdfSignature !== '%PDF-') {
    return {
      fileType: 'pdf',
      extractedText: '',
      previewText: '',
      charCount: 0,
      lineCount: 0,
      pageCount: null,
      parseStatus: 'error',
      parseNote: 'File does not have a valid PDF header and could not be read.',
    };
  }

  try {
    const { text, pageCount } = await extractPdfText(buffer);
    const trimmed = text.trim();
    const lineCount = trimmed.length === 0 ? 0 : trimmed.split('\n').length;

    return {
      fileType: 'pdf',
      extractedText: text,
      previewText: createPreview(text),
      charCount: trimmed.length,
      lineCount,
      pageCount,
      parseStatus: trimmed.length > 0 ? 'parsed' : 'empty',
      parseNote:
        trimmed.length === 0
          ? 'PDF opened, but no selectable text was found (it may be scanned images).'
          : undefined,
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : 'Unable to parse PDF content.';
    const friendlyMessage = rawMessage.toLowerCase().includes('password')
      ? 'PDF is password-protected and cannot be read.'
      : `Unable to extract text from PDF: ${rawMessage}`;

    return {
      fileType: 'pdf',
      extractedText: '',
      previewText: '',
      charCount: 0,
      lineCount: 0,
      pageCount: null,
      parseStatus: 'error',
      parseNote: friendlyMessage,
    };
  }
}

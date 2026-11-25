import type { ProjectReportVersion, ReportScorecard } from './types.ts';

const PAGE_W = 595.28; // A4 width in pt
const PAGE_H = 841.89; // A4 height in pt
const MARGIN_L = 44;
const MARGIN_R = 44;
const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R; // ~507 pt
const TOP_Y = PAGE_H - 54;
const BOTTOM_Y = 54;

type FontKey = 'F1' | 'F2' | 'F3'; // F1=Helvetica, F2=Helvetica-Bold, F3=Courier

function sanitizePdfText(input: string): string {
  return String(input ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u2192/g, '->')
    .replace(/\u2022/g, '*')
    .replace(/\u00B7/g, '|')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapePdfLiteral(text: string): string {
  return sanitizePdfText(text)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapText(text: string, maxWidthPt: number, fontSize: number): string[] {
  const clean = sanitizePdfText(text);
  if (!clean) return [''];
  // Average glyph width ~0.51 * fontSize for Helvetica
  const avgCharW = fontSize * 0.52;
  const maxChars = Math.max(12, Math.floor(maxWidthPt / avgCharW));
  const words = clean.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (word.length > maxChars) {
      if (current) {
        lines.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += maxChars) {
        lines.push(word.slice(i, i + maxChars));
      }
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function fmtPct(v: number | null): string {
  if (v === null || Number.isNaN(v)) return 'Not Available';
  return `${v.toFixed(1)}%`;
}

function fmtDelta(v: number | null): string {
  if (v === null || Number.isNaN(v)) return 'N/A';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)} pts`;
}

function fmtCount(v: number | null): string {
  if (v === null || Number.isNaN(v)) return 'N/A';
  return String(v);
}

class PdfDocBuilder {
  private pages: string[][] = [];
  private cursorY = TOP_Y;
  private readonly reportTitle: string;
  private readonly reportVersion: number;

  constructor(reportTitle: string, reportVersion: number) {
    this.reportTitle = sanitizePdfText(reportTitle);
    this.reportVersion = reportVersion;
    this.newPage();
  }

  private currentOps(): string[] {
    return this.pages[this.pages.length - 1];
  }

  newPage(): void {
    this.pages.push([]);
    this.cursorY = TOP_Y;
    // Running header
    this.drawRect(0, PAGE_H - 34, PAGE_W, 34, [0.97, 0.98, 0.99]);
    this.drawLine(0, PAGE_H - 34, PAGE_W, PAGE_H - 34, [0.88, 0.9, 0.93], 0.6);
    this.drawTextRaw(
      MARGIN_L,
      PAGE_H - 22,
      `ForgeAI Honest Project Report (v${this.reportVersion}) - ${this.reportTitle}`,
      'F2',
      8.5,
      [0.2, 0.28, 0.42]
    );
  }

  ensureSpace(heightNeeded: number): void {
    if (this.cursorY - heightNeeded < BOTTOM_Y) {
      this.newPage();
    }
  }

  private drawRect(
    x: number,
    y: number,
    w: number,
    h: number,
    fillRgb?: [number, number, number],
    strokeRgb?: [number, number, number],
    lineWidth = 0.75
  ): void {
    const ops = this.currentOps();
    ops.push('q');
    if (fillRgb) {
      ops.push(`${fillRgb[0].toFixed(3)} ${fillRgb[1].toFixed(3)} ${fillRgb[2].toFixed(3)} rg`);
    }
    if (strokeRgb) {
      ops.push(`${lineWidth.toFixed(2)} w`);
      ops.push(`${strokeRgb[0].toFixed(3)} ${strokeRgb[1].toFixed(3)} ${strokeRgb[2].toFixed(3)} RG`);
    }
    ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re`);
    if (fillRgb && strokeRgb) ops.push('B');
    else if (fillRgb) ops.push('f');
    else ops.push('S');
    ops.push('Q');
  }

  private drawLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    rgb: [number, number, number],
    lineWidth = 0.75
  ): void {
    const ops = this.currentOps();
    ops.push('q');
    ops.push(`${lineWidth.toFixed(2)} w`);
    ops.push(`${rgb[0].toFixed(3)} ${rgb[1].toFixed(3)} ${rgb[2].toFixed(3)} RG`);
    ops.push(`${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
    ops.push('Q');
  }

  private drawTextRaw(
    x: number,
    y: number,
    text: string,
    font: FontKey,
    size: number,
    rgb: [number, number, number]
  ): void {
    const escaped = escapePdfLiteral(text);
    const ops = this.currentOps();
    ops.push('BT');
    ops.push(`/${font} ${size.toFixed(1)} Tf`);
    ops.push(`${rgb[0].toFixed(3)} ${rgb[1].toFixed(3)} ${rgb[2].toFixed(3)} rg`);
    ops.push(`1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm`);
    ops.push(`(${escaped}) Tj`);
    ops.push('ET');
  }

  addTitleBanner(projectName: string, subtitle: string, metaLine: string): void {
    this.ensureSpace(78);
    const boxH = 68;
    const boxY = this.cursorY - boxH;
    this.drawRect(MARGIN_L, boxY, CONTENT_W, boxH, [0.118, 0.227, 0.541]); // #1E3A8A
    this.drawTextRaw(MARGIN_L + 16, boxY + 44, projectName, 'F2', 16, [1, 1, 1]);
    this.drawTextRaw(MARGIN_L + 16, boxY + 27, subtitle, 'F1', 9.5, [0.85, 0.9, 1]);
    this.drawTextRaw(MARGIN_L + 16, boxY + 12, metaLine, 'F3', 8, [0.75, 0.83, 0.98]);
    this.cursorY = boxY - 14;
  }

  addSectionHeading(letter: string, title: string, badge?: string): void {
    this.ensureSpace(34);
    this.cursorY -= 6;
    const y = this.cursorY;
    this.drawRect(MARGIN_L, y - 4, CONTENT_W, 20, [0.945, 0.96, 0.985], [0.85, 0.88, 0.93], 0.6);
    this.drawTextRaw(
      MARGIN_L + 8,
      y + 2,
      `${letter}. ${title}`,
      'F2',
      11,
      [0.118, 0.227, 0.541]
    );
    if (badge) {
      this.drawTextRaw(
        MARGIN_L + CONTENT_W - 120,
        y + 2.5,
        badge,
        'F3',
        8,
        [0.35, 0.42, 0.52]
      );
    }
    this.cursorY -= 26;
  }

  addSubHeading(text: string): void {
    this.ensureSpace(20);
    this.drawTextRaw(MARGIN_L, this.cursorY, text, 'F2', 9.5, [0.12, 0.16, 0.23]);
    this.cursorY -= 14;
  }

  addParagraph(text: string, opts?: { indent?: number; size?: number; color?: [number, number, number]; font?: FontKey }): void {
    const indent = opts?.indent ?? 0;
    const size = opts?.size ?? 9;
    const color = opts?.color ?? [0.22, 0.27, 0.35];
    const font = opts?.font ?? 'F1';
    const lines = wrapText(text, CONTENT_W - indent, size);
    const lineH = size + 3.5;

    for (const line of lines) {
      this.ensureSpace(lineH + 2);
      this.drawTextRaw(MARGIN_L + indent, this.cursorY, line, font, size, color);
      this.cursorY -= lineH;
    }
    this.cursorY -= 3;
  }

  addKeyValue(label: string, value: string): void {
    const labelClean = `${sanitizePdfText(label)}: `;
    const full = `${labelClean}${sanitizePdfText(value)}`;
    const lines = wrapText(full, CONTENT_W, 9);
    const lineH = 12.5;
    for (let i = 0; i < lines.length; i++) {
      this.ensureSpace(lineH + 2);
      if (i === 0) {
        const splitIdx = lines[0].indexOf(': ');
        if (splitIdx > 0) {
          const k = lines[0].slice(0, splitIdx + 2);
          const v = lines[0].slice(splitIdx + 2);
          this.drawTextRaw(MARGIN_L, this.cursorY, k, 'F2', 9, [0.15, 0.2, 0.3]);
          this.drawTextRaw(
            MARGIN_L + k.length * 4.85,
            this.cursorY,
            v,
            'F1',
            9,
            [0.24, 0.29, 0.37]
          );
        } else {
          this.drawTextRaw(MARGIN_L, this.cursorY, lines[0], 'F1', 9, [0.24, 0.29, 0.37]);
        }
      } else {
        this.drawTextRaw(MARGIN_L + 10, this.cursorY, lines[i], 'F1', 9, [0.24, 0.29, 0.37]);
      }
      this.cursorY -= lineH;
    }
  }

  addBulletList(items: string[], emptyFallback = 'None recorded.'): void {
    if (!items || items.length === 0) {
      this.addParagraph(`* ${emptyFallback}`, { indent: 8, color: [0.42, 0.47, 0.55] });
      return;
    }
    for (const item of items) {
      const lines = wrapText(item, CONTENT_W - 18, 9);
      const lineH = 12.2;
      for (let i = 0; i < lines.length; i++) {
        this.ensureSpace(lineH + 2);
        const prefix = i === 0 ? '* ' : '  ';
        this.drawTextRaw(
          MARGIN_L + 8,
          this.cursorY,
          `${prefix}${lines[i]}`,
          'F1',
          9,
          [0.22, 0.27, 0.35]
        );
        this.cursorY -= lineH;
      }
    }
    this.cursorY -= 3;
  }

  addScorecardGrid(cards: Array<{ label: string; value: string; sub?: string }>): void {
    const cols = Math.min(4, Math.max(1, cards.length));
    const gap = 8;
    const cardW = (CONTENT_W - gap * (cols - 1)) / cols;
    const cardH = 44;
    this.ensureSpace(cardH + 10);

    const y = this.cursorY - cardH;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const x = MARGIN_L + i * (cardW + gap);
      this.drawRect(x, y, cardW, cardH, [0.985, 0.99, 0.996], [0.83, 0.86, 0.91], 0.7);
      this.drawTextRaw(x + 8, y + 30, c.label, 'F1', 7.8, [0.38, 0.44, 0.54]);
      this.drawTextRaw(x + 8, y + 14, c.value, 'F2', 12, [0.09, 0.14, 0.24]);
      if (c.sub) {
        this.drawTextRaw(x + 8, y + 4.5, c.sub, 'F3', 7, [0.42, 0.48, 0.56]);
      }
    }
    this.cursorY = y - 10;
  }

  addTable(
    headers: string[],
    colWidths: number[],
    rows: string[][]
  ): void {
    const headerH = 20;
    this.ensureSpace(headerH + 22);

    const drawHeader = () => {
      const y = this.cursorY - headerH;
      this.drawRect(MARGIN_L, y, CONTENT_W, headerH, [0.94, 0.955, 0.975], [0.82, 0.85, 0.9], 0.6);
      let x = MARGIN_L;
      for (let c = 0; c < headers.length; c++) {
        this.drawTextRaw(x + 5, y + 6.5, headers[c], 'F2', 8, [0.16, 0.22, 0.34]);
        x += colWidths[c];
      }
      this.cursorY = y;
    };

    drawHeader();

    if (rows.length === 0) {
      const rowH = 18;
      this.ensureSpace(rowH);
      const y = this.cursorY - rowH;
      this.drawRect(MARGIN_L, y, CONTENT_W, rowH, [1, 1, 1], [0.88, 0.9, 0.93], 0.5);
      this.drawTextRaw(MARGIN_L + 6, y + 6, 'No entries recorded.', 'F1', 8.5, [0.45, 0.5, 0.58]);
      this.cursorY = y - 8;
      return;
    }

    for (const row of rows) {
      const wrappedCols = row.map((cell, idx) =>
        wrapText(cell ?? 'N/A', Math.max(24, colWidths[idx] - 10), 8)
      );
      const maxLines = Math.max(1, ...wrappedCols.map((l) => l.length));
      const rowH = maxLines * 10.5 + 8;

      if (this.cursorY - rowH < BOTTOM_Y) {
        this.newPage();
        drawHeader();
      }

      const y = this.cursorY - rowH;
      this.drawRect(MARGIN_L, y, CONTENT_W, rowH, [1, 1, 1], [0.88, 0.9, 0.93], 0.5);

      let x = MARGIN_L;
      for (let c = 0; c < row.length; c++) {
        const cellLines = wrappedCols[c];
        for (let l = 0; l < cellLines.length; l++) {
          const ty = y + rowH - 11.5 - l * 10.5;
          this.drawTextRaw(x + 5, ty, cellLines[l], 'F1', 8, [0.2, 0.25, 0.33]);
        }
        x += colWidths[c];
      }
      this.cursorY = y;
    }
    this.cursorY -= 10;
  }

  addComparisonBarChart(
    title: string,
    series: Array<{ label: string; baseline: number | null; final: number | null }>
  ): void {
    const chartH = 122;
    this.ensureSpace(chartH + 14);
    const boxY = this.cursorY - chartH;
    this.drawRect(MARGIN_L, boxY, CONTENT_W, chartH, [0.99, 0.992, 0.996], [0.84, 0.87, 0.92], 0.7);
    this.drawTextRaw(MARGIN_L + 10, boxY + chartH - 15, title, 'F2', 9, [0.12, 0.17, 0.27]);

    // Legend
    this.drawRect(MARGIN_L + CONTENT_W - 150, boxY + chartH - 16, 8, 8, [0.58, 0.64, 0.72]);
    this.drawTextRaw(MARGIN_L + CONTENT_W - 138, boxY + chartH - 15, 'Baseline', 'F1', 7.8, [0.32, 0.38, 0.46]);
    this.drawRect(MARGIN_L + CONTENT_W - 80, boxY + chartH - 16, 8, 8, [0.118, 0.227, 0.541]);
    this.drawTextRaw(MARGIN_L + CONTENT_W - 68, boxY + chartH - 15, 'Final', 'F1', 7.8, [0.118, 0.227, 0.541]);

    const plotBottom = boxY + 24;
    const plotTop = boxY + chartH - 30;
    const plotH = plotTop - plotBottom; // ~68 pt
    this.drawLine(MARGIN_L + 28, plotBottom, MARGIN_L + CONTENT_W - 14, plotBottom, [0.78, 0.82, 0.88], 0.7);
    this.drawLine(MARGIN_L + 28, plotTop, MARGIN_L + CONTENT_W - 14, plotTop, [0.92, 0.94, 0.96], 0.5);
    this.drawTextRaw(MARGIN_L + 8, plotBottom - 2, '0%', 'F3', 7, [0.45, 0.5, 0.58]);
    this.drawTextRaw(MARGIN_L + 5, plotTop - 2, '100%', 'F3', 7, [0.45, 0.5, 0.58]);

    const groupW = (CONTENT_W - 50) / Math.max(1, series.length);
    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      const gx = MARGIN_L + 36 + i * groupW;
      const barW = 24;

      // Baseline bar
      if (s.baseline !== null) {
        const bh = Math.max(2, (Math.min(100, Math.max(0, s.baseline)) / 100) * plotH);
        this.drawRect(gx, plotBottom, barW, bh, [0.58, 0.64, 0.72]);
        this.drawTextRaw(gx, plotBottom + bh + 3, `${s.baseline.toFixed(1)}%`, 'F3', 7, [0.32, 0.38, 0.46]);
      } else {
        this.drawTextRaw(gx + 2, plotBottom + 4, 'N/A', 'F3', 7, [0.5, 0.55, 0.62]);
      }

      // Final bar
      if (s.final !== null) {
        const fh = Math.max(2, (Math.min(100, Math.max(0, s.final)) / 100) * plotH);
        this.drawRect(gx + barW + 6, plotBottom, barW, fh, [0.118, 0.227, 0.541]);
        this.drawTextRaw(gx + barW + 6, plotBottom + fh + 3, `${s.final.toFixed(1)}%`, 'F3', 7, [0.118, 0.227, 0.541]);
      } else {
        this.drawTextRaw(gx + barW + 8, plotBottom + 4, 'N/A', 'F3', 7, [0.5, 0.55, 0.62]);
      }

      this.drawTextRaw(gx, boxY + 9, s.label, 'F2', 8, [0.22, 0.27, 0.35]);
    }

    this.cursorY = boxY - 12;
  }

  addHorizontalBarChart(
    title: string,
    items: Array<{ label: string; count: number; color: [number, number, number] }>
  ): void {
    const rowH = 17;
    const chartH = 34 + items.length * rowH;
    this.ensureSpace(chartH + 12);
    const boxY = this.cursorY - chartH;
    this.drawRect(MARGIN_L, boxY, CONTENT_W, chartH, [0.99, 0.992, 0.996], [0.84, 0.87, 0.92], 0.7);
    this.drawTextRaw(MARGIN_L + 10, boxY + chartH - 15, title, 'F2', 9, [0.12, 0.17, 0.27]);

    const maxCount = Math.max(1, ...items.map((i) => i.count));
    const barMaxW = CONTENT_W - 190;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const ry = boxY + chartH - 34 - i * rowH;
      this.drawTextRaw(MARGIN_L + 10, ry + 3, it.label, 'F1', 8.2, [0.22, 0.27, 0.35]);
      this.drawRect(MARGIN_L + 130, ry + 1, barMaxW, 10, [0.94, 0.95, 0.97]);
      if (it.count > 0) {
        const w = Math.max(4, (it.count / maxCount) * barMaxW);
        this.drawRect(MARGIN_L + 130, ry + 1, w, 10, it.color);
      }
      this.drawTextRaw(
        MARGIN_L + 138 + barMaxW,
        ry + 3,
        String(it.count),
        'F3',
        8,
        [0.15, 0.2, 0.3]
      );
    }
    this.cursorY = boxY - 12;
  }

  buildBuffer(): Buffer {
    const totalPages = this.pages.length;
    // Stamp footers on every page now that totalPages is known
    for (let i = 0; i < totalPages; i++) {
      const ops = this.pages[i];
      ops.push('q');
      ops.push('0.60 w 0.880 0.900 0.930 RG');
      ops.push(`0 38.00 m ${PAGE_W.toFixed(2)} 38.00 l S`);
      ops.push('Q');
      ops.push('BT /F1 8.0 Tf 0.420 0.470 0.550 rg');
      ops.push(`1 0 0 1 ${MARGIN_L.toFixed(2)} 22.00 Tm`);
      ops.push(
        `(${escapePdfLiteral(`ForgeAI Honest Reporting Engine | Page ${i + 1} of ${totalPages}`)}) Tj ET`
      );
    }

    // Construct PDF 1.4 objects
    const objects: string[] = [];
    const addObj = (body: string): number => {
      objects.push(body);
      return objects.length;
    };

    const catalogId = addObj(''); // placeholder 1
    const pagesId = addObj(''); // placeholder 2
    const f1Id = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const f2Id = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
    const f3Id = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');

    const pageIds: number[] = [];
    for (const pageOps of this.pages) {
      const streamData = pageOps.join('\n');
      const len = Buffer.byteLength(streamData, 'latin1');
      const contentId = addObj(`<< /Length ${len} >>\nstream\n${streamData}\nendstream`);
      const pageId = addObj(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W.toFixed(2)} ${PAGE_H.toFixed(2)}] /Resources << /Font << /F1 ${f1Id} 0 R /F2 ${f2Id} 0 R /F3 ${f3Id} 0 R >> >> /Contents ${contentId} 0 R >>`
      );
      pageIds.push(pageId);
    }

    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

    const chunks: string[] = ['%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'];
    const offsets: number[] = [0];
    let byteCursor = Buffer.byteLength(chunks[0], 'latin1');

    for (let i = 0; i < objects.length; i++) {
      offsets.push(byteCursor);
      const entry = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
      chunks.push(entry);
      byteCursor += Buffer.byteLength(entry, 'latin1');
    }

    const xrefStart = byteCursor;
    chunks.push(`xref\n0 ${objects.length + 1}\n`);
    chunks.push('0000000000 65535 f \n');
    for (let i = 1; i <= objects.length; i++) {
      chunks.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
    }
    chunks.push(
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
    );

    return Buffer.from(chunks.join(''), 'latin1');
  }
}

function scorecardCards(sc: ReportScorecard, labelPrefix: string) {
  return [
    {
      label: `${labelPrefix} Overall`,
      value: fmtPct(sc.overallScore),
      sub: `Pass ${fmtCount(sc.passedTests)} / Fail ${fmtCount(sc.failedTests)}`,
    },
    {
      label: 'Grounding (40%)',
      value: fmtPct(sc.groundingScore),
      sub: `Evaluated: ${fmtCount(sc.evaluatedTests)}`,
    },
    {
      label: 'Correctness (40%)',
      value: fmtPct(sc.correctnessScore),
      sub: `Errors: ${fmtCount(sc.errorTests)}`,
    },
    {
      label: 'Refusal (20%)',
      value: fmtPct(sc.refusalQualityScore),
      sub: `Skipped: ${fmtCount(sc.skippedTests)}`,
    },
  ];
}

export function generateReportPdfBuffer(report: ProjectReportVersion): Buffer {
  const po = report.projectOverview;
  const pdf = new PdfDocBuilder(po.projectName, report.version);

  pdf.addTitleBanner(
    po.projectName,
    `Agent: ${po.agentName} | Domain: ${po.domain} | Completeness: ${report.completenessStatus.toUpperCase()}`,
    `Report v${report.version} | Generated: ${report.generatedAt} | Mode: ${report.narrativeMode}`
  );

  if (report.missingArtifacts.length > 0) {
    pdf.addParagraph(
      `HONEST COMPLETENESS NOTICE: Missing or incomplete artifacts (${report.missingArtifacts.join(', ')}) are marked Not Available rather than fabricated.`,
      { font: 'F2', size: 8.5, color: [0.68, 0.35, 0.04] }
    );
  }
  pdf.addParagraph(report.limitationsAndFutureImprovements.executiveSummary, { size: 9.2 });

  // Section A: Project Overview
  pdf.addSectionHeading('A', 'Project Overview', `Stage: ${po.pipelineStage}`);
  pdf.addKeyValue('Project Name', po.projectName);
  pdf.addKeyValue('Agent Name', po.agentName);
  pdf.addKeyValue('Agent Purpose', po.agentPurpose);
  pdf.addKeyValue('Target Audience', po.targetAudience);
  pdf.addKeyValue('Desired Response Tone', po.responseTone);
  pdf.addKeyValue('Created Date', po.createdAt);
  pdf.addKeyValue(
    'Uploaded Knowledge Sources',
    `${po.uploadedDocumentsCount} file(s), ${po.totalDocumentBytes} bytes total`
  );
  pdf.addTable(
    ['Document', 'Type', 'Size (bytes)', 'Parse Status', 'Chars'],
    [200, 55, 80, 92, 80],
    po.uploadedDocuments.map((d) => [
      d.name,
      d.fileType.toUpperCase(),
      String(d.sizeBytes),
      d.parseStatus,
      String(d.charCount),
    ])
  );

  // Section B: Requirements Analysis
  const req = report.requirementsAnalysis;
  pdf.addSectionHeading('B', 'Requirements Analysis', req.availability.toUpperCase());
  pdf.addKeyValue('Original Brief', req.originalBrief);
  if (req.clarificationInterview) {
    pdf.addSubHeading(
      `Intake Clarification Interview (${req.clarificationInterview.status})`
    );
    pdf.addTable(
      ['Clarification Question', 'User Answer', 'Skipped'],
      [220, 227, 60],
      req.clarificationInterview.questionsAndAnswers.map((qa) => [
        qa.question,
        qa.answer,
        qa.skipped ? 'Yes' : 'No',
      ])
    );
  } else {
    pdf.addKeyValue('Intake Clarification Interview', 'Not Available');
  }

  if (req.approvedRequirements) {
    pdf.addKeyValue(
      'Approval Status',
      req.approvedRequirements.approved
        ? `Approved (${req.approvedRequirements.approvedAt ?? 'timestamp N/A'})`
        : 'Not Approved'
    );
    pdf.addKeyValue('Scope', req.approvedRequirements.scope.join('; ') || 'None');
    pdf.addKeyValue(
      'Must-Answer Topics',
      req.approvedRequirements.mustAnswerTopics.join('; ') || 'None'
    );
    pdf.addKeyValue(
      'Must-Refuse Topics',
      req.approvedRequirements.mustRefuseTopics.join('; ') || 'None'
    );
  } else {
    pdf.addKeyValue('Approved Requirements', 'Not Available');
  }

  if (req.groundability) {
    pdf.addKeyValue(
      'Groundability Overall Status',
      `${req.groundability.overallStatus} - ${req.groundability.summary}`
    );
    pdf.addKeyValue(
      'Supported / Partial / Unsupported Counts',
      `${req.groundability.supportedRequirements.length} Supported | ${req.groundability.partiallySupportedRequirements.length} Partially Supported | ${req.groundability.unsupportedRequirements.length} Unsupported`
    );
  } else {
    pdf.addKeyValue('Groundability Analysis', 'Not Available');
  }
  pdf.addSubHeading('Identified Limitations and Assumptions');
  pdf.addBulletList(req.limitationsAndAssumptions, 'None recorded.');

  // Section C: Generated Agent Definition
  const ag = report.agentDefinitionSection;
  pdf.addSectionHeading('C', 'Generated Agent Definition', ag.availability.toUpperCase());
  if (ag.systemPrompt && ag.knowledgeConfig && ag.outputContract) {
    pdf.addKeyValue(
      'Versions',
      `Original v${ag.originalVersionNumber ?? 'N/A'} | Final v${ag.finalVersionNumber ?? 'N/A'}`
    );
    pdf.addKeyValue('Role & Identity', ag.systemPrompt.agentRoleAndIdentity);
    pdf.addKeyValue('Main Objective', ag.systemPrompt.mainObjective);
    pdf.addKeyValue(
      'Knowledge & Retrieval Config',
      `method=${ag.knowledgeConfig.retrievalMethod}, chunkSize=${ag.knowledgeConfig.chunkSize}, overlap=${ag.knowledgeConfig.chunkOverlap}, topK=${ag.knowledgeConfig.topK}, similarityThreshold=${ag.knowledgeConfig.similarityThreshold}`
    );
    pdf.addKeyValue(
      'Output Contract',
      `format=${ag.outputContract.expectedOutputFormat}, citation=${ag.outputContract.citationFormat}, refusal=${ag.outputContract.refusalFormat}`
    );
    pdf.addSubHeading('Selected Tools');
    pdf.addBulletList(
      ag.selectedTools.map((t) => `${t.toolName} (${t.implementationStatus}): ${t.description}`),
      'No tools selected.'
    );
    pdf.addSubHeading('Agent Version History');
    pdf.addTable(
      ['Ver', 'Source', 'Valid', 'Notes'],
      [40, 100, 50, 317],
      ag.versionHistory.map((v) => [
        `v${v.version}`,
        v.source,
        v.valid ? 'Yes' : 'No',
        v.notes || '-',
      ])
    );
  } else {
    pdf.addParagraph('Generated Agent Definition: Not Available.');
  }

  // Section D: Evaluation Methodology
  const em = report.evaluationMethodology;
  pdf.addSectionHeading('D', 'Evaluation Methodology', em.availability.toUpperCase());
  pdf.addKeyValue(
    'Evaluation Dataset',
    em.datasetVersion !== null
      ? `v${em.datasetVersion} (${em.totalTestCases ?? 0} test cases: Answerable=${fmtCount(em.countsByCategory.answerable)}, Out-of-Scope=${fmtCount(em.countsByCategory.out_of_scope)}, Edge Case=${fmtCount(em.countsByCategory.edge_case)})`
      : 'Not Available'
  );
  pdf.addKeyValue(
    'Scoring Weights',
    `Grounding ${(em.scoringWeights.grounding * 100).toFixed(0)}% | Correctness ${(em.scoringWeights.correctness * 100).toFixed(0)}% | Refusal Quality ${(em.scoringWeights.refusal * 100).toFixed(0)}%`
  );
  pdf.addKeyValue('Judge Rubric', `${em.judgeRubric.scale}. ${em.judgeRubric.passCriteria}`);
  pdf.addSubHeading('Deterministic Validation Checks');
  pdf.addBulletList(em.deterministicValidationChecks);

  // Section E: Baseline Evaluation
  const be = report.baselineEvaluation;
  pdf.addSectionHeading('E', 'Baseline Evaluation', be.availability.toUpperCase());
  if (be.isIncompleteEvaluation) {
    pdf.addParagraph(`INCOMPLETE EVALUATION WARNING: ${be.incompleteReason}`, {
      font: 'F2',
      size: 8.5,
      color: [0.75, 0.25, 0.1],
    });
  }
  pdf.addKeyValue(
    'Baseline Run',
    be.runId
      ? `${be.runId} (Agent v${be.agentVersion}, Dataset v${be.datasetVersion}, Status: ${be.runStatus})`
      : 'Not Available'
  );
  pdf.addScorecardGrid(scorecardCards(be.scorecard, 'Baseline'));
  if (be.categoryBreakdown.length > 0) {
    pdf.addTable(
      ['Category', 'Total', 'Passed', 'Failed', 'Errors', 'Skipped', 'Pass Rate'],
      [110, 50, 60, 60, 60, 60, 107],
      be.categoryBreakdown.map((c) => [
        c.category,
        String(c.total),
        String(c.passed),
        String(c.failed),
        String(c.errors),
        String(c.skipped),
        fmtPct(c.passRatePercent),
      ])
    );
  }
  if (be.importantFailures.length > 0) {
    pdf.addSubHeading(`Baseline Failures / Errors / Skipped (${be.importantFailures.length})`);
    pdf.addTable(
      ['Test ID', 'Category', 'Status', 'Failure Explanation'],
      [65, 85, 65, 292],
      be.importantFailures.slice(0, 10).map((f) => [
        f.testCaseId,
        f.category,
        f.status,
        f.failureReason,
      ])
    );
  }

  // Section F: Optimization History
  const opt = report.optimizationHistory;
  pdf.addSectionHeading('F', 'Optimization History', opt.availability.toUpperCase());
  pdf.addKeyValue(
    'Optimization Summary',
    `${opt.iterationsCompleted} / ${opt.maxIterations} iteration(s) completed | Stopping Reason: ${opt.stoppingReasonLabel}`
  );
  pdf.addKeyValue('Stopping Detail', opt.stoppingDetail);

  const fcs = opt.failureCategorySummary;
  pdf.addHorizontalBarChart('Optimizer Failure Classification Breakdown', [
    { label: 'Retrieval Miss', count: fcs.retrieval_miss, color: [0.15, 0.39, 0.92] },
    { label: 'Prompt Defect', count: fcs.prompt_defect, color: [0.85, 0.47, 0.02] },
    { label: 'Hallucination', count: fcs.hallucination, color: [0.86, 0.15, 0.15] },
    { label: 'Wrong Refusal', count: fcs.wrong_refusal, color: [0.58, 0.25, 0.68] },
    { label: 'Uncertain', count: fcs.uncertain, color: [0.39, 0.45, 0.55] },
  ]);

  if (opt.iterations.length > 0) {
    pdf.addTable(
      ['Iter', 'Agents', 'Prev -> New', 'Delta', 'Approved/Proposed', 'Remaining Failures & Decision'],
      [35, 65, 85, 65, 75, 182],
      opt.iterations.map((it) => [
        `#${it.iterationNumber}`,
        `v${it.baseAgentVersion} -> ${it.newAgentVersion ? 'v' + it.newAgentVersion : '-'}`,
        `${fmtPct(it.previousScorecard.overallScore)} -> ${fmtPct(it.newScorecard?.overallScore ?? null)}`,
        fmtDelta(it.scoreDelta.overall),
        `${it.changesApprovedCount} / ${it.changesProposedCount}`,
        `${it.remainingFailureCount ?? 'N/A'} remaining | ${it.decisionReason}`,
      ])
    );
  }

  // Section G: Final Results
  const fr = report.finalResults;
  pdf.addSectionHeading('G', 'Final Results & Baseline Comparison', fr.availability.toUpperCase());
  if (fr.isIncompleteEvaluation) {
    pdf.addParagraph(`INCOMPLETE FINAL EVALUATION WARNING: ${fr.incompleteReason}`, {
      font: 'F2',
      size: 8.5,
      color: [0.75, 0.25, 0.1],
    });
  }
  pdf.addKeyValue(
    'Final Agent & Run',
    fr.finalEvaluationRunId
      ? `Agent v${fr.finalAgentVersion} | Eval ${fr.finalEvaluationRunId} (${fr.finalEvaluationStatus})`
      : 'Not Available'
  );
  pdf.addKeyValue('Outcome', fr.improvementSummary);
  pdf.addScorecardGrid(scorecardCards(fr.finalScorecard, 'Final'));

  pdf.addComparisonBarChart('Baseline vs Final Evaluation Score Comparison (%)', [
    {
      label: 'Overall Score',
      baseline: be.scorecard.overallScore,
      final: fr.finalScorecard.overallScore,
    },
    {
      label: 'Grounding',
      baseline: be.scorecard.groundingScore,
      final: fr.finalScorecard.groundingScore,
    },
    {
      label: 'Correctness',
      baseline: be.scorecard.correctnessScore,
      final: fr.finalScorecard.correctnessScore,
    },
    {
      label: 'Refusal Qual.',
      baseline: be.scorecard.refusalQualityScore,
      final: fr.finalScorecard.refusalQualityScore,
    },
  ]);

  pdf.addSubHeading(`Remaining Known Failures / Errors / Skipped (${fr.remainingKnownFailures.length})`);
  if (fr.remainingKnownFailures.length > 0) {
    pdf.addTable(
      ['Test ID', 'Category', 'Status', 'Failure / Error Reason'],
      [65, 85, 65, 292],
      fr.remainingKnownFailures.map((f) => [
        f.testCaseId,
        f.category,
        f.status,
        f.failureReason,
      ])
    );
  } else {
    pdf.addParagraph(
      fr.finalEvaluationRunId
        ? 'No failing, errored, or skipped tests remaining in the final recorded evaluation run.'
        : 'Not Available — no evaluation run recorded yet.'
    );
  }

  // Section H: Limitations and Future Improvements
  const lim = report.limitationsAndFutureImprovements;
  pdf.addSectionHeading('H', 'Limitations and Future Improvements');
  pdf.addSubHeading('Unsupported & Partially Supported Requirements');
  pdf.addBulletList(lim.unsupportedRequirements);
  pdf.addSubHeading('Retrieval Limitations');
  pdf.addBulletList(lim.retrievalLimitations);
  pdf.addSubHeading('Evaluation Limitations');
  pdf.addBulletList(lim.evaluationLimitations);
  pdf.addSubHeading('Known Agent Weaknesses');
  pdf.addBulletList(lim.knownAgentWeaknesses);
  pdf.addSubHeading('Features Not Yet Implemented');
  pdf.addBulletList(lim.unimplementedFeatures);
  pdf.addSubHeading('Recommended Next Improvements');
  pdf.addBulletList(lim.recommendedNextImprovements);

  return pdf.buildBuffer();
}

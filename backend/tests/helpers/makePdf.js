/**
 * backend/tests/helpers/makePdf.js
 * ------------------------------------------------------------------
 * Builds a real, valid, uncompressed PDF from plain text lines.
 *
 * The tests need an actual PDF on disk to exercise the upload → parse →
 * score pipeline, and pulling in a PDF-writing library just for that
 * would be overkill. This produces a one-page (or multi-page) Helvetica
 * document that pdf-parse reads back correctly.
 *
 *   const pdf = buildPdf(['John Doe', 'john@example.com']);
 *   fs.writeFileSync('/tmp/resume.pdf', pdf);
 */

const fs = require('fs');

/** Escape the characters that are special inside a PDF text string. */
function escapeText(line) {
  return String(line)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    // pdf-parse chokes on non-latin1 glyphs, so strip them
    .replace(/[^\x20-\x7e]/g, ' ');
}

/**
 * @param {string[]} lines  one entry per text line
 * @param {object} [opts]   { fontName, fontSize, lineHeight, marginTop }
 * @returns {Buffer} a complete PDF file
 */
function buildPdf(lines, opts = {}) {
  const fontSize = opts.fontSize || 11;
  const lineHeight = opts.lineHeight || 15;
  const marginTop = opts.marginTop || 750;
  const marginLeft = opts.marginLeft || 50;
  const pageHeight = 792;
  const usableHeight = marginTop - 60;
  const linesPerPage = Math.max(1, Math.floor(usableHeight / lineHeight));

  // Split into pages.
  const pages = [];
  for (let i = 0; i < Math.max(1, lines.length); i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }
  if (pages.length === 0) pages.push(['']);

  const objects = [];
  const objectOffsets = [];

  /** Reserve the next object number. */
  const nextId = () => objects.length + 1;

  const catalogId = 1;
  const pagesId = 2;
  const fontId = 3;

  // Page + content object ids are allocated in pairs after the first three.
  const pageIds = pages.map(() => 0);
  const contentIds = pages.map(() => 0);

  // Build content streams first so we know their lengths.
  const contentStreams = pages.map((pageLines) => {
    const parts = [`BT /F1 ${fontSize} Tf ${marginLeft} ${marginTop} Td ${lineHeight} TL`];
    pageLines.forEach((line) => {
      parts.push(`(${escapeText(line)}) Tj T*`);
    });
    parts.push('ET');
    return parts.join('\n');
  });

  // Assemble the object table: catalog, pages, font, then page/content pairs.
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');

  objects.push({ id: catalogId, body: `<< /Type /Catalog /Pages ${pagesId} 0 R >>` });
  objects.push({ id: pagesId, body: `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>` });
  objects.push({ id: fontId, body: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>` });

  pages.forEach((_, i) => {
    const pageObjId = 4 + i * 2;
    const contentObjId = 5 + i * 2;
    pageIds[i] = pageObjId;
    contentIds[i] = contentObjId;

    objects.push({
      id: pageObjId,
      body:
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 ${pageHeight}] ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentObjId} 0 R >>`,
    });

    const stream = contentStreams[i];
    objects.push({
      id: contentObjId,
      body: `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    });
  });

  // Serialise with a correct xref table (pdf-parse relies on it).
  let pdf = '%PDF-1.4\n';
  objects.forEach((obj) => {
    objectOffsets[obj.id] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${obj.id} 0 obj\n${obj.body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  const size = objects.length + 1;
  pdf += `xref\n0 ${size}\n`;
  pdf += '0000000000 65535 f \n';
  for (let id = 1; id <= objects.length; id += 1) {
    pdf += `${String(objectOffsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${size} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/** Write a resume PDF to disk and return its path. */
function writeResumePdf(filePath, lines) {
  fs.writeFileSync(filePath, buildPdf(lines));
  return filePath;
}

/** A realistic engineering resume, used by several tests. */
const SAMPLE_RESUME_LINES = [
  'John Doe',
  'john.doe@email.com | +1 (415) 555-0134 | linkedin.com/in/johndoe',
  '',
  'PROFESSIONAL SUMMARY',
  'Senior Frontend Engineer with 7 years of experience building large scale React applications.',
  'Led a team of five engineers and improved Core Web Vitals by 42 percent.',
  '',
  'SKILLS',
  'JavaScript, TypeScript, React, Next.js, Redux, Tailwind CSS, Node.js, Express,',
  'PostgreSQL, MongoDB, AWS, Docker, Kubernetes, Jest, Cypress, GraphQL, CI/CD,',
  'Agile, Scrum, Git, Figma, Communication, Leadership',
  '',
  'WORK EXPERIENCE',
  'Senior Frontend Engineer | Acme Technologies, San Francisco, CA | Jan 2020 - Present',
  '- Architected a design system used by 12 product teams, cutting UI build time by 35%.',
  '- Led migration from Angular to React for a dashboard serving 200k users.',
  '- Mentored 4 junior engineers and ran weekly code review sessions.',
  '',
  'Frontend Developer | Globex Inc, Remote | Mar 2017 - Dec 2019',
  '- Built reusable React components and reduced bundle size by 28%.',
  '- Collaborated with designers in Figma to ship 30 features.',
  '',
  'Software Engineering Intern | Initech | Jun 2016 - Aug 2016',
  '- Automated data pipelines using Python and SQL.',
  '',
  'EDUCATION',
  'Bachelor of Science in Computer Science',
  'University of California, Berkeley | 2017 | GPA: 3.8',
  '',
  'CERTIFICATIONS',
  'AWS Certified Solutions Architect',
];

module.exports = { buildPdf, writeResumePdf, SAMPLE_RESUME_LINES, escapeText };

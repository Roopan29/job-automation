/**
 * backend/tests/services.test.js
 * ------------------------------------------------------------------
 * Unit tests for the pure services: resume parsing, ATS scoring, the
 * matching engine, the template cover letter and scraper normalisation.
 *
 * Run with:  npm test          (or: node --test tests/)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const resumeParser = require('../services/resumeParser');
const atsScorer = require('../services/atsScorer');
const matchingEngine = require('../services/matchingEngine');
const coverLetterGen = require('../services/coverLetterGen');
const jobScraper = require('../services/jobScraper');
const { buildPdf, SAMPLE_RESUME_LINES } = require('./helpers/makePdf');

/* ------------------------------------------------------------------ *
 * resumeParser
 * ------------------------------------------------------------------ */

test('skill dictionary ships 200+ entries', () => {
  assert.ok(resumeParser.SKILL_DICTIONARY.length >= 200, `only ${resumeParser.SKILL_DICTIONARY.length} skills`);
});

test('skill matcher finds aliased skills and does not over-match', () => {
  const skills = resumeParser.extractSkills(
    'Experienced with React, Next.js, Node.js, TypeScript, PostgreSQL, Docker and Kubernetes.'
  );
  const names = skills.map((s) => s.name);

  assert.ok(names.includes('React'), 'React should be detected');
  assert.ok(names.includes('Next.js'), 'Next.js should be detected from "Next.js"');
  assert.ok(names.includes('Node.js'), 'Node.js should be detected');
  assert.ok(names.includes('TypeScript'), 'TypeScript should be detected');

  // "js" inside React.js must not create a phantom JavaScript entry, and
  // the single letter "C" must not match inside "CSS" or "React".
  const text2 = 'I know CSS and React.js only.';
  const names2 = resumeParser.extractSkills(text2).map((s) => s.name);
  assert.ok(names2.includes('CSS'));
  assert.ok(!names2.includes('C'), 'single-letter "C" should not match inside other words');
});

test('experience parser extracts title, company, dates and months', () => {
  const parsed = resumeParser.parseResumeText(
    [
      'WORK EXPERIENCE',
      'Senior Frontend Engineer | Acme Technologies, San Francisco, CA | Jan 2020 - Present',
      '- Architected a design system used by 12 teams, cutting build time by 35%.',
      'Frontend Developer | Globex Inc | Mar 2017 - Dec 2019',
      '- Built reusable React components and reduced bundle size by 28%.',
    ].join('\n')
  );

  assert.equal(parsed.experience.length, 2, `expected 2 roles, got ${parsed.experience.length}`);
  assert.equal(parsed.experience[0].title, 'Senior Frontend Engineer');
  assert.match(parsed.experience[0].company, /Acme Technologies/);
  assert.equal(parsed.experience[0].startDate, '2020-01-01');
  assert.equal(parsed.experience[0].endDate, 'Present');
  assert.ok(parsed.experience[0].months >= 60, 'senior role should span 5+ years');
  assert.equal(parsed.experience[1].endDate, '2019-12-01');
  assert.equal(parsed.experience[1].months, 33);
});

test('education parser does not match "Be" inside "Berkeley"', () => {
  const parsed = resumeParser.parseResumeText(
    ['EDUCATION', 'Bachelor of Science in Computer Science', 'University of California, Berkeley | 2017 | GPA: 3.8'].join('\n')
  );

  assert.equal(parsed.education.length, 1, 'institution line must not become a second degree');
  assert.equal(parsed.education[0].field, 'Computer Science');
  assert.equal(parsed.education[0].year, '2017');
  assert.equal(parsed.education[0].gpa, '3.8');
});

test('contact parser separates email domain from website', () => {
  const { contact } = resumeParser.parseResumeText(
    'Jane Roe\njane@corp.io | linkedin.com/in/jane | janeroe.dev | github.com/jane'
  );
  assert.equal(contact.email, 'jane@corp.io');
  assert.equal(contact.linkedin, 'linkedin.com/in/jane');
  assert.equal(contact.github, 'github.com/jane');
  assert.equal(contact.website, 'janeroe.dev');
  assert.equal(contact.name, 'Jane Roe');
});

test('seniority guessing follows the title', () => {
  assert.equal(resumeParser.guessSeniority('Junior Developer'), 'entry');
  assert.equal(resumeParser.guessSeniority('Software Engineer'), 'mid');
  assert.equal(resumeParser.guessSeniority('Senior Staff Engineer'), 'senior');
});

test('a real PDF round-trips through pdf-parse', async () => {
  const file = path.join(os.tmpdir(), `jobbot-test-${Date.now()}.pdf`);
  fs.writeFileSync(file, buildPdf(SAMPLE_RESUME_LINES));

  try {
    const parsed = await resumeParser.parseResume(file, 'pdf');
    assert.equal(parsed.parseError, undefined, `parse error: ${parsed.parseError}`);
    assert.ok(parsed.wordCount > 100, `expected a real word count, got ${parsed.wordCount}`);
    assert.equal(parsed.contact.email, 'john.doe@email.com');
    assert.equal(parsed.contact.name, 'John Doe');
    assert.equal(parsed.experience.length, 3);
    assert.equal(parsed.education.length, 1);
    assert.ok(parsed.skills.length >= 20, `expected 20+ skills, got ${parsed.skills.length}`);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('parsing a missing file degrades gracefully instead of throwing', async () => {
  const parsed = await resumeParser.parseResume('/tmp/definitely-not-here.pdf', 'pdf');
  assert.equal(parsed.skills.length, 0);
  assert.equal(parsed.experience.length, 0);
  assert.ok(parsed.parseError, 'a parseError should be reported');
});

test('unsupported file types degrade gracefully with a clear parseError', async () => {
  // parseResume never throws – callers rely on the default shape. The
  // hard rejection of a .txt upload happens in uploadMiddleware (415),
  // which the API test covers.
  const file = path.join(os.tmpdir(), `jobbot-test-${Date.now()}.txt`);
  fs.writeFileSync(file, 'hello');
  try {
    const parsed = await resumeParser.parseResume(file, 'txt');
    assert.match(parsed.parseError || '', /Unsupported resume type/);
    assert.equal(parsed.skills.length, 0);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

/* ------------------------------------------------------------------ *
 * atsScorer
 * ------------------------------------------------------------------ */

test('ATS weights sum to exactly 100', () => {
  const total = Object.values(atsScorer.WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
});

test('a strong resume scores far higher than an empty one', () => {
  const good = resumeParser.parseResumeText(SAMPLE_RESUME_LINES.join('\n'));
  const goodScore = atsScorer.scoreResume(good.rawText, good);

  const bad = resumeParser.parseResumeText('Bob\nhello');
  const badScore = atsScorer.scoreResume(bad.rawText, bad);

  assert.ok(goodScore.totalScore > 70, `expected a strong score, got ${goodScore.totalScore}`);
  assert.ok(badScore.totalScore < 40, `expected a weak score, got ${badScore.totalScore}`);
  assert.ok(goodScore.totalScore > badScore.totalScore);
  assert.equal(Object.keys(goodScore.breakdown).length, 8, 'all 8 categories must be reported');
});

test('every breakdown category is clamped to its own maximum', () => {
  const parsed = resumeParser.parseResumeText(SAMPLE_RESUME_LINES.join('\n'));
  const { breakdown } = atsScorer.scoreResume(parsed.rawText, parsed);

  Object.entries(breakdown).forEach(([key, entry]) => {
    assert.ok(entry.score >= 0, `${key} score must be >= 0`);
    assert.ok(entry.score <= entry.max, `${key} score ${entry.score} exceeds max ${entry.max}`);
    assert.ok(Array.isArray(entry.details) && entry.details.length > 0, `${key} needs details`);
  });
});

/* ------------------------------------------------------------------ *
 * matchingEngine
 * ------------------------------------------------------------------ */

const SAMPLE_RESUME = resumeParser.parseResumeText(SAMPLE_RESUME_LINES.join('\n'));

test('a job whose skills are all on the resume scores higher than one that is not', () => {
  const goodJob = {
    title: 'Senior Frontend Engineer',
    description: 'We need React, TypeScript, Next.js, Jest and AWS experience.',
    requirements: ['React', 'TypeScript', 'Next.js', 'Jest', 'AWS'],
    location: 'Remote',
    job_type: 'remote',
  };

  const badJob = {
    title: 'Machine Learning Engineer',
    description: 'PyTorch, TensorFlow, Spark, Hadoop, Scala and Kafka required.',
    requirements: ['PyTorch', 'TensorFlow', 'Spark', 'Hadoop', 'Scala', 'Kafka'],
    location: 'Onsite Berlin',
    job_type: 'onsite',
  };

  const good = matchingEngine.matchJobToResume(goodJob, SAMPLE_RESUME, { preferredLocations: ['Remote'] });
  const bad = matchingEngine.matchJobToResume(badJob, SAMPLE_RESUME, { preferredLocations: ['Remote'] });

  assert.ok(good.matchScore > 80, `expected a strong match, got ${good.matchScore}`);
  assert.ok(bad.matchScore < 30, `expected a weak match, got ${bad.matchScore}`);
  assert.deepEqual(good.matchedSkills.sort(), ['AWS', 'Jest', 'Next.js', 'React', 'TypeScript'].sort());
  assert.equal(good.missingSkills.length, 0);
  assert.ok(bad.missingSkills.length >= 5);
});

test('match score is always capped at 100 and never negative or NaN', () => {
  const jobs = [
    { title: 'React Developer', description: 'React', requirements: ['React'] },
    { title: '', description: '' },
    { title: 'Odd', description: '...', requirements: ['NothingLikeThis'] },
  ];

  jobs.forEach((job) => {
    const m = matchingEngine.matchJobToResume(job, SAMPLE_RESUME);
    assert.ok(Number.isFinite(m.matchScore), `score must be finite, got ${m.matchScore}`);
    assert.ok(m.matchScore >= 0 && m.matchScore <= 100, `score out of range: ${m.matchScore}`);
  });
});

test('scoring without a resume returns zero and lists the requirements', () => {
  const m = matchingEngine.matchJobToResume(
    { title: 'Dev', description: 'React and Go', requirements: ['React', 'Go'] },
    null
  );
  assert.equal(m.matchScore, 0);
  assert.deepEqual(m.matchedSkills, []);
  assert.ok(m.requiredSkills.length >= 1);
});

test('topSkillGaps counts the most common missing skills', () => {
  const gaps = matchingEngine.topSkillGaps([
    { missingSkills: ['Rust', 'Go'] },
    { missingSkills: ['Rust', 'Kafka'] },
    { missingSkills: '["Rust"]' }, // stored as JSON text in the DB
  ]);

  assert.equal(gaps[0].skill.toLowerCase(), 'rust');
  assert.equal(gaps[0].count, 3);
  assert.equal(gaps[0].percentage, 100);
});

test('required years are read out of the description', () => {
  assert.equal(matchingEngine.requiredYears({ description: 'You have 5+ years of experience' }), 5);
  assert.equal(matchingEngine.requiredYears({ description: 'No requirement stated' }), null);
});

test('requirements are accepted as an array, a JSON string and free text', () => {
  // normalizeJob() emits a JSON string; mapJob() emits a real array. Both
  // shapes reach the matcher in production, so neither may throw.
  const asArray = matchingEngine.matchJobToResume(
    { title: 'Dev', description: 'x', requirements: ['React', 'Jest'] },
    SAMPLE_RESUME
  );
  const asJsonString = matchingEngine.matchJobToResume(
    { title: 'Dev', description: 'x', requirements: '["React","Jest"]' },
    SAMPLE_RESUME
  );
  const asFreeText = matchingEngine.matchJobToResume(
    { title: 'Dev', description: 'x', requirements: 'React and Jest experience' },
    SAMPLE_RESUME
  );

  assert.ok(asArray.matchedSkills.includes('React'));
  assert.equal(asJsonString.matchScore, asArray.matchScore, 'JSON string must score like the array');
  assert.ok(asJsonString.matchedSkills.includes('Jest'));
  assert.ok(Number.isFinite(asFreeText.matchScore));
});

/* ------------------------------------------------------------------ *
 * coverLetterGen (template path – no API key needed)
 * ------------------------------------------------------------------ */

test('the template cover letter is tailored and complete', async () => {
  const job = {
    title: 'Senior React Developer',
    company: 'Acme Corp',
    description:
      'We are building a design platform used by millions of creators. We value ownership and craft.',
    requirements: ['React', 'TypeScript'],
    location: 'Remote',
    job_type: 'remote',
  };

  const result = await coverLetterGen.buildCoverLetter(job, SAMPLE_RESUME, {
    tone: 'professional',
    forceTemplate: true,
  });

  assert.equal(result.source, 'template');
  assert.ok(result.coverLetter.length > 400, `letter too short: ${result.coverLetter.length}`);
  assert.match(result.coverLetter, /Senior React Developer/);
  assert.match(result.coverLetter, /Acme Corp/);
  assert.match(result.coverLetter, /React/);
  assert.match(result.coverLetter, /Sincerely/);
  assert.ok(!/\{\w+\}/.test(result.coverLetter), 'no unfilled {placeholders} should remain');
});

test('interview prep always returns 10 questions', async () => {
  const prep = await coverLetterGen.buildInterviewPrep({ title: 'React Dev', company: 'Acme' }, SAMPLE_RESUME);
  assert.equal(prep.questions.length, 10);
  prep.questions.forEach((q) => {
    assert.ok(q.question.length > 5, 'every question needs text');
    assert.ok(q.suggestedAnswer.length > 20, 'every answer needs guidance');
  });
});

test('follow-up email template includes a subject line', async () => {
  const { emailDraft } = await coverLetterGen.buildFollowUpEmail(
    { title: 'React Dev', company: 'Acme' },
    SAMPLE_RESUME,
    new Date(Date.now() - 7 * 86400000).toISOString()
  );
  assert.match(emailDraft, /^Subject: /);
  assert.match(emailDraft, /Acme/);
});

/* ------------------------------------------------------------------ *
 * jobScraper normalisation
 * ------------------------------------------------------------------ */

test('normalizeJob infers type, level, salary and requirements', () => {
  const job = jobScraper.normalizeJob({
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Remote - Anywhere',
    description:
      'We are fully remote. Salary $120k-$160k.\n- 5 years of experience with Node.js\n- Strong SQL knowledge\n- Familiar with Kubernetes',
    requirements: [],
    source: 'remoteok',
    source_url: 'https://remoteok.com/l/12345',
    posted_date: '2026-01-15T10:00:00Z',
  });

  assert.equal(job.job_type, 'remote');
  assert.equal(job.experience_level, 'senior');
  assert.match(job.salary, /\$120k/);
  assert.equal(job.posted_date, '2026-01-15');
  assert.equal(job.source, 'RemoteOK');
  assert.ok(job.requirements.length >= 2, `expected parsed requirements, got ${JSON.parse(job.requirements).length}`);
});

test('normalizeJob drops entries with no title', () => {
  assert.equal(jobScraper.normalizeJob({ title: '', description: 'x' }), null);
});

test('dedupe removes jobs that share a source URL', () => {
  const jobs = [
    { title: 'A', source_url: 'https://x.com/1' },
    { title: 'A duplicate', source_url: 'https://x.com/1' },
    { title: 'B', source_url: 'https://x.com/2' },
  ];
  assert.equal(jobScraper.dedupe(jobs).length, 2);
});

test('"3 days ago" is converted to an ISO date', () => {
  const job = jobScraper.normalizeJob({
    title: 'Dev',
    source: 'indeed',
    source_url: 'https://indeed.com/x',
    posted_text: '3 days ago',
  });
  const expected = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  assert.equal(job.posted_date, expected);
});

test('a scrape against unreachable sources fails per-source, never throws', async () => {
  const result = await jobScraper.scrapeJobs({
    query: 'react',
    location: 'Remote',
    sources: ['remoteok'],
    limit: 3,
    useBrowser: false,
  });

  assert.equal(Array.isArray(result.jobs), true);
  assert.equal(result.results.length, 1);
  assert.ok(['success', 'failed'].includes(result.results[0].status));
  // Whatever happened, the failure reason must be human readable.
  if (result.results[0].status === 'failed') {
    assert.ok(result.results[0].error.length > 5, 'a failed source needs an explanatory error');
    assert.notEqual(result.results[0].error, 'fetch failed', 'the raw undici message should be unwrapped');
  }
});

test('unknown sources are ignored rather than crashing the run', async () => {
  const result = await jobScraper.scrapeJobs({ query: 'x', sources: ['not-a-real-board'], useBrowser: false });
  assert.equal(result.results[0].status, 'failed');
  assert.match(result.results[0].error, /No valid sources/);
});

/* ------------------------------------------------------------------ *
 * autoApplyBot error flattening
 * ------------------------------------------------------------------ */

test('a multi-line Puppeteer launch error is flattened, not truncated', () => {
  const { flattenLaunchError } = require('../services/autoApplyBot');

  // The real message Puppeteer throws when Chrome is missing: line 0 ends
  // mid-sentence and the actual fix lives on the later lines.
  const real = new Error(
    [
      'Could not find Chrome (ver. 127.0.6533.88). This can occur if either',
      ' 1. you did not perform an installation before running the script (e.g. `npx puppeteer browsers install chrome`) or',
      ' 2. your cache path is incorrectly configured (which is: /root/.cache/puppeteer).',
      'For (2), check out our guide on configuring puppeteer at https://pptr.dev/guides/configuration.',
    ].join('\n')
  );

  const flat = flattenLaunchError(real);

  assert.equal(flat.includes('\n'), false, 'must be a single line');
  assert.equal(
    flat.endsWith('either'),
    false,
    'must not end mid-sentence the way line 0 does'
  );
  assert.ok(
    flat.includes('npx puppeteer browsers install chrome'),
    'must keep the actionable install command'
  );
  assert.ok(flat.length <= 300, `must be capped, got ${flat.length}`);
});

test('flattenLaunchError tolerates junk input', () => {
  const { flattenLaunchError } = require('../services/autoApplyBot');

  assert.equal(typeof flattenLaunchError(new Error('boom')), 'string');
  assert.equal(flattenLaunchError(new Error('boom')), 'boom');
  assert.equal(typeof flattenLaunchError(undefined), 'string');
  assert.ok(flattenLaunchError(undefined).length > 0, 'never returns an empty reason');
  assert.ok(
    flattenLaunchError(new Error('x'.repeat(5000))).length <= 300,
    'a huge message is capped'
  );
});

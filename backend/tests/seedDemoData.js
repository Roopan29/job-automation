/**
 * backend/tests/seedDemoData.js
 * ------------------------------------------------------------------
 * Populates the database with a realistic set of jobs and applications
 * so the whole UI can be explored without internet access to the job
 * boards (scraping needs egress to remoteok.com / linkedin.com etc.).
 *
 *   npm run seed            add demo jobs + a few applications
 *   npm run seed -- --fresh wipe jobs/applications first
 *
 * Every demo job is scored against your default resume by the real
 * matching engine, so the match percentages on screen are genuine.
 * If no resume is uploaded yet, jobs are stored with a 0% score and
 * re-scored automatically the moment you upload one.
 */

const log = require('../utils/logger');
const { getDb } = require('../db/initDB');
const jobScraper = require('../services/jobScraper');
const jobController = require('../controllers/jobController');
const { getDefaultResume } = require('../controllers/resumeController');
const { createApplication } = require('../controllers/applyController');

const DAY = 86400000;

/** Jobs spread across sources, levels and locations. */
const DEMO_JOBS = [
  {
    title: 'Senior React Developer',
    company: 'Northwind Labs',
    location: 'Remote - US',
    salary: '$150k - $185k',
    description:
      'Northwind Labs builds analytics tooling used by 40,000 companies. We are a fully remote team of 60 and we are looking for a senior React engineer to own our dashboard surface.\n\nWhat you will do:\n- Lead the migration of our dashboard from class components to modern React with hooks and TypeScript\n- Design and ship a component library used by five product teams\n- Partner with design in Figma and drive the implementation end to end\n- Improve Core Web Vitals and cut time-to-interactive\n\nWhat we look for:\n- 5+ years building production React applications\n- Deep TypeScript, testing with Jest and React Testing Library\n- Experience with GraphQL, Next.js and CI/CD pipelines\n- Comfortable with AWS and Docker',
    requirements: ['React', 'TypeScript', 'Next.js', 'Jest', 'GraphQL', 'AWS', 'Docker', 'CI/CD'],
    source: 'RemoteOK',
    source_url: 'https://remoteok.com/remote-jobs/10001-senior-react-developer',
    posted_date: new Date(Date.now() - 1 * DAY).toISOString(),
  },
  {
    title: 'Frontend Engineer',
    company: 'Brightline',
    location: 'Remote - Europe',
    salary: '€70k - €90k',
    description:
      'Brightline is a fintech startup helping freelancers get paid. You will build the customer-facing web app in React with a heavy focus on accessibility and performance.\n\nResponsibilities:\n- Build features in React, Redux and TypeScript\n- Write unit and end-to-end tests with Jest and Cypress\n- Work closely with designers in Figma\n- Own the frontend deployment pipeline\n\nRequirements:\n- 3+ years of frontend experience\n- Strong CSS and responsive design skills\n- Experience with REST APIs and state management\n- Familiarity with accessibility (WCAG)',
    requirements: ['React', 'Redux', 'TypeScript', 'CSS', 'Jest', 'Cypress', 'Figma', 'Web Accessibility'],
    source: 'LinkedIn',
    source_url: 'https://www.linkedin.com/jobs/view/10002',
    posted_date: new Date(Date.now() - 2 * DAY).toISOString(),
  },
  {
    title: 'Full Stack Engineer (Node.js)',
    company: 'Meridian Health',
    location: 'Hybrid - Austin, TX',
    salary: '$130k - $160k',
    description:
      'Meridian Health modernises clinic software. This is a hybrid role, three days a week in Austin.\n\nYou will:\n- Build and maintain REST APIs in Node.js and Express\n- Model data in PostgreSQL and write efficient queries\n- Ship React frontends that consume those APIs\n- Participate in an on-call rotation\n\nWe are looking for:\n- 4+ years with Node.js and Express\n- Strong PostgreSQL and database design skills\n- React experience\n- Docker and Kubernetes familiarity',
    requirements: ['Node.js', 'Express', 'PostgreSQL', 'React', 'Docker', 'Kubernetes', 'REST API Design'],
    source: 'Indeed',
    source_url: 'https://www.indeed.com/viewjob?jk=demo10003',
    posted_date: new Date(Date.now() - 3 * DAY).toISOString(),
  },
  {
    title: 'Staff Software Engineer, Platform',
    company: 'Cobalt Systems',
    location: 'Onsite - Seattle, WA',
    salary: '$190k - $240k',
    description:
      'Cobalt Systems runs the internal platform behind a marketplace with 12 million users. This is a senior, onsite role.\n\nWhat you will own:\n- The Kubernetes-based deployment platform used by 200 engineers\n- Service reliability, observability and incident response\n- Mentoring senior and mid-level engineers\n\nRequirements:\n- 8+ years of software engineering experience\n- Deep Kubernetes, Terraform and AWS knowledge\n- Strong Go or Python\n- Experience leading technical strategy',
    requirements: ['Kubernetes', 'Terraform', 'AWS', 'Go', 'Python', 'Monitoring', 'Microservices', 'Leadership'],
    source: 'Glassdoor',
    source_url: 'https://www.glassdoor.com/partner/jobListing.htm?pos=10004',
    posted_date: new Date(Date.now() - 4 * DAY).toISOString(),
  },
  {
    title: 'Machine Learning Engineer',
    company: 'Vantage AI',
    location: 'Remote - Worldwide',
    salary: '$160k - $210k',
    description:
      'Vantage AI builds retrieval systems over enterprise documents. You will own model training and serving.\n\nYou will:\n- Train and evaluate models with PyTorch\n- Build data pipelines in Spark and Airflow\n- Serve models behind a Python API\n\nRequirements:\n- Strong PyTorch and TensorFlow\n- Experience with Spark, Hadoop and Kafka\n- Python and SQL fluency\n- 4+ years in applied ML',
    requirements: ['PyTorch', 'TensorFlow', 'Spark', 'Hadoop', 'Kafka', 'Python', 'Machine Learning', 'SQL'],
    source: 'RemoteOK',
    source_url: 'https://remoteok.com/remote-jobs/10005-machine-learning-engineer',
    posted_date: new Date(Date.now() - 5 * DAY).toISOString(),
  },
  {
    title: 'Junior Frontend Developer',
    company: 'Paperkite Studio',
    location: 'Remote',
    salary: '$60k - $80k',
    description:
      'Paperkite is a small design studio building marketing sites. A great first role for someone with 0-2 years of experience.\n\nYou will:\n- Build responsive pages with HTML, CSS and JavaScript\n- Turn Figma designs into production components\n- Fix bugs and improve accessibility\n\nWe would love:\n- 1+ year with React or Vue\n- Solid CSS and responsive design\n- Curiosity and a portfolio of side projects',
    requirements: ['HTML', 'CSS', 'JavaScript', 'React', 'Responsive Design', 'Figma'],
    source: 'Remotive',
    source_url: 'https://remotive.com/remote-jobs/10006',
    posted_date: new Date(Date.now() - 6 * DAY).toISOString(),
  },
  {
    title: 'DevOps Engineer',
    company: 'Foundry Cloud',
    location: 'Remote - US',
    salary: '$140k - $170k',
    description:
      'Foundry Cloud operates infrastructure for SaaS companies. You will automate everything.\n\nResponsibilities:\n- Build CI/CD pipelines with GitHub Actions\n- Manage Kubernetes clusters on AWS\n- Write Terraform modules\n- Improve observability with Prometheus and Grafana\n\nRequirements:\n- 4+ years in DevOps or SRE\n- Strong Linux and Shell scripting\n- Terraform, Kubernetes, AWS\n- Monitoring and incident response experience',
    requirements: ['Kubernetes', 'Terraform', 'AWS', 'CI/CD', 'GitHub Actions', 'Linux', 'Prometheus', 'Docker'],
    source: 'LinkedIn',
    source_url: 'https://www.linkedin.com/jobs/view/10007',
    posted_date: new Date(Date.now() - 7 * DAY).toISOString(),
  },
  {
    title: 'Product Designer',
    company: 'Lumen',
    location: 'Hybrid - New York, NY',
    salary: '$120k - $150k',
    description:
      'Lumen is hiring a product designer to own a core surface of the product.\n\nYou will:\n- Run discovery and usability testing\n- Design flows in Figma and maintain the design system\n- Partner with engineers through hand-off\n\nLooking for:\n- 4+ years of product design\n- Strong Figma and prototyping skills\n- Experience with design systems\n- Excellent communication',
    requirements: ['Figma', 'UI Design', 'UX Design', 'Design Systems', 'Prototyping', 'Communication'],
    source: 'Indeed',
    source_url: 'https://www.indeed.com/viewjob?jk=demo10008',
    posted_date: new Date(Date.now() - 8 * DAY).toISOString(),
  },
];

/** A small, believable application history for the tracker + charts. */
const DEMO_APPLICATIONS = [
  { company: 'Brightline', status: 'interview', daysAgo: 9, method: 'manual', followUpInDays: 2, notes: 'Recruiter screen done. Technical round scheduled.' },
  { company: 'Meridian Health', status: 'responded', daysAgo: 12, method: 'auto', followUpInDays: 5, notes: 'Hiring manager replied, asking for availability.' },
  { company: 'Cobalt Systems', status: 'rejected', daysAgo: 21, method: 'manual', notes: 'Went with an internal candidate.' },
  { company: 'Paperkite Studio', status: 'applied', daysAgo: 4, method: 'auto', followUpInDays: 4, notes: '' },
  { company: 'Foundry Cloud', status: 'ghosted', daysAgo: 34, method: 'auto', notes: 'No reply after three weeks.' },
];

/**
 * Insert the demo jobs through the same code path the scraper uses.
 * @returns {{added:number, updated:number}}
 */
function seedJobs() {
  const resume = getDefaultResume();
  if (!resume) {
    log.warn('No resume uploaded yet – demo jobs will be stored with a 0% match score.');
    log.warn('Upload a resume and they will be re-scored automatically.');
  }

  const db = getDb();
  let added = 0;
  let updated = 0;

  const run = db.transaction(() => {
    DEMO_JOBS.forEach((job) => {
      const normalised = jobScraper.normalizeJob({ ...job, source: job.source.toLowerCase() });
      // normalizeJob lowercases the source key, but the DB stores the
      // human label – restore it so the UI badges read correctly.
      normalised.source = job.source;

      const result = jobController.upsertJob(normalised, resume);
      if (result === 'added') added += 1;
      else updated += 1;
    });
  });
  run();

  return { added, updated };
}

/** Create applications against the demo jobs. */
function seedApplications() {
  const db = getDb();
  const resume = getDefaultResume();
  let created = 0;

  DEMO_APPLICATIONS.forEach((spec) => {
    const job = db.prepare('SELECT * FROM jobs WHERE company = ?').get(spec.company);
    if (!job) {
      log.warn(`Demo job for ${spec.company} not found – skipping its application`);
      return;
    }

    // Already applied in a previous run?
    const existing = db.prepare('SELECT id FROM applications WHERE job_id = ?').get(job.id);
    if (existing) return;

    const appliedAt = new Date(Date.now() - spec.daysAgo * DAY).toISOString().slice(0, 19).replace('T', ' ');
    const followUp = spec.followUpInDays
      ? new Date(Date.now() + spec.followUpInDays * DAY).toISOString().slice(0, 10)
      : null;

    const id = createApplication({
      jobId: job.id,
      resumeId: resume ? resume.id : null,
      coverLetter: '',
      method: spec.method,
      status: 'applied',
      notes: spec.notes,
    });

    // Backdate the row and move it to the requested status so the charts
    // and the tracker show something interesting.
    db.prepare(
      `UPDATE applications
          SET applied_at = ?, last_updated = ?, follow_up_date = ?
        WHERE id = ?`
    ).run(appliedAt, appliedAt, followUp, id);

    if (spec.status !== 'applied') {
      db.prepare(
        `INSERT INTO status_history (application_id, old_status, new_status, note, changed_at)
         VALUES (?, 'applied', ?, ?, ?)`
      ).run(id, spec.status, spec.notes || null, appliedAt);
      db.prepare("UPDATE applications SET status = ? WHERE id = ?").run(spec.status, id);
    }

    created += 1;
  });

  return created;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function main() {
  const fresh = process.argv.includes('--fresh');
  const db = getDb();

  if (fresh) {
    log.warn('--fresh: clearing applications, status history and jobs');
    db.exec(`
      DELETE FROM status_history;
      DELETE FROM applications;
      DELETE FROM jobs;
      DELETE FROM scrape_logs;
    `);
  }

  const { added, updated } = seedJobs();
  const applications = seedApplications();

  const jobCount = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
  const appCount = db.prepare('SELECT COUNT(*) AS n FROM applications').get().n;
  const top = db.prepare('SELECT title, company, match_score FROM jobs ORDER BY match_score DESC LIMIT 3').all();

  log.banner('Demo data seeded', [
    `Jobs:         ${added} added, ${updated} refreshed (${jobCount} total)`,
    `Applications: ${applications} added (${appCount} total)`,
    `Top matches:  ${top.map((t) => `${t.company} ${Math.round(t.match_score)}%`).join(' · ') || 'upload a resume'}`,
    '',
    'Start the frontend (`cd frontend && npm run dev`) to explore the UI.',
  ]);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    log.error(`Seeding failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { seedJobs, seedApplications, DEMO_JOBS, DEMO_APPLICATIONS };

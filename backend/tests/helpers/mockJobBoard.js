/**
 * backend/tests/helpers/mockJobBoard.js
 * ------------------------------------------------------------------
 * A tiny local HTTP server that mimics the public JSON APIs of RemoteOK
 * and Remotive.
 *
 * Why this exists: the real boards are unreachable from CI and sandboxes
 * (egress is blocked), which left the scraper's *parsing* logic — the part
 * that actually transforms a payload into a job row — completely
 * untested. Pointing the scraper at this mock exercises that logic for
 * real, with no network dependency.
 *
 * Usage:
 *   const board = await startMockJobBoard();
 *   process.env.REMOTEOK_API_URL = board.remoteOkUrl;
 *   process.env.REMOTIVE_API_URL = board.remotiveUrl;
 *   ... run the scraper ...
 *   await board.close();
 */

const http = require('http');

/** RemoteOK payload: element 0 is legal boilerplate with no id/position. */
const REMOTEOK_PAYLOAD = [
  { legal: 'boilerplate-without-id' },
  {
    id: 1001,
    position: 'Senior React Developer',
    company: 'Acme Corp',
    // Both location fields carry the SAME value on purpose: the parser
    // must not render "Worldwide / Worldwide".
    location: 'Worldwide',
    candidate_required_location: 'Worldwide',
    // Both a numeric range AND a formatted string on purpose: the parser
    // must pick one, not concatenate them.
    salary_min: 140000,
    salary_max: 180000,
    salary: '$140k - $180k',
    description: '<p>Build <b>React</b> apps with TypeScript and GraphQL.</p>',
    tags: ['react', 'typescript', 'graphql'],
    url: 'https://remoteok.com/remote-jobs/1001-senior-react-developer',
    // An ISO date with NO epoch — the combination that used to produce
    // 1970-01-01 because of an operator-precedence bug.
    date: '2026-09-01T10:00:00+00:00',
  },
  {
    id: 1002,
    position: 'Backend Engineer',
    company: 'Globex',
    location: 'Europe',
    salary_min: 90000,
    salary_max: 120000,
    description: 'Node.js and PostgreSQL services.',
    tags: ['node', 'postgresql'],
    url: 'https://remoteok.com/remote-jobs/1002-backend-engineer',
    date: '2026-08-20T08:00:00+00:00',
    epoch: 1787788800,
  },
];

/** Remotive payload. */
const REMOTIVE_PAYLOAD = {
  'job-count': 1,
  jobs: [
    {
      id: 2001,
      url: 'https://remotive.com/remote-jobs/2001',
      title: 'Frontend Engineer',
      company_name: 'Initech',
      candidate_required_location: 'Remote - US',
      salary: '$110k - $140k',
      description: '<div>Vue and React work.</div>',
      tags: ['vue', 'react'],
      publication_date: '2026-09-02T09:00:00',
    },
  ],
};

/**
 * LinkedIn public guest search markup. Uses the `base-search-card`
 * class names the scraper looks for.
 */
const LINKEDIN_HTML = `<!doctype html><html><body><ul>
  <li class="base-card">
    <div class="base-search-card__title">Product Designer</div>
    <div class="base-search-card__subtitle"><a href="https://linkedin.com/company/umbrella">Umbrella</a></div>
    <div class="base-search-card__location">Remote - UK</div>
    <span class="job-search-card__salary-info">£60k - £80k</span>
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/3001?trackingId=abc123">link</a>
    <div class="base-search-card__snippet">Design and ship product experiences.</div>
    <time datetime="2026-09-03">3 days ago</time>
  </li>
  <li class="base-card">
    <div class="base-search-card__title">Staff Platform Engineer</div>
    <div class="base-search-card__subtitle"><a href="https://linkedin.com/company/soylent">Soylent</a></div>
    <div class="base-search-card__location">Berlin, Germany</div>
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/3002">link</a>
    <time datetime="2026-08-30">1 week ago</time>
  </li>
</ul></body></html>`;

/** What LinkedIn serves when it decides you must log in. */
const LINKEDIN_AUTHWALL_HTML =
  '<html><body><div id="authwall">Sign in to LinkedIn to continue</div></body></html>';

/**
 * Start the mock board on an ephemeral port.
 * @param {{linkedinMode?: 'jobs'|'authwall'}} [opts]
 * @returns {Promise<{port:number, remoteOkUrl:string, remotiveUrl:string, linkedinUrl:string, close:Function}>}
 */
function startMockJobBoard(opts = {}) {
  const linkedinMode = opts.linkedinMode || 'jobs';

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/remoteok')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(REMOTEOK_PAYLOAD));
      return;
    }
    if (req.url.startsWith('/remotive')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(REMOTIVE_PAYLOAD));
      return;
    }
    if (req.url.startsWith('/linkedin')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(linkedinMode === 'authwall' ? LINKEDIN_AUTHWALL_HTML : LINKEDIN_HTML);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        remoteOkUrl: `http://127.0.0.1:${port}/remoteok`,
        remotiveUrl: `http://127.0.0.1:${port}/remotive`,
        linkedinUrl: `http://127.0.0.1:${port}/linkedin`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startMockJobBoard, REMOTEOK_PAYLOAD, REMOTIVE_PAYLOAD };

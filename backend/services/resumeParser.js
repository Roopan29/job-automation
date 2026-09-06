/**
 * backend/services/resumeParser.js
 * ------------------------------------------------------------------
 * Turns a PDF / DOCX resume into structured data.
 *
 *   parseResume(filePath, fileType) -> {
 *     rawText, skills, experience, education, summary,
 *     contact: { email, phone, linkedin, website, name },
 *     sections, wordCount, parsedAt
 *   }
 *
 * Text extraction uses `pdf-parse` for PDFs and `mammoth` for DOCX.
 * Everything after that is deterministic pattern matching:
 *
 *   • skills      – matched against SKILL_DICTIONARY (300+ entries)
 *   • experience  – "Job title | Company | Mon YYYY – Mon YYYY" blocks
 *   • education   – degree phrases + institution + graduation year
 *   • summary     – the paragraph under Summary / Objective / Profile
 *   • contact     – email, phone, LinkedIn / portfolio URLs, full name
 *
 * Parsing is best-effort: a malformed resume never throws, it simply
 * returns fewer fields with empty defaults.
 */

const fs = require('fs');
const path = require('path');
const log = require('../utils/logger');

/* ------------------------------------------------------------------ *
 * 1. Skill dictionary
 * ------------------------------------------------------------------ */

/**
 * Every entry is { name, aliases, category }.
 * `aliases` are additional spellings accepted in a resume
 * ("nodejs" / "node" / "node.js" all resolve to "Node.js").
 */
const SKILL_DICTIONARY = [
  // -- Programming languages ------------------------------------------------
  ['JavaScript', ['javascript', 'js', 'ecmascript'], 'language'],
  ['TypeScript', ['typescript', 'ts'], 'language'],
  ['Python', ['python', 'python3'], 'language'],
  ['Java', ['java'], 'language'],
  ['C++', ['c++', 'cpp'], 'language'],
  ['C', ['c language'], 'language'],
  ['C#', ['c#', 'csharp', 'c sharp'], 'language'],
  ['Go', ['golang', 'go language'], 'language'],
  ['Rust', ['rust'], 'language'],
  ['Ruby', ['ruby'], 'language'],
  ['PHP', ['php'], 'language'],
  ['Swift', ['swift'], 'language'],
  ['Kotlin', ['kotlin'], 'language'],
  ['Scala', ['scala'], 'language'],
  ['R', ['r language'], 'language'],
  ['Dart', ['dart'], 'language'],
  ['Elixir', ['elixir'], 'language'],
  ['Haskell', ['haskell'], 'language'],
  ['Perl', ['perl'], 'language'],
  ['Lua', ['lua'], 'language'],
  ['MATLAB', ['matlab'], 'language'],
  ['Shell Scripting', ['bash', 'shell script', 'shell scripting', 'zsh'], 'language'],
  ['PowerShell', ['powershell'], 'language'],
  ['SQL', ['sql', 'structured query language'], 'language'],
  ['HTML', ['html', 'html5'], 'language'],
  ['CSS', ['css', 'css3'], 'language'],
  ['Sass', ['sass', 'scss'], 'language'],
  ['Solidity', ['solidity'], 'language'],
  ['Groovy', ['groovy'], 'language'],
  ['Clojure', ['clojure'], 'language'],
  ['Objective-C', ['objective-c', 'objective c'], 'language'],
  ['VBA', ['vba'], 'language'],

  // -- Frontend --------------------------------------------------------------
  ['React', ['react', 'react.js', 'reactjs'], 'frontend'],
  ['Next.js', ['next.js', 'nextjs', 'next js'], 'frontend'],
  ['Vue.js', ['vue', 'vue.js', 'vuejs'], 'frontend'],
  ['Nuxt.js', ['nuxt', 'nuxt.js', 'nuxtjs'], 'frontend'],
  ['Angular', ['angular', 'angular.js', 'angularjs', 'angular 2+'], 'frontend'],
  ['Svelte', ['svelte', 'sveltekit', 'svelte.js'], 'frontend'],
  ['Redux', ['redux', 'redux toolkit', 'react-redux'], 'frontend'],
  ['Zustand', ['zustand'], 'frontend'],
  ['Recoil', ['recoil'], 'frontend'],
  ['MobX', ['mobx'], 'frontend'],
  ['Context API', ['context api', 'react context'], 'frontend'],
  ['Tailwind CSS', ['tailwind', 'tailwindcss', 'tailwind css'], 'frontend'],
  ['Bootstrap', ['bootstrap'], 'frontend'],
  ['Material UI', ['material ui', 'material-ui', 'mui'], 'frontend'],
  ['Chakra UI', ['chakra ui', 'chakra'], 'frontend'],
  ['Styled Components', ['styled components', 'styled-components'], 'frontend'],
  ['Webpack', ['webpack'], 'frontend'],
  ['Vite', ['vite'], 'frontend'],
  ['Babel', ['babel'], 'frontend'],
  ['Parcel', ['parcel bundler'], 'frontend'],
  ['Rollup', ['rollup'], 'frontend'],
  ['esbuild', ['esbuild'], 'frontend'],
  ['jQuery', ['jquery'], 'frontend'],
  ['Three.js', ['three.js', 'threejs'], 'frontend'],
  ['D3.js', ['d3.js', 'd3js', 'd3'], 'frontend'],
  ['Chart.js', ['chart.js', 'chartjs'], 'frontend'],
  ['Framer Motion', ['framer motion'], 'frontend'],
  ['GSAP', ['gsap', 'greensock'], 'frontend'],
  ['Responsive Design', ['responsive design', 'responsive web design'], 'frontend'],
  ['Web Accessibility', ['accessibility', 'wcag', 'aria', 'a11y'], 'frontend'],
  ['Progressive Web Apps', ['pwa', 'progressive web app', 'progressive web apps'], 'frontend'],
  ['Web Performance', ['web vitals', 'core web vitals', 'lighthouse', 'performance optimization'], 'frontend'],
  ['SSR', ['server side rendering', 'ssr', 'server-side rendering'], 'frontend'],
  ['REST API Consumption', ['rest api', 'restful api', 'rest apis', 'rest'], 'frontend'],
  ['GraphQL Client', ['apollo client', 'urql'], 'frontend'],

  // -- Backend ---------------------------------------------------------------
  ['Node.js', ['node.js', 'nodejs', 'node'], 'backend'],
  ['Express.js', ['express', 'express.js', 'expressjs'], 'backend'],
  ['NestJS', ['nestjs', 'nest.js'], 'backend'],
  ['Fastify', ['fastify'], 'backend'],
  ['Koa', ['koa'], 'backend'],
  ['Django', ['django'], 'backend'],
  ['Flask', ['flask'], 'backend'],
  ['FastAPI', ['fastapi'], 'backend'],
  ['Spring Boot', ['spring boot', 'spring', 'spring framework'], 'backend'],
  ['Spring', ['spring framework'], 'backend'],
  ['Ruby on Rails', ['ruby on rails', 'rails'], 'backend'],
  ['Laravel', ['laravel'], 'backend'],
  ['ASP.NET', ['asp.net', 'aspnet', '.net', 'dotnet', '.net core'], 'backend'],
  ['Gin', ['gin framework'], 'backend'],
  ['GraphQL', ['graphql', 'graph ql'], 'backend'],
  ['gRPC', ['grpc'], 'backend'],
  ['WebSockets', ['websocket', 'websockets', 'socket.io', 'socketio'], 'backend'],
  ['Microservices', ['microservices', 'micro-services', 'microservice'], 'backend'],
  ['Serverless', ['serverless', 'lambda functions', 'faas'], 'backend'],
  ['REST API Design', ['api design', 'rest api design', 'api development'], 'backend'],
  ['Authentication', ['authentication', 'oauth', 'oauth2', 'jwt', 'json web token', 'auth0', 'sso'], 'backend'],
  ['Authorization', ['authorization', 'rbac', 'abac'], 'backend'],
  ['Message Queues', ['message queue', 'rabbitmq', 'kafka', 'apache kafka', 'sqs', 'pubsub', 'pub/sub'], 'backend'],
  ['Redis', ['redis'], 'backend'],
  ['Celery', ['celery'], 'backend'],
  ['Nginx', ['nginx'], 'backend'],
  ['Apache', ['apache http server'], 'backend'],

  // -- Databases -------------------------------------------------------------
  ['PostgreSQL', ['postgresql', 'postgres'], 'database'],
  ['MySQL', ['mysql'], 'database'],
  ['MongoDB', ['mongodb', 'mongo'], 'database'],
  ['SQLite', ['sqlite'], 'database'],
  ['MariaDB', ['mariadb'], 'database'],
  ['Oracle DB', ['oracle database', 'oracle db', 'plsql', 'pl/sql'], 'database'],
  ['SQL Server', ['sql server', 'mssql', 'ms sql'], 'database'],
  ['DynamoDB', ['dynamodb'], 'database'],
  ['Cassandra', ['cassandra'], 'database'],
  ['CouchDB', ['couchdb'], 'database'],
  ['Firestore', ['firestore', 'cloud firestore'], 'database'],
  ['Elasticsearch', ['elasticsearch', 'elastic search', 'opensearch'], 'database'],
  ['Neo4j', ['neo4j'], 'database'],
  ['Prisma', ['prisma'], 'database'],
  ['Sequelize', ['sequelize'], 'database'],
  ['TypeORM', ['typeorm'], 'database'],
  ['Mongoose', ['mongoose'], 'database'],
  ['Knex', ['knex'], 'database'],
  ['Drizzle ORM', ['drizzle', 'drizzle orm'], 'database'],
  ['Database Design', ['database design', 'data modeling', 'schema design', 'normalization'], 'database'],
  ['Database Migration', ['database migration', 'migrations', 'alembic', 'flyway'], 'database'],
  ['Query Optimization', ['query optimization', 'query tuning', 'indexing'], 'database'],
  ['Snowflake', ['snowflake'], 'database'],
  ['BigQuery', ['bigquery', 'big query'], 'database'],
  ['ClickHouse', ['clickhouse'], 'database'],

  // -- Cloud & DevOps --------------------------------------------------------
  ['AWS', ['aws', 'amazon web services'], 'cloud'],
  ['Azure', ['azure', 'microsoft azure'], 'cloud'],
  ['Google Cloud', ['gcp', 'google cloud', 'google cloud platform'], 'cloud'],
  ['EC2', ['ec2'], 'cloud'],
  ['S3', ['s3', 'amazon s3'], 'cloud'],
  ['Lambda', ['aws lambda', 'lambda'], 'cloud'],
  ['CloudFormation', ['cloudformation'], 'cloud'],
  ['Terraform', ['terraform'], 'devops'],
  ['Ansible', ['ansible'], 'devops'],
  ['Puppet', ['puppet config management'], 'devops'],
  ['Chef', ['chef automation'], 'devops'],
  ['Docker', ['docker', 'containerization', 'containers'], 'devops'],
  ['Kubernetes', ['kubernetes', 'k8s', 'eks', 'gke', 'aks'], 'devops'],
  ['Helm', ['helm charts', 'helm'], 'devops'],
  ['Jenkins', ['jenkins'], 'devops'],
  ['CI/CD', ['ci/cd', 'cicd', 'continuous integration', 'continuous deployment', 'continuous delivery'], 'devops'],
  ['GitHub Actions', ['github actions', 'gh actions'], 'devops'],
  ['GitLab CI', ['gitlab ci', 'gitlab ci/cd'], 'devops'],
  ['CircleCI', ['circleci', 'circle ci'], 'devops'],
  ['Travis CI', ['travis ci', 'travis'], 'devops'],
  ['Git', ['git', 'github', 'gitlab', 'bitbucket', 'version control'], 'devops'],
  ['Linux', ['linux', 'ubuntu', 'centos', 'debian', 'unix'], 'devops'],
  ['Monitoring', ['monitoring', 'prometheus', 'grafana', 'datadog', 'new relic', 'cloudwatch'], 'devops'],
  ['Logging', ['log aggregation', 'splunk', 'elk stack', 'logstash', 'kibana'], 'devops'],
  ['Incident Response', ['incident response', 'on-call', 'site reliability', 'sre'], 'devops'],
  ['Load Balancing', ['load balancing', 'load balancer', 'auto scaling', 'autoscaling'], 'devops'],
  ['CDN', ['cdn', 'cloudflare', 'content delivery network'], 'devops'],
  ['Vercel', ['vercel'], 'devops'],
  ['Netlify', ['netlify'], 'devops'],
  ['Heroku', ['heroku'], 'devops'],
  ['Firebase', ['firebase'], 'devops'],
  ['Supabase', ['supabase'], 'devops'],
  ['Nginx Config', ['reverse proxy'], 'devops'],

  // -- Mobile ----------------------------------------------------------------
  ['React Native', ['react native'], 'mobile'],
  ['Flutter', ['flutter'], 'mobile'],
  ['iOS Development', ['ios development', 'ios', 'swiftui', 'uikit'], 'mobile'],
  ['Android Development', ['android development', 'android sdk', 'jetpack compose'], 'mobile'],
  ['Expo', ['expo'], 'mobile'],
  ['Mobile UI', ['mobile ui', 'mobile app development', 'mobile development'], 'mobile'],
  ['App Store Deployment', ['app store', 'play store', 'testflight'], 'mobile'],

  // -- Data / ML -------------------------------------------------------------
  ['Machine Learning', ['machine learning', 'ml'], 'data'],
  ['Deep Learning', ['deep learning'], 'data'],
  ['TensorFlow', ['tensorflow'], 'data'],
  ['PyTorch', ['pytorch'], 'data'],
  ['Keras', ['keras'], 'data'],
  ['scikit-learn', ['scikit-learn', 'sklearn', 'scikit learn'], 'data'],
  ['Pandas', ['pandas'], 'data'],
  ['NumPy', ['numpy'], 'data'],
  ['Matplotlib', ['matplotlib'], 'data'],
  ['Seaborn', ['seaborn'], 'data'],
  ['Plotly', ['plotly'], 'data'],
  ['OpenCV', ['opencv', 'computer vision'], 'data'],
  ['NLP', ['nlp', 'natural language processing', 'spacy', 'nltk'], 'data'],
  ['LLMs', ['llm', 'llms', 'large language model', 'gpt', 'gpt-4', 'langchain', 'prompt engineering'], 'data'],
  ['Data Analysis', ['data analysis', 'data analytics', 'analytical skills'], 'data'],
  ['Data Visualization', ['data visualization', 'tableau', 'power bi', 'looker', 'looker studio'], 'data'],
  ['ETL', ['etl', 'elt', 'data pipeline', 'data pipelines', 'airflow', 'apache airflow', 'dbt'], 'data'],
  ['Statistics', ['statistics', 'statistical analysis', 'a/b testing', 'hypothesis testing'], 'data'],
  ['Excel', ['excel', 'microsoft excel', 'google sheets', 'spreadsheets'], 'data'],
  ['Spark', ['apache spark', 'spark', 'pyspark'], 'data'],
  ['Hadoop', ['hadoop', 'hdfs', 'mapreduce'], 'data'],
  ['Data Warehousing', ['data warehouse', 'data warehousing', 'redshift'], 'data'],
  ['MLOps', ['mlops', 'model deployment', 'mlflow'], 'data'],

  // -- Testing & Quality -----------------------------------------------------
  ['Unit Testing', ['unit testing', 'unit tests'], 'testing'],
  ['Integration Testing', ['integration testing', 'integration tests'], 'testing'],
  ['E2E Testing', ['e2e testing', 'end to end testing', 'end-to-end testing', 'cypress', 'playwright', 'selenium'], 'testing'],
  ['Jest', ['jest'], 'testing'],
  ['Vitest', ['vitest'], 'testing'],
  ['Mocha', ['mocha'], 'testing'],
  ['Chai', ['chai'], 'testing'],
  ['React Testing Library', ['react testing library', 'testing library', 'rtl'], 'testing'],
  ['JUnit', ['junit'], 'testing'],
  ['PyTest', ['pytest', 'py test'], 'testing'],
  ['TDD', ['tdd', 'test driven development', 'test-driven development'], 'testing'],
  ['BDD', ['bdd', 'behavior driven development', 'cucumber', 'gherkin'], 'testing'],
  ['Code Review', ['code review', 'code reviews', 'peer review'], 'testing'],
  ['Debugging', ['debugging', 'troubleshooting', 'root cause analysis'], 'testing'],
  ['Static Analysis', ['eslint', 'prettier', 'sonarqube', 'linting'], 'testing'],

  // -- Security --------------------------------------------------------------
  ['Cybersecurity', ['cybersecurity', 'information security', 'infosec'], 'security'],
  ['Penetration Testing', ['penetration testing', 'pentesting', 'ethical hacking'], 'security'],
  ['OWASP', ['owasp'], 'security'],
  ['Encryption', ['encryption', 'tls', 'ssl', 'cryptography'], 'security'],
  ['Compliance', ['gdpr', 'soc 2', 'hipaa', 'iso 27001', 'compliance'], 'security'],
  ['Threat Modeling', ['threat modeling', 'vulnerability assessment', 'security audit'], 'security'],

  // -- Design ----------------------------------------------------------------
  ['Figma', ['figma'], 'design'],
  ['Sketch', ['sketch app'], 'design'],
  ['Adobe XD', ['adobe xd', 'xd'], 'design'],
  ['Photoshop', ['photoshop'], 'design'],
  ['Illustrator', ['illustrator'], 'design'],
  ['UI Design', ['ui design', 'user interface design', 'ui development'], 'design'],
  ['UX Design', ['ux design', 'user experience', 'ux research', 'usability testing'], 'design'],
  ['Wireframing', ['wireframe', 'wireframing', 'prototyping', 'mockup', 'mockups'], 'design'],
  ['Design Systems', ['design system', 'design systems', 'component library'], 'design'],

  // -- Product / Business ----------------------------------------------------
  ['Product Management', ['product management', 'product owner', 'product manager'], 'product'],
  ['Project Management', ['project management', 'program management'], 'product'],
  ['Agile', ['agile', 'agile methodology', 'agile development'], 'methodology'],
  ['Scrum', ['scrum', 'scrum master'], 'methodology'],
  ['Kanban', ['kanban'], 'methodology'],
  ['Jira', ['jira', 'atlassian jira'], 'tool'],
  ['Confluence', ['confluence'], 'tool'],
  ['Trello', ['trello'], 'tool'],
  ['Asana', ['asana'], 'tool'],
  ['Notion', ['notion'], 'tool'],
  ['Slack', ['slack'], 'tool'],
  ['Salesforce', ['salesforce', 'crm'], 'tool'],
  ['HubSpot', ['hubspot'], 'tool'],
  ['Google Analytics', ['google analytics', 'ga4', 'analytics'], 'tool'],
  ['SEO', ['seo', 'search engine optimization'], 'marketing'],
  ['SEM', ['sem', 'google ads', 'ppc', 'paid search'], 'marketing'],
  ['Content Marketing', ['content marketing', 'copywriting'], 'marketing'],
  ['Social Media Marketing', ['social media marketing', 'social media'], 'marketing'],
  ['Email Marketing', ['email marketing', 'mailchimp', 'klaviyo'], 'marketing'],
  ['Market Research', ['market research', 'competitive analysis'], 'marketing'],
  ['Financial Analysis', ['financial analysis', 'financial modeling', 'forecasting', 'budgeting'], 'finance'],
  ['Accounting', ['accounting', 'general ledger', 'accounts payable'], 'finance'],
  ['QuickBooks', ['quickbooks'], 'finance'],
  ['SAP', ['sap'], 'tool'],
  ['Customer Support', ['customer support', 'customer service', 'client relations', 'customer success'], 'soft'],
  ['Technical Writing', ['technical writing', 'documentation', 'technical documentation'], 'soft'],

  // -- Soft skills -----------------------------------------------------------
  ['Leadership', ['leadership', 'team lead', 'team leadership', 'people management'], 'soft'],
  ['Communication', ['communication', 'communication skills', 'verbal communication', 'written communication'], 'soft'],
  ['Teamwork', ['teamwork', 'team player', 'collaboration', 'cross-functional'], 'soft'],
  ['Problem Solving', ['problem solving', 'problem-solving', 'analytical thinking'], 'soft'],
  ['Mentoring', ['mentoring', 'mentorship', 'coaching'], 'soft'],
  ['Time Management', ['time management', 'prioritization', 'multitasking'], 'soft'],
  ['Adaptability', ['adaptability', 'fast-paced environment', 'flexible'], 'soft'],
  ['Critical Thinking', ['critical thinking', 'decision making', 'strategic thinking'], 'soft'],
  ['Stakeholder Management', ['stakeholder management', 'stakeholder communication', 'client management'], 'soft'],
  ['Presentation Skills', ['presentation skills', 'public speaking', 'presentations'], 'soft'],
  ['Attention to Detail', ['attention to detail', 'detail oriented', 'detail-oriented'], 'soft'],
  ['Ownership', ['ownership', 'self-starter', 'self motivated', 'self-motivated'], 'soft'],
  ['Remote Work', ['remote work', 'remote collaboration', 'distributed team', 'async communication'], 'soft'],
];

/**
 * Normalised dictionary entries:
 * [{ name, category, patterns: [RegExp] }]
 *
 * Patterns are word-boundary anchored. For multi-word aliases we also
 * allow punctuation differences ("next.js" vs "nextjs").
 */
const SKILL_INDEX = SKILL_DICTIONARY.map(([name, aliases, category]) => ({
  name,
  category,
  aliases,
  patterns: [name, ...aliases]
    .filter(Boolean)
    .map((alias) => {
      // 1. Replace every separator (space . / _ -) with a placeholder so
      //    "next.js", "nextjs" and "next js" all collapse to one form.
      // 2. Escape regex metacharacters on what is left (C++ -> C\+\+).
      // 3. Swap the placeholder back for a flexible separator class.
      const SEP = '\u0000';
      const pattern = alias
        .trim()
        .replace(/[\s./_\\-]+/g, SEP)
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(new RegExp(SEP, 'g'), '[\\s./_-]*');
      // Boundaries deliberately exclude + # and . so "C" does not match
      // inside "C++" / "C#" and "node" does not match inside "React.js".
      return new RegExp(`(^|[^a-z0-9+#.])${pattern}([^a-z0-9+#]|$)`, 'i');
    }),
}));

/** How many dictionary entries we ship (used in logs / the ATS report). */
const SKILL_DICTIONARY_SIZE = SKILL_DICTIONARY.length;

/* ------------------------------------------------------------------ *
 * 2. Text extraction
 * ------------------------------------------------------------------ */

/**
 * Extract the raw text of a resume.
 * @param {string} filePath absolute path to the file
 * @param {string} fileType "pdf" | "docx"
 * @returns {Promise<string>}
 */
async function extractText(filePath, fileType) {
  const type = String(fileType || path.extname(filePath)).toLowerCase().replace('.', '');

  if (!fs.existsSync(filePath)) {
    throw new Error(`Resume file not found at ${filePath}`);
  }

  if (type === 'pdf') {
    // Requiring the inner module avoids pdf-parse's "debug mode", which
    // tries to read ./test/data/05-versions-space.pdf on first import.
    // eslint-disable-next-line global-require
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    const buffer = fs.readFileSync(filePath);

    // pdf-parse forwards its argument straight to pdf.js getDocument().
    // The bundled pdf.js only recognises an ArrayBuffer or a
    // { data: Uint8Array } parameter object – a raw Node Buffer is
    // treated as a parameter object with no data and the parse fails
    // with "Invalid PDF structure". Copying into a Uint8Array also
    // detaches the file from Node's pooled Buffer ArrayBuffer.
    const parsed = await pdfParse({ data: new Uint8Array(buffer) });
    return parsed.text || '';
  }

  if (type === 'docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || '';
  }

  throw new Error(`Unsupported resume type "${type}". Upload a PDF or DOCX file.`);
}

/* ------------------------------------------------------------------ *
 * 3. Text helpers
 * ------------------------------------------------------------------ */

/** Collapse weird whitespace, strip control characters. */
function cleanText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    // non-breaking spaces & zero-width chars sneak into PDFs
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Split text into non-empty, trimmed lines. */
function toLines(text) {
  return cleanText(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Strip diacritics + lowercase, for fuzzy comparisons. */
function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/* ------------------------------------------------------------------ *
 * 4. Section headings
 * ------------------------------------------------------------------ */

const SECTION_PATTERNS = [
  { key: 'summary', re: /^(professional\s+)?(summary|profile|objective|about\s+me|career\s+objective|executive\s+summary)\b/i },
  { key: 'skills', re: /^(technical\s+)?(skills|core\s+competencies|competencies|technologies|tech\s+stack|expertise|areas\s+of\s+expertise)\b/i },
  { key: 'experience', re: /^(work|professional|employment)?\s*(experience|history|background)\b/i },
  { key: 'projects', re: /^(personal\s+|key\s+)?projects?\b/i },
  { key: 'education', re: /^education\b|^academic\s+(background|qualifications)\b/i },
  { key: 'certifications', re: /^certifications?\b|^licenses?\b|^courses?\b/i },
  { key: 'awards', re: /^(awards?|honou?rs?|achievements?)\b/i },
  { key: 'publications', re: /^publications?\b/i },
  { key: 'volunteer', re: /^volunte\w+\b/i },
  { key: 'languages', re: /^languages?\b/i },
];

/**
 * Split the resume into { headingKey: [lines] } buckets.
 * Lines before the first heading go under "_intro".
 */
function splitSections(lines) {
  const sections = { _intro: [] };
  let current = '_intro';

  lines.forEach((line) => {
    // A heading line is short and matches one of our patterns.
    if (line.length <= 40) {
      const hit = SECTION_PATTERNS.find((p) => p.re.test(line.replace(/[:|]+$/, '').trim()));
      if (hit) {
        current = hit.key;
        sections[current] = sections[current] || [];
        return;
      }
    }
    sections[current].push(line);
  });

  return sections;
}

/* ------------------------------------------------------------------ *
 * 5. Skills
 * ------------------------------------------------------------------ */

/**
 * Find every known skill mentioned in the text.
 * Returns [{ name, category, mentions }] sorted by mentions desc.
 */
function extractSkills(rawText) {
  const text = cleanText(rawText);
  if (!text) return [];

  const found = [];

  SKILL_INDEX.forEach((entry) => {
    let mentions = 0;
    for (const pattern of entry.patterns) {
      const matches = text.match(new RegExp(pattern.source, 'gi'));
      if (matches) {
        mentions += matches.length;
        break; // one alias match is enough to count the skill once
      }
    }
    if (mentions > 0) found.push({ name: entry.name, category: entry.category, mentions });
  });

  // Languages such as "C" / "R" / "Go" are noisy: require a second
  // signal (a neighbouring tech word) before trusting a single hit.
  const NOISY = new Set(['C', 'R', 'Go', 'Apache', 'Spring', 'Lambda', 'Chef', 'Puppet', 'Notion', 'Spark']);
  const filtered = found.filter((skill) => {
    if (!NOISY.has(skill.name)) return true;
    return skill.mentions >= 2 || /\b(software|develop|engineer|program|framework|comput)/i.test(text);
  });

  return filtered
    .sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name))
    .map(({ name, category }) => ({ name, category }));
}

/* ------------------------------------------------------------------ *
 * 6. Experience
 * ------------------------------------------------------------------ */

const MONTHS =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

/** "Jan 2020 – Mar 2023", "2019 - 2021", "Jan 2020 – Present" */
const DATE_RANGE_RE = new RegExp(
  `(${MONTHS}[\\s.]*\\d{4}|\\d{1,2}/\\d{4}|\\d{4})\\s*(?:-|–|—|to|until|through)\\s*(${MONTHS}[\\s.]*\\d{4}|\\d{1,2}/\\d{4}|\\d{4}|present|current|now|ongoing)`,
  'i'
);

const SINGLE_DATE_RE = new RegExp(`\\b(${MONTHS}[\\s.]*\\d{4}|\\d{1,2}/\\d{4}|\\d{4})\\b`, 'i');

const SENIORITY_WORDS = [
  'senior',
  'lead',
  'principal',
  'staff',
  'head of',
  'director',
  'manager',
  'chief',
  'vp',
  'junior',
  'associate',
  'intern',
  'entry',
  'graduate',
  'jr',
  'sr',
  'ii',
  'iii',
];

const ROLE_HINT =
  /(engineer|developer|designer|analyst|manager|architect|scientist|consultant|administrator|specialist|coordinator|lead|intern|director|officer|associate|technician|strategist|marketer|writer|researcher|accountant|recruiter|tester|qa|devops|sre|nurse|teacher|professor)/i;

const COMPANY_HINT =
  /(inc\.?|llc|ltd\.?|limited|corp\.?|corporation|company|co\.|gmbh|technologies|technology|tech|labs|lab|group|solutions|systems|software|studios|studio|agency|consulting|partners|global|international|digital|media|bank|health|university|college|school|hospital|institute)/i;

/** Guess "entry" | "mid" | "senior" from a job title. */
function guessSeniority(title = '') {
  const t = title.toLowerCase();
  if (/\b(intern|junior|jr\.?|entry|trainee|graduate|apprentice)\b/.test(t)) return 'entry';
  if (/\b(senior|sr\.?|lead|principal|staff|head|director|chief|vp|manager|architect)\b/.test(t)) return 'senior';
  return 'mid';
}

/** Normalise "Jan 2020" / "01/2020" / "2020" into an ISO-ish date. */
function normaliseDate(raw) {
  if (!raw) return null;
  const value = raw.trim();
  if (/present|current|now|ongoing/i.test(value)) return 'Present';

  const monthYear = value.match(new RegExp(`^${MONTHS}[\\s.]*\\d{4}$`, 'i'));
  if (monthYear) {
    const monthName = value.match(new RegExp(MONTHS, 'i'))[1];
    const year = value.match(/\d{4}/)[0];
    const monthIndex =
      ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].findIndex(
        (m) => monthName.toLowerCase().startsWith(m)
      ) + 1;
    return `${year}-${String(monthIndex).padStart(2, '0')}-01`;
  }

  const slash = value.match(/^(\d{1,2})\/(\d{4})$/);
  if (slash) return `${slash[2]}-${slash[1].padStart(2, '0')}-01`;

  const yearOnly = value.match(/^(\d{4})$/);
  if (yearOnly) return `${yearOnly[1]}-01-01`;

  return null;
}

/** Number of months between two ISO dates (Present counts as today). */
function monthsBetween(startISO, endISO) {
  const parse = (iso) => (iso === 'Present' ? new Date() : new Date(iso));
  const start = parse(startISO);
  const end = parse(endISO);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.max(0, (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()));
}

/**
 * Extract work history.
 *
 * Strategy: walk the "experience" section line by line. A line that
 * contains a date range (or sits directly above one) starts a new role;
 * following lines are collected as bullet points.
 *
 * @returns {Array<{title,company,location,startDate,endDate,months,description,skills}>}
 */
function extractExperience(lines, skillNames = []) {
  const experiences = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const description = current.bullets
      .map((b) => b.replace(/^[•\-–*▪‣\d+.)\s]+/, '').trim())
      .filter(Boolean)
      .join('\n');
    const text = `${current.title} ${description}`;
    const skills = skillNames.filter((s) =>
      new RegExp(`(^|[^a-z0-9+#.])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s]+/g, '[\\s]+')}([^a-z0-9+#]|$)`, 'i').test(text)
    );

    experiences.push({
      title: current.title || 'Role',
      company: current.company || '',
      location: current.location || '',
      startDate: current.startDate || null,
      endDate: current.endDate || null,
      months: monthsBetween(current.startDate, current.endDate || 'Present'),
      description,
      skills: skills.slice(0, 12),
    });
    current = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    const range = line.match(DATE_RANGE_RE);
    const looksLikeBullet = /^[•\-–*▪‣]/.test(line) || /^\d+[.)]\s/.test(line);

    // --- a line that carries a date range -> new (or continuing) role
    if (range) {
      const datePart = range[0];
      const before = line.slice(0, range.index).replace(/[|,–-]+$/, '').trim();
      const after = line.slice(range.index + datePart.length).replace(/^[|,–-]+/, '').trim();

      const [startISO, endISO] = datePart.split(/\s*(?:-|–|—|to|until|through)\s*/i);
      const startDate = normaliseDate(startISO);
      const endDate = normaliseDate(endISO);

      // "Company, Location | Jan 2020 - Present"  -> title comes next line
      // "Senior Engineer | Acme | Jan 2020 - Present" -> split on pipes
      const parts = [before, after].filter(Boolean).flatMap((chunk) => chunk.split(/\s*\|\s*|\s{2,}at\s{2,}/i));
      const titleCandidate = parts.find((p) => ROLE_HINT.test(p)) || parts[0] || '';
      const companyCandidate = parts.find((p) => p !== titleCandidate && (COMPANY_HINT.test(p) || p.length > 1)) || '';
      const locationCandidate = parts.find((p) => /,/.test(p) && !COMPANY_HINT.test(p)) || '';

      const isTitleLine = Boolean(titleCandidate && ROLE_HINT.test(titleCandidate) && !looksLikeBullet);

      if (isTitleLine) {
        flush();
        current = {
          title: titleCandidate.replace(/\s*[|,]\s*$/, '').trim(),
          company: companyCandidate.replace(/\s*[|,]\s*$/, '').trim(),
          location: locationCandidate,
          startDate,
          endDate,
          bullets: [],
        };
      } else if (current && !current.startDate) {
        // Date line belongs to the role we already started above.
        current.startDate = startDate;
        current.endDate = endDate;
        if (before) current.company = current.company || before;
        if (after) current.location = current.location || after;
      } else {
        flush();
        current = {
          title: before || after || 'Role',
          company: after && before ? after : '',
          location: '',
          startDate,
          endDate,
          bullets: [],
        };
      }
      continue;
    }

    // --- no date: either a lone "Senior Engineer" header, or a bullet
    if (!looksLikeBullet && line.length <= 90 && ROLE_HINT.test(line) && !current) {
      const next = lines[i + 1] || '';
      const nextHasDate = DATE_RANGE_RE.test(next) || SINGLE_DATE_RE.test(next);
      if (nextHasDate) {
        flush();
        current = { title: line.replace(/[:|]+$/, ''), company: '', location: '', startDate: null, endDate: null, bullets: [] };
        continue;
      }
    }

    if (current) {
      // Company / location line right below the title
      if (!current.company && current.bullets.length === 0 && !looksLikeBullet && line.length <= 90) {
        const [maybeCompany, maybeLocation] = line.split(',').map((s) => s.trim());
        current.company = maybeCompany || '';
        current.location = maybeLocation || '';
      } else {
        current.bullets.push(line);
      }
    }
  }
  flush();

  return experiences.filter((e) => e.title && e.title.length > 1).slice(0, 15);
}

/** Total months of experience across every parsed role. */
function totalExperienceMonths(experiences = []) {
  return experiences.reduce((sum, e) => sum + (e.months || 0), 0);
}

/* ------------------------------------------------------------------ *
 * 7. Education
 * ------------------------------------------------------------------ */

/**
 * Degree keywords. Word boundaries are essential here: without them the
 * abbreviation "b.e." also matches the "Be" at the start of "Berkeley".
 */
const DEGREE_RE = new RegExp(
  `\\b(${[
    "bachelor(?:'s)?",
    'b\\.?\\s?tech',
    'b\\.?\\s?e\\.?',
    'b\\.?\\s?sc',
    'b\\.?\\s?s\\.?',
    'b\\.?\\s?a\\.?',
    'b\\.?\\s?c\\.?\\s?a',
    "master(?:'s)?",
    'm\\.?\\s?tech',
    'm\\.?\\s?sc',
    'm\\.?\\s?s\\.?',
    'm\\.?\\s?b\\.?\\s?a',
    'm\\.?\\s?c\\.?\\s?a',
    'ph\\.?\\s?d',
    'doctorate',
    'doctoral',
    'diploma',
    "associate(?:'s)?\\s+degree",
    'higher\\s+national\\s+diploma',
    'pgdm',
    'undergraduate',
    'postgraduate',
  ].join('|')})\\b`,
  'i'
);

/** Subject of study, e.g. "B.Sc in Computer Science" -> "Computer Science". */
function extractFieldOfStudy(line) {
  // Prefer "in X" over "of X" so "Bachelor of Science in Computer
  // Science" yields "Computer Science" and not "Science".
  const inMatch = line.match(/\bin\s+([A-Z][A-Za-z&+]*(?:\s+[A-Za-z&+]+){0,3}?)(?=\s*(?:[,|;(\[]|$))/);
  if (inMatch) return inMatch[1].trim();
  const ofMatch = line.match(/\bof\s+([A-Z][A-Za-z&+]*(?:\s+[A-Za-z&+]+){0,3}?)(?=\s*(?:\bin\b|[,|;(\[]|$))/);
  return ofMatch ? ofMatch[1].trim() : '';
}

/**
 * Extract degrees.
 * @returns {Array<{degree,field,institution,year,gpa}>}
 */
function extractEducation(lines) {
  const education = [];
  let skipUntil = -1;

  for (let i = 0; i < lines.length; i += 1) {
    // Lines already consumed as the institution of the previous degree.
    if (i < skipUntil) continue;

    const line = lines[i].trim();
    if (!DEGREE_RE.test(line)) continue;

    // Degree and institution are frequently on consecutive lines.
    const contextLines = [line, lines[i + 1] || '', lines[i + 2] || ''].filter(Boolean);
    const context = contextLines.join(' | ');

    const yearMatch = context.match(/\b(19|20)\d{2}\b/);
    const field = extractFieldOfStudy(line);
    const gpaMatch = context.match(/(?:gpa|cgpa|grade)[:\s]*([0-9](?:\.[0-9]{1,2})?)/i);

    const institutionLine =
      contextLines.find(
        (l, idx) => idx > 0 && /(university|college|institute|school|academy|polytechnic)/i.test(l)
      ) ||
      line
        .split(/[,|]/)
        .map((s) => s.trim())
        .find((s) => /(university|college|institute|school)/i.test(s)) ||
      '';

    // Remember the institution line so it is not parsed as its own degree.
    if (institutionLine) {
      const idx = contextLines.indexOf(institutionLine);
      if (idx > 0) skipUntil = i + idx + 1;
    }

    education.push({
      degree: line.replace(/[,|].*$/, '').replace(/\s*\(.*\)\s*/, '').trim().slice(0, 120),
      field,
      institution: institutionLine.replace(/\s*[|,]\s*(19|20)\d{2}.*$/, '').trim().slice(0, 120),
      year: yearMatch ? yearMatch[0] : null,
      gpa: gpaMatch ? gpaMatch[1] : null,
    });

    if (education.length >= 6) break;
  }

  return education;
}

/* ------------------------------------------------------------------ *
 * 8. Summary + contact
 * ------------------------------------------------------------------ */

/** Pull the professional summary paragraph out of the resume. */
function extractSummary(sections, lines) {
  const fromSection = (sections.summary || []).join(' ').trim();
  if (fromSection.length > 60) return tidy(fromSection);

  // No explicit heading: take the first "sentence-y" block that is not
  // contact information.
  const candidate = lines
    .filter((l) => l.length > 60 && !/^[•\-–*]/.test(l) && !/^\d{4}/.test(l) && !/@|\+\d|linkedin\.com/i.test(l))
    .slice(0, 3)
    .join(' ');

  return tidy(candidate);
}

function tidy(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
}

/** Extract email / phone / links / the candidate's name. */
function extractContact(rawText, lines) {
  const text = cleanText(rawText);

  const email = (text.match(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/) || [])[0] || '';

  const phone =
    (text.match(/(\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(\s?(ext|x)\.?\s?\d{1,4})?/) || [])[0] || '';

  // Remove emails before scanning for URLs, otherwise the domain of
  // "john@gmail.com" is reported as a portfolio website.
  const withoutEmails = text.replace(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/g, ' ');

  const linkedin = (text.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[^\s|,)]+/i) || [])[0] || '';
  const github = (withoutEmails.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s|,)]+/i) || [])[0] || '';

  // Pick the first URL-looking token that is not a social profile we
  // already captured. Matching tokens (instead of a single big regex
  // with a negative lookahead) avoids starting a match mid-word.
  const urlTokens =
    withoutEmails.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s|,)]*)?/gi) || [];
  const website =
    urlTokens.find((token) => {
      const host = token
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .split('/')[0]
        .toLowerCase();
      return !/^(linkedin|github|gitlab|facebook|twitter|x|instagram)\.com$/.test(host) && !/\.(png|jpe?g|gif|svg|pdf)$/i.test(host);
    }) || '';

  // The name is usually the very first non-empty line that is not an
  // email, phone or URL and is not all-caps heading material.
  const name =
    lines.find(
      (l) =>
        l.length > 2 &&
        l.length < 50 &&
        !/@|\+\d|http|www\.|\.com|resume|curriculum/i.test(l) &&
        /^[A-Za-z][A-Za-z .'-]+[A-Za-z.]?$/.test(l) &&
        l.split(' ').length <= 4
    ) || '';

  return { email, phone: phone.trim(), linkedin, github, website, name: name.trim() };
}

/* ------------------------------------------------------------------ *
 * 9. Public API
 * ------------------------------------------------------------------ */

/**
 * Parse a resume file into structured data.
 *
 * @param {string} filePath  absolute path of the uploaded file
 * @param {string} fileType  "pdf" | "docx" (falls back to the extension)
 * @returns {Promise<object>} parsed resume
 */
async function parseResume(filePath, fileType) {
  const started = Date.now();
  const type = String(fileType || path.extname(filePath)).toLowerCase().replace('.', '');

  const result = {
    rawText: '',
    skills: [],
    experience: [],
    education: [],
    summary: '',
    contact: { email: '', phone: '', linkedin: '', github: '', website: '', name: '' },
    certifications: [],
    wordCount: 0,
    fileType: type,
    parsedAt: new Date().toISOString(),
  };

  try {
    const raw = await extractText(filePath, type);
    const text = cleanText(raw);

    if (!text) {
      log.warn(`resumeParser: no extractable text in ${path.basename(filePath)}`);
      return result;
    }

    const lines = toLines(text);
    const sections = splitSections(lines);
    const skills = extractSkills(text);
    const skillNames = skills.map((s) => s.name);

    result.rawText = text;
    result.skills = skills;
    result.summary = extractSummary(sections, lines);
    result.contact = extractContact(text, lines);
    result.wordCount = text.split(/\s+/).filter(Boolean).length;

    // Experience: prefer the dedicated section, fall back to the whole doc.
    const expLines = (sections.experience || []).length ? sections.experience : lines;
    result.experience = extractExperience(expLines, skillNames);

    result.education = extractEducation(sections.education || []);

    result.certifications = (sections.certifications || [])
      .map((l) => l.replace(/^[•\-–*]\s*/, '').trim())
      .filter((l) => l.length > 3)
      .slice(0, 10);

    log.info(
      `resumeParser: parsed ${path.basename(filePath)} in ${Date.now() - started}ms — ` +
        `${skills.length} skills, ${result.experience.length} roles, ${result.education.length} degrees`
    );
  } catch (err) {
    log.error(`resumeParser failed for ${filePath}: ${err.message}`);
    // Graceful degradation: callers still get the default shape.
    result.parseError = err.message;
  }

  return result;
}

/**
 * Parse text directly (no file). Handy for re-scoring an existing
 * resume or for tests.
 */
function parseResumeText(rawText) {
  const text = cleanText(rawText);
  const lines = toLines(text);
  const sections = splitSections(lines);
  const skills = extractSkills(text);
  const skillNames = skills.map((s) => s.name);

  const expLines = (sections.experience || []).length ? sections.experience : lines;

  return {
    rawText: text,
    skills,
    experience: extractExperience(expLines, skillNames),
    education: extractEducation(sections.education || []),
    summary: extractSummary(sections, lines),
    contact: extractContact(text, lines),
    certifications: (sections.certifications || []).slice(0, 10),
    wordCount: text.split(/\s+/).filter(Boolean).length,
    parsedAt: new Date().toISOString(),
  };
}

module.exports = {
  parseResume,
  parseResumeText,
  extractText,
  extractSkills,
  extractExperience,
  extractEducation,
  extractSummary,
  extractContact,
  splitSections,
  cleanText,
  toLines,
  fold,
  guessSeniority,
  totalExperienceMonths,
  normaliseDate,
  monthsBetween,
  SKILL_DICTIONARY,
  SKILL_DICTIONARY_SIZE,
  SECTION_PATTERNS,
  DATE_RANGE_RE,
};

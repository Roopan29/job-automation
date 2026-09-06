# JobBot 🤖 — Personal Job Application Automation

A self-hosted, single-user job-hunting copilot. It parses your resume, scores it against
job listings, scrapes job boards, matches jobs to your skills, drafts cover letters with
AI, and can drive a real browser through application forms — then tracks every application
through to the offer.

**Built for one person, on localhost.** No accounts, no cloud, no multi-user auth, no
telemetry. Everything lives in a local SQLite file and a folder of your own resumes.

---

## Table of contents

1. [What it does](#what-it-does)
2. [Tech stack](#tech-stack)
3. [Quick start](#quick-start)
4. [Project structure](#project-structure)
5. [The six pages](#the-six-pages)
6. [Step-by-step usage](#step-by-step-usage)
7. [Setting up your OpenAI key](#setting-up-your-openai-key)
8. [Installing the browser for auto-apply](#installing-the-browser-for-auto-apply)
9. [Configuration reference](#configuration-reference)
10. [REST API](#rest-api)
11. [How matching and scoring work](#how-matching-and-scoring-work)
12. [Tests](#tests)
13. [Troubleshooting](#troubleshooting)

---

## What it does

| Capability | How |
| --- | --- |
| Resume parsing | `pdf-parse` for PDF, `mammoth` for DOCX; extracts skills (250+ keyword dictionary), experience, education, contact info, summary |
| ATS scoring | 8 weighted categories totalling 100, graded A+ → F, with concrete improvement tips |
| Job scraping | RemoteOK + Remotive (public JSON APIs), LinkedIn (public guest search), Indeed + Glassdoor (Puppeteer) — 2–5 s random delays, realistic user agent, per-source error isolation |
| Matching | Matched vs. missing skills, bonus points for seniority/location/keyword overlap, capped at 100 |
| Cover letters | GPT-4o when a key is set, otherwise a built-in template engine — it never hard-fails |
| Interview prep | 10 tailored questions with guidance notes |
| Follow-up emails | Drafted automatically when a follow-up date arrives |
| Auto-apply | Headful Puppeteer drives real application forms, detects CAPTCHAs and waits up to 5 minutes for you |
| Tracking | Full pipeline (applied → responded → interview → offer/rejected/ghosted/withdrawn) with status history, notes, CSV export and charts |
| Scheduling | 4 cron jobs: scrape, auto-apply, nightly cleanup, 08:00 follow-up reminders |

---

## Tech stack

**Backend** — Node.js ≥ 18.18, Express 4, better-sqlite3 (synchronous SQLite), Puppeteer,
Cheerio, `pdf-parse`, `mammoth`, `multer`, `node-cron`, `node-notifier`, `openai`,
`csv-stringify`.

**Frontend** — Next.js 14 (App Router), React 18, Tailwind CSS, Chart.js
(`react-chartjs-2`), `react-dropzone`, `react-hot-toast`, `lucide-react`, Axios.

---

## Quick start

You need **Node.js 18.18 or newer** (`node -v`).

### 1. Install

Open two terminals.

```bash
# Terminal A — backend
cd backend
npm install
cp .env.example .env      # optional: the app runs fine without it
npm start
```

```bash
# Terminal B — frontend
cd frontend
npm install
npm run dev
```

### 2. Open it

- **UI** → http://localhost:3000
- **API** → http://localhost:5000/api/health

The SQLite database at `backend/db/database.sqlite` is created automatically on first
boot, along with a default preferences row. Nothing to migrate, nothing to seed.

> **Note on `better-sqlite3`:** it ships a prebuilt binary for most platforms and
> installs normally. If the download fails on your machine (offline, unusual platform,
> corporate proxy), build it from source instead:
> ```bash
> cd backend
> npm install --ignore-scripts
> cd node_modules/better-sqlite3
> npx node-gyp rebuild --release
> ```

### 3. Load demo data (optional)

```bash
cd backend && npm run seed
```

Seeds 8 jobs, 5 applications across the pipeline and sample history so the charts and
tracker have something to show. Add `--fresh` to wipe the database first:

```bash
npm run seed -- --fresh
```

---

## Project structure

```
job-automation/
├── README.md
├── .gitignore
│
├── backend/
│   ├── app.js                    # Express entry point, middleware, 404/500 handlers
│   ├── package.json
│   ├── .env                      # your local config (git-ignored)
│   ├── .env.example              # template — copy to .env
│   ├── db/
│   │   ├── initDB.js             # schema, migrations, seed, connection helpers
│   │   └── database.sqlite       # created at runtime (git-ignored)
│   ├── uploads/resumes/          # your uploaded PDFs/DOCX (git-ignored)
│   ├── controllers/
│   │   ├── resumeController.js
│   │   ├── jobController.js
│   │   ├── applyController.js
│   │   ├── trackerController.js
│   │   ├── preferenceController.js
│   │   └── dashboardController.js
│   ├── services/
│   │   ├── resumeParser.js       # text extraction + entity extraction
│   │   ├── atsScorer.js          # 8-category weighted ATS score
│   │   ├── matchingEngine.js     # resume ↔ job matching
│   │   ├── jobScraper.js         # 5 job-board scrapers
│   │   ├── autoApplyBot.js       # headful Puppeteer application bot
│   │   ├── aiService.js          # GPT-4o wrapper with template fallback
│   │   └── coverLetterGen.js     # deterministic letter/prep/email templates
│   ├── routes/                   # 6 routers mounted under /api
│   ├── scheduler/cronJobs.js     # 4 scheduled jobs
│   ├── middleware/uploadMiddleware.js
│   ├── utils/                    # logger, apiResponse, fileHelper, notifier, serialize
│   └── tests/                    # 93 tests + demo seeder
│
└── frontend/
    ├── package.json
    ├── next.config.mjs           # proxies /api/* to the backend
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── jsconfig.json             # enables the "@/" import alias
    ├── app/
    │   ├── layout.js             # sidebar + toast host + app provider
    │   ├── globals.css
    │   ├── page.js               # Dashboard
    │   ├── resume/page.js        # My Resumes
    │   ├── search/page.js        # Job Search
    │   ├── auto-apply/page.js    # Auto Apply
    │   ├── tracker/page.js       # Application Tracker
    │   └── preferences/page.js   # Preferences
    ├── components/               # 14 UI components
    ├── context/AppContext.js     # shared state + backend health polling
    └── services/api.js           # single Axios client for the whole app
```

---

## The six pages

### 1. Dashboard (`/`)
Your whole job search on one screen: 6 stat cards (total, responded, interviews, offers,
response rate, new jobs this week), the top 5 recommended jobs with match scores, a
30-day application trend line, a status doughnut, upcoming follow-ups, your biggest skill
gaps, and recent activity.

### 2. My Resumes (`/resume`)
Drag-and-drop upload (PDF or DOCX, 5 MB max). Each resume card shows the ATS score with a
grade badge, the 8-category breakdown, extracted skills and experience, and a one-click
**Get ATS Score** breakdown. Set a default resume, rename it, download the original, or
delete it.

### 3. Job Search (`/search`)
Search the scraped job database by keyword, location, job type, experience level and
minimum match score. **Find by Resume** switches to a recommendation view. **Scrape New
Jobs** opens a panel where you pick sources (RemoteOK, Remotive, LinkedIn, Indeed,
Glassdoor) and pulls fresh listings. Each job card shows the match score, matched/missing
skill tags, salary, and actions to bookmark, generate a cover letter, or apply.

The **Scrape history** panel underneath expands to show the last 20 scrape runs — when each
one ran, which source, how many jobs it found versus how many were new, and the failure
reason for any board that blocked the request. It refreshes automatically after every
scrape, so this is the first place to look when a source stops returning jobs.

### 4. Auto Apply (`/auto-apply`)
The control room. A big ON/OFF switch, today's progress against your daily limit, the
current queue size, the next scheduled run, and live browser status. Configure the minimum
match score, daily limit, delay between applications, schedule, cover-letter tone and
sources. Press **Run Auto-Apply Now** to watch the bot work through the queue in a live
console; **Stop** halts after the current job.

### 5. Application Tracker (`/tracker`)
Every application in one filterable table — searchable by company, role or notes, and
filterable by status, method (auto/manual), source and date range. Status is editable
inline with a single click. Per-row actions: set follow-up and interview dates, edit notes
(with a full status-change history timeline), generate interview prep (10 tailored questions
with suggested answers, copyable), draft a follow-up email, or delete. **Export CSV**
downloads exactly the rows the current filters show — clear the filters to export
everything. Three charts below: 30-day trend, source breakdown, status breakdown.

### 6. Preferences (`/preferences`)
Personal info (used to fill application forms), job targets (roles, locations, salary
band, work type, level), auto-apply config, notification toggles, and AI settings
including the OpenAI key with a **Test connection** button. One **Save All Preferences**
button posts the whole form; the backend validates each field and reports anything it
rejected.

---

## Step-by-step usage

### First run

1. **Start both servers** (see [Quick start](#quick-start)).
2. **Open http://localhost:3000.** The sidebar shows a green dot when the backend is up.
   The 🔔 bell next to the logo polls the backend alert feed every 15 s — scrapes, CAPTCHA
   prompts and follow-up reminders land there, so nothing is missed on a machine with no
   desktop notification daemon. A red badge marks unread items; **Clear** empties the feed.
3. **Go to My Resumes** and upload your resume. Wait for the parse — you'll see the
   extracted skills, experience and education, plus an ATS score.
4. **Read the ATS breakdown.** Click the score to expand the 8 categories and the
   improvement tips. Fix the low-scoring ones first; a weak resume caps every match score
   you'll ever get.
5. **Set it as default** so the auto-apply bot knows which one to use.

### Finding jobs

6. **Go to Job Search** and click **Scrape New Jobs**. Pick sources and start. RemoteOK and
   Remotive are the most reliable; they're plain JSON APIs.
7. **Search** with your keywords, or press **Find by Resume** to see the best matches.
8. **Bookmark** the ones worth pursuing.

### Applying

9. On a job card, press **Apply**. A modal opens with a resume picker, a tone selector and
   an auto-generated cover letter you can edit.
10. **Manual Track** records the application and opens the job URL for you to apply by
    hand. **Auto Apply** drives the browser and fills the form.
11. **Watch for CAPTCHAs.** If one appears, the bot opens the window, waits up to 5 minutes
    for you to solve it, and fires a desktop notification. Solve it and it continues.

### Tracking

12. **Go to Application Tracker.** Update statuses as recruiters respond.
13. **Set follow-up dates.** The bot emails you a drafted follow-up at 08:00 on the day.
14. **Export CSV** any time for your own spreadsheet or records. The file matches the
    filters currently applied — filter to `rejected`, export, and you get only those rows.

### Automating it

15. **Go to Auto Apply**, set a minimum match score and a daily limit, pick a schedule, and
    flip the switch on. It will scrape, match and apply on its own from then on.

---

## Setting up your OpenAI key

**The key is optional.** Without one, cover letters, interview prep and follow-up emails
are produced by a built-in deterministic template engine — they're solid, just less
personalised. With a key, they're written by `gpt-4o`.

1. Create an account at https://platform.openai.com and add billing credit.
2. Generate a key at https://platform.openai.com/api-keys.
3. Add it in **either** place:

   **Option A — the UI.** Go to **Preferences → AI settings**, paste the key, press
   **Save**, then **Test**. You'll see a confirmation with the model and round-trip time.

   **Option B — the `.env` file.** Add to `backend/.env` and restart the backend:
   ```bash
   OPENAI_API_KEY=sk-proj-...
   ```

A key saved through the UI is stored in the SQLite `preferences` table and takes
precedence over `.env`. The Preferences page never displays the key back — only whether
one is set.

**Cost:** one cover letter is roughly 800–1200 output tokens, well under a cent at
current `gpt-4o` pricing. The auto-apply bot generates at most `dailyApplyLimit` letters
per day.

---

## Installing the browser for auto-apply

The auto-apply bot needs a Chromium binary. Puppeteer normally downloads one during
`npm install`. If it didn't (offline install, `--ignore-scripts`, CI), install it:

```bash
cd backend
npx puppeteer browsers install chrome
```

**The bot needs a display to solve CAPTCHAs.** It runs headful by default
(`PUPPETEER_HEADLESS=new`). On a headless server you'd have to run it under `xvfb`, but
then you can't solve CAPTCHAs — so on a server, use Manual Track instead.

Scraping works without a browser for RemoteOK, Remotive and LinkedIn. Indeed and
Glassdoor need one.

---

## Configuration reference

Every setting has a working default. Copy `backend/.env.example` to `backend/.env` to
override.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `5000` | Backend port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `development` | Logging verbosity |
| `TZ` | `UTC` | Timezone for cron and dates |
| `DB_PATH` | `backend/db/database.sqlite` | SQLite location |
| `OPENAI_API_KEY` | *(none)* | Enables GPT-4o generation |
| `OPENAI_MODEL` | `gpt-4o` | Chat model |
| `OPENAI_TEMPERATURE` | `0.7` | Creativity |
| `OPENAI_MAX_TOKENS` | `1200` | Response cap |
| `MAX_UPLOAD_MB` | `5` | Resume upload limit |
| `SCRAPER_USER_AGENT` | Chrome 120 UA | Scraper user agent |
| `PUPPETEER_HEADLESS` | `new` | `new` = headful, `true` = headless |
| `PUPPETEER_USER_AGENT` | Chrome 120 UA | Bot user agent |
| `CAPTCHA_TIMEOUT_MS` | `300000` | 5 min to solve a CAPTCHA |
| `NAV_TIMEOUT_MS` | `45000` | Page navigation timeout |
| `REMOTEOK_API_URL` | `https://remoteok.com/api` | RemoteOK JSON feed |
| `REMOTIVE_API_URL` | `https://remotive.com/api/remote-jobs` | Remotive JSON feed |
| `LINKEDIN_GUEST_URL` | LinkedIn guest-search endpoint | Public, no login needed |

The three job-board URLs are optional overrides — leave them unset to use the real boards.
They exist so the parser can be pointed at a local fixture for testing (this is how the
scraper's unit tests run with no network), or at a mirror if a board moves.

The frontend reads `BACKEND_URL` (default `http://localhost:5000`) for its API proxy, and
`NEXT_PUBLIC_API_URL` to override the browser-side base URL.

---

## REST API

Every response uses one envelope:

```jsonc
// success
{ "success": true,  "data": { ... }, "message": "Optional human note" }

// failure
{ "success": false, "error": "What went wrong", "code": 400 }
```

### Resume
| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/resume/upload` | Multipart upload, field `resume` (PDF/DOCX) |
| `GET` | `/api/resume/all` | List all resumes |
| `GET` | `/api/resume/:id` | One resume with parsed data |
| `PUT` | `/api/resume/:id/label` | Rename |
| `PUT` | `/api/resume/:id/set-default` | Make default |
| `GET` | `/api/resume/:id/ats-score` | Full ATS breakdown |
| `GET` | `/api/resume/:id/suggestions` | Improvement tips |
| `DELETE` | `/api/resume/:id` | Delete |

### Jobs
| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/jobs/scrape` | Scrape job boards |
| `GET` | `/api/jobs` | Search/filter/sort/paginate |
| `GET` | `/api/jobs/recommended` | Best matches for the default resume |
| `GET` | `/api/jobs/scrape/logs` | Scrape run history |
| `DELETE` | `/api/jobs/clear-old` | Delete stale jobs |
| `GET` | `/api/jobs/:id` | One job |
| `GET` | `/api/jobs/:id/match-details` | Matched/missing skills + reasoning |
| `POST` | `/api/jobs/:id/bookmark` | Toggle bookmark |

### Apply
| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/apply/run-auto-batch` | Apply to the whole queue |
| `POST` | `/api/apply/stop` | Request a graceful stop |
| `GET` | `/api/apply/status` | Queue, progress, browser health |
| `GET` | `/api/apply/log` | Live bot log |
| `POST` | `/api/apply/:jobId` | Track a manual application |
| `POST` | `/api/apply/:jobId/auto` | Run the bot on one job |
| `POST` | `/api/apply/:jobId/cover-letter` | Generate a cover letter |
| `POST` | `/api/apply/:jobId/interview-prep` | Generate interview questions |
| `POST` | `/api/apply/:jobId/follow-up-email` | Generate a follow-up email |

### Tracker
| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/tracker` | List + filter applications |
| `GET` | `/api/tracker/stats` | Aggregated stats for charts |
| `GET` | `/api/tracker/export/csv` | CSV download |
| `GET` | `/api/tracker/:id` | One application + status history |
| `PATCH` | `/api/tracker/:id/status` | Change status |
| `PATCH` | `/api/tracker/:id/notes` | Edit notes |
| `PATCH` | `/api/tracker/:id/follow-up` | Set follow-up / interview dates |
| `DELETE` | `/api/tracker/:id` | Delete |

### Preferences & misc
| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/preferences` | Current preferences |
| `PUT` | `/api/preferences` | Update (validates each field) |
| `POST` | `/api/preferences/test-ai` | Test the OpenAI connection |
| `GET` | `/api/dashboard` | Everything the dashboard needs |
| `GET` | `/api/health` | Liveness |
| `GET` | `/api/system/status` | Browser + AI + scheduler health |
| `GET` | `/api/notifications` | Notification feed |

---

## How matching and scoring work

### ATS score (resume quality, out of 100)

| Category | Weight | What it checks |
| --- | --- | --- |
| Contact Info | 10 | Email, phone, location, links present |
| Summary | 10 | Has a professional summary of reasonable length |
| Skills | 20 | Number of recognised technical skills |
| Experience | 20 | Roles found, seniority inferred, tenure |
| Education | 10 | Degree detected, field of study |
| Formatting | 10 | Clean structure, section headings, no tables |
| Action Verbs | 10 | Strong verbs leading bullet points |
| Length | 10 | Word count in the healthy range |

Grades: ≥90 `A+`, ≥80 `A`, ≥70 `B`, ≥60 `C`, ≥50 `D`, else `F`.

### Match score (resume ↔ job, out of 100)

```
base        = (matchedSkills / requiredSkills) × 75
              (falls back to keyword overlap when no skills are listed)
+ title     = title similarity              × 10
+ expFit    = experience-level fit          × 5
+ locFit    = location fit                  × 5
+ years     = years-of-experience fit       × 5
score       = min(100, round to 1 decimal)
```

The job page shows exactly which skills matched and which are missing, so you can see
whether to tailor your resume or skip the role.

---

## Tests

```bash
cd backend
npm test
```

**93 tests** — 37 service-level unit tests and 56 API integration tests. The integration
suite boots the real Express app on an ephemeral port against a throwaway temp database,
so it exercises the actual controllers, routes and SQLite schema rather than a mock.

Test fixtures are generated by `backend/tests/helpers/makePdf.js`, which writes a real
PDF from scratch with no external dependency.

---

## Troubleshooting

### A CAPTCHA appeared during auto-apply

Expected — job boards actively fight bots, and this is the honest limit of automation.

- The bot opens the page **headful**, detects the challenge, fires a desktop notification
  and waits up to **5 minutes** (`CAPTCHA_TIMEOUT_MS`) for you to solve it by hand.
- Solve it in the window that popped up and the bot continues on its own.
- If you're on a headless server you can't solve it. Use **Manual Track** instead, or set
  `PUPPETEER_HEADLESS=true` and accept that CAPTCHA-gated applications will fail.
- Lower your daily limit and increase the delay between applications. Slower is stealthier.

### Scraping returns few or no jobs

Job boards block automated traffic constantly, and this is the most fragile part of the
tool by design.

- **RemoteOK and Remotive are the reliable ones** — plain public JSON APIs, no browser
  needed. Start there.
- **LinkedIn** uses the public guest search endpoint. It works without login but rate-limits
  aggressively. Space out your requests.
- **Indeed and Glassdoor** need a Chromium binary and block bots hardest. They'll often
  return zero jobs or a consent wall. This is normal, not a bug.
- Every source is isolated: if Indeed fails, RemoteOK still returns its jobs. The scrape
  response includes a per-source status so you can see exactly which source failed and why.
- If **all** sources fail you get a `502` with a per-source breakdown rather than an empty
  list masquerading as success.
- Check `/api/jobs/scrape/logs` for the history of each run.

### "Chromium is not available"

The Puppeteer browser isn't installed. Run:

```bash
cd backend && npx puppeteer browsers install chrome
```

On Linux you may also need the shared libraries Puppeteer expects:

```bash
sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2 libpango-1.0-0 libcairo2
```

Scraping RemoteOK/Remotive/LinkedIn and every non-automated feature works without it.

### Port already in use

```bash
# change the backend port
cd backend && PORT=5001 npm start

# tell the frontend where to find it
cd frontend && BACKEND_URL=http://localhost:5001 npm run dev
```

### Upload fails

- Only **PDF** and **DOCX** are accepted; anything else is rejected with a `415`.
- The limit is **5 MB** (`MAX_UPLOAD_MB`). Trim images out of your resume — most ATS
  systems ignore them anyway.
- A scanned/image-only PDF has no text layer and will parse to almost nothing. Export your
  resume to PDF from the source document instead of scanning it.

### AI features say "not configured"

No OpenAI key is set. Either add one in **Preferences → AI settings** or put
`OPENAI_API_KEY=...` in `backend/.env` and restart. Everything still works without one —
the template engine takes over. Press **Test** to confirm connectivity and see the model.

### Desktop notifications don't appear

`node-notifier` needs a notification daemon. On Linux that means `libnotify` plus a
running desktop session; inside Docker or over SSH there's nowhere to send them. Alerts are
always recorded regardless — read them at `/api/notifications` or in the in-app feed.

### The database got messed up

It's a single file. Stop the backend, delete `backend/db/database.sqlite*`, restart, and
you get a clean schema with a fresh preferences row.

```bash
rm backend/db/database.sqlite*
cd backend && npm run seed      # optional demo data
```

### I want to start completely over

```bash
rm -rf backend/db/database.sqlite* backend/uploads/resumes/*.pdf
cd backend && npm start
```

---

## Notes and honest limits

- **This tool automates applications, and job boards prohibit automation in their terms of
  service.** Use it at your own discretion and risk. Keep volumes modest.
- **No authentication.** It binds a network interface by default; run it on a machine you
  trust, or set `HOST=127.0.0.1` to restrict it to localhost.
- **Your data stays local.** Resumes and the SQLite file never leave your machine. The only
  outbound calls are to job boards and, if you set a key, to OpenAI.
- **Cover letters are a starting point.** Read and edit them before sending — a generic
  letter is worse than none.

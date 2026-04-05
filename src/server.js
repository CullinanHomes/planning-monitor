const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const path = require('path');
const { Parser } = require('json2csv');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'planning2025';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// ── Database ──────────────────────────────────────────────────────────────────
const dbPath = process.env.DB_PATH || '/data/leads.db';
const db = new sqlite3.Database(dbPath);

// Promisify db methods
const dbRun = (sql, params=[]) => new Promise((res,rej) => db.run(sql, params, function(err){ if(err) rej(err); else res(this); }));
const dbGet = (sql, params=[]) => new Promise((res,rej) => db.get(sql, params, (err,row) => err ? rej(err) : res(row)));
const dbAll = (sql, params=[]) => new Promise((res,rej) => db.all(sql, params, (err,rows) => err ? rej(err) : res(rows)));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT UNIQUE,
    lpa TEXT,
    address TEXT,
    applicant TEXT,
    agent TEXT,
    description TEXT,
    date_submitted TEXT,
    date_scraped TEXT,
    app_type TEXT,
    est_value_min INTEGER,
    est_value_max INTEGER,
    priority_score INTEGER,
    no_agent INTEGER,
    signals TEXT,
    land_registry_url TEXT,
    portal_url TEXT,
    contacted INTEGER DEFAULT 0,
    notes TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS scrape_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at TEXT,
    lpa TEXT,
    found INTEGER,
    qualified INTEGER,
    error TEXT
  )`);
});

// ── LPA scrapers ──────────────────────────────────────────────────────────────
const LPAs = [
  {
    name: 'Elmbridge',
    searchUrl: 'https://www.elmbridge.gov.uk/planning/search-for-planning-applications/',
    weeklyUrl: 'https://publicaccess.elmbridge.gov.uk/online-applications/search.do?action=weeklyList&searchType=Application',
    portal: 'https://publicaccess.elmbridge.gov.uk/online-applications/'
  },
  {
    name: 'Richmond',
    searchUrl: 'https://www.richmond.gov.uk/planning',
    weeklyUrl: 'https://www2.richmond.gov.uk/PlanningApplications/search.aspx?weeklylist=true',
    portal: 'https://www2.richmond.gov.uk/PlanningApplications/'
  },
  {
    name: 'Merton',
    searchUrl: 'https://planning.merton.gov.uk/',
    weeklyUrl: 'https://planning.merton.gov.uk/Northgate/PlanningExplorer/GeneralSearch.aspx',
    portal: 'https://planning.merton.gov.uk/'
  }
];

async function scrapeElmbridge() {
  const results = [];
  try {
    const url = 'https://publicaccess.elmbridge.gov.uk/online-applications/search.do?action=weeklyList&searchType=Application';
    const { data } = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(data);
    $('li.searchresult').each((_, el) => {
      const ref = $(el).find('.reference').text().trim();
      const address = $(el).find('.address').text().trim();
      const desc = $(el).find('.description').text().trim();
      const date = $(el).find('.date').text().trim();
      const link = $(el).find('a').attr('href');
      if (ref) results.push({ ref, address, description: desc, date_submitted: date, applicant: '', agent: '', portal_url: 'https://publicaccess.elmbridge.gov.uk' + link, lpa: 'Elmbridge' });
    });
  } catch (e) {
    console.error('Elmbridge scrape error:', e.message);
  }
  return results;
}

async function scrapeRichmond() {
  const results = [];
  try {
    const url = 'https://www2.richmond.gov.uk/PlanningApplications/search.aspx';
    const { data } = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(data);
    $('table.results tr').slice(1).each((_, el) => {
      const cells = $(el).find('td');
      const ref = $(cells[0]).text().trim();
      const address = $(cells[2]).text().trim();
      const desc = $(cells[3]).text().trim();
      const date = $(cells[1]).text().trim();
      const link = $(cells[0]).find('a').attr('href');
      if (ref) results.push({ ref, address, description: desc, date_submitted: date, applicant: '', agent: '', portal_url: link ? 'https://www2.richmond.gov.uk' + link : '', lpa: 'Richmond' });
    });
  } catch (e) {
    console.error('Richmond scrape error:', e.message);
  }
  return results;
}

async function scrapeMerton() {
  const results = [];
  try {
    const url = 'https://planning.merton.gov.uk/Northgate/PlanningExplorer/GeneralSearch.aspx';
    const { data } = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(data);
    $('table#tblResults tr').slice(1).each((_, el) => {
      const cells = $(el).find('td');
      const ref = $(cells[0]).text().trim();
      const address = $(cells[1]).text().trim();
      const desc = $(cells[2]).text().trim();
      const date = $(cells[3]).text().trim();
      const link = $(cells[0]).find('a').attr('href');
      if (ref) results.push({ ref, address, description: desc, date_submitted: date, applicant: '', agent: '', portal_url: link || '', lpa: 'Merton' });
    });
  } catch (e) {
    console.error('Merton scrape error:', e.message);
  }
  return results;
}

// ── AI classifier ─────────────────────────────────────────────────────────────
async function classifyApplications(apps) {
  if (!API_KEY || apps.length === 0) return apps.map(a => ({ ...a, app_type: 'unknown', est_value_min: 0, est_value_max: 0, priority_score: 0, no_agent: 0, signals: '[]' }));

  const client = new Anthropic({ apiKey: API_KEY });
  const classified = [];

  const chunks = [];
  for (let i = 0; i < apps.length; i += 10) chunks.push(apps.slice(i, i + 10));

  for (const chunk of chunks) {
    const prompt = `You are a property development lead qualifier for a design-and-build contractor in Surrey/SW London.

For each planning application below, return a JSON array with one object per application.

Rules:
- app_type: one of "large_extension", "selfbuild", "conversion", "loft_complex", "other"
- est_value_min and est_value_max: estimated BUILD cost in GBP (integers). Base on description: loft+dormer=£80k-£120k, two-storey extension=£150k-£250k, basement=£200k-£400k, self-build house=£400k-£900k, conversion to flats=£200k-£600k, pool=+£80k, large garden studio=£50k-£100k
- priority_score: 0-100. Higher if: no agent listed, self-build, large scope, basement, multiple works combined, pool, premium area
- no_agent: 1 if no architect or agent name visible, else 0
- signals: array of up to 3 short strings explaining why this is/isn't a good lead
- qualified: true if est_value_min >= 150000, false otherwise

Applications:
${JSON.stringify(chunk.map(a => ({ ref: a.ref, description: a.description, agent: a.agent, address: a.address })))}

Return ONLY a JSON array, no markdown, no explanation.`;

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      });
      const text = response.content[0].text.replace(/```json|```/g, '').trim();
      const results = JSON.parse(text);
      results.forEach((r, i) => {
        if (chunk[i]) classified.push({ ...chunk[i], ...r, signals: JSON.stringify(r.signals || []) });
      });
    } catch (e) {
      console.error('Classification error:', e.message);
      chunk.forEach(a => classified.push({ ...a, app_type: 'unknown', est_value_min: 0, est_value_max: 0, priority_score: 50, no_agent: 0, signals: '[]' }));
    }
  }
  return classified;
}

// ── Save to DB ────────────────────────────────────────────────────────────────
async function saveLeads(leads) {
  const now = new Date().toISOString().split('T')[0];
  let saved = 0;
  for (const l of leads) {
    const postcode = extractPostcode(l.address);
    const lrUrl = postcode ? `https://search.landregistry.gov.uk/app/search#?query=${encodeURIComponent(l.address)}` : '';
    try {
      const result = await dbRun(
        `INSERT OR IGNORE INTO leads (ref,lpa,address,applicant,agent,description,date_submitted,date_scraped,app_type,est_value_min,est_value_max,priority_score,no_agent,signals,land_registry_url,portal_url)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [l.ref,l.lpa,l.address||'',l.applicant||'',l.agent||'',l.description||'',l.date_submitted||'',now,l.app_type||'unknown',l.est_value_min||0,l.est_value_max||0,l.priority_score||0,l.no_agent||0,l.signals||'[]',lrUrl,l.portal_url||'']
      );
      if (result.changes) saved++;
    } catch(e) { console.error('Save error:', e.message); }
  }
  return saved;
}

function extractPostcode(address) {
  const m = address && address.match(/[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}/i);
  return m ? m[0] : null;
}

// ── Main scrape job ───────────────────────────────────────────────────────────
async function runScrape() {
  console.log('Running scrape job:', new Date().toISOString());
  const scrapers = [
    { name: 'Elmbridge', fn: scrapeElmbridge },
    { name: 'Richmond', fn: scrapeRichmond },
    { name: 'Merton', fn: scrapeMerton }
  ];

  for (const { name, fn } of scrapers) {
    try {
      const raw = await fn();
      const classified = await classifyApplications(raw);
      const qualified = classified.filter(a => a.est_value_min >= 150000 || a.qualified);
      const saved = await saveLeads(qualified);
      await dbRun('INSERT INTO scrape_log (ran_at,lpa,found,qualified) VALUES (?,?,?,?)', [new Date().toISOString(), name, raw.length, saved]);
      console.log(`${name}: found ${raw.length}, qualified ${qualified.length}, saved ${saved} new`);
    } catch (e) {
      await dbRun('INSERT INTO scrape_log (ran_at,lpa,found,qualified,error) VALUES (?,?,?,?,?)', [new Date().toISOString(), name, 0, 0, e.message]);
    }
  }
}

// Run daily at 7am
cron.schedule('0 7 * * *', runScrape);

// ── Auth middleware ───────────────────────────────────────────────────────────
const sessions = new Set();
function auth(req, res, next) {
  const token = req.headers['x-session'] || req.query.session;
  if (sessions.has(token)) return next();
  res.status(401).json({ error: 'Unauthorised' });
}

// ── API routes ────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  if (req.body.password === DASHBOARD_PASSWORD) {
    const token = Math.random().toString(36).slice(2) + Date.now();
    sessions.add(token);
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

app.get('/api/leads', auth, async (req, res) => {
  const { lpa, type, sort, page = 1, limit = 50, search } = req.query;
  let sql = 'SELECT * FROM leads WHERE 1=1';
  const params = [];
  if (lpa && lpa !== 'all') { sql += ' AND lpa=?'; params.push(lpa); }
  if (type && type !== 'all') { sql += ' AND app_type=?'; params.push(type); }
  if (search) { sql += ' AND (address LIKE ? OR description LIKE ? OR applicant LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  sql += sort === 'value' ? ' ORDER BY est_value_max DESC' : sort === 'score' ? ' ORDER BY priority_score DESC' : ' ORDER BY date_submitted DESC, date_scraped DESC';
  sql += ' LIMIT ? OFFSET ?';
  params.push(Number(limit), (Number(page) - 1) * Number(limit));
  const leads = await dbAll(sql, params);
  const countParams = [];
  let countSql = 'SELECT COUNT(*) as n FROM leads WHERE 1=1';
  if (lpa && lpa !== 'all') { countSql += ' AND lpa=?'; countParams.push(lpa); }
  if (type && type !== 'all') { countSql += ' AND app_type=?'; countParams.push(type); }
  const countRow = await dbGet(countSql, countParams);
  res.json({ leads: leads.map(l => ({ ...l, signals: JSON.parse(l.signals || '[]') })), total: countRow.n });
});

app.get('/api/stats', auth, async (req, res) => {
  const total = (await dbGet('SELECT COUNT(*) as n FROM leads')).n;
  const thisWeek = (await dbGet("SELECT COUNT(*) as n FROM leads WHERE date_scraped >= date('now','-7 days')")).n;
  const noAgent = (await dbGet('SELECT COUNT(*) as n FROM leads WHERE no_agent=1')).n;
  const pipeline = (await dbGet('SELECT SUM(est_value_max) as v FROM leads')).v || 0;
  const lastRun = await dbGet('SELECT ran_at FROM scrape_log ORDER BY id DESC LIMIT 1');
  res.json({ total, thisWeek, noAgent, pipeline, lastRun: lastRun?.ran_at });
});

app.post('/api/leads/:id/contact', auth, async (req, res) => {
  await dbRun('UPDATE leads SET contacted=1, notes=? WHERE id=?', [req.body.notes || '', req.params.id]);
  res.json({ ok: true });
});

app.get('/api/export', auth, async (req, res) => {
  const leads = await dbAll('SELECT * FROM leads ORDER BY date_submitted DESC');
  const fields = ['lpa','address','applicant','agent','description','app_type','est_value_min','est_value_max','priority_score','date_submitted','ref','land_registry_url','portal_url','contacted','notes'];
  const parser = new Parser({ fields });
  const csv = parser.parse(leads);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="planning-leads-${new Date().toISOString().split('T')[0]}.csv"`);
  res.send(csv);
});

app.post('/api/scrape-now', auth, async (req, res) => {
  res.json({ ok: true, message: 'Scrape started' });
  runScrape().catch(console.error);
});

// ── Serve dashboard ───────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

app.listen(PORT, () => console.log(`Planning monitor running on port ${PORT}`));

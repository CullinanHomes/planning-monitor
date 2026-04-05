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
const PASS = process.env.DASHBOARD_PASSWORD || 'planning2025';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

const db = new sqlite3.Database('/tmp/leads.db');
const dbRun = (s,p) => new Promise((ok,fail) => db.run(s,p||[],function(e){ e?fail(e):ok(this); }));
const dbGet = (s,p) => new Promise((ok,fail) => db.get(s,p||[],(e,r) => e?fail(e):ok(r)));
const dbAll = (s,p) => new Promise((ok,fail) => db.all(s,p||[],(e,r) => e?fail(e):ok(r)));

db.serialize(function() {
  db.run('CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE, lpa TEXT, address TEXT, applicant TEXT, agent TEXT, description TEXT, date_submitted TEXT, date_scraped TEXT, app_type TEXT, est_value_min INTEGER, est_value_max INTEGER, priority_score INTEGER, no_agent INTEGER, signals TEXT, land_registry_url TEXT, portal_url TEXT, contacted INTEGER DEFAULT 0, notes TEXT)');
  db.run('CREATE TABLE IF NOT EXISTS scrape_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ran_at TEXT, lpa TEXT, found INTEGER, qualified INTEGER, error TEXT)');
});

async function scrapeElmbridge() {
  var results = [];
  try {
    var r = await axios.get('https://publicaccess.elmbridge.gov.uk/online-applications/search.do?action=weeklyList&searchType=Application', { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    var $ = cheerio.load(r.data);
    $('li.searchresult').each(function(i, el) {
      var ref = $(el).find('.reference').text().trim();
      var address = $(el).find('.address').text().trim();
      var desc = $(el).find('.description').text().trim();
      var date = $(el).find('.date').text().trim();
      var link = $(el).find('a').attr('href') || '';
      if (ref) results.push({ ref: ref, address: address, description: desc, date_submitted: date, applicant: '', agent: '', portal_url: 'https://publicaccess.elmbridge.gov.uk' + link, lpa: 'Elmbridge' });
    });
  } catch(e) { console.error('Elmbridge error:', e.message); }
  return results;
}

async function scrapeRichmond() {
  var results = [];
  try {
    var r = await axios.get('https://www2.richmond.gov.uk/PlanningApplications/search.aspx', { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    var $ = cheerio.load(r.data);
    $('table.results tr').slice(1).each(function(i, el) {
      var cells = $(el).find('td');
      var ref = $(cells[0]).text().trim();
      var address = $(cells[2]).text().trim();
      var desc = $(cells[3]).text().trim();
      var date = $(cells[1]).text().trim();
      var link = $(cells[0]).find('a').attr('href') || '';
      if (ref) results.push({ ref: ref, address: address, description: desc, date_submitted: date, applicant: '', agent: '', portal_url: 'https://www2.richmond.gov.uk' + link, lpa: 'Richmond' });
    });
  } catch(e) { console.error('Richmond error:', e.message); }
  return results;
}

async function scrapeMerton() {
  var results = [];
  try {
    var r = await axios.get('https://planning.merton.gov.uk/Northgate/PlanningExplorer/GeneralSearch.aspx', { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    var $ = cheerio.load(r.data);
    $('table#tblResults tr').slice(1).each(function(i, el) {
      var cells = $(el).find('td');
      var ref = $(cells[0]).text().trim();
      var address = $(cells[1]).text().trim();
      var desc = $(cells[2]).text().trim();
      var date = $(cells[3]).text().trim();
      var link = $(cells[0]).find('a').attr('href') || '';
      if (ref) results.push({ ref: ref, address: address, description: desc, date_submitted: date, applicant: '', agent: '', portal_url: link, lpa: 'Merton' });
    });
  } catch(e) { console.error('Merton error:', e.message); }
  return results;
}

async function classifyApplications(apps) {
  if (!API_KEY || apps.length === 0) return apps.map(function(a) { return Object.assign({}, a, { app_type: 'unknown', est_value_min: 0, est_value_max: 0, priority_score: 0, no_agent: 0, signals: '[]' }); });
  var client = new Anthropic({ apiKey: API_KEY });
  var classified = [];
  var chunks = [];
  for (var i = 0; i < apps.length; i += 10) chunks.push(apps.slice(i, i + 10));
  for (var c = 0; c < chunks.length; c++) {
    var chunk = chunks[c];
    try {
      var prompt = 'You are a property development lead qualifier. For each planning application below, return a JSON array. Fields: app_type (large_extension/selfbuild/conversion/loft_complex/other), est_value_min (integer GBP), est_value_max (integer GBP), priority_score (0-100), no_agent (1 or 0), signals (array of 3 short strings), qualified (true if est_value_min >= 150000). Applications: ' + JSON.stringify(chunk.map(function(a) { return { ref: a.ref, description: a.description, agent: a.agent, address: a.address }; })) + ' Return ONLY a JSON array, no markdown.';
      var response = await client.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] });
      var text = response.content[0].text.replace(/```json|```/g, '').trim();
      var results = JSON.parse(text);
      for (var j = 0; j < results.length; j++) {
        if (chunk[j]) classified.push(Object.assign({}, chunk[j], results[j], { signals: JSON.stringify(results[j].signals || []) }));
      }
    } catch(e) {
      for (var k = 0; k < chunk.length; k++) classified.push(Object.assign({}, chunk[k], { app_type: 'unknown', est_value_min: 0, est_value_max: 0, priority_score: 50, no_agent: 0, signals: '[]' }));
    }
  }
  return classified;
}

async function saveLeads(leads) {
  var now = new Date().toISOString().split('T')[0];
  var saved = 0;
  for (var i = 0; i < leads.length; i++) {
    var l = leads[i];
    var m = l.address && l.address.match(/[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}/i);
    var lrUrl = m ? 'https://search.landregistry.gov.uk/app/search#?query=' + encodeURIComponent(l.address) : '';
    try {
      var result = await dbRun('INSERT OR IGNORE INTO leads (ref,lpa,address,applicant,agent,description,date_submitted,date_scraped,app_type,est_value_min,est_value_max,priority_score,no_agent,signals,land_registry_url,portal_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [l.ref,l.lpa,l.address||'',l.applicant||'',l.agent||'',l.description||'',l.date_submitted||'',now,l.app_type||'unknown',l.est_value_min||0,l.est_value_max||0,l.priority_score||0,l.no_agent||0,l.signals||'[]',lrUrl,l.portal_url||'']);
      if (result.changes) saved++;
    } catch(e) { console.error('Save error:', e.message); }
  }
  return saved;
}

async function runScrape() {
  console.log('Running scrape:', new Date().toISOString());
  var scrapers = [{ name: 'Elmbridge', fn: scrapeElmbridge }, { name: 'Richmond', fn: scrapeRichmond }, { name: 'Merton', fn: scrapeMerton }];
  for (var i = 0; i < scrapers.length; i++) {
    var name = scrapers[i].name;
    var fn = scrapers[i].fn;
    try {
      var raw = await fn();
      var classified = await classifyApplications(raw);
      var qualified = classified.filter(function(a) { return a.est_value_min >= 150000 || a.qualified; });
      var saved = await saveLeads(qualified);
      await dbRun('INSERT INTO scrape_log (ran_at,lpa,found,qualified) VALUES (?,?,?,?)', [new Date().toISOString(), name, raw.length, saved]);
    } catch(e) {
      await dbRun('INSERT INTO scrape_log (ran_at,lpa,found,qualified,error) VALUES (?,?,?,?,?)', [new Date().toISOString(), name, 0, 0, e.message]);
    }
  }
}

cron.schedule('0 7 * * *', runScrape);

var sessions = new Set();
function auth(req, res, next) {
  var token = req.headers['x-session'] || req.query.session;
  if (sessions.has(token)) return next();
  res.status(401).json({ error: 'Unauthorised' });
}

app.post('/api/login', function(req, res) {
  if (req.body.password === PASS) {
    var token = Math.random().toString(36).slice(2) + Date.now();
    sessions.add(token);
    res.json({ token: token });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

app.get('/api/leads', auth, async function(req, res) {
  var lpa = req.query.lpa, type = req.query.type, sort = req.query.sort, search = req.query.search;
  var page = Number(req.query.page) || 1, limit = Number(req.query.limit) || 50;
  var sql = 'SELECT * FROM leads WHERE 1=1';
  var params = [];
  if (lpa && lpa !== 'all') { sql += ' AND lpa=?'; params.push(lpa); }
  if (type && type !== 'all') { sql += ' AND app_type=?'; params.push(type); }
  if (search) { sql += ' AND (address LIKE ? OR description LIKE ? OR applicant LIKE ?)'; params.push('%'+search+'%','%'+search+'%','%'+search+'%'); }
  sql += sort === 'value' ? ' ORDER BY est_value_max DESC' : sort === 'score' ? ' ORDER BY priority_score DESC' : ' ORDER BY date_submitted DESC, date_scraped DESC';
  sql += ' LIMIT ? OFFSET ?';
  params.push(limit, (page-1)*limit);
  var leads = await dbAll(sql, params);
  var countSql = 'SELECT COUNT(*) as n FROM leads WHERE 1=1';
  var countParams = [];
  if (lpa && lpa !== 'all') { countSql += ' AND lpa=?'; countParams.push(lpa); }
  if (type && type !== 'all') { countSql += ' AND app_type=?'; countParams.push(type); }
  var countRow = await dbGet(countSql, countParams);
  res.json({ leads: leads.map(function(l) { return Object.assign({}, l, { signals: JSON.parse(l.signals||'[]') }); }), total: countRow.n });
});

app.get('/api/stats', auth, async function(req, res) {
  var total = (await dbGet('SELECT COUNT(*) as n FROM leads')).n;
  var thisWeek = (await dbGet("SELECT COUNT(*) as n FROM leads WHERE date_scraped >= date('now','-7 days')")).n;
  var noAgent = (await dbGet('SELECT COUNT(*) as n FROM leads WHERE no_agent=1')).n;
  var pipeline = (await dbGet('SELECT SUM(est_value_max) as v FROM leads')).v || 0;
  var lastRun = await dbGet('SELECT ran_at FROM scrape_log ORDER BY id DESC LIMIT 1');
  res.json({ total: total, thisWeek: thisWeek, noAgent: noAgent, pipeline: pipeline, lastRun: lastRun ? lastRun.ran_at : null });
});

app.post('/api/leads/:id/contact', auth, async function(req, res) {
  await dbRun('UPDATE leads SET contacted=1, notes=? WHERE id=?', [req.body.notes||'', req.params.id]);
  res.json({ ok: true });
});

app.get('/api/export', auth, async function(req, res) {
  var leads = await dbAll('SELECT * FROM leads ORDER BY date_submitted DESC');
  var fields = ['lpa','address','applicant','agent','description','app_type','est_value_min','est_value_max','priority_score','date_submitted','ref','land_registry_url','portal_url','contacted','notes'];
  var csv = new Parser({ fields: fields }).parse(leads);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=planning-leads.csv');
  res.send(csv);
});

app.post('/api/scrape-now', auth, async function(req, res) {
  res.json({ ok: true });
  runScrape().catch(console.error);
});

app.get('*', function(req, res) { res.sendFile(path.join(__dirname, '../public/index.html')); });
app.listen(PORT, function() { console.log('Planning monitor running on port ' + PORT); });

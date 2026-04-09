const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');
const { Parser } = require('json2csv');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const PASS = process.env.DASHBOARD_PASSWORD || 'planning2025';

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

const db = new sqlite3.Database('/tmp/leads.db');
const dbRun = (s,p) => new Promise((ok,fail) => db.run(s,p||[],function(e){ e?fail(e):ok(this); }));
const dbGet = (s,p) => new Promise((ok,fail) => db.get(s,p||[],(e,r) => e?fail(e):ok(r)));
const dbAll = (s,p) => new Promise((ok,fail) => db.all(s,p||[],(e,r) => e?fail(e):ok(r)));

db.serialize(function() {
  db.run('CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE, lpa TEXT, address TEXT, postcode TEXT, applicant TEXT, agent TEXT, description TEXT, date_submitted TEXT, date_scraped TEXT, app_type TEXT, is_new_application INTEGER, contract_value_min INTEGER, contract_value_max INTEGER, planning_likelihood INTEGER, planning_notes TEXT, priority_score INTEGER, no_agent INTEGER, signals TEXT, portal_url TEXT, contacted INTEGER DEFAULT 0, notes TEXT)');
  db.run('CREATE TABLE IF NOT EXISTS scrape_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ran_at TEXT, lpa TEXT, found INTEGER, qualified INTEGER, error TEXT)');
});

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

app.post('/api/classify', auth, async function(req, res) {
  var text = req.body.text;
  var lpa = req.body.lpa || 'Unknown';
  if (!text || text.length < 50) return res.status(400).json({ error: 'No text provided' });
  if (!API_KEY) return res.status(500).json({ error: 'No API key configured' });
  var client = new Anthropic({ apiKey: API_KEY });
  var prompt = 'You are a property development lead qualifier for a design-and-build contractor in Surrey/SW London. We deliver cost-plus construction projects. Minimum project value 150000.\n\nExtract every planning application from the text and return a JSON array. ONLY include where contract_value_min >= 150000.\n\nFor each return:\n- ref: application reference number\n- address: full site address\n- postcode: postcode if visible\n- applicant: applicant name if visible else empty string\n- agent: architect or agent name if visible else empty string\n- description: full description of works\n- app_type: large_extension or selfbuild or conversion or loft_complex or other\n- is_new_application: true if new application false if amendment\n- date_submitted: date if visible\n- contract_value_min: integer GBP. Use: loft=100000, single-storey extension=120000, two-storey extension=180000, basement=300000, self-build house=550000, conversion to flats=300000, pool add 100000\n- contract_value_max: integer GBP\n- planning_likelihood: integer 0-100\n- planning_notes: one sentence\n- priority_score: integer 0-100, higher if no agent, self-build, large scope, premium area\n- no_agent: 1 if no agent listed else 0\n- signals: array of 3 short strings\n\nCouncil: ' + lpa + '\n\nText:\n' + text.slice(0, 9000) + '\n\nReturn ONLY a valid JSON array. No markdown. No explanation.';
  try {
    var response = await client.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] });
    var raw = response.content[0].text.replace(/```json|```/g, '').trim();
    var leads = JSON.parse(raw);
    res.json({ leads: leads });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leads/save', auth, async function(req, res) {
  var leads = req.body.leads;
  var now = new Date().toISOString().split('T')[0];
  var saved = 0;
  for (var i = 0; i < leads.length; i++) {
    var l = leads[i];
    try {
      var result = await dbRun(
        'INSERT OR IGNORE INTO leads (ref,lpa,address,postcode,applicant,agent,description,date_submitted,date_scraped,app_type,is_new_application,contract_value_min,contract_value_max,planning_likelihood,planning_notes,priority_score,no_agent,signals,portal_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [l.ref||l.address,l.lpa,l.address||'',l.postcode||'',l.applicant||'',l.agent||'',l.description||'',l.date_submitted||'',now,l.app_type||'other',l.is_new_application?1:0,l.contract_value_min||0,l.contract_value_max||0,l.planning_likelihood||0,l.planning_notes||'',l.priority_score||0,l.no_agent||0,JSON.stringify(l.signals||[]),l.portal_url||'']
      );
      if (result.changes) saved++;
    } catch(e) { console.error('Save error:', e.message); }
  }
  res.json({ saved: saved });
});

app.get('/api/leads', auth, async function(req, res) {
  var lpa=req.query.lpa, type=req.query.type, sort=req.query.sort, search=req.query.search;
  var page=Number(req.query.page)||1, limit=Number(req.query.limit)||50;
  var sql='SELECT * FROM leads WHERE 1=1';
  var params=[];
  if (lpa&&lpa!=='all'){sql+=' AND lpa=?';params.push(lpa);}
  if (type&&type!=='all'){sql+=' AND app_type=?';params.push(type);}
  if (search){sql+=' AND (address LIKE ? OR description LIKE ? OR applicant LIKE ?)';params.push('%'+search+'%','%'+search+'%','%'+search+'%');}
  sql+=sort==='value'?' ORDER BY contract_value_max DESC':sort==='planning'?' ORDER BY planning_likelihood DESC':sort==='score'?' ORDER BY priority_score DESC':' ORDER BY date_scraped DESC, date_submitted DESC';
  sql+=' LIMIT ? OFFSET ?';
  params.push(limit,(page-1)*limit);
  var leads=await dbAll(sql,params);
  var countSql='SELECT COUNT(*) as n FROM leads WHERE 1=1';
  var countParams=[];
  if (lpa&&lpa!=='all'){countSql+=' AND lpa=?';countParams.push(lpa);}
  if (type&&type!=='all'){countSql+=' AND app_type=?';countParams.push(type);}
  var countRow=await dbGet(countSql,countParams);
  res.json({leads:leads.map(function(l){return Object.assign({},l,{signals:JSON.parse(l.signals||'[]')});}),total:countRow.n});
});

app.get('/api/stats', auth, async function(req, res) {
  var total=(await dbGet('SELECT COUNT(*) as n FROM leads')).n;
  var thisWeek=(await dbGet("SELECT COUNT(*) as n FROM leads WHERE date_scraped >= date('now','-7 days')")).n;
  var noAgent=(await dbGet('SELECT COUNT(*) as n FROM leads WHERE no_agent=1')).n;
  var pipeline=(await dbGet('SELECT SUM(contract_value_max) as v FROM leads')).v||0;
  res.json({total:total,thisWeek:thisWeek,noAgent:noAgent,pipeline:pipeline});
});

app.post('/api/leads/:id/contact', auth, async function(req, res) {
  await dbRun('UPDATE leads SET contacted=1, notes=? WHERE id=?',[req.body.notes||'',req.params.id]);
  res.json({ok:true});
});

app.get('/api/export', auth, async function(req, res) {
  var leads=await dbAll('SELECT * FROM leads ORDER BY date_submitted DESC');
  var fields=['lpa','address','postcode','applicant','agent','description','app_type','contract_value_min','contract_value_max','planning_likelihood','planning_notes','priority_score','no_agent','date_submitted','ref','contacted','notes'];
  var csv=new Parser({fields:fields}).parse(leads);
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename=planning-leads.csv');
  res.send(csv);
});

app.post('/api/letter', auth, async function(req, res) {
  var lead = req.body.lead;
  if (!lead) return res.status(400).json({ error: 'No lead provided' });
  if (!API_KEY) return res.status(500).json({ error: 'No API key configured' });
  var client = new Anthropic({ apiKey: API_KEY });
  var prompt = 'Write a short, professional and warm outreach letter from Cullinan Homes to the following planning applicant. We are a local design-and-build contractor offering a cost-plus service — we handle everything from design through to completion, taking the stress out of the project for the owner.\n\nApplicant name: ' + (lead.applicant || 'the homeowner') + '\nProperty address: ' + (lead.address || '') + '\nDescription of works: ' + (lead.description || '') + '\nProject type: ' + (lead.app_type || '') + '\nEstimated contract value: ' + (lead.contract_value_min ? '£' + Math.round(lead.contract_value_min/1000) + 'k - £' + Math.round(lead.contract_value_max/1000) + 'k' : 'substantial') + '\n\nThe letter should:\n- Be addressed personally if we have a name, otherwise "Dear Homeowner"\n- Reference their specific project naturally\n- Explain what cost-plus means briefly\n- Be concise — 3 short paragraphs maximum\n- End with a clear call to action — a phone call or site visit\n- Be signed off from Oliver Robinson, Cullinan Homes\n- Sound human and local, not like a template\n\nReturn only the letter text, no subject line, no explanation.';
  try {
    var response = await client.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 600, messages: [{ role: 'user', content: prompt }] });
    res.json({ letter: response.content[0].text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*', function(req, res) { res.sendFile(path.join(__dirname, '../public/index.html')); });

app.listen(PORT, function() { console.log('Planning monitor running on port ' + PORT); });

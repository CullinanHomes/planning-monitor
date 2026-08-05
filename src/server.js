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

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

const fs = require('fs');
// Persistent storage resolution, in order of preference:
// 1. Explicit DB_PATH variable if set
// 2. RAILWAY_VOLUME_MOUNT_PATH — set automatically by Railway when a volume is attached,
//    so the database lands on the permanent volume wherever it is mounted
// 3. /data if it exists (manually mounted volume)
// 4. /tmp as a last resort (ephemeral — local dev only)
var RAILWAY_VOL = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DB_PATH = process.env.DB_PATH
  || (RAILWAY_VOL ? RAILWAY_VOL.replace(/\/$/, '') + '/leads.db' : null)
  || (fs.existsSync('/data') ? '/data/leads.db' : '/tmp/leads.db');
console.log('Using database at: ' + DB_PATH + (DB_PATH.indexOf('/tmp/') === 0 ? '  [WARNING: TEMPORARY STORAGE - DATA WILL NOT PERSIST]' : '  [persistent]'));
const db = new sqlite3.Database(DB_PATH);
const dbRun = (s,p) => new Promise((ok,fail) => db.run(s,p||[],function(e){ e?fail(e):ok(this); }));
const dbGet = (s,p) => new Promise((ok,fail) => db.get(s,p||[],(e,r) => e?fail(e):ok(r)));
const dbAll = (s,p) => new Promise((ok,fail) => db.all(s,p||[],(e,r) => e?fail(e):ok(r)));

db.serialize(function() {
  db.run('CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE, lpa TEXT, address TEXT, postcode TEXT, applicant TEXT, agent TEXT, description TEXT, date_submitted TEXT, date_scraped TEXT, app_type TEXT, is_new_application INTEGER, contract_value_min INTEGER, contract_value_max INTEGER, planning_likelihood INTEGER, planning_notes TEXT, priority_score INTEGER, no_agent INTEGER, signals TEXT, portal_url TEXT, contacted INTEGER DEFAULT 0, notes TEXT)');
  db.run('CREATE TABLE IF NOT EXISTS scrape_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ran_at TEXT, lpa TEXT, found INTEGER, qualified INTEGER, error TEXT)');
  db.run('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
  // Migration: add archived column to databases created before this feature existed
  db.run('ALTER TABLE leads ADD COLUMN archived INTEGER DEFAULT 0', function(e) { /* ignore if column already exists */ });
  // Migration: add estimated floor area column for build cost / profit calculations
  db.run('ALTER TABLE leads ADD COLUMN floor_area_sqft INTEGER DEFAULT 0', function(e) { /* ignore if column already exists */ });
  // Migration: contact detail fields, filled in manually as details are acquired
  db.run("ALTER TABLE leads ADD COLUMN contact_name TEXT DEFAULT ''", function(e) {});
  db.run("ALTER TABLE leads ADD COLUMN contact_phone TEXT DEFAULT ''", function(e) {});
  db.run("ALTER TABLE leads ADD COLUMN contact_email TEXT DEFAULT ''", function(e) {});
  db.run("ALTER TABLE leads ADD COLUMN contact_address TEXT DEFAULT ''", function(e) {});
  db.run("ALTER TABLE leads ADD COLUMN agent_address TEXT DEFAULT ''", function(e) {});
  // Migration: date a lead was actually marked contacted, distinct from date_scraped
  db.run("ALTER TABLE leads ADD COLUMN contacted_date TEXT DEFAULT ''", function(e) {});
  // Migration: pipeline stage tracking (new -> contacted -> interested -> quoted -> won/lost)
  db.run("ALTER TABLE leads ADD COLUMN stage TEXT DEFAULT 'new'", function(e) {});
  db.run("ALTER TABLE leads ADD COLUMN stage_date TEXT DEFAULT ''", function(e) {});
  db.run("ALTER TABLE leads ADD COLUMN lost_reason TEXT DEFAULT ''", function(e) {});
  // Backfill: leads already marked contacted before this feature existed start at the 'contacted' stage.
  // Safe to re-run — only touches rows still sitting at the default 'new' stage.
  db.run("UPDATE leads SET stage='contacted' WHERE contacted=1 AND (stage IS NULL OR stage='new')", function(e) {});

  // Land module: off-market outreach (letters + door knocks) to landowners, separate pipeline
  // from the planning-application leads above. Mirrors the site-tracker spreadsheet: type,
  // address, area, council, up to 4 letters, up to 2 door knocks, status and free-text notes.
  db.run(`CREATE TABLE IF NOT EXISTS land_sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT DEFAULT '',
    address TEXT NOT NULL,
    area TEXT DEFAULT '',
    council TEXT DEFAULT '',
    letter1_date TEXT DEFAULT '',
    letter2_date TEXT DEFAULT '',
    letter3_date TEXT DEFAULT '',
    letter4_date TEXT DEFAULT '',
    doorknock1_date TEXT DEFAULT '',
    doorknock2_date TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    responded INTEGER DEFAULT 0,
    response_date TEXT DEFAULT '',
    outcome TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    date_added TEXT,
    import_batch TEXT DEFAULT ''
  )`);
  // Migration: tag rows with the CSV import that created them, so a bad import can be undone
  // as a group rather than deleted one row at a time. Existing/manually-added rows stay ''.
  db.run("ALTER TABLE land_sites ADD COLUMN import_batch TEXT DEFAULT ''", function(e) { /* ignore if column already exists */ });

  // Site Calculator: development appraisals (residual land value / viability), modelled on
  // the multi-tab Excel appraisal workbook — revenue/accommodation schedule, acquisition,
  // build costs, professional fees, finance, costs of sale, all rolling up to a profit/
  // viability verdict. Calculation happens client-side (so it recalculates live as you type,
  // same feel as the spreadsheet); `inputs` is the full editable form state, `outputs` is a
  // computed snapshot taken at save time purely so the list view can show GDV/profit/verdict
  // without re-running the calculation for every saved site.
  db.run(`CREATE TABLE IF NOT EXISTS site_calcs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    site_type TEXT DEFAULT '',
    inputs TEXT NOT NULL,
    outputs TEXT NOT NULL,
    date_added TEXT,
    date_updated TEXT,
    land_site_id INTEGER
  )`);
  // Migration: links an appraisal to a Land outreach record, so the two sit together — a
  // site's contact history and its viability verdict, cross-referenced both ways.
  db.run("ALTER TABLE site_calcs ADD COLUMN land_site_id INTEGER", function(e) { /* ignore if column already exists */ });
});

var DEFAULT_LAND_SETTINGS = {
  letterIntervalMonths: [6, 12, 12],  // months from letter1->2, letter2->3, letter3->4
  maxLetters: 4,
  doorKnockAfterLetter: 2             // suggest a door knock once this many letters are out
};

async function getLandSettings() {
  var row = await dbGet('SELECT value FROM settings WHERE key=?', ['land_config']);
  if (!row) return DEFAULT_LAND_SETTINGS;
  try { return Object.assign({}, DEFAULT_LAND_SETTINGS, JSON.parse(row.value)); }
  catch(e) { return DEFAULT_LAND_SETTINGS; }
}

// Calendar-month arithmetic (not a fixed day count) — "6 months" should land on the same day
// next month regardless of how many days that spans. Clamps to the last day of the target
// month if the original day doesn't exist there (e.g. 31 Jan + 1 month -> 28/29 Feb, not 3 Mar).
function addMonths(dateStr, months) {
  var d = new Date(dateStr + 'T00:00:00');
  var day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() !== day) d.setDate(0);
  return d.toISOString().split('T')[0];
}

function addDays(dateStr, days) {
  var d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// Works out, from a site's letter/door-knock dates, what should happen next and whether
// it's overdue — this is the "next action" the Land dashboard sorts and badges by. Returns
// structured data (stage/n/dueDate/overdue) rather than pre-built text, so the frontend can
// clearly distinguish "this is scheduled for a future date" from "this is due right now" —
// both used to collapse into the same ambiguous "Letter 2 due" wording.
// Canonical status pipeline for a Land site. Once a site reaches any of the "outreach paused"
// stages, letter/door-knock cadence reminders stop making sense — you're not sending follow-up
// letters to someone you're already in legals with — so computeNextAction short-circuits for
// all of these, not just dead/converted.
var LAND_STATUSES = ['active','interested','offer_made','offer_refused','in_legals','converted','dead'];
var LAND_STATUS_OUTREACH_PAUSED = ['offer_made','offer_refused','in_legals','converted','dead'];

function computeNextAction(site, cfg) {
  var today = new Date().toISOString().split('T')[0];
  var letters = [site.letter1_date, site.letter2_date, site.letter3_date, site.letter4_date];
  var sentCount = letters.filter(Boolean).length;
  var lastLetterDate = null;
  for (var i = letters.length - 1; i >= 0; i--) { if (letters[i]) { lastLetterDate = letters[i]; break; } }

  if (LAND_STATUS_OUTREACH_PAUSED.indexOf(site.status) > -1) {
    return { stage: site.status, n: null, dueDate: null, overdue: false };
  }
  if (sentCount === 0) {
    return { stage: 'letter', n: 1, dueDate: null, overdue: true };
  }
  var knocksSent = [site.doorknock1_date, site.doorknock2_date].filter(Boolean).length;
  if (sentCount >= cfg.doorKnockAfterLetter && knocksSent === 0) {
    var dueForKnock = lastLetterDate ? addDays(lastLetterDate, 14) : today;
    return { stage: 'doorknock', n: knocksSent + 1, dueDate: dueForKnock, overdue: dueForKnock <= today };
  }
  if (sentCount >= cfg.maxLetters) {
    return { stage: 'complete', n: null, dueDate: null, overdue: false };
  }
  var intervalMonths = cfg.letterIntervalMonths[sentCount - 1] != null ? cfg.letterIntervalMonths[sentCount - 1] : 12;
  var nextDue = lastLetterDate ? addMonths(lastLetterDate, intervalMonths) : today;
  return { stage: 'letter', n: sentCount + 1, dueDate: nextDue, overdue: nextDue <= today };
}

app.get('/api/land/settings', auth, async function(req, res) {
  res.json(await getLandSettings());
});

app.post('/api/land/settings', auth, async function(req, res) {
  var current = await getLandSettings();
  var updated = Object.assign({}, current, req.body);
  await dbRun('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['land_config', JSON.stringify(updated)]);
  res.json(updated);
});

app.get('/api/land', auth, async function(req, res) {
  var area=req.query.area, council=req.query.council, type=req.query.type, status=req.query.status, search=req.query.search, due=req.query.due, responded=req.query.responded;
  var sql='SELECT * FROM land_sites WHERE 1=1', params=[];
  if (area&&area!=='all'){sql+=' AND area=?';params.push(area);}
  if (council&&council!=='all'){sql+=' AND council=?';params.push(council);}
  if (type&&type!=='all'){sql+=' AND type=?';params.push(type);}
  if (status&&status!=='all'){sql+=' AND status=?';params.push(status);}
  if (responded==='yes'){sql+=' AND responded=1';}
  else if (responded==='no'){sql+=' AND responded=0';}
  if (search){sql+=' AND (address LIKE ? OR notes LIKE ? OR type LIKE ? OR area LIKE ? OR council LIKE ?)';params.push('%'+search+'%','%'+search+'%','%'+search+'%','%'+search+'%','%'+search+'%');}
  sql+=' ORDER BY date_added DESC';
  var sites=await dbAll(sql,params);
  var cfg=await getLandSettings();
  var withActions=sites.map(function(s){ return Object.assign({}, s, { nextAction: computeNextAction(s, cfg) }); });
  if (due==='overdue') withActions=withActions.filter(function(s){return s.nextAction.overdue;});
  else if (due==='upcoming') withActions=withActions.filter(function(s){return !s.nextAction.overdue && (s.nextAction.stage==='letter' || s.nextAction.stage==='doorknock');});
  withActions.sort(function(a,b){
    if (a.nextAction.overdue !== b.nextAction.overdue) return a.nextAction.overdue ? -1 : 1;
    return 0;
  });
  res.json({ sites: withActions, total: withActions.length });
});

app.post('/api/land', auth, async function(req, res) {
  var b = req.body || {};
  if (!b.address) return res.status(400).json({ error: 'Address is required' });
  var now = new Date().toISOString().split('T')[0];
  var result = await dbRun(
    'INSERT INTO land_sites (type,address,area,council,status,notes,date_added) VALUES (?,?,?,?,?,?,?)',
    [b.type||'', b.address, b.area||'', b.council||'', b.status||'active', b.notes||'', now]
  );
  res.json({ ok: true, id: result.lastID });
});

// Bulk import — used by the CSV import feature. Accepts full historical rows (letter/door-knock
// dates included), so a spreadsheet's cadence history is preserved rather than starting fresh.
// Preview endpoint — no writes. Runs the exact same validation/dedupe logic as the real
// import so what you see here is what would actually happen, before anything touches the list.
app.post('/api/land/import/preview', auth, async function(req, res) {
  var rows = req.body.sites;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'sites must be an array' });
  var willImport = [], duplicates = [], invalid = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    if (!r.address) { invalid.push(r); continue; }
    var existing = await dbGet('SELECT id FROM land_sites WHERE address=?', [r.address]);
    if (existing) { duplicates.push(r.address); continue; }
    willImport.push(r);
  }
  res.json({
    total: rows.length,
    willImportCount: willImport.length,
    duplicateCount: duplicates.length,
    invalidCount: invalid.length,
    duplicates: duplicates.slice(0, 20),
    sample: willImport.slice(0, 10)
  });
});

// Bulk import — used by the CSV import feature. Accepts full historical rows (letter/door-knock
// dates included), so a spreadsheet's cadence history is preserved rather than starting fresh.
// Skips any row whose address already exists, so the same file can be safely re-imported.
// Every row inserted is stamped with a shared import_batch id so the whole import can be
// undone in one action via DELETE /api/land/import/:batchId if it turns out to be the wrong file.
app.post('/api/land/import', auth, async function(req, res) {
  var rows = req.body.sites;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'sites must be an array' });
  var today = new Date().toISOString().split('T')[0];
  var batchId = 'imp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  var imported = 0, skipped = 0, errors = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    if (!r.address) { skipped++; continue; }
    try {
      var existing = await dbGet('SELECT id FROM land_sites WHERE address=?', [r.address]);
      if (existing) { skipped++; continue; }
      await dbRun(
        `INSERT INTO land_sites
          (type,address,area,council,letter1_date,letter2_date,letter3_date,letter4_date,
           doorknock1_date,doorknock2_date,status,responded,response_date,outcome,notes,date_added,import_batch)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [r.type||'', r.address, r.area||'', r.council||'',
         r.letter1_date||'', r.letter2_date||'', r.letter3_date||'', r.letter4_date||'',
         r.doorknock1_date||'', r.doorknock2_date||'',
         r.status||'active', r.responded?1:0, r.response_date||'', r.outcome||'',
         r.notes||'', r.date_added||today, batchId]
      );
      imported++;
    } catch(e) { errors.push({ address: r.address, error: e.message }); }
  }
  res.json({ imported: imported, skipped: skipped, errors: errors, batchId: imported > 0 ? batchId : null });
});

app.get('/api/land/import/batches', auth, async function(req, res) {
  var rows = await dbAll(`SELECT import_batch, COUNT(*) as n, MIN(date_added) as date_added
    FROM land_sites WHERE import_batch != '' GROUP BY import_batch ORDER BY import_batch DESC LIMIT 10`);
  res.json({ batches: rows });
});

app.delete('/api/land/import/:batchId', auth, async function(req, res) {
  var result = await dbRun('DELETE FROM land_sites WHERE import_batch=?', [req.params.batchId]);
  res.json({ ok: true, deleted: result.changes });
});

var LAND_EDITABLE_FIELDS = ['type','address','area','council','notes',
  'letter1_date','letter2_date','letter3_date','letter4_date',
  'doorknock1_date','doorknock2_date','response_date'];
// Batch versions of the single-site letter/doorknock/status/delete actions — you send letters
// to dozens or hundreds of sites on the same day, so logging them one at a time doesn't match
// how the work actually happens. These take a list of site ids and one date, and apply it to
// all of them in a single request. Registered ahead of the /:id routes below deliberately —
// Express would otherwise match "/api/land/bulk/letter" against "/api/land/:id/letter" first,
// treating "bulk" as an id and silently doing nothing.
function validIdList(ids) {
  return Array.isArray(ids) && ids.length > 0 && ids.every(function(x){ return Number.isInteger(Number(x)); });
}

app.post('/api/land/bulk/letter', auth, async function(req, res) {
  var ids = req.body.ids, n = Number(req.body.n);
  if (!validIdList(ids)) return res.status(400).json({ error: 'ids must be a non-empty array' });
  if ([1,2,3,4].indexOf(n) === -1) return res.status(400).json({ error: 'Letter number must be 1-4' });
  var date = req.body.date || new Date().toISOString().split('T')[0];
  for (var i = 0; i < ids.length; i++) {
    await dbRun('UPDATE land_sites SET letter'+n+'_date=? WHERE id=?', [date, ids[i]]);
  }
  res.json({ ok: true, updated: ids.length, date: date });
});

app.post('/api/land/bulk/doorknock', auth, async function(req, res) {
  var ids = req.body.ids, n = Number(req.body.n);
  if (!validIdList(ids)) return res.status(400).json({ error: 'ids must be a non-empty array' });
  if ([1,2].indexOf(n) === -1) return res.status(400).json({ error: 'Door knock number must be 1-2' });
  var date = req.body.date || new Date().toISOString().split('T')[0];
  for (var i = 0; i < ids.length; i++) {
    await dbRun('UPDATE land_sites SET doorknock'+n+'_date=? WHERE id=?', [date, ids[i]]);
  }
  res.json({ ok: true, updated: ids.length, date: date });
});

app.post('/api/land/bulk/status', auth, async function(req, res) {
  var ids = req.body.ids, status = req.body.status;
  if (!validIdList(ids)) return res.status(400).json({ error: 'ids must be a non-empty array' });
  if (LAND_STATUSES.indexOf(status) === -1) return res.status(400).json({ error: 'Invalid status' });
  for (var i = 0; i < ids.length; i++) {
    await dbRun('UPDATE land_sites SET status=? WHERE id=?', [status, ids[i]]);
  }
  res.json({ ok: true, updated: ids.length });
});

app.post('/api/land/bulk/delete', auth, async function(req, res) {
  var ids = req.body.ids;
  if (!validIdList(ids)) return res.status(400).json({ error: 'ids must be a non-empty array' });
  for (var i = 0; i < ids.length; i++) {
    await dbRun('DELETE FROM land_sites WHERE id=?', [ids[i]]);
  }
  res.json({ ok: true, deleted: ids.length });
});

// Wipes every Land site unconditionally — a full reset rather than a filtered/selected delete.
// Registered ahead of DELETE /api/land/:id for the same reason as the bulk routes above:
// otherwise "reset" would be matched as if it were a site id and silently do nothing.
app.delete('/api/land/reset', auth, async function(req, res) {
  var result = await dbRun('DELETE FROM land_sites', []);
  res.json({ ok: true, deleted: result.changes });
});

app.post('/api/land/:id', auth, async function(req, res) {
  if (req.body.hasOwnProperty('address') && !req.body.address) return res.status(400).json({ error: 'Address cannot be empty' });
  // response_date only means something alongside responded=1 — if it's edited directly (e.g.
  // correcting a wrong date), keep the flag consistent rather than letting them drift apart.
  if (req.body.hasOwnProperty('response_date') && !req.body.hasOwnProperty('responded')) {
    req.body.responded = req.body.response_date ? 1 : 0;
  }
  var sets=[], params=[];
  LAND_EDITABLE_FIELDS.concat(req.body.hasOwnProperty('responded') ? ['responded'] : []).forEach(function(f){
    if (req.body.hasOwnProperty(f)) { sets.push(f+'=?'); params.push(f==='responded' ? (req.body[f]?1:0) : req.body[f]); }
  });
  if (!sets.length) return res.json({ ok: true });
  params.push(req.params.id);
  await dbRun('UPDATE land_sites SET '+sets.join(',')+' WHERE id=?', params);
  res.json({ ok: true });
});

app.post('/api/land/:id/status', auth, async function(req, res) {
  var status = req.body.status;
  if (LAND_STATUSES.indexOf(status) === -1) return res.status(400).json({ error: 'Invalid status' });
  await dbRun('UPDATE land_sites SET status=? WHERE id=?', [status, req.params.id]);
  res.json({ ok: true });
});

app.post('/api/land/:id/letter', auth, async function(req, res) {
  var n = Number(req.body.n);
  if ([1,2,3,4].indexOf(n) === -1) return res.status(400).json({ error: 'Letter number must be 1-4' });
  var date = req.body.date || new Date().toISOString().split('T')[0];
  await dbRun('UPDATE land_sites SET letter'+n+'_date=? WHERE id=?', [date, req.params.id]);
  res.json({ ok: true });
});

app.post('/api/land/:id/doorknock', auth, async function(req, res) {
  var n = Number(req.body.n);
  if ([1,2].indexOf(n) === -1) return res.status(400).json({ error: 'Door knock number must be 1-2' });
  var date = req.body.date || new Date().toISOString().split('T')[0];
  await dbRun('UPDATE land_sites SET doorknock'+n+'_date=? WHERE id=?', [date, req.params.id]);
  res.json({ ok: true });
});

app.post('/api/land/:id/response', auth, async function(req, res) {
  var responded = req.body.responded ? 1 : 0;
  var date = responded ? (req.body.response_date || new Date().toISOString().split('T')[0]) : '';
  await dbRun('UPDATE land_sites SET responded=?, response_date=?, outcome=? WHERE id=?', [responded, date, req.body.outcome||'', req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/land/:id', auth, async function(req, res) {
  await dbRun('DELETE FROM land_sites WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// A response is attributed to whichever letter was the most recent one sent before it came
// in — e.g. if letter 1 went out, then letter 2, then the owner replied, that reply is
// counted against letter 2's window, not letter 1's. Lets us report "1st letter response
// rate" etc precisely, without needing to record which letter triggered a reply by hand.
function attributedLetterStage(site) {
  var letters = [site.letter1_date, site.letter2_date, site.letter3_date, site.letter4_date];
  if (!site.responded || !site.response_date) return null;
  var stage = null;
  for (var i = 0; i < 4; i++) {
    if (letters[i] && letters[i] <= site.response_date) stage = i + 1;
  }
  return stage;
}

function buildScorecard(sites) {
  var segments = {};
  sites.forEach(function(s){
    var seg = s.type || 'Unspecified';
    if (!segments[seg]) segments[seg] = [1,2,3,4].map(function(){ return { sent: 0, responded: 0 }; });
    var letters = [s.letter1_date, s.letter2_date, s.letter3_date, s.letter4_date];
    var respondedStage = attributedLetterStage(s);
    for (var i = 0; i < 4; i++) {
      if (letters[i]) segments[seg][i].sent++;
    }
    if (respondedStage) segments[seg][respondedStage-1].responded++;
  });
  return Object.keys(segments).sort().map(function(seg){
    return {
      segment: seg,
      stages: segments[seg].map(function(st){
        return { sent: st.sent, responded: st.responded, rate: st.sent > 0 ? Math.round((st.responded/st.sent)*100) : null };
      })
    };
  });
}

// Always queries ALL sites, ignoring whatever filters are currently applied in the UI — this is
// what the area/council/type filter dropdowns should be built from, not the current (possibly
// filtered) result set, otherwise the dropdowns shrink to whatever's on screen and never recover.
app.get('/api/land/facets', auth, async function(req, res) {
  var rows = await dbAll('SELECT DISTINCT area, council, type FROM land_sites');
  var areas = Array.from(new Set(rows.map(function(r){return r.area;}).filter(Boolean))).sort();
  var councils = Array.from(new Set(rows.map(function(r){return r.council;}).filter(Boolean))).sort();
  var types = Array.from(new Set(rows.map(function(r){return r.type;}).filter(Boolean))).sort();
  res.json({ areas: areas, councils: councils, types: types });
});

// Groups every letter sent (and every response, attributed the same way as the segment
// scorecard) into calendar years and year-quarters, so you can see whether response rate is
// trending up or down over time rather than just a single all-time figure.
function buildTimeBreakdown(sites) {
  var years = {}, quarters = {};
  function bump(bucket, key, field) {
    if (!bucket[key]) bucket[key] = { sent: 0, responded: 0 };
    bucket[key][field]++;
  }
  sites.forEach(function(s){
    var letters = [s.letter1_date, s.letter2_date, s.letter3_date, s.letter4_date];
    letters.forEach(function(d){
      if (!d) return;
      var year = d.slice(0,4);
      var q = 'Q' + (Math.floor((Number(d.slice(5,7))-1)/3)+1);
      bump(years, year, 'sent');
      bump(quarters, year+' '+q, 'sent');
    });
    var stage = attributedLetterStage(s);
    if (stage && s.response_date) {
      var ry = s.response_date.slice(0,4);
      var rq = 'Q' + (Math.floor((Number(s.response_date.slice(5,7))-1)/3)+1);
      bump(years, ry, 'responded');
      bump(quarters, ry+' '+rq, 'responded');
    }
  });
  function toRows(bucket) {
    return Object.keys(bucket).sort().map(function(k){
      var v = bucket[k];
      return { label: k, sent: v.sent, responded: v.responded, rate: v.sent>0 ? Math.round((v.responded/v.sent)*100) : null };
    });
  }
  return { annual: toRows(years), quarterly: toRows(quarters) };
}

app.get('/api/land/stats', auth, async function(req, res) {
  var all = await dbAll('SELECT * FROM land_sites');
  var cfg = await getLandSettings();
  var total = all.length;
  var letterCounts = { total: 0 };
  var responded = 0;
  var withFirstLetter = 0;
  var responseDays = [];
  var byArea = {}, byCouncil = {};
  all.forEach(function(s){
    var letters = [s.letter1_date, s.letter2_date, s.letter3_date, s.letter4_date].filter(Boolean);
    letterCounts.total += letters.length;
    if (letters.length > 0) withFirstLetter++;
    if (s.responded) {
      responded++;
      if (s.letter1_date && s.response_date) {
        var d = (new Date(s.response_date) - new Date(s.letter1_date)) / 86400000;
        if (!isNaN(d) && d >= 0) responseDays.push(d);
      }
    }
    if (s.area) byArea[s.area] = (byArea[s.area]||0) + 1;
    if (s.council) byCouncil[s.council] = (byCouncil[s.council]||0) + 1;
  });
  var overdueCount = all.filter(function(s){ return computeNextAction(s, cfg).overdue; }).length;
  var contactRate = withFirstLetter > 0 ? Math.round((responded / withFirstLetter) * 100) : 0;
  var avgDaysToResponse = responseDays.length ? Math.round((responseDays.reduce(function(a,b){return a+b;},0) / responseDays.length) * 10) / 10 : null;
  res.json({
    total: total,
    lettersSent: letterCounts.total,
    responded: responded,
    contactRate: contactRate,
    avgDaysToResponse: avgDaysToResponse,
    overdueCount: overdueCount,
    active: all.filter(function(s){return s.status==='active';}).length,
    interested: all.filter(function(s){return s.status==='interested';}).length,
    offerMade: all.filter(function(s){return s.status==='offer_made';}).length,
    offerRefused: all.filter(function(s){return s.status==='offer_refused';}).length,
    inLegals: all.filter(function(s){return s.status==='in_legals';}).length,
    dead: all.filter(function(s){return s.status==='dead';}).length,
    converted: all.filter(function(s){return s.status==='converted';}).length,
    byArea: byArea,
    byCouncil: byCouncil,
    scorecard: buildScorecard(all),
    timeBreakdown: buildTimeBreakdown(all)
  });
});

app.get('/api/land/export', auth, async function(req, res) {
  var sites=await dbAll('SELECT * FROM land_sites ORDER BY date_added DESC');
  var fields=['type','address','area','council','letter1_date','letter2_date','letter3_date','letter4_date','doorknock1_date','doorknock2_date','status','responded','response_date','outcome','notes','date_added'];
  var csv=new Parser({fields:fields}).parse(sites);
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename=land-sites.csv');
  res.send(csv);
});

// ---------- Site Calculator ----------
// List view only needs enough to show a card per saved appraisal — full inputs/outputs are
// fetched separately when actually opening one, since they can be sizeable JSON blobs.
app.get('/api/sitecalc', auth, async function(req, res) {
  var sql = 'SELECT id, name, site_type, outputs, date_added, date_updated, land_site_id FROM site_calcs';
  var params = [];
  if (req.query.land_site_id) { sql += ' WHERE land_site_id=?'; params.push(req.query.land_site_id); }
  sql += ' ORDER BY date_updated DESC';
  var rows = await dbAll(sql, params);
  var list = rows.map(function(r){
    var outputs = {};
    try { outputs = JSON.parse(r.outputs); } catch(e) {}
    return { id: r.id, name: r.name, site_type: r.site_type, outputs: outputs, date_added: r.date_added, date_updated: r.date_updated, land_site_id: r.land_site_id };
  });
  res.json({ calcs: list });
});

// Lightweight lookup for the Land tab: one appraisal summary per linked land_site_id, so each
// Land card can show its verdict without an extra round trip per site.
app.get('/api/sitecalc/by-land-site/all', auth, async function(req, res) {
  var rows = await dbAll('SELECT id, name, site_type, outputs, land_site_id FROM site_calcs WHERE land_site_id IS NOT NULL');
  var byLandSite = {};
  rows.forEach(function(r){
    var outputs = {};
    try { outputs = JSON.parse(r.outputs); } catch(e) {}
    byLandSite[r.land_site_id] = { id: r.id, name: r.name, site_type: r.site_type, outputs: outputs };
  });
  res.json(byLandSite);
});

app.get('/api/sitecalc/:id', auth, async function(req, res) {
  var row = await dbGet('SELECT * FROM site_calcs WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  var inputs = {}, outputs = {};
  try { inputs = JSON.parse(row.inputs); } catch(e) {}
  try { outputs = JSON.parse(row.outputs); } catch(e) {}
  res.json({ id: row.id, name: row.name, site_type: row.site_type, inputs: inputs, outputs: outputs, date_added: row.date_added, date_updated: row.date_updated, land_site_id: row.land_site_id });
});

app.post('/api/sitecalc', auth, async function(req, res) {
  var b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Name is required' });
  var now = new Date().toISOString().split('T')[0];
  var result = await dbRun(
    'INSERT INTO site_calcs (name, site_type, inputs, outputs, date_added, date_updated, land_site_id) VALUES (?,?,?,?,?,?,?)',
    [b.name, b.site_type||'', JSON.stringify(b.inputs||{}), JSON.stringify(b.outputs||{}), now, now, b.land_site_id||null]
  );
  res.json({ ok: true, id: result.lastID });
});

app.post('/api/sitecalc/:id', auth, async function(req, res) {
  var b = req.body || {};
  if (b.hasOwnProperty('name') && !b.name) return res.status(400).json({ error: 'Name cannot be empty' });
  var now = new Date().toISOString().split('T')[0];
  var sets = ['date_updated=?'], params = [now];
  if (b.hasOwnProperty('name')) { sets.push('name=?'); params.push(b.name); }
  if (b.hasOwnProperty('site_type')) { sets.push('site_type=?'); params.push(b.site_type); }
  if (b.hasOwnProperty('inputs')) { sets.push('inputs=?'); params.push(JSON.stringify(b.inputs)); }
  if (b.hasOwnProperty('outputs')) { sets.push('outputs=?'); params.push(JSON.stringify(b.outputs)); }
  if (b.hasOwnProperty('land_site_id')) { sets.push('land_site_id=?'); params.push(b.land_site_id||null); }
  params.push(req.params.id);
  await dbRun('UPDATE site_calcs SET '+sets.join(',')+' WHERE id=?', params);
  res.json({ ok: true });
});

app.post('/api/sitecalc/:id/duplicate', auth, async function(req, res) {
  var row = await dbGet('SELECT * FROM site_calcs WHERE id=?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  var now = new Date().toISOString().split('T')[0];
  var result = await dbRun(
    'INSERT INTO site_calcs (name, site_type, inputs, outputs, date_added, date_updated, land_site_id) VALUES (?,?,?,?,?,?,?)',
    [row.name + ' (copy)', row.site_type, row.inputs, row.outputs, now, now, row.land_site_id]
  );
  res.json({ ok: true, id: result.lastID });
});

app.delete('/api/sitecalc/:id', auth, async function(req, res) {
  await dbRun('DELETE FROM site_calcs WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

var DEFAULT_SETTINGS = {
  lpas: [
    { name: 'Elmbridge', url: 'https://emaps.elmbridge.gov.uk/ebc_planning.aspx?requesttype=parseTemplate&template=SimpleSearchTab.tmplt' },
    { name: 'Richmond', url: 'https://www.richmond.gov.uk/services/planning' },
    { name: 'Merton', url: 'https://www.merton.gov.uk/planning-and-buildings/planning' },
    { name: 'Mole Valley', url: 'https://www.molevalley.gov.uk/planning-building/search-planning-application/' },
    { name: 'Runnymede', url: 'https://planning.runnymede.gov.uk/Northgate/PlanningExplorer/Home.aspx' },
    { name: 'Hertsmere (Radlett)', url: 'https://www6.hertsmere.gov.uk/online-applications/' },
    { name: 'Barnet (Hadley Wood)', url: 'https://publicaccess.barnet.gov.uk/online-applications/' }
  ],
  costPsf: 250,
  chargePsf: 320,
  minProfit: 85000,
  templates: [
    { name: 'Extension — to homeowner', type: 'large_extension', recipient: 'homeowner', body: 'Dear {name},\n\n[Your extension letter to the homeowner goes here]\n\nKind regards,\n\nOliver Robinson\nCullinan Homes' },
    { name: 'New build — to homeowner', type: 'selfbuild', recipient: 'homeowner', body: 'Dear {name},\n\n[Your new build letter to the homeowner goes here]\n\nKind regards,\n\nOliver Robinson\nCullinan Homes' },
    { name: 'Extension — to architect', type: 'large_extension', recipient: 'agent', body: 'Dear {agent},\n\n[Your extension letter to the architect/agent goes here — regarding their application {ref} at {address}]\n\nKind regards,\n\nOliver Robinson\nCullinan Homes' },
    { name: 'New build — to architect', type: 'selfbuild', recipient: 'agent', body: 'Dear {agent},\n\n[Your new build letter to the architect/agent goes here — regarding their application {ref} at {address}]\n\nKind regards,\n\nOliver Robinson\nCullinan Homes' }
  ]
};

async function getSettings() {
  var row = await dbGet('SELECT value FROM settings WHERE key=?', ['config']);
  if (!row) return DEFAULT_SETTINGS;
  try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(row.value)); }
  catch(e) { return DEFAULT_SETTINGS; }
}

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

app.get('/api/settings', auth, async function(req, res) {
  res.json(await getSettings());
});

app.post('/api/settings', auth, async function(req, res) {
  var current = await getSettings();
  var updated = Object.assign({}, current, req.body);
  await dbRun('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['config', JSON.stringify(updated)]);
  res.json(updated);
});

app.post('/api/classify', auth, async function(req, res) {
  var text = req.body.text;
  var pdfBase64 = req.body.pdf_base64;
  var lpa = req.body.lpa || 'Unknown';
  var usingPdf = !!pdfBase64;
  if (!usingPdf && (!text || text.length < 50)) return res.status(400).json({ error: 'No text or PDF provided' });
  if (!API_KEY) return res.status(500).json({ error: 'No API key configured' });
  var cfg = await getSettings();
  var minProfit = Number(cfg.minProfit) || 85000;
  var costPsf = Number(cfg.costPsf) || 0;
  var chargePsf = Number(cfg.chargePsf) || 0;
  var marginPsf = chargePsf - costPsf;
  var canFilterByProfit = marginPsf > 0;
  var client = new Anthropic({ apiKey: API_KEY });
  // Note: we no longer ask the model to pre-filter by raw contract value — profit, not build
  // cost, is what determines whether a lead qualifies. The model extracts every genuine
  // residential development application it finds; we filter by estimated profit afterwards
  // once floor_area_sqft comes back, using your £/ft² cost and charge-out rates from Settings.
  var instructions = 'You are a property development lead qualifier for a design-and-build contractor covering Surrey, SW London, Hertfordshire and North London. We deliver cost-plus construction projects.\n\nExtract every genuine residential development planning application from the ' + (usingPdf ? 'attached PDF (this is a council weekly/monthly list of planning applications)' : 'text') + ' and return a JSON array. Include extensions, self-builds, lofts, conversions and similar — exclude trivial items with no real construction scope (e.g. tree works, advertising consent, listed building consent for minor internal changes, certificates of lawfulness with no works).\n\nFor each return:\n- ref: application reference number\n- address: full site address\n- postcode: postcode if visible\n- applicant: applicant name if visible else empty string\n- applicant_address: the correspondence address of the applicant if explicitly shown in the text, else empty string. IMPORTANT: only use an address clearly belonging to the applicant. Do NOT use the agent or architect address. Do NOT repeat the site address.\n- agent: architect or agent name if visible else empty string\n- agent_address: the address of the agent or architect if shown in the text, else empty string\n- description: full description of works\n- app_type: large_extension or selfbuild or conversion or loft_complex or other\n- is_new_application: true if new application false if amendment\n- date_submitted: date if visible, formatted strictly as YYYY-MM-DD (convert whatever format appears in the text)\n- contract_value_min: integer GBP. Use: loft=100000, single-storey extension=120000, two-storey extension=180000, basement=300000, self-build house=550000, conversion to flats=300000, pool add 100000\n- contract_value_max: integer GBP\n- floor_area_sqft: integer, estimated NEW or altered internal floor area in square feet based on the description. Guide: rear dormer loft conversion=300, hip-to-gable loft=400, single-storey rear extension=300, wraparound extension=450, two-storey extension=650, basement=800, new detached house=2200, new bungalow=1400, conversion of house to 2 flats=1600, garage conversion=200. Scale up or down using any dimensions or number of bedrooms mentioned. Use 0 only if genuinely impossible to estimate.\n- planning_likelihood: integer 0-100\n- planning_notes: one sentence\n- priority_score: integer 0-100, higher if no agent, self-build, large scope, premium area\n- no_agent: 1 if no agent listed else 0\n- signals: array of 3 short strings\n\nCouncil: ' + lpa + (usingPdf ? '' : '\n\nText:\n' + text.slice(0, 9000)) + '\n\nReturn ONLY a valid JSON array. No markdown. No explanation.';
  var userContent = usingPdf
    ? [ { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } }, { type: 'text', text: instructions } ]
    : instructions;
  try {
    var response = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'user', content: userContent }] });
    var raw = response.content[0].text.replace(/```json|```/g, '').trim();
    var leads = JSON.parse(raw);
    var warning = null;
    if (canFilterByProfit) {
      leads = leads.filter(function(l) { return ((Number(l.floor_area_sqft) || 0) * marginPsf) >= minProfit; });
    } else {
      warning = 'Set your Build cost £/ft² and Charge-out £/ft² in Settings to filter by profit — showing all qualifying leads unfiltered for now.';
    }
    res.json({ leads: leads, warning: warning });
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
        'INSERT OR IGNORE INTO leads (ref,lpa,address,postcode,applicant,agent,description,date_submitted,date_scraped,app_type,is_new_application,contract_value_min,contract_value_max,floor_area_sqft,planning_likelihood,planning_notes,priority_score,no_agent,signals,portal_url,contact_name,contact_address,agent_address) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [l.ref||l.address,l.lpa,l.address||'',l.postcode||'',l.applicant||'',l.agent||'',l.description||'',l.date_submitted||'',now,l.app_type||'other',l.is_new_application?1:0,l.contract_value_min||0,l.contract_value_max||0,l.floor_area_sqft||0,l.planning_likelihood||0,l.planning_notes||'',l.priority_score||0,l.no_agent||0,JSON.stringify(l.signals||[]),l.portal_url||'',l.applicant||'',l.applicant_address||'',l.agent_address||'']
      );
      if (result.changes) saved++;
    } catch(e) { console.error('Save error:', e.message); }
  }
  res.json({ saved: saved });
});

app.get('/api/leads', auth, async function(req, res) {
  var lpa=req.query.lpa, type=req.query.type, sort=req.query.sort, search=req.query.search, stage=req.query.stage;
  var view=req.query.view||'active';
  var page=Number(req.query.page)||1, limit=Number(req.query.limit)||50;
  var sql='SELECT * FROM leads WHERE 1=1';
  var params=[];
  if (view==='active'){sql+=' AND (archived IS NULL OR archived=0) AND (contacted IS NULL OR contacted=0)';}
  else if (view==='contacted'){sql+=' AND contacted=1 AND (archived IS NULL OR archived=0)';}
  else if (view==='archived'){sql+=' AND archived=1';}
  if (stage&&stage!=='all'){sql+=' AND stage=?';params.push(stage);}
  if (lpa&&lpa!=='all'){sql+=' AND lpa=?';params.push(lpa);}
  if (type&&type!=='all'){sql+=' AND app_type=?';params.push(type);}
  if (search){sql+=' AND (address LIKE ? OR description LIKE ? OR applicant LIKE ?)';params.push('%'+search+'%','%'+search+'%','%'+search+'%');}
  sql+=sort==='value'?' ORDER BY contract_value_max DESC':sort==='planning'?' ORDER BY planning_likelihood DESC':sort==='score'?' ORDER BY priority_score DESC':sort==='contactedDate'?' ORDER BY contacted_date DESC':' ORDER BY date_scraped DESC, date_submitted DESC';
  sql+=' LIMIT ? OFFSET ?';
  params.push(limit,(page-1)*limit);
  var leads=await dbAll(sql,params);
  var countSql='SELECT COUNT(*) as n FROM leads WHERE 1=1';
  var countParams=[];
  if (view==='active'){countSql+=' AND (archived IS NULL OR archived=0) AND (contacted IS NULL OR contacted=0)';}
  else if (view==='contacted'){countSql+=' AND contacted=1 AND (archived IS NULL OR archived=0)';}
  else if (view==='archived'){countSql+=' AND archived=1';}
  if (stage&&stage!=='all'){countSql+=' AND stage=?';countParams.push(stage);}
  if (lpa&&lpa!=='all'){countSql+=' AND lpa=?';countParams.push(lpa);}
  if (type&&type!=='all'){countSql+=' AND app_type=?';countParams.push(type);}
  if (search){countSql+=' AND (address LIKE ? OR description LIKE ? OR applicant LIKE ?)';countParams.push('%'+search+'%','%'+search+'%','%'+search+'%');}
  var countRow=await dbGet(countSql,countParams);
  res.json({leads:leads.map(function(l){return Object.assign({},l,{signals:JSON.parse(l.signals||'[]')});}),total:countRow.n});
});

app.get('/api/stats', auth, async function(req, res) {
  var total=(await dbGet('SELECT COUNT(*) as n FROM leads WHERE (archived IS NULL OR archived=0)')).n;
  var thisWeek=(await dbGet("SELECT COUNT(*) as n FROM leads WHERE date_scraped >= date('now','-7 days') AND (archived IS NULL OR archived=0)")).n;
  var noAgent=(await dbGet('SELECT COUNT(*) as n FROM leads WHERE no_agent=1 AND (archived IS NULL OR archived=0)')).n;
  var pipeline=(await dbGet('SELECT SUM(contract_value_max) as v FROM leads WHERE (archived IS NULL OR archived=0)')).v||0;
  var archived=(await dbGet('SELECT COUNT(*) as n FROM leads WHERE archived=1')).n;
  var contacted=(await dbGet('SELECT COUNT(*) as n FROM leads WHERE contacted=1 AND (archived IS NULL OR archived=0)')).n;
  var contactRate=total>0?Math.round((contacted/total)*100):0;
  var avgRow=await dbGet("SELECT AVG(julianday(contacted_date) - julianday(date_scraped)) as d FROM leads WHERE contacted=1 AND contacted_date IS NOT NULL AND contacted_date!='' AND date_scraped IS NOT NULL AND date_scraped!=''");
  var avgDaysToContact=(avgRow&&avgRow.d!=null)?Math.round(avgRow.d*10)/10:null;
  var stageRows=await dbAll("SELECT stage, COUNT(*) as n FROM leads WHERE (archived IS NULL OR archived=0) AND stage!='new' GROUP BY stage");
  var stageCounts={contacted:0,interested:0,quoted:0,won:0,lost:0};
  stageRows.forEach(function(r){ if(stageCounts.hasOwnProperty(r.stage))stageCounts[r.stage]=r.n; });
  var winRate=(stageCounts.won+stageCounts.lost)>0?Math.round(stageCounts.won/(stageCounts.won+stageCounts.lost)*100):null;
  res.json({total:total,thisWeek:thisWeek,noAgent:noAgent,pipeline:pipeline,archived:archived,contacted:contacted,contactRate:contactRate,avgDaysToContact:avgDaysToContact,stageCounts:stageCounts,winRate:winRate});
});

app.post('/api/leads/:id/contact', auth, async function(req, res) {
  var contacted = req.body.contacted===false ? 0 : 1;
  if (contacted) {
    var date = req.body.contacted_date || new Date().toISOString().split('T')[0];
    await dbRun("UPDATE leads SET contacted=1, contacted_date=?, notes=?, stage=CASE WHEN stage IS NULL OR stage='new' THEN 'contacted' ELSE stage END, stage_date=CASE WHEN stage IS NULL OR stage='new' THEN ? ELSE stage_date END WHERE id=?",[date, req.body.notes||'', date, req.params.id]);
  } else {
    await dbRun("UPDATE leads SET contacted=0, contacted_date='', stage='new', stage_date='', lost_reason='' WHERE id=?",[req.params.id]);
  }
  res.json({ok:true});
});

var VALID_STAGES = ['contacted','interested','quoted','won','lost'];
app.post('/api/leads/:id/stage', auth, async function(req, res) {
  var stage = req.body.stage;
  if (VALID_STAGES.indexOf(stage) === -1) return res.status(400).json({ error: 'Invalid stage' });
  var today = new Date().toISOString().split('T')[0];
  var lostReason = stage === 'lost' ? (req.body.lost_reason || '') : '';
  // Also backfill contacted/contacted_date in case a lead is somehow moved to a later
  // stage without ever going through the contact endpoint first.
  await dbRun("UPDATE leads SET stage=?, stage_date=?, lost_reason=?, contacted=1, contacted_date=CASE WHEN contacted_date IS NULL OR contacted_date='' THEN ? ELSE contacted_date END WHERE id=?",[stage, today, lostReason, today, req.params.id]);
  res.json({ok:true});
});

app.post('/api/leads/:id/archive', auth, async function(req, res) {
  var flag = req.body.archived ? 1 : 0;
  await dbRun('UPDATE leads SET archived=? WHERE id=?',[flag, req.params.id]);
  res.json({ok:true});
});

app.post('/api/leads/:id/area', auth, async function(req, res) {
  var area = Number(req.body.floor_area_sqft) || 0;
  await dbRun('UPDATE leads SET floor_area_sqft=? WHERE id=?',[area, req.params.id]);
  res.json({ok:true});
});

app.post('/api/leads/:id/contact-details', auth, async function(req, res) {
  await dbRun('UPDATE leads SET contact_name=?, contact_address=? WHERE id=?',
    [req.body.contact_name||'', req.body.contact_address||'', req.params.id]);
  res.json({ok:true});
});

app.get('/api/export', auth, async function(req, res) {
  var leads=await dbAll('SELECT * FROM leads ORDER BY date_submitted DESC');
  var fields=['lpa','address','postcode','applicant','agent','description','app_type','contract_value_min','contract_value_max','floor_area_sqft','planning_likelihood','planning_notes','priority_score','no_agent','date_submitted','ref','contact_name','contact_address','agent_address','contacted','contacted_date','stage','stage_date','lost_reason','archived','notes'];
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
  var prompt = 'Write a short, professional and warm outreach letter from Cullinan Homes to the following planning applicant. We are a local design-and-build contractor offering a cost-plus service — we handle everything from design through to completion, taking the stress out of the project for the owner.\n\nApplicant name: ' + (lead.contact_name || lead.applicant || 'the homeowner') + '\nProperty address: ' + (lead.address || '') + '\nCorrespondence address if different: ' + (lead.contact_address || 'same as property') + '\nDescription of works: ' + (lead.description || '') + '\nProject type: ' + (lead.app_type || '') + '\nEstimated contract value: ' + (lead.contract_value_min ? '£' + Math.round(lead.contract_value_min/1000) + 'k - £' + Math.round(lead.contract_value_max/1000) + 'k' : 'substantial') + '\n\nThe letter should:\n- Be addressed personally if we have a name, otherwise "Dear Homeowner"\n- Reference their specific project naturally\n- Explain what cost-plus means briefly\n- Be concise — 3 short paragraphs maximum\n- End with a clear call to action — a phone call or site visit\n- Be signed off from Oliver Robinson, Cullinan Homes\n- Sound human and local, not like a template\n\nReturn only the letter text, no subject line, no explanation.';
  try {
    var response = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: prompt }] });
    res.json({ letter: response.content[0].text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(function(req, res) { res.sendFile(path.join(__dirname, '../public/index.html')); });

app.listen(PORT, function() { console.log('Cullinan Home Hub running on port ' + PORT); });

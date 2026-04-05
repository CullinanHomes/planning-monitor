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

const dbPath = process.env.DB_PATH || '/data/leads.db';
const db = new sqlite3.Database(dbPath);
const dbRun = (sql, params=[]) => new Promise((res,rej) => db.run(sql, params, function(err){ if(err) rej(err); else res(this); }));
const dbGet = (sql, params=[]) => new Promise((res,rej) => db.get(sql, params, (err,row) => err ? rej(err) : res(row)));
const dbAll = (sql, params=[]) => new Promise((res,rej) => db.all(sql, params, (err,rows) => err ? rej(err) : res(rows)));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE, lpa TEXT, address TEXT, applicant TEXT, agent TEXT, description TEXT, date_submitted TEXT, date_scraped TEXT, app_type TEXT, est_value_min INTEGER, est_value_max INTEGER, priority_score INTEGER, no_agent INTEGER, signals TEXT, land_registry_url TEXT, portal_url TEXT, contacted INTEGER DEFAULT 0, notes TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS scrape_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ran_at TEXT, lpa TEXT, found INTEGER, qualified INTEGER, error TEXT)`);
});

async function scrapeElmbridge() {
  const results = [];
  try {
    const { data } = await axios.get('https://publicaccess.elmbridge.gov.uk/online-applications/search.do?action=weeklyList&searchType=Application', { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(data);
    $('li.searchresult').each((_, el) => {
      const ref = $(el).find('.reference').text().trim();
      const address = $(el).find('.address').text().trim();

app.listen(PORT, () => console.log(`Planning monitor running on port ${PORT}`));

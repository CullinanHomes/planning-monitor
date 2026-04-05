# Planning Lead Monitor — Deployment Guide

## What this does
Automatically scans Elmbridge, Richmond, and Merton planning portals every morning at 7am.
Classifies each application using AI, estimates project value, and flags high-priority leads.
You log in to a web dashboard to review leads, mark contacts, and export to CSV.

---

## Step 1 — Get a free GitHub account
1. Go to **github.com** and click "Sign up"
2. Create a free account with your email

---

## Step 2 — Upload the code to GitHub
1. Once logged in, click the **+** icon (top right) → "New repository"
2. Name it `planning-monitor`, set to **Private**, click "Create repository"
3. On the next screen, click **"uploading an existing file"**
4. Upload ALL the files from the folder you downloaded (drag and drop the whole folder)
5. Click "Commit changes"

---

## Step 3 — Deploy on Railway (free hosting)
1. Go to **railway.app** and click "Start a New Project"
2. Sign in with your GitHub account (click "Login with GitHub")
3. Click **"Deploy from GitHub repo"**
4. Select your `planning-monitor` repository
5. Railway will automatically detect the settings and start deploying
6. Wait about 2 minutes for it to build (you'll see a progress bar)

---

## Step 4 — Add your environment variables
Once deployed, click on your project in Railway, then:
1. Click the **"Variables"** tab
2. Add these three variables one by one:

| Variable name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key (from console.anthropic.com) |
| `DASHBOARD_PASSWORD` | Choose a password, e.g. `leads2025` |
| `DB_PATH` | `/data/leads.db` |

3. Click "Add" after each one
4. Railway will automatically restart with the new settings

---

## Step 5 — Get your dashboard URL
1. In Railway, click the **"Settings"** tab
2. Under "Domains", click "Generate Domain"
3. You'll get a URL like `planning-monitor-production.up.railway.app`
4. Bookmark this — it's your daily dashboard

---

## Step 6 — Log in
1. Visit your Railway URL
2. Enter the password you set in Step 4
3. You're in — click "Run scan now" to pull your first batch of leads

---

## Daily use
- The app scans automatically every morning at **7am**
- Log in any time to see new leads
- Click **"Export CSV"** to download all leads to Excel
- Click **"Mark contacted"** on any lead you've reached out to
- Click **"View application"** to go directly to the planning portal
- Click **"Land Registry"** to look up the owner

---

## Getting your Anthropic API key
1. Go to **console.anthropic.com**
2. Sign up for a free account
3. Click "API Keys" in the left menu
4. Click "Create Key", give it a name, copy it
5. Paste it into Railway as `ANTHROPIC_API_KEY`

The AI classification costs roughly **£2–5 per month** at typical usage volumes.

---

## Adding more councils later
Just message Claude: *"Add [council name] to my planning monitor"* and it will give you the updated scraper code to drop in.

---

## Troubleshooting
**No leads appearing:** Click "Run scan now" — the portals may have changed their layout slightly. The scraper can be updated easily.
**Can't log in:** Check your `DASHBOARD_PASSWORD` variable in Railway matches what you're typing.
**Errors in Railway logs:** Share the error message and Claude can fix it.

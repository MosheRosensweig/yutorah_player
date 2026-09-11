# 💾 Database Backup & Disaster Recovery Guide

This guide explains how to back up and restore the YUTorah Player database (**Cloudflare D1** — serverless SQLite).

---

## 📌 Executive Summary

- **Database Engine**: Cloudflare D1 (`yutorah-db`, Database ID: `5fa90562-b1fa-40f4-b258-efcba6c3b6bf`)
- **What is stored**:
  1. `users`: Google OAuth user accounts, email, names, profile photos, timestamps.
  2. `listening_history`: Listened shiurim, resume timestamps, duration progress, listen count.
  3. `playlist_items`: Personal playlists, favorites, save for later, and play queue items.
  4. `public_playlists`: Published community playlists, titles, descriptions, curated tags.
  5. `public_playlist_items`: Shiurim and series attached to public playlists.
  6. `playlist_saves`: Records of users who followed or saved public playlists.
- **Is your data safe by default?**
  Yes! Cloudflare D1 automatically creates continuous internal snapshots and transaction logs. However, keeping independent off-site `.sql` backups guarantees you never lose user playlists or listening history under any circumstance.

---

## 🛠️ Step-by-Step Manual Backup ("For Dummies")

You can export a complete, self-contained SQL file of the entire remote database to your computer in **under 15 seconds**.

### Step 1: Open Your Terminal
Open the Terminal application on your Mac, and navigate to the project directory:
```bash
cd /Users/mosherosensweig/git/yutorah_player
```

### Step 2: Create a Backups Directory
*(Only needed the first time)*
```bash
mkdir -p backups
```

### Step 3: Run the Export Command
Run this exact single command:
```bash
npx wrangler d1 export yutorah-db --remote --output ./backups/yutorah-db-backup-$(date +%Y%m%d).sql
```

### Step 4: Verify Your Backup
Check that the backup file was created and contains data:
```bash
ls -lh backups/
head -n 25 backups/yutorah-db-backup-*.sql
```
You will see standard SQLite SQL statements (`CREATE TABLE`, `INSERT INTO users`, `INSERT INTO listening_history`, etc.).

---

## 🚨 How to Restore ("Disaster Recovery")

If accidental data deletion occurs, or if you want to restore the database to a previous point in time:

### Step 1: (Recommended) Export a Safety Snapshot of Current State
```bash
npx wrangler d1 export yutorah-db --remote --output ./backups/pre-restore-snapshot-$(date +%Y%m%d%H%M).sql
```

### Step 2: Execute the Backup File Against Remote D1
```bash
npx wrangler d1 execute yutorah-db --remote --file ./backups/yutorah-db-backup-20260910.sql
```
*Note: If restoring into a clean slate or resetting tables, execute the schema migrations first (`npx wrangler d1 migrations apply yutorah-db --remote`), then execute the SQL insert script.*

---

## 📅 How Often Should You Back Up?

| Event / Cadence | Action | Why |
| :--- | :--- | :--- |
| **Before Major Deployments** | Manual Export | Protects data before database schema migrations or breaking backend changes. |
| **Weekly** | Automated Cron | Captures newly created user playlists and listening history. |
| **Monthly** | Cold Storage Archive | Copy latest `.sql` to Google Drive, iCloud Drive, or an external drive for redundancy. |

---

## 🤖 100% Free & Easy Automation

### Method A: Automated GitHub Actions (Recommended & 100% Free)

You can configure GitHub Actions to back up your database automatically every Sunday at 3:00 AM UTC and upload the compressed backup as an encrypted artifact.

#### 1. Add Secrets to Your GitHub Repository:
Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions**:
- `CLOUDFLARE_API_TOKEN`: Your Cloudflare API Token (with D1 edit/read permissions).
- `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare Account ID.

#### 2. Create the GitHub Workflow:
Create `.github/workflows/backup-d1.yml`:
```yaml
name: Automated D1 Database Backup

on:
  schedule:
    - cron: '0 3 * * 0' # Every Sunday at 3:00 AM UTC
  workflow_dispatch:      # Allows manual trigger button in GitHub UI

jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install Wrangler
        run: npm install -g wrangler

      - name: Export D1 Database
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          mkdir -p backups
          npx wrangler d1 export yutorah-db --remote --output ./backups/yutorah-db-$(date +%Y%m%d).sql
          gzip ./backups/*.sql

      - name: Upload Backup Artifact
        uses: actions/upload-artifact@v4
        with:
          name: d1-database-backup-${{ github.run_id }}
          path: ./backups/*.sql.gz
          retention-days: 90
```

---

### Method B: Cloudflare Point-in-Time Recovery (Built-In)

Cloudflare D1 provides automated internal storage redundancy. If an infrastructure incident occurs, Cloudflare support can roll back the database instance to any transaction point. However, **Method A (GitHub Actions) or Manual Export** is strongly recommended because you personally hold the `.sql` data files independently of Cloudflare.

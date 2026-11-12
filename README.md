# Neuroscience 2026 — WashU Department of Neuroscience

A static one-page schedule of WashU involvement at [SfN Neuroscience 2026](https://www.sfn.org/meetings/neuroscience-2026). Built for DoN faculty: filters, What's next, WashU PIs (timeline/cards), and At a glance.

The page loads JSON from `data/` at runtime. Refreshing the data means replacing those files (see [DATA_CONTRACT.md](DATA_CONTRACT.md) and [data/README.md](data/README.md)).

## Local preview

Browsers block `fetch` from `file://`, so serve the folder:

```bash
python3 -m http.server 8000
```

Then open http://127.0.0.1:8000

## Deploy to GitHub Pages

This repo is ready to publish from the site root (no build step). Paths are relative, and `.nojekyll` keeps GitHub from running Jekyll on the files.

1. Create a GitHub repository and push this project:

   ```bash
   git remote add origin git@github.com:YOUR_ORG/YOUR_REPO.git
   git push -u origin main
   ```

2. In the repo on GitHub: **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Choose branch **main** and folder **/ (root)**, then Save.

The site will be at `https://YOUR_ORG.github.io/YOUR_REPO/` (or a custom domain if you add one).

If the repo name is not the site root you want, or you use a project pages URL with a subpath, the current relative asset paths already work under a subpath.

## Project layout

| Path | Role |
| --- | --- |
| `index.html` | Page shell |
| `css/`, `js/` | Styles and client logic |
| `data/*.json` | Schedule data the page reads |
| `data/harvest.py` | Offline scraper / rebuild tooling |
| `DATA_CONTRACT.md` | Fields the page depends on |

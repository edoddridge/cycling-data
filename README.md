# Cycling Transit Dashboard

Interactive dashboard for annual cycling count data (Super Tuesday and Super Sunday) with:

- a map layer of count locations
- marker clustering and search by `site_id` / council
- click-through location detail
- intersection inset using `layout_n` and `layout_n_enter` azimuth schema, with zoomable map background
- time-series chart modes:
  - one-day evolution (intra-day bins)
  - trend between years (with gaps shown)

## Data sources

- `data/cycling/ST_all_index PBI 2010-2025 Download.xlsx`
- `data/cycling/SS_all_index PBI 2010-2024 Download.xlsx`
- `data/cycling/Data attribute table.pdf`

The dashboard now loads preprocessed JSON from `data/processed/` for faster startup. The preprocessing step reads workbook headers from row 2 and uses the field definitions in the PDF attribute table.

## Preprocess the data

Run:

```bash
/opt/miniconda3/bin/python scripts/preprocess_cycling_data.py
```

This generates:

- `data/processed/st.json`
- `data/processed/ss.json`
- `data/processed/index.json`

## Run locally

From the repository root:

```bash
/opt/miniconda3/bin/python scripts/preprocess_cycling_data.py
python3 -m http.server 8000
```

Then open:

- <http://localhost:8000>

## Deploy to GitHub Pages

This repository includes a GitHub Actions workflow at `.github/workflows/deploy-pages.yml` that publishes the dashboard to GitHub Pages on every push to `main`.

One-time setup in GitHub:

1. Open repository **Settings** -> **Pages**.
2. Under **Build and deployment**, select **Source: GitHub Actions**.
3. Ensure your default branch is `main` (or update the workflow branch trigger if different).

Deploy flow:

1. Regenerate processed data and commit it:

```bash
/opt/miniconda3/bin/python scripts/preprocess_cycling_data.py
git add data/processed .github/workflows/deploy-pages.yml .nojekyll README.md
git commit -m "Configure GitHub Pages deployment"
git push
```

2. Wait for the **Deploy Dashboard To GitHub Pages** workflow to complete.
3. Open the published URL shown in the workflow summary (also listed under **Settings** -> **Pages**).

## How to use

1. Use **Map Layer** to filter sites by dataset.
2. Use **Find Site** to jump to a site by `site_id` or council name.
3. Click a map marker to open site details.
4. Adjust **Inset zoom** to change the background map scale.
3. In **Time Series**, switch between:
   - **One-day evolution** for time bins within a selected count date
   - **Trend between years** for annual totals
5. Review the **Intersection Inset** to interpret leg labels and azimuth directions.

## Tests

Run parsing tests with:

```bash
/opt/miniconda3/bin/python -m unittest tests.test_preprocess
```

## Notes

- ST trends use `total_thisyear`.
- SS trends use `total`.
- Missing years are shown as gaps in the year trend chart.

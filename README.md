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

The additional downloaded-data view is available at:

- <http://localhost:8000/other-data.html>

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

1. The Other Data dashboard now runs on a single **Active layer** (Tasman Bridge + Sydney bicycle surveys + Melbourne cycling network).
2. Use **Find Site** to jump to a site by `site_id` or council name.
3. Click a map marker to open site details.
4. Adjust **Inset zoom** to change the background map scale.
3. In **Time Series**, switch between:
   - **One-day evolution** for time bins within a selected count date
   - **Trend between years** for annual totals
5. Review the **Intersection Inset** to interpret leg labels and azimuth directions.

## Archived experimental work

Experimental network-analysis work has been removed from the published main dashboard.

- Archive branch: `feature/experimental-network-archive`
- Archive tag: `experimental-v1-archive`

To restore or continue the experimental page later, check out the archive branch or tag and cherry-pick as needed.

## Tests

Run parsing tests with:

```bash
/opt/miniconda3/bin/python -m unittest tests.test_preprocess
```

## Download Drakewell daily time series

Use `scripts/download_drakewell_timeseries.py` to download multi-day exports from Drakewell and build a consolidated time-series CSV.

The script is designed to be robust when there are missing dates or partial coverage:

- retries transient HTTP failures
- archives raw daily exports (`raw/YYYY-MM-DD.xls`)
- logs each day as `ok`, `gap`, or `error`
- continues processing even when some dates fail or have no time-bin rows

Example for the Tasman Bridge shared path site:

```bash
/opt/miniconda3/bin/python scripts/download_drakewell_timeseries.py \
  --node TAS_ACTIVE \
  --cosit 00A0113113AT \
  --start-date 2023-09-01 \
  --end-date 2026-05-02
```

Melbourne bicycle detector ZIP files can be aggregated into a dashboard-ready network timeseries with:

```bash
/opt/miniconda3/bin/python scripts/process_melbourne_cycling_data.py
```

Sydney bicycle survey data can be pulled from ArcGIS and converted into active-layer timeseries with:

```bash
/opt/miniconda3/bin/python scripts/process_sydney_cycling_data.py
```

By default, Melbourne events are aggregated to **60-minute bins** and exported as **All directions** totals for browser performance. You can change bin size with `--bin-minutes` (must divide 60), and include per-direction rows with `--include-directional` if needed.

Outputs are written to:

- `data/external/drakewell/TAS_ACTIVE/00A0113113AT/timeseries.csv`
- `data/external/drakewell/TAS_ACTIVE/00A0113113AT/download_log.csv`
- `data/external/drakewell/TAS_ACTIVE/00A0113113AT/raw/`
- `data/external/Sydney/processed/sydney_active_timeseries.csv`
- `data/external/Melbourne/processed/melbourne_network_timeseries.csv`

Useful options:

- `--skip-existing`: reuse previously downloaded raw files
- `--sleep-seconds`: throttle request rate
- `--retries` and `--backoff-seconds`: tune retry behavior

## Notes

- ST trends use `total_thisyear`.
- SS trends use `total`.
- Missing years are shown as gaps in the year trend chart.

const APP_MODE = new URL(import.meta.url).searchParams.get("mode") || "main";

function getDatasets() {
  if (APP_MODE === "other") {
    return [
      {
        id: "other_active",
        name: "Drakewell Tasman Bridge Shared Path",
        source: "drakewell",
        profile: "active_cycling",
        file: "data/external/drakewell/TAS_ACTIVE/00A0113113AT/timeseries.csv",
        color: "#1d3557",
        markerColor: "#457b9d"
      },
      {
        id: "other_active",
        name: "Sydney Bicycle Count Surveys",
        source: "drakewell",
        profile: "sydney_active",
        file: "data/external/Sydney/processed/sydney_active_timeseries.csv",
        color: "#0b6e4f",
        markerColor: "#1f9d72"
      },
      {
        id: "other_active",
        name: "Melbourne Bicycle Network",
        source: "drakewell",
        profile: "melbourne_cycling",
        file: "data/external/Melbourne/processed/melbourne_network_timeseries.csv",
        color: "#2f6f4e",
        markerColor: "#5aa469"
      }
    ];
  }

  return [
    {
      id: "st",
      name: "Super Tuesday (Commuter)",
      file: "data/processed/st.json",
      color: "#005f73",
      markerColor: "#00b4d8"
    },
    {
      id: "ss",
      name: "Super Sunday (Recreation)",
      file: "data/processed/ss.json",
      color: "#bc6c25",
      markerColor: "#ff9f1c"
    }
  ];
}

const DATASETS = getDatasets();

const appState = {
  sites: new Map(),
  markerByKey: new Map(),
  searchLookup: new Map(),
  selectedMarkerKey: null,
  selectedSite: null,
  chartMode: "day",
  otherSeriesMode: "daily",
  splitMode: false,
  splitPath: false,
  splitDirection: false,
  splitUserType: false,
  splitWeekpart: false,
  splitSeason: false,
  smoothSeries: false,
  smoothWindowMinutes: 30,
  splitGender: false,
  insetRenderToken: 0,
  insetZoom: 16,
  statsVolumeMode: "summed",
  statsDataset: "all",
  statsCity: "all"
};

const IS_OTHER_MODE = APP_MODE === "other";

const insetTileCache = new Map();

const map = L.map("map", {
  zoomControl: true,
  preferCanvas: true
}).setView([-33.87, 151.21], 10);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

const markerLayer = L.markerClusterGroup({
  showCoverageOnHover: false,
  spiderfyOnMaxZoom: true,
  maxClusterRadius: 52
}).addTo(map);

const statusBanner = document.getElementById("status-banner");
const datasetFilter = document.getElementById("dataset-filter");
const siteSearch = document.getElementById("site-search");
const siteSearchOptions = document.getElementById("site-search-options");
const siteSearchButton = document.getElementById("site-search-button");
const emptyState = document.getElementById("empty-state");
const detailState = document.getElementById("detail-state");
const siteTitle = document.getElementById("site-title");
const siteChip = document.getElementById("site-chip");
const siteMeta = document.getElementById("site-meta");
const insetNote = document.getElementById("inset-note");
const insetZoom = document.getElementById("inset-zoom");
const insetZoomValue = document.getElementById("inset-zoom-value");
const dateSelect = document.getElementById("date-select");
const dateSelectWrap = document.getElementById("date-select-wrap");
const directionalSummary = document.getElementById("directional-summary");
const directionalChart = document.getElementById("directional-chart");
const directionalMatrix = document.getElementById("directional-matrix");
const statsCityFilter = document.getElementById("stats-city-filter");
const statsVolumeMode = document.getElementById("stats-volume-mode");
const statsScope = document.getElementById("stats-scope");
const statsGrid = document.getElementById("stats-grid");
const statsNotes = document.getElementById("stats-notes");
const statsTrendVolume = document.getElementById("stats-trend-volume");
const splitModeInput = document.getElementById("split-mode");
const splitPathInput = document.getElementById("split-path");
const splitDirectionInput = document.getElementById("split-direction");
const splitUserTypeInput = document.getElementById("split-user-type");
const splitWeekpartInput = document.getElementById("split-weekpart");
const splitSeasonInput = document.getElementById("split-season");
const smoothSeriesInput = document.getElementById("smooth-series");
const smoothWindowInput = document.getElementById("smooth-window");
const splitGenderInput = document.getElementById("split-gender");
const otherSeriesModeInput = document.getElementById("other-series-mode");
const chartElement = document.getElementById("chart");
const chartModeInputs = document.querySelectorAll("input[name='chart-mode']");

function setStatus(text, isHidden = false) {
  statusBanner.textContent = text;
  statusBanner.classList.toggle("hidden", isHidden);
}

function parseDate(value) {
  if (!value || value === "unknown") {
    return null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateLabel(date) {
  if (!date) {
    return "Unknown date";
  }
  return date.toLocaleDateString("en-AU", {
    year: "numeric",
    month: "short",
    day: "2-digit"
  });
}

function percentile(values, fraction) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[idx];
}

function formatNumber(value, digits = 0) {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }
  return value.toLocaleString("en-AU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function aggregateYearlyTotals(records) {
  const grouped = new Map();
  records.forEach((record) => {
    if (!record.year || record.total == null) {
      return;
    }
    if (!grouped.has(record.year)) {
      grouped.set(record.year, []);
    }
    grouped.get(record.year).push(record.total);
  });
  return grouped;
}

function averageHourlySeries(records) {
  const grouped = new Map();
  records.forEach((record) => {
    (record.hourly || []).forEach((point) => {
      if (point.value == null) {
        return;
      }
      if (!grouped.has(point.time)) {
        grouped.set(point.time, []);
      }
      grouped.get(point.time).push(point.value);
    });
  });

  return [...grouped.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([time, values]) => ({
      time,
      value: Number((values.reduce((sum, current) => sum + current, 0) / values.length).toFixed(2))
    }));
}

function averageCategoryValues(records, definitions) {
  return definitions.map((definition) => {
    const values = records
      .map((record) => record.categories?.[definition.id])
      .filter((value) => value != null);

    return {
      ...definition,
      value: values.length === 0
        ? null
        : Number((values.reduce((sum, current) => sum + current, 0) / values.length).toFixed(2))
    };
  });
}

function categoryYearlySeries(records, definitions) {
  return definitions.map((definition) => {
    const grouped = new Map();
    records.forEach((record) => {
      const value = record.categories?.[definition.id];
      if (!record.year || value == null) {
        return;
      }
      if (!grouped.has(record.year)) {
        grouped.set(record.year, []);
      }
      grouped.get(record.year).push(value);
    });

    return {
      ...definition,
      valuesByYear: grouped
    };
  });
}

function categoryVisualStyle(definition) {
  const id = definition.id || "";

  const symbol = id.includes("women")
    ? "square"
    : id.includes("men")
      ? "circle"
      : "diamond";

  const dash = id.includes("ebike")
    ? "dash"
    : (id.includes("_mm") || id.includes("micro"))
      ? "dot"
      : "solid";

  return { symbol, dash };
}

function markerStyle(site, isSelected = false) {
  return {
    radius: isSelected ? 12 : 9,
    weight: isSelected ? 3 : 2,
    color: isSelected ? "#11231f" : "#fffdf4",
    fillColor: site.markerColor || site.color,
    fillOpacity: isSelected ? 1 : 0.98
  };
}

function visibleSites() {
  const filter = datasetFilter.value;
  return [...appState.sites.values()].filter((site) => {
    const datasetOk = filter === "all" || site.datasetId === filter;
    const cityOk = appState.statsCity === "all" || site.council === appState.statsCity;
    return datasetOk && cityOk;
  });
}

function statsVisibleSites() {
  const filtered = visibleSites();
  const bounds = map.getBounds();
  return filtered.filter((site) => bounds.contains([site.latitude, site.longitude]));
}

function sortedUniqueCouncils(sites) {
  return [...new Set(sites.map((site) => site.council).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function refreshStatsCityOptions() {
  const datasetScoped = datasetFilter.value === "all"
    ? [...appState.sites.values()]
    : [...appState.sites.values()].filter((site) => site.datasetId === datasetFilter.value);

  const councils = sortedUniqueCouncils(datasetScoped);
  const previous = appState.statsCity;

  statsCityFilter.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All Cities";
  statsCityFilter.appendChild(allOption);

  councils.forEach((council) => {
    const option = document.createElement("option");
    option.value = council;
    option.textContent = council;
    statsCityFilter.appendChild(option);
  });

  const validValues = new Set(["all", ...councils]);
  appState.statsCity = validValues.has(previous) ? previous : "all";
  statsCityFilter.value = appState.statsCity;
}

function getDistinctYearsForSites(sites) {
  const years = new Set();
  sites.forEach((site) => {
    site.records.forEach((record) => {
      if (record.year != null) {
        years.add(Number(record.year));
      }
    });
  });
  return [...years].sort((left, right) => left - right);
}

function computeDashboardStats(sites) {
  const allRecords = sites.flatMap((site) => site.records || []);
  const totals = allRecords.map((record) => record.total).filter((value) => value != null);
  const years = getDistinctYearsForSites(sites);

  const siteTotals = sites
    .map((site) => ({
      key: site.key,
      siteId: site.siteId,
      total: (site.records || []).reduce((sum, record) => sum + (record.total || 0), 0)
    }))
    .sort((left, right) => right.total - left.total);

  const topSlice = Math.max(1, Math.ceil(siteTotals.length * 0.1));
  const totalVolume = siteTotals.reduce((sum, item) => sum + item.total, 0);
  const topVolume = siteTotals.slice(0, topSlice).reduce((sum, item) => sum + item.total, 0);
  const concentration = totalVolume > 0 ? (topVolume / totalVolume) * 100 : null;

  const hourlyNetwork = averageHourlySeries([{ hourly: allRecords.flatMap((record) => record.hourly || []) }]);
  const peak = hourlyNetwork.reduce((best, point) => {
    if (point.value == null) {
      return best;
    }
    if (!best || point.value > best.value) {
      return point;
    }
    return best;
  }, null);

  return {
    siteCount: sites.length,
    recordCount: allRecords.length,
    yearRange: years.length ? `${years[0]}-${years[years.length - 1]}` : "n/a",
    totalVolume,
    medianDailyTotal: percentile(totals, 0.5),
    concentration,
    peakHour: peak ? `${peak.time} (${formatNumber(peak.value, 1)})` : "n/a",
    topSites: siteTotals.slice(0, 5)
  };
}

function dateRangeCoverage(records) {
  const recordDates = records
    .map((record) => parseDate(record.dateKey || record.date))
    .filter(Boolean)
    .sort((left, right) => left - right);

  if (recordDates.length === 0) {
    return {
      observedDays: 0,
      expectedDays: 0,
      coveragePct: null,
      rangeLabel: "n/a"
    };
  }

  const first = recordDates[0];
  const last = recordDates[recordDates.length - 1];
  const millisInDay = 24 * 60 * 60 * 1000;
  const expectedDays = Math.round((last.getTime() - first.getTime()) / millisInDay) + 1;
  const observedDays = new Set(recordDates.map((date) => date.toISOString().slice(0, 10))).size;
  const coveragePct = expectedDays > 0 ? (observedDays / expectedDays) * 100 : null;

  return {
    observedDays,
    expectedDays,
    coveragePct,
    rangeLabel: `${first.getFullYear()}-${last.getFullYear()}`
  };
}

function computeOtherDashboardStats(sites) {
  const allRecords = sites.flatMap((site) => site.records || []);
  const coverage = dateRangeCoverage(allRecords);

  const byDate = new Map();
  allRecords.forEach((record) => {
    const key = record.dateKey || record.date;
    if (!key || record.total == null) {
      return;
    }
    if (!byDate.has(key)) {
      byDate.set(key, []);
    }
    byDate.get(key).push(Number(record.total));
  });

  const dailyValues = [...byDate.keys()]
    .sort((left, right) => left.localeCompare(right))
    .map((day) => {
      const values = byDate.get(day) || [];
      if (values.length === 0) {
        return null;
      }
      if (appState.statsVolumeMode === "site") {
        return values.reduce((sum, current) => sum + current, 0) / values.length;
      }
      return values.reduce((sum, current) => sum + current, 0);
    })
    .filter((value) => value != null);

  const averageDaily = dailyValues.length
    ? dailyValues.reduce((sum, current) => sum + current, 0) / dailyValues.length
    : null;

  const peakDay = [...byDate.entries()].reduce((best, [day, values]) => {
    if (values.length === 0) {
      return best;
    }
    const dayValue = appState.statsVolumeMode === "site"
      ? values.reduce((sum, current) => sum + current, 0) / values.length
      : values.reduce((sum, current) => sum + current, 0);

    if (!best || dayValue > best.value) {
      return { day, value: dayValue };
    }
    return best;
  }, null);

  const topSites = sites
    .map((site) => {
      const siteTotals = (site.records || []).map((record) => record.total).filter((value) => value != null);
      const meanDaily = siteTotals.length
        ? siteTotals.reduce((sum, current) => sum + current, 0) / siteTotals.length
        : null;
      return {
        key: site.key,
        siteId: site.siteId,
        meanDaily,
        observedDays: siteTotals.length
      };
    })
    .sort((left, right) => (right.meanDaily || 0) - (left.meanDaily || 0));

  return {
    siteCount: sites.length,
    observedDays: coverage.observedDays,
    expectedDays: coverage.expectedDays,
    coveragePct: coverage.coveragePct,
    yearRange: coverage.rangeLabel,
    averageDaily,
    medianDaily: percentile(dailyValues, 0.5),
    peakDayLabel: peakDay
      ? `${peakDay.day} (${formatNumber(peakDay.value, 0)})`
      : "n/a",
    topSites: topSites.slice(0, 5)
  };
}

function computeDashboardYearlyStats(sites) {
  const yearly = new Map();
  const siteYearTotals = new Map();
  const siteIdByKey = new Map(sites.map((site) => [site.key, site.siteId]));

  sites.forEach((site) => {
    if (!siteYearTotals.has(site.key)) {
      siteYearTotals.set(site.key, new Map());
    }

    (site.records || []).forEach((record) => {
      if (record.year == null || record.total == null) {
        return;
      }

      const year = Number(record.year);
      const total = Number(record.total);

      if (!yearly.has(year)) {
        yearly.set(year, {
          totals: [],
          networkTotal: 0
        });
      }

      const current = yearly.get(year);
      current.totals.push(total);
      current.networkTotal += total;

      const byYear = siteYearTotals.get(site.key);
      byYear.set(year, (byYear.get(year) || 0) + total);
    });
  });

  const years = [...yearly.keys()].sort((left, right) => left - right);

  const siteSeries = [...siteYearTotals.entries()].map(([siteKey, valuesByYear]) => ({
    siteKey,
    siteId: siteIdByKey.get(siteKey) ?? siteKey,
    y: years.map((year) => valuesByYear.get(year) ?? null)
  }));

  const medianSiteTotals = years.map((year, yearIndex) => {
    const values = siteSeries.map((series) => series.y[yearIndex]).filter((value) => value != null);
    return percentile(values, 0.5);
  });

  const p90SiteTotals = years.map((year, yearIndex) => {
    const values = siteSeries.map((series) => series.y[yearIndex]).filter((value) => value != null);
    return percentile(values, 0.9);
  });

  return {
    years,
    networkTotals: years.map((year) => yearly.get(year).networkTotal),
    siteSeries,
    medianSiteTotals,
    p90SiteTotals
  };
}

function renderDashboardStatsTrends(sites) {
  if (IS_OTHER_MODE) {
    const allRecords = sites.flatMap((site) => site.records || []);
    const byDate = new Map();
    allRecords.forEach((record) => {
      const key = record.dateKey || record.date;
      if (!key || record.total == null) {
        return;
      }
      if (!byDate.has(key)) {
        byDate.set(key, []);
      }
      byDate.get(key).push(Number(record.total));
    });

    const x = [...byDate.keys()].sort((left, right) => left.localeCompare(right));
    if (x.length === 0) {
      Plotly.purge(statsTrendVolume);
      return;
    }

    const dailyValues = x.map((day) => {
      const values = byDate.get(day) || [];
      if (values.length === 0) {
        return null;
      }
      if (appState.statsVolumeMode === "site") {
        return values.reduce((sum, current) => sum + current, 0) / values.length;
      }
      return values.reduce((sum, current) => sum + current, 0);
    });

    const rolling14 = dailyValues.map((_, index) => {
      const window = dailyValues.slice(Math.max(0, index - 13), index + 1).filter((value) => value != null);
      return window.length ? Number((window.reduce((sum, current) => sum + current, 0) / window.length).toFixed(2)) : null;
    });

    const baseLabel = appState.statsVolumeMode === "site" ? "Daily mean per site" : "Daily network total";
    const rollingLabel = appState.statsVolumeMode === "site" ? "14-day moving mean (site mean)" : "14-day moving mean (network total)";
    const yAxisTitle = appState.statsVolumeMode === "site" ? "Daily count per site" : "Daily count (summed across sites)";

    Plotly.newPlot(
      statsTrendVolume,
      [
        {
          x,
          y: dailyValues,
          type: "scatter",
          mode: "lines",
          name: baseLabel,
          line: { color: "#1d3557", width: 1.8 },
          connectgaps: false
        },
        {
          x,
          y: rolling14,
          type: "scatter",
          mode: "lines",
          name: rollingLabel,
          line: { color: "#457b9d", width: 2.6 },
          connectgaps: false
        }
      ],
      {
        margin: { t: 36, r: 14, b: 60, l: 56 },
        title: { text: "Daily Volume Evolution", font: { size: 14 } },
        xaxis: { title: { text: "Date", standoff: 12 }, type: "date" },
        yaxis: { title: yAxisTitle },
        legend: { orientation: "h", y: -0.28 },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        font: { family: "Space Grotesk, sans-serif", color: "#11231f" }
      },
      { displayModeBar: false, responsive: true }
    );
    return;
  }

  const yearly = computeDashboardYearlyStats(sites);
  if (!window.Plotly) {
    return;
  }

  if (yearly.years.length === 0) {
    Plotly.purge(statsTrendVolume);
    return;
  }

  const x = yearly.years.map((year) => String(year));

  const traces = appState.statsVolumeMode === "site"
    ? [
      ...yearly.siteSeries.map((series) => ({
        x,
        y: series.y,
        meta: `Site ${series.siteId}`,
        type: "scatter",
        mode: "lines",
        showlegend: false,
        line: { color: "rgba(17, 35, 31, 0.12)", width: 1 },
        hovertemplate: "%{meta}<br>Year %{x}<br>Count %{y:.1f}<extra></extra>"
      })),
      {
        x,
        y: yearly.medianSiteTotals,
        type: "scatter",
        mode: "lines+markers",
        name: "Median across sites",
        line: { color: "#005f73", width: 3 },
        hovertemplate: "Median across sites<br>Year %{x}<br>Count %{y:.1f}<extra></extra>"
      }
    ]
    : [
      {
        x,
        y: yearly.networkTotals,
        type: "scatter",
        mode: "lines+markers",
        name: "Network total",
        line: { color: "#005f73", width: 2.8 }
      }
    ];

  Plotly.newPlot(
    statsTrendVolume,
    traces,
    {
      margin: { t: 36, r: 14, b: 60, l: 56 },
      title: { text: "Volume Evolution", font: { size: 14 } },
      xaxis: { title: { text: "Year", standoff: 12 } },
      yaxis: { title: "Count" },
      legend: { orientation: "h", y: -0.28 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "Space Grotesk, sans-serif", color: "#11231f" }
    },
    { displayModeBar: false, responsive: true }
  );
}

function renderDashboardStats() {
  const sites = statsVisibleSites();
  const scopeDataset = IS_OTHER_MODE
    ? "Active layer"
    : (datasetFilter.value === "all" ? "All datasets" : datasetFilter.value.toUpperCase());
  const scopeCity = appState.statsCity === "all" ? "All cities" : appState.statsCity;
  statsScope.textContent = `Scope: ${scopeDataset} | ${scopeCity} | current map view`;

  if (sites.length === 0) {
    statsGrid.innerHTML = "";
    statsNotes.textContent = "No statistics available for the current scope.";
    if (window.Plotly) {
      Plotly.purge(statsTrendVolume);
    }
    return;
  }

  if (IS_OTHER_MODE) {
    const stats = computeOtherDashboardStats(sites);
    const cards = [
      ["Sites", formatNumber(stats.siteCount)],
      ["Observed days", formatNumber(stats.observedDays)],
      ["Expected days", formatNumber(stats.expectedDays)],
      ["Coverage", stats.coveragePct == null ? "n/a" : `${formatNumber(stats.coveragePct, 1)}%`],
      ["Year range", stats.yearRange],
      ["Mean daily count", formatNumber(stats.averageDaily, 1)],
      ["Median daily count", formatNumber(stats.medianDaily, 1)],
      ["Peak day", stats.peakDayLabel]
    ];

    statsGrid.innerHTML = cards
      .map(([label, value]) => `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`)
      .join("");

    const topSiteText = stats.topSites
      .map((item) => `Site ${item.siteId}: ${formatNumber(item.meanDaily, 1)} avg/day over ${formatNumber(item.observedDays)} observed days`)
      .join(" | ");

    statsNotes.textContent = `Missing dates are excluded from daily averages. Top sites by mean daily count: ${topSiteText}`;
    renderDashboardStatsTrends(sites);
    return;
  }

  const stats = computeDashboardStats(sites);
  const cards = [
    ["Sites", formatNumber(stats.siteCount)],
    ["Records", formatNumber(stats.recordCount)],
    ["Year range", stats.yearRange],
    ["Total counts", formatNumber(stats.totalVolume)],
    ["Median daily count", formatNumber(stats.medianDailyTotal, 1)],
    ["Top 10% share", stats.concentration == null ? "n/a" : `${formatNumber(stats.concentration, 1)}%`],
    ["Peak hour", stats.peakHour]
  ];

  statsGrid.innerHTML = cards
    .map(([label, value]) => `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`)
    .join("");

  const topSiteText = stats.topSites
    .map((item) => `Site ${item.siteId}: ${formatNumber(item.total)}`)
    .join(" | ");

  statsNotes.textContent = `Top sites by count: ${topSiteText}`;
  renderDashboardStatsTrends(sites);
}

function hydrateSite(site, dataset, categoryDefinitions) {
  const records = (site.records || []).map((record) => ({
    ...record,
    categories: record.categories || {},
    categoryHourly: record.categoryHourly || {},
    directional: record.directional || { legTotals: [], movements: [] },
    dateObj: parseDate(record.date),
    dateKey: record.date || "unknown"
  })).sort((left, right) => (left.dateObj?.getTime() || 0) - (right.dateObj?.getTime() || 0));

  return {
    ...site,
    color: dataset.color,
    markerColor: dataset.markerColor,
    categoryDefinitions: categoryDefinitions || [],
    records,
    yearlyTotals: site.yearlyTotals || {}
  };
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      const next = line[index + 1];
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function parseCsv(text) {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const columns = parseCsvLine(line);
    return headers.reduce((row, header, index) => {
      row[header] = columns[index] ?? "";
      return row;
    }, {});
  });
}

function parseOptionalNumber(value) {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const VEHICLE_CLASS_LABELS = {
  sv: "SV - Short",
  svt: "SVT - Short + trailer",
  tb2: "TB2 - Two axle rigid/bus",
  tb3: "TB3 - Three axle rigid/bus",
  t4: "T4 - Four+ axle rigid",
  art3: "ART3 - Three axle artic",
  art4: "ART4 - Four axle artic",
  art5: "ART5 - Five axle artic",
  art6: "ART6 - Six+ axle artic",
  bd: "BD - B double",
  drt: "DRT - Double road train",
  trt: "TRT - Triple road train",
  ucv: "UCV - Unclassified vehicle"
};

function vehicleClassLabel(code) {
  return VEHICLE_CLASS_LABELS[code] || code.toUpperCase();
}

function parseVehicleLaneDirection(directionLabel) {
  const lower = String(directionLabel || "").toLowerCase();
  const path = lower.includes("right lane")
    ? "Right lane"
    : lower.includes("centre lane")
      ? "Centre lane"
      : lower.includes("left lane")
        ? "Left lane"
        : "Other lane";
  const direction = lower.includes("eastbound")
    ? "Eastbound"
    : lower.includes("westbound")
      ? "Westbound"
      : "Other direction";
  return { path, direction };
}

function buildDrakewellActiveSite(rows, dataset) {
  const byDate = new Map();
  rows.forEach((row) => {
    if (!row.date) {
      return;
    }
    if (!byDate.has(row.date)) {
      byDate.set(row.date, []);
    }
    byDate.get(row.date).push(row);
  });

  const normalizeDirectionId = (directionLabel) => `dir_${String(directionLabel || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;

  const directionLabels = [...new Set(rows
    .map((row) => row.direction)
    .filter((direction) => direction && direction !== "All directions"))]
    .sort((left, right) => left.localeCompare(right));

  const parsePathDirection = (label) => {
    const lower = String(label || "").toLowerCase();
    const path = lower.includes("northern")
      ? "Northern shared path"
      : lower.includes("southern")
        ? "Southern shared path"
        : "Other path";
    const direction = lower.includes("eastbound")
      ? "Eastbound"
      : lower.includes("westbound")
        ? "Westbound"
        : "Other direction";
    return { path, direction };
  };

  const directionDefinitions = directionLabels.map((label) => ({
    ...parsePathDirection(label),
    id: normalizeDirectionId(label),
    label,
    splitGroup: label,
    userType: "combined"
  }));

  const records = [...byDate.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([recordDate, dateRows]) => {
      const allDirectionRows = dateRows
        .filter((row) => row.direction === "All directions")
        .sort((left, right) => (left.time_bin || "").localeCompare(right.time_bin || ""));

      const directionRowsByLabel = new Map(directionLabels.map((label) => [label, []]));
      dateRows.forEach((row) => {
        if (!directionRowsByLabel.has(row.direction)) {
          return;
        }
        directionRowsByLabel.get(row.direction).push(row);
      });
      directionRowsByLabel.forEach((directionRows) => {
        directionRows.sort((left, right) => (left.time_bin || "").localeCompare(right.time_bin || ""));
      });

      const hourly = allDirectionRows.map((row) => ({
        time: (row.time_bin || "").slice(0, 5),
        value: parseOptionalNumber(row.total_flow)
      }));

      const pedHourly = allDirectionRows.map((row) => ({
        time: (row.time_bin || "").slice(0, 5),
        value: parseOptionalNumber(row.ped)
      }));

      const pclHourly = allDirectionRows.map((row) => ({
        time: (row.time_bin || "").slice(0, 5),
        value: parseOptionalNumber(row.pcl)
      }));

      const categories = {
        walker_total: pedHourly.reduce((sum, point) => sum + (point.value || 0), 0),
        pushbike_total: pclHourly.reduce((sum, point) => sum + (point.value || 0), 0)
      };

      const categoryHourly = {
        walker_total: pedHourly,
        pushbike_total: pclHourly
      };

      directionDefinitions.forEach((definition) => {
        const directionRows = directionRowsByLabel.get(definition.label) || [];
        const directionHourly = directionRows.map((row) => ({
          time: (row.time_bin || "").slice(0, 5),
          value: parseOptionalNumber(row.total_flow)
        }));
        categoryHourly[definition.id] = directionHourly;
        categories[definition.id] = directionHourly.reduce((sum, point) => sum + (point.value || 0), 0);

        const pedId = `${definition.id}_ped`;
        const pclId = `${definition.id}_pcl`;
        const pedHourly = directionRows.map((row) => ({
          time: (row.time_bin || "").slice(0, 5),
          value: parseOptionalNumber(row.ped)
        }));
        const pclHourly = directionRows.map((row) => ({
          time: (row.time_bin || "").slice(0, 5),
          value: parseOptionalNumber(row.pcl)
        }));

        categoryHourly[pedId] = pedHourly;
        categories[pedId] = pedHourly.reduce((sum, point) => sum + (point.value || 0), 0);
        categoryHourly[pclId] = pclHourly;
        categories[pclId] = pclHourly.reduce((sum, point) => sum + (point.value || 0), 0);
      });

      const dailyTotal = hourly.length > 0
        ? hourly.reduce((sum, point) => sum + (point.value || 0), 0)
        : directionDefinitions.reduce((sum, definition) => sum + (categories[definition.id] || 0), 0);

      return {
        date: recordDate,
        year: Number(recordDate.slice(0, 4)),
        total: dailyTotal,
        hourly,
        categories,
        categoryHourly,
        directional: {
          legTotals: [],
          movements: []
        }
      };
    });

  const yearlyTotals = records.reduce((accumulator, record) => {
    if (!Number.isFinite(record.year)) {
      return accumulator;
    }
    const key = String(record.year);
    accumulator[key] = (accumulator[key] || 0) + (record.total || 0);
    return accumulator;
  }, {});

  return {
    key: "drakewell-00A0113113AT",
    siteId: "00A0113113AT",
    datasetId: dataset.id,
    council: "Hobart",
    state: "TAS",
    counterName: "Tasman Bridge shared path",
    description: "Tasman Bridge shared path",
    latitude: -42.863212,
    longitude: 147.352933,
    legs: 0,
    roadLabels: [],
    exitLayout: [],
    flowUnit: "People",
    binMinutes: 5,
    records,
    yearlyTotals,
    directionDefinitions
  };
}

function buildDrakewellVehicleSite(rows, dataset) {
  const byDate = new Map();
  rows.forEach((row) => {
    if (!row.date) {
      return;
    }
    if (!byDate.has(row.date)) {
      byDate.set(row.date, []);
    }
    byDate.get(row.date).push(row);
  });

  const normalizeDirectionId = (directionLabel) => `vdir_${String(directionLabel || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;

  const directionLabels = [...new Set(rows
    .map((row) => row.direction)
    .filter((direction) => direction && direction !== "All directions"))]
    .sort((left, right) => left.localeCompare(right));

  const metricKeys = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => {
    return !["date", "time_bin", "direction", "total_flow", "invalid_reading"].includes(key);
  });

  const classPriority = ["sv", "svt", "tb2", "tb3", "t4", "art3", "art4", "art5", "art6", "bd", "drt", "trt", "ucv"];
  const classKeys = metricKeys
    .filter((key) => metricKeys.includes(key))
    .sort((left, right) => {
      const leftIndex = classPriority.indexOf(left);
      const rightIndex = classPriority.indexOf(right);
      if (leftIndex === -1 && rightIndex === -1) {
        return left.localeCompare(right);
      }
      if (leftIndex === -1) {
        return 1;
      }
      if (rightIndex === -1) {
        return -1;
      }
      return leftIndex - rightIndex;
    });

  const directionDefinitions = directionLabels.map((label) => ({
    ...parseVehicleLaneDirection(label),
    id: normalizeDirectionId(label),
    label,
    splitGroup: label,
    userType: "combined",
    userTypeLabel: "All classes"
  }));

  const records = [...byDate.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([recordDate, dateRows]) => {
      const allDirectionRows = dateRows
        .filter((row) => row.direction === "All directions")
        .sort((left, right) => (left.time_bin || "").localeCompare(right.time_bin || ""));

      const directionRowsByLabel = new Map(directionLabels.map((label) => [label, []]));
      dateRows.forEach((row) => {
        if (!directionRowsByLabel.has(row.direction)) {
          return;
        }
        directionRowsByLabel.get(row.direction).push(row);
      });
      directionRowsByLabel.forEach((directionRows) => {
        directionRows.sort((left, right) => (left.time_bin || "").localeCompare(right.time_bin || ""));
      });

      const hourly = allDirectionRows.map((row) => ({
        time: (row.time_bin || "").slice(0, 5),
        value: parseOptionalNumber(row.total_flow)
      }));

      const categories = {};
      const categoryHourly = {};

      classKeys.forEach((classKey) => {
        const id = `class_${classKey}`;
        const classHourly = allDirectionRows.map((row) => ({
          time: (row.time_bin || "").slice(0, 5),
          value: parseOptionalNumber(row[classKey])
        }));
        categoryHourly[id] = classHourly;
        categories[id] = classHourly.reduce((sum, point) => sum + (point.value || 0), 0);
      });

      directionDefinitions.forEach((definition) => {
        const directionRows = directionRowsByLabel.get(definition.label) || [];
        const directionHourly = directionRows.map((row) => ({
          time: (row.time_bin || "").slice(0, 5),
          value: parseOptionalNumber(row.total_flow)
        }));
        categoryHourly[definition.id] = directionHourly;
        categories[definition.id] = directionHourly.reduce((sum, point) => sum + (point.value || 0), 0);

        classKeys.forEach((classKey) => {
          const classId = `${definition.id}_${classKey}`;
          const classHourly = directionRows.map((row) => ({
            time: (row.time_bin || "").slice(0, 5),
            value: parseOptionalNumber(row[classKey])
          }));
          categoryHourly[classId] = classHourly;
          categories[classId] = classHourly.reduce((sum, point) => sum + (point.value || 0), 0);
        });
      });

      const dailyTotal = hourly.length > 0
        ? hourly.reduce((sum, point) => sum + (point.value || 0), 0)
        : directionDefinitions.reduce((sum, definition) => sum + (categories[definition.id] || 0), 0);

      return {
        date: recordDate,
        year: Number(recordDate.slice(0, 4)),
        total: dailyTotal,
        hourly,
        categories,
        categoryHourly,
        directional: {
          legTotals: [],
          movements: []
        }
      };
    });

  const yearlyTotals = records.reduce((accumulator, record) => {
    if (!Number.isFinite(record.year)) {
      return accumulator;
    }
    const key = String(record.year);
    accumulator[key] = (accumulator[key] || 0) + (record.total || 0);
    return accumulator;
  }, {});

  const classDefinitions = classKeys.map((classKey) => ({
    id: `class_${classKey}`,
    label: vehicleClassLabel(classKey),
    splitGroup: "all_classes",
    path: "All lanes",
    direction: "All directions",
    userType: classKey,
    userTypeLabel: vehicleClassLabel(classKey)
  }));

  const directionClassDefinitions = directionDefinitions.flatMap((definition) => classKeys.map((classKey) => ({
    id: `${definition.id}_${classKey}`,
    label: `${definition.label} - ${vehicleClassLabel(classKey)}`,
    splitGroup: definition.label,
    path: definition.path,
    direction: definition.direction,
    userType: classKey,
    userTypeLabel: vehicleClassLabel(classKey)
  })));

  return {
    key: "drakewell-0000A0113112",
    siteId: "A0113112",
    datasetId: dataset.id,
    council: "Rose Bay",
    state: "TAS",
    counterName: "Tasman Highway traffic",
    description: "Tasman Highway 100m E Of Tasman Bridge East Abutment",
    latitude: -42.8627749,
    longitude: 147.3536489,
    legs: 0,
    roadLabels: [],
    exitLayout: [],
    flowUnit: "Vehicles",
    binMinutes: 5,
    records,
    yearlyTotals,
    directionDefinitions,
    classDefinitions,
    directionClassDefinitions
  };
}

function buildMelbourneCyclingSites(rows, dataset) {
  const bySite = new Map();
  rows.forEach((row) => {
    const route = String(row.site_xn_route || "").trim();
    if (!route || !row.date) {
      return;
    }
    if (!bySite.has(route)) {
      bySite.set(route, []);
    }
    bySite.get(route).push(row);
  });

  const normalizeDirectionId = (directionLabel) => `mdir_${String(directionLabel || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;

  const directionLabels = [...new Set(rows
    .map((row) => row.direction)
    .filter((direction) => direction && direction !== "All directions"))]
    .sort((left, right) => left.localeCompare(right));

  const directionDefinitions = directionLabels.map((label) => ({
    id: normalizeDirectionId(label),
    label,
    splitGroup: label,
    path: "Network",
    direction: label,
    userType: "combined",
    userTypeLabel: "Cyclist"
  }));

  const sites = [];

  bySite.forEach((siteRows, route) => {
    const byDate = new Map();
    siteRows.forEach((row) => {
      if (!byDate.has(row.date)) {
        byDate.set(row.date, []);
      }
      byDate.get(row.date).push(row);
    });

    const records = [...byDate.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([recordDate, dateRows]) => {
        const allDirectionRows = dateRows
          .filter((row) => row.direction === "All directions")
          .sort((left, right) => (left.time_bin || "").localeCompare(right.time_bin || ""));

        const directionRowsByLabel = new Map(directionLabels.map((label) => [label, []]));
        dateRows.forEach((row) => {
          if (!directionRowsByLabel.has(row.direction)) {
            return;
          }
          directionRowsByLabel.get(row.direction).push(row);
        });
        directionRowsByLabel.forEach((directionRows) => {
          directionRows.sort((left, right) => (left.time_bin || "").localeCompare(right.time_bin || ""));
        });

        const hourly = allDirectionRows.map((row) => ({
          time: (row.time_bin || "").slice(0, 5),
          value: parseOptionalNumber(row.total_flow)
        }));

        const categories = {};
        const categoryHourly = {};

        directionDefinitions.forEach((definition) => {
          const directionRows = directionRowsByLabel.get(definition.label) || [];
          const directionHourly = directionRows.map((row) => ({
            time: (row.time_bin || "").slice(0, 5),
            value: parseOptionalNumber(row.total_flow)
          }));
          categoryHourly[definition.id] = directionHourly;
          categories[definition.id] = directionHourly.reduce((sum, point) => sum + (point.value || 0), 0);
        });

        const dailyTotal = hourly.reduce((sum, point) => sum + (point.value || 0), 0);

        return {
          date: recordDate,
          year: Number(recordDate.slice(0, 4)),
          total: dailyTotal,
          hourly,
          categories,
          categoryHourly,
          directional: {
            legTotals: [],
            movements: []
          }
        };
      });

    const yearlyTotals = records.reduce((accumulator, record) => {
      if (!Number.isFinite(record.year)) {
        return accumulator;
      }
      const key = String(record.year);
      accumulator[key] = (accumulator[key] || 0) + (record.total || 0);
      return accumulator;
    }, {});

    const sample = siteRows[0] || {};
    const latitude = parseOptionalNumber(sample.gps_lat);
    const longitude = parseOptionalNumber(sample.gps_long);
    if (latitude == null || longitude == null) {
      return;
    }

    const region = String(sample.region || "Melbourne").trim() || "Melbourne";
    const purpose = String(sample.purpose || "").trim();
    const surfaceType = String(sample.surface_type || "").trim();
    const status = String(sample.status || "").trim();
    const siteDesc = String(sample.site_desc || "").trim();

    const descriptionParts = [surfaceType, status, purpose].filter(Boolean);

    sites.push({
      key: `melbourne-${route}`,
      siteId: route,
      datasetId: dataset.id,
      council: region,
      state: "VIC",
      counterName: siteDesc || `Melbourne site ${route}`,
      description: descriptionParts.join(" | ") || "Melbourne bicycle monitoring site",
      latitude,
      longitude,
      legs: 0,
      roadLabels: [],
      exitLayout: [],
      flowUnit: "People",
      binMinutes: 60,
      records,
      yearlyTotals,
      directionDefinitions
    });
  });

  return {
    sites,
    directionDefinitions
  };
}

function buildSydneyActiveSites(rows, dataset) {
  const bySite = new Map();
  rows.forEach((row) => {
    const siteId = String(row.site_id || "").trim();
    if (!siteId || !row.date) {
      return;
    }
    if (!bySite.has(siteId)) {
      bySite.set(siteId, []);
    }
    bySite.get(siteId).push(row);
  });

  const normalizeDirectionId = (directionLabel) => `sydir_${String(directionLabel || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;

  const directionLabels = [...new Set(rows
    .map((row) => row.direction)
    .filter((direction) => direction && direction !== "All directions"))]
    .sort((left, right) => left.localeCompare(right));

  const directionDefinitions = directionLabels.map((label) => ({
    id: normalizeDirectionId(label),
    label,
    splitGroup: label,
    path: "Sydney survey route",
    direction: label,
    userType: "combined",
    userTypeLabel: "Cyclist"
  }));

  const sites = [];

  bySite.forEach((siteRows, siteId) => {
    const byDate = new Map();
    siteRows.forEach((row) => {
      if (!byDate.has(row.date)) {
        byDate.set(row.date, []);
      }
      byDate.get(row.date).push(row);
    });

    const records = [...byDate.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([recordDate, dateRows]) => {
        const allDirectionRows = dateRows
          .filter((row) => row.direction === "All directions")
          .sort((left, right) => (left.time_bin || "").localeCompare(right.time_bin || ""));

        const directionRowsByLabel = new Map(directionLabels.map((label) => [label, []]));
        dateRows.forEach((row) => {
          if (!directionRowsByLabel.has(row.direction)) {
            return;
          }
          directionRowsByLabel.get(row.direction).push(row);
        });
        directionRowsByLabel.forEach((directionRows) => {
          directionRows.sort((left, right) => (left.time_bin || "").localeCompare(right.time_bin || ""));
        });

        const hourly = allDirectionRows.map((row) => ({
          time: (row.time_bin || "").slice(0, 5),
          value: parseOptionalNumber(row.total_flow)
        }));

        const pedHourly = allDirectionRows.map((row) => ({
          time: (row.time_bin || "").slice(0, 5),
          value: parseOptionalNumber(row.ped)
        }));

        const pclHourly = allDirectionRows.map((row) => ({
          time: (row.time_bin || "").slice(0, 5),
          value: parseOptionalNumber(row.pcl)
        }));

        const categories = {
          walker_total: pedHourly.reduce((sum, point) => sum + (point.value || 0), 0),
          pushbike_total: pclHourly.reduce((sum, point) => sum + (point.value || 0), 0)
        };

        const categoryHourly = {
          walker_total: pedHourly,
          pushbike_total: pclHourly
        };

        directionDefinitions.forEach((definition) => {
          const directionRows = directionRowsByLabel.get(definition.label) || [];
          const directionHourly = directionRows.map((row) => ({
            time: (row.time_bin || "").slice(0, 5),
            value: parseOptionalNumber(row.total_flow)
          }));
          categoryHourly[definition.id] = directionHourly;
          categories[definition.id] = directionHourly.reduce((sum, point) => sum + (point.value || 0), 0);

          const pedId = `${definition.id}_ped`;
          const pclId = `${definition.id}_pcl`;
          const directionPedHourly = directionRows.map((row) => ({
            time: (row.time_bin || "").slice(0, 5),
            value: parseOptionalNumber(row.ped)
          }));
          const directionPclHourly = directionRows.map((row) => ({
            time: (row.time_bin || "").slice(0, 5),
            value: parseOptionalNumber(row.pcl)
          }));

          categoryHourly[pedId] = directionPedHourly;
          categories[pedId] = directionPedHourly.reduce((sum, point) => sum + (point.value || 0), 0);
          categoryHourly[pclId] = directionPclHourly;
          categories[pclId] = directionPclHourly.reduce((sum, point) => sum + (point.value || 0), 0);
        });

        const dailyTotal = hourly.length > 0
          ? hourly.reduce((sum, point) => sum + (point.value || 0), 0)
          : directionDefinitions.reduce((sum, definition) => sum + (categories[definition.id] || 0), 0);

        return {
          date: recordDate,
          year: Number(recordDate.slice(0, 4)),
          total: dailyTotal,
          hourly,
          categories,
          categoryHourly,
          directional: {
            legTotals: [],
            movements: []
          }
        };
      });

    const yearlyTotals = records.reduce((accumulator, record) => {
      if (!Number.isFinite(record.year)) {
        return accumulator;
      }
      const key = String(record.year);
      accumulator[key] = (accumulator[key] || 0) + (record.total || 0);
      return accumulator;
    }, {});

    const sample = siteRows[0] || {};
    const latitude = parseOptionalNumber(sample.latitude);
    const longitude = parseOptionalNumber(sample.longitude);
    if (latitude == null || longitude == null) {
      return;
    }

    const intersection = String(sample.intersection || "").trim();
    sites.push({
      key: `sydney-${siteId}`,
      siteId,
      datasetId: dataset.id,
      council: "Sydney",
      state: "NSW",
      counterName: intersection || `Sydney site ${siteId}`,
      description: intersection || "City of Sydney bicycle count site",
      latitude,
      longitude,
      legs: 0,
      roadLabels: [],
      exitLayout: [],
      flowUnit: "People",
      binMinutes: 60,
      records,
      yearlyTotals,
      directionDefinitions
    });
  });

  return {
    sites,
    directionDefinitions
  };
}

async function loadDrakewellDataset(dataset) {
  const response = await fetch(dataset.file);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${dataset.file}`);
  }

  const csvText = await response.text();
  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    throw new Error("Drakewell timeseries file is empty");
  }

  let site;

  if (dataset.profile === "perm_vehicle") {
    site = buildDrakewellVehicleSite(rows, dataset);
    dataset.categoryDefinitions = [
      ...(site.directionDefinitions || []),
      ...(site.classDefinitions || []),
      ...(site.directionClassDefinitions || [])
    ];
  } else if (dataset.profile === "melbourne_cycling") {
    const melbourne = buildMelbourneCyclingSites(rows, dataset);
    dataset.categoryDefinitions = [
      ...(melbourne.directionDefinitions || [])
    ];
    (melbourne.sites || []).forEach((melbourneSite) => {
      const hydrated = hydrateSite(melbourneSite, dataset, dataset.categoryDefinitions);
      appState.sites.set(hydrated.key, hydrated);
    });
    return;
  } else if (dataset.profile === "sydney_active") {
    const sydney = buildSydneyActiveSites(rows, dataset);
    dataset.categoryDefinitions = [
      { id: "walker_total", label: "Pedestrian" },
      { id: "pushbike_total", label: "Cyclist" },
      ...(sydney.directionDefinitions || []),
      ...(sydney.directionDefinitions || []).flatMap((definition) => [
        {
          id: `${definition.id}_ped`,
          label: `${definition.label} - Pedestrian`,
          splitGroup: definition.label,
          path: definition.path,
          direction: definition.direction,
          userType: "pedestrian",
          userTypeLabel: "Pedestrian"
        },
        {
          id: `${definition.id}_pcl`,
          label: `${definition.label} - Cyclist`,
          splitGroup: definition.label,
          path: definition.path,
          direction: definition.direction,
          userType: "cyclist",
          userTypeLabel: "Cyclist"
        }
      ])
    ];
    (sydney.sites || []).forEach((sydneySite) => {
      const hydrated = hydrateSite(sydneySite, dataset, dataset.categoryDefinitions);
      appState.sites.set(hydrated.key, hydrated);
    });
    return;
  } else {
    site = buildDrakewellActiveSite(rows, dataset);
    dataset.categoryDefinitions = [
      { id: "walker_total", label: "Pedestrian" },
      { id: "pushbike_total", label: "Cyclist" },
      ...(site.directionDefinitions || []),
      ...(site.directionDefinitions || []).flatMap((definition) => [
        {
          id: `${definition.id}_ped`,
          label: `${definition.label} - Pedestrian`,
          splitGroup: definition.label,
          path: definition.path,
          direction: definition.direction,
          userType: "pedestrian",
          userTypeLabel: "Pedestrian"
        },
        {
          id: `${definition.id}_pcl`,
          label: `${definition.label} - Cyclist`,
          splitGroup: definition.label,
          path: definition.path,
          direction: definition.direction,
          userType: "cyclist",
          userTypeLabel: "Cyclist"
        }
      ])
    ];
  }

  const hydrated = hydrateSite(site, dataset, dataset.categoryDefinitions);
  appState.sites.set(hydrated.key, hydrated);
}

async function loadDataset(dataset) {
  if (dataset.source === "drakewell") {
    await loadDrakewellDataset(dataset);
    return;
  }

  const response = await fetch(dataset.file);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${dataset.file}`);
  }
  const payload = await response.json();
  dataset.categoryDefinitions = payload.categoryDefinitions || [];
  payload.sites.forEach((site) => {
    const hydrated = hydrateSite(site, dataset, dataset.categoryDefinitions);
    appState.sites.set(hydrated.key, hydrated);
  });
}

function rebuildSearchOptions() {
  const sites = visibleSites().sort((left, right) => left.council.localeCompare(right.council) || left.siteId - right.siteId);
  appState.searchLookup.clear();
  siteSearchOptions.innerHTML = "";

  sites.forEach((site) => {
    const label = `${site.siteId} | ${site.council}`;
    appState.searchLookup.set(label.toLowerCase(), site.key);
    const option = document.createElement("option");
    option.value = label;
    siteSearchOptions.appendChild(option);
  });
}

function setSelectedMarker(siteKey) {
  if (appState.selectedMarkerKey && appState.markerByKey.has(appState.selectedMarkerKey)) {
    const previousSite = appState.sites.get(appState.selectedMarkerKey);
    appState.markerByKey.get(appState.selectedMarkerKey).setStyle(markerStyle(previousSite, false));
  }

  appState.selectedMarkerKey = siteKey;
  if (siteKey && appState.markerByKey.has(siteKey)) {
    const site = appState.sites.get(siteKey);
    appState.markerByKey.get(siteKey).setStyle(markerStyle(site, true));
  }
}

function getDistinctRecords(site) {
  const uniqueByDate = new Map();
  site.records.forEach((record) => {
    if (!uniqueByDate.has(record.dateKey)) {
      uniqueByDate.set(record.dateKey, record);
    }
  });
  return [...uniqueByDate.values()];
}

function populateDateControl(selectElement, records, preferredValue) {
  const requestedValue = preferredValue || selectElement.value;
  selectElement.innerHTML = "";

  records.forEach((record, index) => {
    const option = document.createElement("option");
    option.value = record.dateKey;
    option.textContent = `${formatDateLabel(record.dateObj)}${index === records.length - 1 ? " (latest)" : ""}`;
    selectElement.appendChild(option);
  });

  if (selectElement.options.length === 0) {
    return;
  }

  const values = [...selectElement.options].map((option) => option.value);
  selectElement.value = values.includes(requestedValue)
    ? requestedValue
    : selectElement.options[selectElement.options.length - 1].value;
}

function updateDateOptions(site) {
  if (!dateSelect) {
    return;
  }
  const records = getDistinctRecords(site);
  populateDateControl(dateSelect, records, dateSelect.value);
}

function getSelectedRecord(site, dateKey) {
  return site.records.find((record) => record.dateKey === dateKey) || site.records.at(-1) || null;
}

function averageValue(values) {
  if (values.length === 0) {
    return null;
  }
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function buildDirectionalAverageRecord(site) {
  const legTotalsByLeg = new Map();
  const movementsByPair = new Map();

  site.records.forEach((record) => {
    (record.directional?.legTotals || []).forEach((leg) => {
      if (!legTotalsByLeg.has(leg.leg)) {
        legTotalsByLeg.set(leg.leg, { enter: [], exit: [], total: [] });
      }
      const bucket = legTotalsByLeg.get(leg.leg);
      if (leg.enter != null) {
        bucket.enter.push(Number(leg.enter));
      }
      if (leg.exit != null) {
        bucket.exit.push(Number(leg.exit));
      }
      if (leg.total != null) {
        bucket.total.push(Number(leg.total));
      }
    });

    (record.directional?.movements || []).forEach((movement) => {
      const key = `${movement.from}-${movement.to}`;
      if (!movementsByPair.has(key)) {
        movementsByPair.set(key, {
          from: movement.from,
          to: movement.to,
          values: []
        });
      }
      if (movement.value != null) {
        movementsByPair.get(key).values.push(Number(movement.value));
      }
    });
  });

  const legTotals = [...legTotalsByLeg.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([leg, bucket]) => ({
      leg,
      enter: averageValue(bucket.enter),
      exit: averageValue(bucket.exit),
      total: averageValue(bucket.total)
    }));

  const movements = [...movementsByPair.values()]
    .map((movement) => ({
      from: movement.from,
      to: movement.to,
      value: averageValue(movement.values)
    }))
    .filter((movement) => movement.value != null)
    .sort((left, right) => (left.from - right.from) || (left.to - right.to));

  return {
    directional: { legTotals, movements },
    dateObj: null
  };
}

function updateDateControlVisibility() {
  if (!dateSelectWrap) {
    return;
  }
  dateSelectWrap.classList.toggle("hidden", appState.chartMode === "year");
}

function availableCategoryDefinitions(site) {
  return (site.categoryDefinitions || []).filter((definition) => site.records.some((record) => {
    if (record.categories?.[definition.id] != null) {
      return true;
    }
    const points = record.categoryHourly?.[definition.id] || [];
    return points.some((point) => point.value != null);
  }));
}

function categoryHourlyValues(record, categoryId, x) {
  const points = record?.categoryHourly?.[categoryId] || [];
  const valueByTime = new Map(points.map((point) => [point.time, point.value]));
  const y = x.map((time) => {
    const value = valueByTime.get(time);
    return value == null ? null : value;
  });
  const hasData = y.some((value) => value != null);
  return { y, hasData };
}

function renderCategoryDayFallbackToTotal(site, record, message = "Category time-binned data is unavailable for this selection. Showing total hourly counts.") {
  Plotly.newPlot(
    chartElement,
    [
      {
        x: (record?.hourly || []).map((point) => point.time),
        y: (record?.hourly || []).map((point) => point.value),
        type: "scatter",
        mode: "lines+markers",
        line: { color: site.color, width: 2.5 },
        marker: { size: 6 },
        name: "Selected day total"
      }
    ],
    {
      margin: { t: 56, r: 16, b: 42, l: 42 },
      xaxis: { title: "Time of Day" },
      yaxis: { title: "Count" },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      annotations: [
        {
          text: message,
          showarrow: false,
          x: 0.5,
          y: 1.2,
          xref: "paper",
          yref: "paper",
          xanchor: "center",
          yanchor: "top",
          align: "center",
          bgcolor: "rgba(243, 248, 246, 0.96)",
          bordercolor: "#8fa8a1",
          borderwidth: 1,
          borderpad: 5,
          font: { size: 11, color: "#27423c" }
        }
      ],
      legend: { orientation: "h", y: -0.22 },
      font: { family: "Space Grotesk, sans-serif", color: "#11231f" }
    },
    { displayModeBar: false, responsive: true }
  );
}

function hasActiveSplit() {
  return appState.splitMode || appState.splitGender;
}

function legendSpacing(traceCount) {
  const itemsPerRow = window.innerWidth <= 900 ? 2 : 3;
  const rows = Math.max(1, Math.ceil(traceCount / itemsPerRow));
  return {
    marginBottom: 76 + Math.max(0, rows - 1) * 24,
    legendY: -0.24 - Math.max(0, rows - 1) * 0.12
  };
}

function categoryDimensions(definition) {
  const token = `${definition.id || ""} ${definition.label || ""}`.toLowerCase();

  let mode = "Other";
  if (token.includes("ebike") || token.includes("e-bike")) {
    mode = "E-bike";
  } else if (token.includes("micro") || token.includes("_mm") || token.includes(" mm")) {
    mode = "Micro mobility";
  } else if (token.includes("pushbike")) {
    mode = "Pushbike";
  } else if (token.includes("bicycle")) {
    mode = "Bicycle";
  } else if (token.includes("walker")) {
    mode = "Walker";
  } else if (token.includes("runner")) {
    mode = "Runner";
  } else if (token.includes("dog")) {
    mode = "Dog walker";
  }

  let gender = null;
  if (token.includes("women") || token.includes("female")) {
    gender = "Women";
  } else if (token.includes("men") || token.includes("male")) {
    gender = "Men";
  } else if (token.includes("not known") || token.includes("not_known") || token.includes("unknown")) {
    gender = "Unknown";
  }

  return { mode, gender };
}

function splitGroupForDefinition(definition) {
  if (IS_OTHER_MODE && definition.splitGroup) {
    const includePath = appState.splitPath;
    const includeDirection = appState.splitDirection;
    const includeUserType = appState.splitUserType;

    if (!includePath && !includeDirection && !includeUserType) {
      return null;
    }

    if (!includeUserType) {
      if (definition.userType && definition.userType !== "combined") {
        return null;
      }
    } else if (!definition.userType || definition.userType === "combined") {
      return null;
    }

    const parts = [];
    if (includePath) {
      parts.push(definition.path || "Other path");
    }
    if (includeDirection) {
      parts.push(definition.direction || "Other direction");
    }
    if (includeUserType) {
      const userTypeLabel = definition.userTypeLabel
        || (definition.userType === "pedestrian" ? "Pedestrian" : definition.userType === "cyclist" ? "Cyclist" : String(definition.userType || "Unknown"));
      parts.push(userTypeLabel);
    }

    if (parts.length === 0) {
      return null;
    }

    return {
      key: parts.join("||"),
      label: parts.join(" - "),
      mode: parts.join(" "),
      gender: null
    };
  }

  const dims = categoryDimensions(definition);
  const parts = [];

  if (appState.splitMode) {
    parts.push(dims.mode);
  }
  if (appState.splitGender) {
    if (!dims.gender) {
      return null;
    }
    parts.push(dims.gender);
  }
  if (parts.length === 0) {
    return null;
  }

  return {
    key: parts.join("||"),
    label: parts.join(" - "),
    mode: dims.mode,
    gender: dims.gender
  };
}

function splitGroupStyle(group, index) {
  const modeColor = {
    Pushbike: "#0077b6",
    "E-bike": "#ef476f",
    "Micro mobility": "#7b2cbf",
    Bicycle: "#2a9d8f",
    Walker: "#e9c46a",
    Runner: "#f4a261",
    "Dog walker": "#e76f51",
    Other: "#8d99ae"
  };
  const genderColor = {
    Women: "#1d3557",
    Men: "#2a9d8f",
    Unknown: "#6c757d"
  };
  const modeDash = {
    Pushbike: "solid",
    "E-bike": "dash",
    "Micro mobility": "dot",
    Bicycle: "solid",
    Walker: "longdash",
    Runner: "dashdot",
    "Dog walker": "longdashdot",
    Other: "solid"
  };
  const genderSymbol = {
    Women: "square",
    Men: "circle",
    Unknown: "diamond"
  };
  const fallbackColors = ["#4d908e", "#577590", "#f9844a", "#9c6644", "#6a4c93"];

  if (IS_OTHER_MODE) {
    return {
      color: fallbackColors[index % fallbackColors.length],
      dash: "solid",
      symbol: "circle"
    };
  }

  const color = appState.splitMode
    ? (modeColor[group.mode] || fallbackColors[index % fallbackColors.length])
    : (genderColor[group.gender] || fallbackColors[index % fallbackColors.length]);

  return {
    color,
    dash: appState.splitMode ? (modeDash[group.mode] || "solid") : "solid",
    symbol: appState.splitGender ? (genderSymbol[group.gender] || "diamond") : "circle"
  };
}

function showEmptyPlot(element, message) {
  Plotly.newPlot(
    element,
    [],
    {
      annotations: [{ text: message, showarrow: false, x: 0.5, y: 0.5, xref: "paper", yref: "paper" }],
      xaxis: { visible: false },
      yaxis: { visible: false },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)"
    },
    { displayModeBar: false, responsive: true }
  );
}

function renderTotalDayChart(site, record) {
  const averageSeries = averageHourlySeries(site.records);
  Plotly.newPlot(
    chartElement,
    [
      {
        x: record?.hourly.map((point) => point.time) || [],
        y: record?.hourly.map((point) => point.value) || [],
        type: "scatter",
        mode: "lines+markers",
        line: { color: site.color, width: 2.5 },
        marker: { size: 6 },
        name: "Selected day"
      },
      {
        x: averageSeries.map((point) => point.time),
        y: averageSeries.map((point) => point.value),
        type: "scatter",
        mode: "lines",
        line: { color: "#57686a", width: 2, dash: "dash" },
        name: "All-years average"
      }
    ],
    {
      margin: { t: 12, r: 16, b: 72, l: 42 },
      xaxis: { title: "Time of Day" },
      yaxis: { title: "Count" },
      legend: { orientation: "h", y: -0.22 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "Space Grotesk, sans-serif", color: "#11231f" }
    },
    { displayModeBar: false, responsive: true }
  );
}

function renderSplitDayChart(site, record) {
  const definitions = availableCategoryDefinitions(site);
  if (definitions.length === 0) {
    showEmptyPlot(chartElement, "No category breakdowns are available for this site.");
    return;
  }

  const chartDefinitions = definitions.filter((definition) => {
    if (record?.categories?.[definition.id] != null) {
      return true;
    }
    const points = record?.categoryHourly?.[definition.id] || [];
    return points.some((point) => point.value != null);
  });
  if (chartDefinitions.length === 0) {
    showEmptyPlot(chartElement, "No category breakdowns are available for the selected count date.");
    return;
  }

  const x = (record?.hourly || []).map((point) => point.time);
  if (x.length === 0) {
    showEmptyPlot(chartElement, "No time bins are available for this count date.");
    return;
  }

  const grouped = new Map();
  chartDefinitions.forEach((definition) => {
    const group = splitGroupForDefinition(definition);
    if (!group) {
      return;
    }
    const series = categoryHourlyValues(record, definition.id, x);
    if (!series.hasData) {
      return;
    }

    if (!grouped.has(group.key)) {
      grouped.set(group.key, {
        ...group,
        y: Array(x.length).fill(null)
      });
    }

    const current = grouped.get(group.key);
    series.y.forEach((value, index) => {
      if (value == null) {
        return;
      }
      current.y[index] = (current.y[index] ?? 0) + Number(value);
    });
  });

  const groups = [...grouped.values()]
    .filter((group) => group.y.some((value) => value != null))
    .sort((left, right) => left.label.localeCompare(right.label));

  const traces = groups.map((group, index) => {
    const style = splitGroupStyle(group, index);

    return {
      x,
      y: group.y.map((value) => (value == null ? null : Number(value.toFixed(2)))),
      type: "scatter",
      mode: "lines+markers",
      line: { color: style.color, width: 2.2, dash: style.dash },
      marker: { symbol: style.symbol, size: 8, color: style.color },
      connectgaps: false,
      legendgroup: group.key,
      name: group.label
    };
  });

  if (traces.length === 0) {
    renderCategoryDayFallbackToTotal(site, record, "Time-binned category data is unavailable for this split. Showing total hourly counts.");
    return;
  }

  Plotly.newPlot(
    chartElement,
    traces,
    {
      margin: { t: 56, r: 16, b: legendSpacing(traces.length).marginBottom, l: 42 },
      xaxis: { title: { text: "Time of Day", standoff: 14 } },
      yaxis: { title: "Count" },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      annotations: [
        {
          text: "Showing category time-binned counts split by selected dimensions.",
          showarrow: false,
          x: 0.5,
          y: 1.2,
          xref: "paper",
          yref: "paper",
          xanchor: "center",
          yanchor: "top",
          align: "center",
          bgcolor: "rgba(243, 248, 246, 0.96)",
          bordercolor: "#8fa8a1",
          borderwidth: 1,
          borderpad: 5,
          font: { size: 11, color: "#27423c" }
        }
      ],
      legend: { orientation: "h", y: legendSpacing(traces.length).legendY },
      font: { family: "Space Grotesk, sans-serif", color: "#11231f" }
    },
    { displayModeBar: false, responsive: true }
  );
}

function renderTotalYearChart(site) {
  const yearly = aggregateYearlyTotals(site.records);
  const years = [...yearly.keys()].sort((left, right) => left - right);
  if (years.length === 0) {
    showEmptyPlot(chartElement, "No year-level totals available for this site.");
    return;
  }

  const x = [];
  const y = [];
  for (let year = years[0]; year <= years[years.length - 1]; year += 1) {
    x.push(String(year));
    const values = yearly.get(year) || [];
    if (values.length === 0) {
      y.push(null);
      continue;
    }
    y.push(Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)));
  }

  Plotly.newPlot(
    chartElement,
    [{ x, y, type: "scatter", mode: "lines+markers", line: { color: site.color, width: 2.5 }, marker: { size: 7 }, connectgaps: false, name: "Yearly total" }],
    {
      margin: { t: 12, r: 16, b: 42, l: 42 },
      xaxis: { title: "Year" },
      yaxis: { title: "Total count" },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "Space Grotesk, sans-serif", color: "#11231f" }
    },
    { displayModeBar: false, responsive: true }
  );
}

function renderSplitYearChart(site) {
  const definitions = availableCategoryDefinitions(site);
  if (definitions.length === 0) {
    showEmptyPlot(chartElement, "No category breakdowns are available for this site.");
    return;
  }

  const grouped = new Map();
  site.records.forEach((record) => {
    if (!record.year) {
      return;
    }

    // Aggregate all category slices for a group within this record first,
    // then average those per-record totals by year.
    const recordGroupTotals = new Map();

    definitions.forEach((definition) => {
      const group = splitGroupForDefinition(definition);
      if (!group) {
        return;
      }

      const value = record.categories?.[definition.id];
      if (value == null) {
        return;
      }

      if (!recordGroupTotals.has(group.key)) {
        recordGroupTotals.set(group.key, {
          ...group,
          total: 0
        });
      }
      recordGroupTotals.get(group.key).total += Number(value);
    });

    recordGroupTotals.forEach((recordGroup) => {
      if (!grouped.has(recordGroup.key)) {
        grouped.set(recordGroup.key, {
          key: recordGroup.key,
          label: recordGroup.label,
          mode: recordGroup.mode,
          gender: recordGroup.gender,
          valuesByYear: new Map()
        });
      }

      const item = grouped.get(recordGroup.key);
      if (!item.valuesByYear.has(record.year)) {
        item.valuesByYear.set(record.year, []);
      }
      item.valuesByYear.get(record.year).push(recordGroup.total);
    });
  });

  const series = [...grouped.values()].filter((item) => item.valuesByYear.size > 0);
  if (series.length === 0) {
    renderTotalYearChart(site);
    return;
  }

  const knownYears = [...new Set(series.flatMap((item) => [...item.valuesByYear.keys()]))].sort((left, right) => left - right);
  const x = [];
  for (let year = knownYears[0]; year <= knownYears[knownYears.length - 1]; year += 1) {
    x.push(String(year));
  }

  Plotly.newPlot(
    chartElement,
    series.map((item, index) => {
      const style = splitGroupStyle(item, index);
      return {
        x,
        y: x.map((yearLabel) => {
          const values = item.valuesByYear.get(Number(yearLabel)) || [];
          if (values.length === 0) {
            return null;
          }
          return Number((values.reduce((sum, current) => sum + current, 0) / values.length).toFixed(2));
        }),
        type: "scatter",
        mode: "lines+markers",
        line: { color: style.color, width: 2, dash: style.dash },
        marker: { size: 6, symbol: style.symbol, color: style.color },
        connectgaps: false,
        name: item.label
      };
    }),
    {
      margin: { t: 12, r: 16, b: legendSpacing(series.length).marginBottom, l: 42 },
      xaxis: { title: { text: "Year", standoff: 14 } },
      yaxis: { title: "Category count" },
      legend: { orientation: "h", y: legendSpacing(series.length).legendY },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "Space Grotesk, sans-serif", color: "#11231f" }
    },
    { displayModeBar: false, responsive: true }
  );
}

function renderChart(site) {
  if (IS_OTHER_MODE) {
    renderOtherTimeSeries(site);
    return;
  }

  const selectedRecord = getSelectedRecord(site, dateSelect.value);
  if (appState.chartMode === "day") {
    if (hasActiveSplit()) {
      renderSplitDayChart(site, selectedRecord);
      return;
    }
    renderTotalDayChart(site, selectedRecord);
    return;
  }

  if (hasActiveSplit()) {
    renderSplitYearChart(site);
    return;
  }
  renderTotalYearChart(site);
}

function weekpartLabel(date) {
  const day = date.getDay();
  return day === 0 || day === 6 ? "Weekend" : "Weekday";
}

function seasonLabel(date) {
  const month = date.getMonth();
  if (month === 11 || month <= 1) {
    return "Summer";
  }
  if (month >= 2 && month <= 4) {
    return "Autumn";
  }
  if (month >= 5 && month <= 7) {
    return "Winter";
  }
  return "Spring";
}

function createOtherBaseSeries(records, splitDefinitions) {
  if (!(appState.splitPath || appState.splitDirection || appState.splitUserType)) {
    return [{
      key: "all",
      label: "All directions daily total",
      mode: "all",
      valuesByDate: new Map(records.map((record) => [record.dateKey, record.total]))
    }];
  }

  const grouped = new Map();
  splitDefinitions.forEach((definition) => {
    const group = splitGroupForDefinition(definition);
    if (!group) {
      return;
    }

    if (!grouped.has(group.key)) {
      grouped.set(group.key, {
        ...group,
        definitionIds: []
      });
    }
    grouped.get(group.key).definitionIds.push(definition.id);
  });

  return [...grouped.values()]
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((group) => ({
      key: group.key,
      label: group.label,
      mode: group.mode,
      valuesByDate: new Map(records.map((record) => {
        const value = group.definitionIds.reduce((sum, definitionId) => sum + (record.categories?.[definitionId] || 0), 0);
        return [record.dateKey, Number(value.toFixed(2))];
      }))
    }));
}

function smoothSeriesValues(yValues, windowSize) {
  const radius = Math.max(0, Math.floor(windowSize / 2));
  return yValues.map((value, index) => {
    if (value == null) {
      return null;
    }
    const start = Math.max(0, index - radius);
    const end = Math.min(yValues.length - 1, index + radius);
    const windowValues = [];
    for (let cursor = start; cursor <= end; cursor += 1) {
      const current = yValues[cursor];
      if (current != null) {
        windowValues.push(current);
      }
    }
    if (windowValues.length === 0) {
      return null;
    }
    return Number((windowValues.reduce((sum, current) => sum + current, 0) / windowValues.length).toFixed(2));
  });
}

function smoothingWindowChoices(binMinutes = 5) {
  const base = Math.max(1, Number(binMinutes) || 5);
  return [...new Set([base, base * 6, base * 12])].sort((left, right) => left - right);
}

function syncSmoothingWindowOptions(site) {
  if (!IS_OTHER_MODE || !smoothWindowInput) {
    return;
  }

  const nativeBinMinutes = Math.max(1, Number(site?.binMinutes) || 5);
  const choices = smoothingWindowChoices(nativeBinMinutes);
  const requested = Number(appState.smoothWindowMinutes) || choices[Math.min(1, choices.length - 1)] || nativeBinMinutes;
  const selected = choices.includes(requested)
    ? requested
    : choices[Math.min(1, choices.length - 1)] || nativeBinMinutes;

  smoothWindowInput.innerHTML = "";
  choices.forEach((minutes) => {
    const option = document.createElement("option");
    option.value = String(minutes);
    option.textContent = minutes === nativeBinMinutes
      ? `${minutes} minutes (native)`
      : `${minutes} minutes`;
    smoothWindowInput.appendChild(option);
  });

  appState.smoothWindowMinutes = selected;
  smoothWindowInput.value = String(selected);
}

function getSmoothingWindowPoints(binMinutes = 5) {
  const minutes = Number(appState.smoothWindowMinutes) || 5;
  const sourceBinMinutes = Math.max(1, Number(binMinutes) || 5);
  return Math.max(1, Math.round(minutes / sourceBinMinutes));
}

function applySmoothingToTraces(traces, binMinutes = 5) {
  if (!IS_OTHER_MODE || !appState.smoothSeries) {
    return traces;
  }
  const window = getSmoothingWindowPoints(binMinutes);
  if (window <= 1) {
    return traces;
  }
  return traces.map((trace) => {
    if (!Array.isArray(trace.y) || trace.y.length < 3) {
      return trace;
    }
    return {
      ...trace,
      y: smoothSeriesValues(trace.y, window),
      name: `${trace.name} (smoothed)`
    };
  });
}

function expandOtherFacetSeries(baseSeries, records) {
  const includeBase = baseSeries.length > 1;
  const groups = new Map();

  records.forEach((record) => {
    const date = parseDate(record.dateKey);
    if (!date) {
      return;
    }

    baseSeries.forEach((series) => {
      const value = series.valuesByDate.get(record.dateKey);
      if (value == null) {
        return;
      }

      const parts = [];
      if (includeBase) {
        parts.push(series.label);
      }
      if (appState.splitWeekpart) {
        parts.push(weekpartLabel(date));
      }
      if (appState.splitSeason) {
        parts.push(seasonLabel(date));
      }

      const key = parts.length ? parts.join("||") : series.key;
      const label = parts.length ? parts.join(" - ") : series.label;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label,
          mode: label,
          points: []
        });
      }
      groups.get(key).points.push({ date, dateKey: record.dateKey, value: Number(value) });
    });
  });

  return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function aggregateSeriesPoints(seriesGroups, mode) {
  const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  if (mode === "weekly") {
    const x = weekdayLabels;
    const traces = seriesGroups.map((group, index) => {
      const byBucket = new Map();
      group.points.forEach((point) => {
        const bucket = (point.date.getDay() + 6) % 7;
        if (!byBucket.has(bucket)) {
          byBucket.set(bucket, []);
        }
        byBucket.get(bucket).push(point.value);
      });

      const style = splitGroupStyle(group, index);
      return {
        x,
        y: x.map((_, bucket) => {
          const values = byBucket.get(bucket) || [];
          if (values.length === 0) {
            return null;
          }
          return Number((values.reduce((sum, current) => sum + current, 0) / values.length).toFixed(2));
        }),
        type: "scatter",
        mode: "lines+markers",
        line: { color: style.color, width: 2.2 },
        marker: { size: 6, color: style.color },
        connectgaps: false,
        name: group.label
      };
    });

    return {
      traces,
      xaxis: { title: { text: "Day of week", standoff: 14 }, type: "category" },
      yaxisTitle: "Mean daily count",
      chartTitle: "Weekly Climatology"
    };
  }

  if (mode === "annual") {
    const x = monthLabels;
    const traces = seriesGroups.map((group, index) => {
      const byBucket = new Map();
      group.points.forEach((point) => {
        const bucket = point.date.getMonth();
        if (!byBucket.has(bucket)) {
          byBucket.set(bucket, []);
        }
        byBucket.get(bucket).push(point.value);
      });

      const style = splitGroupStyle(group, index);
      return {
        x,
        y: x.map((_, bucket) => {
          const values = byBucket.get(bucket) || [];
          if (values.length === 0) {
            return null;
          }
          return Number((values.reduce((sum, current) => sum + current, 0) / values.length).toFixed(2));
        }),
        type: "scatter",
        mode: "lines+markers",
        line: { color: style.color, width: 2.2 },
        marker: { size: 6, color: style.color },
        connectgaps: false,
        name: group.label
      };
    });

    return {
      traces,
      xaxis: { title: { text: "Month", standoff: 14 }, type: "category" },
      yaxisTitle: "Mean daily count",
      chartTitle: "Annual Climatology"
    };
  }

  const traces = seriesGroups.map((group, index) => {
    const style = splitGroupStyle(group, index);
    return {
      x: group.points.map((point) => point.dateKey),
      y: group.points.map((point) => Number(point.value.toFixed(2))),
      type: "scatter",
      mode: "lines+markers",
      line: { color: style.color, width: 2.2 },
      marker: { size: 6, color: style.color },
      connectgaps: false,
      name: group.label
    };
  });

  return {
    traces,
    xaxis: { title: { text: "Date", standoff: 14 }, type: "date" },
    yaxisTitle: "Daily count",
    chartTitle: "Daily Trend"
  };
}

function aggregateOtherTimeOfDayClimatology(records, splitDefinitions, flowUnit = "People", binMinutes = 5) {
  const includeBaseSplit = appState.splitPath || appState.splitDirection || appState.splitUserType;
  const includeWeekpart = appState.splitWeekpart;
  const includeSeason = appState.splitSeason;

  const baseGroups = includeBaseSplit
    ? (() => {
      const grouped = new Map();
      splitDefinitions.forEach((definition) => {
        const group = splitGroupForDefinition(definition);
        if (!group) {
          return;
        }
        if (!grouped.has(group.key)) {
          grouped.set(group.key, {
            key: group.key,
            label: group.label,
            mode: group.mode,
            definitionIds: []
          });
        }
        grouped.get(group.key).definitionIds.push(definition.id);
      });
      return [...grouped.values()].sort((left, right) => left.label.localeCompare(right.label));
    })()
    : [{ key: "all", label: "All directions", mode: "all", definitionIds: null }];

  const groupedSeries = new Map();
  const allTimeBins = new Set();

  records.forEach((record) => {
    const date = parseDate(record.dateKey);
    if (!date) {
      return;
    }

    const facetParts = [];
    if (includeWeekpart) {
      facetParts.push(weekpartLabel(date));
    }
    if (includeSeason) {
      facetParts.push(seasonLabel(date));
    }

    baseGroups.forEach((base) => {
      const labelParts = [];
      if (includeBaseSplit) {
        labelParts.push(base.label);
      }
      labelParts.push(...facetParts);

      const seriesLabel = labelParts.length ? labelParts.join(" - ") : "All directions";
      const seriesKey = labelParts.length ? labelParts.join("||") : "all";

      if (!groupedSeries.has(seriesKey)) {
        groupedSeries.set(seriesKey, {
          key: seriesKey,
          label: seriesLabel,
          mode: seriesLabel,
          valuesByTime: new Map()
        });
      }

      const destination = groupedSeries.get(seriesKey);

      if (!base.definitionIds) {
        (record.hourly || []).forEach((point) => {
          if (point.value == null || !point.time) {
            return;
          }
          allTimeBins.add(point.time);
          if (!destination.valuesByTime.has(point.time)) {
            destination.valuesByTime.set(point.time, []);
          }
          destination.valuesByTime.get(point.time).push(Number(point.value));
        });
        return;
      }

      const summedByTime = new Map();
      base.definitionIds.forEach((definitionId) => {
        (record.categoryHourly?.[definitionId] || []).forEach((point) => {
          if (point.value == null || !point.time) {
            return;
          }
          summedByTime.set(point.time, (summedByTime.get(point.time) || 0) + Number(point.value));
        });
      });

      summedByTime.forEach((value, time) => {
        allTimeBins.add(time);
        if (!destination.valuesByTime.has(time)) {
          destination.valuesByTime.set(time, []);
        }
        destination.valuesByTime.get(time).push(value);
      });
    });
  });

  const x = [...allTimeBins].sort((left, right) => left.localeCompare(right));
  const xDate = x.map((time) => `2000-01-01T${time}:00`);
  const groups = [...groupedSeries.values()].sort((left, right) => left.label.localeCompare(right.label));

  const traces = groups.map((group, index) => {
    const style = splitGroupStyle(group, index);
    return {
      x: xDate,
      y: x.map((time) => {
        const values = group.valuesByTime.get(time) || [];
        if (values.length === 0) {
          return null;
        }
        // Convert mean bin count to an hourly rate based on source bin width.
        const multiplier = 60 / Math.max(1, Number(binMinutes) || 5);
        return Number(((values.reduce((sum, current) => sum + current, 0) / values.length) * multiplier).toFixed(2));
      }),
      type: "scatter",
      mode: "lines+markers",
      line: { color: style.color, width: 2.2 },
      marker: { size: 5, color: style.color },
      connectgaps: false,
      name: group.label
    };
  });

  return {
    traces,
    xaxis: {
      title: { text: "Time of day", standoff: 14 },
      type: "date",
      tickformat: "%H:%M"
    },
    yaxisTitle: `${flowUnit} per hour`,
    chartTitle: "Daily Climatology"
  };
}

function renderOtherTimeSeries(site) {
  const records = getDistinctRecords(site).sort((left, right) => (left.dateKey || "").localeCompare(right.dateKey || ""));
  if (records.length === 0) {
    showEmptyPlot(chartElement, "No daily rows are available for this site.");
    return;
  }

  const splitDefinitions = (site.categoryDefinitions || []).filter((definition) => definition.splitGroup);
  const seriesMode = appState.otherSeriesMode || "daily";
  const aggregated = seriesMode === "daily"
    ? aggregateOtherTimeOfDayClimatology(records, splitDefinitions, site.flowUnit || "People", site.binMinutes || 5)
    : aggregateSeriesPoints(expandOtherFacetSeries(createOtherBaseSeries(records, splitDefinitions), records), seriesMode);
  const traces = applySmoothingToTraces(aggregated.traces, site.binMinutes || 5);

  if (traces.length === 0) {
    showEmptyPlot(chartElement, "No rows match the selected time-series disaggregation options.");
    return;
  }

  Plotly.newPlot(
    chartElement,
    traces,
    {
      margin: { t: 12, r: 16, b: legendSpacing(traces.length).marginBottom, l: 42 },
      xaxis: aggregated.xaxis,
      yaxis: { title: aggregated.yaxisTitle },
      title: { text: aggregated.chartTitle, font: { size: 14 } },
      legend: { orientation: "h", y: legendSpacing(traces.length).legendY },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "Space Grotesk, sans-serif", color: "#11231f" }
    },
    { displayModeBar: false, responsive: true }
  );
}

function formatLegLabel(site, legNumber) {
  const roadLabel = site.roadLabels?.[legNumber - 1] || `Leg ${legNumber}`;
  return `L${legNumber} ${roadLabel}`;
}

function renderDirectionalMatrix(site, record) {
  const movements = record?.directional?.movements || [];
  if (movements.length === 0) {
    directionalMatrix.innerHTML = '<div class="matrix-empty">No leg-to-leg directional movements are available for this count date.</div>';
    return;
  }

  const movementMap = new Map(movements.map((movement) => [`${movement.from}-${movement.to}`, movement.value]));
  const headers = Array.from({ length: site.legs }, (_, index) => index + 1);
  const rows = headers.map((fromLeg) => {
    const cells = headers.map((toLeg) => {
      if (fromLeg === toLeg) {
        return '<td>&mdash;</td>';
      }
      const value = movementMap.get(`${fromLeg}-${toLeg}`);
      return `<td>${value ?? '&mdash;'}</td>`;
    }).join("");
    return `<tr><th scope="row">${formatLegLabel(site, fromLeg)}</th>${cells}</tr>`;
  }).join("");

  directionalMatrix.innerHTML = `
    <table class="matrix-table">
      <thead>
        <tr>
          <th>From \\ To</th>
          ${headers.map((leg) => `<th>${formatLegLabel(site, leg)}</th>`).join("")}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderDirectionalPanel(site) {
  const isAllYears = appState.chartMode === "year";
  const record = isAllYears ? buildDirectionalAverageRecord(site) : getSelectedRecord(site, dateSelect.value);
  if (!record) {
    showEmptyPlot(directionalChart, "No directional data is available for this site.");
    directionalSummary.textContent = "";
    directionalMatrix.innerHTML = '<div class="matrix-empty">No directional data is available for this site.</div>';
    return;
  }

  const legTotals = (record.directional?.legTotals || []).filter((item) => item.enter != null || item.exit != null || item.total != null);
  directionalSummary.textContent = isAllYears
    ? "Directional values averaged across all available years. Bars show per-leg entry and exit means; the matrix shows average from-leg to to-leg movements."
    : `Directional values for ${formatDateLabel(record.dateObj)}. Bars show per-leg entry and exit totals; the matrix shows from-leg to to-leg movements.`;

  if (legTotals.length === 0) {
    showEmptyPlot(
      directionalChart,
      isAllYears
        ? "No per-leg directional totals are available to average across years."
        : "No per-leg directional totals are available for this count date."
    );
  } else {
    const labels = legTotals.map((item) => formatLegLabel(site, item.leg));
    Plotly.newPlot(
      directionalChart,
      [
        { x: labels, y: legTotals.map((item) => item.enter), type: "bar", name: "Enter", marker: { color: "#2a9d8f" } },
        { x: labels, y: legTotals.map((item) => item.exit), type: "bar", name: "Exit", marker: { color: "#e76f51" } }
      ],
      {
        margin: { t: 12, r: 16, b: 96, l: 42 },
        barmode: "group",
        xaxis: { title: "Leg", tickangle: -24 },
        yaxis: { title: "Directional count" },
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        font: { family: "Space Grotesk, sans-serif", color: "#11231f" }
      },
      { displayModeBar: false, responsive: true }
    );
  }

  renderDirectionalMatrix(site, record);
}

function showDetail(site) {
  emptyState.classList.add("hidden");
  detailState.classList.remove("hidden");

  siteTitle.textContent = site.counterName
    ? `${site.counterName} (${site.siteId})`
    : `Site ${site.siteId}`;
  siteChip.textContent = site.datasetId.toUpperCase();
  siteChip.style.background = site.color;
  siteMeta.textContent = `${site.council}, ${site.state} | ${site.description || "No description"}`;

  syncSmoothingWindowOptions(site);
  updateDateOptions(site);
  updateDateControlVisibility();
  drawIntersectionInset(site);
  renderChart(site);
  if (!IS_OTHER_MODE) {
    renderDirectionalPanel(site);
  }
}

function focusSite(site) {
  const marker = appState.markerByKey.get(site.key);
  if (!marker) {
    return;
  }

  markerLayer.zoomToShowLayer(marker, () => {
    map.flyTo([site.latitude, site.longitude], Math.max(map.getZoom(), 15), { duration: 0.7 });
    marker.openTooltip();
    selectSite(site, false);
  });
}

function selectSite(site, focusMap = false) {
  appState.selectedSite = site;
  setSelectedMarker(site.key);
  showDetail(site);
  if (focusMap) {
    focusSite(site);
  }
}

function clearSelectedSite() {
  appState.selectedSite = null;
  setSelectedMarker(null);
  emptyState.classList.remove("hidden");
  detailState.classList.add("hidden");
}

function performSearch() {
  const query = siteSearch.value.trim().toLowerCase();
  if (!query) {
    return;
  }

  const sites = visibleSites();
  const exactKey = appState.searchLookup.get(query);
  let matchedSite = exactKey ? appState.sites.get(exactKey) : null;

  if (!matchedSite) {
    matchedSite = sites.find((site) => String(site.siteId).toLowerCase() === query)
      || sites.find((site) => site.council.toLowerCase().includes(query));
  }

  if (!matchedSite) {
    setStatus(`No visible site matches '${siteSearch.value}'.`, false);
    window.setTimeout(() => setStatus("", true), 1800);
    return;
  }

  selectSite(matchedSite, true);
}

function renderMarkers(fitToBounds = true) {
  markerLayer.clearLayers();
  appState.markerByKey.clear();

  const sites = visibleSites();
  const selectedVisible = appState.selectedSite
    ? sites.some((site) => site.key === appState.selectedSite.key)
    : false;
  if (!selectedVisible && appState.selectedSite) {
    clearSelectedSite();
  }

  const bounds = [];
  sites.forEach((site) => {
    const marker = L.circleMarker([site.latitude, site.longitude], markerStyle(site, site.key === appState.selectedMarkerKey));
    marker.bindTooltip(`${site.datasetId.toUpperCase()} ${site.siteId} - ${site.council}`, {
      direction: "top",
      opacity: 0.9
    });
    marker.on("click", () => selectSite(site, false));
    markerLayer.addLayer(marker);
    appState.markerByKey.set(site.key, marker);
    bounds.push([site.latitude, site.longitude]);
  });

  rebuildSearchOptions();
  if (fitToBounds && bounds.length > 0) {
    map.fitBounds(L.latLngBounds(bounds).pad(0.1));
  }

  renderDashboardStats();

  if (IS_OTHER_MODE && sites.length === 1 && !appState.selectedSite) {
    selectSite(sites[0], false);
  }
}

function drawArrow(ctx, fromX, fromY, toX, toY, color, dashed = false) {
  ctx.save();
  if (dashed) {
    ctx.setLineDash([6, 6]);
  }
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();
  ctx.setLineDash([]);

  const angle = Math.atan2(toY - fromY, toX - fromX);
  const headLength = 8;
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - headLength * Math.cos(angle - Math.PI / 8), toY - headLength * Math.sin(angle - Math.PI / 8));
  ctx.lineTo(toX - headLength * Math.cos(angle + Math.PI / 8), toY - headLength * Math.sin(angle + Math.PI / 8));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function degToRad(value) {
  return (value * Math.PI) / 180;
}

function lonToWorldX(lon, zoom) {
  const scale = 256 * 2 ** zoom;
  return ((lon + 180) / 360) * scale;
}

function latToWorldY(lat, zoom) {
  const scale = 256 * 2 ** zoom;
  const latRad = degToRad(lat);
  const mercN = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  return (scale * (1 - mercN / Math.PI)) / 2;
}

function normalizeTileX(x, zoom) {
  const limit = 2 ** zoom;
  return ((x % limit) + limit) % limit;
}

function isValidTileY(y, zoom) {
  const limit = 2 ** zoom;
  return y >= 0 && y < limit;
}

function loadInsetTile(url) {
  if (insetTileCache.has(url)) {
    return insetTileCache.get(url);
  }

  const promise = new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load tile: ${url}`));
    image.src = url;
  });

  insetTileCache.set(url, promise);
  return promise;
}

function drawInsetFallback(ctx, width, height) {
  ctx.fillStyle = "#eff7ed";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(86, 116, 109, 0.18)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += 24) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += 24) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

async function drawInsetMapBackground(ctx, site, width, height, renderToken) {
  const zoom = appState.insetZoom;
  const worldCenterX = lonToWorldX(site.longitude, zoom);
  const worldCenterY = latToWorldY(site.latitude, zoom);
  const worldLeft = worldCenterX - width / 2;
  const worldTop = worldCenterY - height / 2;
  const worldRight = worldLeft + width;
  const worldBottom = worldTop + height;
  const tileMinX = Math.floor(worldLeft / 256);
  const tileMaxX = Math.floor(worldRight / 256);
  const tileMinY = Math.floor(worldTop / 256);
  const tileMaxY = Math.floor(worldBottom / 256);
  const tileJobs = [];

  for (let tileX = tileMinX; tileX <= tileMaxX; tileX += 1) {
    for (let tileY = tileMinY; tileY <= tileMaxY; tileY += 1) {
      if (!isValidTileY(tileY, zoom)) {
        continue;
      }
      const normalizedTileX = normalizeTileX(tileX, zoom);
      tileJobs.push({
        tileX,
        tileY,
        url: `https://tile.openstreetmap.org/${zoom}/${normalizedTileX}/${tileY}.png`
      });
    }
  }

  const tiles = await Promise.all(tileJobs.map(async (job) => {
    try {
      const image = await loadInsetTile(job.url);
      return { ...job, image };
    } catch {
      return null;
    }
  }));

  if (renderToken !== appState.insetRenderToken) {
    return false;
  }

  const available = tiles.filter(Boolean);
  if (available.length === 0) {
    return false;
  }

  available.forEach((tile) => {
    ctx.drawImage(tile.image, tile.tileX * 256 - worldLeft, tile.tileY * 256 - worldTop, 256, 256);
  });
  ctx.fillStyle = "rgba(244, 250, 240, 0.26)";
  ctx.fillRect(0, 0, width, height);
  return true;
}

function drawIntersectionOverlay(ctx, site, width, height) {
  const centerX = width * 0.5;
  const centerY = height * 0.5;
  const maxRadius = Math.min(width, height) * 0.38;

  ctx.fillStyle = "rgba(229, 243, 234, 0.92)";
  ctx.beginPath();
  ctx.arc(centerX, centerY, 24, 0, Math.PI * 2);
  ctx.fill();

  const legCount = Math.max(1, Math.min(6, site.legs || 0));
  for (let index = 1; index <= legCount; index += 1) {
    const exit = site.exitLayout[index - 1];
    if (exit == null) {
      continue;
    }
    const exitRad = ((exit - 90) * Math.PI) / 180;
    const exitX = centerX + Math.cos(exitRad) * maxRadius;
    const exitY = centerY + Math.sin(exitRad) * maxRadius;

    drawArrow(ctx, centerX, centerY, exitX, exitY, site.color, false);

    const labelX = centerX + Math.cos(exitRad) * (maxRadius + 15);
    const labelY = centerY + Math.sin(exitRad) * (maxRadius + 15);
    const roadLabel = site.roadLabels[index - 1] || `Leg ${index}`;

    ctx.fillStyle = "#1e332f";
    ctx.font = "600 12px 'IBM Plex Mono', monospace";
    ctx.textAlign = labelX > centerX ? "left" : "right";
    ctx.textBaseline = "middle";
    ctx.fillText(`L${index} ${roadLabel}`, labelX, labelY);
  }
}

async function drawIntersectionInset(site) {
  const renderToken = ++appState.insetRenderToken;
  const canvas = document.getElementById("intersection-canvas");
  const ctx = canvas.getContext("2d");
  const pixelRatio = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth;
  const cssHeight = 260;

  insetZoomValue.textContent = String(appState.insetZoom);
  insetNote.textContent = `Loading map background at zoom ${appState.insetZoom}. Solid arrows = exit azimuth (layout_n).`;

  if (canvas.width !== Math.floor(cssWidth * pixelRatio)) {
    canvas.width = Math.floor(cssWidth * pixelRatio);
    canvas.height = Math.floor(cssHeight * pixelRatio);
  }

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  drawInsetFallback(ctx, cssWidth, cssHeight);
  drawIntersectionOverlay(ctx, site, cssWidth, cssHeight);

  const hasBackground = await drawInsetMapBackground(ctx, site, cssWidth, cssHeight, renderToken);
  if (renderToken !== appState.insetRenderToken) {
    return;
  }
  if (hasBackground) {
    drawIntersectionOverlay(ctx, site, cssWidth, cssHeight);
  }

  insetNote.textContent = hasBackground
    ? `Background map tiles are from OpenStreetMap at zoom ${appState.insetZoom}. Solid arrows = exit azimuth (layout_n).`
    : `Map tiles could not be loaded, so the inset is showing the fallback grid. Solid arrows = exit azimuth (layout_n).`;
}

function wireEvents() {
  datasetFilter.addEventListener("change", () => {
    appState.statsDataset = datasetFilter.value;
    refreshStatsCityOptions();
    renderMarkers();
  });

  siteSearchButton.addEventListener("click", performSearch);
  siteSearch.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      performSearch();
    }
  });

  insetZoom.addEventListener("input", (event) => {
    appState.insetZoom = Number(event.target.value);
    insetZoomValue.textContent = String(appState.insetZoom);
    if (appState.selectedSite) {
      drawIntersectionInset(appState.selectedSite);
    }
  });

  if (splitModeInput) {
    splitModeInput.addEventListener("change", () => {
      appState.splitMode = splitModeInput.checked;
      if (appState.selectedSite) {
        renderChart(appState.selectedSite);
      }
    });
  }

  if (splitPathInput) {
    splitPathInput.addEventListener("change", () => {
      appState.splitPath = splitPathInput.checked;
      if (appState.selectedSite) {
        renderChart(appState.selectedSite);
      }
    });
  }

  if (splitDirectionInput) {
    splitDirectionInput.addEventListener("change", () => {
      appState.splitDirection = splitDirectionInput.checked;
      if (appState.selectedSite) {
        renderChart(appState.selectedSite);
      }
    });
  }

  if (splitUserTypeInput) {
    splitUserTypeInput.addEventListener("change", () => {
      appState.splitUserType = splitUserTypeInput.checked;
      if (appState.selectedSite) {
        renderChart(appState.selectedSite);
      }
    });
  }

  if (splitWeekpartInput) {
    splitWeekpartInput.addEventListener("change", () => {
      appState.splitWeekpart = splitWeekpartInput.checked;
      if (appState.selectedSite) {
        renderChart(appState.selectedSite);
      }
    });
  }

  if (splitSeasonInput) {
    splitSeasonInput.addEventListener("change", () => {
      appState.splitSeason = splitSeasonInput.checked;
      if (appState.selectedSite) {
        renderChart(appState.selectedSite);
      }
    });
  }

  if (otherSeriesModeInput) {
    otherSeriesModeInput.addEventListener("change", () => {
      appState.otherSeriesMode = otherSeriesModeInput.value;
      if (appState.selectedSite) {
        renderChart(appState.selectedSite);
      }
    });
  }

  if (smoothSeriesInput) {
    smoothSeriesInput.addEventListener("change", () => {
      appState.smoothSeries = smoothSeriesInput.checked;
      if (appState.selectedSite) {
        renderChart(appState.selectedSite);
      }
    });
  }

  if (smoothWindowInput) {
    smoothWindowInput.addEventListener("change", () => {
      appState.smoothWindowMinutes = Number(smoothWindowInput.value)
        || Number(appState.selectedSite?.binMinutes)
        || 5;
      if (appState.selectedSite) {
        renderChart(appState.selectedSite);
      }
    });
  }

  if (splitGenderInput) {
    splitGenderInput.addEventListener("change", () => {
      appState.splitGender = splitGenderInput.checked;
      if (appState.selectedSite) {
        renderChart(appState.selectedSite);
      }
    });
  }

  if (dateSelect) {
    dateSelect.addEventListener("change", () => {
      if (appState.selectedSite) {
        if (appState.chartMode === "day") {
          renderChart(appState.selectedSite);
        }
        if (!IS_OTHER_MODE) {
          renderDirectionalPanel(appState.selectedSite);
        }
      }
    });
  }

  chartModeInputs.forEach((input) => {
    input.addEventListener("change", (event) => {
      appState.chartMode = event.target.value;
      updateDateControlVisibility();
      if (appState.selectedSite) {
        renderChart(appState.selectedSite);
        if (!IS_OTHER_MODE) {
          renderDirectionalPanel(appState.selectedSite);
        }
      }
    });
  });

  statsCityFilter.addEventListener("change", () => {
    appState.statsCity = statsCityFilter.value;
    renderMarkers();
  });

  statsVolumeMode.addEventListener("change", () => {
    appState.statsVolumeMode = statsVolumeMode.value;
    renderDashboardStats();
  });

  map.on("moveend", () => {
    renderDashboardStats();
  });

  map.on("zoomend", () => {
    renderDashboardStats();
  });
}

async function bootstrap() {
  setStatus(APP_MODE === "other" ? "Loading external dataset..." : "Loading preprocessed datasets...");
  for (const dataset of DATASETS) {
    setStatus(`Loading ${dataset.name}...`);
    await loadDataset(dataset);
  }
  wireEvents();
  appState.statsDataset = datasetFilter.value;
  renderMarkers();
  refreshStatsCityOptions();
  statsVolumeMode.value = appState.statsVolumeMode;
  if (IS_OTHER_MODE && splitGenderInput) {
    splitGenderInput.checked = false;
    splitGenderInput.disabled = true;
  }
  if (IS_OTHER_MODE && otherSeriesModeInput) {
    otherSeriesModeInput.value = appState.otherSeriesMode;
  }
  if (IS_OTHER_MODE && smoothWindowInput) {
    smoothWindowInput.value = String(appState.smoothWindowMinutes);
  }
  updateDateControlVisibility();
  renderDashboardStats();
  setStatus(`Loaded ${appState.sites.size} intersections`, false);
  window.setTimeout(() => setStatus("", true), 2200);
}

bootstrap().catch((error) => {
  console.error(error);
  setStatus(`Failed to load data: ${error.message}`, false);
});
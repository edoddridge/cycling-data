const DATASETS = [
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

const appState = {
  sites: new Map(),
  markerByKey: new Map(),
  searchLookup: new Map(),
  selectedMarkerKey: null,
  selectedSite: null,
  chartMode: "day",
  splitMode: false,
  splitGender: false,
  insetRenderToken: 0,
  insetZoom: 16
};

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
const directionalSummary = document.getElementById("directional-summary");
const directionalChart = document.getElementById("directional-chart");
const directionalMatrix = document.getElementById("directional-matrix");
const splitModeInput = document.getElementById("split-mode");
const splitGenderInput = document.getElementById("split-gender");
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
  return [...appState.sites.values()].filter((site) => filter === "all" || site.datasetId === filter);
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

async function loadDataset(dataset) {
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
  const records = getDistinctRecords(site);
  populateDateControl(dateSelect, records, dateSelect.value);
}

function getSelectedRecord(site, dateKey) {
  return site.records.find((record) => record.dateKey === dateKey) || site.records.at(-1) || null;
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
    definitions.forEach((definition) => {
      const group = splitGroupForDefinition(definition);
      if (!group) {
        return;
      }

      const value = record.categories?.[definition.id];
      if (value == null) {
        return;
      }

      if (!grouped.has(group.key)) {
        grouped.set(group.key, {
          ...group,
          valuesByYear: new Map()
        });
      }

      const item = grouped.get(group.key);
      if (!item.valuesByYear.has(record.year)) {
        item.valuesByYear.set(record.year, []);
      }
      item.valuesByYear.get(record.year).push(Number(value));
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
  const record = getSelectedRecord(site, dateSelect.value);
  if (!record) {
    showEmptyPlot(directionalChart, "No directional data is available for this site.");
    directionalSummary.textContent = "";
    directionalMatrix.innerHTML = '<div class="matrix-empty">No directional data is available for this site.</div>';
    return;
  }

  const legTotals = (record.directional?.legTotals || []).filter((item) => item.enter != null || item.exit != null || item.total != null);
  directionalSummary.textContent = `Directional values for ${formatDateLabel(record.dateObj)}. Bars show per-leg entry and exit totals; the matrix shows from-leg to to-leg movements.`;

  if (legTotals.length === 0) {
    showEmptyPlot(directionalChart, "No per-leg directional totals are available for this count date.");
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

  siteTitle.textContent = `Site ${site.siteId}`;
  siteChip.textContent = site.datasetId.toUpperCase();
  siteChip.style.background = site.color;
  siteMeta.textContent = `${site.council}, ${site.state} | ${site.description || "No description"}`;

  updateDateOptions(site);
  drawIntersectionInset(site);
  renderChart(site);
  renderDirectionalPanel(site);
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

function performSearch() {
  const query = siteSearch.value.trim().toLowerCase();
  if (!query) {
    return;
  }

  const sites = visibleSites();
  const exactKey = appState.searchLookup.get(query);
  let matchedSite = exactKey ? appState.sites.get(exactKey) : null;

  if (!matchedSite) {
    matchedSite = sites.find((site) => String(site.siteId) === query)
      || sites.find((site) => site.council.toLowerCase().includes(query));
  }

  if (!matchedSite) {
    setStatus(`No visible site matches '${siteSearch.value}'.`, false);
    window.setTimeout(() => setStatus("", true), 1800);
    return;
  }

  selectSite(matchedSite, true);
}

function renderMarkers() {
  markerLayer.clearLayers();
  appState.markerByKey.clear();

  const sites = visibleSites();
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
  if (bounds.length > 0) {
    map.fitBounds(L.latLngBounds(bounds).pad(0.1));
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

  splitModeInput.addEventListener("change", () => {
    appState.splitMode = splitModeInput.checked;
    if (appState.selectedSite) {
      renderChart(appState.selectedSite);
    }
  });

  splitGenderInput.addEventListener("change", () => {
    appState.splitGender = splitGenderInput.checked;
    if (appState.selectedSite) {
      renderChart(appState.selectedSite);
    }
  });

  dateSelect.addEventListener("change", () => {
    if (appState.selectedSite) {
      if (appState.chartMode === "day") {
        renderChart(appState.selectedSite);
      }
      renderDirectionalPanel(appState.selectedSite);
    }
  });

  chartModeInputs.forEach((input) => {
    input.addEventListener("change", (event) => {
      appState.chartMode = event.target.value;
      if (appState.selectedSite) {
        renderChart(appState.selectedSite);
      }
    });
  });
}

async function bootstrap() {
  setStatus("Loading preprocessed datasets...");
  for (const dataset of DATASETS) {
    setStatus(`Loading ${dataset.name}...`);
    await loadDataset(dataset);
  }
  wireEvents();
  renderMarkers();
  setStatus(`Loaded ${appState.sites.size} intersections`, false);
  window.setTimeout(() => setStatus("", true), 2200);
}

bootstrap().catch((error) => {
  console.error(error);
  setStatus(`Failed to load data: ${error.message}`, false);
});
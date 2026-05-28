const DATASETS = [
  { id: "st", name: "Super Tuesday (Commuter)", file: "data/processed/st.json", color: "#0077b6" },
  { id: "ss", name: "Super Sunday (Recreation)", file: "data/processed/ss.json", color: "#f4a261" }
];

const MAX_RENDER_EDGES = 900;
const COMMON_ROAD_TOKENS = new Set(["road", "rd", "street", "st", "avenue", "ave", "drive", "dr", "lane", "ln", "highway", "hwy", "way", "north", "south", "east", "west", "track", "path"]);

const appState = {
  sites: [],
  edges: [],
  neighborsBySite: new Map(),
  selectedDataset: "all",
  selectedCity: "all",
  staticAggregation: "year",
  temporalAggregation: "year",
  staticYear: null,
  temporalYear: null,
  temporalIndex: 0,
  temporalBins: [],
  edgeThresholdPct: 10,
  leakagePenalty: 0.45,
  statsVolumeMode: "summed",
  playTimer: null
};

const statusBanner = document.getElementById("status-banner");
const datasetFilter = document.getElementById("dataset-filter");
const cityFilter = document.getElementById("city-filter");
const staticAggregation = document.getElementById("static-aggregation");
const staticDate = document.getElementById("static-date");
const staticSummary = document.getElementById("static-summary");
const temporalAggregation = document.getElementById("temporal-aggregation");
const temporalDate = document.getElementById("temporal-date");
const temporalSummary = document.getElementById("temporal-summary");
const timeSlider = document.getElementById("time-slider");
const timeLabel = document.getElementById("time-label");
const timePlay = document.getElementById("time-play");
const timePrev = document.getElementById("time-prev");
const timeNext = document.getElementById("time-next");
const edgeThresholdInput = document.getElementById("edge-threshold");
const edgeThresholdLabel = document.getElementById("edge-threshold-label");
const leakagePenaltyInput = document.getElementById("leakage-penalty");
const leakagePenaltyLabel = document.getElementById("leakage-penalty-label");
const statsVolumeMode = document.getElementById("stats-volume-mode");
const statsScope = document.getElementById("stats-scope");
const statsGrid = document.getElementById("stats-grid");
const statsNotes = document.getElementById("stats-notes");
const statsTrendVolume = document.getElementById("stats-trend-volume");
const hasStatsPanel = Boolean(statsVolumeMode && statsScope && statsGrid && statsNotes && statsTrendVolume);

const staticMap = L.map("static-map", { zoomControl: true, preferCanvas: true }).setView([-33.87, 151.21], 11);
const temporalMap = L.map("temporal-map", { zoomControl: true, preferCanvas: true }).setView([-33.87, 151.21], 11);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(staticMap);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(temporalMap);

const staticNodeLayer = L.layerGroup().addTo(staticMap);
const staticEdgeLayer = L.layerGroup().addTo(staticMap);
const temporalNodeLayer = L.layerGroup().addTo(temporalMap);
const temporalEdgeLayer = L.layerGroup().addTo(temporalMap);

window.experimentalDebug = {
  staticMap,
  temporalMap,
  staticNodeLayer,
  staticEdgeLayer,
  temporalNodeLayer,
  temporalEdgeLayer
};

function setStatus(text, isHidden = false) {
  statusBanner.textContent = text;
  statusBanner.classList.toggle("hidden", isHidden);
}

function parseDate(value) {
  if (!value || value === "unknown") {
    return null;
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function tokenizeRoads(labels = []) {
  const tokens = new Set();
  labels.forEach((label) => {
    String(label || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !COMMON_ROAD_TOKENS.has(token))
      .forEach((token) => tokens.add(token));
  });
  return [...tokens];
}

function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const lat1 = a.latitude * rad;
  const lat2 = b.latitude * rad;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function hydrateSites(payload, dataset) {
  return (payload.sites || []).map((site) => ({
    key: site.key,
    siteId: site.siteId,
    council: site.council,
    state: site.state,
    latitude: site.latitude,
    longitude: site.longitude,
    datasetId: dataset.id,
    datasetName: dataset.name,
    color: dataset.color,
    roadLabels: site.roadLabels || [],
    roadTokens: tokenizeRoads(site.roadLabels || []),
    records: (site.records || []).map((record) => ({
      ...record,
      year: record.year == null ? null : Number(record.year),
      dateObj: parseDate(record.date),
      dateKey: record.date || "unknown",
      total: record.total == null ? null : Number(record.total),
      hourly: (record.hourly || []).map((point) => ({ time: point.time, value: point.value == null ? null : Number(point.value) })),
      directional: record.directional || { legTotals: [], movements: [] }
    }))
  }));
}

async function loadData() {
  const allSites = [];
  for (const dataset of DATASETS) {
    setStatus(`Loading ${dataset.name}...`);
    const response = await fetch(dataset.file);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${dataset.file}`);
    }
    const payload = await response.json();
    allSites.push(...hydrateSites(payload, dataset));
  }
  appState.sites = allSites;
}

function visibleSites() {
  return appState.sites.filter((site) => {
    const datasetOk = appState.selectedDataset === "all" || site.datasetId === appState.selectedDataset;
    const cityOk = appState.selectedCity === "all" || site.council === appState.selectedCity;
    return datasetOk && cityOk;
  });
}

function sortedUniqueCouncils(sites) {
  return [...new Set(sites.map((site) => site.council).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function refreshCityFilterOptions() {
  const datasetScoped = appState.selectedDataset === "all"
    ? appState.sites
    : appState.sites.filter((site) => site.datasetId === appState.selectedDataset);

  const councils = sortedUniqueCouncils(datasetScoped);
  const previous = appState.selectedCity;
  cityFilter.innerHTML = "";

  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All Cities";
  cityFilter.appendChild(allOption);

  councils.forEach((council) => {
    const option = document.createElement("option");
    option.value = council;
    option.textContent = council;
    cityFilter.appendChild(option);
  });

  const validValues = new Set(["all", ...councils]);
  appState.selectedCity = validValues.has(previous) ? previous : "all";
  cityFilter.value = appState.selectedCity;
}

function buildNetwork(sites) {
  const siteByKey = new Map(sites.map((site) => [site.key, site]));
  const edgeScores = new Map();
  const tokenIndex = new Map();

  sites.forEach((site) => {
    site.roadTokens.forEach((token) => {
      if (!tokenIndex.has(token)) {
        tokenIndex.set(token, []);
      }
      tokenIndex.get(token).push(site.key);
    });
  });

  tokenIndex.forEach((siteKeys) => {
    if (siteKeys.length < 2 || siteKeys.length > 90) {
      return;
    }
    for (let i = 0; i < siteKeys.length; i += 1) {
      for (let j = i + 1; j < siteKeys.length; j += 1) {
        const left = siteByKey.get(siteKeys[i]);
        const right = siteByKey.get(siteKeys[j]);
        const distance = haversineKm(left, right);
        if (distance > 10) {
          continue;
        }
        const pairKey = left.key < right.key ? `${left.key}|${right.key}` : `${right.key}|${left.key}`;
        const score = 1.35 / Math.max(0.35, distance);
        edgeScores.set(pairKey, (edgeScores.get(pairKey) || 0) + score);
      }
    }
  });

  // Ensure local continuity using nearest links.
  sites.forEach((source) => {
    const nearest = sites
      .filter((candidate) => candidate.key !== source.key)
      .map((candidate) => ({ candidate, distance: haversineKm(source, candidate) }))
      .filter((item) => item.distance <= 5.5)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 3);

    nearest.forEach(({ candidate, distance }) => {
      const pairKey = source.key < candidate.key ? `${source.key}|${candidate.key}` : `${candidate.key}|${source.key}`;
      edgeScores.set(pairKey, (edgeScores.get(pairKey) || 0) + 0.75 / Math.max(0.25, distance));
    });
  });

  const edges = [];
  const neighborsBySite = new Map();
  let maxScore = 0;

  edgeScores.forEach((score, pairKey) => {
    const [leftKey, rightKey] = pairKey.split("|");
    const left = siteByKey.get(leftKey);
    const right = siteByKey.get(rightKey);
    if (!left || !right || score <= 0) {
      return;
    }

    maxScore = Math.max(maxScore, score);
    edges.push({
      from: leftKey,
      to: rightKey,
      score,
      midpoint: {
        latitude: (left.latitude + right.latitude) / 2,
        longitude: (left.longitude + right.longitude) / 2
      }
    });

    if (!neighborsBySite.has(leftKey)) {
      neighborsBySite.set(leftKey, []);
    }
    if (!neighborsBySite.has(rightKey)) {
      neighborsBySite.set(rightKey, []);
    }

    neighborsBySite.get(leftKey).push({ key: rightKey, score });
    neighborsBySite.get(rightKey).push({ key: leftKey, score });
  });

  neighborsBySite.forEach((neighbors, siteKey) => {
    const total = neighbors.reduce((sum, item) => sum + item.score, 0) || 1;
    neighborsBySite.set(
      siteKey,
      neighbors.map((item) => ({
        key: item.key,
        score: item.score,
        weight: item.score / total
      }))
    );
  });

  return {
    edges: edges.map((edge) => ({
      ...edge,
      strength: maxScore > 0 ? edge.score / maxScore : 0
    })),
    neighborsBySite
  };
}

function getDistinctYears(sites) {
  const years = new Set();
  sites.forEach((site) => {
    site.records.forEach((record) => {
      if (record.year != null) {
        years.add(record.year);
      }
    });
  });
  return [...years].sort((left, right) => left - right);
}

function populateYearSelect(selectElement, years, preferred) {
  selectElement.innerHTML = "";
  years.forEach((year, index) => {
    const option = document.createElement("option");
    option.value = String(year);
    option.textContent = `${year}${index === years.length - 1 ? " (latest)" : ""}`;
    selectElement.appendChild(option);
  });

  if (selectElement.options.length === 0) {
    return null;
  }

  const values = [...selectElement.options].map((option) => option.value);
  selectElement.value = values.includes(String(preferred)) ? String(preferred) : values[values.length - 1];
  return Number(selectElement.value);
}

function recordsForYear(site, year) {
  const normalizedYear = Number(year);
  return site.records.filter((record) => record.year === normalizedYear);
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
      value: values.length === 0 ? null : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
    }));
}

function averageDailyTotal(records) {
  const totals = records.map((record) => record.total).filter((value) => value != null);
  if (totals.length === 0) {
    return null;
  }
  return Number((totals.reduce((sum, value) => sum + value, 0) / totals.length).toFixed(2));
}

function nodeVolumeForStatic(site, aggregation, year) {
  if (aggregation === "year") {
    return averageDailyTotal(recordsForYear(site, year));
  }
  return averageDailyTotal(site.records);
}

function nodeVolumeForTemporal(site, aggregation, year, timeBin) {
  const records = aggregation === "year" ? recordsForYear(site, year) : site.records;
  const point = averageHourlySeries(records).find((item) => item.time === timeBin);
  return point?.value ?? null;
}

function temporalBins(sites, aggregation, year) {
  const bins = new Set();
  sites.forEach((site) => {
    const records = aggregation === "year" ? recordsForYear(site, year) : site.records;
    averageHourlySeries(records).forEach((point) => {
      if (point.value != null) {
        bins.add(point.time);
      }
    });
  });
  return [...bins].sort((left, right) => left.localeCompare(right));
}

function computeEdgeFlows(volumeBySite, edges, neighborsBySite) {
  const threshold = appState.edgeThresholdPct / 100;
  const lambda = appState.leakagePenalty;

  const thresholdedEdges = edges.filter((edge) => edge.strength >= threshold);
  const chosenEdges = thresholdedEdges.length > 0
    ? thresholdedEdges
    : [...edges].sort((left, right) => right.strength - left.strength).slice(0, 350);

  const candidates = chosenEdges.map((edge) => {
    const fromNeighbors = neighborsBySite.get(edge.from) || [];
    const toNeighbors = neighborsBySite.get(edge.to) || [];

    const pFromTo = fromNeighbors.find((item) => item.key === edge.to)?.weight || 0;
    const pToFrom = toNeighbors.find((item) => item.key === edge.from)?.weight || 0;

    const fromVolume = volumeBySite.get(edge.from) ?? 0;
    const toVolume = volumeBySite.get(edge.to) ?? 0;

    const startRaw = fromVolume * pFromTo;
    const endRaw = toVolume * pToFrom;
    const blended = (startRaw + endRaw) / 2;

    const startFlow = (1 - lambda) * startRaw + lambda * blended;
    const endFlow = (1 - lambda) * endRaw + lambda * blended;

    return {
      ...edge,
      startFlow,
      endFlow,
      confidence: 0.35 + edge.strength * 0.6,
      leakageGap: Math.abs(startRaw - endRaw)
    };
  });

  let kept = candidates
    .filter((item) => item.startFlow > 0 || item.endFlow > 0)
    .sort((left, right) => Math.max(right.startFlow, right.endFlow) - Math.max(left.startFlow, left.endFlow))
    .slice(0, MAX_RENDER_EDGES);

  if (kept.length === 0) {
    kept = candidates
      .sort((left, right) => right.strength - left.strength)
      .slice(0, Math.min(250, candidates.length))
      .map((item) => ({ ...item, startFlow: Math.max(item.startFlow, 0.01), endFlow: Math.max(item.endFlow, 0.01) }));
  }

  const values = kept.flatMap((item) => [item.startFlow, item.endFlow]).filter((value) => value > 0);
  const high = values.length === 0 ? 1 : Math.max(...values);
  const low = values.length === 0 ? 0 : Math.min(...values);

  const widthScale = (value) => {
    if (value <= 0) {
      return 0;
    }
    const normalized = (value - low) / Math.max(0.0001, high - low);
    return 4.5 + normalized * 13;
  };

  return kept.map((item) => ({
    ...item,
    startWidth: widthScale(item.startFlow),
    endWidth: widthScale(item.endFlow)
  }));
}

function clearLayers(edgeLayer, nodeLayer) {
  edgeLayer.clearLayers();
  nodeLayer.clearLayers();
}

function findSiteByKey(sites, key) {
  return sites.find((site) => site.key === key) || null;
}

function drawNetwork({ map, edgeLayer, nodeLayer, sites, edges, volumeBySite, summaryElement, summaryText, fitView }) {
  clearLayers(edgeLayer, nodeLayer);

  const flows = computeEdgeFlows(volumeBySite, edges, appState.neighborsBySite);
  flows.forEach((edge) => {
    const fromSite = findSiteByKey(sites, edge.from);
    const toSite = findSiteByKey(sites, edge.to);
    if (!fromSite || !toSite) {
      return;
    }

    const startSegment = L.polyline([
      [fromSite.latitude, fromSite.longitude],
      [edge.midpoint.latitude, edge.midpoint.longitude]
    ], {
      color: "#136f63",
      opacity: edge.confidence,
      weight: edge.startWidth,
      lineCap: "round"
    });

    const endSegment = L.polyline([
      [edge.midpoint.latitude, edge.midpoint.longitude],
      [toSite.latitude, toSite.longitude]
    ], {
      color: "#f08a4b",
      opacity: edge.confidence,
      weight: edge.endWidth,
      lineCap: "round"
    });

    const tooltip = `From ${fromSite.siteId} to ${toSite.siteId}<br>Start flow: ${edge.startFlow.toFixed(1)}<br>End flow: ${edge.endFlow.toFixed(1)}<br>Leakage gap: ${edge.leakageGap.toFixed(1)}`;
    startSegment.bindTooltip(tooltip);
    endSegment.bindTooltip(tooltip);
    startSegment.addTo(edgeLayer);
    endSegment.addTo(edgeLayer);
  });

  let maxNodeVolume = 1;
  volumeBySite.forEach((value) => {
    if (value != null && value > maxNodeVolume) {
      maxNodeVolume = value;
    }
  });

  sites.forEach((site) => {
    const value = volumeBySite.get(site.key);
    if (value == null || value <= 0) {
      return;
    }

    const radius = 4 + 10 * Math.sqrt(value / maxNodeVolume);
    L.circleMarker([site.latitude, site.longitude], {
      radius,
      weight: 1.3,
      color: "#ffffff",
      fillColor: site.color,
      fillOpacity: 0.84
    })
      .bindTooltip(`Site ${site.siteId} (${site.datasetId.toUpperCase()})<br>Volume: ${value.toFixed(1)}`)
      .addTo(nodeLayer);
  });

  if (fitView) {
    const bounds = L.latLngBounds(sites.map((site) => [site.latitude, site.longitude]));
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.08));
    }
  }

  summaryElement.textContent = summaryText;
}

function renderStaticNetwork() {
  const sites = visibleSites();
  if (sites.length === 0) {
    clearLayers(staticEdgeLayer, staticNodeLayer);
    staticSummary.textContent = "No sites are available for the selected scope.";
    return;
  }

  const volumeBySite = new Map();
  sites.forEach((site) => {
    volumeBySite.set(site.key, nodeVolumeForStatic(site, appState.staticAggregation, appState.staticYear));
  });

  const suffix = appState.staticAggregation === "year"
    ? `year ${appState.staticYear}`
    : "all-years average";

  drawNetwork({
    map: staticMap,
    edgeLayer: staticEdgeLayer,
    nodeLayer: staticNodeLayer,
    sites,
    edges: appState.edges,
    volumeBySite,
    summaryElement: staticSummary,
    summaryText: `Static inferred flow for ${suffix}. Midpoint thickness change represents leakage between origin and destination continuity constraints.`,
    fitView: true
  });
}

function updateTemporalBins() {
  const sites = visibleSites();
  appState.temporalBins = temporalBins(sites, appState.temporalAggregation, appState.temporalYear);
  appState.temporalIndex = Math.min(appState.temporalIndex, Math.max(0, appState.temporalBins.length - 1));
  timeSlider.max = String(Math.max(0, appState.temporalBins.length - 1));
  timeSlider.value = String(appState.temporalIndex);
  timeLabel.textContent = appState.temporalBins[appState.temporalIndex] || "--:--";
}

function renderTemporalNetwork(fitView = false) {
  const sites = visibleSites();
  if (sites.length === 0) {
    clearLayers(temporalEdgeLayer, temporalNodeLayer);
    temporalSummary.textContent = "No sites are available for the selected scope.";
    return;
  }

  if (appState.temporalBins.length === 0) {
    clearLayers(temporalEdgeLayer, temporalNodeLayer);
    temporalSummary.textContent = "No time-binned counts are available for this selection.";
    timeLabel.textContent = "--:--";
    return;
  }

  const timeBin = appState.temporalBins[appState.temporalIndex];
  timeLabel.textContent = timeBin;

  const volumeBySite = new Map();
  sites.forEach((site) => {
    volumeBySite.set(site.key, nodeVolumeForTemporal(site, appState.temporalAggregation, appState.temporalYear, timeBin));
  });

  const suffix = appState.temporalAggregation === "year"
    ? `for year ${appState.temporalYear}`
    : "using all-years hourly average";

  drawNetwork({
    map: temporalMap,
    edgeLayer: temporalEdgeLayer,
    nodeLayer: temporalNodeLayer,
    sites,
    edges: appState.edges,
    volumeBySite,
    summaryElement: temporalSummary,
    summaryText: `Temporal inferred flow at ${timeBin} ${suffix}. Pan/zoom is preserved while stepping through time.`,
    fitView
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

function computeStats(sites) {
  const allRecords = sites.flatMap((site) => site.records);
  const totals = allRecords.map((record) => record.total).filter((value) => value != null);

  const missingHourly = { missing: 0, total: 0 };
  allRecords.forEach((record) => {
    (record.hourly || []).forEach((point) => {
      missingHourly.total += 1;
      if (point.value == null) {
        missingHourly.missing += 1;
      }
    });
  });

  const years = getDistinctYears(sites);

  const yearlyNetworkTotals = new Map();
  allRecords.forEach((record) => {
    if (record.year == null || record.total == null) {
      return;
    }
    yearlyNetworkTotals.set(record.year, (yearlyNetworkTotals.get(record.year) || 0) + record.total);
  });

  const sortedYears = [...yearlyNetworkTotals.keys()].sort((left, right) => left - right);
  let cagrPct = null;
  if (sortedYears.length >= 2) {
    const firstYear = sortedYears[0];
    const lastYear = sortedYears[sortedYears.length - 1];
    const firstValue = yearlyNetworkTotals.get(firstYear);
    const lastValue = yearlyNetworkTotals.get(lastYear);
    const spanYears = lastYear - firstYear;
    if (firstValue > 0 && lastValue >= 0 && spanYears > 0) {
      cagrPct = (Math.pow(lastValue / firstValue, 1 / spanYears) - 1) * 100;
    }
  }

  const siteTotals = sites
    .map((site) => ({ key: site.key, siteId: site.siteId, total: site.records.reduce((sum, record) => sum + (record.total || 0), 0) }))
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

  const directionalImbalanceRatios = [];
  allRecords.forEach((record) => {
    const legTotals = record.directional?.legTotals || [];
    legTotals.forEach((leg) => {
      const enter = leg.enter == null ? null : Number(leg.enter);
      const exit = leg.exit == null ? null : Number(leg.exit);
      if (enter == null || exit == null) {
        return;
      }
      const denom = enter + exit;
      if (denom > 0) {
        directionalImbalanceRatios.push(Math.abs(enter - exit) / denom);
      }
    });
  });

  return {
    siteCount: sites.length,
    recordCount: allRecords.length,
    yearRange: years.length ? `${years[0]}-${years[years.length - 1]}` : "n/a",
    totalVolume,
    medianDailyTotal: percentile(totals, 0.5),
    p90DailyTotal: percentile(totals, 0.9),
    meanYoYGrowth: cagrPct,
    concentration,
    peakHour: peak ? `${peak.time} (${formatNumber(peak.value, 1)})` : "n/a",
    missingHourlyPct: missingHourly.total > 0 ? (missingHourly.missing / missingHourly.total) * 100 : null,
    medianDirectionalImbalance: directionalImbalanceRatios.length ? percentile(directionalImbalanceRatios, 0.5) * 100 : null,
    topSites: siteTotals.slice(0, 5)
  };
}

function computeYearlyStats(sites) {
  const yearly = new Map();
  const siteYearTotals = new Map();

  sites.forEach((site) => {
    if (!siteYearTotals.has(site.key)) {
      siteYearTotals.set(site.key, new Map());
    }

    site.records.forEach((record) => {
      if (record.year == null) {
        return;
      }

      if (!yearly.has(record.year)) {
        yearly.set(record.year, {
          totals: [],
          networkTotal: 0,
          hourlyMissing: 0,
          hourlyTotal: 0,
          directionalImbalance: []
        });
      }

      const current = yearly.get(record.year);
      if (record.total != null) {
        current.totals.push(Number(record.total));
        current.networkTotal += Number(record.total);
        const siteYear = siteYearTotals.get(site.key);
        siteYear.set(record.year, (siteYear.get(record.year) || 0) + Number(record.total));
      }

      (record.hourly || []).forEach((point) => {
        current.hourlyTotal += 1;
        if (point.value == null) {
          current.hourlyMissing += 1;
        }
      });

      (record.directional?.legTotals || []).forEach((leg) => {
        const enter = leg.enter == null ? null : Number(leg.enter);
        const exit = leg.exit == null ? null : Number(leg.exit);
        if (enter == null || exit == null) {
          return;
        }
        const denom = enter + exit;
        if (denom > 0) {
          current.directionalImbalance.push(Math.abs(enter - exit) / denom);
        }
      });
    });
  });

  const years = [...yearly.keys()].sort((left, right) => left - right);

  const siteSeries = [...siteYearTotals.entries()].map(([siteKey, valuesByYear]) => ({
    siteKey,
    y: years.map((year) => valuesByYear.get(year) ?? null)
  }));

  const medianSiteTotals = years.map((year) => {
    const values = siteSeries.map((series) => series.y[years.indexOf(year)]).filter((value) => value != null);
    return percentile(values, 0.5);
  });

  const p90SiteTotals = years.map((year) => {
    const values = siteSeries.map((series) => series.y[years.indexOf(year)]).filter((value) => value != null);
    return percentile(values, 0.9);
  });

  return {
    years,
    networkTotals: years.map((year) => yearly.get(year).networkTotal),
    medianDaily: years.map((year) => percentile(yearly.get(year).totals, 0.5)),
    p90Daily: years.map((year) => percentile(yearly.get(year).totals, 0.9)),
    missingHourlyPct: years.map((year) => {
      const current = yearly.get(year);
      return current.hourlyTotal > 0 ? (current.hourlyMissing / current.hourlyTotal) * 100 : null;
    }),
    imbalancePct: years.map((year) => {
      const values = yearly.get(year).directionalImbalance;
      return values.length > 0 ? percentile(values, 0.5) * 100 : null;
    }),
    siteSeries,
    medianSiteTotals,
    p90SiteTotals
  };
}

function renderStatsTrends(sites) {
  if (!hasStatsPanel) {
    return;
  }
  const yearly = computeYearlyStats(sites);
  if (!window.Plotly || yearly.years.length === 0) {
    return;
  }

  const x = yearly.years.map((year) => String(year));

  const traces = appState.statsVolumeMode === "site"
    ? [
      ...yearly.siteSeries.map((series) => ({
        x,
        y: series.y,
        type: "scatter",
        mode: "lines",
        showlegend: false,
        hoverinfo: "skip",
        line: { color: "rgba(17, 35, 31, 0.12)", width: 1 }
      })),
      {
        x,
        y: yearly.medianSiteTotals,
        type: "scatter",
        mode: "lines+markers",
        name: "Median across sites",
        line: { color: "#005f73", width: 3 }
      },
      {
        x,
        y: yearly.p90SiteTotals,
        type: "scatter",
        mode: "lines+markers",
        name: "P90 across sites",
        line: { color: "#b5651d", width: 3, dash: "dash" }
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

function renderStats() {
  if (!hasStatsPanel) {
    return;
  }
  const sites = visibleSites();
  const scopeDataset = appState.selectedDataset === "all" ? "All datasets" : appState.selectedDataset.toUpperCase();
  const scopeCity = appState.selectedCity === "all" ? "All cities" : appState.selectedCity;
  statsScope.textContent = `Scope: ${scopeDataset} | ${scopeCity}`;

  if (sites.length === 0) {
    statsGrid.innerHTML = "";
    statsNotes.textContent = "No statistics available for the current scope.";
    if (window.Plotly) {
      Plotly.purge(statsTrendVolume);
    }
    return;
  }

  const stats = computeStats(sites);
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
  renderStatsTrends(sites);
}

function refreshSelectors() {
  const sites = visibleSites();
  const years = getDistinctYears(sites);
  appState.staticYear = populateYearSelect(staticDate, years, appState.staticYear);
  appState.temporalYear = populateYearSelect(temporalDate, years, appState.temporalYear);

  const staticYearMode = appState.staticAggregation === "year";
  const temporalYearMode = appState.temporalAggregation === "year";
  staticDate.closest("label").classList.toggle("hidden", !staticYearMode);
  temporalDate.closest("label").classList.toggle("hidden", !temporalYearMode);
}

function recomputeNetwork() {
  const network = buildNetwork(visibleSites());
  appState.edges = network.edges;
  appState.neighborsBySite = network.neighborsBySite;
}

function refreshAll() {
  recomputeNetwork();
  refreshSelectors();
  updateTemporalBins();
  renderStats();
  renderStaticNetwork();
  renderTemporalNetwork(true);
}

function stopPlayback() {
  if (appState.playTimer) {
    window.clearInterval(appState.playTimer);
    appState.playTimer = null;
  }
  timePlay.textContent = "Play";
}

function startPlayback() {
  stopPlayback();
  if (appState.temporalBins.length <= 1) {
    return;
  }
  appState.playTimer = window.setInterval(() => {
    appState.temporalIndex = (appState.temporalIndex + 1) % appState.temporalBins.length;
    timeSlider.value = String(appState.temporalIndex);
    renderTemporalNetwork(false);
  }, 900);
  timePlay.textContent = "Pause";
}

function wireEvents() {
  datasetFilter.addEventListener("change", () => {
    appState.selectedDataset = datasetFilter.value;
    refreshCityFilterOptions();
    stopPlayback();
    refreshAll();
  });

  cityFilter.addEventListener("change", () => {
    appState.selectedCity = cityFilter.value;
    stopPlayback();
    refreshAll();
  });

  staticAggregation.addEventListener("change", () => {
    appState.staticAggregation = staticAggregation.value;
    refreshSelectors();
    renderStaticNetwork();
  });

  staticDate.addEventListener("change", () => {
    appState.staticYear = Number(staticDate.value);
    renderStaticNetwork();
  });

  temporalAggregation.addEventListener("change", () => {
    appState.temporalAggregation = temporalAggregation.value;
    refreshSelectors();
    updateTemporalBins();
    renderTemporalNetwork(true);
  });

  temporalDate.addEventListener("change", () => {
    appState.temporalYear = Number(temporalDate.value);
    updateTemporalBins();
    renderTemporalNetwork(true);
  });

  edgeThresholdInput.addEventListener("input", () => {
    appState.edgeThresholdPct = Number(edgeThresholdInput.value);
    edgeThresholdLabel.textContent = `${appState.edgeThresholdPct}%`;
    renderStaticNetwork();
    renderTemporalNetwork(false);
  });

  leakagePenaltyInput.addEventListener("input", () => {
    appState.leakagePenalty = Number(leakagePenaltyInput.value) / 100;
    leakagePenaltyLabel.textContent = appState.leakagePenalty.toFixed(2);
    renderStaticNetwork();
    renderTemporalNetwork(false);
  });

  if (hasStatsPanel) {
    statsVolumeMode.addEventListener("change", () => {
      appState.statsVolumeMode = statsVolumeMode.value;
      renderStats();
    });
  }

  timeSlider.addEventListener("input", () => {
    appState.temporalIndex = Number(timeSlider.value);
    renderTemporalNetwork(false);
  });

  timePrev.addEventListener("click", () => {
    if (appState.temporalBins.length === 0) {
      return;
    }
    appState.temporalIndex = Math.max(0, appState.temporalIndex - 1);
    timeSlider.value = String(appState.temporalIndex);
    renderTemporalNetwork(false);
  });

  timeNext.addEventListener("click", () => {
    if (appState.temporalBins.length === 0) {
      return;
    }
    appState.temporalIndex = Math.min(appState.temporalBins.length - 1, appState.temporalIndex + 1);
    timeSlider.value = String(appState.temporalIndex);
    renderTemporalNetwork(false);
  });

  timePlay.addEventListener("click", () => {
    if (appState.playTimer) {
      stopPlayback();
    } else {
      startPlayback();
    }
  });
}

async function bootstrap() {
  setStatus("Loading preprocessed datasets...");
  await loadData();

  edgeThresholdLabel.textContent = `${appState.edgeThresholdPct}%`;
  leakagePenaltyLabel.textContent = appState.leakagePenalty.toFixed(2);
  if (hasStatsPanel) {
    statsVolumeMode.value = appState.statsVolumeMode;
  }

  refreshCityFilterOptions();
  wireEvents();
  refreshAll();
  setStatus(`Loaded ${appState.sites.length} monitoring sites`, false);
  window.setTimeout(() => setStatus("", true), 2400);
}

bootstrap().catch((error) => {
  console.error(error);
  setStatus(`Failed to initialize experimental page: ${error.message}`, false);
});

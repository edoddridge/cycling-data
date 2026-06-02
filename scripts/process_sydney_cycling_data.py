from __future__ import annotations

import argparse
import csv
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_FILE = ROOT / "data" / "external" / "Sydney" / "processed" / "sydney_active_timeseries.csv"

SURVEY_BASE_URL = (
    "https://services1.arcgis.com/cNVyNtjGVZybOQWZ/arcgis/rest/services/"
    "Twice_Yearly_Bicycle_Count_Data/FeatureServer/0/query"
)
LOCATIONS_BASE_URL = (
    "https://services1.arcgis.com/cNVyNtjGVZybOQWZ/arcgis/rest/services/"
    "Twice_Yearly_Bicycle_Count_Locations/FeatureServer/0/query"
)

TIME_FIELDS = [
    ("Time_0600", "06:00:00"),
    ("Time_0700", "07:00:00"),
    ("Time_0800", "08:00:00"),
    ("Time_1600", "16:00:00"),
    ("Time_1700", "17:00:00"),
    ("Time_1800", "18:00:00"),
]

MONTH_TO_NUMBER = {
    "january": 1,
    "february": 2,
    "march": 3,
    "april": 4,
    "may": 5,
    "june": 6,
    "july": 7,
    "august": 8,
    "september": 9,
    "october": 10,
    "november": 11,
    "december": 12,
}


def fetch_json(url: str, params: dict[str, object], retries: int, backoff_seconds: float) -> dict:
    query = urllib.parse.urlencode(params)
    final_url = f"{url}?{query}"

    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(final_url, timeout=90) as response:
                payload = response.read().decode("utf-8")
                return json.loads(payload)
        except Exception:
            if attempt >= retries:
                raise
            sleep_seconds = backoff_seconds * (attempt + 1)
            time.sleep(sleep_seconds)

    raise RuntimeError("Unexpected fetch failure")


def fetch_paged_features(
    base_url: str,
    object_id_field: str,
    return_geometry: bool,
    out_sr: int | None,
    retries: int,
    backoff_seconds: float,
) -> list[dict]:
    all_features: list[dict] = []
    offset = 0
    page_size = 2000

    while True:
        params: dict[str, object] = {
            "where": "1=1",
            "outFields": "*",
            "f": "json",
            "orderByFields": f"{object_id_field} ASC",
            "resultOffset": offset,
            "resultRecordCount": page_size,
            "returnGeometry": "true" if return_geometry else "false",
        }
        if out_sr is not None:
            params["outSR"] = out_sr

        payload = fetch_json(base_url, params, retries, backoff_seconds)
        features = payload.get("features") or []
        if not features:
            break

        all_features.extend(features)
        offset += len(features)

        if len(features) < page_size:
            break

    return all_features


def month_to_date(year_value: object, month_value: object) -> str:
    try:
        year = int(year_value)
    except (TypeError, ValueError):
        year = 1900

    month_token = str(month_value or "").strip().lower()
    month = MONTH_TO_NUMBER.get(month_token, 1)
    return f"{year:04d}-{month:02d}-01"


def optional_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def build_location_lookup(location_features: list[dict]) -> dict[int, dict[str, object]]:
    by_site: dict[int, dict[str, object]] = {}

    for feature in location_features:
        attrs = feature.get("attributes") or {}
        geometry = feature.get("geometry") or {}

        site_id = optional_int(attrs.get("SiteID"))
        if site_id is None:
            continue

        by_site[site_id] = {
            "intersection": str(attrs.get("Intersection") or "").strip(),
            "longitude": geometry.get("x"),
            "latitude": geometry.get("y"),
            "location_objectid": attrs.get("OBJECTID"),
        }

    return by_site


def survey_rows_to_timeseries(
    survey_features: list[dict],
    location_by_site: dict[int, dict[str, object]],
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []

    for feature in survey_features:
        attrs = feature.get("attributes") or {}

        site_id = optional_int(attrs.get("SiteID"))
        if site_id is None:
            continue

        location = location_by_site.get(site_id, {})
        date_value = month_to_date(attrs.get("Year"), attrs.get("Month"))

        for field_name, time_bin in TIME_FIELDS:
            count_value = optional_int(attrs.get(field_name))
            if count_value is None:
                continue

            rows.append({
                "site_id": str(site_id),
                "intersection": location.get("intersection", ""),
                "longitude": location.get("longitude", ""),
                "latitude": location.get("latitude", ""),
                "date": date_value,
                "time_bin": time_bin,
                "direction": "All directions",
                "total_flow": count_value,
                "ped": "",
                "pcl": count_value,
                "month": attrs.get("Month", ""),
                "year": attrs.get("Year", ""),
                "totalcount": attrs.get("TotalCount", ""),
                "objectid2": attrs.get("ObjectId2", ""),
                "time_0600": attrs.get("Time_0600", ""),
                "time_0700": attrs.get("Time_0700", ""),
                "time_0800": attrs.get("Time_0800", ""),
                "time_1600": attrs.get("Time_1600", ""),
                "time_1700": attrs.get("Time_1700", ""),
                "time_1800": attrs.get("Time_1800", ""),
                "location_objectid": location.get("location_objectid", ""),
            })

    rows.sort(key=lambda row: (row["site_id"], row["date"], row["time_bin"]))
    return rows


def write_csv(output_file: Path, rows: list[dict[str, object]]) -> None:
    output_file.parent.mkdir(parents=True, exist_ok=True)

    fieldnames = [
        "site_id",
        "intersection",
        "longitude",
        "latitude",
        "date",
        "time_bin",
        "direction",
        "total_flow",
        "ped",
        "pcl",
        "month",
        "year",
        "totalcount",
        "objectid2",
        "time_0600",
        "time_0700",
        "time_0800",
        "time_1600",
        "time_1700",
        "time_1800",
        "location_objectid",
    ]

    with output_file.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build Sydney bicycle survey timeseries for the dashboard active layer.")
    parser.add_argument("--output-file", type=Path, default=DEFAULT_OUTPUT_FILE, help="Output CSV path")
    parser.add_argument("--retries", type=int, default=3, help="Retries per ArcGIS request")
    parser.add_argument("--backoff-seconds", type=float, default=1.5, help="Backoff multiplier for retries")
    args = parser.parse_args()

    survey_features = fetch_paged_features(
        base_url=SURVEY_BASE_URL,
        object_id_field="ObjectId2",
        return_geometry=False,
        out_sr=None,
        retries=max(0, args.retries),
        backoff_seconds=max(0.1, args.backoff_seconds),
    )
    location_features = fetch_paged_features(
        base_url=LOCATIONS_BASE_URL,
        object_id_field="OBJECTID",
        return_geometry=True,
        out_sr=4326,
        retries=max(0, args.retries),
        backoff_seconds=max(0.1, args.backoff_seconds),
    )

    location_by_site = build_location_lookup(location_features)
    rows = survey_rows_to_timeseries(survey_features, location_by_site)
    write_csv(args.output_file, rows)

    unique_sites = len({row["site_id"] for row in rows})
    unique_dates = len({(row["site_id"], row["date"]) for row in rows})

    print(f"Survey features fetched: {len(survey_features)}")
    print(f"Location features fetched: {len(location_features)}")
    print(f"Joined sites: {unique_sites}")
    print(f"Site-date records: {unique_dates}")
    print(f"Time-bin rows written: {len(rows)}")
    print(f"Wrote: {args.output_file}")


if __name__ == "__main__":
    main()

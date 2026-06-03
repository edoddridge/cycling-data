from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT_DIR = ROOT / "data" / "external" / "Melbourne"
DEFAULT_OUTPUT_FILE = ROOT / "data" / "external" / "Melbourne" / "processed" / "melbourne_network_timeseries.csv"
DEFAULT_METADATA_OUTPUT_FILE = ROOT / "data" / "external" / "Melbourne" / "processed" / "melbourne_site_metadata.csv"
DEFAULT_CLIMATOLOGY_INTRADAY_OUTPUT_FILE = ROOT / "data" / "external" / "Melbourne" / "processed" / "melbourne_climatology_intraday.csv"
DEFAULT_CLIMATOLOGY_WEEKLY_OUTPUT_FILE = ROOT / "data" / "external" / "Melbourne" / "processed" / "melbourne_climatology_weekly.csv"
DEFAULT_CLIMATOLOGY_ANNUAL_OUTPUT_FILE = ROOT / "data" / "external" / "Melbourne" / "processed" / "melbourne_climatology_annual.csv"
DEFAULT_SITE_LISTING_FILE = ROOT / "data" / "external" / "Melbourne" / "_published_active_transport_bicycle_volume_and_speed_bike_site_listing.csv"

INPUT_DATE_FMT = "%d/%m/%Y"
INPUT_TIME_FMT = "%H:%M:%S"

DIRECTION_LABELS = {
    "N": "Northbound",
    "S": "Southbound",
    "E": "Eastbound",
    "W": "Westbound",
}

WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def normalize_direction(value: str) -> str:
    token = (value or "").strip().upper()
    return DIRECTION_LABELS.get(token, token or "Unknown")


def floor_to_interval(time_text: str, bin_minutes: int) -> str | None:
    try:
        parsed = datetime.strptime(time_text.strip(), INPUT_TIME_FMT)
    except ValueError:
        return None
    minute = (parsed.minute // bin_minutes) * bin_minutes
    return f"{parsed.hour:02d}:{minute:02d}:00"


def iter_zip_files(input_dir: Path) -> list[Path]:
    return sorted(path for path in input_dir.rglob("*.zip") if path.is_file())


def safe_float(value: str) -> float | None:
    text = (value or "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def bucket_date(day: date, granularity: str) -> str:
    if granularity == "daily":
        return day.isoformat()
    if granularity == "weekly":
        week_start = day - timedelta(days=day.weekday())
        return week_start.isoformat()
    if granularity == "monthly":
        return day.replace(day=1).isoformat()
    raise ValueError(f"Unsupported granularity: {granularity}")


def weekpart_label(day: date) -> str:
    return "Weekend" if day.weekday() >= 5 else "Weekday"


def season_label(day: date) -> str:
    month = day.month
    if month in {12, 1, 2}:
        return "Summer"
    if month in {3, 4, 5}:
        return "Autumn"
    if month in {6, 7, 8}:
        return "Winter"
    return "Spring"


def load_site_metadata(site_listing_file: Path) -> dict[str, dict[str, str]]:
    by_route: dict[str, dict[str, str]] = {}
    if not site_listing_file.exists():
        return by_route

    with site_listing_file.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
        for row in reader:
            route = (row.get("SITE_XN_ROUTE") or "").strip()
            if not route:
                continue
            grouped[route].append(row)

    for route, rows in grouped.items():
        lat_values = [safe_float(row.get("GPS_LAT") or "") for row in rows]
        lon_values = [safe_float(row.get("GPS_LONG") or "") for row in rows]
        lat_clean = [value for value in lat_values if value is not None]
        lon_clean = [value for value in lon_values if value is not None]

        primary = rows[0]
        by_route[route] = {
            "site_xn_route": route,
            "gps_lat": f"{(sum(lat_clean) / len(lat_clean)):.6f}" if lat_clean else "",
            "gps_long": f"{(sum(lon_clean) / len(lon_clean)):.6f}" if lon_clean else "",
            "surface_type": (primary.get("SURFACE_TYPE") or "").strip(),
            "region": (primary.get("REGION") or "").strip(),
            "status": (primary.get("STATUS") or "").strip(),
            "purpose": (primary.get("PURPOSE") or "").strip(),
        }

    return by_route


def parse_zip_csv_events(
    zip_path: Path,
    counts: dict[tuple[str, str, str, str], int],
    day_lookup: dict[tuple[str, str], date],
    bin_minutes: int,
    date_granularity: str,
) -> int:
    events = 0
    with ZipFile(zip_path) as archive:
        for member in archive.namelist():
            if member.endswith("/"):
                continue
            if not member.lower().endswith(".csv"):
                continue

            with archive.open(member) as handle:
                text_handle = (line.decode("utf-8", errors="replace") for line in handle)
                reader = csv.DictReader(text_handle)

                for row in reader:
                    if (row.get("VEHICLE") or "").strip().upper() != "CYCLE":
                        continue

                    date_value = (row.get("DATE") or "").strip()
                    time_value = (row.get("TIME") or "").strip()
                    if not date_value or not time_value:
                        continue

                    route = (row.get("SITE_XN_ROUTE") or "").strip()
                    if not route:
                        continue

                    try:
                        day = datetime.strptime(date_value, INPUT_DATE_FMT).date()
                    except ValueError:
                        continue

                    day_bucket = bucket_date(day, date_granularity)
                    day_lookup[(route, day_bucket)] = day

                    time_bin = floor_to_interval(time_value, bin_minutes)
                    if not time_bin:
                        continue

                    direction = normalize_direction(row.get("DIRECTION") or "")
                    counts[(route, day_bucket, time_bin, direction)] += 1
                    events += 1

    return events


def write_csv(path: Path, rows: list[dict[str, str | int]], fieldnames: list[str], sort_key=None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if sort_key is not None:
        rows.sort(key=sort_key)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def build_monthly_trend_rows(
    counts: dict[tuple[str, str, str, str], int],
    site_metadata: dict[str, dict[str, str]],
    include_directional: bool,
) -> list[dict[str, str | int]]:
    grouped_all: dict[tuple[str, str, str], int] = defaultdict(int)
    for (route, day, time_bin, _direction), count in counts.items():
        grouped_all[(route, day, time_bin)] += count

    rows: list[dict[str, str | int]] = []
    for (route, day, time_bin), total in grouped_all.items():
        rows.append(
            {
                "site_xn_route": route,
                "date": day,
                "time_bin": time_bin,
                "direction": "All directions",
                "total_flow": total,
            }
        )

    if include_directional:
        for (route, day, time_bin, direction), total in counts.items():
            rows.append(
                {
                    "site_xn_route": route,
                    "date": day,
                    "time_bin": time_bin,
                    "direction": direction,
                    "total_flow": total,
                }
            )

    return rows


def build_intraday_cube_rows(
    counts: dict[tuple[str, str, str, str], int],
    day_lookup: dict[tuple[str, str], date],
    include_directional: bool,
) -> list[dict[str, str | int]]:
    rows: list[dict[str, str | int]] = []

    grouped_all: dict[tuple[str, str, str], int] = defaultdict(int)
    for (route, day, time_bin, _direction), count in counts.items():
        grouped_all[(route, day, time_bin)] += count

    cube: dict[tuple[str, str, str, str, str], list[int]] = defaultdict(lambda: [0, 0])

    for (route, day, time_bin), total in grouped_all.items():
        day_obj = day_lookup.get((route, day))
        if not day_obj:
            continue
        key = (route, time_bin, "All directions", weekpart_label(day_obj), season_label(day_obj))
        cube[key][0] += total
        cube[key][1] += 1

    if include_directional:
        for (route, day, time_bin, direction), total in counts.items():
            day_obj = day_lookup.get((route, day))
            if not day_obj:
                continue
            key = (route, time_bin, direction, weekpart_label(day_obj), season_label(day_obj))
            cube[key][0] += total
            cube[key][1] += 1

    for (route, time_bin, direction, weekpart, season), (sum_flow, sample_count) in cube.items():
        rows.append(
            {
                "site_xn_route": route,
                "time_bin": time_bin,
                "direction": direction,
                "weekpart": weekpart,
                "season": season,
                "sum_flow": sum_flow,
                "sample_count": sample_count,
            }
        )

    return rows


def build_daily_totals(
    counts: dict[tuple[str, str, str, str], int],
    include_directional: bool,
) -> dict[tuple[str, str, str], int]:
    totals: dict[tuple[str, str, str], int] = defaultdict(int)

    grouped_all: dict[tuple[str, str], int] = defaultdict(int)
    for (route, day, _time_bin, _direction), count in counts.items():
        grouped_all[(route, day)] += count

    for (route, day), total in grouped_all.items():
        totals[(route, day, "All directions")] += total

    if include_directional:
        for (route, day, _time_bin, direction), count in counts.items():
            totals[(route, day, direction)] += count

    return totals


def build_weekly_climatology_rows(
    daily_totals: dict[tuple[str, str, str], int],
    day_lookup: dict[tuple[str, str], date],
) -> list[dict[str, str | int]]:
    cube: dict[tuple[str, str, str, str, str], list[int]] = defaultdict(lambda: [0, 0])

    for (route, day, direction), total in daily_totals.items():
        day_obj = day_lookup.get((route, day))
        if not day_obj:
            continue
        weekday = WEEKDAY_LABELS[day_obj.weekday()]
        key = (route, weekday, direction, weekpart_label(day_obj), season_label(day_obj))
        cube[key][0] += total
        cube[key][1] += 1

    rows: list[dict[str, str | int]] = []
    for (route, weekday, direction, weekpart, season), (sum_flow, sample_count) in cube.items():
        rows.append(
            {
                "site_xn_route": route,
                "weekday": weekday,
                "direction": direction,
                "weekpart": weekpart,
                "season": season,
                "sum_flow": sum_flow,
                "sample_count": sample_count,
            }
        )

    return rows


def build_annual_climatology_rows(
    daily_totals: dict[tuple[str, str, str], int],
    day_lookup: dict[tuple[str, str], date],
) -> list[dict[str, str | int]]:
    weekly_totals: dict[tuple[str, str, str], int] = defaultdict(int)
    weekly_date_ref: dict[tuple[str, str], date] = {}

    for (route, day, direction), total in daily_totals.items():
        day_obj = day_lookup.get((route, day))
        if not day_obj:
            continue
        week_start = day_obj - timedelta(days=day_obj.weekday())
        week_key = week_start.isoformat()
        weekly_totals[(route, week_key, direction)] += total
        weekly_date_ref[(route, week_key)] = week_start

    cube: dict[tuple[str, str, str, str, str], list[int]] = defaultdict(lambda: [0, 0])

    for (route, week_key, direction), total in weekly_totals.items():
        week_obj = weekly_date_ref.get((route, week_key))
        if not week_obj:
            continue
        month = MONTH_LABELS[week_obj.month - 1]
        key = (route, month, direction, "All weeks", season_label(week_obj))
        cube[key][0] += total
        cube[key][1] += 1

    rows: list[dict[str, str | int]] = []
    for (route, month, direction, weekpart, season), (sum_flow, sample_count) in cube.items():
        rows.append(
            {
                "site_xn_route": route,
                "month": month,
                "direction": direction,
                "weekpart": weekpart,
                "season": season,
                "sum_flow": sum_flow,
                "sample_count": sample_count,
            }
        )

    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Aggregate Melbourne bicycle detector event ZIPs into compact dashboard outputs.")
    parser.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT_DIR, help="Directory containing Melbourne ZIP files")
    parser.add_argument("--output-file", type=Path, default=DEFAULT_OUTPUT_FILE, help="Main trend output CSV path")
    parser.add_argument("--metadata-output-file", type=Path, default=DEFAULT_METADATA_OUTPUT_FILE, help="Site metadata CSV path")
    parser.add_argument("--climatology-intraday-output-file", type=Path, default=DEFAULT_CLIMATOLOGY_INTRADAY_OUTPUT_FILE, help="Intraday climatology cube CSV path")
    parser.add_argument("--climatology-weekly-output-file", type=Path, default=DEFAULT_CLIMATOLOGY_WEEKLY_OUTPUT_FILE, help="Weekly climatology cube CSV path")
    parser.add_argument("--climatology-annual-output-file", type=Path, default=DEFAULT_CLIMATOLOGY_ANNUAL_OUTPUT_FILE, help="Annual climatology cube CSV path")
    parser.add_argument("--site-listing-file", type=Path, default=DEFAULT_SITE_LISTING_FILE, help="Melbourne site listing CSV with metadata")
    parser.add_argument("--bin-minutes", type=int, default=60, help="Time aggregation bin width in minutes")
    parser.add_argument("--include-directional", action="store_true", help="Include per-direction rows")
    parser.add_argument(
        "--date-granularity",
        choices=["daily", "weekly", "monthly"],
        default="daily",
        help="Date granularity for main trend output",
    )
    args = parser.parse_args()

    if args.bin_minutes <= 0 or 60 % args.bin_minutes != 0:
        raise SystemExit("--bin-minutes must be a positive divisor of 60")

    zip_files = iter_zip_files(args.input_dir)
    if not zip_files:
        raise SystemExit(f"No ZIP files found under: {args.input_dir}")

    site_metadata = load_site_metadata(args.site_listing_file)
    if not site_metadata:
        print(f"Warning: no site metadata loaded from {args.site_listing_file}; metadata output will be sparse.")

    trend_counts: dict[tuple[str, str, str, str], int] = defaultdict(int)
    trend_day_lookup: dict[tuple[str, str], date] = {}

    climate_counts: dict[tuple[str, str, str, str], int] = defaultdict(int)
    climate_day_lookup: dict[tuple[str, str], date] = {}

    total_events = 0

    for index, zip_path in enumerate(zip_files, start=1):
        total_events += parse_zip_csv_events(
            zip_path,
            trend_counts,
            trend_day_lookup,
            args.bin_minutes,
            args.date_granularity,
        )
        parse_zip_csv_events(
            zip_path,
            climate_counts,
            climate_day_lookup,
            args.bin_minutes,
            "daily",
        )
        if index % 50 == 0:
            print(f"Processed {index}/{len(zip_files)} ZIPs...")

    trend_rows = build_monthly_trend_rows(trend_counts, site_metadata, args.include_directional)
    metadata_rows = list(site_metadata.values())
    intraday_rows = build_intraday_cube_rows(climate_counts, climate_day_lookup, args.include_directional)

    daily_totals = build_daily_totals(climate_counts, args.include_directional)
    weekly_rows = build_weekly_climatology_rows(daily_totals, climate_day_lookup)
    annual_rows = build_annual_climatology_rows(daily_totals, climate_day_lookup)

    write_csv(
        args.output_file,
        trend_rows,
        ["site_xn_route", "date", "time_bin", "direction", "total_flow"],
        sort_key=lambda row: (str(row["site_xn_route"]), str(row["date"]), str(row["time_bin"]), str(row["direction"])),
    )
    write_csv(
        args.metadata_output_file,
        metadata_rows,
        ["site_xn_route", "gps_lat", "gps_long", "surface_type", "region", "status", "purpose"],
        sort_key=lambda row: str(row["site_xn_route"]),
    )
    write_csv(
        args.climatology_intraday_output_file,
        intraday_rows,
        ["site_xn_route", "time_bin", "direction", "weekpart", "season", "sum_flow", "sample_count"],
        sort_key=lambda row: (str(row["site_xn_route"]), str(row["time_bin"]), str(row["direction"]), str(row["weekpart"]), str(row["season"])),
    )
    write_csv(
        args.climatology_weekly_output_file,
        weekly_rows,
        ["site_xn_route", "weekday", "direction", "weekpart", "season", "sum_flow", "sample_count"],
        sort_key=lambda row: (str(row["site_xn_route"]), str(row["weekday"]), str(row["direction"]), str(row["weekpart"]), str(row["season"])),
    )
    write_csv(
        args.climatology_annual_output_file,
        annual_rows,
        ["site_xn_route", "month", "direction", "weekpart", "season", "sum_flow", "sample_count"],
        sort_key=lambda row: (str(row["site_xn_route"]), str(row["month"]), str(row["direction"]), str(row["weekpart"]), str(row["season"])),
    )

    unique_sites = len({key[0] for key in climate_counts})
    trend_days = len({key[1] for key in trend_counts})
    climate_days = len({key[1] for key in climate_counts})
    unique_directions = len({key[3] for key in climate_counts})

    print(f"ZIP files processed: {len(zip_files)}")
    print(f"Cycling events aggregated: {total_events}")
    print(f"Bin minutes: {args.bin_minutes}")
    print(f"Date granularity (trend): {args.date_granularity}")
    print(f"Sites observed: {unique_sites}")
    print(f"Trend unique days: {trend_days}")
    print(f"Climatology unique days: {climate_days}")
    print(f"Directions observed: {unique_directions}")
    print(f"Wrote trend: {args.output_file}")
    print(f"Wrote metadata: {args.metadata_output_file}")
    print(f"Wrote intraday climatology: {args.climatology_intraday_output_file}")
    print(f"Wrote weekly climatology: {args.climatology_weekly_output_file}")
    print(f"Wrote annual climatology: {args.climatology_annual_output_file}")


if __name__ == "__main__":
    main()

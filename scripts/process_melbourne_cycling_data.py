from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT_DIR = ROOT / "data" / "external" / "Melbourne"
DEFAULT_OUTPUT_FILE = ROOT / "data" / "external" / "Melbourne" / "processed" / "melbourne_network_timeseries.csv"
DEFAULT_SITE_LISTING_FILE = ROOT / "data" / "external" / "Melbourne" / "_published_active_transport_bicycle_volume_and_speed_bike_site_listing.csv"

INPUT_DATE_FMT = "%d/%m/%Y"
INPUT_TIME_FMT = "%H:%M:%S"

DIRECTION_LABELS = {
    "N": "Northbound",
    "S": "Southbound",
    "E": "Eastbound",
    "W": "Westbound"
}


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


def parse_zip_csv_events(zip_path: Path, daily_counts: dict[tuple[str, str, str, str], int], bin_minutes: int) -> int:
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
                        day = datetime.strptime(date_value, INPUT_DATE_FMT).date().isoformat()
                    except ValueError:
                        continue

                    time_bin = floor_to_interval(time_value, bin_minutes)
                    if not time_bin:
                        continue

                    direction = normalize_direction(row.get("DIRECTION") or "")
                    daily_counts[(route, day, time_bin, direction)] += 1
                    events += 1

    return events


def write_timeseries(
    output_file: Path,
    daily_counts: dict[tuple[str, str, str, str], int],
    site_metadata: dict[str, dict[str, str]],
    include_directional: bool,
) -> None:
    output_file.parent.mkdir(parents=True, exist_ok=True)

    grouped_all = defaultdict(int)
    for (route, day, time_bin, _direction), count in daily_counts.items():
        grouped_all[(route, day, time_bin)] += count

    rows = []
    for (route, day, time_bin), total in grouped_all.items():
        metadata = site_metadata.get(route, {
            "site_xn_route": route,
            "gps_lat": "",
            "gps_long": "",
            "surface_type": "",
            "region": "",
            "status": "",
            "purpose": "",
        })
        rows.append({
            "site_xn_route": metadata["site_xn_route"],
            "gps_lat": metadata["gps_lat"],
            "gps_long": metadata["gps_long"],
            "surface_type": metadata["surface_type"],
            "region": metadata["region"],
            "status": metadata["status"],
            "purpose": metadata["purpose"],
            "date": day,
            "time_bin": time_bin,
            "direction": "All directions",
            "total_flow": total,
        })

    if include_directional:
        for (route, day, time_bin, direction), total in daily_counts.items():
            rows.append({
                "site_xn_route": route,
                "gps_lat": "",
                "gps_long": "",
                "surface_type": "",
                "region": "",
                "status": "",
                "purpose": "",
                "date": day,
                "time_bin": time_bin,
                "direction": direction,
                "total_flow": total,
            })

    rows.sort(key=lambda row: (row["site_xn_route"], row["date"], row["time_bin"], row["direction"]))

    fieldnames = [
        "site_xn_route",
        "gps_lat",
        "gps_long",
        "surface_type",
        "region",
        "status",
        "purpose",
        "date",
        "time_bin",
        "direction",
        "total_flow",
    ]
    with output_file.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Aggregate Melbourne bicycle detector event ZIPs to binned counts.")
    parser.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT_DIR, help="Directory containing Melbourne ZIP files")
    parser.add_argument("--output-file", type=Path, default=DEFAULT_OUTPUT_FILE, help="Output CSV path")
    parser.add_argument("--site-listing-file", type=Path, default=DEFAULT_SITE_LISTING_FILE, help="Melbourne site listing CSV with metadata")
    parser.add_argument("--bin-minutes", type=int, default=60, help="Time aggregation bin width in minutes")
    parser.add_argument("--include-directional", action="store_true", help="Include per-direction rows in addition to all-direction totals")
    args = parser.parse_args()

    if args.bin_minutes <= 0 or 60 % args.bin_minutes != 0:
        raise SystemExit("--bin-minutes must be a positive divisor of 60")

    zip_files = iter_zip_files(args.input_dir)
    if not zip_files:
        raise SystemExit(f"No ZIP files found under: {args.input_dir}")

    site_metadata = load_site_metadata(args.site_listing_file)
    if not site_metadata:
        print(f"Warning: no site metadata loaded from {args.site_listing_file}; output will include blank metadata columns.")

    daily_counts: dict[tuple[str, str, str, str], int] = defaultdict(int)
    total_events = 0

    for index, zip_path in enumerate(zip_files, start=1):
        total_events += parse_zip_csv_events(zip_path, daily_counts, args.bin_minutes)
        if index % 50 == 0:
            print(f"Processed {index}/{len(zip_files)} ZIPs...")

    write_timeseries(args.output_file, daily_counts, site_metadata, args.include_directional)

    unique_sites = len({key[0] for key in daily_counts})
    unique_days = len({key[1] for key in daily_counts})
    unique_directions = len({key[3] for key in daily_counts})

    print(f"ZIP files processed: {len(zip_files)}")
    print(f"Cycling events aggregated: {total_events}")
    print(f"Bin minutes: {args.bin_minutes}")
    print(f"Sites observed: {unique_sites}")
    print(f"Unique days: {unique_days}")
    print(f"Directions observed: {unique_directions}")
    print(f"Wrote: {args.output_file}")


if __name__ == "__main__":
    main()

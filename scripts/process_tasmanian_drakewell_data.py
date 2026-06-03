from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

ACTIVE_INPUT_FILE = ROOT / "data" / "external" / "drakewell" / "TAS_ACTIVE" / "00A0113113AT" / "timeseries.csv"
ACTIVE_OUTPUT_DIR = ROOT / "data" / "external" / "drakewell" / "TAS_ACTIVE" / "00A0113113AT" / "processed"

PERM_INPUT_FILE = ROOT / "data" / "external" / "drakewell" / "TAS_PERM" / "0000A0113112" / "timeseries.csv"
PERM_OUTPUT_DIR = ROOT / "data" / "external" / "drakewell" / "TAS_PERM" / "0000A0113112" / "processed"

INPUT_DATE_FMT = "%Y-%m-%d"

MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

KEY_FIELDS = {"date", "time_bin", "direction"}
IGNORED_METRIC_FIELDS = {"invalid_reading"}


def parse_date(value: str) -> date | None:
    text = (value or "").strip()
    if not text:
        return None
    try:
        return datetime.strptime(text, INPUT_DATE_FMT).date()
    except ValueError:
        return None


def bucket_month(day: date) -> str:
    return day.replace(day=1).isoformat()


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


def to_float(value: str) -> float | None:
    text = (value or "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def metric_fields(rows: list[dict[str, str]]) -> list[str]:
    discovered = set()
    for row in rows:
        for key in row.keys():
            if key in KEY_FIELDS or key in IGNORED_METRIC_FIELDS:
                continue
            discovered.add(key)
    preferred = ["total_flow", "ped", "pcl"]
    ordered = [key for key in preferred if key in discovered]
    ordered.extend(sorted(key for key in discovered if key not in set(ordered)))
    return ordered


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, str | float | int]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def build_monthly_trend_rows(rows: list[dict[str, str]], metrics: list[str]) -> list[dict[str, str | float]]:
    grouped: dict[tuple[str, str, str], dict[str, float]] = defaultdict(lambda: defaultdict(float))

    for row in rows:
        day = parse_date(row.get("date") or "")
        if not day:
            continue
        time_bin = (row.get("time_bin") or "").strip()
        direction = (row.get("direction") or "").strip()
        if not time_bin or not direction:
            continue

        key = (bucket_month(day), time_bin, direction)
        for metric in metrics:
            value = to_float(row.get(metric) or "")
            if value is None:
                continue
            grouped[key][metric] += value

    output: list[dict[str, str | float]] = []
    for (month, time_bin, direction), metric_totals in grouped.items():
        record: dict[str, str | float] = {
            "date": month,
            "time_bin": time_bin,
            "direction": direction,
        }
        for metric in metrics:
            record[metric] = round(metric_totals.get(metric, 0.0), 3)
        output.append(record)

    output.sort(key=lambda row: (str(row["date"]), str(row["time_bin"]), str(row["direction"])))
    return output


def build_intraday_cube(rows: list[dict[str, str]], metrics: list[str]) -> list[dict[str, str | float | int]]:
    cube: dict[tuple[str, str, str, str, str], list[float | int]] = defaultdict(lambda: [0.0, 0])

    for row in rows:
        day = parse_date(row.get("date") or "")
        time_bin = (row.get("time_bin") or "").strip()
        direction = (row.get("direction") or "").strip() or "All directions"
        if not day or not time_bin:
            continue

        for metric in metrics:
            value = to_float(row.get(metric) or "")
            if value is None:
                continue
            key = (time_bin, direction, metric, weekpart_label(day), season_label(day))
            cube[key][0] += value
            cube[key][1] += 1

    output: list[dict[str, str | float | int]] = []
    for (time_bin, direction, metric, weekpart, season), (sum_flow, sample_count) in cube.items():
        output.append(
            {
                "time_bin": time_bin,
                "direction": direction,
                "metric": metric,
                "weekpart": weekpart,
                "season": season,
                "sum_flow": round(float(sum_flow), 3),
                "sample_count": int(sample_count),
            }
        )

    output.sort(key=lambda row: (str(row["time_bin"]), str(row["direction"]), str(row["metric"]), str(row["weekpart"]), str(row["season"])))
    return output


def build_daily_metric_totals(rows: list[dict[str, str]], metrics: list[str]) -> dict[tuple[str, str, str], float]:
    totals: dict[tuple[str, str, str], float] = defaultdict(float)
    for row in rows:
        day = parse_date(row.get("date") or "")
        direction = (row.get("direction") or "").strip() or "All directions"
        if not day:
            continue
        day_key = day.isoformat()
        for metric in metrics:
            value = to_float(row.get(metric) or "")
            if value is None:
                continue
            totals[(day_key, direction, metric)] += value
    return totals


def build_weekly_cube(daily_totals: dict[tuple[str, str, str], float]) -> list[dict[str, str | float | int]]:
    cube: dict[tuple[str, str, str, str, str], list[float | int]] = defaultdict(lambda: [0.0, 0])

    for (day_key, direction, metric), value in daily_totals.items():
        day = parse_date(day_key)
        if not day:
            continue
        weekday = WEEKDAY_LABELS[day.weekday()]
        key = (weekday, direction, metric, weekpart_label(day), season_label(day))
        cube[key][0] += value
        cube[key][1] += 1

    output: list[dict[str, str | float | int]] = []
    for (weekday, direction, metric, weekpart, season), (sum_flow, sample_count) in cube.items():
        output.append(
            {
                "weekday": weekday,
                "direction": direction,
                "metric": metric,
                "weekpart": weekpart,
                "season": season,
                "sum_flow": round(float(sum_flow), 3),
                "sample_count": int(sample_count),
            }
        )

    output.sort(key=lambda row: (str(row["weekday"]), str(row["direction"]), str(row["metric"]), str(row["weekpart"]), str(row["season"])))
    return output


def build_annual_cube(daily_totals: dict[tuple[str, str, str], float]) -> list[dict[str, str | float | int]]:
    weekly_totals: dict[tuple[str, str, str], float] = defaultdict(float)
    week_ref: dict[str, date] = {}

    for (day_key, direction, metric), value in daily_totals.items():
        day = parse_date(day_key)
        if not day:
            continue
        week_start = day - timedelta(days=day.weekday())
        week_key = week_start.isoformat()
        weekly_totals[(week_key, direction, metric)] += value
        week_ref[week_key] = week_start

    cube: dict[tuple[str, str, str, str, str], list[float | int]] = defaultdict(lambda: [0.0, 0])

    for (week_key, direction, metric), value in weekly_totals.items():
        week_start = week_ref.get(week_key)
        if not week_start:
            continue
        month = MONTH_LABELS[week_start.month - 1]
        key = (month, direction, metric, "All weeks", season_label(week_start))
        cube[key][0] += value
        cube[key][1] += 1

    output: list[dict[str, str | float | int]] = []
    for (month, direction, metric, weekpart, season), (sum_flow, sample_count) in cube.items():
        output.append(
            {
                "month": month,
                "direction": direction,
                "metric": metric,
                "weekpart": weekpart,
                "season": season,
                "sum_flow": round(float(sum_flow), 3),
                "sample_count": int(sample_count),
            }
        )

    output.sort(key=lambda row: (str(row["month"]), str(row["direction"]), str(row["metric"]), str(row["weekpart"]), str(row["season"])))
    return output


def process_site(input_file: Path, output_dir: Path, label: str) -> None:
    rows = read_rows(input_file)
    if not rows:
        raise SystemExit(f"No rows found in {input_file}")

    metrics = metric_fields(rows)
    if not metrics:
        raise SystemExit(f"No metric columns found in {input_file}")

    trend_rows = build_monthly_trend_rows(rows, metrics)
    intraday_rows = build_intraday_cube(rows, metrics)
    daily_totals = build_daily_metric_totals(rows, metrics)
    weekly_rows = build_weekly_cube(daily_totals)
    annual_rows = build_annual_cube(daily_totals)

    write_csv(
        output_dir / "timeseries_monthly.csv",
        ["date", "time_bin", "direction", *metrics],
        trend_rows,
    )
    write_csv(
        output_dir / "climatology_intraday.csv",
        ["time_bin", "direction", "metric", "weekpart", "season", "sum_flow", "sample_count"],
        intraday_rows,
    )
    write_csv(
        output_dir / "climatology_weekly.csv",
        ["weekday", "direction", "metric", "weekpart", "season", "sum_flow", "sample_count"],
        weekly_rows,
    )
    write_csv(
        output_dir / "climatology_annual.csv",
        ["month", "direction", "metric", "weekpart", "season", "sum_flow", "sample_count"],
        annual_rows,
    )

    print(f"[{label}] input rows: {len(rows)}")
    print(f"[{label}] metrics: {', '.join(metrics)}")
    print(f"[{label}] trend rows: {len(trend_rows)} -> {output_dir / 'timeseries_monthly.csv'}")
    print(f"[{label}] intraday rows: {len(intraday_rows)} -> {output_dir / 'climatology_intraday.csv'}")
    print(f"[{label}] weekly rows: {len(weekly_rows)} -> {output_dir / 'climatology_weekly.csv'}")
    print(f"[{label}] annual rows: {len(annual_rows)} -> {output_dir / 'climatology_annual.csv'}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build compact monthly trend and climatology cubes for Tasmanian Drakewell sites.")
    parser.add_argument("--active-input-file", type=Path, default=ACTIVE_INPUT_FILE)
    parser.add_argument("--active-output-dir", type=Path, default=ACTIVE_OUTPUT_DIR)
    parser.add_argument("--perm-input-file", type=Path, default=PERM_INPUT_FILE)
    parser.add_argument("--perm-output-dir", type=Path, default=PERM_OUTPUT_DIR)
    args = parser.parse_args()

    process_site(args.active_input_file, args.active_output_dir, "Tas Active 00A0113113AT")
    process_site(args.perm_input_file, args.perm_output_dir, "Tas Perm 0000A0113112")


if __name__ == "__main__":
    main()

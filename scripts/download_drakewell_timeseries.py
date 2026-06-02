from __future__ import annotations

import argparse
import csv
import re
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import requests


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_ROOT = ROOT / "data" / "external" / "drakewell"
BASE_URL = "https://tasmaniatrafficdata.drakewell.com/tfreport_multiday.asp"
TIME_BIN_PATTERN = re.compile(r"^(\d{2}):(\d{2})(?::\d{2})?$")
NON_WORD_PATTERN = re.compile(r"[^a-z0-9]+")


def parse_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def daterange(start: date, end: date) -> list[date]:
    days = []
    current = start
    while current <= end:
        days.append(current)
        current += timedelta(days=1)
    return days


def clean_cell(value: str) -> str:
    return " ".join(value.replace("\xa0", " ").split()).strip()


def to_number(value: str) -> int | None:
    text = clean_cell(value)
    if not text or text in {"-", "--", "n/a", "N/A"}:
        return None
    text = text.replace(",", "")
    try:
        numeric = float(text)
    except ValueError:
        return None
    return int(numeric)


def normalize_time_bin(value: str) -> str | None:
    text = clean_cell(value)
    match = TIME_BIN_PATTERN.match(text)
    if not match:
        return None
    return f"{match.group(1)}:{match.group(2)}"


def normalize_metric_key(value: str) -> str:
    text = clean_cell(value).lower()
    if not text:
        return "metric"
    return NON_WORD_PATTERN.sub("_", text).strip("_")


class HTMLTableExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.tables: list[list[list[str]]] = []
        self._in_table = False
        self._in_row = False
        self._in_cell = False
        self._table: list[list[str]] = []
        self._row: list[str] = []
        self._cell: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "table":
            self._in_table = True
            self._table = []
            return
        if not self._in_table:
            return
        if tag == "tr":
            self._in_row = True
            self._row = []
        elif tag in {"td", "th"}:
            self._in_cell = True
            self._cell = []
        elif tag == "br" and self._in_cell:
            self._cell.append("\n")

    def handle_data(self, data: str) -> None:
        if self._in_table and self._in_row and self._in_cell:
            self._cell.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"td", "th"} and self._in_cell:
            text = clean_cell("".join(self._cell))
            self._row.append(text)
            self._in_cell = False
            self._cell = []
            return

        if tag == "tr" and self._in_row:
            if any(cell for cell in self._row):
                self._table.append(self._row)
            self._in_row = False
            self._row = []
            return

        if tag == "table" and self._in_table:
            if self._table:
                self.tables.append(self._table)
            self._in_table = False
            self._table = []


@dataclass
class ParseResult:
    rows: list[dict[str, Any]]
    reason: str | None = None


def find_multiday_table(tables: list[list[list[str]]]) -> tuple[list[list[str]] | None, int | None, int]:
    best: tuple[list[list[str]] | None, int | None, int] = (None, None, -1)

    for table in tables:
        for index, row in enumerate(table):
            time_count = sum(1 for cell in row if clean_cell(cell).lower() == "time")
            if time_count >= 2 and time_count > best[2]:
                best = (table, index, time_count)

    return best


def infer_direction_labels(direction_row: list[str], group_count: int) -> list[str]:
    if group_count <= 0:
        return []

    cleaned = [clean_cell(cell) for cell in direction_row if clean_cell(cell)]
    if len(cleaned) == group_count:
        return cleaned

    if len(cleaned) > group_count:
        step = max(1, len(cleaned) // group_count)
        labels = [cleaned[min(i * step, len(cleaned) - 1)] for i in range(group_count)]
        return labels

    labels = cleaned + [f"Direction {index + 1}" for index in range(group_count - len(cleaned))]
    return labels


def parse_multiday_report(html_text: str, report_date: date) -> ParseResult:
    parser = HTMLTableExtractor()
    parser.feed(html_text)

    table, header_index, time_count = find_multiday_table(parser.tables)
    if table is None or header_index is None or time_count <= 0:
        return ParseResult([], "No multi-day data table found")

    header_row = [clean_cell(cell) for cell in table[header_index]]
    time_starts = [index for index, cell in enumerate(header_row) if cell.lower() == "time"]
    group_count = len(time_starts)
    if group_count == 0:
        return ParseResult([], "No Time headers found")

    group_slices: list[tuple[int, int]] = []
    for index, start in enumerate(time_starts):
        end = time_starts[index + 1] if index + 1 < len(time_starts) else len(header_row)
        group_slices.append((start, end))

    metric_names_by_group: list[list[str]] = []
    for start, end in group_slices:
        metrics = [normalize_metric_key(cell) for cell in header_row[start + 1 : end]]
        metric_names_by_group.append(metrics)

    direction_row = table[header_index - 1] if header_index > 0 else []
    direction_labels = infer_direction_labels(direction_row, group_count)

    parsed_rows: list[dict[str, Any]] = []
    row_width = len(header_row)

    for row in table[header_index + 1 :]:
        normalized = row + [""] * max(0, row_width - len(row))
        if len(normalized) < row_width:
            continue

        for group_index, (start, end) in enumerate(group_slices):
            chunk = normalized[start:end]
            if len(chunk) < 2:
                continue

            interval_label = normalize_time_bin(chunk[0])
            if not interval_label:
                continue

            metric_names = metric_names_by_group[group_index]
            metric_values = [to_number(value) for value in chunk[1:]]
            if all(value is None for value in metric_values):
                continue

            row_out: dict[str, Any] = {
                "date": report_date.isoformat(),
                "time_bin": interval_label,
                "direction": direction_labels[group_index] if group_index < len(direction_labels) else f"Direction {group_index + 1}",
            }

            for metric_index, metric_key in enumerate(metric_names):
                if metric_index >= len(metric_values):
                    break
                row_out[metric_key] = metric_values[metric_index]

            parsed_rows.append(row_out)

    if not parsed_rows:
        return ParseResult([], "No time-bin rows found")

    return ParseResult(parsed_rows)


def build_report_url(node: str, cosit: str, report_date: date, dimtype: int, intval: int) -> str:
    query = urlencode(
        {
            "node": node,
            "cosit": cosit,
            "reportdate": report_date.isoformat(),
            "enddate": report_date.isoformat(),
            "dimtype": dimtype,
            "intval": intval,
            "excel": 1,
        }
    )
    return f"{BASE_URL}?{query}"


def fetch_with_retry(
    session: requests.Session,
    url: str,
    timeout: int,
    retries: int,
    backoff_seconds: float,
) -> requests.Response:
    last_error: Exception | None = None

    for attempt in range(1, retries + 1):
        try:
            response = session.get(url, timeout=timeout)
            if response.status_code >= 500:
                raise requests.HTTPError(f"Server error {response.status_code}", response=response)
            return response
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt < retries:
                time.sleep(backoff_seconds * attempt)

    assert last_error is not None
    raise last_error


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def infer_fieldnames(rows: list[dict[str, Any]]) -> list[str]:
    preferred = ["date", "time_bin", "direction"]
    discovered = {key for row in rows for key in row.keys() if key not in preferred}
    return preferred + sorted(discovered)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Download Drakewell multi-day class report exports and build a gap-tolerant time-series CSV."
    )
    parser.add_argument("--node", default="TAS_ACTIVE", help="Drakewell node, e.g. TAS_ACTIVE")
    parser.add_argument("--cosit", required=True, help="Site ID (cosit), e.g. 00A0113113AT")
    parser.add_argument("--start-date", default="2023-09-01", help="Start date (YYYY-MM-DD)")
    parser.add_argument("--end-date", default="2026-05-02", help="End date (YYYY-MM-DD)")
    parser.add_argument("--dimtype", type=int, default=2, help="Report dimtype parameter")
    parser.add_argument("--intval", type=int, default=2, help="Report interval parameter")
    parser.add_argument("--output-root", type=Path, default=DEFAULT_OUTPUT_ROOT, help="Root output folder")
    parser.add_argument("--sleep-seconds", type=float, default=0.8, help="Delay between successful requests")
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout (seconds)")
    parser.add_argument("--retries", type=int, default=4, help="Retry attempts per date")
    parser.add_argument("--backoff-seconds", type=float, default=1.2, help="Retry backoff base (seconds)")
    parser.add_argument("--skip-existing", action="store_true", help="Skip download when raw file already exists")
    args = parser.parse_args()

    start_date = parse_date(args.start_date)
    end_date = parse_date(args.end_date)
    if end_date < start_date:
        raise ValueError("end-date must be on or after start-date")

    site_root = args.output_root / args.node / args.cosit
    raw_dir = site_root / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    all_rows: list[dict[str, Any]] = []
    log_rows: list[dict[str, Any]] = []

    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": "traffic-and-cycling-drakewell-downloader/1.0",
            "Accept": "*/*",
        }
    )

    for day in daterange(start_date, end_date):
        day_key = day.isoformat()
        url = build_report_url(args.node, args.cosit, day, args.dimtype, args.intval)
        raw_path = raw_dir / f"{day_key}.xls"

        if args.skip_existing and raw_path.exists():
            html_text = raw_path.read_text(encoding="utf-8", errors="replace")
            parsed = parse_multiday_report(html_text, day)
            status = "ok" if parsed.rows else "gap"
            all_rows.extend(parsed.rows)
            log_rows.append(
                {
                    "date": day_key,
                    "status": status,
                    "http_status": "cached",
                    "rows": len(parsed.rows),
                    "reason": parsed.reason or "",
                    "url": url,
                    "raw_file": str(raw_path.relative_to(site_root)),
                }
            )
            continue

        try:
            response = fetch_with_retry(session, url, args.timeout, args.retries, args.backoff_seconds)
            response.raise_for_status()
            raw_path.write_bytes(response.content)

            html_text = response.text
            parsed = parse_multiday_report(html_text, day)
            status = "ok" if parsed.rows else "gap"

            all_rows.extend(parsed.rows)
            log_rows.append(
                {
                    "date": day_key,
                    "status": status,
                    "http_status": response.status_code,
                    "rows": len(parsed.rows),
                    "reason": parsed.reason or "",
                    "url": url,
                    "raw_file": str(raw_path.relative_to(site_root)),
                }
            )
        except Exception as exc:  # noqa: BLE001
            log_rows.append(
                {
                    "date": day_key,
                    "status": "error",
                    "http_status": "",
                    "rows": 0,
                    "reason": str(exc),
                    "url": url,
                    "raw_file": "",
                }
            )

        time.sleep(max(0.0, args.sleep_seconds))

    data_path = site_root / "timeseries.csv"
    log_path = site_root / "download_log.csv"

    all_rows.sort(key=lambda row: (row.get("date", ""), row.get("time_bin", ""), row.get("direction", "")))
    fieldnames = infer_fieldnames(all_rows)
    write_csv(
        data_path,
        all_rows,
        fieldnames,
    )
    write_csv(
        log_path,
        log_rows,
        ["date", "status", "http_status", "rows", "reason", "url", "raw_file"],
    )

    ok_days = sum(1 for row in log_rows if row["status"] == "ok")
    gap_days = sum(1 for row in log_rows if row["status"] == "gap")
    error_days = sum(1 for row in log_rows if row["status"] == "error")

    print(f"Wrote data: {data_path}")
    print(f"Wrote log:  {log_path}")
    print(f"Days processed: {len(log_rows)} | ok={ok_days} gap={gap_days} error={error_days}")


if __name__ == "__main__":
    main()

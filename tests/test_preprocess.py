from datetime import date
import unittest

from scripts.preprocess_cycling_data import (
    DATASETS,
    aggregate_yearly_totals,
    extract_category_hourly_data,
    extract_categories,
    extract_directional_data,
    extract_time_columns,
    parse_date_value,
    resolve_category_hourly_columns,
)


class PreprocessTests(unittest.TestCase):
    def test_parse_date_value_handles_iso_timestamp(self) -> None:
        self.assertEqual(parse_date_value("2014-11-09 00:00:00"), date(2014, 11, 9))

    def test_parse_date_value_handles_australian_slash_format(self) -> None:
        self.assertEqual(parse_date_value("09/11/2014"), date(2014, 11, 9))

    def test_extract_time_columns_sorts_valid_time_bins_only(self) -> None:
        headers = ["site_id", "08:15:00", "Count_Date", "07:00:00", "Trips/hour", "06:45:00"]
        self.assertEqual(extract_time_columns(headers), ["06:45:00", "07:00:00", "08:15:00"])

    def test_aggregate_yearly_totals_averages_duplicate_year_records(self) -> None:
        records = [
            {"year": 2021, "total": 100},
            {"year": 2021, "total": 140},
            {"year": 2022, "total": 90},
            {"year": 2023, "total": None},
        ]
        self.assertEqual(aggregate_yearly_totals(records), {2021: 120.0, 2022: 90.0})

    def test_extract_categories_keeps_only_numeric_values(self) -> None:
        dataset = next(dataset for dataset in DATASETS if dataset["id"] == "ss")
        normalized_row = {"bicycle": 12, "e-bike": None, "walker": "no data", "micro": 4}
        self.assertEqual(extract_categories(dataset, normalized_row), {"bicycle": 12, "micro": 4})

    def test_extract_directional_data_builds_leg_totals_and_movements(self) -> None:
        normalized_row = {
            "leg1_enter": 8,
            "leg1_exit": 10,
            "leg1_total": 18,
            "leg2_enter": 4,
            "leg2_exit": 6,
            "leg2_total": 10,
            "leg1-2": 3,
            "leg2-1": 5,
        }
        directional = extract_directional_data(normalized_row, 2)
        self.assertEqual(
            directional["legTotals"],
            [
                {"leg": 1, "enter": 8, "exit": 10, "total": 18},
                {"leg": 2, "enter": 4, "exit": 6, "total": 10},
            ],
        )
        self.assertEqual(
            directional["movements"],
            [
                {"from": 1, "to": 2, "value": 3},
                {"from": 2, "to": 1, "value": 5},
            ],
        )

    def test_resolve_category_hourly_columns_detects_mixed_header_formats(self) -> None:
        dataset = next(dataset for dataset in DATASETS if dataset["id"] == "st")
        headers = [
            "female_06:30:00",
            "06:45:00 female",
            "women_ebike_07-00",
            "not known",
            "male",
        ]

        resolved = resolve_category_hourly_columns(dataset, headers)
        self.assertEqual(
            resolved,
            {
                "female": [("06:30", "female_06:30:00"), ("06:45", "06:45:00 female")],
                "women_ebike": [("07:00", "women_ebike_07-00")],
            },
        )

    def test_extract_category_hourly_data_keeps_only_series_with_values(self) -> None:
        category_hourly_columns = {
            "female": [("06:30", "female_06:30:00"), ("06:45", "female_06:45:00")],
            "male": [("06:30", "male_06:30:00")],
        }
        normalized_row = {
            "female_06:30:00": 3,
            "female_06:45:00": 5,
            "male_06:30:00": None,
        }

        extracted = extract_category_hourly_data(normalized_row, category_hourly_columns)
        self.assertEqual(
            extracted,
            {
                "female": [
                    {"time": "06:30", "value": 3},
                    {"time": "06:45", "value": 5},
                ]
            },
        )


if __name__ == "__main__":
    unittest.main()
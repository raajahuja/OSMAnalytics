"""Check a freshly built analytics database before it replaces the live one.

Exits with an error, and a message saying why, if the database is damaged, is
for the wrong country, has no data, or lost most of the previous build's data.
"""
import argparse
import json
import sqlite3
from pathlib import Path

MIN_SHARE_OF_PREVIOUS = 0.7
SCHEMA = 2


def read_only(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def feature_count(connection):
    return connection.execute("SELECT COUNT(*) FROM map_features").fetchone()[0]


def validate(candidate, country, previous=None):
    connection = read_only(candidate)
    try:
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise SystemExit("The new database is damaged.")
        summary = json.loads(connection.execute("SELECT summary FROM metadata").fetchone()[0])
        if summary["country"]["id"] != country:
            raise SystemExit(f"The new database is for {summary['country']['id']}, not {country}.")
        if summary.get("schema") != SCHEMA:
            raise SystemExit(f"The new database has schema {summary.get('schema')}, not {SCHEMA}.")
        regions = len(summary["areas"]) - 1
        if regions < 1:
            raise SystemExit("The new database has no regions.")
        features = feature_count(connection)
        if not features:
            raise SystemExit("The new database has no map features.")
    finally:
        connection.close()
    if previous:
        connection = read_only(previous)
        try:
            before = feature_count(connection)
        finally:
            connection.close()
        if features < before * MIN_SHARE_OF_PREVIOUS:
            raise SystemExit(
                f"The new database has {features:,} features, down from {before:,}. Keeping the old one."
            )
    print(f"Checked: {features:,} features in {regions} regions", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--country", required=True)
    parser.add_argument("--previous", type=Path)
    args = parser.parse_args()
    validate(args.candidate, args.country, args.previous)

"""Write a tiny, deterministic OSM extract and run the real analytics pipeline on it.

Usage: build_fixture.py OUTPUT_DIR   (creates OUTPUT_DIR/analytics/LU.sqlite and XX.sqlite)

Twelve 0.1-degree cantons form a 4x3 grid over Luxembourg, west to east and
south to north. C01 covers 5.9-6.0 E, 49.5-49.6 N; C02 is its eastern neighbour.

Country XX has no national settings and 40 regions, 20 wide and 2 tall, running
east from 179 E across the antimeridian to 179 W at about 17 S. It exercises
any-country builds, more than 31 regions and maps that cross 180 degrees.
"""
from datetime import datetime
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

import osmium
from osmium.osm.mutable import Node, Relation, Way

ROOT = Path(__file__).resolve().parents[3]
SNAPSHOT = "2026-01-02T03:04:05Z"
WEST, SOUTH, STEP = 5.9, 49.5, 0.1


def load_pipeline():
    spec = importlib.util.spec_from_file_location("prepare_analytics", ROOT / "code/pipeline/prepare-analytics.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cantons():
    features = []
    for index in range(12):
        row, column = divmod(index, 4)
        x0, y0 = WEST + column * STEP, SOUTH + row * STEP
        x1, y1 = x0 + STEP, y0 + STEP
        features.append({
            "type": "Feature",
            "properties": {"code": f"C{index + 1:02d}", "name": f"Canton {index + 1:02d}"},
            "geometry": {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]},
        })
    return {"type": "FeatureCollection", "features": features}


# Geometry helpers: every node id is assigned here, so ways list ids only.
NODES = {
    # Motorway from C01 into C02.
    1: (5.95, 49.55), 2: (6.05, 49.55),
    # Residential street inside C01.
    3: (5.93, 49.53), 4: (5.94, 49.53), 5: (5.95, 49.53),
    # Closed roundabout: a highway, so it must stay a line.
    6: (5.96, 49.58), 7: (5.961, 49.58), 8: (5.961, 49.581), 9: (5.96, 49.58 + 0.001),
    # Building footprint in C02.
    10: (6.02, 49.52), 11: (6.022, 49.52), 12: (6.022, 49.522), 13: (6.02, 49.522),
    # Forest multipolygon with a hole in C03.
    20: (6.11, 49.51), 21: (6.15, 49.51), 22: (6.15, 49.55), 23: (6.11, 49.55),
    24: (6.12, 49.52), 25: (6.13, 49.52), 26: (6.13, 49.53), 27: (6.12, 49.53),
    # Road outside every canton: must be dropped.
    30: (5.10, 49.10), 31: (5.11, 49.10),
    # Bus route ways in C01.
    40: (5.91, 49.51), 41: (5.92, 49.51), 42: (5.93, 49.51),
}
TAGGED_NODES = [
    (101, (5.931, 49.531), {"highway": "bus_stop", "name": "Église Saint-Jean", "shelter": "yes"}),
    (102, (5.932, 49.532), {"amenity": "cafe", "name": "Café du Parc"}),
    (103, (6.021, 49.521), {"shop": "bakery", "name": "=SUM(A1)"}),
    (104, (5.955, 49.555), {"highway": "traffic_signals"}),
    (105, (6.0, 49.57), {"barrier": "gate"}),  # Exactly on the C01/C02 border.
    (106, (5.05, 49.05), {"amenity": "cafe", "name": "Outside"}),
    (107, (5.933, 49.533), {"barrier": "gate", "access": "private"}),
    (108, (6.25, 49.75), {"place": "town", "name": "Fixtureville"}),
]
WAYS = [
    (201, [1, 2], {"highway": "motorway", "name": "A1", "ref": "A1"}),
    (202, [3, 4, 5], {"highway": "residential", "name": "Rue de la Gare"}),
    (203, [6, 7, 8, 9, 6], {"highway": "unclassified", "junction": "roundabout"}),
    (204, [10, 11, 12, 13, 10], {"building": "yes", "name": "Town Hall"}),
    (205, [20, 21, 22, 23, 20], {}),
    (206, [24, 25, 26, 27, 24], {}),
    (207, [30, 31], {"highway": "residential", "name": "Outside Road"}),
    (208, [40, 41], {"highway": "service"}),
    (209, [41, 42], {"highway": "service"}),
]
RELATIONS = [
    (301, [("w", 205, "outer"), ("w", 206, "inner")], {"type": "multipolygon", "landuse": "forest", "name": "Fixture Forest"}),
    (302, [("w", 208, ""), ("w", 209, "")], {"type": "route", "route": "bus", "name": "Line 1"}),
    (303, [("r", 302, ""), ("r", 304, "")], {"type": "route_master", "route_master": "bus"}),
    (304, [("r", 303, "")], {"type": "collection", "note": "Membership cycle"}),
]


DATELINE_COUNTRY = {
    "id": "XX", "name": "Dateline", "division": "Cell",
    "source": "https://example.org/extract", "boundarySource": "https://example.org/boundaries",
    "boundaryCredit": "Fixture Survey", "boundaryLicense": "CC0",
}
DATELINE_NODES = {1101: (-179.95, -16.96), 1102: (-179.85, -16.96), 1103: (179.85, -16.96), 1104: (179.95, -16.96)}
DATELINE_TAGGED = [
    (1001, (179.995, -16.95), {"amenity": "cafe", "name": "МОСКВА кафе"}),   # R10
    (1002, (-179.995, -16.95), {"amenity": "cafe", "name": "Other side"}),   # R11
    (1003, (-179.75, -16.85), {"amenity": "school", "name": "Region 33"}),   # R33: 1 << 32 wraps to R01
    (1004, (179.05, -16.95), {"amenity": "school", "name": "Region 1"}),     # R01
    (1005, (-179.05, -16.85), {"shop": "bakery", "name": "Region 40"}),      # R40
]
DATELINE_WAYS = [
    (2001, [1101, 1102], {"highway": "primary", "name": "East Road"}),
    (2002, [1103, 1104], {"highway": "primary", "name": "West Road"}),
]


def dateline_cells():
    features = []
    for index in range(40):
        row, column = divmod(index, 20)
        x0 = round(179 + column * 0.1, 6)
        x0 = x0 - 360 if x0 >= 180 else x0
        x1 = 180.0 if column == 9 else round(x0 + 0.1, 6)
        y0, y1 = round(-17 + row * 0.1, 6), round(-16.9 + row * 0.1, 6)
        features.append({
            "type": "Feature",
            "properties": {"code": f"R{index + 1:02d}", "name": f"Cell {index + 1:02d}"},
            "geometry": {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]},
        })
    return {"type": "FeatureCollection", "features": features}


# Version and last edit. Anything not listed was edited recently, at version 1.
HISTORY = {
    ("way", 201): (40, "2019-03-01T00:00:00Z"),   # Most edited, stale, in C01 and C02.
    ("way", 202): (7, "2021-06-15T00:00:00Z"),    # Stale, in C01.
    ("node", 101): (3, "2015-05-05T00:00:00Z"),   # Oldest, in C01.
    ("node", 104): (2, "2024-02-02T00:00:00Z"),   # Between one and three years old.
    ("way", 204): (5, "2018-08-08T00:00:00Z"),    # Stale building in C02.
}


def history(kind, identifier):
    version, edited = HISTORY.get((kind, identifier), (1, "2025-11-20T00:00:00Z"))
    return {"version": version, "timestamp": datetime.fromisoformat(edited.replace("Z", "+00:00"))}


def write_extract(path, plain=NODES, tagged=TAGGED_NODES, ways=WAYS, relations=RELATIONS):
    header = osmium.io.Header()
    header.set("osmosis_replication_timestamp", SNAPSHOT)
    writer = osmium.SimpleWriter(str(path), overwrite=True, header=header)
    try:
        located = [(i, loc, {}) for i, loc in plain.items()] + tagged
        for identifier, location, tags in sorted(located):
            writer.add_node(Node(id=identifier, location=location, tags=tags, **history("node", identifier)))
        for identifier, nodes, tags in ways:
            writer.add_way(Way(id=identifier, nodes=nodes, tags=tags, **history("way", identifier)))
        for identifier, members, tags in relations:
            writer.add_relation(Relation(id=identifier, members=members, tags=tags, **history("relation", identifier)))
    finally:
        writer.close()


def main(output):
    output = Path(output)
    pipeline = load_pipeline()
    with tempfile.TemporaryDirectory() as working:
        working = Path(working)
        pbf, boundaries = working / "fixture.osm.pbf", working / "cantons.geojson"
        write_extract(pbf)
        boundaries.write_text(json.dumps(cantons()))
        pipeline.build(pbf, boundaries, output / "analytics" / "LU.sqlite", pipeline.load_country("LU"))
        write_extract(pbf, DATELINE_NODES, DATELINE_TAGGED, DATELINE_WAYS, [])
        boundaries.write_text(json.dumps(dateline_cells()))
        pipeline.build(pbf, boundaries, output / "analytics" / "XX.sqlite", DATELINE_COUNTRY)


if __name__ == "__main__":
    main(sys.argv[1])

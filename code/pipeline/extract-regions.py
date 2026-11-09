"""Find a country's regions in its own OSM extract and write the build's inputs.

Writes CODE.geojson (one feature per region) and CODE.json (the country config
that prepare-analytics.py reads). An extract also holds parts of neighbouring
countries, so only boundaries inside this country are kept. A level is used only
if its regions together cover the country. Otherwise the country becomes a
single region, so that no data is silently left out of the database.
"""
import argparse
import json
from pathlib import Path

import osmium
from shapely.geometry import mapping, shape
from shapely.ops import unary_union
from shapely.validation import make_valid

MIN_REGIONS = 2
MAX_REGIONS = 150
MIN_COVERAGE = 0.85
MIN_INSIDE_COUNTRY = 0.8
REGION_LEVELS = range(3, 9)


def label(tags):
    return tags.get("name:en") or tags.get("int_name") or tags.get("name")


def read_boundaries(pbf):
    """Every administrative boundary in the extract that forms a valid area."""
    factory = osmium.geom.GeoJSONFactory()
    processor = (
        osmium.FileProcessor(str(pbf))
        .with_locations()
        .with_areas(osmium.filter.TagFilter(("boundary", "administrative")))
        .with_filter(osmium.filter.EntityFilter(osmium.osm.AREA))
    )
    boundaries = []
    for area in processor:
        tags = dict(area.tags)
        level = tags.get("admin_level", "")
        if tags.get("boundary") != "administrative" or not level.isdigit():
            continue
        try:
            geometry = shape(json.loads(factory.create_multipolygon(area)))
        except (RuntimeError, ValueError):
            continue
        if geometry.is_empty:
            continue
        boundaries.append({
            "id": ("w" if area.from_way() else "r") + str(area.orig_id()),
            "level": int(level),
            "tags": tags,
            "shape": make_valid(geometry),
        })
    return boundaries


def find_country(boundaries, code):
    """The highest-level boundary carrying this country's ISO code."""
    matches = [
        item for item in boundaries
        if code in (item["tags"].get("ISO3166-1"), item["tags"].get("ISO3166-1:alpha2"))
    ]
    return min(matches, key=lambda item: (item["level"], -item["shape"].area), default=None)


def assemble_country(boundaries, code, name):
    """The country's outline, even when the extract cuts its own border.

    A long border can leave the country's relation with missing ways, so it never
    forms an area. Returns the outline and whether it had to be pieced together.
    """
    country = find_country(boundaries, code)
    if country:
        return country, False
    parts = [item for item in boundaries if item["tags"].get("ISO3166-2", "").startswith(code + "-")]
    if parts:
        top = min(item["level"] for item in parts)
        return {
            "id": "",
            "level": top - 1,
            "tags": {},
            "shape": make_valid(unary_union([item["shape"] for item in parts if item["level"] == top])),
        }, True
    named = [item for item in boundaries if label(item["tags"]) == name]
    if named:
        return min(named, key=lambda item: (item["level"], -item["shape"].area)), False
    return None, False


def belongs_to_country(item, country_shape, code):
    iso = item["tags"].get("ISO3166-2")
    if iso and not iso.startswith(code + "-"):
        return False
    inside = item["shape"].intersection(country_shape).area
    return inside >= item["shape"].area * MIN_INSIDE_COUNTRY


def choose_regions(boundaries, country, code):
    """The first level below the country whose boundaries cover it, or None."""
    country_shape = country["shape"]
    for level in REGION_LEVELS:
        if level <= country["level"]:
            continue
        members = [
            item for item in boundaries
            if item["level"] == level and item["id"] != country["id"]
            and label(item["tags"]) and belongs_to_country(item, country_shape, code)
        ]
        if not MIN_REGIONS <= len(members) <= MAX_REGIONS:
            continue
        covered = unary_union([item["shape"] for item in members]).intersection(country_shape)
        if covered.area >= country_shape.area * MIN_COVERAGE:
            return sorted(members, key=lambda item: label(item["tags"]))
    return None


def region_features(members, country_shape):
    """GeoJSON features clipped to the country, each with a unique code."""
    features = []
    seen = set()
    for item in members:
        code = item["tags"].get("ISO3166-2") or item["id"].upper()
        if code in seen or code == "all":
            code = item["id"].upper()
        seen.add(code)
        features.append({
            "type": "Feature",
            "properties": {"code": code, "name": label(item["tags"])},
            "geometry": mapping(make_valid(item["shape"].intersection(country_shape))),
        })
    return features


def relation_url(item):
    kind = "way" if item["id"].startswith("w") else "relation"
    return f"https://www.openstreetmap.org/{kind}/{item['id'][1:]}"


def other_areas(country_shape, code):
    """A region for what a pieced-together outline may have missed.

    Objects outside every region are dropped from the database, so a state whose
    own boundary is also broken would otherwise silently disappear.
    """
    remainder = make_valid(country_shape.convex_hull.difference(country_shape))
    if remainder.is_empty or remainder.area == 0:
        return []
    return [{
        "type": "Feature",
        "properties": {"code": code + "-OTHER", "name": "Other areas"},
        "geometry": mapping(remainder),
    }]


def extract(pbf, code, name, source, output_dir):
    boundaries = read_boundaries(pbf)
    country, pieced = assemble_country(boundaries, code, name)
    if country is None:
        raise SystemExit(f"No complete {name} boundary was found in this extract.")
    members = choose_regions(boundaries, country, code)
    if members:
        features = region_features(members, country["shape"])
        print(f"Found {len(features)} regions (admin level {members[0]['level']})", flush=True)
    else:
        features = [{
            "type": "Feature",
            "properties": {"code": code, "name": name},
            "geometry": mapping(country["shape"]),
        }]
        print("No complete set of regions found, using the whole country as one region", flush=True)
    if pieced:
        print("The country's own boundary is incomplete, so its outline was built from its regions", flush=True)
        features += other_areas(country["shape"], code)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / f"{code}.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False)
    )
    (output_dir / f"{code}.json").write_text(json.dumps({
        "id": code,
        "name": name,
        "division": "Region",
        "source": source,
        "boundarySource": relation_url(country) if country["id"] else source,
        "boundaryCredit": "OpenStreetMap contributors",
        "boundaryLicense": "ODbL 1.0",
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--code", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--pbf", type=Path, required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    extract(args.pbf, args.code, args.name, args.source, args.output_dir)

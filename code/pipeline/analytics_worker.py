"""Geometry work for parallel builds. Each process holds its own copy of the regions."""
import importlib.util
import json
from pathlib import Path
import sys

from shapely import from_wkb
from shapely.geometry import Point

sys.path.insert(0, str(Path(__file__).resolve().parent))
from geometry_codec import encode_geometry  # noqa: E402

state = {}


def init(script, boundaries, country_json):
    spec = importlib.util.spec_from_file_location("prepare_analytics_worker", script)
    pipeline = importlib.util.module_from_spec(spec)
    sys.modules["prepare_analytics_worker"] = pipeline
    spec.loader.exec_module(pipeline)
    country = json.loads(country_json)
    features = json.loads(Path(boundaries).read_text())["features"]
    project, unproject = pipeline.projections(country, features)
    regions = pipeline.load_regions(features, country, project)
    state["census"] = pipeline.Census(regions, None, {"n": set(), "w": set()}, project, unproject)
    state["pipeline"] = pipeline


def process_node(census, lon, lat, has_tags):
    scopes = census.scopes(Point(*census.project(lon, lat)), 0)
    return scopes, encode_geometry(Point(lon, lat)) if has_tags and scopes else None, (lon, lat, lon, lat)


def process_way(census, pipeline, wkb, tags):
    try:
        line = from_wkb(wkb)
        geometry = census.fast_project(line)
    except (RuntimeError, ValueError):
        return None
    scopes = census.scopes(geometry, 1)
    shaped = pipeline.way_shape(line, tags) if scopes and tags else None
    if shaped is None or shaped.is_empty:
        return scopes, None, None
    return scopes, encode_geometry(shaped), shaped.bounds


def process_area(census, pipeline, wkb):
    try:
        wgs84 = from_wkb(wkb)
        polygon = census.fast_project(wgs84)
        return (census.scopes(polygon if polygon.is_valid else pipeline.make_valid(polygon), 2),)
    except (RuntimeError, ValueError):
        return None


def process(batch):
    census, pipeline = state["census"], state["pipeline"]
    results = []
    for item in batch:
        if item[0] == "n":
            results.append(process_node(census, *item[1:]))
        elif item[0] == "w":
            results.append(process_way(census, pipeline, *item[1:]))
        else:
            results.append(process_area(census, pipeline, *item[1:]))
    return results

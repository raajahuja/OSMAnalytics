"""Build a read-only analytics database from a country's OSM extract and region boundaries."""

import argparse
from collections import Counter, defaultdict, deque
import concurrent.futures
import json
import math
import multiprocessing
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile

import numpy
import osmium
from pyproj import Transformer
import shapely
from shapely import STRtree, from_wkb, line_merge, make_valid, prepare, to_geojson, union_all
from shapely.geometry import GeometryCollection, MultiLineString, Point, Polygon, shape
from shapely.ops import transform

sys.path.insert(0, str(Path(__file__).resolve().parent))
from geometry_codec import encode_geometry  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
INPUT = ROOT / "input"
COUNTRIES = Path(__file__).resolve().parent / "countries"
# More workers don't help: reading the file and writing SQLite become the limit.
PARALLEL_WORKERS = 4
PARALLEL_MIN_BYTES = 20_000_000
BATCH_SIZE = 1000
SCHEMA = 2
# Tests lower these so a small fixture exercises the same paths as a real country.
ID_LIST_MIN_OBJECTS = int(os.environ.get("WAYFINDER_LIST_MIN", 5000))
SEARCH_MIN_VALUES = int(os.environ.get("WAYFINDER_SEARCH_MIN_VALUES", 1000))
RELATION_DETAIL_COORDINATES = 2000
WHOLE_KEY, REGION_LISTS, KIND_LISTS = -1, -2, -3
KIND_IDS = {"node": 0, "way": 1, "relation": 2}
ROAD_CLASSES = frozenset("""
motorway motorway_link trunk trunk_link primary primary_link secondary secondary_link
tertiary tertiary_link unclassified residential living_street service track road
""".split())
PATH_CLASSES = frozenset("footway cycleway path steps pedestrian bridleway corridor".split())
RAIL_CLASSES = frozenset("rail light_rail tram subway narrow_gauge monorail funicular miniature".split())
AREA_KEYS = {"building", "building:part", "landuse", "amenity", "leisure", "shop", "tourism", "office", "historic", "place"}


def load_country(value):
    """Read a country config by ID (code/pipeline/countries/XX.json) or by file path."""
    path = Path(value) if str(value).endswith(".json") else COUNTRIES / f"{value}.json"
    country = json.loads(path.read_text())
    if not re.fullmatch(r"[A-Z]{2}", country["id"]):
        raise ValueError("Country id must be two capital letters.")
    return country


def projections(country, features):
    """Forward and inverse transforms for measuring in metres.

    A country can name a national CRS. Otherwise an equal-area projection is
    centred on its regions, using 3D averaging so 179E and 179W centre near 180.
    """
    crs = country.get("crs")
    if crs is None:
        points = [shape(feature["geometry"]).representative_point() for feature in features]
        vectors = [
            (math.cos(math.radians(p.y)) * math.cos(math.radians(p.x)),
             math.cos(math.radians(p.y)) * math.sin(math.radians(p.x)),
             math.sin(math.radians(p.y)))
            for p in points
        ]
        x, y, z = (sum(axis) for axis in zip(*vectors))
        latitude, longitude = math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x))
        crs = f"+proj=laea +lat_0={latitude} +lon_0={longitude} +datum=WGS84 +units=m +no_defs"
    return (
        Transformer.from_crs(4326, crs, always_xy=True).transform,
        Transformer.from_crs(crs, 4326, always_xy=True).transform,
    )


def longitude_unwrapper(geometry):
    """Return a function that gives a country crossing 180 degrees continuous longitudes."""

    def eastward(coordinates):
        coordinates = coordinates.copy()
        coordinates[coordinates[:, 0] < 0, 0] += 360
        return coordinates

    longitudes = shapely.get_coordinates(geometry)[:, 0]
    if numpy.ptp(numpy.where(longitudes < 0, longitudes + 360, longitudes)) < numpy.ptp(longitudes):
        return lambda item: shapely.transform(item, eastward)
    return lambda item: item


def display_relation(geometry, tags):
    """Thin out huge abstract relations such as transit networks and treaties.

    Their full shape can be 20 MB, and every nearby search inside them has to read
    it. Real areas (multipolygons) and waterways keep every point.
    """
    if tags.get("type") in {"multipolygon", "waterway"}:
        return geometry
    if shapely.get_num_coordinates(geometry) <= RELATION_DETAIL_COORDINATES:
        return geometry
    parts = shapely.get_parts(shapely.get_parts(geometry))
    drawn = parts[shapely.get_dimensions(parts) > 0]
    if not len(drawn):
        return geometry
    lines = drawn[shapely.get_dimensions(drawn) == 1]
    areas = drawn[shapely.get_dimensions(drawn) == 2]
    merged = shapely.get_parts(line_merge(MultiLineString(list(lines)))) if len(lines) else lines
    x0, y0, x1, y1 = geometry.bounds
    simplified = shapely.simplify(
        numpy.concatenate((merged, areas)), max(x1 - x0, y1 - y0) / 1000, preserve_topology=False,
    )
    kept = simplified[~shapely.is_empty(simplified)]
    return GeometryCollection(list(kept)) if len(kept) else geometry


def edited_at(item):
    """Last-edit time in Unix seconds, or None when the extract has no metadata."""
    seconds = int(item.timestamp.timestamp())
    return seconds if seconds > 0 else None


def way_shape(line, tags):
    """Closed ways are filled only when their tags describe an area."""
    explicit = tags.get("area")
    natural = tags.get("natural")
    area = explicit == "yes" or (
        explicit != "no" and not {"highway", "barrier", "railway"}.intersection(tags) and (
            any(tags.get(key) not in (None, "no") for key in AREA_KEYS)
            or (natural and natural not in {"coastline", "cliff", "ridge", "arete", "tree_row"})
        )
    )
    if area and line.is_closed and len(line.coords) >= 4:
        polygon = Polygon(line)
        if polygon.is_valid and polygon.area > 0:
            return polygon
    return line

# Themes are convenience views. The tag database is built independently of them.
THEMES = {
    "roads": ("Roads", "highway", "length", "Motor road classes, including service roads and tracks. Counts are OSM ways."),
    "barriers": ("Barriers", "barrier", "length", "Barrier nodes and ways. Length covers linear barriers."),
    "buildings": ("Buildings", "building", "area", "Assembled building footprints from ways and multipolygon relations."),
    "paths": ("Paths & cycleways", "highway", "length", "Mapped footways, cycleways, paths, steps, pedestrian ways and bridleways."),
    "waterways": ("Waterways", "waterway", "length", "Linear rivers, streams, drains, canals and other mapped waterways."),
    "rail": ("Rail tracks", "railway", "length", "Mapped tracks in active rail classes, including trams and narrow gauge."),
    "amenities": ("Amenities", "amenity", None, "OSM nodes and ways tagged as amenities."),
    "shops": ("Shops", "shop", None, "OSM nodes and ways tagged as shops."),
    "transit": ("Public transport", "public_transport", None, "OSM nodes and ways carrying the public_transport tag."),
    "landuse": ("Land use", "landuse", "area", "Assembled areas with a land-use tag. Areas can overlap."),
    "controls": ("Traffic controls", "highway", None, "Traffic signals, stop signs, give-way signs and crossings mapped as nodes."),
    "power": ("Power infrastructure", "power", "length", "Power nodes and ways. Length covers power lines, minor lines and cables."),
}


def theme_matches(kind, tags):
    highway = tags.get("highway")
    if kind == "way" and tags.get("area") != "yes":
        if highway in ROAD_CLASSES:
            yield "roads", highway
        if highway in PATH_CLASSES:
            yield "paths", highway
        if tags.get("railway") in RAIL_CLASSES:
            yield "rail", tags["railway"]
        if tags.get("waterway") not in {None, "", "no", "riverbank", "proposed", "construction"}:
            yield "waterways", tags["waterway"]
    if kind == "node" and highway in {"traffic_signals", "stop", "give_way", "crossing"}:
        yield "controls", highway
    candidates = (
        ("buildings", "landuse") if kind == "area"
        else ("barriers", "amenities", "shops", "transit", "power")
    )
    for theme in candidates:
        value = tags.get(THEMES[theme][1])
        if value and value not in {"no", "vacant", "disused"}:
            yield theme, value


def array_projector(function):
    """Project a whole geometry at once rather than one coordinate tuple at a time."""
    def apply(coordinates):
        x, y = function(coordinates[:, 0], coordinates[:, 1])
        return numpy.column_stack((x, y))
    return lambda geometry: shapely.transform(geometry, apply)


class Census(osmium.SimpleHandler):
    def __init__(self, regions, connection, relation_members, project, unproject):
        super().__init__()
        self.project = project
        self.unproject = unproject
        self.regions = regions
        self.polygons = [region["shape"] for region in regions]
        self.tree = STRtree(self.polygons)
        self.country = union_all(self.polygons)
        self.unwrap = longitude_unwrapper(transform(unproject, self.country))
        self.crosses_180 = self.unwrap(Point(-1, 0)).x != -1
        for polygon in [self.country, *self.polygons]:
            prepare(polygon)
        self.connection = connection
        self.pending = []
        self.map_features = []
        self.map_bounds = []
        self.map_tags = []
        self.feature_regions = []
        self.feature_freshness = []
        self.key_ids = {}
        self.value_ids = {}
        self.relation_meta = {}
        self.next_feature = 0
        self.region_index = {region["id"]: index for index, region in enumerate(regions)}
        self.member_geometry = {}
        self.context_roads = []
        self.context_places = []
        self.overview = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: [0, 0.0, 0.0])))
        self.objects = defaultdict(Counter)
        self.skipped = Counter()
        self.relation_members = relation_members
        self.membership = {}
        self.area_relations = {}
        self.wkb = osmium.geom.WKBFactory()
        self.fast_project = array_projector(project)

    def scopes(self, geometry, dimension):
        if geometry.is_empty:
            return []
        # The tree only compares bounding boxes. The exact test is then made against
        # the prepared regions, because the borders are far more detailed than features.
        candidates = sorted(self.tree.query(geometry))
        if dimension == 0:
            # One canton owns points exactly on a shared border.
            for index in candidates:
                if self.polygons[index].intersects(geometry):
                    return [("all", 0), (self.regions[index]["id"], 0)]
            return []
        metric = "length" if dimension == 1 else "area"
        memberships = []
        inside_one_region = False
        for index in candidates:
            polygon = self.polygons[index]
            if polygon.covers(geometry):
                portion = geometry
                inside_one_region = True
            elif polygon.intersects(geometry):
                portion = polygon.intersection(geometry)
            else:
                continue
            amount = getattr(portion, metric)
            if amount > 0:
                memberships.append((self.regions[index]["id"], amount))
        if not memberships:
            return []
        portion = geometry if inside_one_region or self.country.covers(geometry) else self.country.intersection(geometry)
        return [("all", getattr(portion, metric)), *memberships]

    def tags(self, kind, object_id, tags, regions, geometry, version=None, edited=None):
        if not regions:
            return
        drawn = geometry is not None and not geometry.is_empty
        self.record(
            kind, object_id, tags, regions,
            encode_geometry(geometry) if drawn else None, geometry.bounds if drawn else None,
            version, edited,
        )

    def record(self, kind, object_id, tags, regions, encoded, bounds, version, edited):
        if not regions:
            return
        for region in regions:
            self.objects[region][kind] += 1
            self.pending.extend((region, kind, object_id, key, value) for key, value in tags.items())
        if encoded is not None:
            self.next_feature += 1
            fid = self.next_feature
            self.feature_regions.extend((fid, self.region_index[region]) for region in regions if region != "all")
            self.map_features.append((fid, kind, object_id, tags.get("name"), encoded))
            west, south, east, north = bounds
            self.map_bounds.append((fid, west, east, south, north))
            longitude = (west + east) / 2
            self.feature_freshness.append((
                fid, version or None, edited,
                longitude + 360 if self.crosses_180 and longitude < 0 else longitude,
                (south + north) / 2,
            ))
            self.map_tags.extend(
                (self.key_ids.setdefault(key, len(self.key_ids)), fid,
                 self.value_ids.setdefault(value, len(self.value_ids)))
                for key, value in tags.items()
            )
        if len(self.pending) >= 40_000:
            self.flush()

    def flush(self):
        self.connection.executemany("INSERT INTO tag_records VALUES (?, ?, ?, ?, ?)", self.pending)
        self.connection.executemany("INSERT INTO map_features VALUES (?, ?, ?, ?, ?)", self.map_features)
        self.connection.executemany("INSERT INTO map_bounds VALUES (?, ?, ?, ?, ?)", self.map_bounds)
        self.connection.executemany("INSERT INTO map_tags VALUES (?, ?, ?)", self.map_tags)
        self.connection.executemany("INSERT INTO feature_regions VALUES (?, ?)", self.feature_regions)
        self.feature_regions.clear()
        self.connection.executemany("INSERT INTO feature_freshness VALUES (?, ?, ?, ?, ?)", self.feature_freshness)
        self.feature_freshness.clear()
        self.pending.clear()
        self.map_features.clear()
        self.map_bounds.clear()
        self.map_tags.clear()

    def add_themes(self, matches, scopes, dimension):
        for theme, value in matches:
            for region, amount in scopes:
                row = self.overview[region][theme][value]
                row[0] += 1
                if THEMES[theme][2] == "length" and dimension == 1:
                    row[1] += amount / 1000
                if THEMES[theme][2] == "area" and dimension == 2:
                    row[2] += amount / 1_000_000

    def node(self, node):
        is_member = node.id in self.relation_members["n"]
        if not node.tags and not is_member:
            return
        if not node.location.valid():
            self.skipped["nodes"] += bool(node.tags)
            return
        tags = dict(node.tags)
        point = Point(node.lon, node.lat)
        scopes = self.scopes(Point(*self.project(node.lon, node.lat)), 0)
        regions = [region for region, _ in scopes]
        if is_member:
            self.membership[("n", node.id)] = set(regions)
            if regions:
                self.member_geometry[("n", node.id)] = point
        if tags:
            self.tags("node", node.id, tags, regions, point, node.version, edited_at(node))
            if regions and tags.get("place") in {"city", "town", "village"} and tags.get("name"):
                self.context_places.append({
                    "type": "Feature", "geometry": json.loads(to_geojson(self.unwrap(point))),
                    "properties": {"layer": "place", "name": tags["name"], "rank": tags["place"]},
                })
            self.add_themes(theme_matches("node", tags), scopes, 0)

    def way(self, way):
        is_member = way.id in self.relation_members["w"]
        if not way.tags and not is_member:
            return
        try:
            line = from_wkb(self.wkb.create_linestring(way))
            geometry = self.fast_project(line)
        except (RuntimeError, ValueError):
            self.skipped["ways"] += bool(way.tags)
            return
        tags = dict(way.tags)
        scopes = self.scopes(geometry, 1)
        regions = [region for region, _ in scopes]
        if is_member:
            self.membership[("w", way.id)] = set(regions)
            if regions:
                self.member_geometry[("w", way.id)] = line
        if tags:
            self.tags("way", way.id, tags, regions, way_shape(line, tags) if regions else None, way.version, edited_at(way))
            if regions and tags.get("highway") in {"motorway", "trunk", "primary"}:
                self.context_roads.append(line)
            for theme, value in theme_matches("way", tags):
                dimension = 0 if theme == "power" and value not in {"line", "minor_line", "cable"} else 1
                self.add_themes([(theme, value)], scopes, dimension)

    def area(self, area):
        tags = dict(area.tags)
        matches = list(theme_matches("area", tags))
        if area.from_way() and not matches:
            return
        try:
            wgs84 = from_wkb(self.wkb.create_multipolygon(area))
            polygon = self.fast_project(wgs84)
            scopes = self.scopes(polygon if polygon.is_valid else make_valid(polygon), 2)
        except (RuntimeError, ValueError):
            self.skipped["areas"] += 1
            return
        if not area.from_way():
            self.area_relations[area.orig_id()] = {region for region, _ in scopes}
            if scopes:
                self.member_geometry[("r", area.orig_id())] = wgs84 if wgs84.is_valid else make_valid(wgs84)
        self.add_themes(matches, scopes, 2)

    def add_relations(self, relations):
        scopes = {}
        parents = defaultdict(set)
        for object_id, (_, members) in relations.items():
            if object_id in self.area_relations:
                scopes[object_id] = self.area_relations[object_id]
                continue
            regions = set()
            for kind, ref in members:
                if kind == "r":
                    parents[ref].add(object_id)
                else:
                    regions.update(self.membership.get((kind, ref), ()))
            scopes[object_id] = regions
        # Propagate resolved membership through nested relations, including cycles.
        pending = deque(ref for ref, regions in scopes.items() if regions)
        while pending:
            child = pending.popleft()
            for parent in parents[child]:
                added = scopes[child] - scopes[parent]
                if added:
                    scopes[parent].update(added)
                    pending.append(parent)
        for object_id, (tags, _) in relations.items():
            if tags and scopes[object_id]:
                geometry = self.relation_shape(object_id, relations)
                if geometry is not None and not geometry.is_empty:
                    geometry = display_relation(geometry, tags)
                self.tags("relation", object_id, tags, sorted(scopes[object_id]), geometry, *self.relation_meta.get(object_id, (None, None)))
        self.flush()

    def relation_shape(self, object_id, relations):
        # Multipolygons keep their rings. Other relations draw located member geometry.
        pending = [("r", object_id)]
        visited = set()
        parts = []
        while pending:
            member = pending.pop()
            if member in visited:
                continue
            visited.add(member)
            if member in self.member_geometry:
                parts.append(self.member_geometry[member])
            elif member[0] == "r" and member[1] in relations:
                pending.extend(relations[member[1]][1])
        if len(parts) == 1:
            return parts[0]
        return GeometryCollection(parts)

    def map_context(self):
        features = [
            {
                "type": "Feature",
                "properties": {"layer": "canton", "name": region["name"]},
                "geometry": json.loads(to_geojson(self.unwrap(transform(self.unproject, region["shape"].simplify(18))))),
            }
            for region in self.regions
        ]
        if self.context_roads:
            roads = self.unwrap(line_merge(MultiLineString(self.context_roads)).simplify(0.00009))
            features.append({
                "type": "Feature", "properties": {"layer": "roads"},
                "geometry": json.loads(to_geojson(roads)),
            })
        return {"type": "FeatureCollection", "features": features + self.context_places}


def outline(geometry, bounds):
    x0, y0, x1, y1 = bounds
    scale = min(340 / (x1 - x0), 420 / (y1 - y0))
    def point(x, y):
        return round(200 + (x - (x0 + x1) / 2) * scale, 1), round(235 - (y - (y0 + y1) / 2) * scale, 1)
    def ring(coords):
        return "M" + "L".join(f"{x},{y}" for x, y in (point(*xy) for xy in coords)) + "Z"
    simplified = geometry.simplify(60, preserve_topology=True)
    polygons = [simplified] if simplified.geom_type == "Polygon" else simplified.geoms
    return (
        "".join(ring(p.exterior.coords) + "".join(ring(h.coords) for h in p.interiors) for p in polygons),
        point(geometry.representative_point().x, geometry.representative_point().y),
    )


class ParallelCensus(Census):
    """Sends geometry work to other processes and applies results in the original order.

    Feature IDs and running totals depend on that order, so the database is identical
    to a single-process build.
    """

    def start_pool(self, boundaries, country, workers):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import analytics_worker
        self.worker = analytics_worker
        self.pool = concurrent.futures.ProcessPoolExecutor(
            workers,
            mp_context=multiprocessing.get_context("spawn"),
            initializer=analytics_worker.init,
            initargs=(str(Path(__file__).resolve()), str(boundaries), json.dumps(country)),
        )
        self.inflight = deque()
        self.batch = []
        self.details = []
        self.max_inflight = workers * 4

    def submit(self):
        if self.batch:
            self.inflight.append((self.pool.submit(self.worker.process, self.batch), self.details))
            self.batch, self.details = [], []
        while len(self.inflight) > self.max_inflight:
            self.apply_oldest()

    def apply_oldest(self):
        future, details = self.inflight.popleft()
        for detail, result in zip(details, future.result()):
            self.apply(detail, result)

    def finish(self):
        self.submit()
        while self.inflight:
            self.apply_oldest()

    def close_pool(self):
        self.pool.shutdown(wait=True, cancel_futures=True)

    def add(self, item, detail):
        self.batch.append(item)
        self.details.append(detail)
        if len(self.batch) >= BATCH_SIZE:
            self.submit()

    def node(self, node):
        is_member = node.id in self.relation_members["n"]
        if not node.tags and not is_member:
            return
        if not node.location.valid():
            self.skipped["nodes"] += bool(node.tags)
            return
        tags = dict(node.tags)
        self.add(
            ("n", node.lon, node.lat, bool(tags)),
            ("n", node.id, tags, is_member, node.lon, node.lat, node.version, edited_at(node)),
        )

    def way(self, way):
        is_member = way.id in self.relation_members["w"]
        if not way.tags and not is_member:
            return
        try:
            wkb = self.wkb.create_linestring(way)
        except (RuntimeError, ValueError):
            self.skipped["ways"] += bool(way.tags)
            return
        tags = dict(way.tags)
        self.add(("w", wkb, tags), ("w", way.id, tags, is_member, wkb, way.version, edited_at(way)))

    def area(self, area):
        tags = dict(area.tags)
        matches = list(theme_matches("area", tags))
        if area.from_way() and not matches:
            return
        try:
            wkb = self.wkb.create_multipolygon(area)
        except (RuntimeError, ValueError):
            self.skipped["areas"] += 1
            return
        self.add(("a", wkb), ("a", area.from_way(), area.orig_id(), matches, wkb))

    def apply(self, detail, result):
        {"n": self.apply_node, "w": self.apply_way, "a": self.apply_area}[detail[0]](detail, result)

    def apply_node(self, detail, result):
        _, node_id, tags, is_member, lon, lat, version, edited = detail
        scopes, encoded, bounds = result
        regions = [region for region, _ in scopes]
        if is_member:
            self.membership[("n", node_id)] = set(regions)
            if regions:
                self.member_geometry[("n", node_id)] = Point(lon, lat)
        if tags:
            self.record("node", node_id, tags, regions, encoded, bounds, version, edited)
            if regions and tags.get("place") in {"city", "town", "village"} and tags.get("name"):
                self.context_places.append({
                    "type": "Feature", "geometry": json.loads(to_geojson(self.unwrap(Point(lon, lat)))),
                    "properties": {"layer": "place", "name": tags["name"], "rank": tags["place"]},
                })
            self.add_themes(theme_matches("node", tags), scopes, 0)

    def apply_way(self, detail, result):
        _, way_id, tags, is_member, wkb, version, edited = detail
        if result is None:
            self.skipped["ways"] += bool(tags)
            return
        scopes, encoded, bounds = result
        regions = [region for region, _ in scopes]
        if is_member:
            self.membership[("w", way_id)] = set(regions)
            if regions:
                self.member_geometry[("w", way_id)] = from_wkb(wkb)
        if tags:
            self.record("way", way_id, tags, regions, encoded, bounds, version, edited)
            if regions and tags.get("highway") in {"motorway", "trunk", "primary"}:
                self.context_roads.append(from_wkb(wkb))
            for theme, value in theme_matches("way", tags):
                dimension = 0 if theme == "power" and value not in {"line", "minor_line", "cable"} else 1
                self.add_themes([(theme, value)], scopes, dimension)

    def apply_area(self, detail, result):
        _, from_way, orig_id, matches, wkb = detail
        if result is None:
            self.skipped["areas"] += 1
            return
        scopes = result[0]
        if not from_way:
            self.area_relations[orig_id] = {region for region, _ in scopes}
            if scopes:
                wgs84 = from_wkb(wkb)
                self.member_geometry[("r", orig_id)] = wgs84 if wgs84.is_valid else make_valid(wgs84)
        self.add_themes(matches, scopes, 2)


def load_regions(features, country, project):
    code, name = country.get("codeProperty", "code"), country.get("nameProperty", "name")
    regions = [
        {"id": str(feature["properties"][code]), "name": feature["properties"][name],
         "shape": make_valid(transform(project, shape(feature["geometry"])))}
        for feature in features
    ]
    regions.sort(key=lambda region: region["id"])
    return regions


def write_tag_names(connection, census):
    connection.executescript("""
        CREATE TABLE tag_key_names (id INTEGER PRIMARY KEY, key TEXT NOT NULL);
        CREATE TABLE tag_value_names (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    """)
    connection.executemany("INSERT INTO tag_key_names VALUES (?, ?)", ((i, key) for key, i in census.key_ids.items()))
    connection.executemany("INSERT INTO tag_value_names VALUES (?, ?)", ((i, value) for value, i in census.value_ids.items()))
    connection.execute("CREATE UNIQUE INDEX tag_value_lookup ON tag_value_names(value)")


def store_list(connection, first, second, ids):
    connection.execute("INSERT INTO id_lists VALUES (?, ?, ?)", (first, second, ids.astype("<u4").tobytes()))


def build_id_lists(connection):
    """Sorted feature IDs for each common tag, region and object type."""
    connection.execute("""
        CREATE TABLE id_lists (
            key_id INTEGER NOT NULL, value_id INTEGER NOT NULL, ids BLOB NOT NULL,
            PRIMARY KEY(key_id, value_id)
        )
    """)
    def read(query, parameters):
        return numpy.fromiter((row[0] for row in connection.execute(query, parameters)), dtype=numpy.uint32)

    keys = connection.execute(
        "SELECT key_id FROM map_tags GROUP BY key_id HAVING COUNT(*) >= ?", (ID_LIST_MIN_OBJECTS,),
    ).fetchall()
    for (key,) in keys:
        store_list(connection, key, WHOLE_KEY, read("SELECT fid FROM map_tags WHERE key_id=? ORDER BY fid", (key,)))
    pairs = connection.execute(
        "SELECT key_id, value_id FROM map_tags GROUP BY key_id, value_id HAVING COUNT(*) >= ?", (ID_LIST_MIN_OBJECTS,),
    ).fetchall()
    for key, value in pairs:
        store_list(connection, key, value, read("SELECT fid FROM map_tags WHERE key_id=? AND value_id=? ORDER BY fid", (key, value)))

    rows = connection.execute("SELECT fid, region FROM feature_regions ORDER BY fid").fetchall()
    if rows:
        fids, regions = numpy.array(rows, dtype=numpy.uint32).T
        for region in numpy.unique(regions):
            store_list(connection, REGION_LISTS, int(region), fids[regions == region])
    for kind, kind_id in KIND_IDS.items():
        store_list(connection, KIND_LISTS, kind_id, read("SELECT fid FROM map_features WHERE kind=? ORDER BY fid", (kind,)))


def build_value_search(connection):
    """A substring index over the values of keys with too many to scan."""
    connection.executescript("""
        CREATE VIRTUAL TABLE value_search USING fts5(value, content='', tokenize='trigram', columnsize=0);
    """)
    keys = [key for (key,) in connection.execute(
        "SELECT key FROM tag_keys WHERE region='all' AND values_all >= ?", (SEARCH_MIN_VALUES,),
    )]
    for key in keys:
        # Objects with no drawable shape have values that aren't in the dictionary yet.
        connection.execute(
            "INSERT OR IGNORE INTO tag_value_names(value) SELECT value FROM tag_values WHERE region='all' AND key=?",
            (key,),
        )
    connection.execute("CREATE TEMP TABLE searched (id INTEGER PRIMARY KEY)")
    for key in keys:
        connection.execute("""
            INSERT OR IGNORE INTO searched
            SELECT n.id FROM tag_values v JOIN tag_value_names n ON n.value = v.value
            WHERE v.region='all' AND v.key=?
        """, (key,))
    connection.execute("""
        INSERT INTO value_search(rowid, value)
        SELECT n.id, n.value FROM searched s JOIN tag_value_names n ON n.id = s.id
    """)
    connection.execute("DROP TABLE searched")


def run_node_script(script, *arguments):
    node = os.environ.get("WAYFINDER_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is needed to finish the build. Set WAYFINDER_NODE.")
    subprocess.run(
        [node, "--no-warnings", str(Path(__file__).resolve().parent / script), *map(str, arguments)],
        check=True,
    )


def build_rollups(database):
    run_node_script("build-rollups.mjs", database)


def build_tiles(database, tiles):
    run_node_script("build-tiles.mjs", database, tiles)


def build(pbf, boundaries, output, country, workers=None):

    features = json.loads(boundaries.read_text())["features"]
    project, unproject = projections(country, features)
    regions = load_regions(features, country, project)
    identifiers = {region["id"] for region in regions}
    expected = country.get("expectedRegions")
    if not regions or len(identifiers) != len(regions) or "all" in identifiers or (expected and len(regions) != expected):
        raise ValueError(f"Expected {expected or 'one or more'} unique regions for {country['name']}.")
    with osmium.io.Reader(str(pbf)) as reader:
        snapshot = reader.header().get("osmosis_replication_timestamp")
    relations = {}
    relation_meta = {}
    relation_members = {"n": set(), "w": set()}
    for relation in osmium.FileProcessor(str(pbf), osmium.osm.RELATION):
        members = [(member.type, member.ref) for member in relation.members]
        relations[relation.id] = (dict(relation.tags), members)
        relation_meta[relation.id] = (relation.version, edited_at(relation))
        for kind, ref in members:
            if kind in relation_members:
                relation_members[kind].add(ref)
    print(f"Reading OSM geometries and tags from {pbf.name} ({snapshot})", flush=True)

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as working:
        temporary = Path(working) / output.name
        connection = sqlite3.connect(temporary)
        try:
            connection.executescript("""
                PRAGMA journal_mode=OFF;
                PRAGMA synchronous=OFF;
                CREATE TABLE tag_records(region TEXT, kind TEXT, object_id INTEGER, key TEXT, value TEXT);
                CREATE TABLE map_features (
                    fid INTEGER PRIMARY KEY, kind TEXT NOT NULL, osm_id INTEGER NOT NULL,
                    label TEXT, geometry BLOB NOT NULL
                );
                CREATE TABLE feature_regions (
                    fid INTEGER NOT NULL, region INTEGER NOT NULL,
                    PRIMARY KEY(fid, region)
                ) WITHOUT ROWID;
                CREATE TABLE feature_freshness (
                    fid INTEGER PRIMARY KEY, version INTEGER, edited INTEGER, lon REAL NOT NULL, lat REAL NOT NULL
                ) WITHOUT ROWID;
                CREATE VIRTUAL TABLE map_bounds USING rtree(fid, west, east, south, north);
                CREATE TABLE map_tags (
                    key_id INTEGER NOT NULL, fid INTEGER NOT NULL, value_id INTEGER NOT NULL,
                    PRIMARY KEY(key_id, fid)
                ) WITHOUT ROWID;
            """)
            if workers is None:
                workers = PARALLEL_WORKERS if Path(pbf).stat().st_size >= PARALLEL_MIN_BYTES else 1
            handler = ParallelCensus if workers > 1 else Census
            census = handler(regions, connection, relation_members, project, unproject)
            census.relation_meta = relation_meta
            # Node locations go in a file on disk, so memory doesn't hold every map point.
            node_index = "flex_mem" if "," in working else f"sparse_file_array,{working}/nodes.idx"
            if workers > 1:
                census.start_pool(boundaries, country, workers)
                try:
                    census.apply_file(str(pbf), locations=True, idx=node_index)
                    census.finish()
                finally:
                    census.close_pool()
            else:
                census.apply_file(str(pbf), locations=True, idx=node_index)
            census.add_relations(relations)
            write_tag_names(connection, census)
            print("Aggregating every OSM tag key and value", flush=True)
            connection.executescript("""
                CREATE INDEX map_tags_exact ON map_tags(key_id, value_id);
                CREATE INDEX map_tags_object ON map_tags(fid);
                CREATE INDEX map_tags_sample ON map_tags(key_id, ((fid * 2654435761) & 2147483647), value_id) WHERE key_id >= 0;
                CREATE UNIQUE INDEX map_osm_id ON map_features(kind, osm_id);
                CREATE TABLE tag_values (
                    region TEXT, key TEXT, value TEXT,
                    nodes INTEGER, ways INTEGER, relations INTEGER,
                    node_id INTEGER, way_id INTEGER, relation_id INTEGER,
                    PRIMARY KEY(region, key, value)
                ) WITHOUT ROWID;
                INSERT INTO tag_values
                    SELECT region, key, value,
                           SUM(kind='node'), SUM(kind='way'), SUM(kind='relation'),
                           MIN(CASE WHEN kind='node' THEN object_id END),
                           MIN(CASE WHEN kind='way' THEN object_id END),
                           MIN(CASE WHEN kind='relation' THEN object_id END)
                    FROM tag_records GROUP BY region, key, value;
                DROP TABLE tag_records;
                CREATE TABLE tag_keys (
                    region TEXT, key TEXT,
                    nodes INTEGER, ways INTEGER, relations INTEGER, values_all INTEGER,
                    values_node INTEGER, values_way INTEGER, values_relation INTEGER,
                    PRIMARY KEY(region, key)
                ) WITHOUT ROWID;
                INSERT INTO tag_keys
                    SELECT region, key, SUM(nodes), SUM(ways), SUM(relations), COUNT(*),
                           SUM(nodes>0), SUM(ways>0), SUM(relations>0)
                    FROM tag_values GROUP BY region, key;
                CREATE TABLE metadata (summary TEXT NOT NULL);
                CREATE TABLE map_context (document TEXT NOT NULL);
            """)
            areas = []
            for region in [{"id": "all", "name": country["name"], "shape": census.country}, *regions]:
                region_id, geometry = region["id"], region["shape"]
                drawing, label = outline(geometry, census.country.bounds) if region_id != "all" else (None, None)
                themes = {
                    theme: [[value, count, round(length, 5), round(area, 7)]
                            for value, (count, length, area) in sorted(values.items())]
                    for theme, values in census.overview[region_id].items()
                }
                keys, values = connection.execute(
                    "SELECT COUNT(*), COALESCE(SUM(values_all), 0) FROM tag_keys WHERE region=?",
                    (region_id,),
                ).fetchone()
                areas.append({
                    "id": region_id, "name": region["name"], "area": round(geometry.area / 1_000_000, 3),
                    "outline": drawing, "label": label, "themes": themes,
                    "bounds": census.unwrap(transform(unproject, geometry)).bounds,
                    "objects": dict(census.objects[region_id]), "keys": keys, "values": values,
                })
            summary = {
                "country": {"id": country["id"], "name": country["name"], "division": country["division"]},
                "schema": SCHEMA, "searchMinValues": SEARCH_MIN_VALUES,
                "snapshot": snapshot, "source": country["source"],
                "boundarySource": country["boundarySource"],
                "boundaryCredit": country["boundaryCredit"],
                "boundaryLicense": country["boundaryLicense"],
                "areas": areas, "skippedGeometry": dict(census.skipped),
                "themes": [{"id": key, "label": label, "tag": tag, "measure": measure, "note": note}
                           for key, (label, tag, measure, note) in THEMES.items()],
            }
            connection.execute("INSERT INTO metadata VALUES (?)", (json.dumps(summary, ensure_ascii=False),))
            connection.execute(
                "INSERT INTO map_context VALUES (?)",
                (json.dumps(census.map_context(), ensure_ascii=False, separators=(",", ":")),),
            )
            build_id_lists(connection)
            build_value_search(connection)
            connection.commit()
            connection.close()
            print("Precomputing Freshness for common tags", flush=True)
            build_rollups(temporary)
            connection = sqlite3.connect(temporary)
            connection.execute("VACUUM")
            connection.close()
            print("Building vector tiles", flush=True)
            tiles = temporary.with_suffix(".pmtiles")
            build_tiles(temporary, tiles)
        finally:
            connection.close()
        tiles.replace(output.with_suffix(".pmtiles"))
        temporary.replace(output)
    print(f"Prepared {output.name}: {areas[0]['keys']:,} keys, {areas[0]['values']:,} distinct key/value pairs", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--country", default="LU", help="Config ID in code/pipeline/countries, or a path to a config")
    parser.add_argument("--pbf", type=Path)
    parser.add_argument("--boundaries", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--workers", type=int, help="Geometry processes. Chosen from the file size by default.")
    args = parser.parse_args()
    # Stopping a build must also shut down its workers and remove temporary files.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    config = load_country(args.country)
    build(
        args.pbf or INPUT / config["pbf"],
        args.boundaries or INPUT / config["boundaries"],
        args.output or ROOT / "output/analytics" / f"{config['id']}.sqlite",
        config,
        args.workers,
    )

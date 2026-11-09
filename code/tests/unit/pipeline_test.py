"""Unit tests for the pure logic in the analytics pipeline."""
import importlib.util
import json
import math
import pathlib
import sqlite3
import tempfile
import unittest

import shapely
from shapely.geometry import LineString, Point, Polygon, box

ROOT = pathlib.Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("pipeline", ROOT / "code/pipeline/prepare-analytics.py")
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)

fixture_spec = importlib.util.spec_from_file_location("fixture", ROOT / "code/tests/fixtures/build_fixture.py")
fixture = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixture)

SQUARE = LineString([(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)])


def census(regions=2):
    shapes = [box(index * 10, 0, (index + 1) * 10, 10) for index in range(regions)]
    connection = sqlite3.connect(":memory:")
    return pipeline.Census(
        [{"id": f"R{index}", "name": f"Region {index}", "shape": shape} for index, shape in enumerate(shapes)],
        connection,
        {"n": set(), "w": set()},
        lambda x, y, z=None: (x, y),
        lambda x, y, z=None: (x, y),
    )


class WayShape(unittest.TestCase):
    def test_closed_building_becomes_polygon(self):
        self.assertIsInstance(pipeline.way_shape(SQUARE, {"building": "yes"}), Polygon)

    def test_closed_highway_stays_a_line(self):
        self.assertIsInstance(pipeline.way_shape(SQUARE, {"highway": "residential"}), LineString)

    def test_area_yes_overrides_highway(self):
        self.assertIsInstance(pipeline.way_shape(SQUARE, {"highway": "pedestrian", "area": "yes"}), Polygon)

    def test_area_no_overrides_building(self):
        self.assertIsInstance(pipeline.way_shape(SQUARE, {"building": "yes", "area": "no"}), LineString)

    def test_linear_natural_features_stay_lines(self):
        for natural in ("coastline", "cliff", "tree_row"):
            self.assertIsInstance(pipeline.way_shape(SQUARE, {"natural": natural}), LineString, natural)

    def test_open_way_never_becomes_polygon(self):
        line = LineString([(0, 0), (1, 1)])
        self.assertIs(pipeline.way_shape(line, {"building": "yes"}), line)


class ThemeMatches(unittest.TestCase):
    def themes(self, kind, tags):
        return sorted(pipeline.theme_matches(kind, tags))

    def test_road_and_path_classes(self):
        self.assertEqual(self.themes("way", {"highway": "primary"}), [("roads", "primary")])
        self.assertEqual(self.themes("way", {"highway": "footway"}), [("paths", "footway")])

    def test_area_highway_is_not_a_road(self):
        self.assertEqual(self.themes("way", {"highway": "primary", "area": "yes"}), [])

    def test_traffic_controls_are_nodes_only(self):
        self.assertEqual(self.themes("node", {"highway": "stop"}), [("controls", "stop")])
        self.assertEqual(self.themes("way", {"highway": "stop"}), [])

    def test_excluded_waterways_and_values(self):
        self.assertEqual(self.themes("way", {"waterway": "riverbank"}), [])
        self.assertEqual(self.themes("node", {"amenity": "no"}), [])

    def test_areas_only_count_buildings_and_landuse(self):
        self.assertEqual(self.themes("area", {"building": "yes", "amenity": "school"}), [("buildings", "yes")])


class Scopes(unittest.TestCase):
    def test_point_on_a_shared_border_belongs_to_one_region(self):
        self.assertEqual(census().scopes(Point(10, 5), 0), [("all", 0), ("R0", 0)])

    def test_point_outside_every_region_is_dropped(self):
        self.assertEqual(census().scopes(Point(50, 50), 0), [])

    def test_crossing_line_is_clipped_per_region_and_counted_once_nationally(self):
        scopes = dict(census().scopes(LineString([(5, 5), (15, 5)]), 1))
        self.assertEqual(scopes, {"all": 10, "R0": 5, "R1": 5})

    def test_line_touching_only_a_border_has_no_length_in_the_neighbour(self):
        scopes = dict(census().scopes(LineString([(5, 5), (10, 5)]), 1))
        self.assertEqual(scopes, {"all": 5, "R0": 5})


class Relations(unittest.TestCase):
    def test_membership_spreads_through_nested_relations_and_cycles(self):
        instance = census()
        instance.connection.executescript("""
            CREATE TABLE tag_records(region, kind, object_id, key, value);
            CREATE TABLE map_features(fid, kind, osm_id, label, geometry);
            CREATE TABLE feature_regions(fid, region);
            CREATE TABLE feature_freshness(fid, version, edited, lon, lat);
            CREATE TABLE map_bounds(fid, west, east, south, north);
            CREATE TABLE map_tags(key, fid, value);
        """)
        line = LineString([(1, 1), (2, 2)])
        instance.membership[("w", 1)] = {"all", "R1"}
        instance.member_geometry[("w", 1)] = line
        relations = {
            10: ({"type": "route"}, [("w", 1)]),
            11: ({"type": "master"}, [("r", 10), ("r", 12)]),
            12: ({"type": "cycle"}, [("r", 11)]),
        }
        instance.add_relations(relations)
        rows = instance.connection.execute(
            "SELECT DISTINCT object_id, region FROM tag_records ORDER BY object_id, region"
        ).fetchall()
        self.assertEqual(rows, [(object_id, region) for object_id in (10, 11, 12) for region in ("R1", "all")])

    def test_single_member_relation_keeps_its_own_geometry(self):
        instance = census()
        line = LineString([(1, 1), (2, 2)])
        instance.member_geometry[("w", 1)] = line
        self.assertIs(instance.relation_shape(10, {10: ({}, [("w", 1)])}), line)


class Outline(unittest.TestCase):
    def test_outline_is_scaled_into_the_svg_box(self):
        path, label = pipeline.outline(box(0, 0, 100, 100), (0, 0, 100, 100))
        self.assertTrue(path.startswith("M") and path.endswith("Z"))
        self.assertEqual(label, (200.0, 235.0))


class Projections(unittest.TestCase):
    def forward(self, country, features):
        return pipeline.projections(country, features)[0]

    def test_named_crs_is_used(self):
        project = self.forward({"crs": 2169}, [])
        x, y = project(6.13, 49.61)
        self.assertAlmostEqual(x, 77000, delta=2000)
        self.assertAlmostEqual(y, 75000, delta=2000)

    def test_default_projection_is_centred_on_the_regions(self):
        features = [{"geometry": box(10, 50, 12, 52).__geo_interface__}]
        x, y = self.forward({}, features)(11, 51)
        self.assertAlmostEqual(x, 0, delta=50)
        self.assertAlmostEqual(y, 0, delta=50)

    def test_regions_on_both_sides_of_180_centre_near_180(self):
        features = [
            {"geometry": box(179, -18, 179.8, -17).__geo_interface__},
            {"geometry": box(-179.8, -18, -179, -17).__geo_interface__},
        ]
        project = self.forward({}, features)
        west, _ = project(179.5, -17.5)
        east, _ = project(-179.5, -17.5)
        self.assertAlmostEqual(east - west, 106000, delta=1500)

    def test_default_projection_measures_real_distances(self):
        features = fixture.dateline_cells()["features"]
        project = self.forward({}, features)
        a, b = project(-179.95, -16.96), project(-179.85, -16.96)
        self.assertAlmostEqual(math.dist(a, b), 10640, delta=30)


class LongitudeUnwrapper(unittest.TestCase):
    def test_country_across_180_becomes_continuous(self):
        country = shapely.union_all([box(179, 0, 180, 1), box(-180, 0, -179, 1)])
        unwrap = pipeline.longitude_unwrapper(country)
        self.assertEqual(unwrap(Point(-179.5, 0.5)).x, 180.5)
        self.assertEqual(unwrap(Point(179.5, 0.5)).x, 179.5)

    def test_country_across_the_prime_meridian_is_untouched(self):
        point = Point(-3, 52)
        self.assertIs(pipeline.longitude_unwrapper(box(-8, 50, 2, 60))(point), point)

    def test_western_hemisphere_country_is_untouched(self):
        point = Point(-100, 40)
        self.assertIs(pipeline.longitude_unwrapper(box(-125, 25, -67, 49))(point), point)


class LoadCountry(unittest.TestCase):
    def test_loads_by_id(self):
        country = pipeline.load_country("LU")
        self.assertEqual((country["name"], country["expectedRegions"], country["crs"]), ("Luxembourg", 12, 2169))

    def test_rejects_ids_the_server_could_not_route(self):
        with tempfile.TemporaryDirectory() as working:
            path = pathlib.Path(working) / "bad.json"
            path.write_text(json.dumps({"id": "lux"}))
            with self.assertRaisesRegex(ValueError, "two capital"):
                pipeline.load_country(path)


class Build(unittest.TestCase):
    def build(self, cantons, country=None):
        with tempfile.TemporaryDirectory() as working:
            working = pathlib.Path(working)
            pbf, boundaries = working / "x.osm.pbf", working / "b.geojson"
            fixture.write_extract(pbf)
            boundaries.write_text(json.dumps({"type": "FeatureCollection", "features": cantons}))
            output = working / "out" / "LU.sqlite"
            pipeline.build(pbf, boundaries, output, country or pipeline.load_country("LU"))
            connection = sqlite3.connect(output)
            regions = connection.execute("SELECT COUNT(DISTINCT region) FROM feature_regions").fetchone()[0]
            connection.close()
            return sorted(path.name for path in (working / "out").iterdir()), regions

    def test_build_leaves_only_the_finished_database(self):
        self.assertEqual(self.build(fixture.cantons()["features"])[0], ["LU.pmtiles", "LU.sqlite"])

    def test_luxembourg_still_requires_its_twelve_cantons(self):
        with self.assertRaisesRegex(ValueError, "12 unique"):
            self.build(fixture.cantons()["features"][:11])

    def test_duplicate_canton_codes_are_rejected(self):
        cantons = fixture.cantons()["features"]
        cantons[1]["properties"]["code"] = cantons[0]["properties"]["code"]
        with self.assertRaisesRegex(ValueError, "12 unique"):
            self.build(cantons)

    def test_any_region_count_builds_without_a_national_limit(self):
        cantons = fixture.cantons()["features"]
        for index in range(13, 41):
            extra = json.loads(json.dumps(cantons[0]))
            extra["properties"]["code"] = f"C{index}"
            cantons.append(extra)
        files, regions = self.build(cantons, fixture.DATELINE_COUNTRY)
        self.assertEqual(files, ["LU.pmtiles", "LU.sqlite"])
        self.assertGreater(regions, 12)

    def test_a_region_cannot_reuse_the_national_id(self):
        cantons = fixture.cantons()["features"]
        cantons[0]["properties"]["code"] = "all"
        with self.assertRaisesRegex(ValueError, "unique regions"):
            self.build(cantons, fixture.DATELINE_COUNTRY)

    def test_empty_boundaries_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "unique regions"):
            self.build([], {**fixture.DATELINE_COUNTRY, "crs": 4326})


class ParallelBuild(unittest.TestCase):
    def contents(self, path):
        connection = sqlite3.connect(path)
        tables = [row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'map_bounds_%' AND name != 'value_search'"
        )]
        rows = {table: connection.execute(f'SELECT * FROM "{table}" ORDER BY 1, 2').fetchall()
                if len(connection.execute(f'SELECT * FROM "{table}" LIMIT 1').description) > 1
                else connection.execute(f'SELECT * FROM "{table}"').fetchall()
                for table in tables}
        connection.close()
        return rows

    def test_parallel_output_is_identical_to_a_single_process(self):
        with tempfile.TemporaryDirectory() as working:
            working = pathlib.Path(working)
            pbf, boundaries = working / "x.osm.pbf", working / "b.geojson"
            fixture.write_extract(pbf)
            boundaries.write_text(json.dumps({"type": "FeatureCollection", "features": fixture.cantons()["features"]}))
            country = pipeline.load_country("LU")
            serial, parallel = working / "serial" / "LU.sqlite", working / "parallel" / "LU.sqlite"
            pipeline.build(pbf, boundaries, serial, country, workers=1)
            pipeline.build(pbf, boundaries, parallel, country, workers=2)
            self.assertEqual(self.contents(serial), self.contents(parallel))


if __name__ == "__main__":
    unittest.main()

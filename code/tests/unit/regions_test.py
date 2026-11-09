import importlib.util
import unittest
from pathlib import Path

from shapely.geometry import box

ROOT = Path(__file__).resolve().parents[3]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / "code/pipeline" / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


regions = load("extract_regions", "extract-regions.py")


def boundary(identifier, level, shape, **tags):
    return {"id": identifier, "level": level, "shape": shape, "tags": {"name": identifier, **tags}}


COUNTRY = boundary("r1", 2, box(0, 0, 4, 2), **{"ISO3166-1": "JO"})
WEST = boundary("r2", 4, box(0, 0, 2, 2), **{"ISO3166-2": "JO-W"})
EAST = boundary("r3", 4, box(2, 0, 4, 2), **{"ISO3166-2": "JO-E"})
NEIGHBOUR = boundary("r4", 4, box(4, 0, 6, 2), **{"ISO3166-2": "SY-N"})
NEIGHBOUR_COUNTRY = boundary("r5", 2, box(4, 0, 6, 2), **{"ISO3166-1": "SY"})


class FindCountry(unittest.TestCase):
    def test_finds_by_iso_code(self):
        self.assertEqual(regions.find_country([NEIGHBOUR_COUNTRY, COUNTRY], "JO")["id"], "r1")

    def test_reports_a_missing_country(self):
        self.assertIsNone(regions.find_country([NEIGHBOUR_COUNTRY], "JO"))


class ChooseRegions(unittest.TestCase):
    def ids(self, boundaries):
        chosen = regions.choose_regions(boundaries, COUNTRY, "JO")
        return chosen and [item["id"] for item in chosen]

    def test_keeps_only_this_countrys_regions(self):
        self.assertEqual(self.ids([COUNTRY, WEST, EAST, NEIGHBOUR]), ["r2", "r3"])

    def test_rejects_a_foreign_iso_code_even_if_it_overlaps(self):
        inside_but_foreign = boundary("r6", 4, box(1, 0, 3, 2), **{"ISO3166-2": "SY-X"})
        self.assertEqual(self.ids([COUNTRY, WEST, EAST, inside_but_foreign]), ["r2", "r3"])

    def test_gaps_in_coverage_move_to_the_next_level(self):
        finer = [boundary(f"d{i}", 6, box(i, 0, i + 1, 2)) for i in range(4)]
        self.assertEqual(self.ids([COUNTRY, WEST, *finer]), ["d0", "d1", "d2", "d3"])

    def test_no_complete_level_means_no_regions(self):
        self.assertIsNone(self.ids([COUNTRY, WEST]))

    def test_a_single_region_is_not_a_division(self):
        self.assertIsNone(self.ids([COUNTRY, boundary("r7", 4, box(0, 0, 4, 2))]))

    def test_too_many_regions_are_skipped(self):
        width = 4 / 200
        many = [boundary(f"m{i}", 8, box(i * width, 0, (i + 1) * width, 2)) for i in range(200)]
        self.assertIsNone(self.ids([COUNTRY, *many]))


class RegionFeatures(unittest.TestCase):
    def test_codes_are_unique_and_shapes_are_clipped(self):
        overflowing = boundary("r8", 4, box(3, 0, 4.5, 2), **{"ISO3166-2": "JO-W"})
        features = regions.region_features([WEST, overflowing], COUNTRY["shape"])
        codes = [feature["properties"]["code"] for feature in features]
        self.assertEqual(codes, ["JO-W", "R8"])
        east_edge = max(point[0] for point in features[1]["geometry"]["coordinates"][0])
        self.assertEqual(east_edge, 4)

    def test_prefers_english_names(self):
        named = boundary("r9", 4, box(0, 0, 1, 1), **{"name": "عمان", "name:en": "Amman"})
        self.assertEqual(regions.label(named["tags"]), "Amman")


if __name__ == "__main__":
    unittest.main()

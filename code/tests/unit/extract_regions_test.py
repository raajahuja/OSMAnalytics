import importlib.util
from pathlib import Path
import unittest

from shapely.geometry import box

spec = importlib.util.spec_from_file_location(
    "extract_regions", Path(__file__).resolve().parents[2] / "pipeline/extract-regions.py"
)
regions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(regions)


def boundary(identifier, level, shape, **tags):
    return {"id": identifier, "level": level, "tags": tags, "shape": shape}


STATES = [
    boundary("r1", 4, box(0, 0, 2, 2), **{"name": "North", "ISO3166-2": "ZZ-N"}),
    boundary("r2", 4, box(2, 0, 4, 2), **{"name": "South", "ISO3166-2": "ZZ-S"}),
]


class AssembleCountry(unittest.TestCase):
    def test_a_complete_country_boundary_is_preferred(self):
        whole = boundary("r9", 2, box(0, 0, 4, 2), **{"ISO3166-1": "ZZ"})
        country, pieced = regions.assemble_country([whole, *STATES], "ZZ", "Zedland")
        self.assertEqual((country["id"], pieced), ("r9", False))

    def test_states_stand_in_for_a_broken_country_boundary(self):
        country, pieced = regions.assemble_country(STATES, "ZZ", "Zedland")
        self.assertTrue(pieced)
        self.assertEqual(country["level"], 3)
        self.assertAlmostEqual(country["shape"].area, 8)
        self.assertEqual(len(regions.choose_regions(STATES, country, "ZZ")), 2)

    def test_a_boundary_with_the_country_name_is_used_next(self):
        named = boundary("r5", 4, box(0, 0, 1, 1), name="Zedland")
        country, pieced = regions.assemble_country([named], "ZZ", "Zedland")
        self.assertEqual((country["id"], pieced), ("r5", False))

    def test_nothing_usable_is_reported_rather_than_guessed(self):
        other = boundary("r6", 4, box(0, 0, 1, 1), name="Elsewhere")
        self.assertEqual(regions.assemble_country([other], "ZZ", "Zedland"), (None, False))


class OtherAreas(unittest.TestCase):
    def test_a_gap_in_the_outline_keeps_its_data(self):
        l_shape = box(0, 0, 4, 2).union(box(0, 2, 2, 4))
        [feature] = regions.other_areas(l_shape, "ZZ")
        self.assertEqual(feature["properties"], {"code": "ZZ-OTHER", "name": "Other areas"})

    def test_a_convex_outline_needs_no_extra_region(self):
        self.assertEqual(regions.other_areas(box(0, 0, 4, 2), "ZZ"), [])


if __name__ == "__main__":
    unittest.main()

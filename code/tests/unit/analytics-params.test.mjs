import test from "node:test";
import assert from "node:assert/strict";
import {
  csvCell,
  readRules,
  tagConditions,
  viewport,
} from "../../server/analytics.mjs";

const query = (values) => new URLSearchParams(values);
const filters = (rules) => query({ filters: JSON.stringify(rules) });

test("csvCell quotes text, keeps numbers bare and blanks missing values", () => {
  assert.equal(csvCell(12), "12");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell("plain"), '"plain"');
  assert.equal(csvCell('a"b'), '"a""b"');
});

test("csvCell neutralises spreadsheet formulas", () => {
  for (const text of ["=1+1", "+1", "-1", "@x", "  =1", "\t=1"])
    assert.ok(csvCell(text).startsWith(`"'`), text);
});

test("viewport accepts valid bounds and rejects malformed ones", () => {
  assert.deepEqual(viewport(query({ bbox: "1,2,3,4" })), [1, 2, 3, 4]);
  for (const bbox of [
    "",
    "1,2,3",
    "1,2,3,4,5",
    "a,2,3,4",
    "1,,3,4",
    "3,2,1,4",
    "1,4,3,2",
    "1,2,1,4",
    "1,-91,3,4",
    "1,2,3,91",
    "1,2,Infinity,4",
  ])
    assert.equal(viewport(query({ bbox })), null, bbox);
  assert.equal(viewport(query({})), null);
});

test("viewport keeps longitudes past 180 for the map to unwrap", () => {
  assert.deepEqual(viewport(query({ bbox: "179,2,181,4" })), [179, 2, 181, 4]);
  assert.deepEqual(viewport(query({ bbox: "-181,2,3,4" })), [-181, 2, 3, 4]);
});

test("readRules supports the single key form", () => {
  assert.equal(readRules(query({})), null);
  assert.deepEqual(readRules(query({ key: "highway" })), [
    { key: "highway", values: [] },
  ]);
  assert.deepEqual(readRules(query({ key: "highway", value: "bus_stop" })), [
    { key: "highway", values: ["bus_stop"] },
  ]);
});

test("readRules removes duplicate values and enforces its limits", () => {
  assert.deepEqual(readRules(filters([{ key: "a", values: ["x", "x", "y"] }])), [
    { key: "a", values: ["x", "y"] },
  ]);
  const rules = (count) =>
    Array.from({ length: count }, (_, i) => ({ key: "k" + i, values: [] }));
  assert.equal(readRules(filters(rules(12))).length, 12);
  assert.equal(readRules(filters(rules(13))), null);
  const values = (count) => Array.from({ length: count }, (_, i) => "v" + i);
  assert.ok(readRules(filters([{ key: "a", values: values(40) }])));
  assert.equal(readRules(filters([{ key: "a", values: values(41) }])), null);
});

test("readRules rejects malformed and hostile input", () => {
  for (const packed of [
    "{",
    "{}",
    "[null]",
    '[{"key":1,"values":[]}]',
    '[{"key":"a"}]',
    '[{"key":"a","values":[1]}]',
    '[{"key":"a","values":[]},{"key":"a","values":[]}]',
    JSON.stringify([{ key: "x".repeat(256), values: [] }]),
  ])
    assert.equal(readRules(query({ filters: packed })), null, packed);
});

test("tagConditions only places values in bound parameters", () => {
  const hostile = "x') OR 1=1 --";
  const { clause, parameters } = tagConditions([
    { key: hostile, values: [hostile, "b"], keyId: 4, valueIds: [7, 8] },
    { key: "c", values: [], keyId: 5, valueIds: [] },
  ]);
  assert.equal(clause, "((t.key_id=? AND t.value_id IN (?,?)) OR (t.key_id=?))");
  assert.deepEqual(parameters, [4, 7, 8, 5]);
});

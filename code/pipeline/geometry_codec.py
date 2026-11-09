"""Compact binary geometry: about a fifth of the size of GeoJSON text.

A value is one byte for the shapely type ID, then varints describing its parts,
then every coordinate as a zigzag varint delta at OSM's 1e-7 degree precision.
A GeometryCollection holds its members one after another, each self-contained.
code/server/geometry.mjs is the matching decoder.
"""
import numpy
import shapely

POINT, LINESTRING, LINEARRING, POLYGON, MULTIPOINT, MULTILINESTRING, MULTIPOLYGON, COLLECTION = range(8)
SCALE = 1e7
# 1e-7 degree steps across 720 degrees, zigzagged, fit in seven groups of seven bits.
GROUPS = 7


def varint(value):
    encoded = bytearray()
    while value >= 128:
        encoded.append((value & 127) | 128)
        value >>= 7
    encoded.append(value)
    return bytes(encoded)


def varints(values):
    lengths = numpy.ones(len(values), dtype=numpy.int64)
    for group in range(1, GROUPS):
        lengths += values >= (numpy.uint64(1) << numpy.uint64(7 * group))
    starts = numpy.cumsum(lengths) - lengths
    output = numpy.zeros(int(lengths.sum()), dtype=numpy.uint8)
    for group in range(GROUPS):
        inside = lengths > group
        more = (lengths[inside] > group + 1).astype(numpy.uint8) * 128
        shifted = values[inside] >> numpy.uint64(7 * group)
        output[starts[inside] + group] = (shifted & numpy.uint64(127)).astype(numpy.uint8) | more
    return output.tobytes()


def coordinates(geometry):
    scaled = numpy.rint(shapely.get_coordinates(geometry) * SCALE).astype(numpy.int64)
    deltas = numpy.column_stack((
        numpy.diff(scaled[:, 0], prepend=0),
        numpy.diff(scaled[:, 1], prepend=0),
    )).ravel()
    return varints(((deltas << 1) ^ (deltas >> 63)).astype(numpy.uint64))


def rings(polygon):
    return [polygon.exterior, *polygon.interiors]


def encode_geometry(geometry):
    kind = int(shapely.get_type_id(geometry))
    if kind == LINEARRING:
        kind = LINESTRING
    head = bytearray([kind])
    if kind == COLLECTION:
        members = [member for member in geometry.geoms if not member.is_empty]
        head += varint(len(members))
        return bytes(head) + b"".join(map(encode_geometry, members))
    if kind in (LINESTRING, MULTIPOINT):
        head += varint(int(shapely.get_num_coordinates(geometry)))
    elif kind == POLYGON:
        head += varint(len(rings(geometry)))
        for ring in rings(geometry):
            head += varint(len(ring.coords))
    elif kind == MULTILINESTRING:
        head += varint(len(geometry.geoms))
        for line in geometry.geoms:
            head += varint(len(line.coords))
    elif kind == MULTIPOLYGON:
        head += varint(len(geometry.geoms))
        for polygon in geometry.geoms:
            head += varint(len(rings(polygon)))
            for ring in rings(polygon):
                head += varint(len(ring.coords))
    return bytes(head) + coordinates(geometry)

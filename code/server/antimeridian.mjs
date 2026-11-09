// Helpers for maps and searches that cross 180 degrees longitude.

// Leaflet reports longitudes past 180 once a map pans across the antimeridian.
// Each box uses stored coordinates; `offset` moves results back to the map's.
export function viewportBoxes([west, south, east, north]) {
  if (east - west >= 360)
    return [{ west: -180, south, east: 180, north, offset: 0 }];
  const inRange = west >= -180 && west < 180;
  const left = inRange ? west : ((((west + 180) % 360) + 360) % 360) - 180;
  const offset = inRange ? 0 : Math.round((west - left) / 360) * 360;
  const right = east - offset;
  if (right <= 180) return [{ west: left, south, east: right, north, offset }];
  return [
    { west: left, south, east: 180, north, offset },
    { west: -180, south, east: right - 360, north, offset: offset + 360 },
  ];
}

// Splits a west-east search around a point near the antimeridian.
export function longitudeRanges(west, east) {
  if (east - west >= 360) return [[-180, 180]];
  if (east > 180)
    return [
      [west, 180],
      [-180, east - 360],
    ];
  if (west < -180)
    return [
      [west + 360, 180],
      [-180, east],
    ];
  return [[west, east]];
}

function shiftCoordinates(coordinates, offset) {
  return typeof coordinates[0] === "number"
    ? [coordinates[0] + offset, ...coordinates.slice(1)]
    : coordinates.map((item) => shiftCoordinates(item, offset));
}

export function shiftGeometry(geometry, offset) {
  if (!offset) return geometry;
  return geometry.type === "GeometryCollection"
    ? {
        ...geometry,
        geometries: geometry.geometries.map((item) =>
          shiftGeometry(item, offset),
        ),
      }
    : {
        ...geometry,
        coordinates: shiftCoordinates(geometry.coordinates, offset),
      };
}

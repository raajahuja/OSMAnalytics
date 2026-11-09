/// <reference types="vite/client" />
// The look of the maps: a pre-built base map from PMTiles plus the live overlays.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import * as maplibregl from "maplibre-gl";
import type {
  ExpressionSpecification,
  LayerSpecification,
  StyleSpecification,
} from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { Feature, Geometry, Position } from "geojson";

let registered = false;
function registerTiles() {
  if (registered) return;
  // The bundler can't see this file on its own, so it's named here.
  maplibregl.setWorkerUrl(workerUrl);
  maplibregl.addProtocol("pmtiles", new Protocol().tile);
  registered = true;
}

const tileSource = (country: string, version?: string) => {
  registerTiles();
  return {
    type: "vector" as const,
    url:
      "pmtiles://" +
      location.origin +
      "/tiles/" +
      country +
      ".pmtiles" +
      (version ? "?v=" + version : ""),
  };
};

const emptySource = {
  type: "geojson" as const,
  data: { type: "FeatureCollection" as const, features: [] },
};
const isPolygon: ExpressionSpecification = [
  "in",
  ["geometry-type"],
  ["literal", ["Polygon", "MultiPolygon"]],
];
const isPoint: ExpressionSpecification = [
  "in",
  ["geometry-type"],
  ["literal", ["Point", "MultiPoint"]],
];
const notPoint: ExpressionSpecification = ["!", isPoint];
const nothing: ExpressionSpecification = ["==", ["get", "osm"], ""];

export const BASE_LAYERS = [
  "regions-fill",
  "regions-line",
  "water-fill",
  "water-line",
  "buildings",
  "context-roads",
  "roads-minor",
  "roads-main",
];
export const MATCH_LAYERS = ["matches-fill", "matches-line", "matches-point"];
export const SELECTED_LAYERS = [
  "selected-fill",
  "selected-line",
  "selected-point",
];
export const QUERY_LAYERS = ["query-fill", "query-line", "query-point"];
export const BOUNDARY_LAYERS = ["boundary-fill", "boundary-line"];
export const CLICKABLE_LAYERS = [
  "matches-point",
  "matches-line",
  "matches-fill",
];

const baseLayers: LayerSpecification[] = [
  {
    id: "regions-fill",
    type: "fill",
    source: "base",
    "source-layer": "regions",
    paint: { "fill-color": "#f4f7f3", "fill-opacity": 0.94 },
  },
  {
    id: "regions-line",
    type: "line",
    source: "base",
    "source-layer": "regions",
    paint: { "line-color": "#a7bdb7", "line-width": 1 },
  },
  {
    id: "water-fill",
    type: "fill",
    source: "base",
    "source-layer": "water",
    filter: isPolygon,
    paint: { "fill-color": "#b9dce5", "fill-opacity": 0.9 },
  },
  {
    id: "water-line",
    type: "line",
    source: "base",
    "source-layer": "water",
    paint: { "line-color": "#8bbdcf", "line-width": 1.5 },
  },
  {
    id: "buildings",
    type: "fill",
    source: "base",
    "source-layer": "buildings",
    paint: {
      "fill-color": "#e1d9ce",
      "fill-outline-color": "#d3cbc0",
      "fill-opacity": 0.85,
    },
  },
  {
    id: "context-roads",
    type: "line",
    source: "base",
    "source-layer": "context_roads",
    maxzoom: 11,
    paint: {
      "line-color": "#b4bcb9",
      "line-width": 1.1,
      "line-opacity": 0.85,
    },
  },
  {
    id: "roads-minor",
    type: "line",
    source: "base",
    "source-layer": "roads",
    minzoom: 11,
    filter: ["==", ["get", "main"], 0],
    paint: {
      "line-color": "#b8c0b9",
      "line-width": 1.3,
      "line-opacity": 0.82,
    },
  },
  {
    id: "roads-main",
    type: "line",
    source: "base",
    "source-layer": "roads",
    minzoom: 11,
    filter: ["==", ["get", "main"], 1],
    paint: {
      "line-color": "#c9ae83",
      "line-width": 2.4,
      "line-opacity": 0.82,
    },
  },
];

const overlayLayers: LayerSpecification[] = [
  {
    id: "matches-fill",
    type: "fill",
    source: "matches",
    filter: isPolygon,
    paint: { "fill-color": ["get", "street"], "fill-opacity": 0.34 },
  },
  {
    id: "matches-line",
    type: "line",
    source: "matches",
    filter: notPoint,
    paint: { "line-color": ["get", "street"], "line-width": ["get", "width"] },
  },
  {
    id: "matches-point",
    type: "circle",
    source: "matches",
    filter: isPoint,
    paint: {
      "circle-color": ["get", "street"],
      "circle-radius": ["get", "radius"],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
    },
  },
  {
    id: "selected-fill",
    type: "fill",
    source: "matches",
    filter: nothing,
    paint: { "fill-color": "#ff6200", "fill-opacity": 0.5 },
  },
  {
    id: "selected-line",
    type: "line",
    source: "matches",
    filter: nothing,
    paint: { "line-color": "#ff6200", "line-width": 4 },
  },
  {
    id: "selected-point",
    type: "circle",
    source: "matches",
    filter: nothing,
    paint: {
      "circle-color": "#ff6200",
      "circle-radius": 6,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 3,
    },
  },
  {
    id: "boundary-fill",
    type: "fill",
    source: "base",
    "source-layer": "regions",
    filter: ["==", ["get", "name"], ""],
    paint: { "fill-color": "#67bbaa", "fill-opacity": 0.12 },
  },
  {
    id: "boundary-line",
    type: "line",
    source: "base",
    "source-layer": "regions",
    filter: ["==", ["get", "name"], ""],
    paint: { "line-color": "#116959", "line-width": 3 },
  },
  {
    id: "query-fill",
    type: "fill",
    source: "query",
    filter: isPolygon,
    paint: {
      "fill-color": "#ff6200",
      "fill-opacity": ["get", "fillOpacity"],
    },
  },
  {
    id: "query-line",
    type: "line",
    source: "query",
    filter: notPoint,
    paint: {
      "line-color": "#ff6200",
      "line-width": ["get", "weight"],
      "line-opacity": ["get", "opacity"],
    },
  },
  {
    id: "query-point",
    type: "circle",
    source: "query",
    filter: isPoint,
    paint: {
      "circle-color": ["get", "fill"],
      "circle-opacity": ["get", "fillOpacity"],
      "circle-radius": ["get", "radius"],
      "circle-stroke-color": ["get", "stroke"],
      "circle-stroke-width": ["get", "strokeWidth"],
    },
  },
];

const IMAGERY_BOUNDS: [number, number, number, number] = [
  5.72009158, 49.4379598, 6.54617072, 50.18501989,
];

export function featureMapStyle(
  country: string,
  version?: string,
): StyleSpecification {
  const imagery = country === "LU";
  return {
    version: 8,
    sources: {
      base: tileSource(country, version),
      matches: emptySource,
      query: emptySource,
      ...(imagery && {
        imagery: {
          type: "raster" as const,
          tiles: ["/api/analytics/LU/imagery/{z}/{x}/{y}.jpeg"],
          tileSize: 256,
          bounds: IMAGERY_BOUNDS,
          minzoom: 7,
          maxzoom: 19,
        },
      }),
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#e9eeec" },
      },
      ...baseLayers,
      ...(imagery
        ? [
            {
              id: "imagery",
              type: "raster" as const,
              source: "imagery",
              layout: { visibility: "none" as const },
            },
          ]
        : []),
      ...overlayLayers,
    ],
  };
}

export function freshnessMapStyle(
  country: string,
  version?: string,
): StyleSpecification {
  return {
    version: 8,
    sources: { base: tileSource(country, version), cells: emptySource },
    layers: [
      {
        id: "cells",
        type: "fill",
        source: "cells",
        paint: { "fill-color": ["get", "color"], "fill-opacity": 0.92 },
      },
      {
        id: "outlines",
        type: "line",
        source: "base",
        "source-layer": "regions",
        paint: { "line-color": "#7d8187", "line-width": 1 },
      },
    ],
  };
}

export type Box = [west: number, south: number, east: number, north: number];

export function emptyBox(): Box {
  return [Infinity, Infinity, -Infinity, -Infinity];
}

export function extendBox(box: Box, geometry: Geometry) {
  const visit = (value: Position | Position[] | Position[][] | Position[][][]) => {
    if (typeof value[0] === "number") {
      const [x, y] = value as Position;
      box[0] = Math.min(box[0], x);
      box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x);
      box[3] = Math.max(box[3], y);
    } else (value as Position[]).forEach(visit as (item: Position) => void);
  };
  if (geometry.type === "GeometryCollection")
    geometry.geometries.forEach((member) => extendBox(box, member));
  else visit(geometry.coordinates);
  return box;
}

export const validBox = (box: Box) => box[0] <= box[2] && box[1] <= box[3];

const EARTH_METRES = 6_371_008.8;

export function circleRing(
  center: { lng: number; lat: number },
  radius: number,
): Position[] {
  const ring: Position[] = [];
  const latitude = (center.lat * Math.PI) / 180;
  const arc = radius / EARTH_METRES;
  for (let step = 0; step <= 96; step++) {
    const bearing = (step / 96) * 2 * Math.PI;
    const lat = Math.asin(
      Math.sin(latitude) * Math.cos(arc) +
        Math.cos(latitude) * Math.sin(arc) * Math.cos(bearing),
    );
    const lng =
      (center.lng * Math.PI) / 180 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(arc) * Math.cos(latitude),
        Math.cos(arc) - Math.sin(latitude) * Math.sin(lat),
      );
    ring.push([(lng * 180) / Math.PI, (lat * 180) / Math.PI]);
  }
  return ring;
}

export function circleBox(
  center: { lng: number; lat: number },
  radius: number,
): Box {
  return extendBox(emptyBox(), {
    type: "LineString",
    coordinates: circleRing(center, radius),
  });
}

export const featureOf = (
  geometry: Geometry,
  properties: Record<string, unknown>,
): Feature => ({ type: "Feature", geometry, properties });

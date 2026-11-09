import { apiFetch, datasetVersion, snapBounds } from "./api";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import * as maplibregl from "maplibre-gl";
import type {
  ExpressionSpecification,
  GeoJSONSource,
  LngLat,
  Map as MapLibreMap,
  Marker,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { labelWidth, rankPriority, visibleLabels } from "./placeLabels";
import { Crosshair, Eye, EyeOff, LocateFixed } from "lucide-react";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import AnalyticsObjectInspector, {
  type MappedObject,
  type ObjectDetails,
} from "./AnalyticsObjectInspector";
import {
  LocationSearch,
  NearbyPanel,
  type Coordinates,
  type NearbyResults,
} from "./AnalyticsNearby";
import {
  BASE_LAYERS,
  BOUNDARY_LAYERS,
  CLICKABLE_LAYERS,
  MATCH_LAYERS,
  QUERY_LAYERS,
  SELECTED_LAYERS,
  circleBox,
  circleRing,
  emptyBox,
  extendBox,
  featureMapStyle,
  featureOf,
  validBox,
  type Box,
} from "./mapStyle";

export type FeatureBounds = [
  west: number,
  south: number,
  east: number,
  north: number,
];
export type TagFilter = { key: string; values: string[] };
type MapContext = FeatureCollection<
  Geometry,
  { layer: string; name?: string; rank?: string }
>;
type MatchingFeatures = FeatureCollection<Geometry, MappedObject> & {
  limited: boolean;
};
// street draws on the light map, label on dark UI. aerial avoids terrain colours
// such as sand, soil, grass and water, and is outlined in dark for contrast.
type Tone = { street: string; label: string; aerial: string };
const palette: Tone[] = [
  { street: "#b83f15", label: "#ffab68", aerial: "#19e3ff" },
  { street: "#125fa6", label: "#8fd2ff", aerial: "#ff4fd8" },
  { street: "#80339d", label: "#e6aaff", aerial: "#b6ff2e" },
  { street: "#a91b56", label: "#ffa3c9", aerial: "#a48bff" },
  { street: "#3c700d", label: "#c5ed77", aerial: "#ffe600" },
  { street: "#663d15", label: "#ffda88", aerial: "#ff6a55" },
  { street: "#2b3d9a", label: "#b2b9ff", aerial: "#2effb0" },
  { street: "#973000", label: "#ff9682", aerial: "#7fd1ff" },
];
export const overlapTone: Tone = {
  street: "#253348",
  label: "#baf3ed",
  aerial: "#ffffff",
};

export function mapLegend(filters: TagFilter[]) {
  return filters
    .flatMap<{ key: string; value?: string }>(({ key, values }) =>
      values.length
        ? values.map((value) => ({ key, value }))
        : [{ key, value: undefined }],
    )
    .map((rule, index) => ({ ...rule, tone: palette[index % palette.length] }));
}

const queryOrange = "#ff6200";
const VILLAGE_ZOOM = 10.5;
const STREET_NAME_ZOOM = 14;
const LONG_PRESS_MS = 500;
const CLICK_MARGIN = 5;
const padded = (x: number, y: number) => ({
  left: x,
  right: x,
  top: y,
  bottom: y,
});

async function read<T>(
  url: string,
  signal: AbortSignal,
  form?: URLSearchParams,
): Promise<T> {
  const response = await apiFetch(url, signal, form);
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw Error(data?.error || "Could not load the local map.");
  }
  return response.json();
}

function setFeatures(m: MapLibreMap, source: string, features: Feature[]) {
  (m.getSource(source) as GeoJSONSource | undefined)?.setData({
    type: "FeatureCollection",
    features,
  });
}

function setVisible(m: MapLibreMap, layers: string[], visible: boolean) {
  for (const layer of layers)
    m.setLayoutProperty(layer, "visibility", visible ? "visible" : "none");
}

function fitBox(
  m: MapLibreMap | null,
  [west, south, east, north]: Box,
  options: { padding: number | ReturnType<typeof padded>; maxZoom: number },
  animate = false,
) {
  m?.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    { ...options, animate },
  );
}

// The pre-built tiles stop at zoom 4, and the map is blank below that.
const lowestZoom = 4;
// Luxembourg's aerial imagery starts at a closer zoom than the base map.
const lowestAerialZoom = 6;

const fitArea = (m: MapLibreMap | null, bounds: FeatureBounds, maxZoom = 13) =>
  fitBox(m, bounds, { padding: 16, maxZoom });

function placeLabel(text: string, className = "ax-map-place") {
  const element = document.createElement("div");
  element.className = className;
  element.style.pointerEvents = "none";
  const label = document.createElement("span");
  label.textContent = text;
  element.append(label);
  return element;
}

export default function AnalyticsFeatureMap({
  country,
  bounds,
  selectedArea,
  filterParams,
  filters,
  visible,
}: {
  country: string;
  bounds: FeatureBounds;
  selectedArea?: string;
  filterParams: string;
  filters: TagFilter[];
  visible: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const fittedBounds = useRef<FeatureBounds>(undefined);
  const drawnBounds = useRef<Box>(undefined);
  const drawn = useRef(new Map<string, MappedObject>());
  const scope = useRef(filterParams);
  const [contextPoint, setContextPoint] = useState<{
    location: LngLat;
    left: number;
    top: number;
  }>();
  const [nearby, setNearby] = useState<{
    center: LngLat;
    radius: number;
    page: number;
  }>();
  const [hoveredResult, setHoveredResult] = useState<string>();
  const [nearbyResponse, setNearbyResponse] = useState<{
    query: string;
    results?: NearbyResults;
    error?: string;
  }>();
  const [selection, setSelection] = useState<{
    id: string;
    scope: string;
    object: MappedObject;
    location?: LngLat;
  }>();
  const selected = selection?.scope === filterParams ? selection : undefined;
  const objectUrl = selected
    ? "/api/analytics/" + country + "/object/" + selected.id
    : "";
  const [objectResponse, setObjectResponse] = useState<{
    url: string;
    data?: ObjectDetails;
    error?: string;
  }>();
  const objectDetails =
    objectResponse?.url === objectUrl ? objectResponse : undefined;
  const [context, setContext] = useState<MapContext>();
  const [{ bbox, zoom }, setViewport] = useState({ bbox: "", zoom: 0 });
  const [contextError, setContextError] = useState("");
  const [basemap, setBasemap] = useState<"street" | "satellite">("street");
  const aerial = basemap !== "street";
  useEffect(() => {
    map.current?.setMinZoom(aerial ? lowestAerialZoom : lowestZoom);
  }, [aerial]);
  const aerialRef = useRef(aerial);
  const [imageryError, setImageryError] = useState(false);
  const [objectsHidden, setObjectsHidden] = useState(false);
  const [response, setResponse] = useState<{
    query: string;
    count: number;
    limited: boolean;
    error?: string;
  }>();
  useEffect(() => {
    scope.current = filterParams;
    aerialRef.current = aerial;
  }, [filterParams, aerial]);
  const clearSelection = useCallback(() => setSelection(undefined), []);
  const beginNearby = useCallback(
    (center: LngLat) => {
      clearSelection();
      setContextPoint(undefined);
      setNearby({ center: center.wrap(), radius: 250, page: 1 });
    },
    [clearSelection],
  );
  const openObject = useCallback(
    (object: MappedObject, objectScope: string, location?: LngLat) => {
      setSelection({
        id: object.kind + "/" + object.id,
        scope: objectScope,
        object,
        location,
      });
    },
    [],
  );

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const m = new maplibregl.Map({
      container,
      style: featureMapStyle(country, datasetVersion(country)),
      attributionControl: false,
      minZoom: lowestZoom,
      maxZoom: 18,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      fadeDuration: 0,
    });
    map.current = m;
    m.touchZoomRotate.disableRotation();
    m.keyboard.disableRotation();
    // Lets browser tests find and click objects, which are pixels on a canvas.
    Object.assign(container, { wayfinder: { map: m, drawn: drawn.current } });
    m.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-left",
    );
    m.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    m.on("load", () => setMapReady(true));
    m.on("error", (event) => {
      if ((event as { sourceId?: string }).sourceId === "imagery")
        setImageryError(true);
    });
    const updateBounds = () => {
      const box = m.getBounds();
      const zoom = m.getZoom();
      // The grid follows 256-pixel tiles, one level above MapLibre's own zoom.
      const bbox = snapBounds(
        [box.getWest(), box.getSouth(), box.getEast(), box.getNorth()],
        zoom + 1,
      );
      setViewport((old) =>
        old.bbox === bbox && old.zoom === zoom ? old : { bbox, zoom },
      );
    };
    m.on("moveend", updateBounds);
    m.on("load", updateBounds);
    m.on("movestart", () => setContextPoint(undefined));
    const openMenu = (location: LngLat, x: number, y: number) => {
      setContextPoint({
        location,
        left: Math.max(6, Math.min(x + 6, container.clientWidth - 198)),
        top: Math.max(6, Math.min(y + 6, container.clientHeight - 76)),
      });
    };
    m.on("contextmenu", (event) => {
      event.preventDefault();
      openMenu(event.lngLat, event.point.x, event.point.y);
    });
    // MapLibre doesn't turn a long press into a context menu on touch screens.
    let pressTimer: ReturnType<typeof setTimeout> | undefined;
    const endPress = () => clearTimeout(pressTimer);
    m.on("touchstart", (event) => {
      endPress();
      if (event.originalEvent.touches.length !== 1) return;
      const { point, lngLat } = event;
      pressTimer = setTimeout(
        () => openMenu(lngLat, point.x, point.y),
        LONG_PRESS_MS,
      );
    });
    m.on("touchmove", endPress);
    m.on("touchend", endPress);
    m.on("touchcancel", endPress);
    m.on("click", (event) => {
      setContextPoint(undefined);
      const { x, y } = event.point;
      const [hit] = m.queryRenderedFeatures(
        [
          [x - CLICK_MARGIN, y - CLICK_MARGIN],
          [x + CLICK_MARGIN, y + CLICK_MARGIN],
        ],
        { layers: CLICKABLE_LAYERS },
      );
      const object = hit && drawn.current.get(hit.properties.osm);
      if (object) openObject(object, scope.current, event.lngLat);
      else clearSelection();
    });
    for (const layer of CLICKABLE_LAYERS) {
      m.on("mouseenter", layer, () => {
        m.getCanvas().style.cursor = "pointer";
      });
      m.on("mouseleave", layer, () => {
        m.getCanvas().style.cursor = "";
      });
    }
    const observer = new ResizeObserver(() => {
      if (container.clientWidth && container.clientHeight) m.resize();
    });
    observer.observe(container);
    // Some browsers send native gesture events for a desktop trackpad pinch.
    let pinchZoom: number | undefined;
    const gestureStart = (event: Event) => {
      if (!window.matchMedia("(pointer: fine)").matches) return;
      event.preventDefault();
      pinchZoom = m.getZoom();
    };
    const gestureChange = (event: Event) => {
      if (pinchZoom === undefined) return;
      const gesture = event as MouseEvent & { scale: number };
      if (!Number.isFinite(gesture.scale) || gesture.scale <= 0) return;
      event.preventDefault();
      const box = container.getBoundingClientRect();
      const anchor: [number, number] =
        Number.isFinite(gesture.clientX) && Number.isFinite(gesture.clientY)
          ? [gesture.clientX - box.left, gesture.clientY - box.top]
          : [box.width / 2, box.height / 2];
      m.easeTo({
        zoom: pinchZoom + Math.log2(gesture.scale),
        around: m.unproject(anchor),
        duration: 0,
      });
    };
    const gestureEnd = () => {
      pinchZoom = undefined;
    };
    container.addEventListener("gesturestart", gestureStart, {
      passive: false,
    });
    container.addEventListener("gesturechange", gestureChange, {
      passive: false,
    });
    container.addEventListener("gestureend", gestureEnd);

    const abort = new AbortController();
    let places: {
      marker: Marker;
      village: boolean;
      width: number;
      shown: boolean;
    }[] = [];
    const refreshPlaces = () => {
      const showVillages = m.getZoom() >= VILLAGE_ZOOM;
      // Each marker is repositioned on every frame, so only nearby ones exist.
      const view = m.getBounds();
      const marginX = (view.getEast() - view.getWest()) * 0.25;
      const marginY = (view.getNorth() - view.getSouth()) * 0.25;
      const nearView = ({ lng, lat }: LngLat) =>
        lat >= view.getSouth() - marginY &&
        lat <= view.getNorth() + marginY &&
        [0, 360, -360].some(
          (shift) =>
            lng + shift >= view.getWest() - marginX &&
            lng + shift <= view.getEast() + marginX,
        );
      const candidates = places.filter(
        ({ village, marker }) =>
          (showVillages || !village) && nearView(marker.getLngLat()),
      );
      const fits = visibleLabels(
        candidates.map(({ marker, width }) => {
          const { x, y } = m.project(marker.getLngLat());
          return { x, y, width, height: 16 };
        }),
      );
      const keep = new Map(candidates.map((place, index) => [place, fits[index]]));
      for (const place of places) {
        const show = keep.get(place) ?? false;
        if (show && !place.shown) place.marker.addTo(m);
        else if (!show && place.shown) place.marker.remove();
        place.shown = show;
      }
    };
    m.on("moveend", refreshPlaces);
    read<MapContext>("/api/analytics/" + country + "/map", abort.signal)
      .then((data) => {
        if (abort.signal.aborted) return;
        setContext(data);
        const ranked: (typeof places)[number][][] = [[], [], []];
        for (const { properties, geometry } of data.features) {
          if (properties.layer !== "place" || geometry.type !== "Point") continue;
          const name = properties.name ?? "";
          ranked[rankPriority(properties.rank)].push({
            marker: new maplibregl.Marker({
              element: placeLabel(name),
              anchor: "center",
            }).setLngLat(geometry.coordinates as [number, number]),
            village: properties.rank === "village",
            width: labelWidth(name),
            shown: false,
          });
        }
        places = ranked.flat();
        refreshPlaces();
      })
      .catch((error) => {
        if (!abort.signal.aborted) setContextError(error.message);
      });

    let streetNames: Marker[] = [];
    const refreshStreetNames = () => {
      streetNames.forEach((marker) => marker.remove());
      streetNames = [];
      if (m.getZoom() < STREET_NAME_ZOOM || aerialRef.current) return;
      const view = m.getBounds();
      const seen = new Set<string>();
      const occupied = new Set<string>();
      for (const { properties, geometry } of m.querySourceFeatures("base", {
        sourceLayer: "roads",
        filter: ["has", "name"],
      })) {
        const name = properties.name as string;
        if (seen.has(name) || geometry.type !== "LineString") continue;
        const center = geometry.coordinates[
          Math.floor(geometry.coordinates.length / 2)
        ] as [number, number];
        if (!view.contains(center)) continue;
        const pixel = m.project(center);
        const cell = Math.floor(pixel.x / 125) + ":" + Math.floor(pixel.y / 45);
        if (occupied.has(cell)) continue;
        occupied.add(cell);
        seen.add(name);
        streetNames.push(
          new maplibregl.Marker({
            element: placeLabel(name, "ax-map-place ax-map-street"),
            anchor: "center",
          })
            .setLngLat(center)
            .addTo(m),
        );
      }
    };
    m.on("idle", refreshStreetNames);

    return () => {
      abort.abort();
      endPress();
      observer.disconnect();
      container.removeEventListener("gesturestart", gestureStart);
      container.removeEventListener("gesturechange", gestureChange);
      container.removeEventListener("gestureend", gestureEnd);
      m.remove();
      map.current = null;
      fittedBounds.current = undefined;
      setMapReady(false);
    };
  }, [country, clearSelection, openObject]);

  useEffect(() => {
    const m = map.current;
    if (!visible || !m || fittedBounds.current === bounds) return;
    m.resize();
    fitArea(m, bounds);
    fittedBounds.current = bounds;
  }, [country, bounds, visible]);

  const selectedLocation = selected?.location;
  const dockOpen = !!(selected || nearby);
  useLayoutEffect(() => {
    const m = map.current;
    if (!m || !host.current?.clientWidth) return;
    m.resize();
    if (!selectedLocation) return;
    // Keep what was clicked in view when the details dock narrows the map.
    const { x, y } = m.project(selectedLocation);
    const width = host.current.clientWidth;
    const height = host.current.clientHeight;
    const moveX = x < 24 ? x - 24 : x > width - 24 ? x - width + 24 : 0;
    const moveY = y < 42 ? y - 42 : y > height - 24 ? y - height + 24 : 0;
    if (moveX || moveY) m.panBy([moveX, moveY], { animate: false });
  }, [selectedLocation, dockOpen]);

  const nearbyCenter = nearby?.center;
  const nearbyRadius = nearby?.radius;
  useEffect(() => {
    const m = map.current;
    if (!m || !nearbyCenter || !nearbyRadius) return;
    fitBox(m, circleBox(nearbyCenter, nearbyRadius), {
      padding: padded(38, 46),
      maxZoom: 17,
    });
  }, [nearbyCenter, nearbyRadius]);

  const nearbyQuery = nearby
    ? new URLSearchParams({
        lat: String(nearby.center.lat),
        lon: String(nearby.center.lng),
        radius: String(nearby.radius),
        page: String(nearby.page),
      }).toString()
    : "";
  const currentNearby =
    nearbyResponse?.query === nearbyQuery ? nearbyResponse : undefined;
  const nearbyResults = currentNearby?.results;
  const nearbyActive = !!nearby;
  useEffect(() => {
    if (!nearbyQuery) return;
    const abort = new AbortController();
    read<NearbyResults>(
      "/api/analytics/" + country + "/nearby?" + nearbyQuery,
      abort.signal,
    )
      .then((results) => {
        if (!abort.signal.aborted)
          setNearbyResponse({ query: nearbyQuery, results });
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setNearbyResponse({ query: nearbyQuery, error: error.message });
      });
    return () => abort.abort();
  }, [country, nearbyQuery]);

  const activeResult = nearbyResults?.features.find(
    ({ id }) => id === (selected?.id ?? hoveredResult),
  );
  const resultSelected = !!selected && activeResult?.id === selected.id;
  const selectedBounds = objectDetails?.data?.bounds;

  // The radius, the active nearby result and the locator ring share one source.
  useEffect(() => {
    const m = map.current;
    if (!m || !mapReady) return;
    const features: Feature[] = [];
    if (nearbyCenter && nearbyRadius) {
      // Thin the radius so an orange result stays readable inside it.
      const thin = !!activeResult;
      features.push(
        featureOf(
          {
            type: "Polygon",
            coordinates: [circleRing(nearbyCenter, nearbyRadius)],
          },
          {
            weight: thin ? 2 : 4,
            opacity: thin ? 0.8 : 1,
            fillOpacity: thin ? 0 : 0.5,
          },
        ),
        featureOf(
          { type: "Point", coordinates: [nearbyCenter.lng, nearbyCenter.lat] },
          {
            radius: 4,
            fill: queryOrange,
            fillOpacity: 1,
            stroke: "#ffffff",
            strokeWidth: 1.5,
          },
        ),
      );
    }
    if (activeResult) {
      const { geometry, properties } = activeResult;
      // Relations can span whole countries, so only outline them.
      const filled =
        geometry.type.includes("Point") ||
        (properties.kind !== "relation" && geometry.type.includes("Polygon"));
      features.push(
        featureOf(geometry, {
          weight: 4,
          opacity: 1,
          fillOpacity: filled ? 0.5 : 0,
          radius: 8,
          fill: queryOrange,
          stroke: queryOrange,
          strokeWidth: 4,
        }),
      );
    }
    if (selectedBounds && !nearbyActive) {
      const [west, south, east, north] = selectedBounds;
      const span = m.project([east, north]);
      const start = m.project([west, south]);
      // A short road can be under a pixel at country zoom, so ring it.
      if (Math.max(Math.abs(span.x - start.x), Math.abs(span.y - start.y)) <= 24)
        features.push(
          featureOf(
            {
              type: "Point",
              coordinates: [(west + east) / 2, (south + north) / 2],
            },
            {
              radius: 14,
              fill: queryOrange,
              fillOpacity: 0,
              stroke: queryOrange,
              strokeWidth: 2.5,
            },
          ),
        );
    }
    setFeatures(m, "query", features);
  }, [
    mapReady,
    nearbyCenter,
    nearbyRadius,
    activeResult,
    selectedBounds,
    nearbyActive,
    zoom,
  ]);

  useEffect(() => {
    const m = map.current;
    if (!m || !mapReady || !activeResult || !resultSelected) return;
    const box = extendBox(emptyBox(), activeResult.geometry);
    if (!validBox(box)) return;
    const view = m.getBounds();
    if (
      !view.contains([box[0], box[1]]) ||
      !view.contains([box[2], box[3]])
    )
      fitBox(m, box, { padding: padded(38, 46), maxZoom: 17 });
  }, [mapReady, activeResult, resultSelected]);

  useEffect(() => {
    const m = map.current;
    if (!m || !mapReady) return;
    setImageryError(false);
    setVisible(m, BASE_LAYERS, !aerial);
    if (m.getLayer("imagery")) setVisible(m, ["imagery"], aerial);
    const color: ExpressionSpecification = ["get", aerial ? "aerial" : "street"];
    m.setPaintProperty("matches-fill", "fill-color", color);
    m.setPaintProperty("matches-line", "line-color", color);
    m.setPaintProperty("matches-point", "circle-color", color);
    m.setPaintProperty(
      "matches-point",
      "circle-stroke-color",
      aerial ? "#0b0e10" : "#ffffff",
    );
    // Orange disappears on sand, so the selection turns white on imagery.
    const highlight = aerial ? "#ffffff" : queryOrange;
    m.setPaintProperty("selected-fill", "fill-color", highlight);
    m.setPaintProperty("selected-line", "line-color", highlight);
    m.setPaintProperty("selected-point", "circle-color", highlight);
    m.setPaintProperty(
      "selected-point",
      "circle-stroke-color",
      aerial ? "#0b0e10" : "#ffffff",
    );
    m.setPaintProperty(
      "boundary-line",
      "line-color",
      aerial ? "#ffe182" : "#116959",
    );
    m.setPaintProperty(
      "boundary-fill",
      "fill-color",
      aerial ? "#fff0a3" : "#67bbaa",
    );
  }, [aerial, mapReady]);

  useEffect(() => {
    const m = map.current;
    if (!m || !mapReady) return;
    setVisible(
      m,
      [...MATCH_LAYERS, ...SELECTED_LAYERS, ...QUERY_LAYERS, ...BOUNDARY_LAYERS],
      !objectsHidden,
    );
  }, [objectsHidden, mapReady]);

  const selectedId = selected?.id;
  useEffect(() => {
    const m = map.current;
    if (!m || !mapReady) return;
    const isSelected: ExpressionSpecification = [
      "==",
      ["get", "osm"],
      selectedId ?? "",
    ];
    const types = (names: string[]): ExpressionSpecification => [
      "in",
      ["geometry-type"],
      ["literal", names],
    ];
    const polygons = types(["Polygon", "MultiPolygon"]);
    const points = types(["Point", "MultiPoint"]);
    // Relations can span whole countries, so only outline them.
    m.setFilter("selected-fill", ["all", isSelected, polygons, ["==", ["get", "relation"], 0]]);
    m.setFilter("selected-line", ["all", isSelected, ["!", points]]);
    m.setFilter("selected-point", ["all", isSelected, points]);
    // Filter colours can be close to the highlight, so the rest step back.
    const dim = selectedId ? 0.25 : 1;
    m.setPaintProperty("matches-fill", "fill-opacity", 0.34 * dim);
    m.setPaintProperty("matches-line", "line-opacity", dim);
    m.setPaintProperty("matches-point", "circle-opacity", dim);
    m.setPaintProperty("matches-point", "circle-stroke-opacity", dim);
  }, [selectedId, mapReady, nearbyActive]);

  useEffect(() => {
    const m = map.current;
    if (!m || !mapReady) return;
    const filter: ExpressionSpecification = [
      "==",
      ["get", "name"],
      selectedArea ?? "",
    ];
    for (const layer of BOUNDARY_LAYERS) m.setFilter(layer, filter);
  }, [selectedArea, mapReady]);

  useEffect(() => {
    if (!objectUrl) return;
    const abort = new AbortController();
    read<ObjectDetails>(objectUrl, abort.signal)
      .then((data) => {
        if (!abort.signal.aborted) setObjectResponse({ url: objectUrl, data });
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setObjectResponse({ url: objectUrl, error: error.message });
      });
    return () => abort.abort();
  }, [objectUrl]);

  const closeObject = () => {
    clearSelection();
    host.current?.focus({ preventScroll: true });
  };
  const closeNearby = () => {
    setNearby(undefined);
    setHoveredResult(undefined);
    closeObject();
  };
  const goTo = (coordinates: Coordinates) => {
    const m = map.current;
    if (!m) return;
    closeNearby();
    setContextPoint(undefined);
    m.jumpTo({
      center: [coordinates[1], coordinates[0]],
      zoom: Math.max(14, m.getZoom()),
    });
  };

  useEffect(() => {
    setSelection(undefined);
  }, [filterParams]);

  const zoomToObject = (item: ObjectDetails) => {
    const m = map.current;
    if (!m) return;
    if (item.coordinates) {
      m.jumpTo({
        center: [item.coordinates[0], item.coordinates[1]],
        zoom: Math.max(16, m.getZoom()),
      });
    } else fitArea(m, item.bounds, 17);
  };

  const fitRadius = (animate: boolean) => {
    if (nearby)
      fitBox(
        map.current,
        circleBox(nearby.center, nearby.radius),
        { padding: padded(38, 46), maxZoom: 17 },
        animate,
      );
  };

  const parameters = new URLSearchParams(filterParams);
  parameters.set("bbox", bbox);
  const featureUrl = "/api/analytics/" + country + "/features";
  const form = parameters.toString();
  const query = featureUrl + "?" + form;
  useEffect(() => {
    const m = map.current;
    if (!bbox || !m || !mapReady) return;
    const abort = new AbortController();
    const clear = () => {
      drawn.current.clear();
      drawnBounds.current = undefined;
      setFeatures(m, "matches", []);
    };
    // Nearby results are listed in the dock; only the active one is drawn.
    if (nearbyActive) {
      clear();
      return;
    }
    const draw = (
      data: FeatureCollection<Geometry, MappedObject>,
      limited: boolean,
    ) => {
      const legend = mapLegend(filters);
      const paletteByRule = new Map(
        legend.map(({ key, value, tone }) => [
          JSON.stringify([key, value]),
          tone,
        ]),
      );
      const rare = data.features.length <= 120;
      const features: Feature[] = [];
      const everything = emptyBox();
      const view = m.getBounds();
      drawn.current.clear();
      for (const feature of data.features) {
        const object = feature.properties;
        const id = object.kind + "/" + object.id;
        const [key, value] = object.tags[0] ?? [];
        const tone =
          object.tags.length > 1
            ? overlapTone
            : (paletteByRule.get(JSON.stringify([key, value])) ??
              paletteByRule.get(JSON.stringify([key, undefined])) ??
              palette[0]);
        const properties = {
          osm: id,
          street: tone.street,
          aerial: tone.aerial,
          width: rare ? 4 : 2.8,
          radius: rare ? 5 : 3.25,
          relation: object.kind === "relation" ? 1 : 0,
        };
        drawn.current.set(id, object);
        features.push(featureOf(feature.geometry, properties));
        const box = extendBox(emptyBox(), feature.geometry);
        if (!validBox(box)) continue;
        extendBox(everything, {
          type: "MultiPoint",
          coordinates: [
            [box[0], box[1]],
            [box[2], box[3]],
          ],
        });
        // A short line can vanish at this zoom, so a dot marks where it is.
        if (!feature.geometry.type.includes("Point")) {
          const low = m.project([box[0], box[1]]);
          const high = m.project([box[2], box[3]]);
          const center: [number, number] = [
            (box[0] + box[2]) / 2,
            (box[1] + box[3]) / 2,
          ];
          if (
            Math.max(Math.abs(high.x - low.x), Math.abs(high.y - low.y)) <= 9 &&
            view.contains(center)
          )
            features.push(
              featureOf({ type: "Point", coordinates: center }, properties),
            );
        }
      }
      drawnBounds.current = validBox(everything) ? everything : undefined;
      setFeatures(m, "matches", features);
      setResponse({
        query,
        count: data.features.length,
        limited,
      });
    };
    if (!filters.length && !parameters.has("allKeys")) {
      clear();
      return;
    }
    const timer = setTimeout(() => {
      read<MatchingFeatures>(
        featureUrl,
        abort.signal,
        new URLSearchParams(form),
      )
        .then((data) => {
          if (!abort.signal.aborted) draw(data, data.limited);
        })
        .catch((error) => {
          if (!abort.signal.aborted)
            setResponse({
              query,
              count: 0,
              limited: false,
              error: error.message,
            });
        });
    }, 110);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
    // parameters is rebuilt each render from form, which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bbox, query, featureUrl, form, filters, nearbyActive, mapReady]);

  const status = response?.query === query ? response : undefined;
  const mapError = (!nearby && status?.error) || contextError;
  const places =
    context?.features.flatMap(({ properties, geometry }) => {
      if (
        properties.layer !== "place" ||
        !properties.name ||
        geometry.type !== "Point"
      )
        return [];
      return [
        {
          name: properties.name,
          coordinates: [
            geometry.coordinates[1],
            geometry.coordinates[0],
          ] as Coordinates,
        },
      ];
    }) ?? [];
  return (
    <div
      className={
        "ax-feature-map-wrap" +
        (aerial ? " is-satellite" : "") +
        (objectsHidden ? " objects-hidden" : "")
      }
    >
      <div className={"ax-map-viewport" + (dockOpen ? " has-inspector" : "")}>
        <div
          className={"ax-map-canvas" + (selected ? " has-selection" : "")}
          onKeyDown={(event) => {
            if (event.key === "Escape") setContextPoint(undefined);
          }}
        >
          <div
            className="ax-feature-map"
            aria-label="Interactive map of matching OpenStreetMap features"
            ref={host}
          />
          <div className="ax-map-tools">
            <LocationSearch places={places} onGo={goTo} />
            <div className="ax-map-actions">
              {country === "LU" && (
                <div
                  className="ax-geo-switch gs-segmented"
                  role="group"
                  aria-label="Basemap"
                >
                  <button
                    type="button"
                    className="gs-segment"
                    aria-pressed={basemap === "street"}
                    onClick={() => setBasemap("street")}
                  >
                    Map
                  </button>
                  <button
                    type="button"
                    className="gs-segment"
                    aria-pressed={basemap === "satellite"}
                    onClick={() => setBasemap("satellite")}
                  >
                    Satellite
                  </button>
                </div>
              )}
              <button
                className="ax-fit-map ax-toggle-objects gs-btn gs-btn--secondary"
                type="button"
                onClick={() => {
                  if (!objectsHidden) clearSelection();
                  setObjectsHidden(!objectsHidden);
                }}
              >
                {objectsHidden ? <Eye size={14} /> : <EyeOff size={14} />}{" "}
                {objectsHidden ? "Show objects" : "Hide objects"}
              </button>
              <button
                className="ax-fit-map gs-btn gs-btn--secondary"
                type="button"
                onClick={() => {
                  if (nearby) fitRadius(true);
                  else fitArea(map.current, bounds);
                }}
              >
                <LocateFixed size={14} /> {nearby ? "Fit radius" : "Fit area"}
              </button>
              {!nearby && status?.count && !status.limited ? (
                <button
                  className="ax-fit-map ax-fit-matches gs-btn gs-btn--secondary"
                  type="button"
                  onClick={() => {
                    if (drawnBounds.current)
                      fitBox(
                        map.current,
                        drawnBounds.current,
                        { padding: 28, maxZoom: 16 },
                        true,
                      );
                  }}
                >
                  Fit matches
                </button>
              ) : null}
            </div>
          </div>
          {contextPoint && (
            <div
              className="ax-map-context-menu gs-popover"
              role="group"
              aria-label="Map location actions"
              style={{ left: contextPoint.left, top: contextPoint.top }}
            >
              <button
                type="button"
                className="gs-btn gs-btn--ghost"
                autoFocus
                onClick={() => beginNearby(contextPoint.location)}
              >
                <Crosshair size={14} /> Query nearby features
              </button>
              <button
                type="button"
                className="gs-btn gs-btn--ghost"
                onClick={() =>
                  goTo([contextPoint.location.lat, contextPoint.location.lng])
                }
              >
                <LocateFixed size={14} /> Go to this location
              </button>
            </div>
          )}
        </div>
        {selected ? (
          <AnalyticsObjectInspector
            object={selected.object}
            details={objectDetails?.data}
            error={objectDetails?.error}
            onClose={() => {
              closeObject();
              fitRadius(false);
            }}
            onZoom={zoomToObject}
            backToResults={nearbyActive}
          />
        ) : (
          nearby && (
            <NearbyPanel
              center={[nearby.center.lat, nearby.center.lng]}
              radius={nearby.radius}
              result={nearbyResults}
              error={currentNearby?.error}
              onRadius={(radius) =>
                setNearby((query) => query && { ...query, radius, page: 1 })
              }
              onPage={(page) =>
                setNearby((query) => query && { ...query, page })
              }
              onHighlight={setHoveredResult}
              onSelect={(object) => {
                setHoveredResult(undefined);
                openObject(object, filterParams);
              }}
              onClose={closeNearby}
            />
          )
        )}
      </div>
      {(mapError || aerial) && (
        <div className="ax-feature-map-info">
          {mapError && <p role="status">{mapError}</p>}
          {aerial && (
            <>
              <a
                className="ax-imagery-credit"
                href="https://data.public.lu/en/datasets/orthophoto-officielle-du-grand-duche-de-luxembourg-edition-ete-2025/"
                target="_blank"
                rel="noreferrer"
              >
                Aerial imagery: Geoportail Luxembourg · 2025
              </a>
              {imageryError && (
                <p role="status">
                  Some aerial tiles couldn’t load. Switch to Map to continue.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

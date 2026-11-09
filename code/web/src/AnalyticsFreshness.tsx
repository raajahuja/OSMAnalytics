import { apiFetch, datasetVersion } from "./api";
import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type {
  GeoJSONSource,
  Map as MapLibreMap,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { freshnessMapStyle } from "./mapStyle";
import { ArrowUpRight, History } from "lucide-react";
import "./analytics-freshness.css";

type Bounds = [west: number, south: number, east: number, north: number];
type ListedObject = {
  kind: "node" | "way" | "relation";
  id: number;
  label: string | null;
  version: number;
  edited: number;
};
type Freshness = {
  staleYears: number;
  staleYear: number;
  objects: number;
  stale: number;
  recent: number;
  medianEdited: number | null;
  sample: number | null;
  averageVersion: number | null;
  maxVersion: number;
  years: { year: number; objects: number }[];
  regions: {
    id: string;
    name: string;
    objects: number;
    stale: number;
    averageAgeYears: number;
  }[];
  cells: { bounds: Bounds; objects: number; stale: number }[];
  mostEdited: ListedObject[];
  oldest: ListedObject[];
};

const whole = new Intl.NumberFormat("en-US");
const count = (value: number) => whole.format(value);
const percent = (part: number, total: number) =>
  total ? Math.round((100 * part) / total) + "%" : "0%";
const monthYear = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const fullDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const fromSeconds = (seconds: number) => new Date(seconds * 1000);

// One hue from near-surface to bright: more stale reads as brighter on the dark map.
const ramp = ["#184f95", "#2a78d6", "#5598e7", "#86b6ef", "#cde2fb"];
const rampLabels = ["0–20%", "20–40%", "40–60%", "60–80%", "80–100%"];
const staleColor = (share: number) =>
  ramp[Math.min(ramp.length - 1, Math.floor(share * ramp.length))];

function YearChart({ data }: { data: Freshness }) {
  const tallest = Math.max(...data.years.map(({ objects }) => objects));
  const step = Math.ceil(data.years.length / 10);
  const peak = data.years.find(({ objects }) => objects === tallest)?.year;
  return (
    <section className="ax-freshness-card" aria-label="Objects by last edit year">
      <h4>Last edited, by year</h4>
      <p>Objects by the year of their most recent edit</p>
      <div className="ax-freshness-legend">
        <span>
          <i className="is-stale" /> Before {data.staleYear}
        </span>
        <span>
          <i /> {data.staleYear} onward
        </span>
      </div>
      <div
        className="ax-freshness-years"
        role="img"
        aria-label={
          "Most objects were last edited in " +
          peak +
          ", with " +
          count(tallest) +
          " objects."
        }
      >
        {data.years.map(({ year, objects }, index) => (
          <div className="ax-freshness-year" key={year}>
            <span
              className={
                "ax-freshness-tip" +
                (index > data.years.length / 2 ? " is-left" : "")
              }
            >
              <strong>{year}</strong> {count(objects)}
            </span>
            {year === peak && (
              <em className="ax-freshness-peak">{count(objects)}</em>
            )}
            <b
              className={year < data.staleYear ? "is-stale" : undefined}
              style={{
                height: objects ? `max(2px, ${(100 * objects) / tallest}%)` : 0,
              }}
            />
            <small>
              {(data.years.length - 1 - index) % step === 0 ? year : ""}
            </small>
          </div>
        ))}
      </div>
    </section>
  );
}

function ObjectList({
  title,
  detail,
  rows,
  value,
}: {
  title: string;
  detail: string;
  rows: ListedObject[];
  value: (row: ListedObject) => string;
}) {
  return (
    <section className="ax-freshness-card" aria-label={title}>
      <h4>{title}</h4>
      <p>{detail}</p>
      <ol className="ax-freshness-list">
        {rows.map((row) => (
          <li key={row.kind + row.id}>
            <a
              href={`https://www.openstreetmap.org/${row.kind}/${row.id}/history`}
              target="_blank"
              rel="noreferrer"
              title="Open edit history in OpenStreetMap"
            >
              <span>{row.label || row.kind + " " + row.id}</span>
              <ArrowUpRight size={13} />
            </a>
            <strong>{value(row)}</strong>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function AnalyticsFreshness({
  country,
  region,
  bounds,
  areaName,
  filterParams,
  onRegion,
}: {
  country: string;
  region: string;
  bounds: Bounds;
  areaName: string;
  filterParams: string;
  onRegion: (id: string) => void;
}) {
  const [data, setData] = useState<Freshness>();
  const [error, setError] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const url = "/api/analytics/" + country + "/freshness";
  const [west, south, east, north] = bounds;

  useEffect(() => {
    const abort = new AbortController();
    setError("");
    const timer = setTimeout(() => {
      apiFetch(url, abort.signal, new URLSearchParams(filterParams))
        .then(async (response) => {
          const body = await response.json();
          if (!response.ok) throw new Error(body.error);
          setData(body);
        })
        .catch((failure) => {
          if (!abort.signal.aborted)
            setError(failure.message || "Could not load freshness.");
        });
    }, 140);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [url, filterParams]);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const m = new maplibregl.Map({
      container,
      style: freshnessMapStyle(country, datasetVersion(country)),
      attributionControl: false,
      minZoom: 4,
      maxZoom: 15,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      fadeDuration: 0,
    });
    map.current = m;
    m.touchZoomRotate.disableRotation();
    m.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-left",
    );
    m.on("load", () => setMapReady(true));
    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      className: "ax-freshness-popup",
    });
    m.on("mousemove", "cells", (event) => {
      const text = event.features?.[0]?.properties.text;
      if (!text) return;
      popup
        .setLngLat(event.lngLat)
        .setHTML(text as string)
        .addTo(m);
    });
    m.on("mouseleave", "cells", () => popup.remove());
    const observer = new ResizeObserver(() => m.resize());
    observer.observe(container);
    return () => {
      observer.disconnect();
      m.remove();
      map.current = null;
      setMapReady(false);
    };
  }, [country]);

  useEffect(() => {
    map.current?.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 14, animate: false },
    );
  }, [west, south, east, north]);

  useEffect(() => {
    const source = map.current?.getSource("cells") as GeoJSONSource | undefined;
    if (!source || !mapReady || !data) return;
    source.setData({
      type: "FeatureCollection",
      features: data.cells.map((cell) => {
        const [w, s, e, n] = cell.bounds;
        return {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s],
              ],
            ],
          },
          properties: {
            color: staleColor(cell.stale / cell.objects),
            text: `<strong>${percent(cell.stale, cell.objects)}</strong> not edited in ${data.staleYears}+ years · ${count(cell.objects)} objects`,
          },
        };
      }),
    });
  }, [data, mapReady]);

  const empty = data && !data.objects;
  return (
    <section className="gs-panel ax-panel ax-freshness" id="freshness">
      <div className="ax-freshness-head">
        <h4>
          <History size={16} /> Freshness · {areaName}
        </h4>
        <p>
          Old does not mean wrong, since stable features rarely need edits. A
          way's date changes when its tags or node list change, not when its
          nodes move.
        </p>
      </div>
      {error && (
        <p className="ax-empty" role="alert">
          {error}
        </p>
      )}
      {empty && (
        <p className="ax-empty" role="status">
          No dated objects match these filters.
        </p>
      )}
      {!data && !error && (
        <p className="ax-empty" role="status">
          Loading freshness…
        </p>
      )}
      {data && !empty && data.sample && (
        <p className="ax-freshness-sample" role="note">
          Estimated from a fixed sample of {count(data.sample)} of these
          objects, since the selection is too large to read in full. Counts
          are scaled up, and the lists below come from the sample.
        </p>
      )}
      {data && !empty && (
        <dl className="ax-freshness-stats">
          <div>
            <dt>Objects</dt>
            <dd>{count(data.objects)}</dd>
          </div>
          <div>
            <dt>Median last edit</dt>
            <dd>
              {data.medianEdited
                ? monthYear.format(fromSeconds(data.medianEdited))
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Not edited in {data.staleYears}+ years</dt>
            <dd>
              {percent(data.stale, data.objects)}
              <small>{count(data.stale)}</small>
            </dd>
          </div>
          <div>
            <dt>Edited in the last year</dt>
            <dd>
              {percent(data.recent, data.objects)}
              <small>{count(data.recent)}</small>
            </dd>
          </div>
          <div>
            <dt>Average version</dt>
            <dd>
              {(data.averageVersion ?? 0).toFixed(1)}
              <small>highest {count(data.maxVersion)}</small>
            </dd>
          </div>
        </dl>
      )}
      <div className="ax-freshness-main" hidden={!!empty}>
        <section
          className="ax-freshness-card ax-freshness-map-card"
          aria-label="Stale areas map"
        >
          <h4>Stale areas</h4>
          <p>Share of objects in each square not edited in {data?.staleYears ?? 3}+ years</p>
          <div
            className="ax-freshness-map"
            ref={host}
            role="img"
            aria-label="Map of stale object share. The table below lists the same information by area."
          />
          <div className="ax-freshness-legend" aria-hidden="true">
            {ramp.map((color, index) => (
              <span key={color}>
                <i style={{ background: color }} /> {rampLabels[index]}
              </span>
            ))}
          </div>
        </section>
        {data && !empty && <YearChart data={data} />}
      </div>
      {data && !empty && (
        <div className="ax-freshness-tables">
          <section className="ax-freshness-card" aria-label="Stalest regions">
            <h4>Stalest areas first</h4>
            <p>Select a row to focus on that area</p>
            <div className="ax-freshness-table">
              <table className="gs-table">
                <thead>
                  <tr>
                    <th scope="col">Area</th>
                    <th scope="col">Stale</th>
                    <th scope="col">Avg age</th>
                    <th scope="col">Objects</th>
                  </tr>
                </thead>
                <tbody>
                  {data.regions.map((row) => (
                    <tr
                      key={row.id}
                      className={row.id === region ? "is-selected" : undefined}
                    >
                      <th scope="row">
                        <button type="button" onClick={() => onRegion(row.id)}>
                          {row.name}
                        </button>
                      </th>
                      <td>{percent(row.stale, row.objects)}</td>
                      <td>{row.averageAgeYears.toFixed(1)} yr</td>
                      <td>{count(row.objects)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <ObjectList
            title="Most edited"
            detail="Highest version number. Opens the edit history."
            rows={data.mostEdited}
            value={({ version }) => "v" + count(version)}
          />
          <ObjectList
            title="Longest untouched"
            detail="Oldest last edit. Opens the edit history."
            rows={data.oldest}
            value={({ edited }) => fullDate.format(fromSeconds(edited))}
          />
        </div>
      )}
    </section>
  );
}

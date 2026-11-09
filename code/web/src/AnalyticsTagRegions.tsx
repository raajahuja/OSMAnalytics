import { apiFetch } from "./api";
import { useEffect, useState } from "react";
import { MapPinned } from "lucide-react";
import "./analytics-tag-regions.css";

type Row = {
  id: string;
  name: string;
  areaKm2: number;
  count: number;
  keyCount: number;
  distinctValues: number;
  regionObjects: number;
  topValue: string | null;
  topCount: number;
};
type Results = { total: number; regions: Row[] };

const whole = new Intl.NumberFormat("en-US");
const count = (value: number) => whole.format(value);
const share = (part: number, total: number) => {
  if (!total || !part) return "0%";
  const percent = (100 * part) / total;
  return (percent < 0.1 ? "<0.1" : percent.toFixed(1).replace(/\.0$/, "")) + "%";
};
const density = (objects: number, km2: number) => {
  if (!km2) return "—";
  const value = objects / km2;
  return value >= 10
    ? count(Math.round(value))
    : value.toFixed(value >= 1 ? 1 : 2);
};

export default function AnalyticsTagRegions({
  country,
  tagKey,
  kind,
  values,
  division,
  selectedRegion,
  onRegion,
}: {
  country: string;
  tagKey: string;
  kind: string;
  values: string[];
  division: string;
  selectedRegion: string;
  onRegion: (id: string) => void;
}) {
  const [response, setResponse] = useState<{ id: string; data: Results }>();
  const [error, setError] = useState("");
  const form = new URLSearchParams({ key: tagKey, kind });
  for (const value of values) form.append("focus", value);
  const id = country + "?" + form;

  useEffect(() => {
    const abort = new AbortController();
    setError("");
    const timer = setTimeout(() => {
      apiFetch(
        "/api/analytics/" + country + "/tag-regions",
        abort.signal,
        new URLSearchParams(id.split("?")[1]),
      )
        .then(async (reply) => {
          const body = await reply.json();
          if (!reply.ok) throw new Error(body.error);
          setResponse({ id, data: body });
        })
        .catch((failure) => {
          if (!abort.signal.aborted)
            setError(failure.message || "Could not load regions.");
        });
    }, 140);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [country, id]);

  const data = response?.id === id ? response.data : undefined;
  const largest = data ? Math.max(1, data.regions[0]?.count ?? 0) : 1;
  const subject =
    values.length === 0
      ? tagKey
      : values.length === 1
        ? tagKey + "=" + (values[0] || "(empty value)")
        : tagKey + " · " + values.length + " values";
  return (
    <section className="ax-tag-regions" aria-label={"By " + division}>
      <div className="ax-tag-regions-head">
        <h4>
          <MapPinned size={16} /> By {division.toLowerCase()}
          <code>{subject}</code>
        </h4>
        <p>
          Select a {division.toLowerCase()} to focus on it. An object crossing a
          border counts in each {division.toLowerCase()} it touches.
        </p>
      </div>
      {error && (
        <p className="ax-empty" role="alert">
          {error}
        </p>
      )}
      {!data && !error && (
        <p className="ax-empty" role="status">
          Loading regions…
        </p>
      )}
      {data && (
        <div className="ax-tag-regions-scroll" tabIndex={0}>
          <table className="gs-table">
            <thead>
              <tr>
                <th>{division}</th>
                <th className="ax-number">Objects</th>
                <th aria-hidden="true" />
                <th className="ax-number">% of country</th>
                <th className="ax-number">Per km²</th>
                <th className="ax-number">% of its objects</th>
                <th className="ax-number">Distinct values</th>
                <th>Most common value</th>
              </tr>
            </thead>
            <tbody>
              {data.regions.map((row) => (
                <tr
                  key={row.id}
                  className={row.id === selectedRegion ? "is-selected" : undefined}
                >
                  <td>
                    <button
                      type="button"
                      className="ax-text-button"
                      onClick={() => onRegion(row.id)}
                    >
                      {row.name}
                    </button>
                  </td>
                  <td className="ax-number ax-emphasis">{count(row.count)}</td>
                  <td className="ax-tag-regions-bar" aria-hidden="true">
                    <i>
                      <b style={{ width: (100 * row.count) / largest + "%" }} />
                    </i>
                  </td>
                  <td className="ax-number">{share(row.count, data.total)}</td>
                  <td className="ax-number">
                    {density(row.count, row.areaKm2)}
                  </td>
                  <td className="ax-number">
                    {share(row.count, row.regionObjects)}
                  </td>
                  <td className="ax-number">{count(row.distinctValues)}</td>
                  <td className="ax-tag-regions-top">
                    {row.topValue === null ? (
                      "—"
                    ) : (
                      <>
                        <code title={row.topValue}>
                          {row.topValue || "(empty value)"}
                        </code>
                        <small>{share(row.topCount, row.keyCount)}</small>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

import { useState } from "react";
import { ChevronLeft, ChevronRight, Crosshair, Search, X } from "lucide-react";
import type { FeatureCollection, Geometry } from "geojson";
import type { MappedObject } from "./AnalyticsObjectInspector";

export type Coordinates = [latitude: number, longitude: number];
export type Place = { name: string; coordinates: Coordinates };
export type NearbyObject = MappedObject & {
  category: string | null;
  distance: number;
};
export type NearbyResults = FeatureCollection<Geometry, NearbyObject> & {
  total: number;
  page: number;
  pageSize: number;
};

const counts = new Intl.NumberFormat("en-GB");
const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

function parseCoordinates(text: string): Coordinates | undefined {
  const match = text.match(
    /^([+-]?\d+(?:\.\d+)?)(?:\s*,\s*|\s+)([+-]?\d+(?:\.\d+)?)$/,
  );
  if (!match) return;
  const lat = Number(match[1]),
    lon = Number(match[2]);
  if (Math.abs(lat) <= 85 && Math.abs(lon) <= 180) return [lat, lon];
}

export function LocationSearch({
  places,
  onGo,
}: {
  places: Place[];
  onGo: (coordinates: Coordinates) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const term = normalize(query.trim());
  const coordinates = parseCoordinates(query.trim());
  const matching =
    term && !coordinates
      ? places
          .filter(({ name }) => normalize(name).includes(term))
          .sort((a, b) => {
            const rank = (item: Place) =>
              normalize(item.name) === term
                ? 0
                : normalize(item.name).startsWith(term)
                  ? 1
                  : 2;
            return rank(a) - rank(b) || a.name.localeCompare(b.name);
          })
          .slice(0, 8)
      : [];
  const choose = (point: Coordinates) => {
    onGo(point);
    setOpen(false);
  };
  return (
    <form
      className="ax-location-control"
      role="search"
      aria-label="Find a map location"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        const point = coordinates ?? matching[0]?.coordinates;
        if (point) choose(point);
      }}
    >
      <label className="ax-location-field">
        <Search size={14} aria-hidden="true" />
        <input
          className="gs-input"
          type="search"
          aria-label="Go to location"
          placeholder="Go to location"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
        />
      </label>
      {open && (
        <div
          className="ax-location-search gs-popover"
          // Keeps focus in the box so a result's click lands before blur.
          onMouseDown={(event) => event.preventDefault()}
        >
          {coordinates ? (
            <button type="submit" className="gs-btn gs-btn--ghost">
              <Crosshair size={14} /> Go to {coordinates.join(", ")}
            </button>
          ) : matching.length ? (
            <div className="ax-location-results">
              {matching.map(({ name, coordinates: point }) => (
                <button
                  type="button"
                  className="gs-btn gs-btn--ghost"
                  key={name + point.join(",")}
                  onClick={() => choose(point)}
                >
                  {name}
                </button>
              ))}
            </div>
          ) : (
            <small>
              {term
                ? "No local place found. Try latitude, longitude."
                : "Search local place names or enter latitude, longitude."}
            </small>
          )}
        </div>
      )}
    </form>
  );
}

export function NearbyPanel({
  center,
  radius,
  result,
  error,
  onRadius,
  onPage,
  onHighlight,
  onSelect,
  onClose,
}: {
  center: Coordinates;
  radius: number;
  result?: NearbyResults;
  error?: string;
  onRadius: (radius: number) => void;
  onPage: (page: number) => void;
  onHighlight: (id?: string) => void;
  onSelect: (object: NearbyObject) => void;
  onClose: () => void;
}) {
  const pageCount = result ? Math.ceil(result.total / result.pageSize) : 0;
  return (
    <aside
      className="ax-object-inspector ax-nearby-panel gs-panel"
      aria-label="Nearby features"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="ax-object-head">
        <div>
          <div className="ax-object-kicker">
            {center[0].toFixed(5)}, {center[1].toFixed(5)}
          </div>
          <h5>Nearby features</h5>
        </div>
        <button
          type="button"
          aria-label="Close nearby query"
          className="gs-btn gs-btn--ghost gs-icon-btn"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </div>
      <div className="ax-nearby-controls">
        <label>
          Radius
          <select
            className="gs-select"
            value={radius}
            onChange={(event) => onRadius(Number(event.target.value))}
          >
            {[25, 50, 100, 250, 500, 1000, 2000].map((metres) => (
              <option key={metres} value={metres}>
                {metres >= 1000 ? metres / 1000 + " km" : metres + " m"}
              </option>
            ))}
          </select>
        </label>
        <span>All local OSM features</span>
      </div>
      <div className="ax-object-body ax-nearby-results">
        <p role="status">
          {error ??
            (result
              ? counts.format(result.total) +
                (result.total === 1 ? " feature found" : " features found")
              : "Querying nearby features…")}
        </p>
        {result?.features.map(({ properties: object }) => (
          <button
            className="ax-nearby-result"
            type="button"
            key={object.kind + "/" + object.id}
            onClick={() => onSelect(object)}
            onMouseEnter={() => onHighlight(object.kind + "/" + object.id)}
            onMouseLeave={() => onHighlight()}
            onFocus={() => onHighlight(object.kind + "/" + object.id)}
            onBlur={() => onHighlight()}
          >
            <span>
              <strong>
                {object.label ||
                  object.category ||
                  object.kind + " " + object.id}
              </strong>
              <small>
                {object.kind}
                {object.label && object.category ? " · " + object.category : ""}
              </small>
            </span>
            <span>{counts.format(object.distance)} m</span>
          </button>
        ))}
      </div>
      <div className="ax-object-actions">
        {result && pageCount > 0 ? (
          <>
            <span>
              Page {counts.format(result.page)} of {counts.format(pageCount)}
            </span>
            <div className="ax-nearby-pages">
              <button
                type="button"
                className="gs-btn gs-btn--ghost gs-icon-btn"
                aria-label="Previous nearby results"
                disabled={result.page <= 1}
                onClick={() => onPage(result.page - 1)}
              >
                <ChevronLeft size={15} />
              </button>
              <button
                type="button"
                className="gs-btn gs-btn--ghost gs-icon-btn"
                aria-label="Next nearby results"
                disabled={result.page >= pageCount}
                onClick={() => onPage(result.page + 1)}
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </>
        ) : (
          <span>Features that intersect the radius</span>
        )}
      </div>
    </aside>
  );
}

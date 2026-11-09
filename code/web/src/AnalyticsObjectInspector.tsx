import { ArrowLeft, ArrowUpRight, LocateFixed, X } from "lucide-react";

export type MappedObject = {
  kind: "node" | "way" | "relation";
  id: number;
  label: string | null;
  tags: [key: string, value: string][];
};

export type ObjectDetails = {
  geometry: string;
  coordinates: [number, number] | null;
  bounds: [number, number, number, number];
  regions: string[];
  version: number | null;
  edited: number | null;
  tags: { key: string; value: string }[];
};

const editDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export default function AnalyticsObjectInspector({
  object,
  details,
  error,
  onClose,
  onZoom,
  backToResults,
}: {
  object: MappedObject;
  details?: ObjectDetails;
  error?: string;
  onClose: () => void;
  onZoom: (details: ObjectDetails) => void;
  backToResults?: boolean;
}) {
  const matching = new Map(object.tags);
  const rows =
    details?.tags ?? object.tags.map(([key, value]) => ({ key, value }));
  const tags = [...rows].sort(
    (a, b) => Number(matching.has(b.key)) - Number(matching.has(a.key)),
  );
  const type = object.kind.charAt(0).toUpperCase() + object.kind.slice(1);
  return (
    <aside
      className="ax-object-inspector gs-panel"
      aria-label="Feature details"
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
            OSM {object.kind} · {object.id}
          </div>
          <h5>{object.label || type + " " + object.id}</h5>
        </div>
        <button
          type="button"
          className="gs-btn gs-btn--ghost gs-icon-btn"
          aria-label={
            backToResults ? "Back to nearby results" : "Close feature details"
          }
          onClick={onClose}
        >
          {backToResults ? <ArrowLeft size={17} /> : <X size={17} />}
        </button>
      </div>
      <div className="ax-object-body">
        {details && (
          <dl className="ax-object-location">
            <div>
              <dt>Geometry</dt>
              <dd>{details.geometry.replace(/([a-z])([A-Z])/g, "$1 $2")}</dd>
            </div>
            {!!details.regions.length && (
              <div>
                <dt>Area</dt>
                <dd>{details.regions.join(", ")}</dd>
              </div>
            )}
            {details.coordinates && (
              <div>
                <dt>Coordinates</dt>
                <dd>
                  {details.coordinates[1].toFixed(6)},{" "}
                  {details.coordinates[0].toFixed(6)}
                </dd>
              </div>
            )}
            {details.edited !== null && (
              <div>
                <dt>Last edited</dt>
                <dd>
                  {editDate.format(new Date(details.edited * 1000))}
                  {details.version !== null && " · version " + details.version}
                </dd>
              </div>
            )}
          </dl>
        )}
        <div className="ax-object-tags-heading">
          <strong>OpenStreetMap tags</strong>
          {details && <span>{tags.length}</span>}
        </div>
        {error ? (
          <p role="status">{error}</p>
        ) : (
          !details && <p role="status">Loading object details…</p>
        )}
        <table
          className="gs-table"
          aria-label="OpenStreetMap tags for this feature"
        >
          <tbody>
            {tags.map(({ key, value }) => (
              <tr
                key={key}
                className={matching.get(key) === value ? "is-match" : undefined}
              >
                <th scope="row">
                  <code>{key}</code>
                </th>
                <td>
                  <code>{value || "(empty value)"}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ax-object-actions">
        {details && (
          <button
            className="ax-button gs-btn gs-btn--secondary"
            type="button"
            onClick={() => onZoom(details)}
          >
            <LocateFixed size={14} /> Zoom to feature
          </button>
        )}
        <a
          className="ax-example"
          href={
            "https://www.openstreetmap.org/" + object.kind + "/" + object.id
          }
          target="_blank"
          rel="noreferrer"
        >
          Open in OSM <ArrowUpRight size={14} />
        </a>
      </div>
    </aside>
  );
}

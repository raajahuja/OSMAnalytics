import { apiFetch, rememberDatasetVersion } from "./api";
import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  BarChart3,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  History,
  Map as MapIcon,
  Navigation,
  Search,
  Table2,
  X,
} from "lucide-react";
import AnalyticsFeatureMap, {
  mapLegend,
  overlapTone,
  type FeatureBounds,
  type TagFilter,
} from "./AnalyticsFeatureMap";
import AnalyticsFreshness from "./AnalyticsFreshness";
import AnalyticsTagRegions from "./AnalyticsTagRegions";
import "./analytics.css";

type Kind = "all" | "node" | "way" | "relation";
type Country = { id: string; name: string; division: string };
type Area = {
  id: string;
  name: string;
  bounds?: FeatureBounds;
  objects: Partial<Record<Exclude<Kind, "all">, number>>;
};
type Dataset = {
  version?: string;
  country: Country;
  snapshot: string;
  source: string;
  boundarySource: string;
  boundaryCredit: string;
  boundaryLicense: string;
  areas: Area[];
};
type TagRow = {
  key?: string;
  value?: string;
  count: number;
  distinct_values?: number;
  nodes: number;
  ways: number;
  relations: number;
  node_id?: number;
  way_id?: number;
  relation_id?: number;
};
type ValueDistribution = {
  top: { value: string; count: number }[];
  otherCount: number;
  otherValues: number;
};
type FilterMetrics = {
  keyCount: number;
  matchCount: number;
  keys: [string, number][];
  values: [string, string, number][];
};
type TagResults = {
  rows: TagRow[];
  total: number;
  page: number;
  pageSize: number;
  tag: { count: number; distinct_values: number } | null;
  distribution: ValueDistribution | null;
  comparison: Record<string, number> | null;
};

const kinds: { id: Kind; label: string }[] = [
  { id: "all", label: "All object types" },
  { id: "node", label: "Nodes" },
  { id: "way", label: "Ways" },
  { id: "relation", label: "Relations" },
];
const whole = new Intl.NumberFormat("en-GB");
const decimal = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeZone: "UTC",
});
const count = (n: number) => whole.format(n);
async function read<T>(
  url: string,
  signal: AbortSignal,
  form?: string,
): Promise<T> {
  const response = await apiFetch(url, signal, form);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not load analytics.");
  return body;
}

const exactValue = (value: string) => value || "(empty value)";
const chipColors = (tone: typeof overlapTone) =>
  ({
    "--chip-color": tone.label,
    "--chip-imagery": tone.aerial,
  }) as CSSProperties;

function ValueDistributionChart({
  area,
  values,
  toggleValue,
  present,
  distribution,
  error,
}: {
  area: Area;
  values: string[];
  toggleValue: (value: string) => void;
  present: number;
  distribution?: ValueDistribution | null;
  error: string;
}) {
  const valueBar = (value: string, amount: number) => {
    const share = (100 * amount) / present;
    return (
      <>
        <span>{value}</span>
        <strong>
          {count(amount)}{" "}
          <small>· {share < 0.01 ? "<0.01" : decimal.format(share)}%</small>
        </strong>
        <i aria-hidden="true">
          <b style={{ width: share + "%" }} />
        </i>
      </>
    );
  };

  return (
    <section className="ax-tag-visual" aria-label="Value distribution">
      <div className="ax-tag-visual-head">
        <div>
          <h4>
            <BarChart3 size={16} /> Value distribution
          </h4>
          <p>{area.name} · Share of objects with this key</p>
        </div>
      </div>
      {distribution ? (
        present > 0 ? (
          <>
            <div className="ax-value-bars">
              {distribution.top.map(({ value, count: amount }) => (
                <button
                  key={value}
                  className="ax-value-bar"
                  title={exactValue(value)}
                  aria-pressed={values.includes(value)}
                  onClick={() => toggleValue(value)}
                >
                  {valueBar(exactValue(value), amount)}
                </button>
              ))}
              {distribution.otherValues > 0 && (
                <div className="ax-value-bar ax-value-other">
                  {valueBar(
                    "Other values (" + count(distribution.otherValues) + ")",
                    distribution.otherCount,
                  )}
                </div>
              )}
            </div>
            <p className="ax-tag-visual-note">
              Select bars or values in the table to add or remove map filters.
            </p>
          </>
        ) : (
          <p className="ax-empty">
            No objects with this key in the selected scope.
          </p>
        )
      ) : (
        <p className="ax-empty" role="status">
          {error
            ? "Value distribution unavailable."
            : "Loading value distribution…"}
        </p>
      )}
    </section>
  );
}

function FeatureMapView({
  data,
  area,
  filters,
  filterParams,
  matchAll,
  setMatchAll,
  visible,
}: {
  data: Dataset;
  area: Area;
  filters: TagFilter[];
  filterParams: string;
  matchAll: boolean;
  setMatchAll: (match: boolean) => void;
  visible: boolean;
}) {
  return (
    <section
      className="gs-panel ax-panel ax-tag-geography"
      id="tag-geography"
      tabIndex={-1}
      aria-label="Feature map"
    >
      <h4 className="ax-visually-hidden">Map of matching features</h4>
      <div className="ax-geo-focus">
        <div className="ax-map-rules" aria-label="Applied tag filters">
          {mapLegend(filters).map(({ key, value, tone }) => {
            const rule =
              key + "=" + (value === undefined ? "*" : exactValue(value));
            return (
              <code
                className="ax-rule-chip gs-chip"
                key={JSON.stringify([key, value])}
                title={rule}
              >
                <i aria-hidden="true" style={chipColors(tone)} />
                <span>{rule}</span>
              </code>
            );
          })}
          {new URLSearchParams(filterParams).has("allKeys") && (
            <code className="ax-rule-chip gs-chip" title="Every mapped object">
              <i
                aria-hidden="true"
                style={chipColors(mapLegend([{ key: "", values: [] }])[0].tone)}
              />
              <span>All keys</span>
            </code>
          )}
          {filters.length > 1 && (
            <code
              className="ax-rule-chip gs-chip"
              title="Objects matching more than one selected key"
            >
              <i aria-hidden="true" style={chipColors(overlapTone)} />{" "}
              <span>Multiple matches</span>
            </code>
          )}
        </div>
        {filters.length > 1 && (
          <select
            className="gs-select"
            aria-label="Key matching"
            value={matchAll ? "all" : "any"}
            onChange={(event) => setMatchAll(event.target.value === "all")}
          >
            <option value="any">Match any key</option>
            <option value="all">Match all keys</option>
          </select>
        )}
      </div>
      {area.bounds ? (
        <AnalyticsFeatureMap
          country={data.country.id}
          bounds={area.bounds}
          selectedArea={area.id === "all" ? undefined : area.name}
          filterParams={filterParams}
          filters={filters}
          visible={visible}
        />
      ) : (
        <p className="ax-empty">
          Map geometry is unavailable. Run{" "}
          <code>npm run analytics:prepare</code> to prepare it.
        </p>
      )}
    </section>
  );
}

async function firstValue(
  country: string,
  region: string,
  kind: Kind,
  key: string,
  signal: AbortSignal,
) {
  const { rows } = await read<TagResults>(
    tagEndpoint(country, region, kind, "", "count", key) + "&view=options",
    signal,
  );
  return rows[0]?.value;
}

function TagPicker({
  country,
  region,
  kind,
  tagKey,
  selected,
  summary,
  metric,
  selectedMetrics,
  onToggle,
  onClear,
  onSelectAll,
  allSelected = false,
  keyOptions,
  onKeyChange,
  limitReached,
}: {
  country: string;
  region: string;
  kind: Kind;
  tagKey?: string;
  selected: string[];
  summary: string;
  metric?: number;
  selectedMetrics?: Map<string, number>;
  onToggle: (value: string) => void;
  onClear?: () => void;
  onSelectAll: () => void;
  allSelected?: boolean;
  keyOptions?: string[];
  onKeyChange?: (key: string) => void;
  limitReached: boolean;
}) {
  const valueMode = keyOptions !== undefined;
  const label = valueMode ? "Tag value" : "Tag key";
  const enabled = !valueMode || tagKey !== undefined;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popupId = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [paging, setPaging] = useState({ query: "", page: 1 });
  const [response, setResponse] = useState<{
    url: string;
    data?: TagResults;
    error?: string;
  }>();
  const query = tagEndpoint(country, region, kind, search, "count", tagKey);
  const page = paging.query === query ? paging.page : 1;
  const url = query + "&view=options&page=" + page;
  const close = () => {
    setOpen(false);
    setSearch("");
    setPaging({ query: "", page: 1 });
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      read<TagResults>(url, abort.signal)
        .then((data) => {
          if (!abort.signal.aborted) setResponse({ url, data });
        })
        .catch((error) => {
          if (!abort.signal.aborted) setResponse({ url, error: error.message });
        });
    }, 140);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [open, url]);

  const responseForUrl = response?.url === url ? response : undefined;
  const results = responseForUrl?.data;
  const pages = results ? Math.ceil(results.total / results.pageSize) : 0;
  const done = () => {
    close();
    trigger.current?.focus();
  };
  return (
    <div
      className="ax-picker"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close();
          trigger.current?.focus();
        }
      }}
    >
      <span>{label}</span>
      <button
        ref={trigger}
        type="button"
        className="ax-picker-trigger gs-btn gs-btn--secondary"
        aria-label={
          label +
          ": " +
          summary +
          (metric === undefined ? "" : ", " + count(metric) + " objects")
        }
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        title={summary}
        disabled={!enabled}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <code>{summary}</code>
        {metric !== undefined && (
          <strong
            className="ax-picker-count gs-badge gs-num"
            title={
              valueMode
                ? "Distinct objects matching keys and values"
                : "Distinct objects matching keys before values"
            }
          >
            {count(metric)}
          </strong>
        )}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="ax-picker-popup gs-popover" id={popupId}>
          {valueMode && keyOptions.length > 1 && (
            <label className="ax-picker-key-option">
              Values for
              <select
                className="gs-select"
                value={tagKey}
                onChange={(event) => {
                  onKeyChange?.(event.target.value);
                  setSearch("");
                  setPaging({ query: "", page: 1 });
                }}
              >
                {keyOptions.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="ax-picker-actions">
            <span>
              {allSelected
                ? "All " + label.replace("Tag ", "") + "s"
                : count(selected.length) + " selected"}
            </span>
            <button
              type="button"
              className="ax-text-button"
              onClick={onSelectAll}
              disabled={allSelected}
            >
              Select all
            </button>
            {onClear && (
              <button
                type="button"
                className="ax-text-button"
                onClick={onClear}
                disabled={!selected.length && !allSelected}
              >
                Clear
              </button>
            )}
            <button
              type="button"
              className="ax-button gs-btn gs-btn--secondary"
              onClick={done}
            >
              Done
            </button>
          </div>
          {!!selected.length && (
            <div className="ax-picker-selections">
              {selected.map((item) => (
                <button
                  type="button"
                  key={item}
                  title={exactValue(item)}
                  aria-label={"Remove " + exactValue(item)}
                  disabled={valueMode && selected.length === 1}
                  onClick={() => onToggle(item)}
                >
                  <code>{exactValue(item)}</code>
                  {selectedMetrics?.has(item) && (
                    <small>{count(selectedMetrics.get(item)!)}</small>
                  )}
                  {!(valueMode && selected.length === 1) && <X size={12} />}
                </button>
              ))}
            </div>
          )}
          <label className="ax-tag-search">
            <span>
              <Search size={15} />
              <input
                className="gs-input"
                autoFocus
                aria-label={"Search " + label.toLowerCase() + "s"}
                placeholder={
                  tagKey === undefined
                    ? "Search keys, e.g. barrier"
                    : "Search exact values"
                }
                value={search}
                maxLength={255}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPaging({ query: "", page: 1 });
                }}
              />
            </span>
          </label>
          <div className="ax-picker-list" key={url}>
            {results?.rows.map((row) => {
              const option = tagKey === undefined ? row.key : row.value;
              return (
                option !== undefined && (
                  <button
                    type="button"
                    key={option}
                    role="checkbox"
                    aria-checked={allSelected || selected.includes(option)}
                    disabled={limitReached && !selected.includes(option)}
                    onClick={() => onToggle(option)}
                  >
                    <span className="ax-picker-check" aria-hidden="true">
                      {(allSelected || selected.includes(option)) && (
                        <Check size={12} />
                      )}
                    </span>
                    <code>{exactValue(option)}</code>
                    <small>{count(row.count)}</small>
                  </button>
                )
              );
            })}
            {responseForUrl?.error ? (
              <p role="alert">{responseForUrl.error}</p>
            ) : !results ? (
              <p role="status">Loading…</p>
            ) : (
              !results.total && <p>No matching {label.toLowerCase()}s.</p>
            )}
          </div>
          {limitReached && (
            <p className="ax-picker-limit">
              Selection limit reached. Clear an option to add another.
            </p>
          )}
          {results && (
            <div className="ax-page">
              <span>{count(results.total)} matches</span>
              <div>
                {tagKey === undefined && (
                  <a
                    className="ax-example"
                    href={query + "&format=csv"}
                    download
                    title="Export tag keys"
                  >
                    <ArrowDownToLine size={14} />
                  </a>
                )}
                <button
                  type="button"
                  aria-label="Previous filter page"
                  disabled={results.page <= 1}
                  onClick={() => setPaging({ query, page: results.page - 1 })}
                >
                  <ChevronLeft size={15} />
                </button>
                <button
                  type="button"
                  aria-label="Next filter page"
                  disabled={results.page >= pages}
                  onClick={() => setPaging({ query, page: results.page + 1 })}
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function tagEndpoint(
  country: string,
  region: string,
  kind: Kind,
  search: string,
  sort: string,
  key?: string,
) {
  const params = new URLSearchParams({ region, kind, q: search.trim(), sort });
  if (key !== undefined) params.set("key", key);
  return "/api/analytics/" + country + "/tags?" + params;
}

function TagDetails({
  data,
  area,
  active,
  filters,
  filterParams,
  kind,
  toggleValue,
  onAnalysisKey,
  matchAll,
  setMatchAll,
  view,
  onRegion,
}: {
  data: Dataset;
  area: Area;
  active?: TagFilter;
  filters: TagFilter[];
  filterParams: string;
  kind: Kind;
  toggleValue: (value: string) => void;
  onAnalysisKey: (key: string) => void;
  matchAll: boolean;
  setMatchAll: (match: boolean) => void;
  view: "map" | "table" | "freshness";
  onRegion: (id: string) => void;
}) {
  const selectedKey = active?.key;
  const values = active?.values ?? [];
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("count");
  const [paging, setPaging] = useState({ query: "", page: 1 });
  const [mapVisited, setMapVisited] = useState(view === "map");
  useEffect(() => {
    if (view === "map") setMapVisited(true);
  }, [view]);
  useEffect(() => {
    setSearch("");
    setSort("count");
    setPaging({ query: "", page: 1 });
  }, [selectedKey]);
  const [response, setResponse] = useState<{
    table: string;
    scope: string;
    results: TagResults;
  } | null>(null);
  const [error, setError] = useState("");
  const endpoint = tagEndpoint(
    data.country.id,
    area.id,
    kind,
    search,
    sort,
    selectedKey,
  );
  const page = paging.query === endpoint ? paging.page : 1;
  const setPage = (next: number) => setPaging({ query: endpoint, page: next });
  const table = endpoint + "&page=" + page;
  const scope = JSON.stringify([area.id, kind, selectedKey]);
  const [requestUrl, tableQuery] = table.split("?");
  const detailParams = new URLSearchParams(tableQuery);
  for (const value of values) detailParams.append("focus", value);
  const requestForm = detailParams.toString();
  useEffect(() => {
    if (view !== "table" || selectedKey === undefined) return;
    const abort = new AbortController();
    setError("");
    const timer = setTimeout(() => {
      read<TagResults>(requestUrl, abort.signal, requestForm)
        .then((results) => {
          if (!abort.signal.aborted) setResponse({ table, scope, results });
        })
        .catch((error) => {
          if (!abort.signal.aborted) setError(error.message);
        });
    }, 140);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [table, scope, requestUrl, requestForm, selectedKey, view]);
  const results = response?.table === table ? response.results : null;
  const chart = response?.scope === scope ? response.results : null;
  const pages = results
    ? Math.max(1, Math.ceil(results.total / results.pageSize))
    : 1;
  const present = chart?.tag?.count ?? 0;

  return (
    <div className="ax-map-dashboard">
      {(view === "map" || mapVisited) && (
        <div hidden={view !== "map"}>
          <FeatureMapView
            data={data}
            area={area}
            filters={filters}
            filterParams={filterParams}
            matchAll={matchAll}
            setMatchAll={setMatchAll}
            visible={view === "map"}
          />
        </div>
      )}
      {view === "table" && !active && (
        <p className="gs-panel ax-panel ax-empty">
          Choose a tag key to see its values in the table.
        </p>
      )}
      {view === "table" && active && (
        <section className="gs-panel ax-panel ax-tag-panel" id="tag-details">
          <div className="ax-tag-table-layout">
            <div className="ax-tag-table-content">
              <div className="ax-tag-table-head">
                <h4>Exact tag values</h4>
                <p>Select a value to update the shared filters.</p>
              </div>
              <div className="ax-tag-filters">
                <label className="ax-tag-search">
                  Search values
                  <span>
                    <Search size={16} />
                    <input
                      className="gs-input"
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value);
                        setPage(1);
                      }}
                      placeholder="Filter exact tag values…"
                      maxLength={255}
                    />
                  </span>
                </label>
                <label>
                  Sort by
                  <select
                    className="gs-select"
                    value={sort}
                    onChange={(e) => {
                      setSort(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="count">Most objects</option>
                    <option value="name">Alphabetical</option>
                  </select>
                </label>
                <div className="ax-analysis-actions">
                  {filters.length > 1 && (
                    <label>
                      Analyze key
                      <select
                        className="gs-select"
                        value={selectedKey}
                        onChange={(event) => onAnalysisKey(event.target.value)}
                      >
                        {filters.map(({ key }) => (
                          <option key={key} value={key}>
                            {key}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <a
                    className="ax-button gs-btn gs-btn--secondary"
                    href={endpoint + "&format=csv"}
                    download
                  >
                    <ArrowDownToLine size={16} /> Export CSV
                  </a>
                </div>
              </div>
              {error && (
                <p className="ax-empty" role="alert">
                  {error}
                </p>
              )}
              {!error && !results && (
                <p className="ax-empty" role="status">
                  Loading tag counts…
                </p>
              )}
              {results && (
                <>
                  <div
                    className="ax-table-scroll"
                    role="region"
                    aria-label="Exact tag value results"
                    tabIndex={0}
                  >
                    <table className="gs-table">
                      <thead>
                        <tr>
                          <th>Tag value</th>
                          <th className="ax-number">Objects in filter</th>
                          <th className="ax-number">% with key</th>
                          <th className="ax-number">Nodes</th>
                          <th className="ax-number">Ways</th>
                          <th className="ax-number">Relations</th>
                          <th>Example</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.rows.map((row) => {
                          const value = row.value ?? "";
                          const sample =
                            kind === "all"
                              ? row.way_id
                                ? "way"
                                : row.node_id
                                  ? "node"
                                  : "relation"
                              : kind;
                          const id =
                            row[
                              (sample + "_id") as
                                "way_id" | "node_id" | "relation_id"
                            ];
                          return (
                            <tr
                              key={value}
                              className={
                                values.includes(value)
                                  ? "is-selected"
                                  : undefined
                              }
                            >
                              <td>
                                <button
                                  className="ax-text-button"
                                  aria-pressed={values.includes(value)}
                                  title="Toggle this value in the filters"
                                  onClick={() => toggleValue(value)}
                                >
                                  <code>{exactValue(value)}</code>
                                </button>
                              </td>
                              <td className="ax-number ax-emphasis">
                                {count(row.count)}
                              </td>
                              <td className="ax-number">
                                {decimal.format(
                                  present ? (100 * row.count) / present : 0,
                                )}
                                %
                              </td>
                              <td className="ax-number">{count(row.nodes)}</td>
                              <td className="ax-number">{count(row.ways)}</td>
                              <td className="ax-number">
                                {count(row.relations)}
                              </td>
                              <td>
                                {id ? (
                                  <a
                                    className="ax-example"
                                    href={
                                      "https://www.openstreetmap.org/" +
                                      sample +
                                      "/" +
                                      id
                                    }
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {sample} {id} <ArrowUpRight size={13} />
                                  </a>
                                ) : (
                                  "—"
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {!results.total && (
                    <p className="ax-empty">
                      No matching values for this selection.
                    </p>
                  )}
                  <div className="ax-page">
                    <span>{count(results.total)} matching values</span>
                    <div>
                      <button
                        aria-label="Previous page"
                        disabled={results.page <= 1}
                        onClick={() => setPage(results.page - 1)}
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <span>
                        Page {count(results.page)} of {count(pages)}
                      </span>
                      <button
                        aria-label="Next page"
                        disabled={results.page >= pages}
                        onClick={() => setPage(results.page + 1)}
                      >
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
            <ValueDistributionChart
              area={area}
              values={values}
              toggleValue={toggleValue}
              present={present}
              distribution={chart?.distribution}
              error={error}
            />
          </div>
          {data.areas.length > 1 && (
            <AnalyticsTagRegions
              country={data.country.id}
              tagKey={active.key}
              kind={kind}
              values={values}
              division={data.country.division}
              selectedRegion={area.id}
              onRegion={onRegion}
            />
          )}
        </section>
      )}
    </div>
  );
}

export default function Analytics() {
  const [countries, setCountries] = useState<Country[]>([]);
  const [publicSite, setPublicSite] = useState(false);
  const [country, setCountry] = useState("");
  const [data, setData] = useState<Dataset | null>(null);
  const [region, setRegion] = useState("all");
  const [view, setView] = useState<"map" | "table" | "freshness">("map");
  const [filters, setFilters] = useState<TagFilter[]>([]);
  const [allKeys, setAllKeys] = useState(false);
  const [analysisKey, setAnalysisKey] = useState("highway");
  const [kind, setKind] = useState<Kind>("all");
  const [matchAll, setMatchAll] = useState(false);
  const [metricResponse, setMetricResponse] = useState<
    { id: string } & FilterMetrics
  >();
  const [adjustedScope, setAdjustedScope] = useState("");
  const active = filters.find(({ key }) => key === analysisKey) ?? filters[0];
  const valuesSelected = filters.reduce(
    (sum, filter) => sum + filter.values.length,
    0,
  );
  const filterParams = new URLSearchParams({
    region,
    kind,
    filters: JSON.stringify(filters),
    match: matchAll ? "all" : "any",
    ...(allKeys ? { allKeys: "1" } : {}),
  }).toString();
  const metricsUrl = "/api/analytics/" + country + "/selection";
  const metricsId = metricsUrl + "?" + filterParams;
  const metrics = metricResponse?.id === metricsId ? metricResponse : undefined;
  const scopeId = [country, region, kind].join(":");
  useEffect(() => {
    if (!country || (!filters.length && !allKeys)) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      read<FilterMetrics>(metricsUrl, abort.signal, filterParams)
        .then(async (data) => {
          if (abort.signal.aborted) return;
          const available = new Map(data.keys);
          const exact = new Map(
            data.values.map(([key, value, amount]) => [
              JSON.stringify([key, value]),
              amount,
            ]),
          );
          const next = filters
            .filter(({ key }) => (available.get(key) ?? 0) > 0)
            .map(({ key, values }) => ({
              key,
              values: values.filter(
                (value) => (exact.get(JSON.stringify([key, value])) ?? 0) > 0,
              ),
            }));
          // A value missing from this area falls back to the area's most
          // common value, because an empty list would mean every value.
          await Promise.all(
            next
              .filter(
                ({ key, values }) =>
                  !values.length &&
                  filters.some(
                    (rule) => rule.key === key && rule.values.length,
                  ),
              )
              .map(async (rule) => {
                const first = await firstValue(
                  country,
                  region,
                  kind,
                  rule.key,
                  abort.signal,
                );
                if (first !== undefined) rule.values = [first];
              }),
          );
          if (abort.signal.aborted) return;
          if (JSON.stringify(next) !== JSON.stringify(filters)) {
            setFilters((current) => (current === filters ? next : current));
            setAdjustedScope(scopeId);
          }
          setMetricResponse({ id: metricsId, ...data });
        })
        .catch(() => {});
    }, 140);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [country, filters, allKeys, filterParams, metricsUrl, metricsId, scopeId]);

  // Each country opens on roads, narrowed to its most common road type.
  useEffect(() => {
    if (!country) return;
    const abort = new AbortController();
    firstValue(country, "all", "all", "highway", abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return;
        setFilters(
          value === undefined ? [] : [{ key: "highway", values: [value] }],
        );
        setAnalysisKey("highway");
      })
      .catch(() => {});
    return () => abort.abort();
  }, [country]);

  // Keys still waiting for their first value, and the country they were
  // chosen in, so quick clicks or a country change can't overshoot.
  const pendingKeys = useRef(new Set<string>());
  const currentCountry = useRef(country);
  currentCountry.current = country;
  useEffect(() => pendingKeys.current.clear(), [country]);
  const toggleKey = (key: string) => {
    setAdjustedScope("");
    if (filters.some((rule) => rule.key === key)) {
      pendingKeys.current.delete(key);
      setFilters((current) => current.filter((rule) => rule.key !== key));
      return;
    }
    if (pendingKeys.current.has(key)) return;
    if (filters.length + pendingKeys.current.size >= 12) return;
    // The first key starts on its most common value. Later keys start on all
    // values, since two most common values rarely occur on one object.
    if (filters.length || pendingKeys.current.size) {
      setAllKeys(false);
      setFilters((current) =>
        current.length >= 12 || current.some((rule) => rule.key === key)
          ? current
          : [...current, { key, values: [] }],
      );
      setAnalysisKey(key);
      return;
    }
    const requested = country;
    pendingKeys.current.add(key);
    firstValue(country, area?.id ?? "all", kind, key, AbortSignal.timeout(8000))
      .catch(() => undefined)
      .then((value) => {
        if (!pendingKeys.current.delete(key)) return;
        if (currentCountry.current !== requested) return;
        setAllKeys(false);
        setFilters((current) => {
          if (current.length >= 12 || current.some((rule) => rule.key === key))
            return current;
          const chosen = current.reduce(
            (sum, rule) => sum + rule.values.length,
            0,
          );
          const values =
            value === undefined || chosen >= 40 || current.length ? [] : [value];
          return [...current, { key, values }];
        });
        setAnalysisKey(key);
      });
  };
  const updateValues = (key: string, change: (values: string[]) => string[]) =>
    setFilters((current) =>
      current.map((rule) =>
        rule.key === key ? { key, values: change(rule.values) } : rule,
      ),
    );
  const toggleValue = (value: string) => {
    setAdjustedScope("");
    if (!active) return;
    updateValues(active.key, (values) =>
      values.includes(value)
        ? // No values means "all values", so the last one stays selected.
          values.length === 1
          ? values
          : values.filter((item) => item !== value)
        : valuesSelected < 40
          ? [...values, value]
          : values,
    );
  };
  const [error, setError] = useState("");
  const [noCountries, setNoCountries] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    document.title = "Wayfinder — OpenStreetMap Analytics";
    read<{ publicSite: boolean }>("/api/config", abort.signal)
      .then((config) => setPublicSite(config.publicSite))
      .catch(() => {});
    read<Country[]>("/api/analytics", abort.signal)
      .then((items) => {
        setCountries(items);
        setCountry(items[0]?.id || "");
        setNoCountries(!items.length);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(error.message);
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!country) return;
    const abort = new AbortController();
    setError("");
    read<Dataset>("/api/analytics/" + country, abort.signal)
      .then((loaded) => {
        rememberDatasetVersion(country, loaded.version);
        setData(loaded);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(error.message);
      });
    return () => abort.abort();
  }, [country]);
  const dataset = data?.country.id === country ? data : null;
  const area = dataset?.areas.find((entry) => entry.id === region);
  const changeRegion = (id: string) => {
    const next = dataset?.areas.find((entry) => entry.id === id);
    if (kind !== "all" && next && !next.objects[kind]) setKind("all");
    setAdjustedScope("");
    setRegion(id);
  };
  return (
    <div className="ax-app">
      <header className="ax-header">
        <div className="ax-header-inner gs-appbar">
          <a
            className="ax-brand gs-brand"
            href="/"
            aria-label="Wayfinder analytics home"
          >
            <span className="gs-brand-mark">
              <Navigation size={15} fill="currentColor" />
            </span>
            <span className="gs-brand-title">Wayfinder</span>
          </a>
          <h1>OpenStreetMap analytics</h1>
          {!publicSite && (
            <a
              className="gs-btn gs-btn--secondary gs-btn--sm"
              href="/countries"
            >
              Countries
            </a>
          )}
          {dataset && (
            <div className="ax-dashboard-tools gs-appbar-actions">
              <span className="ax-snapshot gs-meta">
                <Database size={15} /> Snapshot ·{" "}
                {dataset.snapshot
                  ? date.format(new Date(dataset.snapshot)) + " UTC"
                  : "Date unavailable"}
              </span>
              <div
                className="ax-view-switch gs-segmented"
                role="group"
                aria-label="Analytics view"
              >
                <button
                  className="gs-segment"
                  aria-pressed={view === "map"}
                  onClick={() => setView("map")}
                >
                  <MapIcon size={16} /> Map view
                </button>
                <button
                  className="gs-segment"
                  aria-pressed={view === "table"}
                  onClick={() => setView("table")}
                >
                  <Table2 size={16} /> Table view
                </button>
                <button
                  className="gs-segment"
                  aria-pressed={view === "freshness"}
                  onClick={() => setView("freshness")}
                >
                  <History size={16} /> Freshness
                </button>
              </div>
            </div>
          )}
        </div>
      </header>
      <main className="ax-main">
        {error && (
          <div className="gs-panel ax-panel ax-empty" role="alert">
            {error}
          </div>
        )}
        {noCountries && (
          <div className="gs-panel ax-panel ax-empty" role="status">
            {publicSite ? (
              "No countries are available yet."
            ) : (
              <>
                No countries yet. Open <a href="/countries">Countries</a> to
                download and build one. A small country such as Luxembourg
                takes a few minutes.
              </>
            )}
          </div>
        )}
        {!error && !noCountries && !dataset && (
          <div className="gs-panel ax-panel ax-empty" role="status">
            Loading analytics dataset…
          </div>
        )}
        {dataset && area && (
          <>
            <div className="ax-filter-band ax-map-filter-band">
              <div className="ax-geography">
                <label>
                  Country
                  <select
                    className="gs-select"
                    value={country}
                    onChange={(e) => {
                      setCountry(e.target.value);
                      setRegion("all");
                      setFilters([]);
                      setAllKeys(false);
                      setMatchAll(false);
                    }}
                  >
                    {countries.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {dataset.country.division}
                  <select
                    className="gs-select"
                    value={region}
                    onChange={(e) => changeRegion(e.target.value)}
                  >
                    <option value="all">
                      All {dataset.country.division.toLowerCase()}s
                    </option>
                    {dataset.areas
                      .filter((entry) => entry.id !== "all")
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <TagPicker
                country={country}
                region={area.id}
                kind={kind}
                selected={filters.map(({ key }) => key)}
                summary={
                  allKeys
                    ? "All keys"
                    : filters.length > 1
                      ? exactValue(filters[0].key) + " +" + (filters.length - 1)
                      : filters.length
                        ? exactValue(filters[0].key)
                        : "Choose tag keys"
                }
                metric={metrics?.keyCount}
                selectedMetrics={metrics && new Map(metrics.keys)}
                onToggle={toggleKey}
                onClear={() => {
                  setAllKeys(false);
                  setFilters([]);
                }}
                onSelectAll={() => {
                  setAdjustedScope("");
                  setAllKeys(true);
                  setFilters([]);
                }}
                allSelected={allKeys}
                limitReached={filters.length >= 12}
              />
              <TagPicker
                country={country}
                region={area.id}
                kind={kind}
                tagKey={active?.key}
                keyOptions={filters.map(({ key }) => key)}
                onKeyChange={setAnalysisKey}
                selected={active?.values ?? []}
                summary={
                  // Describes the key whose values the picker shows.
                  (active?.values.length ?? 0) > 1
                    ? count(active!.values.length) + " values"
                    : active?.values.length === 1
                      ? exactValue(active.values[0])
                      : "All values"
                }
                metric={metrics?.matchCount}
                selectedMetrics={
                  metrics &&
                  new Map(
                    metrics.values
                      .filter(([key]) => key === active?.key)
                      .map(([, value, amount]) => [value, amount]),
                  )
                }
                onToggle={toggleValue}
                onSelectAll={() => {
                  setAdjustedScope("");
                  if (active) updateValues(active.key, () => []);
                }}
                allSelected={!active?.values.length}
                limitReached={valuesSelected >= 40}
              />
              <label>
                Object type
                <select
                  className="gs-select"
                  value={kind}
                  onChange={(event) => {
                    setAdjustedScope("");
                    setKind(event.target.value as Kind);
                  }}
                >
                  {kinds.map((item) => (
                    <option
                      key={item.id}
                      value={item.id}
                      disabled={item.id !== "all" && !area.objects[item.id]}
                    >
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              {adjustedScope === scopeId && (
                <p className="ax-filter-adjustment" role="status">
                  Selections unavailable in {area.name} for this object type
                  were cleared.
                </p>
              )}
            </div>
            <TagDetails
              key={country}
              data={dataset}
              area={area}
              active={active}
              filters={filters}
              filterParams={filterParams}
              kind={kind}
              toggleValue={toggleValue}
              onAnalysisKey={setAnalysisKey}
              matchAll={matchAll}
              setMatchAll={setMatchAll}
              view={view}
              onRegion={changeRegion}
            />
            {view === "freshness" &&
              area?.bounds &&
              !filters.length &&
              !allKeys && (
                <section className="gs-panel ax-panel ax-freshness">
                  <p className="ax-empty" role="status">
                    Choose tag keys, or select all keys, to see how recently
                    those objects were edited.
                  </p>
                </section>
              )}
            {view === "freshness" &&
              area?.bounds &&
              (filters.length > 0 || allKeys) && (
              <AnalyticsFreshness
                key={"freshness-" + country}
                country={country}
                region={region}
                bounds={area.bounds}
                areaName={area.name}
                filterParams={filterParams}
                onRegion={changeRegion}
              />
            )}

            <footer className="ax-footer">
              <span className="ax-footer-brand">
                Wayfinder <span>OpenStreetMap analytics</span>
              </span>
              <ul className="ax-footer-credits" aria-label="Data sources">
                <li>
                  <span>Map data</span>
                  <a
                    href="https://www.openstreetmap.org/copyright"
                    target="_blank"
                    rel="noreferrer"
                  >
                    © OpenStreetMap contributors
                  </a>
                </li>
                <li>
                  <span>Source</span>
                  <a href={dataset.source} target="_blank" rel="noreferrer">
                    Geofabrik extract
                  </a>
                </li>
                <li>
                  <span>Boundaries</span>
                  <p>
                    {dataset.boundaryCredit} ·{" "}
                    <a
                      href={dataset.boundarySource}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {dataset.boundaryLicense}
                    </a>
                  </p>
                </li>
              </ul>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

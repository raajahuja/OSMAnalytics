import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Download,
  Hammer,
  Minus,
  Navigation,
  Pause,
  Play,
  Search,
  Square,
  Terminal,
  X,
} from "lucide-react";
import "./analytics.css";
import "./countries.css";

type Step =
  | "up-to-date"
  | "refresh"
  | "build"
  | "download-and-build"
  | "too-large"
  | "unavailable";

interface DownloadJob {
  code: string;
  name: string;
  state:
    | "queued"
    | "downloading"
    | "verifying"
    | "paused"
    | "done"
    | "failed"
    | "cancelled";
  receivedBytes: number;
  totalBytes: number | null;
  error: string | null;
  bytesPerSecond: number;
}

interface LogEntry {
  id: number;
  atMs: number;
  name: string;
  text: string;
  level: "info" | "success" | "warning" | "error";
}

type Control = (code: string, action: "" | "/pause" | "/stop") => void;
type BuildControl = (code: string, action: "" | "/stop") => void;

interface BuildJob {
  code: string;
  name: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  stage: "regions" | "building" | "checking" | "publishing" | null;
  error: string | null;
  elapsedSeconds: number;
  expectedSeconds: number | null;
}

interface CountryStatus {
  code: string;
  download: DownloadJob | null;
  downloadFits: boolean;
  build: BuildJob | null;
  canBuild: boolean;
  name: string;
  website: {
    name: string;
    continent: string;
    shared: boolean;
    bytes: number | null;
    modifiedMs: number | null;
  } | null;
  downloaded: { bytes: number; modifiedMs: number } | null;
  app: {
    bytes: number;
    builtMs: number;
    snapshot: string | null;
    unreadable?: boolean;
  } | null;
  updateAvailable: boolean;
  estimate: {
    memoryBytes: number;
    diskBytes: number;
    seconds: number;
    fits: boolean;
    limit: "memory" | "disk" | null;
  } | null;
  nextStep: Step;
}

interface CountriesResponse {
  catalog: {
    loaded: boolean;
    checkedMs: number | null;
    checking: boolean;
    done: number;
    total: number;
    error: string | null;
  };
  downloads: { active: boolean; jobs: DownloadJob[]; log: LogEntry[] };
  builds: { active: boolean; jobs: BuildJob[] };
  machine: { memoryBytes: number; freeDiskBytes: number };
  countries: CountryStatus[];
}

const isInProgress = (job: DownloadJob | null) =>
  job?.state === "queued" ||
  job?.state === "downloading" ||
  job?.state === "verifying" ||
  job?.state === "paused";

function percent(job: DownloadJob) {
  if (!job.totalBytes) return null;
  return Math.min(100, Math.floor((job.receivedBytes / job.totalBytes) * 100));
}

// What the list shows instead of the next step while a download is under way.
function jobLabel(job: DownloadJob | null) {
  if (job?.state === "queued") return "Waiting";
  if (job?.state === "verifying") return "Checking file";
  if (job?.state === "downloading") {
    const done = percent(job);
    return done === null ? "Downloading" : "Downloading " + done + "%";
  }
  if (job?.state === "paused") {
    const done = percent(job);
    return done === null ? "Paused" : "Paused at " + done + "%";
  }
  if (job?.state === "failed") return "Download failed";
  return null;
}

const isBuilding = (job: BuildJob | null) =>
  job?.state === "queued" || job?.state === "running";

const BUILD_STAGES = {
  regions: "Finding regions",
  building: "Building database",
  checking: "Checking result",
  publishing: "Going live",
};

function buildLabel(job: BuildJob | null) {
  if (job?.state === "queued") return "Waiting to build";
  if (job?.state === "running")
    return job.stage ? BUILD_STAGES[job.stage] : "Building";
  if (job?.state === "failed") return "Build failed";
  return null;
}

function formatClock(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return minutes + ":" + String(seconds % 60).padStart(2, "0");
}

function buildDetail(job: BuildJob) {
  if (job.state === "queued") return "";
  const expected = job.expectedSeconds
    ? " · " + formatDuration(job.expectedSeconds).toLowerCase() + " expected"
    : "";
  return formatClock(job.elapsedSeconds) + " elapsed" + expected;
}

function JobButtons({
  job,
  control,
  compact = false,
}: {
  job: DownloadJob;
  control: Control;
  compact?: boolean;
}) {
  const className = compact
    ? "gs-icon-btn cy-icon"
    : "gs-btn gs-btn--secondary gs-btn--sm";
  const button = (
    label: string,
    icon: ReactNode,
    action: "" | "/pause" | "/stop",
    disabled = false,
  ) => (
    <button
      className={className}
      aria-label={label + " " + job.name}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        control(job.code, action);
      }}
    >
      {icon} {!compact && label}
    </button>
  );
  return (
    <span className="cy-job-buttons">
      {job.state === "paused"
        ? button("Resume", <Play size={14} />, "")
        : job.state !== "queued" &&
          button(
            "Pause",
            <Pause size={14} />,
            "/pause",
            job.state === "verifying",
          )}
      {button(
        "Stop",
        <Square size={13} />,
        "/stop",
        job.state === "verifying",
      )}
    </span>
  );
}

function jobDetail(job: DownloadJob) {
  const parts: string[] = [];
  if (job.totalBytes)
    parts.push(
      formatBytes(job.receivedBytes) + " of " + formatBytes(job.totalBytes),
    );
  if (job.state === "downloading" && job.bytesPerSecond > 0) {
    parts.push(formatBytes(job.bytesPerSecond) + "/s");
    if (job.totalBytes) {
      const left = Math.ceil(
        (job.totalBytes - job.receivedBytes) / job.bytesPerSecond,
      );
      parts.push(
        left < 60 ? left + " s left" : Math.ceil(left / 60) + " min left",
      );
    }
  }
  return parts.join(" · ");
}

const clock = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function DownloadConsole({
  jobs,
  builds,
  log,
  control,
  buildControl,
}: {
  jobs: DownloadJob[];
  builds: BuildJob[];
  log: LogEntry[];
  control: Control;
  buildControl: BuildControl;
}) {
  const [open, setOpen] = useState(true);
  const logBox = useRef<HTMLOListElement>(null);
  const lastEntry = log.at(-1)?.id;
  useEffect(() => {
    if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [lastEntry, open]);

  const running = jobs.filter((job) => job.state === "downloading").length;
  const waiting = jobs.filter((job) => job.state === "queued").length;
  const paused = jobs.filter((job) => job.state === "paused").length;
  const summary = [
    running && running + " running",
    waiting && waiting + " waiting",
    paused && paused + " paused",
    builds.length && builds.length + " building",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="gs-panel cy-console" aria-label="Activity console">
      <button
        className="cy-console-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Terminal size={14} aria-hidden="true" />
        <strong>Activity</strong>
        <span className="gs-meta">{summary || "Nothing running"}</span>
        <span className="gs-meta cy-console-toggle">
          {open ? "Hide" : "Show"}
        </span>
      </button>
      {open && (
        <div className="cy-console-body">
          <div className="cy-jobs">
            {jobs.length + builds.length === 0 && (
              <p className="cy-muted">
                Use the buttons on any country to download or build it.
              </p>
            )}
            {builds.map((job) => (
              <div className="cy-job" key={"build-" + job.code}>
                <div className="cy-job-line">
                  <strong>{job.name}</strong>
                  <span className="cy-step cy-step--job-downloading">
                    {buildLabel(job)}
                  </span>
                  <span className="cy-job-buttons">
                    <button
                      className="gs-btn gs-btn--secondary gs-btn--sm"
                      aria-label={"Stop building " + job.name}
                      disabled={job.stage === "publishing"}
                      onClick={() => buildControl(job.code, "/stop")}
                    >
                      <Square size={13} /> Stop
                    </button>
                  </span>
                </div>
                <p className="gs-meta">{buildDetail(job)}</p>
              </div>
            ))}
            {jobs.map((job) => (
              <div className="cy-job" key={job.code}>
                <div className="cy-job-line">
                  <strong>{job.name}</strong>
                  <span className={"cy-step cy-step--job-" + job.state}>
                    {jobLabel(job)}
                  </span>
                  <JobButtons job={job} control={control} />
                </div>
                <div className="cy-bar" aria-hidden="true">
                  <span style={{ width: (percent(job) ?? 0) + "%" }} />
                </div>
                <p className="gs-meta">{jobDetail(job)}</p>
              </div>
            ))}
          </div>
          <ol className="cy-log" ref={logBox} aria-label="Download log">
            {log.length === 0 && (
              <li className="cy-muted">Download activity appears here.</li>
            )}
            {log.map((entry) => (
              <li key={entry.id} className={"cy-log--" + entry.level}>
                <time>{clock.format(new Date(entry.atMs))}</time>
                <b>{entry.name}</b> {entry.text}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

// The action at the end of a list row: start, or control a running download.
function RowAction({
  country,
  control,
  buildControl,
}: {
  country: CountryStatus;
  control: Control;
  buildControl: BuildControl;
}) {
  const { download, downloaded, updateAvailable, website } = country;
  if (isBuilding(country.build))
    return (
      <button
        className="gs-icon-btn cy-icon"
        aria-label={"Stop building " + country.name}
        title="Stop build"
        disabled={country.build?.stage === "publishing"}
        onClick={(event) => {
          event.stopPropagation();
          buildControl(country.code, "/stop");
        }}
      >
        <Square size={13} />
      </button>
    );
  if (isInProgress(download))
    return <JobButtons job={download as DownloadJob} control={control} compact />;
  if (!website) return null;
  if (
    country.canBuild &&
    (country.nextStep === "build" || country.build?.state === "failed")
  )
    return (
      <button
        className="gs-icon-btn cy-icon cy-icon--start"
        aria-label={"Build " + country.name}
        title="Build"
        onClick={(event) => {
          event.stopPropagation();
          buildControl(country.code, "");
        }}
      >
        <Hammer size={15} />
      </button>
    );
  const failed = download?.state === "failed";
  if (downloaded && !updateAvailable && !failed) return null;
  const label = failed
    ? "Try again"
    : updateAvailable
      ? "Download update"
      : "Download";
  return (
    <button
      className="gs-icon-btn cy-icon cy-icon--start"
      aria-label={label + " " + country.name}
      title={country.downloadFits ? label : "Not enough free disk space"}
      disabled={!country.downloadFits}
      onClick={(event) => {
        event.stopPropagation();
        control(country.code, "");
      }}
    >
      <Download size={15} />
    </button>
  );
}

const STATUS_VIEWS: [string, string, (c: CountryStatus) => boolean][] = [
  ["all", "All countries", () => true],
  ["app", "In app", (c) => Boolean(c.app)],
  ["downloaded", "On this computer", (c) => Boolean(c.downloaded)],
  ["updates", "Updates available", (c) => c.updateAvailable],
];
const NO_DOWNLOAD = "none";
const isOffered = (view: string) => view.startsWith("continent:");

const STEP_LABELS: Record<Step, string> = {
  "up-to-date": "Up to date",
  refresh: "Refresh",
  build: "Build",
  "download-and-build": "Download and build",
  "too-large": "Too large",
  unavailable: "Not available",
};

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const formatDate = (value: number | string) =>
  dateFormat.format(new Date(value));

function formatBytes(bytes: number) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0) + " MB";
  return Math.max(1, Math.round(bytes / 1e3)) + " KB";
}

function formatDuration(seconds: number) {
  if (seconds < 90) return "About a minute";
  if (seconds < 3600) return "About " + Math.round(seconds / 60) + " minutes";
  const hours = seconds / 3600;
  return "About " + (hours < 10 ? hours.toFixed(1) : Math.round(hours)) + " hours";
}

function YesNo({ value }: { value: boolean }) {
  return value ? (
    <span className="cy-yes">
      <Check size={15} aria-hidden="true" />
      <span className="cy-hidden">Yes</span>
    </span>
  ) : (
    <span className="cy-no">
      <Minus size={15} aria-hidden="true" />
      <span className="cy-hidden">No</span>
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cy-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function DownloadControl({
  country,
  actionError,
  control,
}: {
  country: CountryStatus;
  actionError: string;
  control: Control;
}) {
  const { download, downloaded, updateAvailable, website } = country;
  if (!website) return null;

  if (isInProgress(download)) {
    const job = download as DownloadJob;
    return (
      <div className="cy-action" role="status">
        <p>{jobLabel(job)}</p>
        <div className="cy-bar" aria-hidden="true">
          <span style={{ width: (percent(job) ?? 0) + "%" }} />
        </div>
        <p className="gs-meta">{jobDetail(job)}</p>
        <JobButtons job={job} control={control} />
      </div>
    );
  }

  const failed = download?.state === "failed";
  const label = failed
    ? "Try again"
    : !downloaded
      ? "Download"
      : updateAvailable
        ? "Download update"
        : "Download again";
  return (
    <div className="cy-action">
      <button
        className={
          "gs-btn gs-btn--sm " +
          (!downloaded || updateAvailable || failed
            ? "gs-btn--primary"
            : "gs-btn--secondary")
        }
        disabled={!country.downloadFits}
        onClick={() => control(country.code, "")}
      >
        <Download size={15} /> {label}
        {website.bytes && " · " + formatBytes(website.bytes)}
      </button>
      {!country.downloadFits && (
        <p className="cy-problem">There isn't enough free disk space.</p>
      )}
      {failed && <p className="cy-problem">{download?.error}</p>}
      {actionError && <p className="cy-problem">{actionError}</p>}
      {download?.state === "done" && (
        <p className="cy-done" role="status">
          Download complete and verified.
        </p>
      )}
    </div>
  );
}

function BuildPanel({
  country,
  buildControl,
}: {
  country: CountryStatus;
  buildControl: BuildControl;
}) {
  const { build, downloaded, app, nextStep, canBuild } = country;
  if (!downloaded) return null;
  if (isBuilding(build)) {
    const job = build as BuildJob;
    return (
      <div className="cy-action" role="status">
        <p>{buildLabel(job)}</p>
        <p className="gs-meta">{buildDetail(job)}</p>
        <button
          className="gs-btn gs-btn--secondary gs-btn--sm"
          disabled={job.stage === "publishing"}
          onClick={() => buildControl(job.code, "/stop")}
        >
          <Square size={13} /> Stop build
        </button>
      </div>
    );
  }
  const failed = build?.state === "failed";
  return (
    <div className="cy-action">
      <button
        className={
          "gs-btn gs-btn--sm " +
          (nextStep === "build" || failed
            ? "gs-btn--primary"
            : "gs-btn--secondary")
        }
        disabled={!canBuild}
        onClick={() => buildControl(country.code, "")}
      >
        <Hammer size={15} /> {failed ? "Try build again" : app ? "Rebuild" : "Build"}
      </button>
      {failed && <p className="cy-problem">{build?.error}</p>}
      {build?.state === "done" && (
        <p className="cy-done" role="status">
          Built. <a href="/">Open the map</a> and choose {country.name}.
        </p>
      )}
    </div>
  );
}

function Details({
  country,
  actionError,
  control,
  buildControl,
  onClose,
}: {
  country: CountryStatus;
  actionError: string;
  control: Control;
  buildControl: BuildControl;
  onClose: () => void;
}) {
  const { website, downloaded, app, estimate, nextStep } = country;
  return (
    <>
      <div className="cy-detail-head">
        <div>
          <h2>{country.name}</h2>
          {website && <p className="gs-meta">{website.continent}</p>}
        </div>
        <button
          className="gs-icon-btn cy-close"
          aria-label="Close details"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>

      <DownloadControl
        country={country}
        actionError={actionError}
        control={control}
      />
      <BuildPanel country={country} buildControl={buildControl} />

      <h3>On website</h3>
      {website ? (
        <dl>
          <Fact label="File size">
            {website.bytes ? formatBytes(website.bytes) : "Unknown"}
          </Fact>
          {website.modifiedMs && (
            <Fact label="Updated">{formatDate(website.modifiedMs)}</Fact>
          )}
          {website.shared && <Fact label="Shared file">{website.name}</Fact>}
        </dl>
      ) : (
        <p className="cy-muted">No separate download for this country.</p>
      )}

      <h3>On this computer</h3>
      {downloaded ? (
        <dl>
          <Fact label="Downloaded">{formatDate(downloaded.modifiedMs)}</Fact>
          <Fact label="File size">{formatBytes(downloaded.bytes)}</Fact>
        </dl>
      ) : (
        <p className="cy-muted">Not downloaded.</p>
      )}

      <h3>In app</h3>
      {app?.unreadable ? (
        <p className="cy-problem">The database can't be read.</p>
      ) : app ? (
        <dl>
          {app.snapshot && (
            <Fact label="Data from">{formatDate(app.snapshot)}</Fact>
          )}
          <Fact label="Database">{formatBytes(app.bytes)}</Fact>
        </dl>
      ) : (
        <p className="cy-muted">Not in the app yet.</p>
      )}

      <h3>Next step</h3>
      <p className={"cy-step cy-step--" + nextStep}>{STEP_LABELS[nextStep]}</p>
      {country.updateAvailable && (
        <p className="gs-meta">Newer data is on the website.</p>
      )}
      {estimate && nextStep !== "up-to-date" && (
        <dl>
          <Fact label="Build time">{formatDuration(estimate.seconds)}</Fact>
          <Fact label="Memory needed">{formatBytes(estimate.memoryBytes)}</Fact>
          <Fact label="Disk needed">{formatBytes(estimate.diskBytes)}</Fact>
        </dl>
      )}
      {estimate && nextStep === "too-large" && (
        <p className="cy-problem">
          This Mac doesn't have enough{" "}
          {estimate.limit === "disk" ? "free disk" : "memory"} to build it.
        </p>
      )}
    </>
  );
}

export default function Countries() {
  const [data, setData] = useState<CountriesResponse | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [reloads, setReloads] = useState(0);

  const send = async (code: string, path: string) => {
    setActionError("");
    try {
      const response = await fetch("/api/countries/" + code + path, {
        method: "POST",
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || "That didn't work. Try again.");
      }
    } catch (failure) {
      setActionError(
        failure instanceof Error ? failure.message : "That didn't work.",
      );
    }
    setReloads((count) => count + 1);
  };
  const control: Control = (code, action) => send(code, "/download" + action);
  const buildControl: BuildControl = (code, action) =>
    send(code, "/build" + action);

  useEffect(() => {
    document.title = "Countries — Wayfinder";
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch("/api/countries", {
          signal: abort.signal,
        });
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error || "Could not load the country list.");
        setData(body);
        setError("");
        if (body.downloads.active || body.builds.active)
          timer = setTimeout(load, 1000);
        else if (body.catalog.checking) timer = setTimeout(load, 2000);
      } catch (failure) {
        if (!abort.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load the country list.",
          );
      }
    };
    load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [reloads]);

  const countries = data?.countries ?? [];

  const menu = useMemo(() => {
    const continents = new Map<string, number>();
    for (const { website } of countries)
      if (website)
        continents.set(
          website.continent,
          (continents.get(website.continent) ?? 0) + 1,
        );
    return {
      status: STATUS_VIEWS.map(([id, label, matches]) => ({
        id,
        label,
        count: countries.filter(matches).length,
      })),
      places: [
        ...[...continents.entries()]
          .sort(([a], [b]) => a.localeCompare(b, "en"))
          .map(([name, count]) => ({
            id: "continent:" + name,
            label: name,
            count,
          })),
        {
          id: NO_DOWNLOAD,
          label: "No download",
          count: countries.filter((c) => !c.website).length,
        },
      ],
    };
  }, [countries]);

  const term = search.trim().toLocaleLowerCase("en");
  const rows = useMemo(() => {
    // A search always covers every country, so a match is never hidden by the menu.
    if (term)
      return countries.filter((c) =>
        c.name.toLocaleLowerCase("en").includes(term),
      );
    if (view === NO_DOWNLOAD) return countries.filter((c) => !c.website);
    if (isOffered(view)) {
      const continent = view.slice("continent:".length);
      return countries.filter((c) => c.website?.continent === continent);
    }
    const matches = STATUS_VIEWS.find(([id]) => id === view)?.[2];
    return matches ? countries.filter(matches) : countries;
  }, [countries, term, view]);

  const current = countries.find((c) => c.code === selected) ?? null;
  const catalog = data?.catalog;
  const allViews = [...menu.status, ...menu.places];
  const viewLabel = allViews.find((item) => item.id === view)?.label;

  const menuButton = (item: { id: string; label: string; count: number }) => (
    <li key={item.id}>
      <button
        aria-current={view === item.id && !term ? "true" : undefined}
        onClick={() => {
          setView(item.id);
          setSearch("");
        }}
      >
        <span>{item.label}</span>
        <span className="gs-num">{item.count}</span>
      </button>
    </li>
  );

  return (
    <div className="ax-app cy-page">
      <header className="ax-header">
        <div className="ax-header-inner gs-appbar">
          <a
            className="ax-brand gs-brand cy-brand"
            href="/"
            aria-label="Wayfinder analytics home"
          >
            <span className="gs-brand-mark">
              <Navigation size={15} fill="currentColor" />
            </span>
            <span className="gs-brand-title">Wayfinder</span>
          </a>
          <h1>Countries</h1>
          <div className="gs-appbar-actions">
            <a className="gs-btn gs-btn--secondary gs-btn--sm" href="/">
              <ArrowLeft size={15} /> Back to map
            </a>
          </div>
        </div>
      </header>

      <main className="cy-main">
        {error && !data && (
          <div className="gs-panel cy-message" role="alert">
            {error}
          </div>
        )}
        {!error && !data && (
          <div className="gs-panel cy-message" role="status">
            Loading countries…
          </div>
        )}
        {catalog?.error && (
          <div className="gs-panel cy-message cy-warning" role="alert">
            {catalog.loaded
              ? "Couldn't check the website, so this shows the last known details."
              : "Couldn't reach the website. Showing only what's on this computer."}
          </div>
        )}
        {data && (
          <div className="cy-layout">
            <nav className="gs-panel cy-menu" aria-label="Country groups">
              <ul>{menu.status.map(menuButton)}</ul>
              <h2>Continents</h2>
              <ul>{menu.places.map(menuButton)}</ul>
            </nav>

            <section className="gs-panel cy-list" aria-label="Countries">
              <div className="cy-toolbar">
                <label className="cy-search">
                  <Search size={15} aria-hidden="true" />
                  <input
                    className="gs-input"
                    type="search"
                    placeholder="Search all countries"
                    aria-label="Search all countries"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </label>
                <label className="cy-picker">
                  <span className="cy-hidden">Country group</span>
                  <select
                    className="gs-select"
                    value={view}
                    onChange={(event) => {
                      setView(event.target.value);
                      setSearch("");
                    }}
                  >
                    {allViews.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label} ({item.count})
                      </option>
                    ))}
                  </select>
                </label>
                <p className="gs-meta cy-count" role="status">
                  {rows.length} {term ? "matches" : viewLabel}
                  {" · "}
                  {catalog?.checking
                    ? catalog.total
                      ? "Checking website " + catalog.done + "/" + catalog.total
                      : "Checking website"
                    : catalog?.checkedMs
                      ? "Website checked " + formatDate(catalog.checkedMs)
                      : "Website not checked"}
                </p>
              </div>

              <div className="cy-scroll">
                {rows.length === 0 ? (
                  <p className="cy-message cy-muted">No countries here.</p>
                ) : (
                  <table className="cy-table">
                    <thead>
                      <tr>
                        <th scope="col">Country</th>
                        <th scope="col" className="cy-right">
                          On website
                        </th>
                        <th scope="col" className="cy-center">
                          On computer
                        </th>
                        <th scope="col" className="cy-center">
                          In app
                        </th>
                        <th scope="col" className="cy-next">
                          Next step
                        </th>
                        <th scope="col" className="cy-row-action">
                          Action
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((country) => (
                        <tr
                          key={country.code}
                          aria-selected={country.code === selected}
                          onClick={() => {
                            setSelected(country.code);
                            setActionError("");
                          }}
                        >
                          <th scope="row">
                            <button>
                              {country.name}
                            </button>
                          </th>
                          <td className="cy-right gs-num">
                            {country.website?.bytes ? (
                              formatBytes(country.website.bytes)
                            ) : (
                              <span className="cy-muted">
                                {country.website ? "…" : "None"}
                              </span>
                            )}
                          </td>
                          <td className="cy-center">
                            <YesNo value={Boolean(country.downloaded)} />
                          </td>
                          <td className="cy-center">
                            <YesNo value={Boolean(country.app)} />
                          </td>
                          <td className="cy-next">
                            <span
                              className={
                                "cy-step cy-step--" +
                                (country.build?.state === "failed"
                                  ? "job-failed"
                                  : buildLabel(country.build)
                                    ? "job-downloading"
                                    : jobLabel(country.download)
                                      ? "job-" + country.download?.state
                                      : country.nextStep)
                              }
                            >
                              {buildLabel(country.build) ??
                                jobLabel(country.download) ??
                                STEP_LABELS[country.nextStep]}
                            </span>
                          </td>
                          <td className="cy-row-action">
                            <RowAction
                              country={country}
                              control={control}
                              buildControl={buildControl}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>

            <aside
              className={"gs-panel cy-detail" + (current ? " cy-detail--open" : "")}
              aria-label="Country details"
            >
              {current ? (
                <Details
                  country={current}
                  actionError={actionError}
                  control={control}
                  buildControl={buildControl}
                  onClose={() => setSelected(null)}
                />
              ) : (
                <div className="cy-placeholder">
                  <p>Select a country to see its details.</p>
                  <h3>This computer</h3>
                  <dl>
                    <Fact label="Memory">
                      {formatBytes(data.machine.memoryBytes)}
                    </Fact>
                    <Fact label="Free disk">
                      {formatBytes(data.machine.freeDiskBytes)}
                    </Fact>
                  </dl>
                </div>
              )}
            </aside>
          </div>
        )}
        {data && (
          <DownloadConsole
            jobs={data.downloads.jobs}
            builds={data.builds.jobs}
            log={data.downloads.log}
            control={control}
            buildControl={buildControl}
          />
        )}
      </main>
    </div>
  );
}

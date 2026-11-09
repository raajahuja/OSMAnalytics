// Browsers and CDNs can't cache POST, so requests are GET unless the filters
// are too long for a URL.
const maxUrlLength = 6000;
const versions = new Map<string, string>();

// A rebuilt dataset has a new version, which changes every request URL.
export function rememberDatasetVersion(country: string, version?: string) {
  if (version) versions.set(country, version);
}

export const datasetVersion = (country: string) => versions.get(country);

function versioned(url: string) {
  const country = /^\/api\/analytics\/([A-Z]{2})\//.exec(url)?.[1];
  const version = country && versions.get(country);
  if (!version) return url;
  return url + (url.includes("?") ? "&" : "?") + "v=" + version;
}

export function apiFetch(
  url: string,
  signal: AbortSignal,
  form?: URLSearchParams | string,
) {
  const query = form === undefined ? "" : new URLSearchParams(form).toString();
  if (url.length + query.length >= maxUrlLength)
    return fetch(url, {
      signal,
      method: "POST",
      body: new URLSearchParams(query),
    });
  const target = query ? url + (url.includes("?") ? "&" : "?") + query : url;
  return fetch(versioned(target), { signal });
}

// Whole cells are used so that small pans reuse the same request, for this
// user and for anyone else looking at the same area.
export function snapBounds(
  [west, south, east, north]: [number, number, number, number],
  zoom: number,
) {
  const cell = 180 / 2 ** Math.floor(zoom);
  const down = (value: number) => Math.floor(value / cell) * cell;
  const up = (value: number) => Math.ceil(value / cell) * cell;
  return [
    down(west),
    Math.max(-90, down(south)),
    up(east),
    Math.min(90, up(north)),
  ]
    .map((value) => Number(value.toFixed(7)))
    .join(",");
}

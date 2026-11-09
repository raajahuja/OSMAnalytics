import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const origin =
  "https://wmts1.geoportail.lu/opendata/wmts/ortho_2025/GLOBAL_WEBMERCATOR_4_V3/";
const extent = [5.72009158, 49.4379598, 6.54617072, 50.18501989];
const pending = new Map();

export function tileRange(z) {
  const n = 2 ** z;
  const x = (lon) => Math.floor(((lon + 180) / 360) * n);
  const y = (lat) =>
    Math.floor(
      ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n,
    );
  return [x(extent[0]), y(extent[3]), x(extent[2]), y(extent[1])];
}

async function getTile(path, z, x, y) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const upstream = await fetch(
    origin + String(z).padStart(2, "0") + "/" + x + "/" + y + ".jpeg",
    {
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    },
  );
  if (
    !upstream.ok ||
    !upstream.headers.get("content-type")?.startsWith("image/jpeg")
  ) {
    await upstream.body?.cancel();
    throw Error("No imagery tile");
  }
  const tile = Buffer.from(await upstream.arrayBuffer());
  if (tile.length > 1024 * 1024 || tile[0] !== 0xff || tile[1] !== 0xd8)
    throw Error("Invalid imagery tile");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, tile);
  return tile;
}

export async function serveImagery(res, directory, z, x, y) {
  if (z < 7 || z > 19) {
    res.writeHead(404).end();
    return;
  }
  const [west, north, east, south] = tileRange(z);
  if (x < west || x > east || y < north || y > south) {
    res.writeHead(404).end();
    return;
  }
  const path = join(
    directory,
    "LU-ortho-2025",
    String(z),
    String(x),
    y + ".jpeg",
  );
  if (!pending.has(path))
    pending.set(
      path,
      getTile(path, z, x, y).finally(() => pending.delete(path)),
    );
  try {
    const tile = await pending.get(path);
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": tile.length,
      "Cache-Control": "public, max-age=604800",
    });
    res.end(tile);
  } catch {
    res.writeHead(502, { "Cache-Control": "no-store" });
    res.end();
  }
}

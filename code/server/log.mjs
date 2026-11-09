// One JSON object per line, so a log collector can filter on any field.
// Client addresses are left out on purpose.
export function logEvent(level, event, fields = {}) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else console.log(line);
}

export function logError(event, error, fields = {}) {
  logEvent("error", event, {
    ...fields,
    message: error?.message ?? String(error),
    stack: error?.stack,
  });
}

// Records each response once it has finished or the client has gone away.
export function logRequests(req, res, pathname) {
  const started = performance.now();
  res.once("close", () =>
    logEvent("info", "request", {
      method: req.method,
      path: pathname,
      status: res.statusCode,
      ms: Math.round(performance.now() - started),
      completed: res.writableFinished,
    }),
  );
}

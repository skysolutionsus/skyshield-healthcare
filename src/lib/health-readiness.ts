export type MinimalHealthResponse = {
  status: "ok" | "degraded";
  readiness: "ready" | "not_ready";
  timestamp: string;
};

export function buildMinimalHealthResponse(
  ready: boolean,
  now: Date = new Date()
): MinimalHealthResponse {
  return {
    status: ready ? "ok" : "degraded",
    readiness: ready ? "ready" : "not_ready",
    timestamp: now.toISOString(),
  };
}

export function healthReadinessStatusCode(ready: boolean): 200 | 503 {
  return ready ? 200 : 503;
}

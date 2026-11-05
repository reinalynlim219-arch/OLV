// Real road distances and driving times between map points, from an OSRM routing
// server (free, built on OpenStreetMap roads). Only map coordinates are sent, never
// names or addresses. Results are kept for 30 minutes, because the delivery plan
// refreshes every few seconds. When the server cannot be reached, matrix() returns
// null and the caller uses straight-line distance instead, so the plan never breaks.
//
// ROUTING_URL in .env chooses the server; set it empty to always use straight lines.
const DEFAULT_URL = "https://router.project-osrm.org";
const KEEP_MS = 30 * 60 * 1000;
// After a failure the server is not asked again for 2 minutes (ROUTING_RETRY_MS changes it, for tests).
const retryAfterFailureMs = () => Number.isFinite(Number(process.env.ROUTING_RETRY_MS)) && process.env.ROUTING_RETRY_MS !== "" ? Number(process.env.ROUTING_RETRY_MS) : 2 * 60 * 1000;
const MAX_POINTS = 100;

module.exports = function roadDistances({ timeoutMs = 5000 } = {}) {
    const cache = new Map();   // points key -> { at, result }
    const pending = new Map(); // points key -> Promise, so parallel plan requests share one call
    let downUntil = 0;

    const baseUrl = () => String(process.env.ROUTING_URL ?? DEFAULT_URL).trim().replace(/\/+$/, "");
    const keyOf = points => points.map(p => `${Number(p.lng).toFixed(6)},${Number(p.lat).toFixed(6)}`).join(";");

    async function fetchMatrix(base, key) {
        try {
            const response = await fetch(`${base}/table/v1/driving/${key}?annotations=distance,duration`, { signal: AbortSignal.timeout(timeoutMs) });
            const data = await response.json();
            if (!response.ok || data.code !== "Ok" || !Array.isArray(data.distances)) throw new Error(data.message || `routing server answered ${response.status}`);
            const result = { distances: data.distances, durations: data.durations || null };
            cache.set(key, { at: Date.now(), result });
            return result;
        } catch (error) {
            downUntil = Date.now() + retryAfterFailureMs();
            console.error("Road distances unavailable, using straight-line distance:", error.message);
            return null;
        }
    }

    // points: [{ lat, lng }]. Returns { distances[i][j] (meters), durations[i][j] (seconds) } or null.
    async function matrix(points) {
        const base = baseUrl();
        if (!base || points.length < 2 || points.length > MAX_POINTS) return null;
        const key = keyOf(points);
        const kept = cache.get(key);
        if (kept && Date.now() - kept.at < KEEP_MS) return kept.result;
        if (Date.now() < downUntil) return null;
        if (!pending.has(key)) pending.set(key, fetchMatrix(base, key).finally(() => pending.delete(key)));
        return pending.get(key);
    }

    return { matrix, keyOf };
};

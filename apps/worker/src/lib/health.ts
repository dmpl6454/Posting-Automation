import http from "node:http";
import { runServiceHealthChecks } from "../workers/auto-healer.worker";

interface WorkerInfo {
  name: string;
  status: "running" | "stopped";
}

interface ServiceHealth {
  name: string;
  status: "ok" | "error";
  latencyMs: number;
  error?: string;
}

interface HealthResponse {
  status: "ok" | "degraded" | "error";
  workers: WorkerInfo[];
  services?: ServiceHealth[];
  uptime: number;
  timestamp: string;
}

const startTime = Date.now();

// Registry of active workers; callers push entries before calling startHealthServer()
const registeredWorkers: WorkerInfo[] = [];

// Cached service checks (refreshed every 60s, not on every request)
let cachedServiceChecks: ServiceHealth[] = [];
let lastServiceCheck = 0;
const SERVICE_CHECK_INTERVAL = 60_000;

export function registerWorker(name: string): void {
  registeredWorkers.push({ name, status: "running" });
}

export function markWorkerStopped(name: string): void {
  const worker = registeredWorkers.find((w) => w.name === name);
  if (worker) {
    worker.status = "stopped";
  }
}

export function startHealthServer(): http.Server {
  const port = parseInt(process.env.HEALTH_PORT || "3001", 10);

  const server = http.createServer(async (req, res) => {
    const allRunning = registeredWorkers.length > 0 && registeredWorkers.every((w) => w.status === "running");

    // Refresh service checks if stale
    const now = Date.now();
    const isDeepCheck = req.url === "/health/deep";
    if (isDeepCheck || now - lastServiceCheck > SERVICE_CHECK_INTERVAL) {
      try {
        cachedServiceChecks = await runServiceHealthChecks();
        lastServiceCheck = now;
      } catch {
        // Non-blocking — keep cached results
      }
    }

    const servicesHealthy = cachedServiceChecks.length === 0 || cachedServiceChecks.every((s) => s.status === "ok");

    let status: "ok" | "degraded" | "error";
    if (!allRunning) status = "error";
    else if (!servicesHealthy) status = "degraded";
    else status = "ok";

    const response: HealthResponse = {
      status,
      workers: registeredWorkers,
      services: cachedServiceChecks.length > 0 ? cachedServiceChecks : undefined,
      uptime: Math.floor((now - startTime) / 1000),
      timestamp: new Date().toISOString(),
    };

    const statusCode = status === "ok" ? 200 : status === "degraded" ? 200 : 503;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });

  server.listen(port, () => {
    console.log(`  - Health check server listening on port ${port}`);
  });

  return server;
}

import http from "node:http";

interface WorkerInfo {
  name: string;
  status: "running" | "stopped";
}

interface HealthResponse {
  status: "ok" | "error";
  workers: WorkerInfo[];
  uptime: number;
  timestamp: string;
}

const startTime = Date.now();

// Registry of active workers; callers push entries before calling startHealthServer()
const registeredWorkers: WorkerInfo[] = [];

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

  const server = http.createServer((_req, res) => {
    const allRunning = registeredWorkers.length > 0 && registeredWorkers.every((w) => w.status === "running");

    const response: HealthResponse = {
      status: allRunning ? "ok" : "error",
      workers: registeredWorkers,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    };

    const statusCode = allRunning ? 200 : 503;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });

  server.listen(port, () => {
    console.log(`  - Health check server listening on port ${port}`);
  });

  return server;
}

import { NextResponse } from "next/server";
import { prisma } from "@postautomation/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface HealthCheck {
  status: "ok" | "error" | "skipped";
  latencyMs?: number;
  error?: string;
}

interface HealthResponse {
  status: "ok" | "degraded" | "down";
  checks: {
    database: HealthCheck;
    redis: HealthCheck;
  };
  timestamp: string;
  uptime: number;
  version: string;
}

const startTime = Date.now();

async function checkDatabase(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown database error";
    return { status: "error", latencyMs: Date.now() - start, error: message };
  }
}

async function checkRedis(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

    // Parse Redis URL to do a basic TCP connectivity check
    // This avoids a hard dependency on ioredis in the web app
    const url = new URL(redisUrl);
    const host = url.hostname || "localhost";
    const port = parseInt(url.port || "6379", 10);

    // Use Node.js net module for a simple TCP ping
    const net = await import("net");
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host, port, timeout: 3000 }, () => {
        // Send Redis PING command (RESP protocol)
        socket.write("*1\r\n$4\r\nPING\r\n");
      });

      socket.on("data", (data) => {
        const response = data.toString().trim();
        socket.destroy();
        resolve(response.includes("PONG"));
      });

      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });

      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (!connected) {
      return { status: "error", latencyMs: Date.now() - start, error: "Redis not responding" };
    }
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown Redis error";
    return { status: "error", latencyMs: Date.now() - start, error: message };
  }
}

export async function GET() {
  const [database, redis] = await Promise.all([
    checkDatabase(),
    checkRedis(),
  ]);

  const allOk = database.status === "ok" && redis.status === "ok";
  const allDown = database.status === "error" && redis.status === "error";

  let status: HealthResponse["status"];
  if (allOk) {
    status = "ok";
  } else if (allDown) {
    status = "down";
  } else {
    status = "degraded";
  }

  const response: HealthResponse = {
    status,
    checks: { database, redis },
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: process.env.npm_package_version || "0.0.1",
  };

  return NextResponse.json(response, {
    status: status === "ok" ? 200 : 503,
    headers: {
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PUBLISH_HEARTBEAT_KEY } from "../../../../packages/queue/src/publishing-health";

/**
 * Source locks for the 2026-11-12 "posting never silently stops" work. A
 * deploy shipped a worker that crash-looped for ~33h while every check was
 * green; these keep the pieces that would have caught it from being removed.
 */
const root = path.join(__dirname, "../../../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

describe("publishing heartbeat", () => {
  it("the scheduled-post scan writes it only after a completed scan", () => {
    const src = read("apps/worker/src/scheduler/cron-jobs.ts");
    const fn = src.slice(src.indexOf("export async function publishScheduledPosts"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    const hb = body.indexOf("recordPublishHeartbeat(redisConnection)");
    expect(hb).toBeGreaterThan(0);
    expect(hb).toBeGreaterThan(body.indexOf("for (let batch"));
    expect(hb).toBeLessThan(body.indexOf("} finally {"));
  });
});

describe("deploy.sh worker gate", () => {
  const sh = read("scripts/deploy.sh");
  const fnBody = (name: string) => {
    const start = sh.indexOf(`${name}() {`);
    return sh.slice(start, sh.indexOf("\n}\n", start));
  };

  it("deploy saves the running worker image before building and gates after restarting", () => {
    const deploy = fnBody("cmd_deploy");
    expect(deploy.indexOf("save_worker_rollback_image")).toBeGreaterThan(-1);
    expect(deploy.indexOf("save_worker_rollback_image")).toBeLessThan(deploy.indexOf("build web worker migrate"));
    expect(deploy.indexOf("gate_worker")).toBeGreaterThan(deploy.indexOf("--timeout \"$WORKER_STOP_TIMEOUT\" worker"));
  });

  it("rollback is gated too", () => {
    expect(fnBody("cmd_rollback")).toContain("gate_worker");
  });

  it("the gate requires zero restarts and a heartbeat newer than the container start", () => {
    const v = fnBody("verify_worker");
    expect(v).toContain("RestartCount");
    expect(v).toContain("read_publish_heartbeat");
    expect(v).toMatch(/"\$hb" -ge "\$started_ms"/);
  });

  it("a failed gate restores the previous worker image and fails the deploy", () => {
    const g = fnBody("gate_worker");
    expect(g).toContain('docker tag "$WORKER_ROLLBACK_IMAGE" "$WORKER_IMAGE_REF"');
    expect(g).toContain("--force-recreate");
    expect(g).toMatch(/error "Deploy FAILED/);
  });

  it("reads the same key the worker writes", () => {
    expect(fnBody("read_publish_heartbeat")).toContain(`GET ${PUBLISH_HEARTBEAT_KEY}`);
  });

  it("the redis password is passed by env, never argv", () => {
    expect(fnBody("read_publish_heartbeat")).toContain("REDISCLI_AUTH");
    expect(sh).not.toMatch(/redis-cli -a "\$/);
  });
});

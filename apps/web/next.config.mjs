import { execSync } from "child_process";

function getGitInfo() {
  // BUG-14: in the Docker build there is no `git` binary, so the shell-out
  // below throws and we'd fall back to "unknown"/"1.0.0-dev" — which is what
  // the Versions page showed in production. deploy.sh passes the real values
  // as build args (Dockerfile.web → BUILD_* env), so prefer those first.
  const env = process.env;
  if (env.BUILD_COMMIT_HASH && env.BUILD_COMMIT_HASH !== "unknown") {
    return {
      version: env.BUILD_APP_VERSION || "1.0.0",
      commitHash: env.BUILD_COMMIT_HASH,
      commitDate: env.BUILD_COMMIT_DATE || new Date().toISOString(),
      branch: env.BUILD_BRANCH || "main",
      commitMsg: env.BUILD_COMMIT_MSG || "",
    };
  }

  try {
    const commitHash = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
    const commitDate = execSync("git log -1 --format=%cI", { encoding: "utf-8" }).trim();
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
    const commitMsg = execSync("git log -1 --format=%s", { encoding: "utf-8" }).trim();
    // Count commits for auto version number
    const commitCount = execSync("git rev-list --count HEAD", { encoding: "utf-8" }).trim();
    const version = `1.0.${commitCount}`;
    return { version, commitHash, commitDate, branch, commitMsg };
  } catch {
    return {
      version: "1.0.0-dev",
      commitHash: "unknown",
      commitDate: new Date().toISOString(),
      branch: "unknown",
      commitMsg: "local build",
    };
  }
}

const gitInfo = getGitInfo();

/** @type {import('next').NextConfig} */
const nextConfig = {
  // BUG-17: stop advertising the framework via the X-Powered-By: Next.js header.
  poweredByHeader: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: gitInfo.version,
    NEXT_PUBLIC_COMMIT_HASH: gitInfo.commitHash,
    NEXT_PUBLIC_COMMIT_DATE: gitInfo.commitDate,
    NEXT_PUBLIC_BRANCH: gitInfo.branch,
    NEXT_PUBLIC_COMMIT_MSG: gitInfo.commitMsg,
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  // DEV ONLY (ignored by `next build`). Next keeps just ~5 compiled routes in
  // memory and disposes them after ~60s idle, so clicking around a dashboard
  // this size means constantly recompiling pages you visited a minute ago —
  // measured as multi-second waits on routes that were already built. Hold more
  // of them, for longer.
  onDemandEntries: {
    maxInactiveAge: 30 * 60 * 1000,
    pagesBufferLength: 32,
  },
  transpilePackages: [
    "@postautomation/api",
    "@postautomation/db",
    "@postautomation/auth",
  ],
  experimental: {
    // Runs instrumentation.ts at server start (Sentry, 2026-11-10). Next 14
    // still gates the hook behind this flag.
    instrumentationHook: true,
    // @sentry/node is OpenTelemetry + require-in-the-middle, which must load
    // from node_modules rather than be bundled.
    serverComponentsExternalPackages: ["@prisma/client", "prisma", "puppeteer", "puppeteer-core", "ioredis", "@sentry/node", "@sentry/opentelemetry", "@opentelemetry/instrumentation", "require-in-the-middle", "import-in-the-middle"],
    serverActions: {
      bodySizeLimit: "500mb",
    },
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(config.externals || []), "puppeteer", "puppeteer-core"];
    }
    return config;
  },
  // Security headers
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: process.env.APP_URL || "http://localhost:3000" },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization" },
          { key: "Access-Control-Max-Age", value: "86400" },
        ],
      },
    ];
  },
};

export default nextConfig;

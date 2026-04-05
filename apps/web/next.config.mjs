import { execSync } from "child_process";

function getGitInfo() {
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
  env: {
    NEXT_PUBLIC_APP_VERSION: gitInfo.version,
    NEXT_PUBLIC_COMMIT_HASH: gitInfo.commitHash,
    NEXT_PUBLIC_COMMIT_DATE: gitInfo.commitDate,
    NEXT_PUBLIC_BRANCH: gitInfo.branch,
    NEXT_PUBLIC_COMMIT_MSG: gitInfo.commitMsg,
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
  transpilePackages: [
    "@postautomation/api",
    "@postautomation/db",
    "@postautomation/auth",
  ],
  experimental: {
    serverComponentsExternalPackages: ["@prisma/client", "prisma", "puppeteer", "puppeteer-core", "ioredis"],
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

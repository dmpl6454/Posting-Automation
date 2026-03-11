/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@postautomation/api",
    "@postautomation/db",
    "@postautomation/auth",
  ],
  experimental: {
    serverComponentsExternalPackages: ["@prisma/client", "prisma", "puppeteer", "puppeteer-core"],
  },
  serverExternalPackages: ["puppeteer", "puppeteer-core"],
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

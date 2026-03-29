import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    version: process.env.NEXT_PUBLIC_APP_VERSION || "1.0.0-dev",
    commitHash: process.env.NEXT_PUBLIC_COMMIT_HASH || "unknown",
    commitDate: process.env.NEXT_PUBLIC_COMMIT_DATE || "",
    branch: process.env.NEXT_PUBLIC_BRANCH || "unknown",
    commitMsg: process.env.NEXT_PUBLIC_COMMIT_MSG || "",
    buildTime: process.env.NEXT_PUBLIC_BUILD_TIME || "",
    nodeEnv: process.env.NODE_ENV,
  });
}

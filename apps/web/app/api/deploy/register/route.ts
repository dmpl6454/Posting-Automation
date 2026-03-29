import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@postautomation/db";

/**
 * POST /api/deploy/register
 * Called by CI/CD pipeline or deploy script to register a new deployment.
 * Requires DEPLOY_SECRET header for authentication.
 */
export async function POST(req: NextRequest) {
  // Authenticate with deploy secret
  const secret = req.headers.get("x-deploy-secret") || req.headers.get("authorization")?.replace("Bearer ", "");
  const expectedSecret = process.env.DEPLOY_SECRET;

  if (!expectedSecret || secret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { version, commitHash, commitMsg, branch, changelog, environment, metadata } = body;

    if (!version || !commitHash) {
      return NextResponse.json({ error: "version and commitHash are required" }, { status: 400 });
    }

    // Mark previous active deployments as superseded
    await (prisma as any).deployment.updateMany({
      where: { status: "active", environment: environment || "production" },
      data: { status: "superseded" },
    });

    // Create new deployment record
    const deployment = await (prisma as any).deployment.create({
      data: {
        version,
        commitHash,
        commitMsg: commitMsg || "",
        branch: branch || "main",
        changelog: changelog || null,
        environment: environment || "production",
        deployedBy: "ci",
        status: "active",
        metadata: metadata || undefined,
      },
    });

    return NextResponse.json({
      success: true,
      deployment: {
        id: deployment.id,
        version: deployment.version,
        commitHash: deployment.commitHash,
      },
    });
  } catch (err: any) {
    console.error("[Deploy Register] Error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

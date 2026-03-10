"use client";

import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import {
  Search,
  Download,
  ChevronDown,
  ChevronRight,
  Lock,
  Globe,
  FileJson,
  Code2,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types for rendering the docs
// ---------------------------------------------------------------------------
interface ProcedureDoc {
  name: string;
  type: "query" | "mutation";
  description: string;
  auth: "session" | "session+org" | "public";
  input?: Record<string, FieldDoc>;
  inputRequired?: string[];
  exampleInput?: Record<string, unknown>;
  exampleOutput?: Record<string, unknown> | unknown[];
}

interface FieldDoc {
  type: string;
  description?: string;
  required?: boolean;
  enum?: string[];
  default?: unknown;
}

interface RouterDoc {
  name: string;
  description: string;
  procedures: ProcedureDoc[];
}

// ---------------------------------------------------------------------------
// Documentation Data
// ---------------------------------------------------------------------------
const routers: RouterDoc[] = [
  {
    name: "user",
    description: "User profile and organization management",
    procedures: [
      {
        name: "me",
        type: "query",
        description: "Returns the authenticated user with organization memberships.",
        auth: "session",
        exampleOutput: {
          id: "clx123...",
          name: "Jane Doe",
          email: "jane@example.com",
          memberships: [{ role: "OWNER", organization: { name: "Acme", slug: "acme" } }],
        },
      },
      {
        name: "updateProfile",
        type: "mutation",
        description: "Update the current user's name or avatar image.",
        auth: "session",
        input: {
          name: { type: "string", description: "Display name" },
          image: { type: "string (URL)", description: "Avatar image URL" },
        },
        exampleInput: { name: "Jane Smith" },
      },
      {
        name: "createOrganization",
        type: "mutation",
        description: "Create a new organization. The current user becomes OWNER.",
        auth: "session",
        input: {
          name: { type: "string", required: true },
          slug: { type: "string", required: true, description: "URL-safe slug (lowercase, alphanumeric, hyphens)" },
        },
        inputRequired: ["name", "slug"],
        exampleInput: { name: "Acme Corp", slug: "acme-corp" },
      },
    ],
  },
  {
    name: "post",
    description: "Post creation, scheduling, and management",
    procedures: [
      {
        name: "list",
        type: "query",
        description: "List posts for the organization with optional status filter and pagination.",
        auth: "session+org",
        input: {
          status: { type: "string", enum: ["DRAFT", "SCHEDULED", "PUBLISHING", "PUBLISHED", "FAILED", "CANCELLED"] },
          limit: { type: "integer", default: 20, description: "1-100" },
          cursor: { type: "string", description: "Cursor for pagination" },
        },
        exampleInput: { status: "DRAFT", limit: 10 },
        exampleOutput: { posts: ["..."], nextCursor: "clx456..." },
      },
      {
        name: "getById",
        type: "query",
        description: "Get a single post by ID with targets, media, and tags.",
        auth: "session+org",
        input: { id: { type: "string", required: true } },
        inputRequired: ["id"],
      },
      {
        name: "create",
        type: "mutation",
        description: "Create a new post with content, channels, optional schedule, media, tags, and AI metadata.",
        auth: "session+org",
        input: {
          content: { type: "string", required: true },
          channelIds: { type: "string[]", required: true, description: "At least one channel ID" },
          scheduledAt: { type: "string (ISO 8601)", description: "Schedule date-time" },
          mediaIds: { type: "string[]", description: "Media attachment IDs" },
          tags: { type: "string[]", description: "Post tags" },
          aiGenerated: { type: "boolean", default: false },
          aiProvider: { type: "string" },
          aiPrompt: { type: "string" },
        },
        inputRequired: ["content", "channelIds"],
        exampleInput: {
          content: "Exciting product launch!",
          channelIds: ["ch_twitter_1"],
          scheduledAt: "2025-01-15T09:00:00Z",
        },
      },
      {
        name: "update",
        type: "mutation",
        description: "Update a non-published post. Cannot edit published or publishing posts.",
        auth: "session+org",
        input: {
          id: { type: "string", required: true },
          content: { type: "string" },
          scheduledAt: { type: "string | null" },
          tags: { type: "string[]" },
        },
        inputRequired: ["id"],
      },
      {
        name: "delete",
        type: "mutation",
        description: "Permanently delete a post and all its targets.",
        auth: "session+org",
        input: { id: { type: "string", required: true } },
        inputRequired: ["id"],
      },
      {
        name: "publishNow",
        type: "mutation",
        description: "Immediately publish a post by scheduling it for the current time.",
        auth: "session+org",
        input: { id: { type: "string", required: true } },
        inputRequired: ["id"],
      },
    ],
  },
  {
    name: "channel",
    description: "Social media channel connections and management",
    procedures: [
      {
        name: "list",
        type: "query",
        description: "List all connected social media channels for the organization.",
        auth: "session+org",
        exampleOutput: [{ id: "ch_1", platform: "TWITTER", name: "@company", isActive: true }],
      },
      {
        name: "supportedPlatforms",
        type: "query",
        description: "List all supported social platforms with display names and constraints.",
        auth: "session+org",
      },
      {
        name: "getOAuthUrl",
        type: "mutation",
        description: "Generate OAuth authorization URL for connecting a new channel.",
        auth: "session+org",
        input: { platform: { type: "string", required: true, description: "e.g. TWITTER, LINKEDIN" } },
        inputRequired: ["platform"],
      },
      {
        name: "disconnect",
        type: "mutation",
        description: "Remove a connected channel from the organization.",
        auth: "session+org",
        input: { channelId: { type: "string", required: true } },
        inputRequired: ["channelId"],
      },
      {
        name: "toggleActive",
        type: "mutation",
        description: "Toggle the active state of a channel.",
        auth: "session+org",
        input: { channelId: { type: "string", required: true } },
        inputRequired: ["channelId"],
      },
    ],
  },
  {
    name: "ai",
    description: "AI-powered content generation and optimization (rate limited)",
    procedures: [
      {
        name: "generateContent",
        type: "mutation",
        description: "Generate social media content from a prompt. Supports OpenAI and Anthropic providers.",
        auth: "session+org",
        input: {
          prompt: { type: "string", required: true },
          platform: { type: "string", description: "Target platform" },
          tone: { type: "string", enum: ["professional", "casual", "humorous", "formal", "inspiring"], default: "professional" },
          provider: { type: "string", enum: ["openai", "anthropic"], default: "openai" },
        },
        inputRequired: ["prompt"],
        exampleInput: { prompt: "Write a tweet about our new feature", tone: "casual", provider: "openai" },
      },
      {
        name: "suggestHashtags",
        type: "mutation",
        description: "Suggest relevant hashtags for content.",
        auth: "session+org",
        input: {
          content: { type: "string", required: true },
          platform: { type: "string" },
        },
        inputRequired: ["content"],
      },
      {
        name: "optimizeContent",
        type: "mutation",
        description: "Optimize content for a platform and goal (engagement, reach, clicks, conversions).",
        auth: "session+org",
        input: {
          content: { type: "string", required: true },
          platform: { type: "string", required: true },
          goal: { type: "string", enum: ["engagement", "reach", "clicks", "conversions"], default: "engagement" },
        },
        inputRequired: ["content", "platform"],
      },
    ],
  },
  {
    name: "analytics",
    description: "Post analytics, engagement metrics, and dashboard statistics",
    procedures: [
      {
        name: "overview",
        type: "query",
        description: "Post counts and target stats for a date range (defaults to last 30 days).",
        auth: "session+org",
        input: {
          from: { type: "string (ISO 8601)" },
          to: { type: "string (ISO 8601)" },
        },
      },
      {
        name: "engagement",
        type: "query",
        description: "Aggregated engagement metrics: impressions, clicks, likes, shares, comments, reach.",
        auth: "session+org",
      },
      {
        name: "dashboardStats",
        type: "query",
        description: "All-time counts: totalPosts, connectedChannels, published, aiGenerated.",
        auth: "session+org",
      },
      {
        name: "platformBreakdown",
        type: "query",
        description: "Published post count grouped by social platform.",
        auth: "session+org",
      },
      {
        name: "recentActivity",
        type: "query",
        description: "Recent published/failed post targets for the activity feed.",
        auth: "session+org",
        input: { limit: { type: "integer", default: 5, description: "1-20" } },
      },
      {
        name: "postMetrics",
        type: "query",
        description: "Analytics snapshots for a specific post target.",
        auth: "session+org",
        input: { postTargetId: { type: "string", required: true } },
        inputRequired: ["postTargetId"],
      },
    ],
  },
  {
    name: "team",
    description: "Team member management and invitations",
    procedures: [
      {
        name: "members",
        type: "query",
        description: "List all organization members with their user profiles.",
        auth: "session+org",
      },
      {
        name: "invite",
        type: "mutation",
        description: "Invite an existing user by email. Requires OWNER or ADMIN role.",
        auth: "session+org",
        input: {
          email: { type: "string (email)", required: true },
          role: { type: "string", enum: ["ADMIN", "MEMBER", "VIEWER"], default: "MEMBER" },
        },
        inputRequired: ["email"],
      },
      {
        name: "updateRole",
        type: "mutation",
        description: "Change a member's role. Requires OWNER role.",
        auth: "session+org",
        input: {
          memberId: { type: "string", required: true },
          role: { type: "string", required: true, enum: ["ADMIN", "MEMBER", "VIEWER"] },
        },
        inputRequired: ["memberId", "role"],
      },
      {
        name: "removeMember",
        type: "mutation",
        description: "Remove a member from the organization. Cannot remove the owner.",
        auth: "session+org",
        input: { memberId: { type: "string", required: true } },
        inputRequired: ["memberId"],
      },
    ],
  },
  {
    name: "billing",
    description: "Subscription plans and Stripe billing management",
    procedures: [
      {
        name: "plans",
        type: "query",
        description: "List all available subscription plans with pricing.",
        auth: "session+org",
      },
      {
        name: "currentPlan",
        type: "query",
        description: "Get the organization's current plan, expiry, and Stripe subscription details.",
        auth: "session+org",
      },
      {
        name: "createCheckout",
        type: "mutation",
        description: "Create a Stripe checkout session for plan upgrade. Requires OWNER role.",
        auth: "session+org",
        input: { planType: { type: "string", required: true, enum: ["STARTER", "PROFESSIONAL", "ENTERPRISE"] } },
        inputRequired: ["planType"],
      },
      {
        name: "createPortalSession",
        type: "mutation",
        description: "Create a Stripe customer portal session for managing billing.",
        auth: "session+org",
      },
    ],
  },
  {
    name: "media",
    description: "Media file upload and management (images and videos)",
    procedures: [
      {
        name: "list",
        type: "query",
        description: "List media files with optional type filter and pagination.",
        auth: "session+org",
        input: {
          limit: { type: "integer", default: 20 },
          cursor: { type: "string" },
          type: { type: "string", enum: ["image", "video", "all"], default: "all" },
        },
      },
      {
        name: "getUploadUrl",
        type: "mutation",
        description: "Get a presigned S3 URL for uploading. Max 50MB. Validates file type.",
        auth: "session+org",
        input: {
          fileName: { type: "string", required: true },
          fileType: { type: "string", required: true, description: "MIME type" },
          fileSize: { type: "integer", required: true, description: "Size in bytes, max 52428800" },
        },
        inputRequired: ["fileName", "fileType", "fileSize"],
      },
      {
        name: "confirmUpload",
        type: "mutation",
        description: "Confirm that a media file has been uploaded to S3.",
        auth: "session+org",
        input: { mediaId: { type: "string", required: true } },
        inputRequired: ["mediaId"],
      },
      {
        name: "delete",
        type: "mutation",
        description: "Delete a media file from S3 and the database.",
        auth: "session+org",
        input: { id: { type: "string", required: true } },
        inputRequired: ["id"],
      },
    ],
  },
  {
    name: "webhook",
    description: "Webhook endpoint configuration",
    procedures: [
      {
        name: "list",
        type: "query",
        description: "List all webhooks for the organization.",
        auth: "session+org",
      },
      {
        name: "create",
        type: "mutation",
        description: "Create a new webhook endpoint with event subscriptions.",
        auth: "session+org",
        input: {
          url: { type: "string (URL)", required: true },
          events: { type: "string[]", required: true, description: "At least one event" },
        },
        inputRequired: ["url", "events"],
        exampleInput: { url: "https://example.com/webhook", events: ["post.published", "post.failed"] },
      },
      {
        name: "delete",
        type: "mutation",
        description: "Delete a webhook endpoint.",
        auth: "session+org",
        input: { id: { type: "string", required: true } },
        inputRequired: ["id"],
      },
    ],
  },
  {
    name: "apikey",
    description: "API key generation and management",
    procedures: [
      {
        name: "list",
        type: "query",
        description: "List API keys for the organization (keys are masked).",
        auth: "session+org",
      },
      {
        name: "create",
        type: "mutation",
        description: "Generate a new API key. The full key is returned only once. Rate limited.",
        auth: "session+org",
        input: {
          name: { type: "string", required: true },
          expiresAt: { type: "string (ISO 8601)" },
        },
        inputRequired: ["name"],
        exampleInput: { name: "Production API Key" },
        exampleOutput: { id: "key_1", name: "Production API Key", key: "pa_abc123..." },
      },
      {
        name: "delete",
        type: "mutation",
        description: "Revoke and delete an API key.",
        auth: "session+org",
        input: { id: { type: "string", required: true } },
        inputRequired: ["id"],
      },
    ],
  },
  {
    name: "audit",
    description: "Audit log viewing (requires OWNER or ADMIN role)",
    procedures: [
      {
        name: "list",
        type: "query",
        description: "Paginated audit logs with optional filters for action, entity type, user, and date range.",
        auth: "session+org",
        input: {
          page: { type: "integer", default: 1 },
          limit: { type: "integer", default: 25 },
          action: { type: "string" },
          entityType: { type: "string" },
          userId: { type: "string" },
          startDate: { type: "string" },
          endDate: { type: "string" },
        },
      },
      {
        name: "entityHistory",
        type: "query",
        description: "Full audit trail for a specific entity (type + ID).",
        auth: "session+org",
        input: {
          entityType: { type: "string", required: true },
          entityId: { type: "string", required: true },
        },
        inputRequired: ["entityType", "entityId"],
      },
    ],
  },
  {
    name: "image",
    description: "AI image generation and editing (rate limited)",
    procedures: [
      {
        name: "generate",
        type: "mutation",
        description: "Generate an image from a text prompt. Supports Nano Banana and DALL-E providers.",
        auth: "session+org",
        input: {
          prompt: { type: "string", required: true, description: "Max 2000 characters" },
          provider: { type: "string", enum: ["nano-banana", "nano-banana-pro", "dall-e"] },
          aspectRatio: { type: "string", default: "1:1" },
          imageSize: { type: "string", default: "1K" },
        },
        inputRequired: ["prompt"],
      },
      {
        name: "edit",
        type: "mutation",
        description: "Edit an existing image using AI. DALL-E not supported for editing.",
        auth: "session+org",
        input: {
          prompt: { type: "string", required: true },
          imageBase64: { type: "string", required: true },
          imageMimeType: { type: "string", default: "image/jpeg" },
          provider: { type: "string", enum: ["nano-banana", "nano-banana-pro"] },
        },
        inputRequired: ["prompt", "imageBase64"],
      },
      {
        name: "saveGenerated",
        type: "mutation",
        description: "Upload a generated base64 image to S3 and create a media record.",
        auth: "session+org",
        input: {
          imageBase64: { type: "string", required: true },
          mimeType: { type: "string", default: "image/png" },
          fileName: { type: "string", default: "generated-image.png" },
        },
        inputRequired: ["imageBase64"],
      },
    ],
  },
  {
    name: "bulk",
    description: "Bulk post operations: schedule, delete, status change, CSV import/export",
    procedures: [
      {
        name: "bulkSchedule",
        type: "mutation",
        description: "Schedule multiple posts at once (max 100 items).",
        auth: "session+org",
        input: {
          items: { type: "array of { postId: string, scheduledAt: string }", required: true },
        },
        inputRequired: ["items"],
        exampleInput: { items: [{ postId: "post_1", scheduledAt: "2025-02-01T10:00:00Z" }] },
        exampleOutput: { scheduled: 1 },
      },
      {
        name: "bulkDelete",
        type: "mutation",
        description: "Delete multiple posts by ID (max 100).",
        auth: "session+org",
        input: { postIds: { type: "string[]", required: true } },
        inputRequired: ["postIds"],
        exampleOutput: { deleted: 5 },
      },
      {
        name: "bulkUpdateStatus",
        type: "mutation",
        description: "Change the status of multiple posts to DRAFT or CANCELLED.",
        auth: "session+org",
        input: {
          postIds: { type: "string[]", required: true },
          status: { type: "string", required: true, enum: ["DRAFT", "CANCELLED"] },
        },
        inputRequired: ["postIds", "status"],
      },
      {
        name: "csvImport",
        type: "mutation",
        description: "Import posts from CSV data. Header: content (required), scheduledAt (optional).",
        auth: "session+org",
        input: {
          csvData: { type: "string", required: true, description: "Raw CSV text" },
          channelIds: { type: "string[]", required: true },
          scheduledAt: { type: "string", description: "Default schedule for rows without one" },
        },
        inputRequired: ["csvData", "channelIds"],
        exampleOutput: { imported: 10, errors: [] },
      },
      {
        name: "csvExport",
        type: "query",
        description: "Export posts as CSV. Columns: content, status, scheduledAt, publishedAt, platforms.",
        auth: "session+org",
        input: {
          status: { type: "string" },
          startDate: { type: "string" },
          endDate: { type: "string" },
        },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helper Components
// ---------------------------------------------------------------------------

function JsonBlock({ data }: { data: unknown }) {
  const json = JSON.stringify(data, null, 2);
  return (
    <pre className="overflow-x-auto rounded-md bg-slate-950 p-3 text-xs text-green-400 font-mono leading-relaxed">
      <code>{json}</code>
    </pre>
  );
}

function AuthBadge({ auth }: { auth: string }) {
  if (auth === "public") {
    return (
      <Badge variant="outline" className="text-xs gap-1">
        <Globe className="h-3 w-3" />
        Public
      </Badge>
    );
  }
  if (auth === "session+org") {
    return (
      <Badge variant="secondary" className="text-xs gap-1">
        <Lock className="h-3 w-3" />
        Session + Org
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-xs gap-1">
      <Lock className="h-3 w-3" />
      Session
    </Badge>
  );
}

function ProcedureCard({ procedure, routerName }: { procedure: ProcedureDoc; routerName: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border rounded-lg">
      <button
        className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Badge
            variant={procedure.type === "query" ? "outline" : "default"}
            className={`text-xs shrink-0 ${procedure.type === "query" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"}`}
          >
            {procedure.type === "query" ? "GET" : "POST"}
          </Badge>
          <code className="text-sm font-mono font-medium">
            {routerName}.{procedure.name}
          </code>
        </div>
        <AuthBadge auth={procedure.auth} />
      </button>

      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-3">
          <p className="text-sm text-muted-foreground">{procedure.description}</p>

          <div className="text-xs font-mono text-muted-foreground bg-muted/50 rounded px-3 py-1.5">
            {procedure.type === "query" ? "GET" : "POST"}{" "}
            /api/trpc/{routerName}.{procedure.name}
          </div>

          {procedure.input && Object.keys(procedure.input).length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-2">Input Parameters</h4>
              <div className="rounded-md border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/30">
                      <th className="px-3 py-2 text-left font-medium">Field</th>
                      <th className="px-3 py-2 text-left font-medium">Type</th>
                      <th className="px-3 py-2 text-left font-medium">Required</th>
                      <th className="px-3 py-2 text-left font-medium">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(procedure.input).map(([field, doc]) => (
                      <tr key={field} className="border-b last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{field}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{doc.type}</td>
                        <td className="px-3 py-2 text-xs">
                          {doc.required || procedure.inputRequired?.includes(field) ? (
                            <Badge variant="destructive" className="text-[10px] px-1.5 py-0">required</Badge>
                          ) : (
                            <span className="text-muted-foreground">optional</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {doc.enum ? `Enum: ${doc.enum.join(", ")}` : ""}
                          {doc.default !== undefined ? ` Default: ${String(doc.default)}` : ""}
                          {doc.description ? ` ${doc.description}` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {procedure.exampleInput && (
            <div>
              <h4 className="text-sm font-medium mb-1">Example Input</h4>
              <JsonBlock data={procedure.exampleInput} />
            </div>
          )}

          {procedure.exampleOutput && (
            <div>
              <h4 className="text-sm font-medium mb-1">Example Output</h4>
              <JsonBlock data={procedure.exampleOutput} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------
export default function ApiDocsPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedRouters, setExpandedRouters] = useState<Set<string>>(new Set());

  const filteredRouters = useMemo(() => {
    if (!searchQuery.trim()) return routers;
    const q = searchQuery.toLowerCase();
    return routers
      .map((router) => {
        const routerMatch = router.name.toLowerCase().includes(q) || router.description.toLowerCase().includes(q);
        const filteredProcedures = router.procedures.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            `${router.name}.${p.name}`.toLowerCase().includes(q)
        );
        if (routerMatch) return router;
        if (filteredProcedures.length > 0) return { ...router, procedures: filteredProcedures };
        return null;
      })
      .filter(Boolean) as RouterDoc[];
  }, [searchQuery]);

  const toggleRouter = (name: string) => {
    setExpandedRouters((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const expandAll = () => {
    setExpandedRouters(new Set(routers.map((r) => r.name)));
  };

  const collapseAll = () => {
    setExpandedRouters(new Set());
  };

  const handleDownloadSpec = async () => {
    try {
      const response = await fetch("/api/openapi");
      const spec = (await response.json()) as Record<string, unknown>;
      const blob = new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "postautomation-openapi.json";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch {
      // Fallback: construct inline
      const blob = new Blob(["OpenAPI spec not available at /api/openapi"], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "error.txt";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  };

  const totalProcedures = routers.reduce((sum, r) => sum + r.procedures.length, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Code2 className="h-6 w-6" />
            API Documentation
          </h1>
          <p className="text-muted-foreground mt-1">
            {routers.length} routers, {totalProcedures} procedures
          </p>
        </div>
        <Button variant="outline" onClick={handleDownloadSpec}>
          <FileJson className="mr-2 h-4 w-4" />
          Download OpenAPI JSON
        </Button>
      </div>

      {/* Info card */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <h3 className="text-sm font-medium">Base URL</h3>
              <code className="mt-1 block text-xs font-mono text-muted-foreground bg-muted rounded px-2 py-1">
                /api/trpc/&#123;router&#125;.&#123;procedure&#125;
              </code>
            </div>
            <div>
              <h3 className="text-sm font-medium">Authentication</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Session cookie (NextAuth) + x-organization-id header for org endpoints
              </p>
            </div>
            <div>
              <h3 className="text-sm font-medium">Transport</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                tRPC over HTTP. Queries = GET, Mutations = POST. Data serialized with superjson.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Search and controls */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search routers or procedures..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        <Button variant="outline" size="sm" onClick={expandAll}>
          Expand All
        </Button>
        <Button variant="outline" size="sm" onClick={collapseAll}>
          Collapse All
        </Button>
      </div>

      {/* Router sections */}
      <div className="space-y-4">
        {filteredRouters.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center py-12">
              <Search className="h-10 w-10 text-muted-foreground/30 mb-2" />
              <p className="text-muted-foreground">No results found for &quot;{searchQuery}&quot;</p>
            </CardContent>
          </Card>
        ) : (
          filteredRouters.map((router) => {
            const isExpanded = expandedRouters.has(router.name) || searchQuery.trim() !== "";
            return (
              <Card key={router.name}>
                <CardHeader
                  className="cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => toggleRouter(router.name)}
                >
                  <div className="flex items-center gap-3">
                    {isExpanded ? (
                      <ChevronDown className="h-5 w-5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
                    )}
                    <div className="flex-1">
                      <CardTitle className="text-lg">
                        {router.name}
                        <Badge variant="outline" className="ml-2 text-xs">
                          {router.procedures.length} endpoints
                        </Badge>
                      </CardTitle>
                      <CardDescription className="mt-1">{router.description}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                {isExpanded && (
                  <CardContent className="space-y-2 pt-0">
                    {router.procedures.map((proc) => (
                      <ProcedureCard
                        key={proc.name}
                        procedure={proc}
                        routerName={router.name}
                      />
                    ))}
                  </CardContent>
                )}
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}

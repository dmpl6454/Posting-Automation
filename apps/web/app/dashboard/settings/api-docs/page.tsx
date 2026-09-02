"use client";

import { useState, useMemo } from "react";
import { Button } from "~/components/ui/button";
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
        exampleInput: { id: "clxabc123" },
        exampleOutput: {
          id: "clxabc123",
          content: "Hello world!",
          status: "PUBLISHED",
          scheduledAt: "2026-05-26T10:00:00.000Z",
          publishedAt: "2026-05-26T10:00:05.123Z",
          targets: [
            { id: "tgt_1", channelId: "ch_1", status: "PUBLISHED", publishedUrl: "https://twitter.com/...", channel: { platform: "TWITTER" } },
          ],
          media: [],
          tags: ["launch"],
        },
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
        exampleOutput: [
          {
            platform: "TWITTER",
            displayName: "Twitter / X",
            constraints: { maxContentLength: 25000, maxMediaCount: 4, supportsThreads: true },
          },
          {
            platform: "LINKEDIN",
            displayName: "LinkedIn",
            constraints: { maxContentLength: 3000, maxMediaCount: 9, supportsThreads: false },
          },
        ],
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
        exampleInput: { planType: "PROFESSIONAL" },
        exampleOutput: { url: "https://checkout.stripe.com/c/pay/cs_test_..." },
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

/* Design tokens for this page. Literal hex throughout: this project's Tailwind
   config flattens the blue/green/emerald/red scales onto the palette's status
   triplets, so `bg-blue-50 text-blue-700` renders the label the same colour as
   its background. */
const METHOD_COLOR: Record<string, string> = {
  GET: "#5b9bd5",
  POST: "#5cb85c",
  DELETE: "#d9695f",
};
const CARD_TITLE = "text-[14.5px] font-semibold leading-[1.2]";
const CARD_SUB = "text-[12px] leading-[1.5] text-muted-foreground";
const FIELD_38 =
  "h-[38px] rounded-[8px] border-border2 bg-background px-3 text-[12.5px]";
const OUTLINE_BTN =
  "h-[38px] shrink-0 gap-1.5 rounded-[8px] border-border2 px-[15px] text-[12.5px] font-medium hover:bg-hover";

/** The design's fixed-width method pill. */
function MethodPill({ method }: { method: string }) {
  const c = METHOD_COLOR[method] ?? "#8a8578";
  return (
    <span
      className="w-[52px] shrink-0 rounded-[5px] py-0.5 text-center font-mono text-[10px] font-bold leading-[1.6]"
      style={{ background: `${c}26`, color: c }}
    >
      {method}
    </span>
  );
}

function JsonBlock({ data }: { data: unknown }) {
  const json = JSON.stringify(data, null, 2);
  return (
    <pre className="overflow-x-auto rounded-[8px] border border-border2 bg-surface1 p-3 font-mono text-[11.5px] leading-relaxed text-[#5cb85c]">
      <code>{json}</code>
    </pre>
  );
}

function AuthBadge({ auth }: { auth: string }) {
  const label =
    auth === "public" ? "Public" : auth === "session+org" ? "Session + Org" : "Session";
  const Icon = auth === "public" ? Globe : Lock;
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-[5px] border border-border2 px-2 py-px text-[10px] font-medium leading-[1.6] text-muted-foreground">
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

// Fix #81: `expanded` is now controlled externally so `expandAll` can open all procedures.
function ProcedureCard({
  procedure,
  routerName,
  expanded,
  onToggle,
}: {
  procedure: ProcedureDoc;
  routerName: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    /* The design's endpoint row: one line of
       [method pill] [path] [description], no chevron and no auth badge.
       The row still opens the parameter/example detail this app has and the
       mockup does not, so the DEFAULT state matches the design exactly and the
       extra depth is one click away rather than deleted. */
    <div className="rounded-[9px] border border-border2">
      <button
        className="flex w-full items-center gap-3 px-3 py-[9px] text-left transition-colors hover:bg-hover"
        onClick={onToggle}
      >
        <MethodPill method={procedure.type === "query" ? "GET" : "POST"} />
        <code className="shrink-0 font-mono text-[12px] font-medium leading-[1.3]">
          {routerName}.{procedure.name}
        </code>
        <span className="min-w-0 flex-1 truncate text-[11.5px] leading-[1.4] text-muted-foreground">
          {procedure.description}
        </span>
        {/* No chevron in the resting state — the design's row is just
            pill / path / description. */}
        {expanded && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-faint" />}
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-border2 px-3 pb-3.5 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 rounded-[6px] bg-tile px-3 py-1.5 font-mono text-[11.5px] text-muted-foreground">
              {procedure.type === "query" ? "GET" : "POST"}{" "}
              /api/trpc/{routerName}.{procedure.name}
            </div>
            <AuthBadge auth={procedure.auth} />
          </div>

          {procedure.input && Object.keys(procedure.input).length > 0 && (
            <div>
              <h4 className="mb-2 text-[12px] font-semibold leading-none">Input Parameters</h4>
              <div className="overflow-hidden rounded-[8px] border border-border2">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border2 bg-tile">
                      <th className="px-3 py-2 text-left text-[11px] font-semibold">Field</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold">Type</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold">Required</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(procedure.input).map(([field, doc]) => (
                      <tr key={field} className="border-b border-border2 last:border-0">
                        <td className="px-3 py-2 font-mono text-[11px]">{field}</td>
                        <td className="px-3 py-2 text-[11px] text-muted-foreground">{doc.type}</td>
                        <td className="px-3 py-2 text-[11px]">
                          {doc.required || procedure.inputRequired?.includes(field) ? (
                            <span
                              className="rounded-[5px] px-1.5 py-px text-[10px] font-semibold leading-[1.6]"
                              style={{ background: "rgba(201,107,86,0.15)", color: "#c96b56" }}
                            >
                              required
                            </span>
                          ) : (
                            <span className="text-faint">optional</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-[11px] text-muted-foreground">
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
              <h4 className="mb-1.5 text-[12px] font-semibold leading-none">Example Input</h4>
              <JsonBlock data={procedure.exampleInput} />
            </div>
          )}

          {procedure.exampleOutput && (
            <div>
              <h4 className="mb-1.5 text-[12px] font-semibold leading-none">Example Output</h4>
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
  // Router groups are always open now (the design lists their endpoints
  // inline), so only per-procedure detail has expanded state. Keyed by
  // "routerName.procedureName" — Fix #81.
  const [expandedProcs, setExpandedProcs] = useState<Set<string>>(new Set());

  const toggleProc = (key: string) => {
    setExpandedProcs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

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
    /* Design stacks sections on 20px, not 24px. */
    <div className="w-full space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        {/* Page header — eyebrow / display title / subtitle (design restyle).
            The live router/procedure counts stay in the subtitle: the design's
            static tagline should not displace real data about the workspace. */}
        <div className="min-w-0">
          <span className="eyebrow">API Docs</span>
          {/* The design's h1 carries no icon. */}
          <h1 className="display mt-2.5 text-[30px] leading-[1.1]">
            Everything the API can do.
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            Reference for building on top of your workspace data — {routers.length} routers,{" "}
            {totalProcedures} procedures
          </p>
        </div>
        <Button variant="outline" onClick={handleDownloadSpec} className={`${OUTLINE_BTN} w-full sm:w-auto`}>
          <FileJson className="h-[13px] w-[13px]" />
          Download OpenAPI JSON
        </Button>
      </div>

      {/* Search. The design has no control row at all, but 51 procedures need
          a filter, so it is kept as a single quiet field rather than a block.
          Expand/Collapse All are gone: the groups no longer collapse. */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search routers or procedures..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className={`${FIELD_38} pl-9`}
        />
      </div>

      {/* Router sections */}
      <div className="flex flex-col gap-3.5">
        {filteredRouters.length === 0 ? (
          <div className="flex flex-col items-center rounded-[14px] border border-border bg-card py-12">
            <Search className="h-8 w-8 text-tile" />
            <p className="mt-2.5 text-[12.5px] text-muted-foreground">
              No results found for &quot;{searchQuery}&quot;
            </p>
          </div>
        ) : (
          /* The design lists every group's endpoints inline — no accordion, no
             chevron, no endpoint-count chip. Collapsing 13 routers into 13
             empty headers is what made this page read as a stack of labels
             rather than a reference. */
          filteredRouters.map((router) => (
            <div key={router.name} className="rounded-[14px] border border-border bg-card p-5">
              <h2 className={CARD_TITLE}>{router.name}</h2>
              <p className={`mt-[5px] ${CARD_SUB}`}>{router.description}</p>
              <div className="mt-3.5 flex flex-col gap-2">
                {router.procedures.map((proc) => {
                  const procKey = `${router.name}.${proc.name}`;
                  return (
                    <ProcedureCard
                      key={proc.name}
                      procedure={proc}
                      routerName={router.name}
                      expanded={expandedProcs.has(procKey)}
                      onToggle={() => toggleProc(procKey)}
                    />
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {/* The design has no info block at the top of this page. This reference
          is real and specific to this workspace's API, so it moves to the foot
          of the page rather than being deleted — it no longer pushes the
          endpoint list below the fold. */}
      <div className="grid gap-4 rounded-[12px] border border-border bg-surface1 px-4 py-3.5 sm:grid-cols-3">
        <div>
          <h3 className="text-[12px] font-semibold leading-none">Base URL</h3>
          <code className="mt-1.5 block rounded-[6px] bg-tile px-2 py-1 font-mono text-[11.5px] text-muted-foreground">
            /api/trpc/&#123;router&#125;.&#123;procedure&#125;
          </code>
        </div>
        <div>
          <h3 className="text-[12px] font-semibold leading-none">Authentication</h3>
          <p className="mt-1.5 text-[11.5px] leading-[1.5] text-muted-foreground">
            Session cookie (NextAuth) + x-organization-id header for org endpoints
          </p>
        </div>
        <div>
          <h3 className="text-[12px] font-semibold leading-none">Transport</h3>
          <p className="mt-1.5 text-[11.5px] leading-[1.5] text-muted-foreground">
            tRPC over HTTP. Queries = GET, Mutations = POST. Data serialized with superjson.
          </p>
        </div>
      </div>
    </div>
  );
}

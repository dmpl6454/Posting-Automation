/**
 * Manual OpenAPI 3.0 specification for the PostAutomation tRPC API.
 *
 * Since tRPC does not natively export OpenAPI specs, this file documents
 * all key endpoints manually. The spec covers every router registered
 * in the application (user, post, channel, ai, analytics, team, billing,
 * media, webhook, apikey, audit, image, and bulk).
 */

interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    description: string;
    version: string;
  };
  servers: Array<{ url: string; description: string }>;
  paths: Record<string, any>;
  components: {
    securitySchemes: Record<string, any>;
    schemas: Record<string, any>;
  };
  security: Array<Record<string, string[]>>;
}

export const openApiSpec: OpenApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "PostAutomation API",
    description:
      "API documentation for the PostAutomation platform. All endpoints are served via tRPC over HTTP. " +
      "Queries use GET requests with URL-encoded input, mutations use POST requests with JSON body. " +
      "All requests require a valid session cookie and the x-organization-id header for org-scoped endpoints.",
    version: "1.0.0",
  },
  servers: [
    {
      url: "/api/trpc",
      description: "tRPC API base path",
    },
  ],
  paths: {
    // ===================== USER ROUTER =====================
    "/user.me": {
      get: {
        tags: ["User"],
        summary: "Get current user profile",
        description: "Returns the authenticated user with their organization memberships.",
        operationId: "user.me",
        security: [{ session: [] }],
        responses: {
          "200": {
            description: "User profile with memberships",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UserWithMemberships" },
              },
            },
          },
          "401": { description: "Unauthorized" },
        },
      },
    },
    "/user.updateProfile": {
      post: {
        tags: ["User"],
        summary: "Update user profile",
        description: "Update the authenticated user's name or avatar image URL.",
        operationId: "user.updateProfile",
        security: [{ session: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string", minLength: 1 },
                  image: { type: "string", format: "uri" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated user object" },
          "401": { description: "Unauthorized" },
        },
      },
    },
    "/user.createOrganization": {
      post: {
        tags: ["User"],
        summary: "Create a new organization",
        description: "Creates a new organization and sets the current user as OWNER.",
        operationId: "user.createOrganization",
        security: [{ session: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "slug"],
                properties: {
                  name: { type: "string", minLength: 1 },
                  slug: { type: "string", pattern: "^[a-z0-9-]+$" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Created organization" },
          "401": { description: "Unauthorized" },
        },
      },
    },

    // ===================== POST ROUTER =====================
    "/post.list": {
      get: {
        tags: ["Post"],
        summary: "List posts",
        description: "Returns paginated posts for the organization with optional status filter.",
        operationId: "post.list",
        security: [{ session: [], organization: [] }],
        parameters: [
          {
            name: "input",
            in: "query",
            schema: {
              type: "object",
              properties: {
                status: {
                  type: "string",
                  enum: ["DRAFT", "SCHEDULED", "PUBLISHING", "PUBLISHED", "FAILED", "CANCELLED"],
                },
                limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
                cursor: { type: "string" },
              },
            },
          },
        ],
        responses: {
          "200": {
            description: "Paginated list of posts with targets, media, and tags",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    posts: { type: "array", items: { $ref: "#/components/schemas/Post" } },
                    nextCursor: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/post.getById": {
      get: {
        tags: ["Post"],
        summary: "Get post by ID",
        description: "Returns a single post with its targets, media, and tags.",
        operationId: "post.getById",
        security: [{ session: [], organization: [] }],
        parameters: [
          { name: "input", in: "query", schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
        ],
        responses: {
          "200": { description: "Post object" },
          "404": { description: "Post not found" },
        },
      },
    },
    "/post.create": {
      post: {
        tags: ["Post"],
        summary: "Create a new post",
        description: "Creates a post with content, channel targets, optional schedule, media, tags, and AI metadata.",
        operationId: "post.create",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["content", "channelIds"],
                properties: {
                  content: { type: "string", minLength: 1 },
                  contentVariants: { type: "object", additionalProperties: { type: "string" } },
                  channelIds: { type: "array", items: { type: "string" }, minItems: 1 },
                  scheduledAt: { type: "string", format: "date-time" },
                  mediaIds: { type: "array", items: { type: "string" } },
                  tags: { type: "array", items: { type: "string" } },
                  aiGenerated: { type: "boolean", default: false },
                  aiProvider: { type: "string" },
                  aiPrompt: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Created post with targets, media, and tags" },
        },
      },
    },
    "/post.update": {
      post: {
        tags: ["Post"],
        summary: "Update an existing post",
        description: "Updates content, variants, schedule, or tags of a non-published post.",
        operationId: "post.update",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["id"],
                properties: {
                  id: { type: "string" },
                  content: { type: "string" },
                  contentVariants: { type: "object" },
                  scheduledAt: { type: "string", format: "date-time", nullable: true },
                  tags: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated post" },
          "400": { description: "Cannot edit published posts" },
          "404": { description: "Post not found" },
        },
      },
    },
    "/post.delete": {
      post: {
        tags: ["Post"],
        summary: "Delete a post",
        description: "Permanently deletes a post and all associated targets.",
        operationId: "post.delete",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
            },
          },
        },
        responses: {
          "200": { description: "Success confirmation" },
          "404": { description: "Post not found" },
        },
      },
    },
    "/post.publishNow": {
      post: {
        tags: ["Post"],
        summary: "Publish a post immediately",
        description: "Sets the post to SCHEDULED with current time and enqueues publish jobs for all targets.",
        operationId: "post.publishNow",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
            },
          },
        },
        responses: {
          "200": { description: "Success confirmation" },
          "404": { description: "Post not found" },
        },
      },
    },

    // ===================== CHANNEL ROUTER =====================
    "/channel.list": {
      get: {
        tags: ["Channel"],
        summary: "List connected channels",
        description: "Returns all social media channels connected to the organization.",
        operationId: "channel.list",
        security: [{ session: [], organization: [] }],
        responses: {
          "200": {
            description: "Array of channels",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Channel" } },
              },
            },
          },
        },
      },
    },
    "/channel.supportedPlatforms": {
      get: {
        tags: ["Channel"],
        summary: "List supported platforms",
        description: "Returns all supported social platforms with their display names and constraints.",
        operationId: "channel.supportedPlatforms",
        security: [{ session: [], organization: [] }],
        responses: {
          "200": { description: "Array of platform objects with displayName and constraints" },
        },
      },
    },
    "/channel.getOAuthUrl": {
      post: {
        tags: ["Channel"],
        summary: "Get OAuth URL for connecting a channel",
        description: "Generates the OAuth authorization URL for the given platform.",
        operationId: "channel.getOAuthUrl",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", required: ["platform"], properties: { platform: { type: "string" } } },
            },
          },
        },
        responses: {
          "200": { description: "Object with url and state" },
        },
      },
    },
    "/channel.disconnect": {
      post: {
        tags: ["Channel"],
        summary: "Disconnect a channel",
        description: "Removes a connected social media channel from the organization.",
        operationId: "channel.disconnect",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", required: ["channelId"], properties: { channelId: { type: "string" } } },
            },
          },
        },
        responses: {
          "200": { description: "Success" },
          "404": { description: "Channel not found" },
        },
      },
    },
    "/channel.toggleActive": {
      post: {
        tags: ["Channel"],
        summary: "Toggle channel active state",
        description: "Toggles the isActive flag on a channel.",
        operationId: "channel.toggleActive",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", required: ["channelId"], properties: { channelId: { type: "string" } } },
            },
          },
        },
        responses: { "200": { description: "Updated channel" } },
      },
    },

    // ===================== AI ROUTER =====================
    "/ai.generateContent": {
      post: {
        tags: ["AI"],
        summary: "Generate content using AI",
        description: "Generates social media content from a prompt using the selected AI provider. Rate limited.",
        operationId: "ai.generateContent",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["prompt"],
                properties: {
                  prompt: { type: "string", minLength: 1 },
                  platform: { type: "string" },
                  tone: { type: "string", enum: ["professional", "casual", "humorous", "formal", "inspiring"], default: "professional" },
                  provider: { type: "string", enum: ["openai", "anthropic"], default: "openai" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Generated content string" },
          "429": { description: "Rate limit exceeded" },
        },
      },
    },
    "/ai.suggestHashtags": {
      post: {
        tags: ["AI"],
        summary: "Suggest hashtags",
        description: "Suggests relevant hashtags for the given content and platform.",
        operationId: "ai.suggestHashtags",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["content"],
                properties: {
                  content: { type: "string" },
                  platform: { type: "string" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Array of hashtag suggestions" } },
      },
    },
    "/ai.optimizeContent": {
      post: {
        tags: ["AI"],
        summary: "Optimize content",
        description: "Optimizes content for a specific platform and goal (engagement, reach, clicks, conversions).",
        operationId: "ai.optimizeContent",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["content", "platform"],
                properties: {
                  content: { type: "string" },
                  platform: { type: "string" },
                  goal: { type: "string", enum: ["engagement", "reach", "clicks", "conversions"], default: "engagement" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Optimized content" } },
      },
    },

    // ===================== ANALYTICS ROUTER =====================
    "/analytics.overview": {
      get: {
        tags: ["Analytics"],
        summary: "Get analytics overview",
        description: "Returns post counts and target stats for the given date range (defaults to last 30 days).",
        operationId: "analytics.overview",
        security: [{ session: [], organization: [] }],
        parameters: [
          { name: "input", in: "query", schema: { type: "object", properties: { from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } } } },
        ],
        responses: {
          "200": {
            description: "Overview with totalPosts, totalTargets, published, failed, period",
          },
        },
      },
    },
    "/analytics.engagement": {
      get: {
        tags: ["Analytics"],
        summary: "Get engagement metrics",
        description: "Aggregated engagement metrics (impressions, clicks, likes, shares, comments, reach) across published posts.",
        operationId: "analytics.engagement",
        security: [{ session: [], organization: [] }],
        responses: {
          "200": { description: "Engagement metrics object" },
        },
      },
    },
    "/analytics.dashboardStats": {
      get: {
        tags: ["Analytics"],
        summary: "Get dashboard statistics",
        description: "All-time counts: totalPosts, connectedChannels, published, aiGenerated.",
        operationId: "analytics.dashboardStats",
        security: [{ session: [], organization: [] }],
        responses: { "200": { description: "Dashboard stats object" } },
      },
    },
    "/analytics.platformBreakdown": {
      get: {
        tags: ["Analytics"],
        summary: "Platform breakdown",
        description: "Published post count broken down by social platform.",
        operationId: "analytics.platformBreakdown",
        security: [{ session: [], organization: [] }],
        responses: { "200": { description: "Array of { platform, count }" } },
      },
    },
    "/analytics.recentActivity": {
      get: {
        tags: ["Analytics"],
        summary: "Recent activity feed",
        description: "Recent published or failed post targets for the dashboard.",
        operationId: "analytics.recentActivity",
        security: [{ session: [], organization: [] }],
        responses: { "200": { description: "Array of activity items" } },
      },
    },
    "/analytics.postMetrics": {
      get: {
        tags: ["Analytics"],
        summary: "Post target metrics",
        description: "Analytics snapshots for a specific post target.",
        operationId: "analytics.postMetrics",
        security: [{ session: [], organization: [] }],
        parameters: [
          { name: "input", in: "query", schema: { type: "object", required: ["postTargetId"], properties: { postTargetId: { type: "string" } } } },
        ],
        responses: { "200": { description: "Array of analytics snapshots" } },
      },
    },

    // ===================== TEAM ROUTER =====================
    "/team.members": {
      get: {
        tags: ["Team"],
        summary: "List team members",
        description: "Returns all members of the organization with their user profiles.",
        operationId: "team.members",
        security: [{ session: [], organization: [] }],
        responses: { "200": { description: "Array of organization members" } },
      },
    },
    "/team.invite": {
      post: {
        tags: ["Team"],
        summary: "Invite a team member",
        description: "Invites an existing user to the organization. Requires OWNER or ADMIN role.",
        operationId: "team.invite",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email"],
                properties: {
                  email: { type: "string", format: "email" },
                  role: { type: "string", enum: ["ADMIN", "MEMBER", "VIEWER"], default: "MEMBER" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Created membership" },
          "403": { description: "Insufficient permissions" },
          "404": { description: "User not found" },
          "409": { description: "Already a member" },
        },
      },
    },
    "/team.updateRole": {
      post: {
        tags: ["Team"],
        summary: "Update member role",
        description: "Changes a member's role. Requires OWNER role.",
        operationId: "team.updateRole",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["memberId", "role"],
                properties: {
                  memberId: { type: "string" },
                  role: { type: "string", enum: ["ADMIN", "MEMBER", "VIEWER"] },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Updated membership" }, "403": { description: "Only owners" } },
      },
    },
    "/team.removeMember": {
      post: {
        tags: ["Team"],
        summary: "Remove a team member",
        description: "Removes a member from the organization. Cannot remove the owner.",
        operationId: "team.removeMember",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", required: ["memberId"], properties: { memberId: { type: "string" } } },
            },
          },
        },
        responses: { "200": { description: "Success" }, "400": { description: "Cannot remove owner" } },
      },
    },

    // ===================== BILLING ROUTER =====================
    "/billing.plans": {
      get: {
        tags: ["Billing"],
        summary: "List available plans",
        description: "Returns all subscription plans with pricing and feature information.",
        operationId: "billing.plans",
        security: [{ session: [], organization: [] }],
        responses: { "200": { description: "Array of plan objects" } },
      },
    },
    "/billing.currentPlan": {
      get: {
        tags: ["Billing"],
        summary: "Get current plan",
        description: "Returns the organization's current subscription plan and Stripe details.",
        operationId: "billing.currentPlan",
        security: [{ session: [], organization: [] }],
        responses: { "200": { description: "Current plan with config" } },
      },
    },
    "/billing.createCheckout": {
      post: {
        tags: ["Billing"],
        summary: "Create Stripe checkout session",
        description: "Creates a Stripe checkout session for upgrading the plan. Requires OWNER role.",
        operationId: "billing.createCheckout",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["planType"],
                properties: { planType: { type: "string", enum: ["STARTER", "PROFESSIONAL", "ENTERPRISE"] } },
              },
            },
          },
        },
        responses: { "200": { description: "Object with checkout URL" }, "403": { description: "Only owners" } },
      },
    },
    "/billing.createPortalSession": {
      post: {
        tags: ["Billing"],
        summary: "Create Stripe customer portal session",
        description: "Creates a Stripe customer portal session for managing billing.",
        operationId: "billing.createPortalSession",
        security: [{ session: [], organization: [] }],
        responses: { "200": { description: "Object with portal URL" } },
      },
    },

    // ===================== MEDIA ROUTER =====================
    "/media.list": {
      get: {
        tags: ["Media"],
        summary: "List media files",
        description: "Returns paginated media files for the organization, optionally filtered by type.",
        operationId: "media.list",
        security: [{ session: [], organization: [] }],
        parameters: [
          { name: "input", in: "query", schema: { type: "object", properties: { limit: { type: "integer" }, cursor: { type: "string" }, type: { type: "string", enum: ["image", "video", "all"] } } } },
        ],
        responses: { "200": { description: "Paginated media items" } },
      },
    },
    "/media.getUploadUrl": {
      post: {
        tags: ["Media"],
        summary: "Get presigned upload URL",
        description: "Generates a presigned S3 PUT URL for uploading a media file. Validates file type and size (max 50MB).",
        operationId: "media.getUploadUrl",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["fileName", "fileType", "fileSize"],
                properties: {
                  fileName: { type: "string" },
                  fileType: { type: "string" },
                  fileSize: { type: "integer", maximum: 52428800 },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Upload URL, public URL, and media ID" } },
      },
    },
    "/media.confirmUpload": {
      post: {
        tags: ["Media"],
        summary: "Confirm media upload",
        description: "Confirms that a media file has been successfully uploaded to S3.",
        operationId: "media.confirmUpload",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: { "application/json": { schema: { type: "object", required: ["mediaId"], properties: { mediaId: { type: "string" } } } } },
        },
        responses: { "200": { description: "Confirmation with media object" } },
      },
    },
    "/media.delete": {
      post: {
        tags: ["Media"],
        summary: "Delete a media file",
        description: "Deletes a media file from both S3 and the database.",
        operationId: "media.delete",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } },
        },
        responses: { "200": { description: "Success" }, "404": { description: "Not found" } },
      },
    },

    // ===================== WEBHOOK ROUTER =====================
    "/webhook.list": {
      get: {
        tags: ["Webhook"],
        summary: "List webhooks",
        description: "Returns all webhooks configured for the organization.",
        operationId: "webhook.list",
        security: [{ session: [], organization: [] }],
        responses: { "200": { description: "Array of webhooks" } },
      },
    },
    "/webhook.create": {
      post: {
        tags: ["Webhook"],
        summary: "Create a webhook",
        description: "Creates a new webhook endpoint with specified event subscriptions.",
        operationId: "webhook.create",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url", "events"],
                properties: {
                  url: { type: "string", format: "uri" },
                  events: { type: "array", items: { type: "string" }, minItems: 1 },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Created webhook with secret" } },
      },
    },
    "/webhook.delete": {
      post: {
        tags: ["Webhook"],
        summary: "Delete a webhook",
        description: "Deletes a webhook endpoint.",
        operationId: "webhook.delete",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } },
        },
        responses: { "200": { description: "Success" } },
      },
    },

    // ===================== API KEY ROUTER =====================
    "/apikey.list": {
      get: {
        tags: ["API Key"],
        summary: "List API keys",
        description: "Returns all API keys for the organization (keys are masked).",
        operationId: "apikey.list",
        security: [{ session: [], organization: [] }],
        responses: { "200": { description: "Array of API key objects (masked)" } },
      },
    },
    "/apikey.create": {
      post: {
        tags: ["API Key"],
        summary: "Create an API key",
        description: "Generates a new API key. The full key is only returned once at creation. Rate limited.",
        operationId: "apikey.create",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  expiresAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "API key with plaintext key (one-time)" } },
      },
    },
    "/apikey.delete": {
      post: {
        tags: ["API Key"],
        summary: "Delete an API key",
        description: "Revokes and deletes an API key.",
        operationId: "apikey.delete",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } },
        },
        responses: { "200": { description: "Success" } },
      },
    },

    // ===================== AUDIT ROUTER =====================
    "/audit.list": {
      get: {
        tags: ["Audit"],
        summary: "List audit logs",
        description: "Returns paginated audit logs for the organization. Requires OWNER or ADMIN role.",
        operationId: "audit.list",
        security: [{ session: [], organization: [] }],
        parameters: [
          {
            name: "input",
            in: "query",
            schema: {
              type: "object",
              properties: {
                page: { type: "integer", default: 1 },
                limit: { type: "integer", default: 25 },
                action: { type: "string" },
                entityType: { type: "string" },
                userId: { type: "string" },
                startDate: { type: "string" },
                endDate: { type: "string" },
              },
            },
          },
        ],
        responses: {
          "200": { description: "Paginated audit logs with user info" },
          "403": { description: "Only owners and admins" },
        },
      },
    },
    "/audit.entityHistory": {
      get: {
        tags: ["Audit"],
        summary: "Get entity audit history",
        description: "Returns the full audit trail for a specific entity. Requires OWNER or ADMIN role.",
        operationId: "audit.entityHistory",
        security: [{ session: [], organization: [] }],
        parameters: [
          { name: "input", in: "query", schema: { type: "object", required: ["entityType", "entityId"], properties: { entityType: { type: "string" }, entityId: { type: "string" } } } },
        ],
        responses: { "200": { description: "Array of audit log entries" } },
      },
    },

    // ===================== IMAGE ROUTER =====================
    "/image.generate": {
      post: {
        tags: ["Image"],
        summary: "Generate an image from text",
        description: "Generates an image using AI from a text prompt. Supports Nano Banana and DALL-E providers. Rate limited.",
        operationId: "image.generate",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["prompt"],
                properties: {
                  prompt: { type: "string", maxLength: 2000 },
                  provider: { type: "string", enum: ["nano-banana", "nano-banana-pro", "dall-e"] },
                  aspectRatio: { type: "string", default: "1:1" },
                  imageSize: { type: "string", default: "1K" },
                  size: { type: "string", enum: ["1024x1024", "1024x1792", "1792x1024"] },
                  quality: { type: "string", enum: ["standard", "hd"] },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Generated image as base64 with mimeType and description" },
          "429": { description: "Rate limit exceeded" },
        },
      },
    },
    "/image.edit": {
      post: {
        tags: ["Image"],
        summary: "Edit an existing image",
        description: "Edits an existing image using AI and a text prompt. DALL-E provider not supported for editing.",
        operationId: "image.edit",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["prompt", "imageBase64"],
                properties: {
                  prompt: { type: "string", maxLength: 2000 },
                  imageBase64: { type: "string" },
                  imageMimeType: { type: "string", default: "image/jpeg" },
                  provider: { type: "string", enum: ["nano-banana", "nano-banana-pro", "dall-e"] },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Edited image as base64" } },
      },
    },
    "/image.saveGenerated": {
      post: {
        tags: ["Image"],
        summary: "Save a generated image",
        description: "Uploads a base64 image to S3 and creates a media record. Enqueues thumbnail generation.",
        operationId: "image.saveGenerated",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["imageBase64"],
                properties: {
                  imageBase64: { type: "string" },
                  mimeType: { type: "string", default: "image/png" },
                  fileName: { type: "string", default: "generated-image.png" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Saved media with id, url, fileName, mimeType" } },
      },
    },

    // ===================== BULK ROUTER =====================
    "/bulk.bulkSchedule": {
      post: {
        tags: ["Bulk"],
        summary: "Bulk schedule posts",
        description: "Schedule multiple posts at once by providing an array of postId/scheduledAt pairs (max 100).",
        operationId: "bulk.bulkSchedule",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["items"],
                properties: {
                  items: {
                    type: "array",
                    maxItems: 100,
                    items: {
                      type: "object",
                      required: ["postId", "scheduledAt"],
                      properties: {
                        postId: { type: "string" },
                        scheduledAt: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Count of scheduled posts" } },
      },
    },
    "/bulk.bulkDelete": {
      post: {
        tags: ["Bulk"],
        summary: "Bulk delete posts",
        description: "Delete multiple posts by ID (max 100). Only deletes posts belonging to the organization.",
        operationId: "bulk.bulkDelete",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["postIds"],
                properties: {
                  postIds: { type: "array", maxItems: 100, items: { type: "string" } },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Count of deleted posts" } },
      },
    },
    "/bulk.bulkUpdateStatus": {
      post: {
        tags: ["Bulk"],
        summary: "Bulk update post status",
        description: "Change the status of multiple posts to DRAFT or CANCELLED.",
        operationId: "bulk.bulkUpdateStatus",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["postIds", "status"],
                properties: {
                  postIds: { type: "array", maxItems: 100, items: { type: "string" } },
                  status: { type: "string", enum: ["DRAFT", "CANCELLED"] },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Count of updated posts" } },
      },
    },
    "/bulk.csvImport": {
      post: {
        tags: ["Bulk"],
        summary: "Import posts from CSV",
        description: "Parses CSV data (header: content, scheduledAt optional) and creates posts linked to specified channels.",
        operationId: "bulk.csvImport",
        security: [{ session: [], organization: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["csvData", "channelIds"],
                properties: {
                  csvData: { type: "string" },
                  channelIds: { type: "array", items: { type: "string" }, minItems: 1 },
                  scheduledAt: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Import result with imported count and errors array",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    imported: { type: "integer" },
                    errors: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/bulk.csvExport": {
      get: {
        tags: ["Bulk"],
        summary: "Export posts as CSV",
        description: "Exports posts as a CSV string with columns: content, status, scheduledAt, publishedAt, platforms.",
        operationId: "bulk.csvExport",
        security: [{ session: [], organization: [] }],
        parameters: [
          {
            name: "input",
            in: "query",
            schema: {
              type: "object",
              properties: {
                status: { type: "string" },
                startDate: { type: "string" },
                endDate: { type: "string" },
              },
            },
          },
        ],
        responses: {
          "200": {
            description: "CSV string and count",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    csv: { type: "string" },
                    count: { type: "integer" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },

  components: {
    securitySchemes: {
      session: {
        type: "apiKey",
        in: "cookie",
        name: "next-auth.session-token",
        description: "NextAuth.js session cookie",
      },
      organization: {
        type: "apiKey",
        in: "header",
        name: "x-organization-id",
        description: "Organization ID for org-scoped endpoints",
      },
    },
    schemas: {
      UserWithMemberships: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string", nullable: true },
          email: { type: "string" },
          image: { type: "string", nullable: true },
          memberships: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                role: { type: "string", enum: ["OWNER", "ADMIN", "MEMBER", "VIEWER"] },
                organization: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    slug: { type: "string" },
                    plan: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
      Post: {
        type: "object",
        properties: {
          id: { type: "string" },
          content: { type: "string" },
          status: { type: "string", enum: ["DRAFT", "SCHEDULED", "PUBLISHING", "PUBLISHED", "FAILED", "CANCELLED"] },
          scheduledAt: { type: "string", format: "date-time", nullable: true },
          publishedAt: { type: "string", format: "date-time", nullable: true },
          aiGenerated: { type: "boolean" },
          targets: { type: "array", items: { $ref: "#/components/schemas/PostTarget" } },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      PostTarget: {
        type: "object",
        properties: {
          id: { type: "string" },
          channelId: { type: "string" },
          status: { type: "string" },
          publishedUrl: { type: "string", nullable: true },
          channel: { $ref: "#/components/schemas/Channel" },
        },
      },
      Channel: {
        type: "object",
        properties: {
          id: { type: "string" },
          platform: {
            type: "string",
            enum: [
              "TWITTER", "INSTAGRAM", "FACEBOOK", "LINKEDIN", "YOUTUBE",
              "TIKTOK", "REDDIT", "PINTEREST", "THREADS", "TELEGRAM",
              "DISCORD", "SLACK", "MASTODON", "BLUESKY", "MEDIUM", "DEVTO",
            ],
          },
          name: { type: "string" },
          username: { type: "string", nullable: true },
          isActive: { type: "boolean" },
        },
      },
    },
  },
  security: [{ session: [] }],
};

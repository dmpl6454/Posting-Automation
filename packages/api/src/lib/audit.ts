import { prisma } from "@postautomation/db";

interface AuditLogInput {
  organizationId?: string;
  userId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
}

// Fire and forget — don't block the main operation
export async function createAuditLog(input: AuditLogInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: input.metadata ?? undefined,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
    });
  } catch (error) {
    // Don't let audit logging failures break the main operation
    console.error("Failed to create audit log:", error);
  }
}

// Common action constants
export const AUDIT_ACTIONS = {
  // Posts
  POST_CREATED: "post.created",
  POST_UPDATED: "post.updated",
  POST_DELETED: "post.deleted",
  POST_PUBLISHED: "post.published",
  POST_SCHEDULED: "post.scheduled",

  // Channels
  CHANNEL_CONNECTED: "channel.connected",
  CHANNEL_DISCONNECTED: "channel.disconnected",
  CHANNEL_REFRESHED: "channel.refreshed",

  // Team
  MEMBER_INVITED: "member.invited",
  MEMBER_REMOVED: "member.removed",
  MEMBER_ROLE_CHANGED: "member.role_changed",

  // API Keys
  API_KEY_CREATED: "apikey.created",
  API_KEY_DELETED: "apikey.deleted",

  // Webhooks
  WEBHOOK_CREATED: "webhook.created",
  WEBHOOK_UPDATED: "webhook.updated",
  WEBHOOK_DELETED: "webhook.deleted",

  // Billing
  PLAN_CHANGED: "billing.plan_changed",
  BILLING_CHECKOUT_STARTED: "billing.checkout_started",
  SUBSCRIPTION_CANCELLED: "billing.subscription_cancelled",

  // RSS
  RSS_FEED_CREATED: "rss.feed_created",
  RSS_FEED_UPDATED: "rss.feed_updated",
  RSS_FEED_DELETED: "rss.feed_deleted",

  // Agents
  AGENT_CREATED: "agent.created",
  AGENT_UPDATED: "agent.updated",
  AGENT_DELETED: "agent.deleted",
  AGENT_TOGGLED: "agent.toggled",

  // Autopilot
  PIPELINE_TRIGGERED: "autopilot.pipeline_triggered",

  // Listening
  LISTENING_QUERY_CREATED: "listening.query_created",
  LISTENING_QUERY_DELETED: "listening.query_deleted",

  // User profile / settings
  USER_PROFILE_UPDATED: "user.profile_updated",
  USER_PASSWORD_CHANGED: "user.password_changed",
  USER_PHONE_ADDED: "user.phone_added",
  USER_PHONE_REMOVED: "user.phone_removed",

  // Organization
  ORG_SETTINGS_UPDATED: "org.settings_updated",

  // Auth
  USER_LOGIN: "auth.login",
  PASSWORD_RESET_REQUESTED: "auth.password_reset_requested",
  PASSWORD_RESET_COMPLETED: "auth.password_reset_completed",

  // Admin
  ADMIN_USER_SUPERADMIN_TOGGLED: "admin.user.superadmin_toggled",
  ADMIN_USER_BANNED: "admin.user.banned",
  ADMIN_USER_UNBANNED: "admin.user.unbanned",
  ADMIN_USER_DELETED: "admin.user.deleted",
  ADMIN_USER_IMPERSONATED: "admin.user.impersonated",
  ADMIN_ORG_PLAN_CHANGED: "admin.org.plan_changed",
  ADMIN_ORG_DELETED: "admin.org.deleted",
  ADMIN_POST_RETRIED: "admin.post.retried",
  ADMIN_CHANNEL_DISCONNECTED: "admin.channel.disconnected",
  ADMIN_CHANNEL_TOKEN_REFRESHED: "admin.channel.token_refreshed",
  ADMIN_AGENT_TOGGLED: "admin.agent.toggled",
  ADMIN_AGENT_DELETED: "admin.agent.deleted",
  ADMIN_MEDIA_DELETED: "admin.media.deleted",
  ADMIN_QUEUE_JOB_RETRIED: "admin.queue.job_retried",
  ADMIN_QUEUE_JOB_DELETED: "admin.queue.job_deleted",
} as const;

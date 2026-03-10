import { prisma } from "@postautomation/db";

interface AuditLogInput {
  organizationId: string;
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
  SUBSCRIPTION_CANCELLED: "billing.subscription_cancelled",

  // Organization
  ORG_SETTINGS_UPDATED: "org.settings_updated",

  // Auth
  USER_LOGIN: "auth.login",
  PASSWORD_RESET_REQUESTED: "auth.password_reset_requested",
  PASSWORD_RESET_COMPLETED: "auth.password_reset_completed",
} as const;

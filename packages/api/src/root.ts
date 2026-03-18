import { createRouter } from "./trpc";
import { userRouter } from "./routers/user.router";
import { postRouter } from "./routers/post.router";
import { channelRouter } from "./routers/channel.router";
import { aiRouter } from "./routers/ai.router";
import { analyticsRouter } from "./routers/analytics.router";
import { teamRouter } from "./routers/team.router";
import { billingRouter } from "./routers/billing.router";
import { mediaRouter } from "./routers/media.router";
import { webhookRouter } from "./routers/webhook.router";
import { apikeyRouter } from "./routers/apikey.router";
import { authRouter } from "./routers/auth.router";
import { webhookDeliveryRouter } from "./routers/webhook-delivery.router";
import { auditRouter } from "./routers/audit.router";
import { imageRouter } from "./routers/image.router";
import { onboardingRouter } from "./routers/onboarding.router";
import { notificationRouter } from "./routers/notification.router";
import { approvalRouter } from "./routers/approval.router";
import { rssRouter } from "./routers/rss.router";
import { shortlinkRouter } from "./routers/shortlink.router";
import { repurposeRouter } from "./routers/repurpose.router";
import { bulkRouter } from "./routers/bulk.router";
import { orgRouter } from "./routers/org.router";
import { agentRouter } from "./routers/agent.router";
import { chatRouter } from "./routers/chat.router";
import { adminRouter } from "./routers/admin";
import { autopilotRouter } from "./routers/autopilot.router";
import { accountGroupRouter } from "./routers/account-group.router";
import { designTemplateRouter } from "./routers/design-template.router";
import { channelGroupRouter } from "./routers/channel-group.router";

export const appRouter = createRouter({
  user: userRouter,
  post: postRouter,
  channel: channelRouter,
  ai: aiRouter,
  analytics: analyticsRouter,
  team: teamRouter,
  billing: billingRouter,
  media: mediaRouter,
  webhook: webhookRouter,
  webhookDelivery: webhookDeliveryRouter,
  apikey: apikeyRouter,
  auth: authRouter,
  audit: auditRouter,
  image: imageRouter,
  onboarding: onboardingRouter,
  notification: notificationRouter,
  approval: approvalRouter,
  rss: rssRouter,
  shortlink: shortlinkRouter,
  repurpose: repurposeRouter,
  bulk: bulkRouter,
  org: orgRouter,
  agent: agentRouter,
  chat: chatRouter,
  admin: adminRouter,
  autopilot: autopilotRouter,
  accountGroup: accountGroupRouter,
  designTemplate: designTemplateRouter,
  channelGroup: channelGroupRouter,
});

export type AppRouter = typeof appRouter;

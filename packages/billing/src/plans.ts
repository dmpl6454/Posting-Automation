import type { PlanType } from "@postautomation/db";

export interface PlanConfig {
  name: string;
  type: PlanType;
  priceMonthly: number;
  stripePriceId: string;
  limits: {
    channels: number;
    postsPerMonth: number;
    aiImagesPerMonth: number;
    aiVideosPerMonth: number;
    teamMembers: number;
  };
  features: string[];
}

export const PLANS: Record<string, PlanConfig> = {
  FREE: {
    name: "Free",
    type: "FREE",
    priceMonthly: 0,
    stripePriceId: "",
    limits: {
      channels: 3,
      postsPerMonth: 30,
      aiImagesPerMonth: 0,
      aiVideosPerMonth: 0,
      teamMembers: 1,
    },
    features: ["3 social channels", "30 posts/month", "Basic scheduling"],
  },
  STARTER: {
    name: "Starter",
    type: "STARTER",
    priceMonthly: 29,
    stripePriceId: process.env.STRIPE_STARTER_PRICE_ID || "",
    limits: {
      channels: 10,
      postsPerMonth: 500,
      aiImagesPerMonth: 100,
      aiVideosPerMonth: 5,
      teamMembers: 3,
    },
    features: [
      "10 social channels",
      "500 posts/month",
      "AI content generation",
      "100 AI images/month",
      "3 team members",
    ],
  },
  PROFESSIONAL: {
    name: "Professional",
    type: "PROFESSIONAL",
    priceMonthly: 49,
    stripePriceId: process.env.STRIPE_PRO_PRICE_ID || "",
    limits: {
      channels: 30,
      postsPerMonth: -1, // unlimited
      aiImagesPerMonth: 300,
      aiVideosPerMonth: 30,
      teamMembers: -1, // unlimited
    },
    features: [
      "30 social channels",
      "Unlimited posts",
      "AI content & image generation",
      "300 AI images/month",
      "Unlimited team members",
      "Analytics dashboard",
    ],
  },
  ENTERPRISE: {
    name: "Enterprise",
    type: "ENTERPRISE",
    priceMonthly: 99,
    stripePriceId: process.env.STRIPE_ENTERPRISE_PRICE_ID || "",
    limits: {
      channels: 100,
      postsPerMonth: -1,
      aiImagesPerMonth: 500,
      aiVideosPerMonth: 60,
      teamMembers: -1,
    },
    features: [
      "100 social channels",
      "Unlimited everything",
      "Priority support",
      "Custom integrations",
      "SSO & advanced security",
    ],
  },
};

export function getPlanConfig(planType: PlanType): PlanConfig {
  const plan = PLANS[planType];
  // FREE is always defined in the PLANS record
  return plan ?? PLANS.FREE!;
}

export function checkPlanLimit(
  planType: PlanType,
  resource: keyof PlanConfig["limits"],
  currentUsage: number
): boolean {
  const plan = getPlanConfig(planType);
  const limit = plan.limits[resource];
  if (limit === -1) return true; // unlimited
  return currentUsage < limit;
}

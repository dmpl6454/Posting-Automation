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

const PLAN_DATA: Record<string, Omit<PlanConfig, "stripePriceId"> & { envKey: string }> = {
  FREE: {
    name: "Free",
    type: "FREE",
    priceMonthly: 0,
    envKey: "",
    limits: {
      channels: 3,
      postsPerMonth: 30,
      aiImagesPerMonth: 10,
      aiVideosPerMonth: 0,
      teamMembers: 1,
    },
    features: ["3 social channels", "30 posts/month", "10 AI images/month", "Basic scheduling"],
  },
  STARTER: {
    name: "Starter",
    type: "STARTER",
    priceMonthly: 20,
    envKey: "STRIPE_STARTER_PRICE_ID",
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
    priceMonthly: 40,
    envKey: "STRIPE_PRO_PRICE_ID",
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
    priceMonthly: 90,
    envKey: "STRIPE_ENTERPRISE_PRICE_ID",
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

// Read env vars at runtime (not build time) to work inside Docker
export const PLANS: Record<string, PlanConfig> = new Proxy({} as Record<string, PlanConfig>, {
  get(_, key: string) {
    const data = PLAN_DATA[key];
    if (!data) return undefined;
    const { envKey, ...rest } = data;
    return { ...rest, stripePriceId: envKey ? process.env[envKey] || "" : "" };
  },
  ownKeys() {
    return Object.keys(PLAN_DATA);
  },
  getOwnPropertyDescriptor(_, key: string) {
    if (key in PLAN_DATA) return { configurable: true, enumerable: true, writable: true };
    return undefined;
  },
});

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

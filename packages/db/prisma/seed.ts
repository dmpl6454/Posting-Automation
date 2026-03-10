import { PrismaClient, PlanType, MemberRole, SocialPlatform, PostStatus } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  const passwordHash = await bcrypt.hash("password123", 12);

  // ==================== USERS ====================

  const adminUser = await prisma.user.upsert({
    where: { email: "admin@postautomation.app" },
    update: {},
    create: {
      email: "admin@postautomation.app",
      name: "Admin User",
      password: passwordHash,
      emailVerified: new Date(),
    },
  });
  console.log(`  User: ${adminUser.email} (id: ${adminUser.id})`);

  const demoUser = await prisma.user.upsert({
    where: { email: "demo@postautomation.app" },
    update: {},
    create: {
      email: "demo@postautomation.app",
      name: "Demo User",
      password: passwordHash,
      emailVerified: new Date(),
    },
  });
  console.log(`  User: ${demoUser.email} (id: ${demoUser.id})`);

  // ==================== ORGANIZATION ====================

  const org = await prisma.organization.upsert({
    where: { slug: "demo-org" },
    update: {},
    create: {
      name: "Demo Organization",
      slug: "demo-org",
      plan: PlanType.PROFESSIONAL,
    },
  });
  console.log(`  Organization: ${org.name} (id: ${org.id})`);

  // ==================== MEMBERSHIPS ====================

  await prisma.organizationMember.upsert({
    where: {
      userId_organizationId: {
        userId: adminUser.id,
        organizationId: org.id,
      },
    },
    update: {},
    create: {
      userId: adminUser.id,
      organizationId: org.id,
      role: MemberRole.OWNER,
    },
  });
  console.log(`  Membership: ${adminUser.email} -> OWNER`);

  await prisma.organizationMember.upsert({
    where: {
      userId_organizationId: {
        userId: demoUser.id,
        organizationId: org.id,
      },
    },
    update: {},
    create: {
      userId: demoUser.id,
      organizationId: org.id,
      role: MemberRole.MEMBER,
    },
  });
  console.log(`  Membership: ${demoUser.email} -> MEMBER`);

  // ==================== CHANNELS ====================

  const twitterChannel = await prisma.channel.upsert({
    where: {
      organizationId_platform_platformId: {
        organizationId: org.id,
        platform: SocialPlatform.TWITTER,
        platformId: "demo-twitter-123",
      },
    },
    update: {},
    create: {
      organizationId: org.id,
      platform: SocialPlatform.TWITTER,
      platformId: "demo-twitter-123",
      name: "PostAutomation Twitter",
      username: "@postautomation",
      accessToken: "demo-access-token-twitter",
      refreshToken: "demo-refresh-token-twitter",
      tokenExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
      scopes: ["tweet.read", "tweet.write", "users.read"],
      isActive: true,
    },
  });
  console.log(`  Channel: ${twitterChannel.name} (${twitterChannel.platform})`);

  const linkedinChannel = await prisma.channel.upsert({
    where: {
      organizationId_platform_platformId: {
        organizationId: org.id,
        platform: SocialPlatform.LINKEDIN,
        platformId: "demo-linkedin-456",
      },
    },
    update: {},
    create: {
      organizationId: org.id,
      platform: SocialPlatform.LINKEDIN,
      platformId: "demo-linkedin-456",
      name: "PostAutomation LinkedIn",
      username: "postautomation",
      accessToken: "demo-access-token-linkedin",
      refreshToken: "demo-refresh-token-linkedin",
      tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days
      scopes: ["r_liteprofile", "w_member_social"],
      isActive: true,
    },
  });
  console.log(`  Channel: ${linkedinChannel.name} (${linkedinChannel.platform})`);

  const instagramChannel = await prisma.channel.upsert({
    where: {
      organizationId_platform_platformId: {
        organizationId: org.id,
        platform: SocialPlatform.INSTAGRAM,
        platformId: "demo-instagram-789",
      },
    },
    update: {},
    create: {
      organizationId: org.id,
      platform: SocialPlatform.INSTAGRAM,
      platformId: "demo-instagram-789",
      name: "PostAutomation Instagram",
      username: "postautomation",
      accessToken: "demo-access-token-instagram",
      refreshToken: "demo-refresh-token-instagram",
      tokenExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days
      scopes: ["instagram_basic", "instagram_content_publish"],
      isActive: true,
    },
  });
  console.log(`  Channel: ${instagramChannel.name} (${instagramChannel.platform})`);

  // ==================== MEDIA ====================

  const media1 = await prisma.media.upsert({
    where: { id: "seed-media-001" },
    update: {},
    create: {
      id: "seed-media-001",
      organizationId: org.id,
      uploadedById: adminUser.id,
      fileName: "product-launch-banner.png",
      fileType: "image/png",
      fileSize: 245_000,
      url: "https://placehold.co/1200x630/4f46e5/ffffff?text=Product+Launch",
      thumbnailUrl: "https://placehold.co/300x158/4f46e5/ffffff?text=Product+Launch",
      width: 1200,
      height: 630,
    },
  });
  console.log(`  Media: ${media1.fileName}`);

  const media2 = await prisma.media.upsert({
    where: { id: "seed-media-002" },
    update: {},
    create: {
      id: "seed-media-002",
      organizationId: org.id,
      uploadedById: demoUser.id,
      fileName: "team-photo.jpg",
      fileType: "image/jpeg",
      fileSize: 182_000,
      url: "https://placehold.co/800x800/10b981/ffffff?text=Team+Photo",
      thumbnailUrl: "https://placehold.co/300x300/10b981/ffffff?text=Team+Photo",
      width: 800,
      height: 800,
    },
  });
  console.log(`  Media: ${media2.fileName}`);

  // ==================== POSTS ====================

  const now = new Date();
  const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
  const oneDayFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  // Post 1 — DRAFT
  const post1 = await prisma.post.upsert({
    where: { id: "seed-post-001" },
    update: {},
    create: {
      id: "seed-post-001",
      organizationId: org.id,
      createdById: adminUser.id,
      content: "Exciting news! We are launching our new automation platform next week. Stay tuned for more details. #automation #socialmedia #launch",
      status: PostStatus.DRAFT,
      aiGenerated: false,
      targets: {
        create: [
          { channelId: twitterChannel.id, status: PostStatus.DRAFT },
          { channelId: linkedinChannel.id, status: PostStatus.DRAFT },
        ],
      },
      tags: {
        create: [
          { tag: "launch" },
          { tag: "announcement" },
        ],
      },
    },
  });
  console.log(`  Post: ${post1.id} (DRAFT)`);

  // Post 2 — SCHEDULED
  const post2 = await prisma.post.upsert({
    where: { id: "seed-post-002" },
    update: {},
    create: {
      id: "seed-post-002",
      organizationId: org.id,
      createdById: adminUser.id,
      content: "Tips for growing your social media presence in 2025: 1. Be consistent 2. Engage with your audience 3. Use analytics to optimize #growthtips",
      contentVariants: {
        TWITTER: "Tips for growing your social media presence:\n1. Be consistent\n2. Engage with your audience\n3. Use analytics\n#growthtips",
        LINKEDIN: "Here are my top 3 tips for growing your social media presence in 2025:\n\n1. Consistency is key\n2. Engage authentically with your audience\n3. Let data drive your decisions\n\nWhat strategies have worked for you?",
      },
      status: PostStatus.SCHEDULED,
      scheduledAt: oneHourFromNow,
      aiGenerated: true,
      aiProvider: "openai",
      aiPrompt: "Write a social media post about growth tips",
      targets: {
        create: [
          { channelId: twitterChannel.id, status: PostStatus.SCHEDULED },
          { channelId: linkedinChannel.id, status: PostStatus.SCHEDULED },
        ],
      },
      tags: {
        create: [
          { tag: "growth" },
          { tag: "tips" },
        ],
      },
    },
  });
  console.log(`  Post: ${post2.id} (SCHEDULED for ${oneHourFromNow.toISOString()})`);

  // Post 3 — SCHEDULED (future)
  const post3 = await prisma.post.upsert({
    where: { id: "seed-post-003" },
    update: {},
    create: {
      id: "seed-post-003",
      organizationId: org.id,
      createdById: demoUser.id,
      content: "Behind the scenes of our product development process. Our team works hard to bring you the best tools for social media management.",
      status: PostStatus.SCHEDULED,
      scheduledAt: oneDayFromNow,
      aiGenerated: false,
      targets: {
        create: [
          { channelId: instagramChannel.id, status: PostStatus.SCHEDULED },
        ],
      },
      mediaAttachments: {
        create: [
          { mediaId: media2.id, order: 0 },
        ],
      },
      tags: {
        create: [
          { tag: "behindthescenes" },
        ],
      },
    },
  });
  console.log(`  Post: ${post3.id} (SCHEDULED for ${oneDayFromNow.toISOString()})`);

  // Post 4 — PUBLISHED
  const post4 = await prisma.post.upsert({
    where: { id: "seed-post-004" },
    update: {},
    create: {
      id: "seed-post-004",
      organizationId: org.id,
      createdById: adminUser.id,
      content: "We just hit 10,000 users on our platform! Thank you for your support. #milestone #thankyou",
      status: PostStatus.PUBLISHED,
      publishedAt: twoDaysAgo,
      scheduledAt: twoDaysAgo,
      aiGenerated: false,
      targets: {
        create: [
          {
            channelId: twitterChannel.id,
            status: PostStatus.PUBLISHED,
            publishedId: "tweet-demo-12345",
            publishedUrl: "https://twitter.com/postautomation/status/12345",
            publishedAt: twoDaysAgo,
          },
          {
            channelId: linkedinChannel.id,
            status: PostStatus.PUBLISHED,
            publishedId: "li-post-demo-67890",
            publishedUrl: "https://linkedin.com/feed/update/67890",
            publishedAt: twoDaysAgo,
          },
        ],
      },
      mediaAttachments: {
        create: [
          { mediaId: media1.id, order: 0 },
        ],
      },
      tags: {
        create: [
          { tag: "milestone" },
        ],
      },
    },
  });
  console.log(`  Post: ${post4.id} (PUBLISHED)`);

  // Post 5 — PUBLISHED (older)
  const post5 = await prisma.post.upsert({
    where: { id: "seed-post-005" },
    update: {},
    create: {
      id: "seed-post-005",
      organizationId: org.id,
      createdById: demoUser.id,
      content: "Introducing our AI-powered content generation feature. Let AI help you craft the perfect post for every platform.",
      status: PostStatus.PUBLISHED,
      publishedAt: threeDaysAgo,
      scheduledAt: threeDaysAgo,
      aiGenerated: true,
      aiProvider: "anthropic",
      aiPrompt: "Announce our new AI content generation feature",
      targets: {
        create: [
          {
            channelId: twitterChannel.id,
            status: PostStatus.PUBLISHED,
            publishedId: "tweet-demo-11111",
            publishedUrl: "https://twitter.com/postautomation/status/11111",
            publishedAt: threeDaysAgo,
          },
        ],
      },
      tags: {
        create: [
          { tag: "ai" },
          { tag: "feature" },
        ],
      },
    },
  });
  console.log(`  Post: ${post5.id} (PUBLISHED)`);

  // ==================== SUMMARY ====================

  console.log("\nSeed complete!");
  console.log("  Users:         2 (admin@postautomation.app, demo@postautomation.app)");
  console.log("  Password:      password123");
  console.log("  Organization:  Demo Organization (demo-org)");
  console.log("  Channels:      3 (Twitter, LinkedIn, Instagram)");
  console.log("  Posts:          5 (1 DRAFT, 2 SCHEDULED, 2 PUBLISHED)");
  console.log("  Media:          2 (placeholder images)");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("Seed failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });

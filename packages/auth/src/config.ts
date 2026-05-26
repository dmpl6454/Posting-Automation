import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@postautomation/db";
import type { NextAuthConfig } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";

// Wrap PrismaAdapter to skip createUser/createSession for credentials provider
// This is required because NextAuth v5 beta + PrismaAdapter tries to create
// a database session even when strategy is "jwt", causing CredentialsSignin errors.
const prismaAdapter = PrismaAdapter(prisma) as Adapter;

export const authConfig: NextAuthConfig = {
  adapter: prismaAdapter,
  secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
  providers: [
    GoogleProvider({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
      allowDangerousEmailAccountLinking: true,
    }),
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        phone: { label: "Phone", type: "text" },
        otp: { label: "OTP", type: "text" },
        loginType: { label: "Login Type", type: "text" },
      },
      async authorize(credentials) {
        // Phone OTP login
        if (credentials?.loginType === "phone-otp") {
          const phone = credentials.phone as string;
          const otp = credentials.otp as string;
          if (!phone || !otp) return null;

          const otpRecord = await prisma.phoneOtp.findFirst({
            where: {
              phone,
              used: false,
              expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: "desc" },
          });

          if (!otpRecord) return null;

          const isValid = await bcrypt.compare(otp, otpRecord.otp);
          if (!isValid) return null;

          await prisma.phoneOtp.update({
            where: { id: otpRecord.id },
            data: { used: true },
          });

          const user = await prisma.user.findUnique({
            where: { phone },
            select: {
              id: true,
              email: true,
              name: true,
              image: true,
              isSuperAdmin: true,
              isBanned: true,
              deletedAt: true,
            },
          });

          if (!user || user.isBanned || user.deletedAt) return null;

          return {
            id: user.id,
            email: user.email,
            name: user.name,
            image: user.image,
            isSuperAdmin: user.isSuperAdmin,
            isBanned: user.isBanned,
          } as any;
        }

        // Email/password login
        if (!credentials?.email || !credentials?.password) return null;

        const email = (credentials.email as string).toLowerCase().trim();

        const user = await prisma.user.findFirst({
          where: { email: { equals: email, mode: "insensitive" } },
          select: {
            id: true,
            email: true,
            name: true,
            image: true,
            password: true,
            isSuperAdmin: true,
            isBanned: true,
            deletedAt: true,
            accounts: { select: { provider: true } },
          },
        });

        // User exists but signed up via OAuth — give a specific, helpful error
        if (user && !user.password) {
          const providers = user.accounts.map((a) => a.provider);
          if (providers.length > 0) {
            const names = providers
              .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
              .join(" or ");
            throw new Error(`oauth_only:${names}`);
          }
          return null;
        }

        if (!user?.password) return null;

        const isValid = await bcrypt.compare(
          credentials.password as string,
          user.password
        );

        if (!isValid) return null;

        if (user.isBanned) throw new Error("Account suspended");
        if (user.deletedAt) throw new Error("Account no longer exists");

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          isSuperAdmin: user.isSuperAdmin,
          isBanned: user.isBanned,
        } as any;
      },
    }),
  ],
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.isSuperAdmin = (user as any).isSuperAdmin ?? false;
        token.isBanned = (user as any).isBanned ?? false;
      }

      // Re-check from DB on every token refresh
      if (token.id) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: { isBanned: true, isSuperAdmin: true, passwordChangedAt: true },
        });
        if (dbUser) {
          token.isSuperAdmin = dbUser.isSuperAdmin;
          token.isBanned = dbUser.isBanned;

          // If the password was changed AFTER this JWT was issued, invalidate it.
          // This forces re-login after a password reset — equivalent to the
          // reference app's refreshToken.deleteMany().
          if (dbUser.passwordChangedAt && token.iat) {
            const issuedAt = (token.iat as number) * 1000; // JWT iat is in seconds
            if (dbUser.passwordChangedAt.getTime() > issuedAt) {
              return null; // NextAuth treats null as an expired session → sign-out
            }
          }
        }

        // Fix #1 RBAC: load the user's role in their current (first) org so the
        // sidebar can gate modules. We load the OWNER membership first (most
        // privileged), then fallback to the earliest membership.
        const member = await prisma.organizationMember.findFirst({
          where: { userId: token.id as string },
          orderBy: [{ role: "asc" }, { createdAt: "asc" }],
          select: { role: true, organizationId: true },
        });
        if (member) {
          token.role = member.role;
          token.organizationId = member.organizationId;
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string;
        (session.user as any).isSuperAdmin = token.isSuperAdmin ?? false;
        (session.user as any).isBanned = token.isBanned ?? false;
        // Fix #1 RBAC: expose role + organizationId to client components
        (session.user as any).role = token.role ?? "MEMBER";
        (session.user as any).organizationId = token.organizationId ?? null;
      }
      return session;
    },
  },
  events: {
    // Called only when a brand-new user row is created by NextAuth (i.e. first OAuth sign-up).
    // Credentials users get their org in /api/auth/register, so this only runs for Google/GitHub.
    async createUser({ user }) {
      const userId = user.id;
      const userEmail = user.email;
      if (!userId || !userEmail) return;

      // Guard: skip if they somehow already have a membership (shouldn't happen, but be safe)
      const existing = await prisma.organizationMember.findFirst({
        where: { userId },
      });
      if (existing) return;

      const slug = (userEmail.split("@")[0] ?? userEmail)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-");
      const displayName = user.name || slug;

      await prisma.organization.create({
        data: {
          name: `${displayName}'s Workspace`,
          slug: `${slug}-${Date.now().toString(36)}`,
          members: {
            create: {
              userId,
              role: "OWNER",
            },
          },
        },
      });
    },
  },
  pages: {
    signIn: "/login",
    newUser: "/register",
  },
};

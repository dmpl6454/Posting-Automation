import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@postautomation/db";
import type { NextAuthConfig } from "next-auth";
import type { Adapter } from "next-auth/adapters";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { ensurePersonalOrg, verifyAndConsumePhoneOtp } from "@postautomation/db";

// Wrap PrismaAdapter to skip createUser/createSession for credentials provider
// This is required because NextAuth v5 beta + PrismaAdapter tries to create
// a database session even when strategy is "jwt", causing CredentialsSignin errors.
const prismaAdapter = PrismaAdapter(prisma) as Adapter;

// Security audit 2026-09-28: a fixed bcrypt-12 hash of an arbitrary string,
// compared against on every "no such user" login attempt so a real account
// lookup miss takes the same wall-clock time as a genuine wrong-password
// compare — see the authorize() branch below. Never a real password; there
// is no matching account, and nothing needs to ever match this hash.
const DUMMY_PASSWORD_HASH = "$2a$12$//3lFEIjSLZ0IJAcDLbY3OYdULOnaiJRW0iPSZQah13aFg86ncMwK";

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

          // 🔒 Attempt-limited (security audit 2026-09-28) — see verify-phone-otp.ts.
          const verified = await verifyAndConsumePhoneOtp(prisma, phone, otp);
          if (!verified.ok) return null;

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
              phoneVerified: true,
            },
          });

          if (!user || user.isBanned || user.deletedAt) return null;
          // Security audit 2026-09-28: defense in depth. `phone` and
          // `phoneVerified` are always written together by verifyPhone, so
          // this should never actually diverge — but authenticating on the
          // `phone` column match alone, with no check that it was ever
          // verified, has no reason to hold if that invariant is ever broken
          // elsewhere. Mirrors the check sendPhoneOtp already runs.
          if (!user.phoneVerified) return null;

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

        // Security audit 2026-09-28: this branch (no such user at all — the
        // OAuth-only/passwordless cases already returned above) used to
        // return null IMMEDIATELY, while a real account with a WRONG
        // password ran a full bcrypt-12 compare first. Both produce the
        // identical CredentialsSignin error, so the code-level response is
        // safe — but the wall-clock time difference (a bcrypt compare is
        // tens–low hundreds of ms; a bare Prisma miss is single-digit ms) is
        // a genuine account-existence timing oracle. A dummy compare against
        // a fixed hash equalizes it: every login attempt now runs exactly
        // one bcrypt comparison, real or not.
        if (!user?.password) {
          await bcrypt.compare(credentials.password as string, DUMMY_PASSWORD_HASH);
          return null;
        }

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
    // Refuse banned/soft-deleted accounts up front so Google sign-in lands on
    // /auth/error?error=AccessDenied instead of jwt()'s null silently bouncing
    // them to /login. `user` is the adapter row (real id) or, on a first
    // Google link to an existing account, the provider profile, whose id is a
    // fresh random UUID — hence the email fallback when the id finds nothing.
    // No row at all is a brand-new signup and is allowed.
    async signIn({ user }) {
      const select = { isBanned: true, deletedAt: true } as const;
      let row = user?.id
        ? await prisma.user.findUnique({ where: { id: user.id }, select })
        : null;
      if (!row && user?.email) {
        row = await prisma.user.findFirst({
          where: { email: { equals: user.email, mode: "insensitive" } },
          select,
        });
      }
      return !(row && (row.isBanned || row.deletedAt));
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.isSuperAdmin = (user as any).isSuperAdmin ?? false;
        token.isBanned = (user as any).isBanned ?? false;
        // App-level access tier (USER|ADMIN) — NOT the org MemberRole below.
        token.appRole = (user as any).appRole ?? "USER";
      }

      // Re-check from DB on every token refresh
      if (token.id) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: { isBanned: true, isSuperAdmin: true, passwordChangedAt: true, appRole: true, deletedAt: true },
        });
        if (dbUser) {
          // Security audit 2026-09-28: isBanned/deletedAt used to only update
          // the token's VALUE — nothing in the auth layer itself acted on it,
          // so enforcement was entirely delegated to whatever read the field
          // downstream (tRPC's protectedProcedure did; every non-tRPC route
          // under apps/web/app/api/** that calls auth() directly did not, and
          // neither did Google sign-in, which has no signIn callback at all).
          // deletedAt was also absent from this select, so an admin-deleted
          // user's already-issued session was never revoked anywhere by any
          // path. Returning null here — this callback runs on every request
          // for BOTH providers, including the very first at sign-in — kills
          // the session for every consumer of auth() in one place, the same
          // way the passwordChangedAt check below already forces a live
          // re-login for a password reset.
          if (dbUser.isBanned || dbUser.deletedAt) {
            return null;
          }

          token.isSuperAdmin = dbUser.isSuperAdmin;
          token.isBanned = dbUser.isBanned;
          // Fresh per-request: role changes made in /admin take effect on the
          // very next request server-side (no re-login needed for enforcement;
          // only the client-cached useSession() nav may lag until a reload).
          token.appRole = dbUser.appRole;

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
        // App-level access tier — deliberately a SEPARATE key from `role`
        // (which is the org MemberRole; renaming it would break sidebar gating).
        (session.user as any).appRole = token.appRole ?? "USER";
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

      // S2: idempotent single-org provisioning. If this person already OWNs an
      // org (e.g. they registered with credentials first, same email), reuse it
      // instead of minting a duplicate personal org.
      await ensurePersonalOrg(prisma, userId, userEmail);
    },
  },
  trustHost: true,
  pages: {
    signIn: "/login",
    newUser: "/register",
    error: "/auth/error",
  },
};

import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@postautomation/db";
import type { NextAuthConfig } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import GitHubProvider from "next-auth/providers/github";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";

const adapter = PrismaAdapter(prisma);

export const authConfig: NextAuthConfig = {
  adapter,
  providers: [
    GoogleProvider({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
    }),
    GitHubProvider({
      clientId: process.env.AUTH_GITHUB_ID!,
      clientSecret: process.env.AUTH_GITHUB_SECRET!,
    }),
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
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
          },
        });

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
    async signIn({ user, account }) {
      // For credentials provider, skip adapter session creation
      if (account?.provider === "credentials") {
        return true;
      }
      return true;
    },
    async jwt({ token, user, account }) {
      if (user) {
        token.id = user.id;
        token.isSuperAdmin = (user as any).isSuperAdmin ?? false;
        token.isBanned = (user as any).isBanned ?? false;
      }

      // Re-check from DB on every token refresh
      if (token.id) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: { isBanned: true, isSuperAdmin: true },
        });
        if (dbUser) {
          token.isSuperAdmin = dbUser.isSuperAdmin;
          token.isBanned = dbUser.isBanned;
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string;
        (session.user as any).isSuperAdmin = token.isSuperAdmin ?? false;
        (session.user as any).isBanned = token.isBanned ?? false;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
    newUser: "/register",
  },
};
